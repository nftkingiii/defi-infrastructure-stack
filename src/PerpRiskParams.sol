// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IShared.sol";

event RiskParamsComputed(bytes32 indexed poolId, uint128 maxOI, uint8 maxLeverage, uint16 initialMarginBps, uint16 maintenanceMarginBps, uint16 fundingRateMultiplier, bool tradingHalted, uint48 computedAt);
event CircuitBreakerTripped(bytes32 indexed poolId, string reason, uint48 timestamp);
event CircuitBreakerCleared(bytes32 indexed poolId, uint48 timestamp);
event PoolRegistered(bytes32 indexed poolId, uint128 baseTvlCap);

error PoolNotRegistered(bytes32 poolId);
error TradingHalted(bytes32 poolId, string reason);
error StaleScore(bytes32 poolId, uint48 scoreAge, uint32 maxAge);
error ConfidenceTooLow(bytes32 poolId, uint8 confidence, uint8 minimum);
error Unauthorised(address caller);

contract PerpRiskParams {

    uint32  public constant MAX_SCORE_AGE_SECONDS    = 2 hours;
    uint8   public constant MIN_CONFIDENCE           = 50;
    uint8   public constant MIN_RISK_SCORE_TO_TRADE  = 20;
    uint16  public constant OI_TVL_RATIO_BPS         = 3_000;
    uint8   public constant BASE_LEVERAGE            = 20;
    uint8   public constant MAX_LEVERAGE             = 100;
    uint8   public constant MIN_LEVERAGE             = 2;
    uint16  public constant BASE_INITIAL_MARGIN_BPS  = 500;
    uint16  public constant BASE_MAINTENANCE_BPS     = 250;
    uint16  public constant MAX_INITIAL_MARGIN_BPS   = 5_000;
    uint16  public constant MAX_MAINTENANCE_BPS      = 2_500;
    uint16  public constant BASE_FUNDING_MULTIPLIER  = 10_000;
    uint16  public constant VOLATILITY_FUNDING_SCALE = 2;

    IScoreRegistry public immutable scoreRegistry;
    address        public immutable perpDex;

    mapping(bytes32 => bool)                private _registered;
    mapping(bytes32 => uint128)             private _tvlCapOverride;
    mapping(bytes32 => CircuitBreakerState) private _circuitBreakers;
    mapping(bytes32 => RiskParams)          private _cachedParams;
    bytes32[]                               private _registeredPools;

    constructor(address _scoreRegistry, address _perpDex) {
        if (_scoreRegistry == address(0) || _perpDex == address(0)) revert ZeroAddress();
        scoreRegistry = IScoreRegistry(_scoreRegistry);
        perpDex       = _perpDex;
    }

    function registerPool(bytes32 poolId, uint128 tvlCapUsd) external {
        if (msg.sender != perpDex) revert Unauthorised(msg.sender);
        _registered[poolId]     = true;
        _tvlCapOverride[poolId] = tvlCapUsd;
        _registeredPools.push(poolId);
        emit PoolRegistered(poolId, tvlCapUsd);
    }

    function getParams(bytes32 poolId) external returns (RiskParams memory params) {
        if (!_registered[poolId]) revert PoolNotRegistered(poolId);

        CircuitBreakerState storage cb = _circuitBreakers[poolId];
        if (cb.halted) {
            return RiskParams({
                maxOI: 0, maxLeverage: 0,
                initialMarginBps: MAX_INITIAL_MARGIN_BPS,
                maintenanceMarginBps: MAX_MAINTENANCE_BPS,
                fundingRateMultiplier: BASE_FUNDING_MULTIPLIER,
                liquidationPenaltyBps: 500,
                stalePriceThreshold: 0,
                tradingHalted: true,
                computedAt: uint48(block.timestamp),
                confidenceUsed: 0
            });
        }

        (uint8 riskScore, uint8 ilRisk, uint32 apyVolatility30d, uint32 liquidityDepth, uint8 confidence, uint48 scoreTimestamp)
            = scoreRegistry.getRiskData(poolId);

        uint48 now48    = uint48(block.timestamp);
        uint48 scoreAge = now48 - scoreTimestamp;

        if (scoreAge > MAX_SCORE_AGE_SECONDS) {
            _tripCircuitBreaker(poolId, "Score stale");
            revert StaleScore(poolId, scoreAge, MAX_SCORE_AGE_SECONDS);
        }
        if (confidence < MIN_CONFIDENCE) {
            _tripCircuitBreaker(poolId, "Confidence too low");
            revert ConfidenceTooLow(poolId, confidence, MIN_CONFIDENCE);
        }
        if (riskScore < MIN_RISK_SCORE_TO_TRADE) {
            _tripCircuitBreaker(poolId, "Risk score critical");
            revert TradingHalted(poolId, "Risk score critical");
        }

        uint128 tvlUsd = scoreRegistry.getLatestScore(poolId).tvlUsd;
        params = _deriveParams(riskScore, ilRisk, apyVolatility30d, liquidityDepth, confidence, tvlUsd, poolId, now48);
        _cachedParams[poolId] = params;

        emit RiskParamsComputed(poolId, params.maxOI, params.maxLeverage, params.initialMarginBps,
            params.maintenanceMarginBps, params.fundingRateMultiplier, params.tradingHalted, now48);
    }

    function getCachedParams(bytes32 poolId) external view returns (RiskParams memory) {
        if (!_registered[poolId]) revert PoolNotRegistered(poolId);
        return _cachedParams[poolId];
    }

    function clearCircuitBreaker(bytes32 poolId) external {
        if (msg.sender != perpDex) revert Unauthorised(msg.sender);
        _circuitBreakers[poolId] = CircuitBreakerState({ halted: false, haltedAt: 0, reason: "" });
        emit CircuitBreakerCleared(poolId, uint48(block.timestamp));
    }

    function getCircuitBreaker(bytes32 poolId) external view returns (CircuitBreakerState memory) {
        return _circuitBreakers[poolId];
    }

    function getRegisteredPools() external view returns (bytes32[] memory) {
        return _registeredPools;
    }

    function _deriveParams(
        uint8 riskScore, uint8 ilRisk, uint32 apyVolatility30d, uint32 liquidityDepth,
        uint8 confidence, uint128 tvlUsd, bytes32 poolId, uint48 now48
    ) internal view returns (RiskParams memory p) {
        uint128 baseTvlCap   = _tvlCapOverride[poolId] > 0 ? _tvlCapOverride[poolId] : tvlUsd;
        uint128 oiFromTvl    = uint128((uint256(baseTvlCap) * OI_TVL_RATIO_BPS * riskScore) / (10_000 * 100));
        uint128 liquidityPen = liquidityDepth > 0 ? uint128((uint256(oiFromTvl) * liquidityDepth) / 10_000) : 0;
        p.maxOI = oiFromTvl > liquidityPen ? oiFromTvl - liquidityPen : 0;

        uint8 rawLeverage = uint8((uint256(BASE_LEVERAGE) * riskScore) / 100);
        uint8 ilHaircut   = ilRisk / 10;
        rawLeverage       = rawLeverage > ilHaircut ? rawLeverage - ilHaircut : MIN_LEVERAGE;
        p.maxLeverage     = rawLeverage > MAX_LEVERAGE ? MAX_LEVERAGE : rawLeverage < MIN_LEVERAGE ? MIN_LEVERAGE : rawLeverage;

        uint16 volPremium  = uint16(apyVolatility30d / 10);
        uint16 ilPremium   = uint16(ilRisk * 2);
        uint16 initMargin  = BASE_INITIAL_MARGIN_BPS + volPremium + ilPremium;
        if (confidence < 80) initMargin += uint16((uint256(80 - confidence) * 10));
        p.initialMarginBps = initMargin > MAX_INITIAL_MARGIN_BPS ? MAX_INITIAL_MARGIN_BPS : initMargin;

        uint16 maintMargin     = p.initialMarginBps / 2;
        p.maintenanceMarginBps = maintMargin < BASE_MAINTENANCE_BPS ? BASE_MAINTENANCE_BPS : maintMargin;

        p.fundingRateMultiplier = uint16(BASE_FUNDING_MULTIPLIER + (apyVolatility30d * VOLATILITY_FUNDING_SCALE));
        p.liquidationPenaltyBps = uint16(50 + (100 - riskScore));

        uint32 staleThreshold = 60;
        uint32 volReduction   = apyVolatility30d / 10;
        p.stalePriceThreshold = staleThreshold > volReduction ? staleThreshold - volReduction : 10;

        p.tradingHalted  = false;
        p.computedAt     = now48;
        p.confidenceUsed = confidence;
    }

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
