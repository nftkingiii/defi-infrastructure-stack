/**
 * indexer/listener.js
 * Polls ScoreRegistry for ScorePublished events.
 * Stores each event as a snapshot in SQLite.
 * Uses block cursor to avoid reprocessing events on restart.
 */

const { ethers }  = require('ethers');
const db          = require('./db');
const logger      = require('./logger');

// Minimal ABI — only the events and reads we need
const REGISTRY_ABI = [
  'event ScorePublished(bytes32 indexed poolId, address indexed publisher, uint8 riskScore, uint32 netApy, uint128 tvlUsd, uint48 timestamp)',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
];

const CURSOR_KEY     = 'ScoreRegistry';
const BLOCK_CHUNK    = 2000;   // events fetched per RPC call
const POLL_INTERVAL  = 15_000; // ms between polls

class Listener {
  constructor(provider, registryAddress) {
    this.provider = provider;
    this.registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
    this._running = false;
    this._timer   = null;
  }

  async start() {
    await db.getDb();
    this._running = true;
    logger.info('Listener started — polling ScoreRegistry every %ds', POLL_INTERVAL / 1000);
    await this._poll();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    logger.info('Listener stopped');
  }

  async _poll() {
    if (!this._running) return;
    try {
      await this._processNewEvents();
    } catch (err) {
      logger.error('Listener poll error: %s', err.message);
    }
    if (this._running) {
      this._timer = setTimeout(() => this._poll(), POLL_INTERVAL);
    }
  }

  async _processNewEvents() {
    const latestBlock = await this.provider.getBlockNumber();
    const fromBlock   = db.getCursor(CURSOR_KEY) + 1;

    if (fromBlock > latestBlock) {
      logger.debug('No new blocks (cursor=%d, latest=%d)', fromBlock - 1, latestBlock);
      return;
    }

    let processed = 0;
    let cursor    = fromBlock;

    while (cursor <= latestBlock) {
      const toBlock = Math.min(cursor + BLOCK_CHUNK - 1, latestBlock);

      logger.debug('Fetching events blocks %d–%d', cursor, toBlock);

      const events = await this.registry.queryFilter(
        this.registry.filters.ScorePublished(),
        cursor,
        toBlock
      );

      for (const event of events) {
        await this._handleEvent(event);
        processed++;
      }

      db.setCursor(CURSOR_KEY, toBlock);
      cursor = toBlock + 1;
    }

    if (processed > 0) {
      logger.info('Listener: processed %d new ScorePublished events (blocks %d–%d)',
        processed, fromBlock, latestBlock);
    }
  }

  async _handleEvent(event) {
    const { poolId, publisher, netApy, tvlUsd, timestamp } = event.args;

    // Fetch full score to get updateCount (not in event args)
    let updateCount = 0;
    try {
      const score  = await this.registry.getLatestScore(poolId);
      updateCount  = Number(score.updateCount);
    } catch {
      logger.warn('Could not fetch updateCount for pool %s — defaulting to 0', poolId);
    }

    const snap = {
      poolId:      poolId,
      publisher:   publisher,
      blockNumber: event.blockNumber,
      timestamp:   Number(timestamp),
      realisedApy: Number(netApy),
      tvlUsd:      tvlUsd.toString(),
      updateCount: updateCount,
      txHash:      event.transactionHash,
    };

    db.insertSnapshot(snap);

    logger.debug('Snapshot stored: pool=%s publisher=%s apy=%dbps tvl=%s',
      poolId.slice(0, 10), publisher.slice(0, 10), snap.realisedApy, snap.tvlUsd);
  }
}

module.exports = Listener;
