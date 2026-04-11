/**
 * deploy/verify.js
 * Reads all deployed contract state and prints a full deployment summary.
 * Run after deploy.js to confirm everything is wired correctly.
 *
 * Usage: node verify.js
 */

require('dotenv').config();

const { ethers } = require('ethers');
const log        = require('./logger');
const state      = require('./state');
const {
  SCORE_REGISTRY_ABI,
  PUBLISHER_STAKE_ABI,
  DEVIATION_ADJUDICATOR_ABI,
  PERP_RISK_PARAMS_ABI,
} = require('./contracts');

const NETWORK = process.env.NETWORK_NAME || 'monad';

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network  = await provider.getNetwork();
  const deployed = state.load(NETWORK);

  log.divider();
  log.info('Deployment verification — %s (chainId %s)', NETWORK, network.chainId.toString());
  log.divider();

  if (!Object.keys(deployed).length) {
    log.warn('No deployments found for network: %s', NETWORK);
    process.exit(0);
  }

  log.info('Recorded addresses:');
  log.info(state.summarise(NETWORK));

  // ── PublisherStake ─────────────────────────────────────────────────────────
  if (deployed.PublisherStake) {
    log.step('PublisherStake @ %s', deployed.PublisherStake);
    const c = new ethers.Contract(deployed.PublisherStake, PUBLISHER_STAKE_ABI, provider);
    try {
      const shMon        = await c.shMon();
      const adjudicator  = await c.adjudicator();
      const minStake     = await c.minStakeMon();
      const pubCount     = await c.activePublisherCount();
      const unbonding    = await c.UNBONDING_PERIOD();

      log.info('shMon:              %s', shMon);
      log.info('adjudicator:        %s', adjudicator);
      log.info('minStakeMon:        %s MON', ethers.formatEther(minStake));
      log.info('activePublishers:   %s', pubCount.toString());
      log.info('unbondingPeriod:    %s days', (Number(unbonding) / 86400).toString());

      const adjSet = adjudicator !== ethers.ZeroAddress;
      adjSet
        ? log.success('Adjudicator is set')
        : log.warn('Adjudicator is still zero address — run deploy.js step 5');
    } catch (e) {
      log.error('Error reading PublisherStake: %s', e.message);
    }
  }

  // ── ScoreRegistry ──────────────────────────────────────────────────────────
  if (deployed.ScoreRegistry) {
    log.step('ScoreRegistry @ %s', deployed.ScoreRegistry);
    const c = new ethers.Contract(deployed.ScoreRegistry, SCORE_REGISTRY_ABI, provider);
    try {
      const stakeAddr  = await c.publisherStake();
      const poolCount  = await c.poolCount();
      const maxHistory = await c.MAX_HISTORY();
      const minGap     = await c.MIN_UPDATE_GAP();

      log.info('publisherStake:     %s', stakeAddr);
      log.info('poolCount:          %s', poolCount.toString());
      log.info('maxHistory:         %s snapshots', maxHistory.toString());
      log.info('minUpdateGap:       %s seconds', minGap.toString());

      const stakeMatch = stakeAddr.toLowerCase() === deployed.PublisherStake?.toLowerCase();
      stakeMatch
        ? log.success('publisherStake wired correctly')
        : log.warn('publisherStake mismatch — expected %s', deployed.PublisherStake);
    } catch (e) {
      log.error('Error reading ScoreRegistry: %s', e.message);
    }
  }

  // ── DeviationAdjudicator ───────────────────────────────────────────────────
  if (deployed.DeviationAdjudicator) {
    log.step('DeviationAdjudicator @ %s', deployed.DeviationAdjudicator);
    const c = new ethers.Contract(deployed.DeviationAdjudicator, DEVIATION_ADJUDICATOR_ABI, provider);
    try {
      const stakeAddr      = await c.publisherStake();
      const registryAddr   = await c.scoreRegistry();
      const settlWindow    = await c.settlementWindow();
      const apyThreshold   = await c.apyThresholdBps();
      const slashAmount    = await c.slashAmountMon();
      const claimCount     = await c.claimCount();

      log.info('publisherStake:     %s', stakeAddr);
      log.info('scoreRegistry:      %s', registryAddr);
      log.info('settlementWindow:   %s days', (Number(settlWindow) / 86400).toString());
      log.info('apyThreshold:       %s bps (%s%%)', apyThreshold.toString(), (Number(apyThreshold) / 100).toString());
      log.info('slashAmount:        %s MON', ethers.formatEther(slashAmount));
      log.info('claimCount:         %s', claimCount.toString());

      const stakeMatch    = stakeAddr.toLowerCase()    === deployed.PublisherStake?.toLowerCase();
      const registryMatch = registryAddr.toLowerCase() === deployed.ScoreRegistry?.toLowerCase();

      stakeMatch    ? log.success('publisherStake wired correctly') : log.warn('publisherStake mismatch');
      registryMatch ? log.success('scoreRegistry wired correctly')  : log.warn('scoreRegistry mismatch');
    } catch (e) {
      log.error('Error reading DeviationAdjudicator: %s', e.message);
    }
  }

  // ── PerpRiskParams ─────────────────────────────────────────────────────────
  if (deployed.PerpRiskParams) {
    log.step('PerpRiskParams @ %s', deployed.PerpRiskParams);
    const c = new ethers.Contract(deployed.PerpRiskParams, PERP_RISK_PARAMS_ABI, provider);
    try {
      const registryAddr   = await c.scoreRegistry();
      const perpDex        = await c.perpDex();
      const pools          = await c.getRegisteredPools();
      const maxScoreAge    = await c.MAX_SCORE_AGE_SECONDS();
      const minConfidence  = await c.MIN_CONFIDENCE();

      log.info('scoreRegistry:      %s', registryAddr);
      log.info('perpDex:            %s', perpDex);
      log.info('registeredPools:    %s', pools.length.toString());
      log.info('maxScoreAge:        %s seconds (%s min)', maxScoreAge.toString(), (Number(maxScoreAge) / 60).toString());
      log.info('minConfidence:      %s/100', minConfidence.toString());

      const registryMatch = registryAddr.toLowerCase() === deployed.ScoreRegistry?.toLowerCase();
      registryMatch
        ? log.success('scoreRegistry wired correctly')
        : log.warn('scoreRegistry mismatch — expected %s', deployed.ScoreRegistry);
    } catch (e) {
      log.error('Error reading PerpRiskParams: %s', e.message);
    }
  }

  log.divider();
  log.info('Verification complete');
  log.divider();
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
