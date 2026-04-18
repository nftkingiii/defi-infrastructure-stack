'use client'
import { parseAbi } from 'viem'

import { useReadContract, useReadContracts } from 'wagmi'
import { CONTRACTS, SCORE_REGISTRY_ABI, MONAD_TESTNET } from '@/lib/contracts'

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

export function usePoolIds() {
  return useReadContract({
    address:      CONTRACTS.ScoreRegistry as `0x${string}`,
    abi:          SCORE_REGISTRY_ABI,
    functionName: 'getAllPoolIds',
    chainId:      MONAD_TESTNET.id,
  })
}

export function usePoolCount() {
  return useReadContract({
    address:      CONTRACTS.ScoreRegistry as `0x${string}`,
    abi:          SCORE_REGISTRY_ABI,
    functionName: 'poolCount',
    chainId:      MONAD_TESTNET.id,
  })
}

export function usePoolScores(poolIds: string[] | undefined) {
  const contracts = (poolIds ?? []).map(id => ({
    address:      CONTRACTS.ScoreRegistry as `0x${string}`,
    abi:          parseAbi(['function getLatestScore(bytes32 poolId) view returns (tuple(bytes32 poolId, string protocolName, string symbol, uint8 category, uint32 baseApy, uint32 rewardApy, uint32 netApy, uint32 apyVolatility30d, uint128 tvlUsd, uint32 liquidityDepth, uint32 utilisationRate, uint8 riskScore, uint8 ilRisk, uint8 auditScore, uint16 protocolAgeDays, uint8 confidence, address publisher, uint48 timestamp, uint32 updateCount))']),
    functionName: 'getLatestScore' as const,
    args:         [id as `0x${string}`],
    chainId:      MONAD_TESTNET.id,
  }))

  return useReadContracts({
    contracts: contracts as any,
    query: { enabled: !!poolIds?.length },
  })
}
