'use client'

import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { parseAbi, parseUnits } from 'viem'
import { CONTRACTS, MONAD_TESTNET, ERC20_ABI, PERPS_DEX_ABI } from './contracts'

const RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://testnet-rpc.monad.xyz'

function getProvider() {
  return new ethers.JsonRpcProvider(RPC)
}

function getDex() {
  return new ethers.Contract(CONTRACTS.PerpsDEX, [
    'function getSupportedPools() view returns (bytes32[])',
    'function getOpenInterest(bytes32 poolId) view returns (uint128)',
    'function getMarkPrice(bytes32 poolId) view returns (uint32)',
    'function positionCount() view returns (uint256)',
    'function getLiquidationRate(uint8 bucket) view returns (uint256 liquidations, uint256 positions, uint256 rateBps)',
    'function isLiquidatable(uint256 positionId) view returns (bool)',
  ], getProvider())
}

function getUsdc(address?: string) {
  return new ethers.Contract(CONTRACTS.MockUSDC, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ], getProvider())
}

// ── DEX pools ─────────────────────────────────────────────────────────────────

export function useDEXPools() {
  const [data, setData]      = useState<string[] | undefined>()
  const [isLoading, setLoad] = useState(true)

  useEffect(() => {
    let cancelled = false
    getDex().getSupportedPools()
      .then((pools: string[]) => { if (!cancelled) { setData(pools); setLoad(false) } })
      .catch(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [])

  return { data, isLoading }
}

// ── Open interest ─────────────────────────────────────────────────────────────

export function useOpenInterest(poolIds: string[] | undefined) {
  const [data, setData] = useState<{ result: bigint }[] | undefined>()

  useEffect(() => {
    if (!poolIds?.length) return
    let cancelled = false
    const dex = getDex()
    Promise.all(poolIds.map(id => dex.getOpenInterest(id)))
      .then((results: bigint[]) => {
        if (!cancelled) setData(results.map(r => ({ result: BigInt(r) })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [poolIds?.join(',')])

  return { data }
}

// ── Mark prices ───────────────────────────────────────────────────────────────

export function useMarkPrices(poolIds: string[] | undefined) {
  const [data, setData] = useState<{ result: number }[] | undefined>()

  useEffect(() => {
    if (!poolIds?.length) return
    let cancelled = false
    const dex = getDex()
    Promise.all(poolIds.map(id => dex.getMarkPrice(id)))
      .then((results: any[]) => {
        if (!cancelled) setData(results.map(r => ({ result: Number(r) })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [poolIds?.join(',')])

  return { data }
}

// ── Position count ────────────────────────────────────────────────────────────

export function usePositionCount() {
  const [data, setData] = useState<bigint | undefined>()

  useEffect(() => {
    let cancelled = false
    getDex().positionCount()
      .then((v: bigint) => { if (!cancelled) setData(BigInt(v)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return { data }
}

// ── Liquidation rates ─────────────────────────────────────────────────────────

export function useLiquidationRates() {
  const [data, setData] = useState<{ result: [bigint, bigint, bigint] | undefined }[] | undefined>()

  useEffect(() => {
    let cancelled = false
    const dex = getDex()
    Promise.all(Array.from({ length: 10 }, (_, i) => dex.getLiquidationRate(i)))
      .then((results: any[]) => {
        if (!cancelled) setData(results.map(r => ({
          result: [BigInt(r.liquidations), BigInt(r.positions), BigInt(r.rateBps)] as [bigint, bigint, bigint]
        })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return { data }
}

// ── USDC balance ──────────────────────────────────────────────────────────────

export function useUsdcBalance(address: string | undefined) {
  const [data, setData] = useState<bigint | undefined>()

  useEffect(() => {
    if (!address) return
    let cancelled = false
    getUsdc().balanceOf(address)
      .then((v: bigint) => { if (!cancelled) setData(BigInt(v)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address])

  return { data }
}

// ── USDC allowance ────────────────────────────────────────────────────────────

export function useUsdcAllowance(owner: string | undefined) {
  const [data, setData] = useState<bigint | undefined>()

  useEffect(() => {
    if (!owner) return
    let cancelled = false
    getUsdc().allowance(owner, CONTRACTS.PerpsDEX)
      .then((v: bigint) => { if (!cancelled) setData(BigInt(v)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [owner])

  return { data }
}

// ── Write hooks (keep using wagmi for wallet transactions) ────────────────────

export function useApproveUsdc() {
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess }   = useWaitForTransactionReceipt({ hash })

  const approve = (amount: string) => {
    writeContract({
      address:      CONTRACTS.MockUSDC as `0x${string}`,
      abi:          parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
      functionName: 'approve',
      args:         [CONTRACTS.PerpsDEX as `0x${string}`, parseUnits(amount, 6)],
    } as any)
  }

  return { approve, isPending, isConfirming, isSuccess, hash }
}

export function useMintUsdc() {
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess }   = useWaitForTransactionReceipt({ hash })

  const mint = (to: string, amount: string) => {
    writeContract({
      address:      CONTRACTS.MockUSDC as `0x${string}`,
      abi:          parseAbi(['function mint(address to, uint256 amount) external']),
      functionName: 'mint',
      args:         [to as `0x${string}`, parseUnits(amount, 6)],
    } as any)
  }

  return { mint, isPending, isConfirming, isSuccess }
}

export function useOpenPosition() {
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess }   = useWaitForTransactionReceipt({ hash })

  const open = (poolId: string, side: number, collateral: string, leverage: number) => {
    writeContract({
      address:      CONTRACTS.PerpsDEX as `0x${string}`,
      abi:          parseAbi(['function openPosition(bytes32 poolId, uint8 side, uint128 collateralUsdc, uint8 leverage) external returns (uint256 positionId)']),
      functionName: 'openPosition',
      args:         [poolId as `0x${string}`, side, parseUnits(collateral, 6), leverage],
    } as any)
  }

  return { open, isPending, isConfirming, isSuccess, hash }
}

export function useClosePosition() {
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess }   = useWaitForTransactionReceipt({ hash })

  const close = (positionId: bigint) => {
    writeContract({
      address:      CONTRACTS.PerpsDEX as `0x${string}`,
      abi:          parseAbi(['function closePosition(uint256 positionId) external']),
      functionName: 'closePosition',
      args:         [positionId],
    } as any)
  }

  return { close, isPending, isConfirming, isSuccess }
}
