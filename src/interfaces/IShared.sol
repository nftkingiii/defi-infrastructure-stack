// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * src/interfaces/IShared.sol
 * Shared interfaces, enums, structs, and errors used across the stack.
 * All contracts import from here to avoid redeclaration conflicts.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPublisherStake {
    function isAuthorised(address publisher) external view returns (bool);
    function slash(address publisher, uint128 slashMonAmount, address watchdog) external;
}

interface IScoreRegistry {
    function getLatestScore(bytes32 poolId) external view returns (PoolScore memory);
    function getScoreHistory(bytes32 poolId, uint256 n) external view returns (PoolScore[] memory);
    function getRiskData(bytes32 poolId) external view returns (
        uint8   riskScore,
        uint8   ilRisk,
        uint32  apyVolatility30d,
        uint32  liquidityDepth,
        uint8   confidence,
        uint48  timestamp
    );
    function getTotalApy(bytes32 poolId) external view returns (uint32 totalApy, uint48 timestamp);
}

interface IShMON {
    function exchangeRate() external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

// ── Enums ─────────────────────────────────────────────────────────────────────

enum Category {
    DEX,
    Lending,
    Staking,
    Vault,
    RWA,
    Perps,
    Unknown
}

enum PublisherStatus {
    Unregistered,
    Active,
    Unbonding,
    Slashed,
    Banned
}

enum ClaimStatus {
    Pending,
    Executed,
    Rejected,
    Expired
}

enum SlashReason {
    ApyDeviation,
    RiskScoreFlip,
    ConfidenceFraud
}

// ── Structs ───────────────────────────────────────────────────────────────────

struct PoolScore {
    bytes32  poolId;
    string   protocolName;
    string   symbol;
    Category category;
    uint32   baseApy;
    uint32   rewardApy;
    uint32   netApy;
    uint32   apyVolatility30d;
    uint128  tvlUsd;
    uint32   liquidityDepth;
    uint32   utilisationRate;
    uint8    riskScore;
    uint8    ilRisk;
    uint8    auditScore;
    uint16   protocolAgeDays;
    uint8    confidence;
    address  publisher;
    uint48   timestamp;
    uint32   updateCount;
}

struct PublisherInfo {
    uint128         shMonStaked;
    uint128         monValueAtDeposit;
    uint48          stakedAt;
    uint48          unbondingEndsAt;
    uint32          slashCount;
    uint32          poolsPublished;
    PublisherStatus status;
}

struct Claim {
    bytes32     poolId;
    address     publisher;
    address     claimant;
    uint48      submittedAt;
    uint48      settlementEndsAt;
    uint128     claimantBond;
    uint32      publishedApy;
    uint8       publishedRiskScore;
    uint8       publishedConfidence;
    uint128     publishedTvl;
    ClaimStatus status;
    SlashReason reason;
}

struct RiskParams {
    uint128 maxOI;
    uint8   maxLeverage;
    uint16  initialMarginBps;
    uint16  maintenanceMarginBps;
    uint16  fundingRateMultiplier;
    uint16  liquidationPenaltyBps;
    uint32  stalePriceThreshold;
    bool    tradingHalted;
    uint48  computedAt;
    uint8   confidenceUsed;
}

struct CircuitBreakerState {
    bool    halted;
    uint48  haltedAt;
    string  reason;
}

// ── Shared Errors ─────────────────────────────────────────────────────────────

error NotAuthorised(address caller);
error PoolNotFound(bytes32 poolId);
error ZeroAddress();
