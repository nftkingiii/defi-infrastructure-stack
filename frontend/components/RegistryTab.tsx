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
  const avgRisk = scores.length ? Math.round(scores.reduce((s: number, p: any) => s + p.riskScore, 0) / scores.length) : null
  const bestApy = scores.length ? Math.max(...scores.map((p: any) => p.baseApy + p.rewardApy)) : 0
  const totalTvl = scores.length ? scores.reduce((s: bigint, p: any) => s + BigInt(p.tvlUsd ?? 0), 0n) : 0n

  return (
    <div>
      <div className="stats-row">
        <div className="stat-cell">
          <div className="stat-label">Pools tracked</div>
          <div className="stat-value violet">{poolCount?.toString() ?? '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Avg risk score</div>
          <div className="stat-value acid">{avgRisk ?? '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Best APY</div>
          <div className="stat-value">{bestApy ? formatApy(bestApy) : '—'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Total TVL tracked</div>
          <div className="stat-value">{totalTvl > 0n ? formatTvl(totalTvl) : '—'}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Pool scores</span>
          <span className="panel-sub">Sorted by risk score · Publisher updates every 30 min</span>
        </div>
        {isLoading ? (
          <div className="loading-state">Fetching registry data</div>
        ) : scores.length === 0 ? (
          <div className="empty-state">
            <strong>No pools published yet</strong>
            Start the publisher agent to populate the registry
          </div>
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
                const riskChip = p.riskScore >= 80 ? 'chip-acid'
                  : p.riskScore >= 60 ? 'chip-violet'
                  : p.riskScore >= 40 ? 'chip-amber'
                  : 'chip-red'
                return (
                  <tr key={i} className="row-enter" style={{ animationDelay: `${i * 40}ms` }}>
                    <td>
                      <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 600, fontSize: 13 }}>
                        {p.protocolName || 'Unknown'}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--data-muted)', marginTop: 2 }}>{p.symbol}</div>
                    </td>
                    <td>
                      <span className="chip chip-violet">{CATEGORY_LABELS[p.category] ?? 'Unknown'}</span>
                    </td>
                    <td style={{ color: 'var(--acid)' }}>{formatApy(p.baseApy)}</td>
                    <td style={{ color: 'var(--data-muted)' }}>{formatApy(p.rewardApy)}</td>
                    <td>{formatTvl(BigInt(p.tvlUsd ?? 0))}</td>
                    <td>
                      <div className="score-bar">
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${p.riskScore}%`, background: risk.color }} />
                        </div>
                        <span className="score-num" style={{ color: risk.color }}>{p.riskScore}</span>
                        <span className={`chip ${riskChip}`}>{risk.label}</span>
                      </div>
                    </td>
                    <td>
                      <div className="score-bar">
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${p.confidence}%`, background: 'var(--violet)' }} />
                        </div>
                        <span className="score-num" style={{ color: 'var(--data-muted)' }}>{p.confidence}%</span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--data-muted)' }}>{p.updateCount?.toString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
