'use client'

import { useState } from 'react'
import {
  useDEXPools, useOpenInterest, useMarkPrices, usePositionCount,
  useUsdcBalance, useUsdcAllowance, useApproveUsdc, useOpenPosition, useMintUsdc
} from '@/lib/useDEX'
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

  const { approve, isPending: approving }                   = useApproveUsdc()
  const { open, isPending: opening, isConfirming }          = useOpenPosition()
  const { mint, isPending: minting }                        = useMintUsdc()

  const scores = scoresRaw?.map(r => r.result as any).filter(Boolean) ?? []
  const getScore = (poolId: string) => scores.find((s: any) => s?.poolId === poolId)

  const usdcBal      = usdcBalance ? Number(usdcBalance as bigint) / 1e6 : 0
  const colNum       = parseFloat(collateral || '0')
  const needsApproval = !allowance || (allowance as bigint) < BigInt(Math.floor(colNum * 1e6))

  const handleTrade = () => {
    if (!selectedPool || !collateral) return
    if (needsApproval) approve((colNum * 10).toString())
    else open(selectedPool, side, collateral, leverage)
  }

  return (
    <div>
      <div className="stats-row">
        <div className="stat-cell">
          <div className="stat-label">Total positions</div>
          <div className="stat-value violet">{positionCount?.toString() ?? '0'}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Supported pools</div>
          <div className="stat-value">{pools.length}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Your USDC balance</div>
          <div className="stat-value acid">${usdcBal.toFixed(2)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Settlement token</div>
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--data-muted)' }}>
            {CONTRACTS.MockUSDC.slice(0, 14)}...
          </div>
        </div>
      </div>

      {address && usdcBal < 100 && (
        <div className="mint-banner">
          <span className="mint-banner-text">No test USDC detected. Mint some to open positions.</span>
          <button className="btn btn-acid btn-sm" onClick={() => address && mint(address, '10000')} disabled={minting}>
            {minting ? 'Minting...' : 'Mint 10,000 USDC'}
          </button>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Active pools</span>
          {address && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
              + Open position
            </button>
          )}
        </div>
        {pools.length === 0 ? (
          <div className="empty-state">
            <strong>No pools registered</strong>
            Run deploy-perps.js to register pools from the registry
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th>Mark price</th>
                <th>Open interest</th>
                <th>Oracle score</th>
                <th>Max leverage</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((poolId, i) => {
                const score = getScore(poolId)
                const oi    = oiData?.[i]?.result as bigint | undefined
                const price = priceData?.[i]?.result as number | undefined
                const maxLev = score ? Math.max(2, Math.floor(20 * score.riskScore / 100)) : '—'
                return (
                  <tr key={poolId} className="row-enter" style={{ animationDelay: `${i * 50}ms` }}>
                    <td>
                      <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 600 }}>
                        {score?.protocolName ?? poolId.slice(0, 12) + '...'}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--data-muted)' }}>{score?.symbol ?? ''}</div>
                    </td>
                    <td>${price ? (price / 100).toFixed(2) : '1.00'}</td>
                    <td>{oi !== undefined ? formatUsdc(oi) : '—'}</td>
                    <td>
                      {score ? (
                        <span style={{ color: score.riskScore >= 70 ? 'var(--acid)' : 'var(--amber)' }}>
                          {score.riskScore}/100
                        </span>
                      ) : <span style={{ color: 'var(--data-muted)' }}>—</span>}
                    </td>
                    <td style={{ color: 'var(--violet)' }}>{maxLev}x</td>
                    <td>
                      {address && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => { setSelectedPool(poolId); setShowModal(true) }}
                        >
                          Trade
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="modal-bg" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Open position</div>

            <div className="form-row">
              <label className="form-label">Pool</label>
              <select className="form-select" value={selectedPool} onChange={e => setSelectedPool(e.target.value)}>
                <option value="">Select pool</option>
                {pools.map(p => {
                  const s = getScore(p)
                  return <option key={p} value={p}>{s?.protocolName ?? p.slice(0, 16)}</option>
                })}
              </select>
            </div>

            <div className="form-row">
              <label className="form-label">Direction</label>
              <div className="direction-toggle">
                <button className={`dir-btn long ${side === 0 ? 'active' : ''}`} onClick={() => setSide(0)}>
                  Long ↑
                </button>
                <button className={`dir-btn short ${side === 1 ? 'active' : ''}`} onClick={() => setSide(1)}>
                  Short ↓
                </button>
              </div>
            </div>

            <div className="form-row">
              <label className="form-label">Collateral (USDC) · balance: ${usdcBal.toFixed(2)}</label>
              <input
                className="form-input"
                type="number"
                placeholder="100"
                value={collateral}
                onChange={e => setCollateral(e.target.value)}
              />
            </div>

            <div className="form-row">
              <label className="form-label">Leverage: {leverage}x</label>
              <input
                type="range" min={1} max={16} step={1}
                value={leverage}
                onChange={e => setLeverage(Number(e.target.value))}
              />
              <div className="size-preview">
                Position size: <span>${colNum ? (colNum * leverage).toFixed(0) : '0'}</span>
                {' · '}
                Margin required: <span>${colNum ? ((colNum * leverage * 505) / 10000).toFixed(0) : '0'}</span>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
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
