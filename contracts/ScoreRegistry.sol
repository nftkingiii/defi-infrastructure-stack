// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ScoreRegistry
 * @notice Immutable on-chain registry for yield intelligence scores.
 *         Publishers stake MON via PublisherStake to earn write access.
 *         Immutable contract — no admin keys, no upgradeability.
 *
 * Data stored per pool entry:
 *   - APY components (base, reward, net)
 *   - TVL
 *   - AI risk score (0–100)
 *   - Volatility (30d APY std deviation, basis points)
 *   - IL risk (0–100, 0 for single-sided)
 *   - Liquidity depth (slippage cost in bps for $100k swap)
 *   - Utilisation rate (lending pools: borrowed / supplied)
 *   - Protocol age (days since first indexed)
 *   - Audit score (0–100, manually attested by publisher)
 *   - Category enum
 *   - Confidence (0–100, publisher self-reported data quality)
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPublisherStake {
    function isAuthorised(address publisher) external view returns (bool);
}

// ── Types ─────────────────────────────────────────────────────────────────────

enum Category {
    DEX,        // 0
    Lending,    // 1
    Staking,    // 2
    Vault,      // 3
    RWA,        // 4
    Perps,      // 5
    Unknown     // 6
}

struct PoolScore {
    // ── Identity
    bytes32 poolId;           // keccak256(chain + protocol + symbol)
    string  protocolName;     // human-readable label
    string  symbol;           // e.g. "USDT-USDC LP"
    Category category;

    // ── APY (all in basis points, 1 bp = 0.01%)
    uint32  baseApy;          // base yield, no incentives
    uint32  rewardApy;        // incentive/emissions component
    uint32  netApy;           // after estimated gas drag
    uint32  apyVolatility30d; // 30-day std deviation of totalApy

    // ── Liquidity
    uint128 tvlUsd;           // TVL in USD, scaled 1e6
    uint32  liquidityDepth;   // slippage bps for $100k trade
    uint32  utilisationRate;  // bps (lending only, 0 otherwise)

    // ── Risk
    uint8   riskScore;        // 0 (highest risk) – 100 (lowest risk)
    uint8   ilRisk;           // 0–100, 0 for single-sided
    uint8   auditScore;       // 0–100, publisher-attested
    uint16  protocolAgeDays;  // days since first indexed by publisher

    // ── Meta
    uint8   confidence;       // 0–100, publisher data quality signal
    address publisher;        // who wrote this entry
    uint48  timestamp;        // block.timestamp of last update
    uint32  updateCount;      // number of times this pool has been updated
}

// ── Events ────────────────────────────────────────────────────────────────────

event ScorePublished(
    bytes32 indexed poolId,
    address indexed publisher,
    uint8   riskScore,
    uint32  netApy,
    uint128 tvlUsd,
    uint48  timestamp
);

event ScoreHistoryPruned(bytes32 indexed poolId, uint256 entriesRemoved);

// ── Errors ────────────────────────────────────────────────────────────────────

error NotAuthorised(address caller);
error InvalidPoolId();
error InvalidRiskScore(uint8 score);
error InvalidConfidence(uint8 confidence);
error StaleTimestamp(uint48 provided, uint48 current);
error PoolNotFound(bytes32 poolId);
error InvalidApy();

// ── Contract ──────────────────────────────────────────────────────────────────

