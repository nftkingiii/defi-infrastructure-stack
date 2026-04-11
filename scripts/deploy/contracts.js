/**
 * deploy/contracts.js
 * ABI fragments and constructor signatures for all four contracts.
 * Bytecode would come from your Foundry/Hardhat build artifacts.
 * Replace the bytecode placeholders with actual compiled output.
 */

// ── ScoreRegistry ─────────────────────────────────────────────────────────────

const SCORE_REGISTRY_ABI = [
  'constructor(address _publisherStake)',
  'function publishScore(tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount) entry) external',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
  'function getRiskData(bytes32 poolId) view returns (uint8 riskScore, uint8 ilRisk, uint32 apyVolatility30d, uint32 liquidityDepth, uint8 confidence, uint48 timestamp)',
  'function getTotalApy(bytes32 poolId) view returns (uint32 totalApy, uint48 timestamp)',
  'function getAllPoolIds() view returns (bytes32[])',
  'function poolCount() view returns (uint256)',
  'function isRegistered(bytes32 poolId) view returns (bool)',
  'function derivePoolId(uint256 chainId, string calldata protocolSlug, string calldata symbol) pure returns (bytes32)',
  'event ScorePublished(bytes32 indexed poolId, address indexed publisher, uint8 riskScore, uint32 netApy, uint128 tvlUsd, uint48 timestamp)',
];

// ── PublisherStake ────────────────────────────────────────────────────────────

const PUBLISHER_STAKE_ABI = [
  'constructor(address _shMon, address _adjudicator, uint128 _minStakeMon)',
  'function register(uint128 shMonAmount) external',
  'function topUp(uint128 shMonAmount) external',
  'function startUnbonding() external',
  'function withdraw() external',
  'function slash(address publisher, uint128 slashMonAmount, address watchdog) external',
  'function isAuthorised(address publisher) view returns (bool)',
  'function getPublisher(address publisher) view returns (tuple(uint128 shMonStaked, uint128 monValueAtDeposit, uint48 stakedAt, uint48 unbondingEndsAt, uint32 slashCount, uint32 poolsPublished, uint8 status))',
  'function currentMonValue(address publisher) view returns (uint128)',
  'function getAllPublishers() view returns (address[])',
  'function activePublisherCount() view returns (uint256)',
  'function setAdjudicator(address _adjudicator) external',   // needed for two-step deploy
  'event PublisherRegistered(address indexed publisher, uint128 shMonStaked, uint128 monValue)',
  'event PublisherSlashed(address indexed publisher, address indexed watchdog, uint128 shMonSlashed, uint128 watchdogBounty, uint128 burned)',
];

// ── DeviationAdjudicator ──────────────────────────────────────────────────────

const DEVIATION_ADJUDICATOR_ABI = [
  'constructor(address _publisherStake, address _scoreRegistry, address _shMon)',
  'function postEvidenceRoot(bytes32 poolId, uint256 windowStart, bytes32 root) external',
  'function getEvidenceRoot(address poster, bytes32 poolId, uint256 windowStart) view returns (bytes32)',
  'function submitClaim(bytes32 poolId, address publisher, uint8 reason, uint128 bond) external returns (uint256 claimId)',
  'function executeClaim(uint256 claimId, address evidencePoster, uint256 windowStart, uint32 realisedApy, uint128 realisedTvl, uint32 updateCount, bytes32[] calldata proof) external',
  'function getClaim(uint256 claimId) view returns (tuple(bytes32 poolId, address publisher, address claimant, uint48 submittedAt, uint48 settlementEndsAt, uint128 claimantBond, uint32 publishedApy, uint8 publishedRiskScore, uint8 publishedConfidence, uint128 publishedTvl, uint8 status, uint8 reason))',
  'function hasActiveClaim(address publisher, bytes32 poolId) view returns (bool, uint256)',
  'event ClaimSubmitted(uint256 indexed claimId, bytes32 indexed poolId, address indexed publisher, address claimant, uint8 reason, uint48 settlementEndsAt)',
  'event ClaimExecuted(uint256 indexed claimId, address indexed publisher, address indexed watchdog, uint8 reason, uint128 slashAmount)',
];

// ── PerpRiskParams ────────────────────────────────────────────────────────────

const PERP_RISK_PARAMS_ABI = [
  'constructor(address _scoreRegistry, address _perpDex)',
  'function registerPool(bytes32 poolId, uint128 tvlCapUsd) external',
  'function getParams(bytes32 poolId) external returns (tuple(uint128 maxOI, uint8 maxLeverage, uint16 initialMarginBps, uint16 maintenanceMarginBps, uint16 fundingRateMultiplier, uint16 liquidationPenaltyBps, uint32 stalePriceThreshold, bool tradingHalted, uint48 computedAt, uint8 confidenceUsed))',
  'function getCachedParams(bytes32 poolId) view returns (tuple(uint128 maxOI, uint8 maxLeverage, uint16 initialMarginBps, uint16 maintenanceMarginBps, uint16 fundingRateMultiplier, uint16 liquidationPenaltyBps, uint32 stalePriceThreshold, bool tradingHalted, uint48 computedAt, uint8 confidenceUsed))',
  'function clearCircuitBreaker(bytes32 poolId) external',
  'function getCircuitBreaker(bytes32 poolId) view returns (tuple(bool halted, uint48 haltedAt, string reason))',
  'function getRegisteredPools() view returns (bytes32[])',
  'event RiskParamsComputed(bytes32 indexed poolId, uint128 maxOI, uint8 maxLeverage, uint16 initialMarginBps, uint16 maintenanceMarginBps, uint16 fundingRateMultiplier, bool tradingHalted, uint48 computedAt)',
  'event CircuitBreakerTripped(bytes32 indexed poolId, string reason, uint48 timestamp)',
];

module.exports = {
  SCORE_REGISTRY_ABI,
  PUBLISHER_STAKE_ABI,
  DEVIATION_ADJUDICATOR_ABI,
  PERP_RISK_PARAMS_ABI,
};
