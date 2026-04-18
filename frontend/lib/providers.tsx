'use client'

import { RainbowKitProvider, getDefaultConfig, darkTheme } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { ReactNode } from 'react'
import { MONAD_TESTNET } from '@/lib/contracts'
import '@rainbow-me/rainbowkit/styles.css'

const config = getDefaultConfig({
  appName:   'Oracle Stack Dashboard',
  projectId: 'oracle-stack-monad',
  chains:    [MONAD_TESTNET as any],
  ssr:       true,
})

const queryClient = new QueryClient()

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor:          '#7F77DD',
            accentColorForeground: '#fff',
            borderRadius:         'medium',
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
