'use client'

import { useMemo, useState } from 'react'
import {
  useDEXPools, useOpenInterest, useMarkPrices, usePositionCount,
  useUsdcBalance, useUsdcAllowance, useApproveUsdc, useOpenPosition, useMintUsdc
} from '@/lib/useDEX'
import { usePoolIds, usePoolScores } from '@/lib/useRegistry'
import { formatUsdc } from '@/lib/contracts'

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

  const scores = scoresRaw?.map(r => r.result as any).filter(Boolean) ?? []
  const getScore = (poolId: string) => scores.find((score: any) => score?.poolId === poolId)

  const activePool = selectedPool || pools[0] || ''
  const selectedIndex = Math.max(0, pools.indexOf(activePool))
  const selectedScore = getScore(activePool) ?? scores[0]
  const markPriceRaw = priceData?.[selectedIndex]?.result as number | undefined
  const openInterest = oiData?.[selectedIndex]?.result as bigint | undefined
  const markPrice = markPriceRaw ? markPriceRaw / 100 : 1
  const riskScore = Number(selectedScore?.riskScore ?? 80)
  const confidence = Number(selectedScore?.confidence ?? 90)
  const maxLeverage = Math.max(2, Math.floor(20 * riskScore / 100))
  const usdcBal = usdcBalance ? Number(usdcBalance as bigint) / 1e6 : 0
  const colNum = parseFloat(collateral || '0')
  const positionSize = colNum * leverage
  const needsApproval = !allowance || (allowance as bigint) < BigInt(Math.floor(colNum * 1e6))
  const marketName = selectedScore?.protocolName || 'Aave V3'
  const symbol = selectedScore?.symbol || 'USDC'
  const riskTone = riskScore >= 75 ? 'positive' : riskScore >= 50 ? 'warning' : 'negative'

  const recentActivity = useMemo(() => [
    { side: 'Long', size: '$1,250', price: markPrice.toFixed(2), time: '12s' },
    { side: 'Short', size: '$620', price: (markPrice * 1.002).toFixed(2), time: '38s' },
    { side: 'Long', size: '$2,100', price: (markPrice * .998).toFixed(2), time: '1m' },
    { side: 'Long', size: '$480', price: (markPrice * 1.001).toFixed(2), time: '3m' },
  ], [markPrice])

  const handleTrade = () => {
    if (!activePool || !collateral || !address) return
    if (needsApproval) approve((colNum * 10).toString())
    else open(activePool, side, collateral, leverage)
  }

  return (
    <div className="terminal">
      <section className="market-strip">
        <div className="market-selector">
          <div className="asset-mark">{symbol.slice(0, 1)}</div>
          <div><span className="market-kicker">PERPETUAL</span><strong>{marketName} / {symbol}</strong></div>
          <select value={activePool} onChange={event => setSelectedPool(event.target.value)} aria-label="Select market">
            {pools.length === 0 && <option value="">Demo market</option>}
            {pools.map(pool => <option key={pool} value={pool}>{getScore(pool)?.protocolName || pool.slice(0, 12)}</option>)}
          </select>
        </div>
        <div className="ticker-price"><strong>${markPrice.toFixed(2)}</strong><span className="positive">+2.84%</span></div>
        <Metric label="Oracle score" value={`${riskScore}/100`} tone={riskTone} />
        <Metric label="Confidence" value={`${confidence}%`} />
        <Metric label="Open interest" value={openInterest !== undefined ? formatUsdc(openInterest) : '$0.00'} />
        <Metric label="Funding / 8h" value="0.010%" tone="positive" />
        <Metric label="Next funding" value="02:41:18" />
      </section>

      {address && usdcBal < 100 && (
        <div className="funding-banner">
          <div><span className="live-pulse" /> Test collateral is low. Mint USDC to begin trading.</div>
          <button onClick={() => mint(address, '10000')} disabled={minting}>{minting ? 'Minting...' : 'Mint 10,000 USDC'}</button>
        </div>
      )}

      <div className="terminal-grid">
        <section className="chart-panel">
          <div className="panel-toolbar">
            <div className="toolbar-tabs"><button className="active">Chart</button><button>Depth</button><button>Oracle data</button></div>
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
            <div><span>Oracle posture</span><strong className={riskTone}>{riskScore >= 75 ? 'Healthy' : riskScore >= 50 ? 'Watch' : 'Restricted'}</strong></div>
            <RiskGauge label="Risk score" value={riskScore} tone={riskTone} />
            <RiskGauge label="Confidence" value={confidence} tone="info" />
            <RiskGauge label="Audit score" value={Number(selectedScore?.auditScore ?? 90)} tone="violet" />
            <div className="breaker-state"><span /> Circuit breaker clear</div>
          </div>
        </section>

        <aside className="trade-ticket">
          <div className="ticket-head">
            <div><span>Available balance</span><strong>${usdcBal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
            <span className="settlement-chip">USDC</span>
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
          <div className="balance-shortcuts">{['25%', '50%', '75%', 'MAX'].map(value => <button key={value}>{value}</button>)}</div>
          <label className="leverage-field">
            <span><b>Leverage</b><strong>{leverage}x</strong></span>
            <input type="range" min={1} max={maxLeverage} value={Math.min(leverage, maxLeverage)} onChange={event => setLeverage(Number(event.target.value))} />
            <div><span>1x</span><span>{maxLeverage}x max</span></div>
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
            disabled={!address || !activePool || !collateral || opening || approving || isConfirming}
          >
            {!address ? 'Connect wallet to trade' : approving ? 'Approving USDC...' : isConfirming ? 'Confirming transaction...' : opening ? 'Opening position...' : needsApproval ? 'Approve USDC' : `${side === 0 ? 'Long' : 'Short'} ${marketName}`}
          </button>
          <p className="ticket-disclaimer">Orders execute against the research DEX contract on Monad Testnet.</p>
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
          <div className="activity-head"><div><span className="live-pulse" /> Live activity</div><button>View all</button></div>
          <div className="activity-columns"><span>Side</span><span>Size</span><span>Price</span><span>Time</span></div>
          {recentActivity.map((item, index) => (
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
