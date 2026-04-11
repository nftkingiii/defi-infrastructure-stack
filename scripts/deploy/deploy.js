/**
 * deploy/deploy.js
 * Deploys the full governance-minimized DeFi infrastructure stack.
 *
 * Deployment order:
 *   1. PublisherStake     (with zero address as adjudicator placeholder)
 *   2. ScoreRegistry      (needs PublisherStake)
 *   3. DeviationAdjudicator (needs PublisherStake + ScoreRegistry)
 *   4. PerpRiskParams     (needs ScoreRegistry + perpDex address)
 *   5. Set adjudicator    (update PublisherStake with real adjudicator address)
 *   6. Verify             (smoke-test all contracts are wired correctly)
 *
 * Re-run safe: already-deployed contracts are skipped using deployments/{network}.json.
 *
 * Required env vars:
 *   PRIVATE_KEY           — deployer wallet private key
 *   RPC_URL               — Monad RPC endpoint
 *   SHMON_ADDRESS         — shMON token contract address on Monad
 *   PERP_DEX_ADDRESS      — address of the perp DEX that will consume PerpRiskParams
 *   MIN_STAKE_MON         — minimum publisher stake in MON (e.g. "1000" for 1000 MON)
 *
 * Optional:
 *   NETWORK_NAME          — label for the deployment file (default: monad)
 *
 * Bytecode:
 *   Place compiled bytecode in deploy/bytecode/{ContractName}.bin
 *   Compile with: forge build (Foundry) or npx hardhat compile
 */

require('dotenv').config();

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
const log        = require('./logger');
const state      = require('./state');
const {
  SCORE_REGISTRY_ABI,
  PUBLISHER_STAKE_ABI,
  DEVIATION_ADJUDICATOR_ABI,
  PERP_RISK_PARAMS_ABI,
} = require('./contracts');

// ── Config ────────────────────────────────────────────────────────────────────

const NETWORK      = process.env.NETWORK_NAME || 'monad';
const MIN_STAKE    = ethers.parseEther(process.env.MIN_STAKE_MON || '1000');

// ── Bytecode loader ───────────────────────────────────────────────────────────

