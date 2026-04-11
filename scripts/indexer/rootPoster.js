/**
 * indexer/rootPoster.js
 * Periodically checks for completed settlement windows, builds merkle trees,
 * and posts evidence roots to DeviationAdjudicator on-chain.
 *
 * A window is "complete" when:
 *   current_time >= window_start + SETTLEMENT_WINDOW
 *
 * The indexer tracks every publisher/pool pair it has seen and builds a
 * separate tree for each combination.
 */

const { ethers }       = require('ethers');
const db               = require('./db');
const { buildTree }    = require('./merkle');
const logger           = require('./logger');

const ADJUDICATOR_ABI = [
  'function postEvidenceRoot(bytes32 poolId, uint256 windowStart, bytes32 root) external',
  'event EvidenceRootPosted(bytes32 indexed poolId, address indexed publisher, uint256 indexed windowStart, bytes32 root)',
];

// Must match DeviationAdjudicator.DEFAULT_SETTLEMENT_WINDOW (30 days in seconds)
const SETTLEMENT_WINDOW = 30 * 24 * 60 * 60;

// How often the root poster runs (every 10 minutes)
const POST_INTERVAL = 10 * 60 * 1000;

// Minimum snapshots required to build a meaningful tree
const MIN_SNAPSHOTS = 3;

class RootPoster {
  constructor(signer, adjudicatorAddress) {
    this.signer      = signer;
    this.adjudicator = new ethers.Contract(adjudicatorAddress, ADJUDICATOR_ABI, signer);
    this._running    = false;
    this._timer      = null;
  }

  async start() {
    this._running = true;
    logger.info('RootPoster started — checking windows every %dm', POST_INTERVAL / 60000);
    await this._run();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    logger.info('RootPoster stopped');
  }

  async _run() {
    if (!this._running) return;
    try {
      await this._processWindows();
      await this._postUnpostedRoots();
    } catch (err) {
      logger.error('RootPoster error: %s', err.message);
    }
    if (this._running) {
      this._timer = setTimeout(() => this._run(), POST_INTERVAL);
    }
  }

  /**
   * For each publisher/pool pair that has snapshots, check if the current
   * window has completed. If so, build the tree and store the root.
   */
  async _processWindows() {
    const now = Math.floor(Date.now() / 1000);

    // Get all distinct publisher/pool pairs from snapshots
    const pairs = this._getActivePairs();

    for (const { poolId, publisher } of pairs) {
      // Determine window boundaries
      // Window starts at the first snapshot for this pair, rounded down to day
      const firstSnap = db.getLatestSnapshot(poolId, publisher);
      if (!firstSnap) continue;

      // We use rolling windows: window N starts at (first_snap_ts + N * SETTLEMENT_WINDOW)
      // For simplicity, we use a single window starting from the first snapshot
      const windowStart = this._alignToDay(firstSnap.timestamp - SETTLEMENT_WINDOW);
      const windowEnd   = windowStart + SETTLEMENT_WINDOW;

      // Skip if window hasn't closed yet
      if (now < windowEnd) {
        logger.debug('Window not yet closed for pool=%s publisher=%s (closes in %dh)',
          poolId.slice(0, 10), publisher.slice(0, 10),
          Math.round((windowEnd - now) / 3600));
        continue;
      }

      // Skip if root already stored for this window
      const existing = db.getRoot(poolId, publisher, windowStart);
      if (existing) continue;

      // Fetch snapshots for this window
      const snapshots = db.getSnapshotsInWindow(poolId, publisher, windowStart, windowEnd);

      if (snapshots.length < MIN_SNAPSHOTS) {
        logger.warn('Skipping window for pool=%s publisher=%s — only %d snapshots (min %d)',
          poolId.slice(0, 10), publisher.slice(0, 10), snapshots.length, MIN_SNAPSHOTS);
        continue;
      }

      // Build tree and store root
      try {
        const { root } = buildTree(snapshots);
        db.insertRoot(poolId, publisher, windowStart, windowEnd, root, snapshots.length);
        logger.info('Root built: pool=%s publisher=%s window=%d snapshots=%d root=%s',
          poolId.slice(0, 10), publisher.slice(0, 10),
          windowStart, snapshots.length, root.slice(0, 12));
      } catch (err) {
        logger.error('Failed to build tree for pool=%s: %s', poolId.slice(0, 10), err.message);
      }
    }
  }

  /**
   * Posts any roots that have been built but not yet submitted on-chain.
   */
  async _postUnpostedRoots() {
    const unposted = db.getUnpostedRoots();

    for (const entry of unposted) {
      try {
        logger.info('Posting root on-chain: pool=%s windowStart=%d root=%s',
          entry.poolId.slice(0, 10), entry.windowStart, entry.root.slice(0, 12));

        const tx = await this.adjudicator.postEvidenceRoot(
          entry.poolId,
          entry.windowStart,
          entry.root
        );

        const receipt = await tx.wait();

        db.markRootPosted(entry.poolId, entry.publisher, entry.windowStart, receipt.hash);

        logger.info('Root posted on-chain: tx=%s', receipt.hash.slice(0, 12));
      } catch (err) {
        logger.error('Failed to post root on-chain for pool=%s: %s',
          entry.poolId.slice(0, 10), err.message);
      }
    }
  }

  /**
   * Returns all distinct (poolId, publisher) pairs that have at least one snapshot.
   */
  _getActivePairs() {
    return db.getActivePairs();
  }

  _alignToDay(timestamp) {
    return Math.floor(timestamp / 86400) * 86400;
  }
}

module.exports = RootPoster;
