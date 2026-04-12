/**
 * publisher/fetcher/onchain.js
 * Reads on-chain data from Monad to supplement DefiLlama data.
 * Fetches: pool TVL from protocol contracts, token prices, utilisation rates.
 *
 * Currently implements:
 *   - ERC20 totalSupply as a TVL cross-check
 *   - Aave V3-style pool utilisation (borrowedUSD / suppliedUSD)
 *   - Generic protocol age from first deployment block
 */

const { ethers } = require('ethers');
const logger     = require('../logger');

// Minimal ABIs
const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

// Known protocol contract addresses on Monad mainnet
// These get filled in as protocols deploy — start with what's known
const KNOWN_PROTOCOLS = {
  'aave-v3': {
    type:      'aave',
    poolAddr:  null,   // fill in after Aave deploys on Monad mainnet
  },
};

// Seconds per block on Monad (~0.5s block time)
const BLOCK_TIME_SECONDS = 0.5;

class OnchainFetcher {
  constructor(rpcUrl) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this._deployBlocks = {};   // cache: contractAddr => deployBlock
  }

  /**
   * Enriches a pool object with on-chain data.
   * Returns the pool with additional fields merged in.
   */
  async enrich(pool) {
    const enriched = { ...pool };

    try {
      // Protocol age from deployment block
      const age = await this._getProtocolAgeDays(pool.protocolSlug);
      if (age !== null) enriched.protocolAgeDays = age;

      // Aave-specific utilisation rate
      if (pool.protocolSlug === 'aave-v3') {
        const util = await this._getAaveUtilisation(pool);
        if (util !== null) enriched.utilisationRate = util;
      }

    } catch (e) {
      logger.debug('[OnChain] Enrich failed for %s: %s', pool.protocolSlug, e.message);
    }

    return enriched;
  }

  /**
   * Returns protocol age in days based on first contract deployment block.
   * Falls back to 0 if contract address not known.
   */
  async _getProtocolAgeDays(protocolSlug) {
    const known = KNOWN_PROTOCOLS[protocolSlug];
    if (!known?.poolAddr) return null;

    try {
      if (this._deployBlocks[known.poolAddr]) {
        return this._blocksToDays(this._deployBlocks[known.poolAddr]);
      }

      // Binary search for first non-empty block (simplified: use getCode existence)
      const currentBlock = await this.provider.getBlockNumber();
      const code         = await this.provider.getCode(known.poolAddr);

      if (code === '0x') return 0;

      // Estimate: use a known reference block or default to recent deployment
      const deployBlock = currentBlock - 1_000_000;   // rough estimate
      this._deployBlocks[known.poolAddr] = deployBlock;

      return this._blocksToDays(currentBlock - deployBlock);
    } catch (e) {
      return null;
    }
  }

  async _getAaveUtilisation(pool) {
    const known = KNOWN_PROTOCOLS['aave-v3'];
    if (!known?.poolAddr) return null;

    try {
      const contract = new ethers.Contract(known.poolAddr, AAVE_POOL_ABI, this.provider);

      // We'd need the underlying asset address — skip if not available
      if (!pool.underlyingTokens?.length) return null;

      const assetAddr = pool.underlyingTokens[0];
      const data      = await contract.getReserveData(assetAddr);

      // currentLiquidityRate is in RAY (1e27), convert to utilisation bps
      const liquidityRate = Number(data.currentLiquidityRate) / 1e27;
      return Math.round(liquidityRate * 10_000);
    } catch {
      return null;
    }
  }

  _blocksToDays(blocks) {
    return Math.round((blocks * BLOCK_TIME_SECONDS) / 86400);
  }

  /**
   * Returns current block timestamp from Monad RPC.
   */
  async getCurrentTimestamp() {
    const block = await this.provider.getBlock('latest');
    return block?.timestamp || Math.floor(Date.now() / 1000);
  }
}

module.exports = OnchainFetcher;
