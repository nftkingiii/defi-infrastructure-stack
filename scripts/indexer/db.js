/**
 * indexer/db.js
 * SQLite database layer using sql.js (pure JS, no native build).
 * Persists snapshots to disk as a binary .db file.
 *
 * Tables:
 *   snapshots   — one row per ScorePublished event
 *   roots       — one row per posted evidence root (windowStart → root)
 *   cursors     — tracks last processed block per contract
 */

const fs   = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data', 'indexer.db');

let _db   = null;
let _save = null;   // function to flush in-memory db to disk

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  // Load existing db from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new SQL.Database();
  }

  _save = () => {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  };

  _initSchema();
  return _db;
}

function _initSchema() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id       TEXT    NOT NULL,
      publisher     TEXT    NOT NULL,
      block_number  INTEGER NOT NULL,
      timestamp     INTEGER NOT NULL,
      realised_apy  INTEGER NOT NULL,
      tvl_usd       TEXT    NOT NULL,
      update_count  INTEGER NOT NULL,
      tx_hash       TEXT    NOT NULL,
      UNIQUE(pool_id, publisher, block_number)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_pool_ts
      ON snapshots(pool_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_snapshots_publisher
      ON snapshots(publisher, pool_id, timestamp);

    CREATE TABLE IF NOT EXISTS roots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id       TEXT    NOT NULL,
      publisher     TEXT    NOT NULL,
      window_start  INTEGER NOT NULL,
      window_end    INTEGER INTEGER NOT NULL,
      root          TEXT    NOT NULL,
      leaf_count    INTEGER NOT NULL,
      posted_tx     TEXT,
      posted_at     INTEGER,
      UNIQUE(pool_id, publisher, window_start)
    );

    CREATE TABLE IF NOT EXISTS cursors (
      contract_name TEXT PRIMARY KEY,
      last_block    INTEGER NOT NULL DEFAULT 0
    );
  `);
  _save();
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

function insertSnapshot(snap) {
  const db = _db;
  db.run(
    `INSERT OR IGNORE INTO snapshots
       (pool_id, publisher, block_number, timestamp, realised_apy, tvl_usd, update_count, tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snap.poolId,
      snap.publisher.toLowerCase(),
      snap.blockNumber,
      snap.timestamp,
      snap.realisedApy,
      snap.tvlUsd.toString(),
      snap.updateCount,
      snap.txHash,
    ]
  );
  _save();
}

function getSnapshotsInWindow(poolId, publisher, windowStart, windowEnd) {
  const db = _db;
  const rows = db.exec(
    `SELECT timestamp, realised_apy, tvl_usd, update_count
     FROM snapshots
     WHERE pool_id = ? AND publisher = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`,
    [poolId, publisher.toLowerCase(), windowStart, windowEnd]
  );
  if (!rows.length || !rows[0].values.length) return [];
  return rows[0].values.map(([timestamp, realisedApy, tvlUsd, updateCount]) => ({
    timestamp,
    realisedApy,
    tvlUsd,
    updateCount,
  }));
}

function getLatestSnapshot(poolId, publisher) {
  const db = _db;
  const rows = db.exec(
    `SELECT timestamp, realised_apy, tvl_usd, update_count
     FROM snapshots
     WHERE pool_id = ? AND publisher = ?
     ORDER BY timestamp DESC LIMIT 1`,
    [poolId, publisher.toLowerCase()]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const [timestamp, realisedApy, tvlUsd, updateCount] = rows[0].values[0];
  return { timestamp, realisedApy, tvlUsd, updateCount };
}

function getActivePairs() {
  const rows = _db.exec(
    `SELECT DISTINCT pool_id, publisher FROM snapshots`
  );
  if (!rows.length || !rows[0].values.length) return [];
  return rows[0].values.map(([poolId, publisher]) => ({ poolId, publisher }));
}

// ── Roots ─────────────────────────────────────────────────────────────────────

function insertRoot(poolId, publisher, windowStart, windowEnd, root, leafCount) {
  const db = _db;
  db.run(
    `INSERT OR REPLACE INTO roots
       (pool_id, publisher, window_start, window_end, root, leaf_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [poolId, publisher.toLowerCase(), windowStart, windowEnd, root, leafCount]
  );
  _save();
}

function markRootPosted(poolId, publisher, windowStart, txHash) {
  const db = _db;
  db.run(
    `UPDATE roots SET posted_tx = ?, posted_at = ?
     WHERE pool_id = ? AND publisher = ? AND window_start = ?`,
    [txHash, Math.floor(Date.now() / 1000), poolId, publisher.toLowerCase(), windowStart]
  );
  _save();
}

function getRoot(poolId, publisher, windowStart) {
  const db = _db;
  const rows = db.exec(
    `SELECT root, leaf_count, window_end, posted_tx
     FROM roots
     WHERE pool_id = ? AND publisher = ? AND window_start = ?`,
    [poolId, publisher.toLowerCase(), windowStart]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const [root, leafCount, windowEnd, postedTx] = rows[0].values[0];
  return { root, leafCount, windowEnd, postedTx };
}

function getUnpostedRoots() {
  const db = _db;
  const rows = db.exec(
    `SELECT pool_id, publisher, window_start, window_end, root, leaf_count
     FROM roots WHERE posted_tx IS NULL`
  );
  if (!rows.length || !rows[0].values.length) return [];
  return rows[0].values.map(([poolId, publisher, windowStart, windowEnd, root, leafCount]) => ({
    poolId, publisher, windowStart, windowEnd, root, leafCount
  }));
}

// ── Cursors ───────────────────────────────────────────────────────────────────

function getCursor(contractName) {
  const db = _db;
  const rows = db.exec(
    `SELECT last_block FROM cursors WHERE contract_name = ?`,
    [contractName]
  );
  if (!rows.length || !rows[0].values.length) return 0;
  return rows[0].values[0][0];
}

function setCursor(contractName, blockNumber) {
  const db = _db;
  db.run(
    `INSERT INTO cursors (contract_name, last_block) VALUES (?, ?)
     ON CONFLICT(contract_name) DO UPDATE SET last_block = excluded.last_block`,
    [contractName, blockNumber]
  );
  _save();
}

module.exports = {
  getDb,
  insertSnapshot,
  getSnapshotsInWindow,
  getLatestSnapshot,
  getActivePairs,
  insertRoot,
  markRootPosted,
  getRoot,
  getUnpostedRoots,
  getCursor,
  setCursor,
};
