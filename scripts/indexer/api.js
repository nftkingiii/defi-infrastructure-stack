/**
 * indexer/api.js
 * Lightweight HTTP API that serves merkle proofs to watchdogs.
 * No framework dependencies — uses Node.js built-in http module.
 *
 * Endpoints:
 *   GET /health
 *   GET /proof?poolId=0x...&publisher=0x...&windowStart=1234567890&snapshotIndex=0
 *   GET /root?poolId=0x...&publisher=0x...&windowStart=1234567890
 *   GET /snapshots?poolId=0x...&publisher=0x...&windowStart=1234567890&windowEnd=1234567890
 */

const http                          = require('http');
const { URL }                       = require('url');
const db                            = require('./db');
const { buildTree, buildProofForIndex } = require('./merkle');
const logger                        = require('./logger');

const PORT = process.env.API_PORT || 3001;

function json(res, statusCode, data) {
  const body = JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  res.writeHead(statusCode, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function err(res, statusCode, message) {
  json(res, statusCode, { error: message });
}

async function handleRequest(req, res) {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const q        = url.searchParams;

  // ── GET /health ──────────────────────────────────────────────────────────
  if (pathname === '/health') {
    return json(res, 200, { status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
  }

  // ── GET /root ────────────────────────────────────────────────────────────
  if (pathname === '/root') {
    const poolId      = q.get('poolId');
    const publisher   = q.get('publisher');
    const windowStart = parseInt(q.get('windowStart'));

    if (!poolId || !publisher || isNaN(windowStart)) {
      return err(res, 400, 'Required: poolId, publisher, windowStart');
    }

    const root = db.getRoot(poolId, publisher, windowStart);
    if (!root) {
      return err(res, 404, 'Root not found for this pool/publisher/window combination');
    }

    return json(res, 200, {
      poolId,
      publisher,
      windowStart,
      root:      root.root,
      leafCount: root.leafCount,
      windowEnd: root.windowEnd,
      postedTx:  root.postedTx,
    });
  }

  // ── GET /proof ───────────────────────────────────────────────────────────
  if (pathname === '/proof') {
    const poolId         = q.get('poolId');
    const publisher      = q.get('publisher');
    const windowStart    = parseInt(q.get('windowStart'));
    const windowEnd      = parseInt(q.get('windowEnd'));
    const snapshotIndex  = parseInt(q.get('snapshotIndex') || '0');

    if (!poolId || !publisher || isNaN(windowStart) || isNaN(windowEnd)) {
      return err(res, 400, 'Required: poolId, publisher, windowStart, windowEnd');
    }

    const snapshots = db.getSnapshotsInWindow(poolId, publisher, windowStart, windowEnd);
    if (!snapshots.length) {
      return err(res, 404, 'No snapshots found for this window');
    }

    if (snapshotIndex >= snapshots.length) {
      return err(res, 400, `snapshotIndex ${snapshotIndex} out of range (${snapshots.length} snapshots)`);
    }

    let proof, root;
    try {
      const { tree, root: r } = buildTree(snapshots);
      proof = buildProofForIndex(snapshots, snapshotIndex);
      root  = r;
    } catch (e) {
      return err(res, 500, `Failed to build proof: ${e.message}`);
    }

    const snap = snapshots[snapshotIndex];

    return json(res, 200, {
      poolId,
      publisher,
      windowStart,
      windowEnd,
      snapshotIndex,
      snapshot: {
        timestamp:   snap.timestamp,
        realisedApy: snap.realisedApy,
        tvlUsd:      snap.tvlUsd,
        updateCount: snap.updateCount,
      },
      proof,
      root,
      totalSnapshots: snapshots.length,
    });
  }

  // ── GET /snapshots ───────────────────────────────────────────────────────
  if (pathname === '/snapshots') {
    const poolId      = q.get('poolId');
    const publisher   = q.get('publisher');
    const windowStart = parseInt(q.get('windowStart'));
    const windowEnd   = parseInt(q.get('windowEnd'));

    if (!poolId || !publisher || isNaN(windowStart) || isNaN(windowEnd)) {
      return err(res, 400, 'Required: poolId, publisher, windowStart, windowEnd');
    }

    const snapshots = db.getSnapshotsInWindow(poolId, publisher, windowStart, windowEnd);

    return json(res, 200, {
      poolId,
      publisher,
      windowStart,
      windowEnd,
      count:     snapshots.length,
      snapshots,
    });
  }

  return err(res, 404, 'Unknown endpoint');
}

function startApi() {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      logger.error('API error: %s', e.message);
      err(res, 500, 'Internal server error');
    }
  });

  server.listen(PORT, () => {
    logger.info('Proof API listening on http://localhost:%d', PORT);
  });

  return server;
}

module.exports = { startApi };
