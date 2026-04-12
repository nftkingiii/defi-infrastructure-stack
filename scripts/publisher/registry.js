/**
 * publisher/registry.js
 * Builds PoolScore structs from scored pool data and publishes them
 * to the ScoreRegistry contract on Monad.
 *
 * Handles:
 *   - poolId derivation (must match ScoreRegistry.derivePoolId)
 *   - struct assembly matching the PoolScore ABI exactly
 *   - gas estimation and retry on failure
 *   - rate limiting (respects MIN_UPDATE_GAP of 60s per pool)
 */

const { ethers } = require('ethers');
const logger     = require('./logger');

// Category enum — must match IShared.sol
const CATEGORY = {
  DEX:     0,
  Lending: 1,
  Staking: 2,
  Vault:   3,
  RWA:     4,
  Perps:   5,
  Unknown: 6,
};

const REGISTRY_ABI = [
  'function publishScore(tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount) entry) external',
  'function derivePoolId(uint256 chainId, string calldata protocolSlug, string calldata symbol) pure returns (bytes32)',
  'function isRegistered(bytes32 poolId) view returns (bool)',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
  'function MIN_UPDATE_GAP() view returns (uint256)',
];

const MIN_UPDATE_GAP_SECONDS = 60;   // matches contract constant
const MAX_RETRIES            = 3;
const RETRY_DELAY_MS         = 5_000;

class RegistryWriter {
  constructor(signer, registryAddress, chainId) {
    this.signer   = signer;
    this.registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
    this.chainId  = chainId;
    this._lastPublish = {};   // poolId => timestamp (rate limit tracking)
  }

  /**
   * Publishes a scored pool to the registry.
   * Skips if rate limited. Retries on transient failures.
   *
   * @param pool       Enriched pool object from fetcher
   * @param scoreResult Result from scorer (riskScore, confidence, reasoning)
   * @returns { published, poolId, txHash, skipped, reason }
   */
  async publish(pool, scoreResult) {
    const poolId = await this._derivePoolId(pool);

    // Rate limit check
    if (this._isRateLimited(poolId)) {
      logger.debug('[Registry] Skipping %s — rate limited', pool.protocolSlug);
      return { published: false, poolId, skipped: true, reason: 'rate_limited' };
    }

    const entry = this._buildEntry(pool, scoreResult, poolId);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info('[Registry] Publishing %s (attempt %d/%d) riskScore=%d confidence=%d',
          pool.protocolName, attempt, MAX_RETRIES,
          scoreResult.riskScore, scoreResult.confidence);

        // Estimate gas first to catch reverts early
        await this.registry.publishScore.estimateGas(entry);

        const tx      = await this.registry.publishScore(entry);
        const receipt = await tx.wait();

        this._lastPublish[poolId] = Math.floor(Date.now() / 1000);

        logger.info('[Registry] Published %s — tx=%s block=%d',
          pool.protocolName, receipt.hash.slice(0, 12), receipt.blockNumber);

        return {
          published: true,
          poolId,
          txHash:    receipt.hash,
          skipped:   false,
        };

      } catch (e) {
        const isLast = attempt === MAX_RETRIES;
        logger.warn('[Registry] Publish failed for %s (attempt %d): %s',
          pool.protocolSlug, attempt, e.message);

        if (isLast) {
          return { published: false, poolId, skipped: false, reason: e.message };
        }

        await _sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  /**
   * Derives the poolId the same way the contract does.
   * keccak256(abi.encodePacked(chainId, protocolSlug, symbol))
   */
  async _derivePoolId(pool) {
    return await this.registry.derivePoolId(
      this.chainId,
      pool.protocolSlug,
      pool.symbol
    );
  }

  /**
   * Assembles the PoolScore struct matching IShared.sol exactly.
   */
  _buildEntry(pool, scoreResult, poolId) {
    return {
      poolId,
      protocolName:     pool.protocolName.slice(0, 100),
      symbol:           pool.symbol.slice(0, 50),
      category:         CATEGORY[pool.category] ?? CATEGORY.Unknown,
      baseApy:          Math.min(pool.baseApy,          500_000),
      rewardApy:        Math.min(pool.rewardApy,        500_000),
      netApy:           Math.min(pool.netApy,           500_000),
      apyVolatility30d: Math.min(pool.apyVolatility30d, 500_000),
      tvlUsd:           BigInt(Math.round(pool.tvlUsd * 1e6)),   // scaled 1e6
      liquidityDepth:   Math.min(pool.liquidityDepth || 100, 65535),
      utilisationRate:  Math.min(pool.utilisationRate || 0, 10_000),
      riskScore:        Math.max(0, Math.min(100, scoreResult.riskScore)),
      ilRisk:           Math.max(0, Math.min(100, pool.ilRisk || 0)),
      auditScore:       Math.max(0, Math.min(100, (pool.audits || 0) * 33)),
      protocolAgeDays:  Math.min(pool.protocolAgeDays || 0, 65535),
      confidence:       Math.max(0, Math.min(100, scoreResult.confidence)),
      publisher:        ethers.ZeroAddress,   // overwritten by contract
      timestamp:        0,                    // overwritten by contract
      updateCount:      0,                    // overwritten by contract
    };
  }

  _isRateLimited(poolId) {
    const last = this._lastPublish[poolId];
    if (!last) return false;
    return (Math.floor(Date.now() / 1000) - last) < MIN_UPDATE_GAP_SECONDS;
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = RegistryWriter;
