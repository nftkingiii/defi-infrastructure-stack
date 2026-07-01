import type { Metadata } from 'next'
import { Providers } from '@/lib/providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'Verity - Oracle Risk Infrastructure',
  description: 'Oracle risk infrastructure for publisher-scored DeFi markets, leverage limits, and liquidation calibration on Monad Testnet.',
  icons: {
    icon: '/icon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
