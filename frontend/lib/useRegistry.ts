'use client'

import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { CONTRACTS, MONAD_TESTNET } from './contracts'

const RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://testnet-rpc.monad.xyz'

const REGISTRY_ABI = [
  'function poolCount() view returns (uint256)',
  'function getAllPoolIds() view returns (bytes32[])',
  'function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))',
]

function getProvider() {
  return new ethers.JsonRpcProvider(RPC)
}

function getRegistry() {
  return new ethers.Contract(CONTRACTS.ScoreRegistry, REGISTRY_ABI, getProvider())
}

export type PoolScore = {
  poolId:          string
  protocolName:    string
  symbol:          string
  category:        number
  baseApy:         number
  rewardApy:       number
  netApy:          number
  apyVolatility30d: number
  tvlUsd:          bigint
  liquidityDepth:  number
  utilisationRate: number
  riskScore:       number
  ilRisk:          number
  auditScore:      number
  protocolAgeDays: number
  confidence:      number
  publisher:       string
  timestamp:       number
  updateCount:     number
}

// ── Pool count ────────────────────────────────────────────────────────────────

export function usePoolCount() {
  const [data, setData]       = useState<bigint | undefined>()
  const [isLoading, setLoad]  = useState(true)

  useEffect(() => {
    let cancelled = false
    getRegistry().poolCount()
      .then((v: bigint) => { if (!cancelled) { setData(v); setLoad(false) } })
      .catch(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [])

  return { data, isLoading }
}

// ── Pool IDs ──────────────────────────────────────────────────────────────────

export function usePoolIds() {
  const [data, setData]       = useState<string[] | undefined>()
  const [isLoading, setLoad]  = useState(true)

  useEffect(() => {
    let cancelled = false
    getRegistry().getAllPoolIds()
      .then((ids: string[]) => { if (!cancelled) { setData(ids); setLoad(false) } })
      .catch((e: any) => { console.error('getAllPoolIds error:', e); if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [])

  return { data, isLoading }
}

// ── Pool scores ───────────────────────────────────────────────────────────────

export function usePoolScores(poolIds: string[] | undefined) {
  const [data, setData]       = useState<{ result: PoolScore }[] | undefined>()
  const [isLoading, setLoad]  = useState(false)

  useEffect(() => {
    if (!poolIds?.length) return
    let cancelled = false
    setLoad(true)
    const registry = getRegistry()

    Promise.all(poolIds.map(id => registry.getLatestScore(id)))
      .then((scores: any[]) => {
        if (cancelled) return
        const results = scores.map((s: any) => {
          // ethers returns tuple with both named and indexed fields
          // access by index to be safe regardless of ethers version
          const arr = Array.isArray(s) ? s : Object.values(s)
          return {
            result: {
              poolId:           String(s.poolId   ?? s[0] ?? ''),
              protocolName:     String(s.protocolName ?? s[1] ?? ''),
              symbol:           String(s.symbol   ?? s[2] ?? ''),
              category:         Number(s.category ?? s[3] ?? 0),
              baseApy:          Number(s.baseApy  ?? s[4] ?? 0),
              rewardApy:        Number(s.rewardApy ?? s[5] ?? 0),
              netApy:           Number(s.netApy   ?? s[6] ?? 0),
              apyVolatility30d: Number(s.apyVolatility30d ?? s[7] ?? 0),
              tvlUsd:           typeof (s.tvlUsd ?? s[8]) === 'bigint' ? (s.tvlUsd ?? s[8]) : BigInt(String(s.tvlUsd ?? s[8] ?? 0)),
              liquidityDepth:   Number(s.liquidityDepth ?? s[9] ?? 0),
              utilisationRate:  Number(s.utilisationRate ?? s[10] ?? 0),
              riskScore:        Number(s.riskScore ?? s[11] ?? 0),
              ilRisk:           Number(s.ilRisk   ?? s[12] ?? 0),
              auditScore:       Number(s.auditScore ?? s[13] ?? 0),
              protocolAgeDays:  Number(s.protocolAgeDays ?? s[14] ?? 0),
              confidence:       Number(s.confidence ?? s[15] ?? 0),
              publisher:        String(s.publisher ?? s[16] ?? ''),
              timestamp:        Number(s.timestamp ?? s[17] ?? 0),
              updateCount:      Number(s.updateCount ?? s[18] ?? 0),
            } as PoolScore
          }
        })
        setData(results)
        setLoad(false)
      })
      .catch((e: any) => {
        console.error('getLatestScore error:', e)
        if (!cancelled) setLoad(false)
      })

    return () => { cancelled = true }
  }, [poolIds?.join(',')])

  return { data, isLoading }
}
