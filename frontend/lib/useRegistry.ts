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
        const results = scores.map(s => ({
          result: {
            poolId:          s.poolId,
            protocolName:    s.protocolName,
            symbol:          s.symbol,
            category:        Number(s.category),
            baseApy:         Number(s.baseApy),
            rewardApy:       Number(s.rewardApy),
            netApy:          Number(s.netApy),
            apyVolatility30d: Number(s.apyVolatility30d),
            tvlUsd:          BigInt(s.tvlUsd),
            liquidityDepth:  Number(s.liquidityDepth),
            utilisationRate: Number(s.utilisationRate),
            riskScore:       Number(s.riskScore),
            ilRisk:          Number(s.ilRisk),
            auditScore:      Number(s.auditScore),
            protocolAgeDays: Number(s.protocolAgeDays),
            confidence:      Number(s.confidence),
            publisher:       s.publisher,
            timestamp:       Number(s.timestamp),
            updateCount:     Number(s.updateCount),
          } as PoolScore
        }))
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
