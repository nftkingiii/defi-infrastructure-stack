'use client'

import { useState } from 'react'
import { useDEXPools, useOpenInterest, useMarkPrices, usePositionCount, useUsdcBalance, useUsdcAllowance, useApproveUsdc, useOpenPosition, useMintUsdc } from '@/lib/useDEX'
import { usePoolIds, usePoolScores } from '@/lib/useRegistry'
import { formatUsdc, CONTRACTS } from '@/lib/contracts'

export function DexTab({ address }: { address?: string }) {
  const [showModal, setShowModal] = useState(false)
  const [selectedPool, setSelectedPool] = useState('')
  const [side, setSide] = useState(0)
  const [collateral, setCollateral] = useState('')
  const [leverage, setLeverage] = useState(2)

  const { data: dexPools }      = useDEXPools()
  const { data: poolIds }       = usePoolIds()
  const { data: scoresRaw }     = usePoolScores(poolIds as string[] | undefined)
  const { data: positionCount } = usePositionCount()
  const { data: usdcBalance }   = useUsdcBalance(address)
  const { data: allowance }     = useUsdcAllowance(address)

  const pools = dexPools as string[] | undefined ?? []
  const { data: oiData }    = useOpenInterest(pools)
  const { data: priceData } = useMarkPrices(pools)

  const { approve, isPending: approving } = useApproveUsdc()
  const { open, isPending: opening, isConfirming } = useOpenPosition()
  const { mint, isPending: minting } = useMintUsdc()

  const scores = scoresRaw?.map(r => r.result as any).filter(Boolean) ?? []
  const getScore = (poolId: string) => scores.find((s: any) => s?.poolId === poolId)

  const usdcBal = usdcBalance ? Number(usdcBalance as bigint) / 1e6 : 0
  const needsApproval = !allowance || (allowance as bigint) < BigInt(parseFloat(collateral || '0') * 1e6)

  const handleTrade = () => {
    if (!selectedPool || !collateral) return
    if (needsApproval) {
      approve((parseFloat(collateral) * 10).toString())
    } else {
      open(selectedPool, side, collateral, leverage)
    }
  }

  return (
    <div>
      <div className="grid-stats">
        <div className="stat-card">
          <div className="stat-label">Total positions</div>
          <div className="stat-value purple">{positionCount?.toString() ?? '0'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Supported pools</div>
          <div className="stat-value">{pools.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Your USDC balance</div>
          <div className="stat-value green">${usdcBal.toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">USDC contract</div>
          <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
            {CONTRACTS.MockUSDC.slice(0, 16)}...
          </div>
        </div>
      </div>

      {address && usdcBal < 100 && (
        <div style={{ background: 'rgba(127,119,221,0.1)', border: '1px solid var(--border-accent)', borderRadius: 10, padding: '12px 16px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--purple)' }}>You need test USDC to open positions.</span>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => address && mint(address, '10000')}
            disabled={minting}
          >
            {minting ? 'Minting...' : 'Mint 10,000 USDC'}
          </button>
        </div>
      )}

      <div className="section">
        <div className="section-header">
          <span className="section-title">Active pools</span>
          {address && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
              Open position
            </button>
          )}
        </div>
        <div className="card">
          {pools.length === 0 ? (
            <div className="empty">No pools registered in the DEX yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Mark price</th>
                  <th>Open interest</th>
                  <th>Risk score</th>
                  <th>Max leverage</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((poolId, i) => {
                  const score = getScore(poolId)
                  const oi    = oiData?.[i]?.result as bigint | undefined
                  const price = priceData?.[i]?.result as number | undefined
                  return (
                    <tr key={poolId} style={{ cursor: 'pointer' }} onClick={() => { setSelectedPool(poolId); setShowModal(true) }}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{score?.protocolName ?? poolId.slice(0, 10) + '...'}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{score?.symbol ?? ''}</div>
                      </td>
                      <td>${price ? (price / 100).toFixed(2) : '1.00'}</td>
                      <td>{oi !== undefined ? formatUsdc(oi) : '—'}</td>
                      <td>
                        {score ? (
                          <span style={{ color: score.riskScore >= 70 ? 'var(--green)' : 'var(--amber)' }}>
                            {score.riskScore}/100
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ color: 'var(--text-muted)' }}>
                        {score ? `${Math.floor(20 * score.riskScore / 100)}x` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Open position</div>

            <div className="form-group">
              <label className="form-label">Pool</label>
              <select className="form-select" value={selectedPool} onChange={e => setSelectedPool(e.target.value)}>
                <option value="">Select pool</option>
                {pools.map(p => {
                  const s = getScore(p)
                  return <option key={p} value={p}>{s?.protocolName ?? p.slice(0, 12)}</option>
                })}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Direction</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-sm"
                  style={{ flex: 1, background: side === 0 ? 'var(--green)' : 'var(--bg-raised)', color: side === 0 ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)' }}
                  onClick={() => setSide(0)}
                >
                  Long
                </button>
                <button
                  className="btn btn-sm"
                  style={{ flex: 1, background: side === 1 ? 'var(--red)' : 'var(--bg-raised)', color: side === 1 ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)' }}
                  onClick={() => setSide(1)}
                >
                  Short
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Collateral (USDC) — balance: ${usdcBal.toFixed(2)}</label>
              <input
                className="form-input"
                type="number"
                placeholder="100"
                value={collateral}
                onChange={e => setCollateral(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Leverage: {leverage}x</label>
              <input
                type="range" min={1} max={16} step={1}
                value={leverage}
                onChange={e => setLeverage(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                <span>1x</span>
                <span>Size: ${collateral ? (parseFloat(collateral) * leverage).toFixed(0) : '0'}</span>
                <span>16x</span>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleTrade}
                disabled={!selectedPool || !collateral || opening || approving || isConfirming}
              >
                {approving ? 'Approving...' : isConfirming ? 'Confirming...' : opening ? 'Opening...' : needsApproval ? 'Approve USDC' : 'Open position'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
