'use client'

import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { RegistryTab } from '@/components/RegistryTab'
import { DexTab } from '@/components/DexTab'
import { ResearchTab } from '@/components/ResearchTab'
import { usePoolCount } from '@/lib/useRegistry'
import { usePositionCount } from '@/lib/useDEX'

type Tab = 'registry' | 'dex' | 'research'

const navItems: { id: Tab; label: string; short: string }[] = [
  { id: 'dex', label: 'Perpetuals', short: 'PX' },
  { id: 'registry', label: 'Oracle registry', short: 'OR' },
  { id: 'research', label: 'Research', short: 'RS' },
]

export default function Home() {
  const [tab, setTab] = useState<Tab>('dex')
  const { address } = useAccount()
  const { data: poolCount } = usePoolCount()
  const { data: positionCount } = usePositionCount()

  return (
    <main className="app-shell">
      <aside className="side-rail">
        <button className="logo-button" onClick={() => setTab('dex')} aria-label="Oracle Stack home">
          <span className="logo-orbit" />
          <span className="logo-core">O</span>
        </button>
        <nav className="rail-nav" aria-label="Primary navigation">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`rail-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              title={item.label}
            >
              <span className="rail-icon">{item.short}</span>
              <span className="rail-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-footer"><span className="live-pulse" /><span>MONAD</span></div>
      </aside>

      <section className="app-main">
        <header className="app-header">
          <div className="header-context">
            <div className="product-name">Oracle Stack</div>
            <div className="network-pill"><span /> Testnet live</div>
          </div>
          <div className="header-metrics">
            <div><span>Pools</span><strong>{poolCount?.toString() ?? '0'}</strong></div>
            <div><span>Positions</span><strong>{positionCount?.toString() ?? '0'}</strong></div>
          </div>
          <div className="wallet-wrap">
            <ConnectButton showBalance={false} accountStatus="address" chainStatus="none" />
          </div>
        </header>

        <div className={`workspace ${tab === 'dex' ? 'workspace-dex' : ''}`}>
          {tab === 'dex' && <DexTab address={address} />}
          {tab === 'registry' && (
            <section className="content-view">
              <div className="view-heading">
                <div><span className="eyebrow">Oracle intelligence</span><h1>Pool Registry</h1></div>
                <p>Live publisher scores used to derive risk limits across the trading stack.</p>
              </div>
              <RegistryTab />
            </section>
          )}
          {tab === 'research' && (
            <section className="content-view">
              <div className="view-heading">
                <div><span className="eyebrow">Calibration lab</span><h1>Research</h1></div>
                <p>Compare oracle safety ratings with observed position and liquidation outcomes.</p>
              </div>
              <ResearchTab />
            </section>
          )}
        </div>
      </section>
    </main>
  )
}
