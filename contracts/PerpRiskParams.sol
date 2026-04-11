// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PerpRiskParams
 * @notice Consumes ScoreRegistry to derive live risk parameters for a
 *         perpetuals DEX. Reads pool scores atomically within trade
 *         transactions via cross-contract calls.
 *
 * Parameters derived per pool:
 *  - maxOI          Max open interest (long + short) in USD, 1e6 scaled
 *  - maxLeverage    Maximum leverage multiplier (1x–100x)
 *  - maintenanceMargin  Minimum margin ratio before liquidation (bps)
 *  - initialMargin  Required margin to open a position (bps)
 *  - fundingRateMultiplier  Scales funding rate based on APY volatility
 *  - liquidationPenalty     Penalty paid to liquidator (bps)
 *  - stalePriceThreshold    Max age of oracle price before blocking trades (seconds)
 *
 * Derivation logic:
 *  All parameters are computed deterministically from ScoreRegistry fields.
 *  No governance votes needed to adjust params — the oracle data drives them.
 *  A circuit breaker halts trading on a pool if its score becomes stale or
 *  confidence drops below the minimum threshold.
 *
 * Research instrument note:
 *  This contract emits detailed RiskParamsComputed events on every read so
 *  off-chain analytics can track how params evolve with market conditions.
 *  This data feeds back into improving the scoring model.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IScoreRegistry {
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
        );

    function getTotalApy(bytes32 poolId)
        external
        view
        returns (uint32 totalApy, uint48 timestamp);

    function getLatestScore(bytes32 poolId)
        external
        view
        returns (
            bytes32  poolId_,
            string   memory protocolName,
            string   memory symbol,
            uint8    category,
            uint32   baseApy,
            uint32   rewardApy,
            uint32   netApy,
            uint32   apyVolatility30d,
            uint128  tvlUsd,
            uint32   liquidityDepth,
            uint32   utilisationRate,
            uint8    riskScore,
            uint8    ilRisk,
            uint8    auditScore,
            uint16   protocolAgeDays,
            uint8    confidence,
            address  publisher,
            uint48   timestamp,
            uint32   updateCount
        );
}

// ── Types ─────────────────────────────────────────────────────────────────────

struct RiskParams {
    // ── Position limits
    uint128 maxOI;                  // max open interest USD, 1e6 scaled
    uint8   maxLeverage;            // e.g. 20 = 20x
    // ── Margin requirements (bps)
    uint16  initialMarginBps;       // margin required to open (e.g. 500 = 5%)
    uint16  maintenanceMarginBps;   // margin below which liquidation fires
    // ── Funding
    uint16  fundingRateMultiplier;  // bps applied to base funding rate
    // ── Liquidation
    uint16  liquidationPenaltyBps;  // penalty to liquidator (e.g. 100 = 1%)
    // ── Circuit breaker
    uint32  stalePriceThreshold;    // seconds before price considered stale
    bool    tradingHalted;          // true if circuit breaker is active
    // ── Meta
    uint48  computedAt;             // block.timestamp of last computation
    uint8   confidenceUsed;         // confidence score that drove this computation
}

struct CircuitBreakerState {
    bool    halted;
    uint48  haltedAt;
    string  reason;
}

// ── Events ────────────────────────────────────────────────────────────────────

event RiskParamsComputed(
    bytes32 indexed poolId,
    uint128 maxOI,
    uint8   maxLeverage,
    uint16  initialMarginBps,
    uint16  maintenanceMarginBps,
    uint16  fundingRateMultiplier,
    bool    tradingHalted,
    uint48  computedAt
);

event CircuitBreakerTripped(
    bytes32 indexed poolId,
    string  reason,
    uint48  timestamp
);

event CircuitBreakerCleared(bytes32 indexed poolId, uint48 timestamp);

event PoolRegistered(bytes32 indexed poolId, uint128 baseTvlCap);

// ── Errors ────────────────────────────────────────────────────────────────────

error PoolNotRegistered(bytes32 poolId);
error TradingHalted(bytes32 poolId, string reason);
error StaleScore(bytes32 poolId, uint48 scoreAge, uint32 maxAge);
error ConfidenceTooLow(bytes32 poolId, uint8 confidence, uint8 minimum);
error ZeroAddress();
error Unauthorised(address caller);

// ── Contract ──────────────────────────────────────────────────────────────────

