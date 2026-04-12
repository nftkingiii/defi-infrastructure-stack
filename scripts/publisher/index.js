/**
 * publisher/index.js
 * Entry point for the yield intelligence publisher.
 *
 * Pipeline per run:
 *   1. Fetch pool data from DefiLlama (all Monad pools)
 *   2. Enrich each pool with on-chain data from Monad RPC
 *   3. Score each pool with rule-based scorer
 *   4. Augment scores with Claude AI reasoning
 *   5. Publish scored pools to ScoreRegistry on Monad
 *   6. Log results and schedule next run
 *
 * Required env vars:
 *   PRIVATE_KEY            — publisher wallet private key
 *   RPC_URL                — Monad RPC endpoint
 *   REGISTRY_ADDRESS       — ScoreRegistry contract address
 *   CHAIN_ID               — Monad chain ID (143 mainnet, 10143 testnet)
 *   ANTHROPIC_API_KEY      — (optional) enables AI score augmentation
 *   PUBLISH_INTERVAL_MIN   — (optional) minutes between runs, default 30
 *   MIN_RISK_SCORE         — (optional) skip pools below this score, default 0
 *   MAX_POOLS_PER_RUN      — (optional) cap pools per run, default 20
 *   LOG_LEVEL              — (optional) debug|info|warn|error
 */

require('dotenv').config();

const { ethers }              = require('ethers');
const cron                    = require('node-cron');
const { fetchMonadPools, fetchMonadTvl } = require('./fetcher/defillama');
const OnchainFetcher          = require('./fetcher/onchain');
const { scorePool }           = require('./scorer/rules');
const RegistryWriter          = require('./registry');
const logger                  = require('./logger');

// ── Config ────────────────────────────────────────────────────────────────────

const PUBLISH_INTERVAL_MIN = parseInt(process.env.PUBLISH_INTERVAL_MIN || '30');
const MIN_RISK_SCORE       = parseInt(process.env.MIN_RISK_SCORE       || '0');
const MAX_POOLS_PER_RUN    = parseInt(process.env.MAX_POOLS_PER_RUN    || '20');

// ── State ─────────────────────────────────────────────────────────────────────

let _runCount = 0;

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function runPipeline(writer, onchainFetcher) {
  _runCount++;
  const start = Date.now();
  logger.info('='.repeat(56));
  logger.info('Publisher run #%d starting...', _runCount);

  const results = {
    fetched:   0,
    enriched:  0,
    scored:    0,
    published: 0,
    skipped:   0,
    failed:    0,
  };

  try {
    // ── Step 1: Fetch from DefiLlama ──────────────────────────────────────────
    const pools = await fetchMonadPools();
    results.fetched = pools.length;

    if (!pools.length) {
      logger.warn('No pools fetched — aborting run');
      return results;
    }

    // Sort by TVL descending, take top MAX_POOLS_PER_RUN
    const topPools = pools
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, MAX_POOLS_PER_RUN);

    logger.info('Processing top %d pools by TVL', topPools.length);

    // ── Step 2–5: Enrich, score, augment, publish per pool ───────────────────
    for (const pool of topPools) {
      try {
        // Enrich with on-chain data
        const enriched = await onchainFetcher.enrich(pool);
        results.enriched++;

        // Rule-based score
        const ruleResult = scorePool(enriched);

        // AI augmentation
        const scoreResult = ruleResult;
        results.scored++;

        // Skip if below minimum risk score threshold
        if (scoreResult.riskScore < MIN_RISK_SCORE) {
          logger.debug('Skipping %s — riskScore %d below threshold %d',
            pool.protocolSlug, scoreResult.riskScore, MIN_RISK_SCORE);
          results.skipped++;
          continue;
        }

        logger.info('Pool: %-30s APY: %s%%  Risk: %d/100  Conf: %d/100  AI: %s',
          pool.protocolName,
          (pool.totalApy / 100).toFixed(2),
          scoreResult.riskScore,
          scoreResult.confidence,
          scoreResult.used ? 'yes' : 'no'
        );

        // Publish to registry
        const result = await writer.publish(enriched, scoreResult);

        if (result.published)    results.published++;
        else if (result.skipped) results.skipped++;
        else                     results.failed++;

      } catch (e) {
        logger.error('Pipeline error for %s: %s', pool.protocolSlug, e.message);
        results.failed++;
      }
    }

  } catch (e) {
    logger.error('Pipeline run #%d failed: %s', _runCount, e.message);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info('Run #%d complete in %ss — fetched=%d published=%d skipped=%d failed=%d',
    _runCount, elapsed,
    results.fetched, results.published, results.skipped, results.failed);
  logger.info('='.repeat(56));

  return results;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  // Validate env
  const required = ['PRIVATE_KEY', 'RPC_URL', 'REGISTRY_ADDRESS', 'CHAIN_ID'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error('Missing required env vars: %s', missing.join(', '));
    process.exit(1);
  }

  logger.info('='.repeat(56));
  logger.info('  Yield Intelligence Publisher');
  logger.info('  RPC:      %s', process.env.RPC_URL);
  logger.info('  Registry: %s', process.env.REGISTRY_ADDRESS);
  logger.info('  Chain ID: %s', process.env.CHAIN_ID);
  logger.info('  Interval: every %d min', PUBLISH_INTERVAL_MIN);
  logger.info('  AI:       %s', process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled');
  logger.info('='.repeat(56));

  // Setup provider and signer
  const provider       = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer         = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const network        = await provider.getNetwork();
  const balance        = await provider.getBalance(signer.address);

  logger.info('Connected to chain %s (chainId %s)', network.name, network.chainId.toString());
  logger.info('Publisher address: %s', signer.address);
  logger.info('Balance: %s MON', ethers.formatEther(balance));

  if (balance < ethers.parseEther('0.01')) {
    logger.warn('Low balance — may not have enough gas. Top up your publisher wallet.');
  }

  // Setup components
  const writer         = new RegistryWriter(signer, process.env.REGISTRY_ADDRESS, parseInt(process.env.CHAIN_ID));
  const onchainFetcher = new OnchainFetcher(process.env.RPC_URL);

  // Run immediately on startup
  await runPipeline(writer, onchainFetcher);

  // Schedule recurring runs
  const cronExpr = `*/${PUBLISH_INTERVAL_MIN} * * * *`;
  logger.info('Scheduling runs every %d minutes (%s)', PUBLISH_INTERVAL_MIN, cronExpr);

  cron.schedule(cronExpr, async () => {
    await runPipeline(writer, onchainFetcher);
  });

  // Graceful shutdown
  process.on('SIGINT',  () => { logger.info('Shutting down publisher'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('Shutting down publisher'); process.exit(0); });
}

main().catch(err => {
  logger.error('Fatal: %s', err.message);
  console.error(err);
  process.exit(1);
});
