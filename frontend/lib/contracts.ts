// lib/contracts.ts
// Contract addresses on Monad Testnet (chainId 10143)

export const CONTRACTS = {
  ScoreRegistry:        '0x1172ce3bA6C6DcdD35C6b14638bE3d6287b8B0B0',
  PublisherStake:       '0x9Db11F94f2E082D84AccEf885687d1D99D681743',
  DeviationAdjudicator: '0x0191b2b80A39D945e67412a1652FC0121fc1b43B',
  PerpRiskParams:       '0xEDdfEA29645FEd0ACbaB25668a94ef5A98e7A7B9',
  PerpsDEX:             '0xD8e4f84f543836832b9CaBfC440488CE74Fb8133',
  MockUSDC:             '0x75761710de793134faCd2933fb495217eb89fb7f',
  MockShMON:            '0x93B322334Fa8D7aC6799B5f9483EC7bDdaC2786D',
} as const

export const MONAD_TESTNET = {
  id:         10143,
  name:       'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL || 'https://testnet-rpc.monad.xyz'] } },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://testnet.monadscan.com' }
  },
} as const

// ── ABIs (minimal — only what the frontend needs) ────────────────────────────

export const SCORE_REGISTRY_ABI = [
  'function getAllPoolIds() view returns (bytes32[])',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
  'function poolCount() view returns (uint256)',
  'event ScorePublished(bytes32 indexed poolId, address indexed publisher, uint8 riskScore, uint32 netApy, uint128 tvlUsd, uint48 timestamp)',
] as const

export const PERPS_DEX_ABI = [
  'function openPosition(bytes32 poolId, uint8 side, uint128 collateralUsdc, uint8 leverage) external returns (uint256 positionId)',
  'function closePosition(uint256 positionId) external',
  'function liquidate(uint256 positionId) external',
  'function getPosition(uint256 positionId) view returns (tuple(bytes32 poolId, address trader, uint8 side, uint128 collateralUsdc, uint128 sizeUsdc, uint32 entryPrice, uint32 entryFundingIndex, uint8 leverage, uint16 initialMarginBps, uint16 maintenanceMarginBps, uint16 liquidationPenaltyBps, uint8 riskScoreAtOpen, uint48 openedAt, bool isOpen))',
  'function getOpenInterest(bytes32 poolId) view returns (uint128)',
  'function getMarkPrice(bytes32 poolId) view returns (uint32)',
  'function getSupportedPools() view returns (bytes32[])',
  'function getLiquidationRate(uint8 bucket) view returns (uint256 liquidations, uint256 positions, uint256 rateBps)',
  'function positionCount() view returns (uint256)',
  'function isLiquidatable(uint256 positionId) view returns (bool)',
  'event PositionOpened(uint256 indexed positionId, bytes32 indexed poolId, address indexed trader, uint8 side, uint128 collateralUsdc, uint128 sizeUsdc, uint8 leverage, uint8 riskScoreAtOpen, uint32 entryPrice, uint48 timestamp)',
  'event PositionLiquidated(uint256 indexed positionId, address indexed trader, address indexed liquidator, uint128 collateralSeized, uint128 liquidatorBounty, uint8 riskScoreAtLiquidation, uint48 timestamp)',
] as const

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount) external',
] as const

export const PUBLISHER_STAKE_ABI = [
  'function isAuthorised(address publisher) view returns (bool)',
  'function activePublisherCount() view returns (uint256)',
  'function getPublisher(address publisher) view returns (tuple(uint128 shMonStaked, uint128 monValueAtDeposit, uint48 stakedAt, uint48 unbondingEndsAt, uint32 slashCount, uint32 poolsPublished, uint8 status))',
] as const

// ── Helpers ──────────────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<number, string> = {
  0: 'DEX', 1: 'Lending', 2: 'Staking', 3: 'Vault', 4: 'RWA', 5: 'Perps', 6: 'Unknown'
}

export const RISK_LABEL = (score: number) => {
  if (score >= 80) return { label: 'V.Low',  color: '#10b981' }
  if (score >= 65) return { label: 'Low',    color: '#34d399' }
  if (score >= 45) return { label: 'Med',    color: '#f59e0b' }
  if (score >= 25) return { label: 'High',   color: '#f97316' }
  return               { label: 'V.High', color: '#ef4444' }
}

export function formatApy(bps: number) {
  return (bps / 100).toFixed(2) + '%'
}

export function formatTvl(raw: bigint) {
  const usd = Number(raw) / 1e6
  if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(1) + 'M'
  if (usd >= 1_000)     return '$' + (usd / 1_000).toFixed(1) + 'K'
  return '$' + usd.toFixed(0)
}

export function formatUsdc(raw: bigint) {
  return '$' + (Number(raw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
}