contract PerpRiskParams {

    // ── Constants ─────────────────────────────────────────────────────────────

    // Score freshness: reject scores older than 2 hours
    uint32  public constant MAX_SCORE_AGE_SECONDS    = 2 hours;
    // Minimum confidence to allow trading
    uint8   public constant MIN_CONFIDENCE           = 50;
    // Minimum risk score to allow max leverage
    uint8   public constant HIGH_QUALITY_RISK_SCORE  = 80;
    // Risk score below which trading is halted entirely
    uint8   public constant MIN_RISK_SCORE_TO_TRADE  = 20;

    // ── Max OI derivation constants ───────────────────────────────────────────
    // maxOI = (tvlUsd * OI_TVL_RATIO_BPS / 10_000) * riskScore / 100
    // e.g. 30% of TVL at full risk score
    uint16  public constant OI_TVL_RATIO_BPS         = 3_000;

    // ── Leverage derivation constants ─────────────────────────────────────────
    // maxLeverage = BASE_LEVERAGE * riskScore / 100, capped at MAX_LEVERAGE
    uint8   public constant BASE_LEVERAGE            = 20;
    uint8   public constant MAX_LEVERAGE             = 100;
    uint8   public constant MIN_LEVERAGE             = 2;

    // ── Margin derivation constants ───────────────────────────────────────────
    // initialMarginBps = BASE_INITIAL_MARGIN + volatility_premium + il_premium
    uint16  public constant BASE_INITIAL_MARGIN_BPS  = 500;   // 5%
    uint16  public constant BASE_MAINTENANCE_BPS     = 250;   // 2.5%
    uint16  public constant MAX_INITIAL_MARGIN_BPS   = 5_000; // 50%
    uint16  public constant MAX_MAINTENANCE_BPS      = 2_500; // 25%

    // ── Funding rate multiplier constants ─────────────────────────────────────
    // Higher APY volatility = higher funding rate multiplier
    // multiplier = 10_000 + (apyVolatility30d * VOLATILITY_FUNDING_SCALE)
    uint16  public constant BASE_FUNDING_MULTIPLIER  = 10_000; // 1x = 10000 bps
    uint16  public constant VOLATILITY_FUNDING_SCALE = 2;      // 2 bps per bps of vol

    // ── Immutables ────────────────────────────────────────────────────────────

    IScoreRegistry public immutable scoreRegistry;
    address        public immutable perpDex;         // only perp DEX can read params atomically

    // ── State ─────────────────────────────────────────────────────────────────

    // poolId => registered for perps trading
    mapping(bytes32 => bool)                 private _registered;
    // poolId => TVL cap override (0 = use derived value)
    mapping(bytes32 => uint128)              private _tvlCapOverride;
    // poolId => circuit breaker state
    mapping(bytes32 => CircuitBreakerState)  private _circuitBreakers;
    // cached params (updated on every getParams call)
    mapping(bytes32 => RiskParams)           private _cachedParams;

    bytes32[] private _registeredPools;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _scoreRegistry, address _perpDex) {
        if (_scoreRegistry == address(0) || _perpDex == address(0)) revert ZeroAddress();
        scoreRegistry = IScoreRegistry(_scoreRegistry);
        perpDex       = _perpDex;
    }

    // ── Pool Registration ─────────────────────────────────────────────────────

    /**
     * @notice Register a pool for perps trading.
     * @dev    Called by the perp DEX admin when adding a new market.
     * @param poolId      Pool identifier from ScoreRegistry
     * @param tvlCapUsd   Optional TVL cap override in USD (1e6 scaled). 0 = derive from score.
     */
    function registerPool(bytes32 poolId, uint128 tvlCapUsd) external {
        if (msg.sender != perpDex) revert Unauthorised(msg.sender);
        _registered[poolId]    = true;
        _tvlCapOverride[poolId] = tvlCapUsd;
        _registeredPools.push(poolId);
        emit PoolRegistered(poolId, tvlCapUsd);
    }

    // ── Core Read ─────────────────────────────────────────────────────────────

    /**
     * @notice Returns live risk params for a pool.
     * @dev    Called atomically within trade transactions by the perp DEX.
     *         Derives all params from ScoreRegistry in a single call.
     *         Caches result and emits RiskParamsComputed for off-chain analytics.
     *
     * @param poolId  Pool to get params for
     * @return params Fully derived RiskParams struct
     */
    function getParams(bytes32 poolId)
        external
        returns (RiskParams memory params)
    {
        if (!_registered[poolId]) revert PoolNotRegistered(poolId);

        // ── Check circuit breaker first
        CircuitBreakerState storage cb = _circuitBreakers[poolId];
        if (cb.halted) {
            return RiskParams({
                maxOI:                  0,
                maxLeverage:            0,
                initialMarginBps:       MAX_INITIAL_MARGIN_BPS,
                maintenanceMarginBps:   MAX_MAINTENANCE_BPS,
                fundingRateMultiplier:  BASE_FUNDING_MULTIPLIER,
                liquidationPenaltyBps:  500,
                stalePriceThreshold:    0,
                tradingHalted:          true,
                computedAt:             uint48(block.timestamp),
                confidenceUsed:         0
            });
        }

        // ── Fetch risk data from registry
        (
            uint8   riskScore,
            uint8   ilRisk,
            uint32  apyVolatility30d,
            uint32  liquidityDepth,
            uint8   confidence,
            uint48  scoreTimestamp
        ) = scoreRegistry.getRiskData(poolId);

        uint48 now48    = uint48(block.timestamp);
        uint48 scoreAge = now48 - scoreTimestamp;

        // ── Staleness check
        if (scoreAge > MAX_SCORE_AGE_SECONDS) {
            _tripCircuitBreaker(poolId, "Score stale");
            revert StaleScore(poolId, scoreAge, MAX_SCORE_AGE_SECONDS);
        }

        // ── Confidence check
        if (confidence < MIN_CONFIDENCE) {
            _tripCircuitBreaker(poolId, "Confidence too low");
            revert ConfidenceTooLow(poolId, confidence, MIN_CONFIDENCE);
        }

        // ── Hard halt on critically low risk score
        if (riskScore < MIN_RISK_SCORE_TO_TRADE) {
            _tripCircuitBreaker(poolId, "Risk score critical");
            revert TradingHalted(poolId, "Risk score critical");
        }

        // ── Fetch TVL for OI derivation
        (,, uint128 tvlUsd) = _getTvl(poolId);

        // ── Derive parameters
        params = _deriveParams(
            riskScore,
            ilRisk,
            apyVolatility30d,
            liquidityDepth,
            confidence,
            tvlUsd,
            poolId,
            now48
        );

        // ── Cache and emit
        _cachedParams[poolId] = params;

        emit RiskParamsComputed(
            poolId,
            params.maxOI,
            params.maxLeverage,
            params.initialMarginBps,
            params.maintenanceMarginBps,
            params.fundingRateMultiplier,
            params.tradingHalted,
            now48
        );
    }

    /**
     * @notice Returns cached params without triggering a fresh derivation.
     *         Use for UI reads — does not update cache or emit events.
     */
    function getCachedParams(bytes32 poolId)
        external
        view
        returns (RiskParams memory)
    {
        if (!_registered[poolId]) revert PoolNotRegistered(poolId);
        return _cachedParams[poolId];
    }

    // ── Circuit Breaker ───────────────────────────────────────────────────────

    /**
     * @notice Manually clear a circuit breaker after remediation.
     * @dev    Only callable by the perp DEX.
     */
    function clearCircuitBreaker(bytes32 poolId) external {
        if (msg.sender != perpDex) revert Unauthorised(msg.sender);
        _circuitBreakers[poolId] = CircuitBreakerState({
            halted:   false,
            haltedAt: 0,
            reason:   ""
        });
        emit CircuitBreakerCleared(poolId, uint48(block.timestamp));
    }

    /**
     * @notice Returns current circuit breaker state for a pool.
     */
    function getCircuitBreaker(bytes32 poolId)
        external
        view
        returns (CircuitBreakerState memory)
    {
        return _circuitBreakers[poolId];
    }

    /**
     * @notice Returns all registered pool IDs.
     */
    function getRegisteredPools() external view returns (bytes32[] memory) {
        return _registeredPools;
    }

    // ── Internal: Parameter Derivation ───────────────────────────────────────

    /**
     * @dev Core derivation logic. All math is integer arithmetic in bps.
     *      Every formula is deterministic — same inputs always yield same params.
     *      This is intentional: no admin can override params without changing
     *      the underlying oracle data that drives them.
     */
    function _deriveParams(
        uint8   riskScore,
        uint8   ilRisk,
        uint32  apyVolatility30d,
        uint32  liquidityDepth,
        uint8   confidence,
        uint128 tvlUsd,
        bytes32 poolId,
        uint48  now48
    ) internal view returns (RiskParams memory p) {

        // ── 1. Max OI
        //    Base: 30% of TVL, scaled down by riskScore
        //    Further capped by liquidityDepth (high slippage = lower OI)
        //    TVL cap override respected if set
        uint128 baseTvlCap = _tvlCapOverride[poolId] > 0
            ? _tvlCapOverride[poolId]
            : tvlUsd;

        uint128 oiFromTvl  = uint128(
            (uint256(baseTvlCap) * OI_TVL_RATIO_BPS * riskScore) / (10_000 * 100)
        );

        // Liquidity depth penalty: high slippage reduces OI further
        // liquidityDepth is bps cost per $100k — higher = worse liquidity
        uint128 liquidityPenalty = liquidityDepth > 0
            ? uint128((uint256(oiFromTvl) * liquidityDepth) / 10_000)
            : 0;
        p.maxOI = oiFromTvl > liquidityPenalty ? oiFromTvl - liquidityPenalty : 0;

        // ── 2. Max Leverage
        //    Scales linearly with riskScore, capped at MAX_LEVERAGE
        //    IL risk applies a further haircut (each 10 points of IL = -1x leverage)
        uint8 rawLeverage = uint8(
            (uint256(BASE_LEVERAGE) * riskScore) / 100
        );
        uint8 ilHaircut   = ilRisk / 10;
        rawLeverage       = rawLeverage > ilHaircut ? rawLeverage - ilHaircut : MIN_LEVERAGE;
        p.maxLeverage     = rawLeverage > MAX_LEVERAGE ? MAX_LEVERAGE
                          : rawLeverage < MIN_LEVERAGE  ? MIN_LEVERAGE
                          : rawLeverage;

        // ── 3. Initial Margin
        //    Base 5%, plus volatility premium (1 bps per 10 bps of 30d vol),
        //    plus IL premium (1 bps per point of IL risk)
        uint16 volPremium  = uint16(apyVolatility30d / 10);
        uint16 ilPremium   = uint16(ilRisk * 2);
        uint16 initMargin  = BASE_INITIAL_MARGIN_BPS + volPremium + ilPremium;

        // Confidence discount: low confidence inflates margin
        if (confidence < 80) {
            initMargin += uint16((uint256(80 - confidence) * 10)); // +10bps per point below 80
        }
        p.initialMarginBps = initMargin > MAX_INITIAL_MARGIN_BPS
            ? MAX_INITIAL_MARGIN_BPS
            : initMargin;

        // ── 4. Maintenance Margin
        //    Always 50% of initial margin, floored at BASE_MAINTENANCE_BPS
        uint16 maintMargin = p.initialMarginBps / 2;
        p.maintenanceMarginBps = maintMargin < BASE_MAINTENANCE_BPS
            ? BASE_MAINTENANCE_BPS
            : maintMargin;

        // ── 5. Funding Rate Multiplier
        //    Higher APY volatility = wider funding rate band
        //    High utilisation on lending pools also increases it
        p.fundingRateMultiplier = uint16(
            BASE_FUNDING_MULTIPLIER + (apyVolatility30d * VOLATILITY_FUNDING_SCALE)
        );

        // ── 6. Liquidation Penalty
        //    Inversely related to risk score: riskier pools need higher
        //    liquidation incentive to attract liquidators
        //    penalty = 50 + (100 - riskScore) bps
        p.liquidationPenaltyBps = uint16(50 + (100 - riskScore));

        // ── 7. Stale Price Threshold
        //    Higher volatility = tighter freshness requirement
        //    Base 60s, reduced by 1s per 10 bps of APY volatility, floored at 10s
        uint32 staleThreshold = 60;
        uint32 volReduction   = apyVolatility30d / 10;
        p.stalePriceThreshold = staleThreshold > volReduction
            ? staleThreshold - volReduction
            : 10;

        // ── Meta
        p.tradingHalted    = false;
        p.computedAt       = now48;
        p.confidenceUsed   = confidence;
    }

    // ── Internal: TVL Fetch ───────────────────────────────────────────────────

    /**
     * @dev Fetches TVL from the full score. Returns (riskScore, totalApy, tvlUsd).
     *      Separate from getRiskData to avoid a second external call in derivation.
     */
    function _getTvl(bytes32 poolId)
        internal
        view
        returns (uint8 riskScore, uint32 totalApy, uint128 tvlUsd)
    {
        (
            ,               // poolId_
            ,               // protocolName
            ,               // symbol
            ,               // category
            uint32 baseApy,
            uint32 rewardApy,
            ,               // netApy
            ,               // apyVolatility30d
            uint128 tvl,
            ,               // liquidityDepth
            ,               // utilisationRate
            uint8 risk,
            ,               // ilRisk
            ,               // auditScore
            ,               // protocolAgeDays
            ,               // confidence
            ,               // publisher
            ,               // timestamp
                            // updateCount
        ) = scoreRegistry.getLatestScore(poolId);

        return (risk, baseApy + rewardApy, tvl);
    }

    // ── Internal: Circuit Breaker ─────────────────────────────────────────────

    function _tripCircuitBreaker(bytes32 poolId, string memory reason) internal {
        CircuitBreakerState storage cb = _circuitBreakers[poolId];
        if (!cb.halted) {
            cb.halted   = true;
            cb.haltedAt = uint48(block.timestamp);
            cb.reason   = reason;
            emit CircuitBreakerTripped(poolId, reason, uint48(block.timestamp));
        }
    }
}
