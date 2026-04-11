/**
 * indexer/index.js
 * Entry point. Wires together the listener, root poster, and proof API.
 *
 * Required env vars (copy .env.example to .env and fill in):
 *   RPC_URL                — Monad RPC endpoint
 *   REGISTRY_ADDRESS       — ScoreRegistry contract address
 *   ADJUDICATOR_ADDRESS    — DeviationAdjudicator contract address
 *   POSTER_PRIVATE_KEY     — Private key of the account that posts roots on-chain
 *   API_PORT               — (optional) HTTP port for proof API, default 3001
 *   LOG_LEVEL              — (optional) debug | info | warn | error, default info
 */

require('dotenv').config();

const { ethers }   = require('ethers');
const db           = require('./db');
const Listener     = require('./listener');
const RootPoster   = require('./rootPoster');
const { startApi } = require('./api');
const logger       = require('./logger');

async function main() {
  // ── Validate env ──────────────────────────────────────────────────────────
  const required = ['RPC_URL', 'REGISTRY_ADDRESS', 'ADJUDICATOR_ADDRESS', 'POSTER_PRIVATE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error('Missing required env vars: %s', missing.join(', '));
    process.exit(1);
  }

  logger.info('='.repeat(56));
  logger.info('  Evidence Indexer starting up');
  logger.info('  RPC: %s', process.env.RPC_URL);
  logger.info('  Registry: %s', process.env.REGISTRY_ADDRESS);
  logger.info('  Adjudicator: %s', process.env.ADJUDICATOR_ADDRESS);
  logger.info('='.repeat(56));

  // ── Init DB ───────────────────────────────────────────────────────────────
  await db.getDb();
  logger.info('Database initialised');

  // ── Init provider and signer ──────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer   = new ethers.Wallet(process.env.POSTER_PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  logger.info('Connected to chain %s (chainId %d)', network.name, network.chainId);
  logger.info('Poster address: %s', signer.address);

  // ── Start components ──────────────────────────────────────────────────────
  const listener   = new Listener(provider, process.env.REGISTRY_ADDRESS);
  const rootPoster = new RootPoster(signer, process.env.ADJUDICATOR_ADDRESS);
  const apiServer  = startApi();

  await listener.start();
  await rootPoster.start();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info('Received %s — shutting down', signal);
    listener.stop();
    rootPoster.stop();
    apiServer.close(() => {
      logger.info('API server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
