import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  TransactionNotFoundError,
  encodeFunctionData,
  parseAbi,
  UserRejectedRequestError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { WRITE_EXIT_LABEL, WRITE_HOLD_NONCE_LINE, WRITE_HOLD_PENDING_LINE, WRITE_HOLD_REVERTED_LINE, createBrowserWriteRecovery, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRecoveryLocks, recoveryRecords } from './write-recovery-fixture'

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  centerWallet: false,
  chainId: 1,
  connectorUid: 'reviewed',
  connected: true,
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(),
    getChainId: vi.fn(), getBlock: vi.fn(), getTransactionReceipt: vi.fn(),
    getBlockNumber: vi.fn(), getTransactionCount: vi.fn() },
  receipt: { data: undefined, isError: false } as {
    data?: {
      status: 'success' | 'reverted'
      blockNumber?: bigint
      transactionHash: string
      logs?: { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[]
    }
    isError: boolean
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  safeConnection: false,
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => mocks.receipt,
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.connected,
    address: mocks.account,
    isCenterWallet: mocks.centerWallet,
  }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safeConnection,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => mocks.safeConnection,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  // The Safe proposal suite covers the queue lookup; nothing is queued here.
  findPendingSafeAppProposal: async () => null,
}))

import { useSafeTx } from '@/hooks/useSafeTx'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
/** Every request below was built for, and reviewed by, Alice. */
const reviewedByAlice = { reviewedAccount: ALICE }
const HASH = `0x${'ab'.repeat(32)}` as const
const EXECUTION_HASH = `0x${'cd'.repeat(32)}` as const
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as const
const canonicalReceipt = (status: 'success' | 'reverted', transactionHash: Hex = HASH) => ({
  status, transactionHash, blockNumber: 77n, blockHash: BLOCK_HASH, transactionIndex: 0,
  from: ALICE, to: BOB, logs: [],
})
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = {
  chainId: 10,
  address: BOB,
  abi: ABI,
  functionName: 'transfer',
  args: [BOB, 5n] as const,
  value: 7n,
  label: 'Transfer',
}

/** Alice's Safe running `data` as the call to Bob that `request` reviews, as an owner sends it. */
const execTransaction = (data: Hex = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })) =>
  encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [BOB, 7n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })

type SafeTxValue = ReturnType<typeof useSafeTx>

const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

async function renderHook() {
  const ref = createRef<SafeTxValue>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
  })
  renderers.push(renderer)
  return { ref, renderer }
}

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
  vi.restoreAllMocks()
})

beforeEach(() => {
  localStorage.clear()
  installRecoveryLocks()
  displayQueries.clear()
  mocks.account = ALICE
  mocks.centerWallet = false
  mocks.chainId = 1
  mocks.connectorUid = 'reviewed'
  mocks.connected = true
  mocks.receipt = { data: undefined, isError: false }
  mocks.publicClient.getBlockNumber.mockResolvedValue(90n)
  mocks.publicClient.getTransactionCount.mockResolvedValue(5)
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }))
  mocks.requestReview.mockResolvedValue(true)
  mocks.safeConnection = false
  mocks.switchChain.mockImplementation(async ({ chainId }) => { mocks.chainId = chainId })
  mocks.waitForSafeExecutionHash.mockResolvedValue(EXECUTION_HASH)
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
    hash,
    from: mocks.safeConnection ? BOB : ALICE,
    to: mocks.safeConnection ? ALICE : BOB,
    input: mocks.safeConnection ? execTransaction() : encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }),
    blockHash: BLOCK_HASH, blockNumber: 77n, transactionIndex: 0,
  }))
  mocks.publicClient.getChainId.mockResolvedValue(10)
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    number: blockNumber ?? 100n, hash: BLOCK_HASH, timestamp: 1_000n,
  }))
  mocks.publicClient.getTransactionReceipt.mockImplementation(async () => mocks.receipt.data)
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
})

