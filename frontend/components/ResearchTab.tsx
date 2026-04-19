'use client'

import { useLiquidationRates, usePositionCount } from '@/lib/useDEX'
import { usePoolCount } from '@/lib/useRegistry'

const SCORE_RANGES = ['0–9','10–19','20–29','30–39','40–49','50–59','60–69','70–79','80–89','90–99']

export function ResearchTab() {
  const { data: ratesRaw }      = useLiquidationRates()
  const { data: positionCount } = usePositionCount()
  const { data: poolCount }     = usePoolCount()

  const rates = ratesRaw?.map(r => r.result as [bigint, bigint, bigint] | undefined) ?? []
  const totalLiq = rates.reduce((s, r) => s + (r ? Number(r[0]) : 0), 0)
  const totalPos = rates.reduce((s, r) => s + (r ? Number(r[1]) : 0), 0)
  const maxRate  = rates.reduce((m, r) => { const v = r ? Number(r[2]) : 0; return v > m ? v : m }, 1)

  const hasData = totalPos > 0

  return (
    <div>
      <div className="stats-row">
        <div className="stat-cell">
          <div className="stat-label">Positions opened</div>
          <div className="stat-value violet">{positionCount?.toString() ?? '0'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Liquidations</div>
          <div className="stat-value red">{totalLiq}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Overall liq rate</div>
          <div className="stat-value">
            {totalPos > 0 ? ((totalLiq / totalPos) * 100).toFixed(1) + '%' : '—'}
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Pools in oracle</div>
          <div className="stat-value acid">{poolCount?.toString() ?? '0'}</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">
          <span className="panel-title">Liquidation rate by score bucket</span>
          <span className="panel-sub">
            High liq rate in high-score buckets = oracle overrating safety
          </span>
        </div>
        {!hasData ? (
          <div className="empty-state">
            <strong>No position data yet</strong>
            Open positions on the DEX tab to start generating calibration data
          </div>
        ) : (
          <>
            <div className="bar-chart">
              {rates.map((r, i) => {
                const liqRate  = r ? Number(r[2]) : 0
                const liqCount = r ? Number(r[0]) : 0
                const barH     = maxRate > 0 ? Math.max(3, (liqRate / maxRate) * 100) : 3
                const color    = i >= 8 ? 'var(--acid)' : i >= 6 ? 'var(--violet)' : i >= 4 ? 'var(--amber)' : 'var(--red)'
                return (
                  <div key={i} className="bar-col">
                    <div className="bar-pct">{liqCount > 0 ? (liqRate / 100).toFixed(0) + '%' : ''}</div>
                    <div className="bar-body" style={{ height: `${barH}%`, background: color }} />
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 6, padding: '8px 20px 16px' }}>
              {SCORE_RANGES.map(r => (
                <div key={r} className="bar-lbl" style={{ textAlign: 'center' }}>{r}</div>
              ))}
            </div>
            <div style={{ padding: '0 20px 16px', fontSize: 10, color: 'var(--data-muted)', textAlign: 'center' }}>
              Oracle risk score range (right = safer rating)
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Score bucket breakdown</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Score range</th>
              <th>Oracle rating</th>
              <th>Positions</th>
              <th>Liquidations</th>
              <th>Liq rate</th>
              <th>Calibration signal</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r, i) => {
              const liq     = r ? Number(r[0]) : 0
              const pos     = r ? Number(r[1]) : 0
              const rate    = r ? Number(r[2]) : 0
              const rating  = i >= 8 ? 'Very safe' : i >= 6 ? 'Safe' : i >= 4 ? 'Moderate' : i >= 2 ? 'Risky' : 'Very risky'
              const signal  = pos === 0 ? '—'
                : rate > 3000 && i >= 6 ? 'Overrating safety'
                : rate < 500 && i < 4   ? 'Overrating risk'
                : pos > 0               ? 'Calibrated'
                : '—'
              const sigColor = signal === 'Overrating safety' ? 'var(--red)'
                : signal === 'Overrating risk' ? 'var(--amber)'
                : signal === 'Calibrated'      ? 'var(--acid)'
                : 'var(--data-muted)'
              const ratingColor = i >= 8 ? 'var(--acid)' : i >= 6 ? 'var(--violet)' : i >= 4 ? 'var(--amber)' : 'var(--red)'

              return (
                <tr key={i} className="row-enter" style={{ animationDelay: `${i * 30}ms` }}>
                  <td style={{ color: 'var(--data-muted)' }}>{SCORE_RANGES[i]}</td>
                  <td style={{ color: ratingColor }}>{rating}</td>
                  <td>{pos}</td>
                  <td>{liq}</td>
                  <td style={{ color: rate > 2000 ? 'var(--red)' : 'var(--data)' }}>
                    {pos > 0 ? (rate / 100).toFixed(1) + '%' : '—'}
                  </td>
                  <td style={{ color: sigColor, fontSize: 11 }}>{signal}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
