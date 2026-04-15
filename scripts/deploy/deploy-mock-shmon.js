/**
 * scripts/deploy/deploy-mock-shmon.js
 * Deploys MockShMON on testnet, mints tokens to your wallet,
 * approves PublisherStake, and registers you as a publisher.
 *
 * Run after deploy.js has already deployed the main stack.
 *
 * Required env vars (same .env as deploy.js):
 *   PRIVATE_KEY
 *   RPC_URL
 *   NETWORK_NAME
 *
 * Also reads deployments/{NETWORK_NAME}.json for PublisherStake address.
 */

require('dotenv').config();

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
const log        = require('./logger');
const state      = require('./state');

const NETWORK = process.env.NETWORK_NAME || 'monad-testnet';

// Mint 2000 mock shMON — worth 2100 MON at 1.05 rate, safely above 100 MON minimum
const MINT_AMOUNT  = ethers.parseEther('2000');
// Stake 1100 shMON — worth 1155 MON, above the 100 MON minimum
const STAKE_AMOUNT = ethers.parseEther('1100');

const MOCK_SHMON_ABI = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function exchangeRate() view returns (uint256)',
];

const PUBLISHER_STAKE_ABI = [
  'function register(uint128 shMonAmount) external',
  'function isAuthorised(address publisher) view returns (bool)',
  'function minStakeMon() view returns (uint128)',
  'function getPublisher(address publisher) view returns (tuple(uint128 shMonStaked, uint128 monValueAtDeposit, uint48 stakedAt, uint48 unbondingEndsAt, uint32 slashCount, uint32 poolsPublished, uint8 status))',
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
  if (!deployed.PublisherStake) {
    log.error('PublisherStake not found in deployments/%s.json — run deploy.js first', NETWORK);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const network  = await provider.getNetwork();

  log.divider();
  log.info('Deploying MockShMON and registering publisher');
  log.info('Network:    chainId %s', network.chainId.toString());
  log.info('Wallet:     %s', signer.address);
  log.info('Stake:      %s shMON', ethers.formatEther(STAKE_AMOUNT));
  log.divider();

  // ── Step 1: Deploy MockShMON ──────────────────────────────────────────────
  log.step('Deploy MockShMON');

  let mockShMonAddress = state.get(NETWORK, 'MockShMON');

  if (mockShMonAddress) {
    log.info('Already deployed: MockShMON → %s', mockShMonAddress);
  } else {
    const bytecode = loadBytecode('MockShMON');
    const factory  = new ethers.ContractFactory(MOCK_SHMON_ABI, bytecode, signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    mockShMonAddress = await contract.getAddress();
    state.set(NETWORK, 'MockShMON', mockShMonAddress);
    log.success('Deployed MockShMON → %s', mockShMonAddress);
  }

  const mockShMon      = new ethers.Contract(mockShMonAddress, MOCK_SHMON_ABI, signer);
  const publisherStake = new ethers.Contract(deployed.PublisherStake, PUBLISHER_STAKE_ABI, signer);

  // ── Step 2: Mint shMON to wallet ──────────────────────────────────────────
  log.step('Mint %s mock shMON to wallet', ethers.formatEther(MINT_AMOUNT));

  const balanceBefore = await mockShMon.balanceOf(signer.address);
  log.info('Current balance: %s shMON', ethers.formatEther(balanceBefore));

  if (balanceBefore < STAKE_AMOUNT) {
    const tx = await mockShMon.mint(signer.address, MINT_AMOUNT);
    await tx.wait();
    const balanceAfter = await mockShMon.balanceOf(signer.address);
    log.success('Minted — new balance: %s shMON', ethers.formatEther(balanceAfter));
  } else {
    log.info('Sufficient balance already — skipping mint');
  }

  // ── Step 3: Check if already registered ──────────────────────────────────
  log.step('Check publisher registration');

  const alreadyRegistered = await publisherStake.isAuthorised(signer.address);
  if (alreadyRegistered) {
    log.info('Already registered as publisher — skipping');
  } else {
    // ── Step 4: Approve PublisherStake to spend shMON ──────────────────────
    log.step('Approve PublisherStake to spend shMON');
    const approveTx = await mockShMon.approve(deployed.PublisherStake, STAKE_AMOUNT);
    await approveTx.wait();
    log.success('Approved %s shMON', ethers.formatEther(STAKE_AMOUNT));

    // ── Step 5: Register as publisher ──────────────────────────────────────
    log.step('Register as publisher (staking %s shMON)', ethers.formatEther(STAKE_AMOUNT));
    const registerTx = await publisherStake.register(STAKE_AMOUNT);
    await registerTx.wait();
    log.success('Registered as publisher');
  }

  // ── Step 6: Verify ────────────────────────────────────────────────────────
  log.step('Verify registration');

  const isAuth = await publisherStake.isAuthorised(signer.address);
  const info   = await publisherStake.getPublisher(signer.address);

  log.info('Authorised:   %s', isAuth);
  log.info('shMON staked: %s', ethers.formatEther(info.shMonStaked));
  log.info('Status:       %s', ['Unregistered','Active','Unbonding','Slashed','Banned'][info.status]);

  log.divider();

  if (isAuth) {
    log.success('Publisher registration complete');
    log.info('');
    log.info('MockShMON address: %s', mockShMonAddress);
    log.info('');
    log.info('Add this to scripts/publisher/.env:');
    log.info('  REGISTRY_ADDRESS=%s', deployed.ScoreRegistry);
    log.info('  CHAIN_ID=10143');
    log.info('');
    log.info('Then run: node index.js');
  } else {
    log.error('Registration failed — check errors above');
  }

  log.divider();
}

main().catch(err => {
  log.error(err.message);
  console.error(err);
  process.exit(1);
});
