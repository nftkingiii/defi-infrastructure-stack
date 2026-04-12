// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IShared.sol";

event ScorePublished(bytes32 indexed poolId, address indexed publisher, uint8 riskScore, uint32 netApy, uint128 tvlUsd, uint48 timestamp);
event ScoreHistoryPruned(bytes32 indexed poolId, uint256 entriesRemoved);

error InvalidPoolId();
error InvalidRiskScore(uint8 score);
error InvalidConfidence(uint8 confidence);
error StaleTimestamp(uint48 provided, uint48 current);
error InvalidApy();

contract ScoreRegistry {

    uint256 public constant MAX_HISTORY    = 48;
    uint256 public constant MIN_UPDATE_GAP = 60;
    uint32  public constant MAX_APY_BPS    = 500_000;

    IPublisherStake public immutable publisherStake;

    mapping(bytes32 => PoolScore)   private _latest;
    mapping(bytes32 => PoolScore[]) private _history;
    mapping(bytes32 => bool)        private _registered;
    bytes32[]                       private _allPools;
    mapping(address => mapping(bytes32 => uint48)) private _lastUpdate;

    constructor(address _publisherStake) {
        publisherStake = IPublisherStake(_publisherStake);
    }

    function publishScore(PoolScore calldata entry) external {
        if (!publisherStake.isAuthorised(msg.sender)) revert NotAuthorised(msg.sender);
        if (entry.poolId == bytes32(0))               revert InvalidPoolId();
        if (entry.riskScore > 100)                    revert InvalidRiskScore(entry.riskScore);
        if (entry.confidence > 100)                   revert InvalidConfidence(entry.confidence);
        if (entry.baseApy > MAX_APY_BPS || entry.rewardApy > MAX_APY_BPS) revert InvalidApy();

        uint48 now48 = uint48(block.timestamp);
        uint48 last  = _lastUpdate[msg.sender][entry.poolId];
        if (last != 0 && now48 - last < MIN_UPDATE_GAP) {
            revert StaleTimestamp(now48, last + uint48(MIN_UPDATE_GAP));
        }
        _lastUpdate[msg.sender][entry.poolId] = now48;

        PoolScore memory stored = entry;
        stored.publisher   = msg.sender;
        stored.timestamp   = now48;
        stored.updateCount = _latest[entry.poolId].updateCount + 1;

        if (!_registered[entry.poolId]) {
            _registered[entry.poolId] = true;
            _allPools.push(entry.poolId);
        }

        _latest[entry.poolId] = stored;
        _history[entry.poolId].push(stored);

        uint256 len = _history[entry.poolId].length;
        if (len > MAX_HISTORY) _pruneHistory(entry.poolId, len - MAX_HISTORY);

        emit ScorePublished(entry.poolId, msg.sender, stored.riskScore, stored.netApy, stored.tvlUsd, now48);
    }

    function getLatestScore(bytes32 poolId) external view returns (PoolScore memory) {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        return _latest[poolId];
    }

    function getScoreHistory(bytes32 poolId, uint256 n) external view returns (PoolScore[] memory) {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore[] storage hist = _history[poolId];
        uint256 total = hist.length;
        uint256 count = n > total ? total : n;
        PoolScore[] memory result = new PoolScore[](count);
        for (uint256 i = 0; i < count; i++) result[i] = hist[total - count + i];
        return result;
    }

    function getTotalApy(bytes32 poolId) external view returns (uint32 totalApy, uint48 timestamp) {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore storage s = _latest[poolId];
        return (s.baseApy + s.rewardApy, s.timestamp);
    }

    function getRiskData(bytes32 poolId) external view returns (
        uint8 riskScore, uint8 ilRisk, uint32 apyVolatility30d,
        uint32 liquidityDepth, uint8 confidence, uint48 timestamp
    ) {
        if (!_registered[poolId]) revert PoolNotFound(poolId);
        PoolScore storage s = _latest[poolId];
        return (s.riskScore, s.ilRisk, s.apyVolatility30d, s.liquidityDepth, s.confidence, s.timestamp);
    }

    function getAllPoolIds()           external view returns (bytes32[] memory) { return _allPools; }
    function poolCount()              external view returns (uint256)           { return _allPools.length; }
    function isRegistered(bytes32 id) external view returns (bool)             { return _registered[id]; }

    function derivePoolId(uint256 chainId, string calldata protocolSlug, string calldata symbol)
        external pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(chainId, protocolSlug, symbol));
    }

    function _pruneHistory(bytes32 poolId, uint256 excess) internal {
        PoolScore[] storage hist = _history[poolId];
        uint256 len = hist.length;
        for (uint256 i = 0; i < len - excess; i++) hist[i] = hist[i + excess];
        for (uint256 i = 0; i < excess; i++) hist.pop();
        emit ScoreHistoryPruned(poolId, excess);
    }
}
