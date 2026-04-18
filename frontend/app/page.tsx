'use client'

import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { RegistryTab } from '@/components/RegistryTab'
import { DexTab } from '@/components/DexTab'
import { ResearchTab } from '@/components/ResearchTab'
import { CONTRACTS } from '@/lib/contracts'

export default function Home() {
  const [tab, setTab] = useState<'registry' | 'dex' | 'research'>('registry')
  const { address } = useAccount()

  return (
    <div>
      <nav>
        <div className="container nav-inner">
          <div className="nav-brand">
            <div className="nav-dot" />
            <span className="nav-title">Oracle Stack</span>
            <span className="nav-chain">Monad Testnet</span>
          </div>
          <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
        </div>
      </nav>
      <div className="container">
        <div className="tabs">
          {(['registry', 'dex', 'research'] as const).map(t => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'registry' ? 'Yield registry' : t === 'dex' ? 'Perps DEX' : 'Research data'}
            </button>
          ))}
        </div>
        {tab === 'registry' && <RegistryTab />}
        {tab === 'dex'      && <DexTab address={address} />}
        {tab === 'research' && <ResearchTab />}
        <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--border)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {Object.entries(CONTRACTS).map(([name, addr]) => (
            <div key={name}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{name}</div>
              <a href={`https://testnet.monadscan.com/address/${addr}`} target="_blank" rel="noreferrer"
                style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--purple)', textDecoration: 'none' }}>
                {addr.slice(0, 10)}...{addr.slice(-6)}
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