describe('useSafeTx', () => {
  it('refuses to send while view-as is active', async () => {
    setViewAs(BOB)
    try {
      const hook = await renderHook()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never

      await act(async () => {
        result = await hook.ref.current!.send(request, reviewedByAlice)
      })

      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: VIEW_AS_WRITE_BLOCKED,
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    } finally {
      clearViewAs()
    }
  })

  it('requests the transaction without a redundant switch when already on its chain', async () => {
    mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 10, connector: { uid: mocks.connectorUid } }))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => hook.renderer.unmount())
  })

  it('wallet-action:submit-a-reviewed-direct-write runs exact review, chain/account checks, simulation, and the simulated write', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = null

    await act(async () => {
      result = await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(result).toBe(HASH)
    expect(mocks.requestReview).toHaveBeenCalledWith(
      { ...request, account: ALICE },
      { label: 'Transfer' },
    )
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith({
      address: BOB,
      abi: ABI,
      functionName: 'transfer',
      args: [BOB, 5n],
      value: 7n,
      account: ALICE,
    })
    expect(mocks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 100_000n }),
    )
    expect(hook.ref.current).toMatchObject({
      phase: 'pending',
      busy: true,
      hash: HASH,
    })
  })

  it('anchors a dependent simulation to its confirmed prerequisite block', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, simulationBlockNumber: 12_345n })
    })

    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 12_345n }),
    )
  })

  it('skips only the duplicate app review when the parent already showed the exact call', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, reviewedInParent: true })
    })

    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: BOB, account: ALICE }),
    )
    expect(mocks.writeContract).toHaveBeenCalled()
  })

  it('cancels without switching, simulating, or signing', async () => {
    mocks.requestReview.mockResolvedValueOnce(false)
    const hook = await renderHook()

    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })

    expect(hook.ref.current!.phase).toBe('idle')
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('blocks a duplicate while review is open', async () => {
    let finishReview!: (approved: boolean) => void
    mocks.requestReview.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (finishReview = resolve)),
    )
    const hook = await renderHook()

    await act(async () => {
      const first = hook.ref.current!.send(request, reviewedByAlice)
      await Promise.resolve()
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
      finishReview(false)
      await first
    })

    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
    expect(hook.ref.current!.phase).toBe('idle')
  })

  it.each([
    ['its own review', {}],
    ['a review its parent showed', { reviewedInParent: true }],
  ])(
    'refuses, before %s opens, a request reviewed for another account',
    async (_, options) => {
      mocks.account = BOB
      const beforeWrite = vi.fn()
      const hook = await renderHook()

      await act(async () => {
        await expect(
          hook.ref.current!.send(request, { ...options, reviewedAccount: ALICE, beforeWrite }),
        ).resolves.toBeNull()
      })

      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        busy: false,
        error: 'The connected account changed. Review again.',
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.switchChain).not.toHaveBeenCalled()
      expect(beforeWrite).not.toHaveBeenCalled()
      expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    },
  )

  it('refuses a request whose reviewed account was switched away while its review was open', async () => {
    mocks.requestReview.mockImplementationOnce(async () => {
      mocks.account = BOB
      return true
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(hook.ref.current!.error).toBe('The connected account changed. Review again.')
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('reviews, simulates and sends as the account the request was reviewed for', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(mocks.requestReview).toHaveBeenCalledWith({ ...request, account: ALICE }, { label: 'Transfer' })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: ALICE }))
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('fails before simulation when switching changes the account', async () => {
    mocks.switchChain.mockImplementationOnce(async () => {
      mocks.account = BOB
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('fails before signing when the account changes during simulation', async () => {
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.account = BOB
      return { request: { gas: 100n } }
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('keeps a receipt RPC error pending and prevents a duplicate send', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })

    // Nothing is in flight to hold the dialog open for: Done closes it, with the hold's line.
    expect(hook.ref.current).toMatchObject({
      phase: 'submitted',
      busy: false,
      settled: true,
      confirmationUncertain: true,
      notice: 'Still pending in your wallet. Speed it up or cancel it there.',
      held: null,
    })
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
  })

  it("keeps a timed-out send held and watched through Done, so the SDK's time-based exit appears, and accepting it sends exactly once more", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      // The wallet's hash never reaches the network.
      mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      expect(hook.ref.current).toMatchObject({ phase: 'submitted', settled: true, held: null })
      // Done and reopening keep it held, and it is still asked.
      await act(async () => hook.ref.current!.dismiss())
      await act(async () => hook.ref.current!.reset())
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await act(async () => { vi.advanceTimersByTime(15_000) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(hook.ref.current).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
      expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
      mocks.receipt = { data: undefined, isError: false }
      await act(async () => { await hook.ref.current!.held!.release() })
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the result of a timed-out send whose receipt lands only after its own receipt lookups stopped', async () => {
    vi.useFakeTimers()
    try {
      mocks.publicClient.getTransactionReceipt.mockResolvedValue(undefined)
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      // Past the flow's ten minutes of direct lookups.
      await act(async () => { await vi.advanceTimersByTimeAsync(601_000) })
      expect(hook.ref.current!.phase).toBe('submitted')
      // It mines now: only the hold's own look at the chain sees it.
      const mined = mocks.publicClient.getTransaction.getMockImplementation()!
      mocks.publicClient.getTransaction.mockImplementation(async (query: { hash: Hex }) => ({ ...(await mined(query)), nonce: 5 }))
      mocks.publicClient.getTransactionReceipt.mockResolvedValue(canonicalReceipt('success'))
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(recoveryRecords()).toHaveLength(0)
      expect(hook.ref.current).toMatchObject({ phase: 'success', error: null, held: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['success', 'success', null],
    ['reverted', 'error', /failed onchain/i],
  ] as const)(
    'treats a %s receipt as a terminal state',
    async (status, phase, error) => {
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })

      mocks.receipt = { data: canonicalReceipt(status), isError: false }
      await act(async () => {
        hook.renderer.update(createElement(Harness, { ref: hook.ref }))
      })

      expect(hook.ref.current).toMatchObject({ phase, busy: false })
      if (error) expect(hook.ref.current!.error).toMatch(error)
      else expect(hook.ref.current!.error).toBeNull()
    },
  )

  it('does not confirm a new action using the previous successful receipt', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'pending', busy: true, hash: EXECUTION_HASH, receipt: null,
    })

    mocks.receipt = { data: canonicalReceipt('success', EXECUTION_HASH), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')
  })

  it('confirms from a direct receipt lookup when the block watcher stalls', async () => {
    vi.useFakeTimers()
    try {
      const getTransactionReceipt = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(canonicalReceipt('success'))
      mocks.publicClient = {
        ...mocks.publicClient,
        getTransactionReceipt,
      } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', busy: true })

      // The watcher never answers; the interval lookup does.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      expect(getTransactionReceipt).toHaveBeenCalledTimes(1)
      expect(hook.ref.current).toMatchObject({ phase: 'pending' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      // The proof independently re-reads the canonical receipt.
      expect(getTransactionReceipt).toHaveBeenCalledTimes(3)
      expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, error: null })
      expect(hook.ref.current!.receipt).toMatchObject({ blockNumber: 77n })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a disconnected wallet and reset clears terminal state', async () => {
    mocks.connected = false
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Connect a wallet first.',
    })

    await act(async () => hook.ref.current!.reset())
    expect(hook.ref.current).toMatchObject({
      phase: 'idle',
      error: null,
      hash: null,
    })
  })

  it('reports a request it cannot encode as an error, and takes the next one', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send({ ...request, functionName: 'missing' }, reviewedByAlice)
    })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(mocks.requestReview).not.toHaveBeenCalled()

    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('refuses a Center wallet before review, like view-as', async () => {
    mocks.centerWallet = true
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => { result = await hook.ref.current!.send(request, reviewedByAlice) })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'This action needs an external wallet. Juicebox wallet payments use their own payment review.',
    })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('names the chain the wallet could not switch to', async () => {
    mocks.switchChain.mockRejectedValueOnce(new Error('User rejected the switch'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Switch your wallet to Optimism to continue.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['becomes a Safe after review', false],
    ['stops being a Safe after review', true],
  ] as const)(
    'stops before the wallet when the connection %s',
    async (_, safeAtReview) => {
      mocks.safeConnection = safeAtReview
      mocks.requestReview.mockImplementationOnce(async () => {
        // A WalletConnect peer read lands mid-flow.
        mocks.safeConnection = !safeAtReview
        return true
      })
      const hook = await renderHook()
      const onBeforeWriteAborted = vi.fn()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
      await act(async () => { result = await hook.ref.current!.send(request, { ...reviewedByAlice, onBeforeWriteAborted }) })
      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: 'Wallet connection changed. Review the transaction again.',
      })
      // The gas followed the reviewed connection, and nothing reached the wallet.
      expect(mocks.writeContract).not.toHaveBeenCalled()
      // The generic reservation is withdrawn by the final connection gate.
      expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
      expect(recoveryRecords()).toHaveLength(0)
    },
  )

  it('withdraws the marker written before the write when the connection changes there', async () => {
    const events: string[] = []
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send(request, {
        ...reviewedByAlice,
        beforeWrite: () => {
          events.push('marked')
          // A WalletConnect peer read lands between the marker and the write.
          mocks.safeConnection = true
        },
        onBeforeWriteAborted: () => { events.push('withdrawn') },
        onWriteRejected: () => { events.push('rejected') },
      })
    })
    expect(result).toBeNull()
    expect(events).toEqual(['marked', 'withdrawn'])
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Wallet connection changed. Review the transaction again.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('sends the gas of the reviewed connection when a peer read flickers mid-flow', async () => {
    let simulated = false
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      simulated = true
      return { request: { address: BOB, functionName: 'transfer', gas: 100n } }
    })
    // The account gate after simulation reads the peer again before the write.
    mocks.getAccount.mockImplementation(() => {
      if (simulated) mocks.safeConnection = false
      return { address: mocks.account, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }
    })
    // And once more after the wallet answered: the sent call is still an ordinary one.
    mocks.writeContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      return HASH
    })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 100_000n }))
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH, safeProposalHash: null })
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it.each(['chain', 'connector', 'view-as'] as const)('withdraws an unsent marker if %s changes during persistence', async changed => {
    const hook = await renderHook()
    const abort = vi.fn()
    try {
      await act(async () => {
        await hook.ref.current!.send(request, {
          ...reviewedByAlice,
          beforeWrite: async () => {
            await Promise.resolve()
            if (changed === 'chain') mocks.chainId = 8453
            else if (changed === 'connector') mocks.connectorUid = 'replacement'
            else setViewAs(BOB)
          },
          onBeforeWriteAborted: abort,
        })
      })
      expect(abort).toHaveBeenCalledOnce()
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(hook.ref.current!.phase).toBe('error')
    } finally { clearViewAs() }
  })

  it('pins the wallet write to the reviewed chain', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ chainId: request.chainId }))
  })

  it('passes the write-intent callbacks to the reviewed write boundary', async () => {
    const order: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      order.push('write')
      throw new UserRejectedRequestError(new Error('User rejected'))
    })
    const beforeWrite = vi.fn(() => { order.push('beforeWrite') })
    const onWriteRejected = vi.fn(() => { order.push('rejected') })
    const onBeforeWriteAborted = vi.fn()
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(order).toEqual(['beforeWrite', 'write', 'rejected'])
    expect(onBeforeWriteAborted).not.toHaveBeenCalled()

    // An account change after the intent was persisted aborts it before the wallet.
    beforeWrite.mockImplementationOnce(() => { mocks.account = BOB })
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('holds a lost wallet reply across reset and remount, and ends the hold on the user’s word', async () => {
    const beforeWrite = vi.fn()
    mocks.publicClient.getBlockNumber.mockResolvedValue(90n)
    mocks.publicClient.getTransactionCount.mockResolvedValue(5)
    mocks.writeContract.mockImplementationOnce(async () => {
      expect(recoveryRecords()).toHaveLength(1)
      throw new Error('Wallet reply was lost after broadcast')
    })
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, { ...reviewedByAlice, beforeWrite }) })
    expect(first.ref.current).toMatchObject({ phase: 'submitted', confirmationUncertain: true, notice: writeHeldMessage() })
    expect(first.ref.current!.held).toMatchObject({ line: writeHeldMessage(), label: WRITE_EXIT_LABEL })
    expect(beforeWrite).toHaveBeenCalledOnce()
    // The account's next nonce is saved before the wallet opens, so the chain can release it.
    expect(recoveryRecords()[0]).toMatchObject({ nonce: '5', fromBlock: '90' })
    expect(recoveryRecords()[0].hash).toBeUndefined()
    await act(async () => { first.ref.current!.reset() })
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    expect(first.ref.current!.phase).toBe('submitted')
    await act(async () => { first.renderer.unmount() })
    const reopened = await renderHook()
    await act(async () => { await reopened.ref.current!.send(request, reviewedByAlice) })
    expect(reopened.ref.current).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    // They checked their wallet: the same call can be sent again.
    await act(async () => { reopened.ref.current!.held!.release() })
    expect(reopened.ref.current).toMatchObject({ phase: 'idle', held: null })
    await act(async () => { await reopened.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(reopened.ref.current!.phase).toBe('pending')
  })

  it('does not send a project update again after an upgrade moved its old record into the journal', async () => {
    const { adoptLegacyProjectAdminRecord, projectAdminNamespace } = await import('@/lib/project-admin-reservation')
    for (const hash of [HASH, undefined]) {
      localStorage.clear()
      localStorage.setItem('homerun:project-admin:pending:v1:10:7', JSON.stringify({
        version: 1, id: '11111111-1111-4111-8111-111111111111', chainId: 10, projectId: '7', holder: ALICE, target: BOB,
        data: '0x12345678', value: '0', label: 'Save', safe: false, submittedAt: 1, afterBlock: '5', ...(hash ? { hash } : {}),
      }))
      await adoptLegacyProjectAdminRecord(localStorage, 10, 7n)
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: projectAdminNamespace(7n) }) })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(hook.ref.current!.phase).toBe(hash ? 'pending' : 'submitted')
      await act(async () => { hook.renderer.unmount() })
    }
  })

  it('sends a changed amount as its own write while another amount is held', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    expect(first.ref.current!.phase).toBe('submitted')
    await act(async () => { first.ref.current!.reset() })
    await act(async () => { await first.ref.current!.send({ ...request, args: [BOB, 6n] }, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(first.ref.current!.phase).toBe('pending')
  })

  it('holds a whole action under its name, whatever the amount', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'project-update' }) })
    await act(async () => { hook.ref.current!.reset() })
    await act(async () => { await hook.ref.current!.send({ ...request, args: [BOB, 6n] }, { ...reviewedByAlice, recoveryNamespace: 'project-update' }) })
    expect(hook.ref.current).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('does not treat a rejection-looking transport message as a definite wallet rejection', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('User rejected: transport connection lost'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.phase).toBe('submitted')
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('never opens the wallet with no hold at all: a hold the storage refuses is kept in the tab', async () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('nana-sdk:reviewed-write')) throw new Error('Storage unavailable')
      original.call(this, key, value)
    })
    mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-c' }) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
    await act(async () => { hook.ref.current!.reset() })
    await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-c' }) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('never opens the wallet when the account’s nonce cannot be read, and says so', async () => {
    mocks.publicClient.getTransactionCount.mockRejectedValue(new Error('rpc down'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(hook.ref.current).toMatchObject({ phase: 'error', error: WRITE_HOLD_NONCE_LINE, held: null })
    expect(recoveryRecords()).toHaveLength(0)
  })

  const PENDING = WRITE_HOLD_PENDING_LINE
  it('never offers the exit for a returned hash that is still pending, only for one proven dropped, rechecked as it is taken', async () => {
    vi.useFakeTimers()
    const known = { hash: HASH, from: ALICE, nonce: 5, blockNumber: null, chainId: 10 }
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.receipt = { data: undefined, isError: true }
    mocks.publicClient.getTransaction.mockResolvedValue(known)
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(hook.ref.current!.held).toBeNull()
    expect(hook.ref.current!.notice).toBe(PENDING)
    // The node no longer knows it and another transaction used its nonce at a finalized block.
    const dropped = () => {
      mocks.publicClient.getTransaction.mockRejectedValue(new TransactionNotFoundError({ hash: HASH }))
      mocks.publicClient.getTransactionCount.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => (blockNumber ?? 100n) >= 95n ? 6 : 5)
      mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber, includeTransactions }: { blockNumber?: bigint; includeTransactions?: boolean }) => ({
        number: blockNumber ?? 100n, hash: BLOCK_HASH, timestamp: 1_000n,
        transactions: includeTransactions ? [{ from: ALICE, nonce: 5, hash: EXECUTION_HASH, to: BOB, input: '0x', value: 0n }] : [],
      }))
    }
    dropped()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    // It reappears before the exit is accepted: the hold stays.
    mocks.publicClient.getTransaction.mockResolvedValue(known)
    await act(async () => { await hook.ref.current!.held!.release() })
    expect(hook.ref.current!.held).toBeNull()
    expect(hook.ref.current!.notice).toBe(PENDING)
    expect(recoveryRecords()).toHaveLength(1)
    dropped()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    await act(async () => { await hook.ref.current!.held!.release() })
    expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null })
    mocks.receipt = { data: undefined, isError: false }
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('ends without a send when the hold clears while its exit is open', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.held).not.toBeNull()
    // Another tab ends the hold while this exit is on screen.
    const other = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } })
    await other.withLock(async () => { other.abandon(other.read()!, { checkedWallet: true }) })
    await act(async () => { await hook.ref.current!.held!.release() })
    expect(hook.ref.current).toMatchObject({ phase: 'submitted', notice: 'Your earlier transaction went through.', held: null })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('ends without a send when a poll sees the hold clear while its exit is open', async () => {
    vi.useFakeTimers()
    try {
      mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      const other = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } })
      await other.withLock(async () => { other.abandon(other.read()!, { checkedWallet: true }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(hook.ref.current).toMatchObject({ notice: 'Your earlier transaction went through.', held: null })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('passes the exit the record the user saw, and follows a hash another tab recorded instead of releasing', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.held).not.toBeNull()
    const other = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } })
    await other.withLock(async () => { other.submitted(HASH, other.read()!) })
    await act(async () => { await hook.ref.current!.held!.release() })
    expect(recoveryRecords()).toEqual([expect.objectContaining({ hash: HASH })])
    expect(hook.ref.current).toMatchObject({ phase: 'pending', held: null })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  describe('when the browser refuses to store a hold', () => {
    const STORAGE = "This browser can't remember pending transactions. Check your wallet before repeating one."
    it('holds in the tab, says so in the review, and never opens the wallet with no hold', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
      mocks.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-a' }) })
      expect(mocks.requestReview.mock.calls[0][1].description).toContain(STORAGE)
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current).toMatchObject({ phase: 'submitted', notice: writeHeldMessage() })
      await act(async () => { hook.ref.current!.reset() })
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-a' }) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
      await act(async () => { await hook.ref.current!.held!.release() })
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-a' }) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    })

    it('tracks a hash the wallet returned and keeps the hold until its receipt', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-b' }) })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
      await act(async () => { hook.ref.current!.reset() })
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, recoveryNamespace: 'memory-b' }) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    })
  })

  it('sends without Web Locks, holding within the tab instead of refusing', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'pending', error: null })
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('repairs a returned hash after storage recovers without submitting twice', async () => {
    vi.useFakeTimers()
    try {
      const original = Storage.prototype.setItem
      let storageBroken = true
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
        if (storageBroken && JSON.parse(value).hash) throw new Error('Storage became unavailable')
        original.call(this, key, value)
      })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(hook.ref.current!.hash).toBe(HASH)
      expect(recoveryRecords()[0].hash).toBeUndefined()
      storageBroken = false
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100) })
      expect(recoveryRecords()[0].hash).toBe(HASH)
      await act(async () => { hook.ref.current!.reset() })
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('keeps a noncanonical receipt pending and retains its durable record', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.publicClient.getBlock.mockResolvedValue({ number: 77n, hash: EXECUTION_HASH })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('pending')
    expect(hook.ref.current!.receipt).toBeNull()
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('holds a reverted write until finality proves its failure, and never sends it again meanwhile', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      number: blockNumber ?? 76n, hash: BLOCK_HASH, timestamp: 1_000n,
    }))
    mocks.receipt = { data: canonicalReceipt('reverted'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current).toMatchObject({ phase: 'error', error: WRITE_HOLD_REVERTED_LINE, held: null })
    expect(recoveryRecords()).toHaveLength(1)
    mocks.receipt = { data: undefined, isError: false }
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current!.phase).toBe('pending')
  })

  it.each(['reset', 'unmount'] as const)('does not write after %s closes an outstanding review', async close => {
    let finish!: (accepted: boolean) => void
    mocks.requestReview.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, reviewedByAlice); await Promise.resolve() })
    await act(async () => { if (close === 'reset') hook.ref.current!.reset(); else hook.renderer.unmount() })
    await act(async () => { finish(true); await pending })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(recoveryRecords()).toHaveLength(0)
  })

  it('awaits a typed domain hash handoff and does not open a second generic journal', async () => {
    const events: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      events.push('write')
      expect(recoveryRecords()).toHaveLength(0)
      return HASH
    })
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: {
        reserve: () => { events.push('reserve') },
        releaseUnsubmitted: () => { events.push('released') },
        submitted: async (hash, safe) => {
          expect(hash).toBe(HASH)
          expect(safe).toBe(false)
          await Promise.resolve()
          events.push('stored')
        },
      } })
      events.push('returned')
    })
    expect(events).toEqual(['reserve', 'write', 'stored', 'returned'])
  })

  it('returns a known hash after a domain storage failure without invoking rejection cleanup', async () => {
    const releaseUnsubmitted = vi.fn()
    const hook = await renderHook()
    let returned: Hex | null = null
    await act(async () => {
      returned = await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: {
        reserve: vi.fn(), releaseUnsubmitted,
        submitted: () => { throw { code: 4001, message: 'Storage callback failed' } },
      } })
    })
    expect(returned).toBe(HASH)
    expect(hook.ref.current).toMatchObject({ phase: 'pending', submissionHash: HASH })
    expect(releaseUnsubmitted).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('persists a wallet reply received after reset without reopening the old review', async () => {
    let reply!: (hash: Hex) => void
    mocks.writeContract.mockImplementationOnce(() => new Promise<Hex>(resolve => { reply = resolve }))
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, reviewedByAlice) })
    await act(async () => { hook.ref.current!.reset() })
    await act(async () => { reply(HASH); await pending })
    expect(hook.ref.current!.phase).toBe('idle')
    expect(recoveryRecords()[0].hash).toBe(HASH)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.submissionHash).toBe(HASH)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})
