/**
 * publisher/fetcher/defillama.js
 * Fetches yield pool data for Monad from DefiLlama.
 * Returns normalized pool objects ready for scoring.
 */

const axios  = require('axios');
const logger = require('../logger');

const YIELDS_URL  = 'https://yields.llama.fi/pools';
const CHAINS_URL  = 'https://api.llama.fi/v2/chains';
const TARGET_CHAIN = 'Monad';
const MIN_TVL_USD  = 50_000;   // ignore pools below $50k TVL
const MAX_APY      = 50_000;   // ignore obviously broken APY data (500% in bps)

async function fetchMonadPools() {
  logger.info('[DefiLlama] Fetching yield pools for %s...', TARGET_CHAIN);

  const res = await axios.get(YIELDS_URL, { timeout: 15_000 });
  const all  = res.data?.data || [];

  const monad = all.filter(p =>
    p.chain?.toLowerCase() === TARGET_CHAIN.toLowerCase() &&
    (p.tvlUsd || 0) >= MIN_TVL_USD
  );

  logger.info('[DefiLlama] Found %d pools on %s (of %d total)', monad.length, TARGET_CHAIN, all.length);

  return monad.map(normalise);
}

async function fetchMonadTvl() {
  try {
    const res = await axios.get(CHAINS_URL, { timeout: 10_000 });
    const chain = res.data?.find(c => c.name?.toLowerCase() === TARGET_CHAIN.toLowerCase());
    return chain?.tvl || 0;
  } catch (e) {
    logger.warn('[DefiLlama] Could not fetch chain TVL: %s', e.message);
    return 0;
  }
}

function normalise(p) {
  const baseApy   = Math.round((p.apyBase   || 0) * 100);   // % to bps
  const rewardApy = Math.round((p.apyReward || 0) * 100);
  const totalApy  = Math.min(baseApy + rewardApy, MAX_APY);
  const vol30d    = Math.round((p.apyPct30D  || 0) * 100);

  return {
    // Identity
    poolId:          p.pool,                          // DefiLlama pool UUID
    protocolSlug:    p.project,
    protocolName:    _titleCase(p.project),
    symbol:          p.symbol || 'UNKNOWN',
    category:        _mapCategory(p.category),
    chain:           p.chain,

    // APY (basis points)
    baseApy,
    rewardApy,
    totalApy,
    netApy:          Math.max(totalApy - 10, 0),       // rough gas drag estimate
    apyVolatility30d: Math.abs(vol30d),

    // Liquidity
    tvlUsd:          Math.round(p.tvlUsd || 0),
    liquidityDepth:  _estimateLiquidityDepth(p.tvlUsd || 0),
    utilisationRate: Math.round((p.utilRate || 0) * 100),

    // Risk signals from DefiLlama
    ilRisk:          p.ilRisk === 'yes' ? 50 : p.ilRisk === 'low' ? 20 : 0,
    audits:          p.audits || 0,
    auditLinks:      p.auditLinks || [],

    // Meta
    underlyingTokens: p.underlyingTokens || [],
    rewardTokens:     p.rewardTokens || [],
    exposure:         p.exposure,
    stablecoin:       p.stablecoin || false,
    poolMeta:         p.poolMeta || '',
  };
}

function _mapCategory(cat) {
  if (!cat) return 'Unknown';
  const c = cat.toLowerCase();
  if (c.includes('dex') || c.includes('amm') || c.includes('lp')) return 'DEX';
  if (c.includes('lend') || c.includes('borrow') || c.includes('money market')) return 'Lending';
  if (c.includes('stake') || c.includes('liquid')) return 'Staking';
  if (c.includes('vault') || c.includes('yield')) return 'Vault';
  if (c.includes('rwa') || c.includes('real world')) return 'RWA';
  return 'Unknown';
}

function _estimateLiquidityDepth(tvlUsd) {
  // Estimate slippage bps for a $100k trade based on TVL
  // Higher TVL = lower slippage
  if (tvlUsd > 50_000_000) return 10;
  if (tvlUsd > 10_000_000) return 30;
  if (tvlUsd > 1_000_000)  return 100;
  if (tvlUsd > 100_000)    return 300;
  return 500;
}

function _titleCase(str) {
  if (!str) return 'Unknown';
  return str.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { fetchMonadPools, fetchMonadTvl };
