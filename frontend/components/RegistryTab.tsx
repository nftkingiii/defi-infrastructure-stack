'use client'

import { usePoolIds, usePoolScores, usePoolCount } from '@/lib/useRegistry'
import { CATEGORY_LABELS, RISK_LABEL, formatApy, formatTvl } from '@/lib/contracts'

export function RegistryTab() {
  const { data: poolIds, isLoading: loadingIds } = usePoolIds()
  const { data: scoresRaw, isLoading: loadingScores } = usePoolScores(poolIds as string[] | undefined)
  const { data: poolCount } = usePoolCount()

  const scores = scoresRaw
    ?.map(r => r.result as any)
    .filter(Boolean)
    .sort((a: any, b: any) => b.riskScore - a.riskScore) ?? []

  const isLoading = loadingIds || loadingScores

  return (
    <div>
      <div className="grid-stats">
        <div className="stat-card">
          <div className="stat-label">Pools tracked</div>
          <div className="stat-value purple">{poolCount?.toString() ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg risk score</div>
          <div className="stat-value green">
            {scores.length ? Math.round(scores.reduce((s: number, p: any) => s + p.riskScore, 0) / scores.length) : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Best APY</div>
          <div className="stat-value">
            {scores.length ? formatApy(Math.max(...scores.map((p: any) => p.baseApy + p.rewardApy))) : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total TVL</div>
          <div className="stat-value">
            {scores.length ? formatTvl(scores.reduce((s: bigint, p: any) => s + BigInt(p.tvlUsd), 0n)) : '—'}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Pool scores</span>
          <span className="section-sub">Sorted by risk score · Updated every 30 min by publisher</span>
        </div>
        <div className="card">
          {isLoading ? (
            <div className="loading">Loading scores from ScoreRegistry...</div>
          ) : scores.length === 0 ? (
            <div className="empty">No pools in registry yet. Start the publisher to populate scores.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Protocol</th>
                  <th>Category</th>
                  <th>Base APY</th>
                  <th>Reward APY</th>
                  <th>TVL</th>
                  <th>Risk score</th>
                  <th>Confidence</th>
                  <th>Updates</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((p: any, i: number) => {
                  const risk = RISK_LABEL(p.riskScore)
                  return (
                    <tr key={i}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{p.protocolName || 'Unknown'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          {p.symbol}
                        </div>
                      </td>
                      <td><span className="tag">{CATEGORY_LABELS[p.category] ?? 'Unknown'}</span></td>
                      <td style={{ color: 'var(--green)' }}>{formatApy(p.baseApy)}</td>
                      <td>{formatApy(p.rewardApy)}</td>
                      <td>{formatTvl(BigInt(p.tvlUsd))}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
                            <div style={{ height: '100%', width: `${p.riskScore}%`, background: risk.color, borderRadius: 2 }} />
                          </div>
                          <span style={{ fontSize: 12, color: risk.color, minWidth: 32 }}>{p.riskScore}</span>
                          <span className="badge" style={{ background: risk.color + '22', color: risk.color }}>{risk.label}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', minWidth: 40 }}>
                            <div style={{ height: '100%', width: `${p.confidence}%`, background: 'var(--purple)', borderRadius: 2 }} />
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.confidence}%</span>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.updateCount?.toString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
