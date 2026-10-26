import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { HELD_FAILED_LINE } from '@bananapus/nana-sdk-core/review'
import { encodeFunctionData, parseAbi, toEventSelector, TransactionNotFoundError, zeroAddress, type Address, type Hex } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRecoveryLocks, recoveryRecords } from './write-recovery-fixture'

// A Safe proposal's result is the SDK hold's: the app's follower finds the execution, and the hold proves it.

const mocks = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionCount: vi.fn(),
  },
  getAccount: vi.fn(),
  writeContract: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount, getWalletClient: async () => ({ writeContract: mocks.writeContract }) }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: SAFE, isCenterWallet: false }) }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: async () => true,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => true,
  useSafeConnection: () => true,
  waitForSafeExecutionHash: async () => EXECUTION,
  findPendingSafeAppProposal: async () => null,
  reportedSafeExecution: async () => null,
  watchSafeProposal: () => new Promise(() => {}),
  atOnceExecution: async () => null,
}))

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
const BLOCK = `0x${'b1'.repeat(32)}` as Hex
const SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
const FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = { chainId: 10, address: BOB, abi: ABI, functionName: 'transfer', args: [BOB, 5n] as const, value: 7n, label: 'Transfer' }
const input = encodeFunctionData({
  abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
  args: [BOB, 7n, encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
})
const receiptWith = (topic: Hex) => ({
  status: 'success' as const, transactionHash: EXECUTION, blockNumber: 9n, blockHash: BLOCK, transactionIndex: 0, from: BOB, to: SAFE,
  logs: [{ address: SAFE, topics: [topic, PROPOSAL], data: `0x${'00'.repeat(32)}` as Hex, removed: false, transactionHash: EXECUTION, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }],
})
const receipt = receiptWith(SUCCESS)

let useSafeTx: typeof import('@/hooks/useSafeTx').useSafeTx
type Value = ReturnType<typeof useSafeTx>
const Harness = forwardRef<Value>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})
const renderers: TestRenderer.ReactTestRenderer[] = []
const settle = () => act(async () => { for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setTimeout(resolve, 0)) })

beforeEach(async () => {
  localStorage.clear()
  installRecoveryLocks()
  vi.resetModules()
  ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
  mocks.getAccount.mockImplementation(() => ({ address: SAFE, chainId: 10 }))
  mocks.writeContract.mockReset().mockResolvedValue(PROPOSAL)
  mocks.publicClient.simulateContract.mockResolvedValue({ request: { address: BOB, functionName: 'transfer', gas: 100n } })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.publicClient.getChainId.mockResolvedValue(10)
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
    return { hash, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0, from: BOB, to: SAFE, input }
  })
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
    number: blockNumber ?? 100n, hash: blockNumber === 9n ? BLOCK : `0x${'b2'.repeat(32)}`, timestamp: 1_000n,
  }))
  mocks.publicClient.getBlockNumber.mockResolvedValue(100n)
  mocks.publicClient.getTransactionCount.mockResolvedValue(0)
  // The follower's receipt watch has the execution; the hold's own receipt read is behind until the test catches it up.
  mocks.publicClient.waitForTransactionReceipt.mockResolvedValue(receipt)
  mocks.publicClient.getTransactionReceipt.mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
  ;(await import('@/lib/write-hold')).holds.dispose()
})

describe('a Safe proposal held by the SDK', () => {
  it('shows a proven success only once the hold settles it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const ref = createRef<Value>()
    await act(async () => { renderers.push(TestRenderer.create(createElement(Harness, { ref }))) })
    await act(async () => { await ref.current!.send(request, { reviewedAccount: SAFE }) })
    await settle()
    // The follower proved the execution ran this proposal, but the hold has not read its receipt: still in flight.
    expect(ref.current).toMatchObject({ phase: 'pending', receipt: null, error: null })
    expect(recoveryRecords()).toHaveLength(1)

    mocks.publicClient.getTransactionReceipt.mockResolvedValue(receipt)
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    await settle()
    expect(ref.current).toMatchObject({ phase: 'success', hash: EXECUTION, error: null })
    expect(ref.current!.receipt?.transactionHash).toBe(EXECUTION)
    expect(recoveryRecords()).toHaveLength(0)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
  it('proposal settles from the hold, not a local follower', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const failed = receiptWith(FAILURE)
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue(failed)
    const ref = createRef<Value>()
    await act(async () => { renderers.push(TestRenderer.create(createElement(Harness, { ref }))) })
    await act(async () => { await ref.current!.send(request, { reviewedAccount: SAFE }) })
    await settle()
    // The follower read ExecutionFailure, but the hold has not: no failure shows, and the proposal can end on Done.
    expect(ref.current).toMatchObject({ phase: 'submitted', error: null, reverted: false, receipt: null })
    expect(recoveryRecords()).toHaveLength(1)

    mocks.publicClient.getTransactionReceipt.mockResolvedValue(failed)
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    await settle()
    expect(ref.current).toMatchObject({ phase: 'error', error: HELD_FAILED_LINE, reverted: true })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})
