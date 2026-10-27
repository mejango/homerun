import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { HELD_FAILED_LINE } from '@bananapus/nana-sdk-core/review'
import { encodeFunctionData, parseAbi, toEventSelector, TransactionNotFoundError, zeroAddress, type Address, type Hex } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRecoveryLocks, recoveryRecords } from './write-recovery-fixture'

// A Safe proposal's result is the SDK hold's: nothing in the app follows it or decides it.

const mocks = vi.hoisted(() => ({
  client: {
    request: vi.fn(), estimateGas: vi.fn(), getBalance: vi.fn(), getTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getTransactionCount: vi.fn(),
  },
  sendTransaction: vi.fn(),
}))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: SAFE, chainId: 10 }),
  getPublicClient: () => mocks.client,
  getWalletClient: async () => ({ chain: { id: 10 }, sendTransaction: mocks.sendTransaction }),
  switchChain: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: SAFE, isCenterWallet: false }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => true,
  useSafeConnection: () => true,
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
const call = { to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n }
const input = encodeFunctionData({
  abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
  args: [BOB, 7n, call.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
})
const receiptWith = (topic: Hex) => ({
  status: 'success' as const, transactionHash: EXECUTION, blockNumber: 9n, blockHash: BLOCK, transactionIndex: 0, from: BOB, to: SAFE,
  logs: [{ address: SAFE, topics: [topic, PROPOSAL], data: `0x${'00'.repeat(32)}` as Hex, removed: false, transactionHash: EXECUTION, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0 }],
})

let useReviewedAction: typeof import('@/hooks/useReviewedAction').useReviewedAction
type Value = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Value>(function Harness(_, ref) {
  const value = useReviewedAction(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})
const renderers: TestRenderer.ReactTestRenderer[] = []
const cleanups: (() => void)[] = []
const settle = () => act(async () => { for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setTimeout(resolve, 0)) })

/** The proposal's execution, as the hold proves it: the Safe ran this call, with `topic` its result. */
async function executed(topic: Hex) {
  mocks.client.getTransactionReceipt.mockResolvedValue(receiptWith(topic))
  const { holds } = await import('@/lib/write-hold')
  await act(async () => { await holds.open({ chainId: 10, account: SAFE, safe: true, call }).onExecuted(mocks.client as never, EXECUTION) })
  await settle()
}

beforeEach(async () => {
  localStorage.clear()
  installRecoveryLocks()
  vi.resetModules()
  ;({ useReviewedAction } = await import('@/hooks/useReviewedAction'))
  // Safe's transaction service has nothing queued and never reports an execution: only the hold can settle the proposal.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ count: 0, results: [] })))
  const review = await import('@bananapus/nana-sdk-core/review')
  cleanups.push(review.registerReviewHandler(async prompt => prompt.confirmation))
  mocks.sendTransaction.mockReset().mockResolvedValue(PROPOSAL)
  mocks.client.request.mockImplementation(async ({ method, params }: { method: string; params: [{ to: Address }] }) => {
    if (method !== 'eth_call') throw new Error(`Unexpected RPC ${method}`)
    // The Safe's nonce, read as one word; any other call simulates clean.
    return params[0].to.toLowerCase() === SAFE ? `0x${'3'.padStart(64, '0')}` : '0x'
  })
  mocks.client.estimateGas.mockResolvedValue(50_000n)
  mocks.client.getBalance.mockResolvedValue(10n ** 18n)
  mocks.client.getChainId.mockResolvedValue(10)
  mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
    return { hash, blockHash: BLOCK, blockNumber: 9n, transactionIndex: 0, from: BOB, to: SAFE, input }
  })
  mocks.client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
    number: blockNumber ?? 100n, hash: blockNumber === 9n ? BLOCK : `0x${'b2'.repeat(32)}`, timestamp: 1_000n,
  }))
  mocks.client.getBlockNumber.mockResolvedValue(100n)
  mocks.client.getTransactionCount.mockResolvedValue(0)
  mocks.client.waitForTransactionReceipt.mockImplementation(() => new Promise(() => {}))
  mocks.client.getTransactionReceipt.mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanups.length) cleanups.pop()!()
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
  ;(await import('@/lib/write-hold')).holds.dispose()
})

async function propose() {
  const ref = createRef<Value>()
  await act(async () => { renderers.push(TestRenderer.create(createElement(Harness, { ref }))) })
  let returned: Hex | null = null
  await act(async () => { returned = await ref.current!.send(request, { reviewedAccount: SAFE }) })
  await settle()
  expect(returned).toBe(PROPOSAL)
  // With the Safe's signers, held: it can end on Done, and nothing shows it as done or failed.
  expect(ref.current).toMatchObject({ phase: 'submitted', submissionHash: PROPOSAL, safeProposalHash: PROPOSAL, error: null, receipt: null })
  expect(recoveryRecords()).toHaveLength(1)
  return ref
}

describe('a Safe proposal held by the SDK', () => {
  it('shows a proven success only once the hold settles it', async () => {
    const ref = await propose()
    await executed(SUCCESS)
    expect(ref.current).toMatchObject({ phase: 'success', hash: EXECUTION, error: null })
    expect(ref.current!.receipt?.transactionHash).toBe(EXECUTION)
    expect(recoveryRecords()).toHaveLength(0)
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
  })

  it('proposal settles from the hold, not a local follower', async () => {
    const ref = await propose()
    await executed(FAILURE)
    expect(ref.current).toMatchObject({ phase: 'error', error: HELD_FAILED_LINE, reverted: true })
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
  })
})
