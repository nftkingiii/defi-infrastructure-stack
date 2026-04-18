'use client'

import { useLiquidationRates, usePositionCount } from '@/lib/useDEX'
import { usePoolCount } from '@/lib/useRegistry'

export function ResearchTab() {
  const { data: ratesRaw }      = useLiquidationRates()
  const { data: positionCount } = usePositionCount()
  const { data: poolCount }     = usePoolCount()

  const rates = ratesRaw?.map(r => r.result as [bigint, bigint, bigint] | undefined) ?? []

  const maxRate = rates.reduce((m, r) => {
    const v = r ? Number(r[2]) : 0
    return v > m ? v : m
  }, 1)

  const totalLiquidations = rates.reduce((s, r) => s + (r ? Number(r[0]) : 0), 0)
  const totalPositions    = rates.reduce((s, r) => s + (r ? Number(r[1]) : 0), 0)

  const scoreRanges = ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-99']

  return (
    <div>
      <div className="grid-stats">
        <div className="stat-card">
          <div className="stat-label">Total positions opened</div>
          <div className="stat-value purple">{positionCount?.toString() ?? '0'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total liquidations</div>
          <div className="stat-value" style={{ color: 'var(--red)' }}>{totalLiquidations}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Overall liq rate</div>
          <div className="stat-value">
            {totalPositions > 0 ? ((totalLiquidations / totalPositions) * 100).toFixed(1) + '%' : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pools in oracle</div>
          <div className="stat-value green">{poolCount?.toString() ?? '0'}</div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Liquidation rate by oracle score bucket</span>
          <span className="section-sub">
            High liq rate in high-score buckets = oracle overrating safety
          </span>
        </div>

        <div className="card" style={{ padding: 24 }}>
          {totalPositions === 0 ? (
            <div className="empty">
              No position data yet. Open positions on the DEX tab to generate research data.
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 8, alignItems: 'end', height: 120, marginBottom: 8 }}>
                {rates.map((r, i) => {
                  const liqRate  = r ? Number(r[2]) : 0
                  const liqCount = r ? Number(r[0]) : 0
                  const posCount = r ? Number(r[1]) : 0
                  const height   = maxRate > 0 ? Math.max(4, (liqRate / maxRate) * 100) : 4
                  const color    = i >= 7 ? 'var(--green)' : i >= 4 ? 'var(--amber)' : 'var(--red)'
                  return (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {liqCount > 0 ? `${(liqRate / 100).toFixed(0)}%` : ''}
                      </div>
                      <div style={{ width: '100%', height: `${height}%`, background: color, borderRadius: '2px 2px 0 0', minHeight: 4 }} />
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 8 }}>
                {scoreRanges.map(r => (
                  <div key={r} style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>{r}</div>
                ))}
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                Risk score range (higher = safer rating by oracle)
              </div>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Score bucket breakdown</span>
        </div>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Score range</th>
                <th>Oracle rating</th>
                <th>Positions opened</th>
                <th>Liquidations</th>
                <th>Liq rate</th>
                <th>Calibration signal</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r, i) => {
                const liqCount = r ? Number(r[0]) : 0
                const posCount = r ? Number(r[1]) : 0
                const liqRate  = r ? Number(r[2]) : 0
                const rating   = i >= 8 ? 'Very safe' : i >= 6 ? 'Safe' : i >= 4 ? 'Moderate' : i >= 2 ? 'Risky' : 'Very risky'
                const signal   = posCount === 0 ? '—'
                  : liqRate > 3000 && i >= 6 ? 'Oracle overrating safety'
                  : liqRate < 500 && i < 4   ? 'Oracle overrating risk'
                  : 'Calibrated'
                const sigColor = signal === 'Oracle overrating safety' ? 'var(--red)'
                  : signal === 'Oracle overrating risk' ? 'var(--amber)'
                  : signal === 'Calibrated' ? 'var(--green)'
                  : 'var(--text-muted)'
                return (
                  <tr key={i}>
                    <td style={{ fontFamily: 'monospace' }}>{scoreRanges[i]}</td>
                    <td style={{ color: i >= 6 ? 'var(--green)' : i >= 4 ? 'var(--amber)' : 'var(--red)' }}>{rating}</td>
                    <td>{posCount}</td>
                    <td>{liqCount}</td>
                    <td>{posCount > 0 ? (liqRate / 100).toFixed(1) + '%' : '—'}</td>
                    <td style={{ color: sigColor, fontSize: 12 }}>{signal}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