function loadBytecode(contractName) {
  const binPath = path.join(__dirname, 'bytecode', `${contractName}.bin`);
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Bytecode not found: ${binPath}\n` +
      `Run 'forge build' or 'npx hardhat compile' and copy the .bin output to deploy/bytecode/`
    );
  }
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

// ── Deploy helper ─────────────────────────────────────────────────────────────

async function deployContract(signer, name, abi, bytecode, constructorArgs = []) {
  const existing = state.get(NETWORK, name);
  if (existing) {
    log.info('Already deployed: %s → %s', name, existing);
    return new ethers.Contract(existing, abi, signer);
  }

  log.info('Deploying %s...', name);

  const factory  = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);

  log.info('Tx hash: %s', contract.deploymentTransaction().hash);
  log.info('Waiting for confirmation...');

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  state.set(NETWORK, name, address);
  log.success('Deployed %s → %s', name, address);

  return contract;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Validate env
  const required = ['PRIVATE_KEY', 'RPC_URL', 'SHMON_ADDRESS', 'PERP_DEX_ADDRESS'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    log.error('Missing required env vars: %s', missing.join(', '));
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();

  log.divider();
  log.info('Deploying governance-minimized DeFi infrastructure stack');
  log.info('Network:    %s (chainId %s)', network.name, network.chainId.toString());
  log.info('Deployer:   %s', signer.address);
  log.info('shMON:      %s', process.env.SHMON_ADDRESS);
  log.info('Perp DEX:   %s', process.env.PERP_DEX_ADDRESS);
  log.info('Min stake:  %s MON', process.env.MIN_STAKE_MON || '1000');
  log.divider();

  // Check deployer balance
  const balance = await provider.getBalance(signer.address);
  log.info('Deployer balance: %s MON', ethers.formatEther(balance));
  if (balance < ethers.parseEther('0.1')) {
    log.warn('Low balance — may not have enough gas for all deployments');
  }

  // ── Step 1: PublisherStake (adjudicator = zero address placeholder) ────────
  log.step('Deploy PublisherStake');
  const publisherStake = await deployContract(
    signer,
    'PublisherStake',
    PUBLISHER_STAKE_ABI,
    loadBytecode('PublisherStake'),
    [
      process.env.SHMON_ADDRESS,
      ethers.ZeroAddress,       // adjudicator set in step 5
      MIN_STAKE,
    ]
  );

  // ── Step 2: ScoreRegistry ──────────────────────────────────────────────────
  log.step('Deploy ScoreRegistry');
  const scoreRegistry = await deployContract(
    signer,
    'ScoreRegistry',
    SCORE_REGISTRY_ABI,
    loadBytecode('ScoreRegistry'),
    [await publisherStake.getAddress()]
  );

  // ── Step 3: DeviationAdjudicator ──────────────────────────────────────────
  log.step('Deploy DeviationAdjudicator');
  const adjudicator = await deployContract(
    signer,
    'DeviationAdjudicator',
    DEVIATION_ADJUDICATOR_ABI,
    loadBytecode('DeviationAdjudicator'),
    [
      await publisherStake.getAddress(),
      await scoreRegistry.getAddress(),
      process.env.SHMON_ADDRESS,
    ]
  );

  // ── Step 4: PerpRiskParams ─────────────────────────────────────────────────
  log.step('Deploy PerpRiskParams');
  const perpRiskParams = await deployContract(
    signer,
    'PerpRiskParams',
    PERP_RISK_PARAMS_ABI,
    loadBytecode('PerpRiskParams'),
    [
      await scoreRegistry.getAddress(),
      process.env.PERP_DEX_ADDRESS,
    ]
  );

  // ── Step 5: Set adjudicator on PublisherStake ──────────────────────────────
  log.step('Set adjudicator on PublisherStake');
  const adjudicatorAlreadySet = state.get(NETWORK, 'AdjudicatorSet');
  if (!adjudicatorAlreadySet) {
    const adjAddress = await adjudicator.getAddress();
    log.info('Calling setAdjudicator(%s)...', adjAddress);
    const tx = await publisherStake.setAdjudicator(adjAddress);
    await tx.wait();
    state.set(NETWORK, 'AdjudicatorSet', true);
    log.success('Adjudicator set on PublisherStake');
  } else {
    log.info('Adjudicator already set — skipping');
  }

  // ── Step 6: Smoke-test verification ───────────────────────────────────────
  log.step('Verify deployment');
  await verify(provider, signer, {
    publisherStake,
    scoreRegistry,
    adjudicator,
    perpRiskParams,
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  log.divider();
  log.info('Deployment complete. Addresses saved to deployments/%s.json', NETWORK);
  log.info('');
  log.info(state.summarise(NETWORK));
  log.divider();
}

// ── Verification ──────────────────────────────────────────────────────────────

async function verify(provider, signer, contracts) {
  const { publisherStake, scoreRegistry, adjudicator, perpRiskParams } = contracts;

  // Check PublisherStake is pointing to correct shMON
  try {
    const shMonAddr = await publisherStake.shMon();
    if (shMonAddr.toLowerCase() === process.env.SHMON_ADDRESS.toLowerCase()) {
      log.success('PublisherStake.shMon() → correct');
    } else {
      log.warn('PublisherStake.shMon() mismatch: got %s', shMonAddr);
    }
  } catch (e) {
    log.warn('Could not verify PublisherStake.shMon(): %s', e.message);
  }

  // Check ScoreRegistry points to PublisherStake
  try {
    const stakeAddr     = await scoreRegistry.publisherStake();
    const expectedAddr  = await publisherStake.getAddress();
    if (stakeAddr.toLowerCase() === expectedAddr.toLowerCase()) {
      log.success('ScoreRegistry.publisherStake() → correct');
    } else {
      log.warn('ScoreRegistry.publisherStake() mismatch: got %s', stakeAddr);
    }
  } catch (e) {
    log.warn('Could not verify ScoreRegistry.publisherStake(): %s', e.message);
  }

  // Check pool count starts at zero
  try {
    const count = await scoreRegistry.poolCount();
    log.success('ScoreRegistry.poolCount() → %s (fresh)', count.toString());
  } catch (e) {
    log.warn('Could not read ScoreRegistry.poolCount(): %s', e.message);
  }

  // Check adjudicator settlement window
  try {
    const window = await adjudicator.settlementWindow();
    log.success('DeviationAdjudicator.settlementWindow() → %s days',
      (Number(window) / 86400).toString());
  } catch (e) {
    log.warn('Could not read DeviationAdjudicator.settlementWindow(): %s', e.message);
  }

  // Check PerpRiskParams points to correct registry
  try {
    const regAddr      = await perpRiskParams.scoreRegistry();
    const expectedAddr = await scoreRegistry.getAddress();
    if (regAddr.toLowerCase() === expectedAddr.toLowerCase()) {
      log.success('PerpRiskParams.scoreRegistry() → correct');
    } else {
      log.warn('PerpRiskParams.scoreRegistry() mismatch: got %s', regAddr);
    }
  } catch (e) {
    log.warn('Could not verify PerpRiskParams.scoreRegistry(): %s', e.message);
  }
}

main().catch(err => {
  log.error(err.message);
  console.error(err);
  process.exit(1);
});
