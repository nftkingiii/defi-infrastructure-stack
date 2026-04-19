'use client'

import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { RegistryTab } from '@/components/RegistryTab'
import { DexTab } from '@/components/DexTab'
import { ResearchTab } from '@/components/ResearchTab'
import { CONTRACTS } from '@/lib/contracts'
import { usePoolCount } from '@/lib/useRegistry'
import { usePositionCount } from '@/lib/useDEX'

export default function Home() {
  const [tab, setTab] = useState<'registry' | 'dex' | 'research'>('registry')
  const { address } = useAccount()
  const { data: poolCount }     = usePoolCount()
  const { data: positionCount } = usePositionCount()

  const tabs = [
    { id: 'registry' as const, label: '01 / Registry' },
    { id: 'dex'      as const, label: '02 / Perps DEX' },
    { id: 'research' as const, label: '03 / Research' },
  ]

  return (
    <div className="layout">
      <div className="signal-strip">
        <div className="signal-dot" title="Oracle: live" />
        <span className="signal-label">Oracle</span>
        <div style={{ flex: 1 }} />
        <div className="signal-dot acid" style={{ background: 'var(--acid)', animationDelay: '0.7s' }} />
        <span className="signal-label">Chain</span>
      </div>

      <div className="main-content">
        <div className="topbar">
          <div className="brand">
            <div className="brand-mark">
              <div className="brand-mark-inner" />
            </div>
            <span className="brand-name">Oracle Stack</span>
            <span className="brand-sub">Monad Testnet</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ fontSize: 10, color: 'var(--data-muted)', fontFamily: 'JetBrains Mono' }}>
              <span style={{ color: 'var(--violet)' }}>{poolCount?.toString() ?? '0'}</span> pools ·{' '}
              <span style={{ color: 'var(--acid)' }}>{positionCount?.toString() ?? '0'}</span> positions
            </div>
            <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
          </div>
        </div>

        <div className="page">
          <div className="tabs">
            {tabs.map(t => (
              <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'registry' && <RegistryTab />}
          {tab === 'dex'      && <DexTab address={address} />}
          {tab === 'research' && <ResearchTab />}

          <div className="contracts-footer">
            {Object.entries(CONTRACTS).map(([name, addr]) => (
              <div key={name}>
                <div className="contract-item-label">{name}</div>
                <a
                  href={`https://testnet.monadscan.com/address/${addr}`}
                  target="_blank" rel="noreferrer"
                  className="contract-item-addr"
                >
                  {addr.slice(0, 10)}...{addr.slice(-6)}
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
