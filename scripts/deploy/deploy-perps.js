/**
 * scripts/deploy/deploy-perps.js
 * Deploys MockUSDC and PerpsDEX, registers pools from ScoreRegistry.
 *
 * Run after deploy.js has deployed the main stack.
 *
 * Required env vars (same .env as deploy.js):
 *   PRIVATE_KEY
 *   RPC_URL
 *   NETWORK_NAME
 */

require('dotenv').config();

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
const log        = require('./logger');
const state      = require('./state');

const NETWORK = process.env.NETWORK_NAME || 'monad-testnet';

// Mint 1,000,000 USDC to deployer for testing
const USDC_MINT = BigInt(1_000_000 * 1e6);

const MOCK_USDC_ABI = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

const PERPS_DEX_ABI = [
  'function addPool(bytes32 poolId, uint32 initialPrice) external',
  'function getSupportedPools() view returns (bytes32[])',
  'function owner() view returns (address)',
];

const SCORE_REGISTRY_ABI = [
  'function getAllPoolIds() view returns (bytes32[])',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
];

const PERP_RISK_PARAMS_ABI = [
  'function registerPool(bytes32 poolId, uint128 tvlCapUsd) external',
  'function getRegisteredPools() view returns (bytes32[])',
];

function loadBytecode(contractName) {
  const binPath = path.join(__dirname, 'bytecode', `${contractName}.bin`);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Bytecode not found: ${binPath}\nRun forge build first.`);
  }
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

async function main() {
  const required = ['PRIVATE_KEY', 'RPC_URL'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    log.error('Missing env vars: %s', missing.join(', '));
    process.exit(1);
  }

  const deployed = state.load(NETWORK);
  if (!deployed.ScoreRegistry || !deployed.PerpRiskParams) {
    log.error('Main stack not found in deployments/%s.json — run deploy.js first', NETWORK);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();

  log.divider();
  log.info('Deploying MockUSDC and PerpsDEX');
  log.info('Network:  chainId %s', network.chainId.toString());
  log.info('Deployer: %s', signer.address);
  log.divider();

  // ── Step 1: Deploy MockUSDC ───────────────────────────────────────────────
  log.step('Deploy MockUSDC');

  let usdcAddress = state.get(NETWORK, 'MockUSDC');
  if (usdcAddress) {
    log.info('Already deployed: MockUSDC → %s', usdcAddress);
  } else {
    const factory  = new ethers.ContractFactory(MOCK_USDC_ABI, loadBytecode('MockUSDC'), signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    usdcAddress = await contract.getAddress();
    state.set(NETWORK, 'MockUSDC', usdcAddress);
    log.success('Deployed MockUSDC → %s', usdcAddress);
  }

  const mockUsdc = new ethers.Contract(usdcAddress, MOCK_USDC_ABI, signer);

  // ── Step 2: Mint USDC ─────────────────────────────────────────────────────
  log.step('Mint %s USDC to deployer', (Number(USDC_MINT) / 1e6).toLocaleString());
  const usdcBalance = await mockUsdc.balanceOf(signer.address);
  if (usdcBalance < USDC_MINT) {
    const tx = await mockUsdc.mint(signer.address, USDC_MINT);
    await tx.wait();
    log.success('Minted %s USDC', (Number(USDC_MINT) / 1e6).toLocaleString());
  } else {
    log.info('Sufficient USDC balance — skipping mint');
  }

  // ── Step 3: Deploy PerpsDEX ───────────────────────────────────────────────
  log.step('Deploy PerpsDEX');

  let perpsDexAddress = state.get(NETWORK, 'PerpsDEX');
  if (perpsDexAddress) {
    log.info('Already deployed: PerpsDEX → %s', perpsDexAddress);
  } else {
    const abi      = [...PERPS_DEX_ABI, 'constructor(address _riskParams, address _usdc)'];
    const factory  = new ethers.ContractFactory(abi, loadBytecode('PerpsDEX'), signer);
    const contract = await factory.deploy(deployed.PerpRiskParams, usdcAddress);
    await contract.waitForDeployment();
    perpsDexAddress = await contract.getAddress();
    state.set(NETWORK, 'PerpsDEX', perpsDexAddress);
    log.success('Deployed PerpsDEX → %s', perpsDexAddress);
  }

  const perpsDex      = new ethers.Contract(perpsDexAddress, PERPS_DEX_ABI, signer);
  const perpRiskParams = new ethers.Contract(deployed.PerpRiskParams, PERP_RISK_PARAMS_ABI, signer);
  const scoreRegistry  = new ethers.Contract(deployed.ScoreRegistry, SCORE_REGISTRY_ABI, signer);

  // ── Step 4: Register pools ────────────────────────────────────────────────
  log.step('Register pools from ScoreRegistry into PerpRiskParams and PerpsDEX');

  const poolIds = await scoreRegistry.getAllPoolIds();
  log.info('Found %s pools in ScoreRegistry', poolIds.length);

  const alreadyRegistered = await perpRiskParams.getRegisteredPools();
  const registeredSet     = new Set(alreadyRegistered);

  let registered = 0;
  for (const poolId of poolIds.slice(0, 5)) {   // register first 5 pools
    try {
      const score = await scoreRegistry.getLatestScore(poolId);

      // Register in PerpRiskParams if not already
      if (!registeredSet.has(poolId)) {
        const tx = await perpRiskParams.registerPool(poolId, 0);
        await tx.wait();
        log.info('Registered pool in PerpRiskParams: %s', score.protocolName);
      }

      // Add to PerpsDEX with initial price of $1.00 (10000 bps)
      const tx2 = await perpsDex.addPool(poolId, 10_000);
      await tx2.wait();
      log.info('Added pool to PerpsDEX: %s', score.protocolName);

      registered++;
    } catch (e) {
      log.warn('Failed to register pool %s: %s', poolId.slice(0, 10), e.message);
    }
  }

  log.success('Registered %s pools', registered);

  // ── Summary ───────────────────────────────────────────────────────────────
  log.divider();
  log.info('Deployment complete');
  log.info('');
  log.info(state.summarise(NETWORK));
  log.info('');
  log.info('Add to scripts/publisher/.env:');
  log.info('  PERPS_DEX_ADDRESS=%s', perpsDexAddress);
  log.divider();
}

main().catch(err => {
  log.error(err.message);
  console.error(err);
  process.exit(1);
});