contract ScoreRegistry {

    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant MAX_HISTORY    = 48;   // max snapshots stored per pool
    uint256 public constant MIN_UPDATE_GAP = 60;   // seconds between updates (anti-spam)
    uint32  public constant MAX_APY_BPS    = 500_000; // 5000% APY ceiling (basis points)

    // ── State ─────────────────────────────────────────────────────────────────

    IPublisherStake public immutable publisherStake;

    // poolId => latest score
    mapping(bytes32 => PoolScore) private _latest;

    // poolId => ordered history (ring buffer index tracked separately)
    mapping(bytes32 => PoolScore[]) private _history;

    // poolId => exists flag
    mapping(bytes32 => bool) private _registered;

    // all registered pool IDs
    bytes32[] private _allPools;

    // publisher => last update timestamp (per pool, for rate limiting)
    mapping(address => mapping(bytes32 => uint48)) private _lastUpdate;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _publisherStake) {
        publisherStake = IPublisherStake(_publisherStake);
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * @notice Publish or update a pool score.
     * @dev    Caller must be authorised by PublisherStake.
     *         Pushes to history ring buffer, capped at MAX_HISTORY.
     */
    function publishScore(PoolScore calldata entry) external {
        // ── Auth
        if (!publisherStake.isAuthorised(msg.sender)) {
            revert NotAuthorised(msg.sender);
        }

        // ── Validate
        if (entry.poolId == bytes32(0)) revert InvalidPoolId();
        if (entry.riskScore > 100)      revert InvalidRiskScore(entry.riskScore);
        if (entry.confidence > 100)     revert InvalidConfidence(entry.confidence);
        if (entry.baseApy > MAX_APY_BPS || entry.rewardApy > MAX_APY_BPS) {
            revert InvalidApy();
        }

        uint48 now48 = uint48(block.timestamp);

        // ── Rate limit per publisher per pool
        uint48 last = _lastUpdate[msg.sender][entry.poolId];
        if (last != 0 && now48 - last < MIN_UPDATE_GAP) {
            revert StaleTimestamp(now48, last + uint48(MIN_UPDATE_GAP));
        }
        _lastUpdate[msg.sender][entry.poolId] = now48;

        // ── Build stored entry (override publisher + timestamp from calldata)
        PoolScore memory stored = entry;
        stored.publisher    = msg.sender;
        stored.timestamp    = now48;
        stored.updateCount  = _latest[entry.poolId].updateCount + 1;

        // ── Register new pool
        if (!_registered[entry.poolId]) {
            _registered[entry.poolId] = true;
            _allPools.push(entry.poolId);
        }

        // ── Update latest
        _latest[entry.poolId] = stored;

        // ── Push to history (trim if over cap)
        _history[entry.poolId].push(stored);
        uint256 len = _history[entry.poolId].length;
        if (len > MAX_HISTORY) {
            _pruneHistory(entry.poolId, len - MAX_HISTORY);
        }

        emit ScorePublished(
            entry.poolId,
            msg.sender,
            stored.riskScore,
            stored.netApy,
            stored.tvlUsd,
            now48
        );
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the latest score for a pool.
     */
    function getLatestScore(bytes32 poolId)
        external
        view
        returns (PoolScore memory)
    {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        return _latest[poolId];
    }

    /**
     * @notice Returns the last N historical scores for a pool.
     * @param  n  Number of entries to return (capped at MAX_HISTORY).
     */
    function getScoreHistory(bytes32 poolId, uint256 n)
        external
        view
        returns (PoolScore[] memory)
    {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore[] storage hist = _history[poolId];
        uint256 total = hist.length;
        uint256 count = n > total ? total : n;
        PoolScore[] memory result = new PoolScore[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = hist[total - count + i];
        }
        return result;
    }

    /**
     * @notice Returns the total APY for a pool (baseApy + rewardApy) in bps.
     *         Convenience read for perps risk consumers.
     */
    function getTotalApy(bytes32 poolId)
        external
        view
        returns (uint32 totalApy, uint48 timestamp)
    {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore storage s = _latest[poolId];
        return (s.baseApy + s.rewardApy, s.timestamp);
    }

    /**
     * @notice Returns the risk score and confidence for a pool.
     *         Primary read for PerpRiskParams.
     */
    function getRiskData(bytes32 poolId)
        external
        view
        returns (
            uint8   riskScore,
            uint8   ilRisk,
            uint32  apyVolatility30d,
            uint32  liquidityDepth,
            uint8   confidence,
            uint48  timestamp
        )
    {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore storage s = _latest[poolId];
        return (
            s.riskScore,
            s.ilRisk,
            s.apyVolatility30d,
            s.liquidityDepth,
            s.confidence,
            s.timestamp
        );
    }

    /**
     * @notice Returns all registered pool IDs.
     */
    function getAllPoolIds() external view returns (bytes32[] memory) {
        return _allPools;
    }

    /**
     * @notice Returns the number of registered pools.
     */
    function poolCount() external view returns (uint256) {
        return _allPools.length;
    }

    /**
     * @notice Returns whether a poolId is registered.
     */
    function isRegistered(bytes32 poolId) external view returns (bool) {
        return _registered[poolId];
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * @notice Derives a poolId from chain ID, protocol slug, and symbol.
     *         Use this off-chain to compute poolIds consistently.
     */
    function derivePoolId(
        uint256 chainId,
        string calldata protocolSlug,
        string calldata symbol
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(chainId, protocolSlug, symbol));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _pruneHistory(bytes32 poolId, uint256 excess) internal {
        PoolScore[] storage hist = _history[poolId];
        uint256 len = hist.length;
        // Shift array left by excess (drop oldest entries)
        for (uint256 i = 0; i < len - excess; i++) {
            hist[i] = hist[i + excess];
        }
        for (uint256 i = 0; i < excess; i++) {
            hist.pop();
        }
        emit ScoreHistoryPruned(poolId, excess);
    }
}
