'use client'
import { parseAbi } from 'viem'

import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { CONTRACTS, PERPS_DEX_ABI, ERC20_ABI, MONAD_TESTNET } from '@/lib/contracts'
import { parseUnits } from 'viem'

export function useDEXPools() {
  return useReadContract({
    address:      CONTRACTS.PerpsDEX as `0x${string}`,
    abi:          PERPS_DEX_ABI,
    functionName: 'getSupportedPools',
    chainId:      MONAD_TESTNET.id,
  })
}

export function useOpenInterest(poolIds: string[] | undefined) {
  const contracts = (poolIds ?? []).map(id => ({
    address:      CONTRACTS.PerpsDEX as `0x${string}`,
    abi:          parseAbi(['function getOpenInterest(bytes32 poolId) view returns (uint128)']),
    functionName: 'getOpenInterest' as const,
    args:         [id as `0x${string}`],
    chainId:      MONAD_TESTNET.id,
  }))
  return useReadContracts({ contracts: contracts as any, query: { enabled: !!poolIds?.length } })
}

export function useMarkPrices(poolIds: string[] | undefined) {
  const contracts = (poolIds ?? []).map(id => ({
    address:      CONTRACTS.PerpsDEX as `0x${string}`,
    abi:          parseAbi(['function getMarkPrice(bytes32 poolId) view returns (uint32)']),
    functionName: 'getMarkPrice' as const,
    args:         [id as `0x${string}`],
    chainId:      MONAD_TESTNET.id,
  }))
  return useReadContracts({ contracts: contracts as any, query: { enabled: !!poolIds?.length } })
}

export function usePositionCount() {
  return useReadContract({
    address:      CONTRACTS.PerpsDEX as `0x${string}`,
    abi:          PERPS_DEX_ABI,
    functionName: 'positionCount',
    chainId:      MONAD_TESTNET.id,
  })
}

export function useLiquidationRates() {
  const buckets = Array.from({ length: 10 }, (_, i) => i)
  const contracts = buckets.map(b => ({
    address:      CONTRACTS.PerpsDEX as `0x${string}`,
    abi:          parseAbi(['function getLiquidationRate(uint8 bucket) view returns (uint256 liquidations, uint256 positions, uint256 rateBps)']),
    functionName: 'getLiquidationRate' as const,
    args:         [b],
    chainId:      MONAD_TESTNET.id,
  }))
  return useReadContracts({ contracts: contracts as any })
}

export function useUsdcBalance(address: string | undefined) {
  return useReadContract({
    address:      CONTRACTS.MockUSDC as `0x${string}`,
    abi:          ERC20_ABI,
    functionName: 'balanceOf',
    args:         address ? [address as `0x${string}`] : undefined,
    query:        { enabled: !!address },
    chainId:      MONAD_TESTNET.id,
  })
}

export function useUsdcAllowance(owner: string | undefined) {
  return useReadContract({
    address:      CONTRACTS.MockUSDC as `0x${string}`,
    abi:          ERC20_ABI,
    functionName: 'allowance',
    args:         owner ? [owner as `0x${string}`, CONTRACTS.PerpsDEX as `0x${string}`] : undefined,
    query:        { enabled: !!owner },
    chainId:      MONAD_TESTNET.id,
  })
}

export function useApproveUsdc() {
  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

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
