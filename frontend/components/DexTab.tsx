'use client'

import { useMemo, useState } from 'react'
import {
  useDEXPools, useOpenInterest, useMarkPrices, usePositionCount,
  useUsdcBalance, useUsdcAllowance, useApproveUsdc, useOpenPosition, useMintUsdc
} from '@/lib/useDEX'
import { usePoolIds, usePoolScores } from '@/lib/useRegistry'
import { formatApy, formatTvl, formatUsdc } from '@/lib/contracts'

type PoolScore = {
  poolId: string
  protocolName?: string
  symbol?: string
  baseApy?: number
  rewardApy?: number
  tvlUsd?: bigint | number | string
  riskScore?: number
  confidence?: number
  liquidityDepth?: number
  volatility?: number
  auditScore?: number
  timestamp?: bigint | number
  updateCount?: bigint | number
  publisher?: string
}

const CHART_POINTS = '0,154 34,143 68,150 102,112 136,126 170,88 204,102 238,74 272,83 306,51 340,66 374,38 408,59 442,48 476,76 510,55 544,87 578,63 612,70 646,42 680,51 714,28 748,44 782,21 816,34'

export function DexTab({ address }: { address?: string }) {
  const [selectedPool, setSelectedPool] = useState('')
  const [side, setSide] = useState(0)
  const [collateral, setCollateral] = useState('250')
  const [leverage, setLeverage] = useState(2)
  const [chartRange, setChartRange] = useState('1H')

  const { data: dexPools } = useDEXPools()
  const { data: poolIds } = usePoolIds()
  const { data: scoresRaw } = usePoolScores(poolIds as string[] | undefined)
  const { data: positionCount } = usePositionCount()
  const { data: usdcBalance } = useUsdcBalance(address)
  const { data: allowance } = useUsdcAllowance(address)
  const pools = useMemo(() => (dexPools as string[] | undefined) ?? [], [dexPools])
  const { data: oiData } = useOpenInterest(pools)
  const { data: priceData } = useMarkPrices(pools)
  const { approve, isPending: approving } = useApproveUsdc()
  const { open, isPending: opening, isConfirming } = useOpenPosition()
  const { mint, isPending: minting } = useMintUsdc()

  const scores = useMemo(
    () => scoresRaw?.map(row => row.result as PoolScore | undefined).filter(Boolean) as PoolScore[] ?? [],
    [scoresRaw]
  )
  const getScore = (poolId: string) => scores.find(score => score?.poolId === poolId)

  const activePool = selectedPool || pools[0] || ''
  const selectedIndex = Math.max(0, pools.indexOf(activePool))
  const selectedScore = getScore(activePool) ?? scores[0]
  const markPriceRaw = priceData?.[selectedIndex]?.result as number | undefined
  const openInterest = oiData?.[selectedIndex]?.result as bigint | undefined
  const markPrice = markPriceRaw ? markPriceRaw / 100 : 1
  const riskScore = Number(selectedScore?.riskScore ?? 80)
  const confidence = Number(selectedScore?.confidence ?? 90)
  const auditScore = Number(selectedScore?.auditScore ?? 90)
  const maxLeverage = Math.max(2, Math.floor(20 * riskScore / 100))
  const safeLeverage = Math.min(leverage, maxLeverage)
  const usdcBal = usdcBalance ? Number(usdcBalance as bigint) / 1e6 : 0
  const colNum = parseFloat(collateral || '0')
  const positionSize = colNum * safeLeverage
  const needsApproval = !allowance || (allowance as bigint) < BigInt(Math.floor(colNum * 1e6))
  const marketName = selectedScore?.protocolName || 'Aave V3'
  const symbol = selectedScore?.symbol || 'USDC'
  const riskTone = riskScore >= 75 ? 'positive' : riskScore >= 50 ? 'warning' : 'negative'
  const posture = riskScore >= 75 ? 'Healthy' : riskScore >= 50 ? 'Watch' : 'Restricted'
  const postureCopy = riskScore >= 75
    ? 'Score supports normal sizing with automated leverage caps.'
    : riskScore >= 50
      ? 'Tradeable, but confidence and liquidity deserve closer attention.'
      : 'High risk bucket. Size down until the oracle improves.'
  const tvl = selectedScore?.tvlUsd !== undefined ? formatTvl(BigInt(selectedScore.tvlUsd)) : '$0'
  const apy = formatApy(Number(selectedScore?.baseApy ?? 0) + Number(selectedScore?.rewardApy ?? 0))
  const liquidityDepth = Number(selectedScore?.liquidityDepth ?? 0)
  const volatility = Number(selectedScore?.volatility ?? 0)
  const updateCount = selectedScore?.updateCount !== undefined ? selectedScore.updateCount.toString() : '0'
  const publisher = truncateAddress(selectedScore?.publisher)
  const scoreAge = formatScoreAge(selectedScore?.timestamp)
  const submitDisabled = !address || !activePool || !collateral || opening || approving || isConfirming

  const sampleActivity = useMemo(() => [
    { side: 'Long', size: '$1,250', price: markPrice.toFixed(2), time: 'sample' },
    { side: 'Short', size: '$620', price: (markPrice * 1.002).toFixed(2), time: 'sample' },
    { side: 'Long', size: '$2,100', price: (markPrice * .998).toFixed(2), time: 'sample' },
    { side: 'Long', size: '$480', price: (markPrice * 1.001).toFixed(2), time: 'sample' },
  ], [markPrice])

  const handleBalanceShortcut = (shortcut: string) => {
    const multiplier = shortcut === 'MAX' ? 1 : Number(shortcut.replace('%', '')) / 100
    const nextCollateral = Math.max(0, usdcBal * multiplier)
    setCollateral(nextCollateral ? nextCollateral.toFixed(2) : '0')
  }

  const handleTrade = () => {
    if (!activePool || !collateral || !address) return
    if (needsApproval) approve((colNum * 10).toString())
    else open(activePool, side, collateral, safeLeverage)
  }

  return (
    <div className="terminal">
      <section className="market-strip">
        <div className="market-selector">
          <div className="asset-mark">{symbol.slice(0, 1)}</div>
          <div><span className="market-kicker">ORACLE PERP</span><strong>{marketName} / {symbol}</strong></div>
          <select value={activePool} onChange={event => setSelectedPool(event.target.value)} aria-label="Select market">
            {pools.length === 0 && <option value="">No DEX pools</option>}
            {pools.map(pool => <option key={pool} value={pool}>{getScore(pool)?.protocolName || pool.slice(0, 12)}</option>)}
          </select>
        </div>
        <div className="ticker-price"><strong>${markPrice.toFixed(2)}</strong><span className={riskTone}>{posture}</span></div>
        <Metric label="Oracle score" value={`${riskScore}/100`} tone={riskTone} />
        <Metric label="Confidence" value={`${confidence}%`} />
        <Metric label="Open interest" value={openInterest !== undefined ? formatUsdc(openInterest) : '$0.00'} />
        <Metric label="Score age" value={scoreAge} />
        <Metric label="Max leverage" value={`${maxLeverage}x`} tone={riskTone} />
      </section>

      {pools.length === 0 && (
        <div className="pool-empty-banner">
          <strong>No perps pool is registered yet.</strong>
          <span>Deploy or seed the DEX pool, then this cockpit will switch from placeholder prices to contract-backed markets.</span>
        </div>
      )}

      {address && usdcBal < 100 && (
        <div className="funding-banner">
          <div><span className="live-pulse" /> Test collateral is low. Mint USDC to begin trading.</div>
          <button onClick={() => mint(address, '10000')} disabled={minting}>{minting ? 'Minting...' : 'Mint 10,000 USDC'}</button>
        </div>
      )}

      <div className="terminal-grid">
        <section className="chart-panel">
          <div className="panel-toolbar">
            <div className="toolbar-tabs"><button className="active">Chart</button><button>Depth</button><button>Oracle proof</button></div>
            <div className="range-tabs">
              {['5M', '15M', '1H', '4H', '1D'].map(range => (
                <button key={range} className={chartRange === range ? 'active' : ''} onClick={() => setChartRange(range)}>{range}</button>
              ))}
            </div>
          </div>
          <div className="chart-summary">
            <div><span>{marketName} / {symbol}</span><strong>${markPrice.toFixed(2)}</strong></div>
            <div className="ohlc">
              <span>O <b>{(markPrice * .991).toFixed(2)}</b></span>
              <span>H <b className="positive">{(markPrice * 1.018).toFixed(2)}</b></span>
              <span>L <b className="negative">{(markPrice * .984).toFixed(2)}</b></span>
              <span>C <b>{markPrice.toFixed(2)}</b></span>
            </div>
          </div>
          <div className="chart-canvas">
            <svg viewBox="0 0 816 190" preserveAspectRatio="none" role="img" aria-label="Market price chart">
              <defs>
                <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#6ee7d8" stopOpacity=".22" />
                  <stop offset="100%" stopColor="#6ee7d8" stopOpacity="0" />
                </linearGradient>
                <filter id="glow"><feGaussianBlur stdDeviation="2.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              </defs>
              <g className="chart-grid-lines">
                {[24, 64, 104, 144, 184].map(y => <line key={y} x1="0" x2="816" y1={y} y2={y} />)}
                {[0, 136, 272, 408, 544, 680, 816].map(x => <line key={x} x1={x} x2={x} y1="0" y2="190" />)}
              </g>
              <polygon points={`${CHART_POINTS} 816,190 0,190`} fill="url(#area)" />
              <polyline points={CHART_POINTS} fill="none" stroke="#6ee7d8" strokeWidth="2.2" filter="url(#glow)" />
              <line x1="0" x2="816" y1="34" y2="34" className="price-line" />
              <circle cx="816" cy="34" r="4" fill="#6ee7d8" />
            </svg>
            <div className="chart-axis"><span>09:00</span><span>10:00</span><span>11:00</span><span>12:00</span><span>13:00</span><span>14:00</span></div>
            <div className="chart-price-tag">${markPrice.toFixed(2)}</div>
          </div>
          <div className="oracle-ribbon">
            <div><span>Oracle posture</span><strong className={riskTone}>{posture}</strong></div>
            <RiskGauge label="Risk score" value={riskScore} tone={riskTone} />
            <RiskGauge label="Confidence" value={confidence} tone="info" />
            <RiskGauge label="Audit score" value={auditScore} tone="violet" />
            <div className="breaker-state"><span /> Circuit breaker clear</div>
          </div>
        </section>

        <aside className="trade-ticket">
          <div className="ticket-head">
            <div><span>Available balance</span><strong>${usdcBal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
            <span className="settlement-chip">USDC</span>
          </div>
          <div className="ticket-oracle-card">
            <div className="oracle-card-head">
              <span>Trade posture</span>
              <strong className={riskTone}>{posture}</strong>
            </div>
            <p>{postureCopy}</p>
            <div className="factor-grid">
              <div><span>TVL</span><strong>{tvl}</strong></div>
              <div><span>Total APY</span><strong>{apy}</strong></div>
              <div><span>Depth</span><strong>{liquidityDepth}/100</strong></div>
              <div><span>Volatility</span><strong>{volatility}/100</strong></div>
            </div>
            <div className="proof-row">
              <span>Publisher {publisher}</span>
              <span>{updateCount} updates</span>
            </div>
          </div>
          <div className="side-toggle">
            <button className={side === 0 ? 'long active' : ''} onClick={() => setSide(0)}>Long</button>
            <button className={side === 1 ? 'short active' : ''} onClick={() => setSide(1)}>Short</button>
          </div>
          <div className="order-type-row"><button className="active">Market</button><button>Limit</button><button>Trigger</button></div>
          <label className="ticket-field">
            <span>Collateral</span>
            <div><input type="number" value={collateral} onChange={event => setCollateral(event.target.value)} /><b>USDC</b></div>
          </label>
          <div className="balance-shortcuts">
            {['25%', '50%', '75%', 'MAX'].map(value => (
              <button key={value} onClick={() => handleBalanceShortcut(value)}>{value}</button>
            ))}
          </div>
          <label className="leverage-field">
            <span><b>Leverage</b><strong>{safeLeverage}x</strong></span>
            <input type="range" min={1} max={maxLeverage} value={safeLeverage} onChange={event => setLeverage(Number(event.target.value))} />
            <div><span>1x</span><span>{maxLeverage}x score cap</span></div>
          </label>
          <div className="order-preview">
            <PreviewRow label="Position size" value={`$${positionSize.toLocaleString()}`} />
            <PreviewRow label="Entry price" value={`$${markPrice.toFixed(2)}`} />
            <PreviewRow label="Initial margin" value={`${(5 + (100 - riskScore) * .02).toFixed(2)}%`} />
            <PreviewRow label="Est. liquidation" value={`$${(markPrice * (side === 0 ? .78 : 1.22)).toFixed(2)}`} />
            <PreviewRow label="Oracle limit" value={`${maxLeverage}x leverage`} />
          </div>
          <button
            className={`trade-submit ${side === 0 ? 'long' : 'short'}`}
            onClick={handleTrade}
            disabled={submitDisabled}
          >
            {!address ? 'Connect wallet to trade' : approving ? 'Approving USDC...' : isConfirming ? 'Confirming transaction...' : opening ? 'Opening position...' : needsApproval ? 'Approve USDC' : `${side === 0 ? 'Long' : 'Short'} ${marketName}`}
          </button>
          <p className="ticket-disclaimer">Orders execute against the research DEX contract on Monad Testnet. Leverage is capped by the latest oracle score.</p>
        </aside>

        <section className="positions-panel">
          <div className="panel-toolbar">
            <div className="toolbar-tabs"><button className="active">Positions <span>{positionCount?.toString() ?? '0'}</span></button><button>Orders</button><button>History</button></div>
            <button className="table-control">All markets</button>
          </div>
          <div className="positions-empty">
            <div className="empty-orbit"><span /></div><strong>No active positions</strong>
            <p>Your live positions will appear here with oracle score snapshots and margin health.</p>
          </div>
        </section>

        <section className="activity-panel">
          <div className="activity-head"><div><span className="sample-badge">Sample</span> Market tape</div><button>Contract feed next</button></div>
          <div className="activity-columns"><span>Side</span><span>Size</span><span>Price</span><span>Source</span></div>
          {sampleActivity.map((item, index) => (
            <div className="activity-row" key={`${item.time}-${index}`}>
              <span className={item.side === 'Long' ? 'positive' : 'negative'}>{item.side}</span>
              <strong>{item.size}</strong><span>${item.price}</span><small>{item.time}</small>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="market-metric"><span>{label}</span><strong className={tone}>{value}</strong></div>
}

function RiskGauge({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="risk-gauge"><div><span>{label}</span><strong>{value}</strong></div><div className="risk-track"><i className={tone} style={{ width: `${value}%` }} /></div></div>
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function truncateAddress(value?: string) {
  if (!value || value === '0x0000000000000000000000000000000000000000') return 'unassigned'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function formatScoreAge(timestamp?: bigint | number) {
  if (!timestamp) return 'pending'
  const seconds = Number(timestamp)
  const ageMs = Date.now() - seconds * 1000
  if (ageMs < 0) return 'fresh'
  const minutes = Math.floor(ageMs / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
