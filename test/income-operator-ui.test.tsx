import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import type { IncomeOperatorSnapshot } from '../src/lib/income-operator'
import type { IncomeProjectState } from '../src/lib/income-state'
import type { TxSendOptions } from '../src/hooks/useSafeTx'

const runtime = vi.hoisted(() => ({
  address: undefined as Address | undefined, snapshot: undefined as IncomeOperatorSnapshot | undefined,
  queryError: false, phase: 'idle', busy: false, safeProposalHash: null as Hex | null,
  receipt: null as TransactionReceipt | null,
  verified: undefined as { rulesetId: bigint; recipient: Address } | undefined,
  verificationEnabled: false, read: vi.fn(), send: vi.fn(), invalidate: vi.fn(),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address }) }))
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({ phase: runtime.phase, busy: runtime.busy, receipt: runtime.receipt, safeProposalHash: runtime.safeProposalHash, hash: runtime.receipt?.transactionHash, error: null, send: runtime.send }),
  txPhaseLabel: (_: unknown, labels: { idle: string }) => labels.idle,
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: runtime.invalidate }),
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (queryKey[0] === 'income-operator') return { data: runtime.snapshot, isError: runtime.queryError, isPending: false, error: new Error('RPC unavailable'), refetch: vi.fn() }
    runtime.verificationEnabled = !!enabled
    return { data: runtime.verified, isError: false, refetch: vi.fn() }
  },
}))
vi.mock('@/lib/income-operator', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-operator')>(), readIncomeOperatorSnapshot: runtime.read }))
import { IncomeOperatorActions } from '../src/components/IncomeOperatorActions'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OPERATOR = '0x2222222222222222222222222222222222222222' as Address
const NEXT = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
function snapshot(): IncomeOperatorSnapshot {
  return {
    chainId: 1, projectId: 7n, blockNumber: 100n, blockHash: `0x${'aa'.repeat(32)}`, blockTimestamp: 1000n,
    controller: v6Address('JBController', 1), owner: v6Address('REVOwner', 1), account: OWNER, isOwner: true, currentRulesetId: 90n,
    stages: [90n, 100n].map((rulesetId, index) => ({ rulesetId, start: 900n + BigInt(index) * 200n, isCurrent: index === 0, operatorIndex: 0, splits: [
      { percent: 300_000_000, projectId: 0n, beneficiary: OPERATOR, hook: zeroAddress, lockedUntil: 0, preferAddToBalance: false },
      { percent: 700_000_000, projectId: 0n, beneficiary: HOOK, hook: HOOK, lockedUntil: 0, preferAddToBalance: false },
    ] })),
  }
}

describe('Owner changes the INCOME Operator', () => {
  let root: Root, host: HTMLDivElement
  beforeEach(() => {
    runtime.address = OWNER; runtime.snapshot = snapshot(); runtime.queryError = false
    runtime.phase = 'idle'; runtime.busy = false; runtime.safeProposalHash = null; runtime.receipt = null; runtime.verified = undefined
    runtime.read.mockReset(); runtime.read.mockImplementation(async () => runtime.snapshot)
    runtime.send.mockReset(); runtime.send.mockImplementation(async (_request, options: TxSendOptions) => { await options.reverify?.(_request); await options.beforeWrite?.() })
    runtime.invalidate.mockReset()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function render() { await act(async () => root.render(<IncomeOperatorActions state={{ ...snapshot() } as unknown as IncomeProjectState} client={{} as PublicClient} />)) }
  async function recipient(value: string) { await act(async () => { const input = host.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
  const button = () => host.querySelector<HTMLButtonElement>('button.btn-primary')!
  async function submit() { await act(async () => button().click()) }

  it('requires actual Owner authority even when the connected account receives incentives', async () => {
    runtime.address = OPERATOR; runtime.snapshot = { ...snapshot(), account: OPERATOR, isOwner: false }
    await render(); await recipient(NEXT)
    expect(button().disabled).toBe(true)
    expect(host.textContent).toContain('Receiving the Operator split does not grant Owner authority')
    expect(runtime.send).not.toHaveBeenCalled()
  })
  it('rejects invalid and zero wallets before preparing a transaction', async () => {
    await render()
    for (const value of ['0x123', zeroAddress]) {
      await recipient(value)
      expect(button().disabled).toBe(true)
      expect(host.textContent).toContain('valid, nonzero wallet address')
    }
    expect(runtime.send).not.toHaveBeenCalled()
  })
  it('reviews the current namespace with fresh Owner and complete splits, then rechecks before writing', async () => {
    await render(); await recipient(NEXT); await submit()
    expect(runtime.read).toHaveBeenCalledTimes(2)
    const [request, options] = runtime.send.mock.calls[0]
    expect(request.functionName).toBe('setSplitGroupsOf')
    expect(request.args).toEqual([7n, 90n, [{ groupId: 1n, splits: [{ ...snapshot().stages[0].splits[0], beneficiary: NEXT }, snapshot().stages[0].splits[1]] }]])
    expect(options.reviewNotice).toContain('1 other stage still requires a separate reviewed transaction')
    expect(options.reviewNotice).toContain('pending reserved INCOME')
  })
  it('shows and updates the upcoming namespace after the current stage is confirmed', async () => {
    await render(); await recipient(NEXT); await submit()
    runtime.snapshot = snapshot(); runtime.snapshot.blockNumber = 101n
    runtime.snapshot.stages[0].splits[0] = { ...runtime.snapshot.stages[0].splits[0], beneficiary: NEXT }
    runtime.phase = 'success'; runtime.receipt = { transactionHash: `0x${'bb'.repeat(32)}`, blockNumber: 101n } as TransactionReceipt
    runtime.verified = { rulesetId: 90n, recipient: NEXT }
    await render()
    expect(host.textContent).toContain('Operator change confirmed for stage 90')
    expect(host.textContent).not.toContain('All current and upcoming Operator splits')
    expect(button().textContent).toContain('upcoming')
    expect(button().disabled).toBe(false)
    await submit()
    expect(runtime.send.mock.calls[1][0].args[1]).toBe(100n)
    expect(runtime.invalidate).toHaveBeenCalledWith({ queryKey: ['income-operator', 1, '7'] })
    expect(runtime.invalidate).toHaveBeenCalledWith({ queryKey: ['income-reserved', 1, '7'] })
    runtime.snapshot.stages[1].splits[0] = { ...runtime.snapshot.stages[1].splits[0], beneficiary: NEXT }
    await render()
    expect(host.textContent).toContain('All current and upcoming Operator splits on Ethereum pay this wallet')
  })
  it('keeps a Safe proposal pending without announcing an executed Operator change', async () => {
    await render(); await recipient(NEXT); await submit()
    runtime.phase = 'pending'; runtime.busy = true; runtime.safeProposalHash = `0x${'cc'.repeat(32)}`
    await render()
    expect(host.textContent).toContain('The Operator has not changed yet')
    expect(host.textContent).not.toContain('Operator change confirmed')
    expect(runtime.verificationEnabled).toBe(false)
    expect(runtime.invalidate).not.toHaveBeenCalled()
    expect(button().disabled).toBe(true)
  })
  it('keeps drafts and pending status visible through failed background reads', async () => {
    await render(); await recipient(NEXT); await submit()
    runtime.phase = 'pending'; runtime.busy = true; runtime.queryError = true; runtime.snapshot = undefined
    await render()
    expect(host.querySelector('input')!.value).toBe(NEXT)
    expect(host.textContent).toContain('Waiting for onchain confirmation')
    expect(button().disabled).toBe(true)
  })
  it('blocks legacy locks and failed fresh Owner reads without offering an impossible write', async () => {
    runtime.snapshot!.stages[0].splits[0] = { ...runtime.snapshot!.stages[0].splits[0], lockedUntil: 281_474_976_710_655 }
    await render(); await recipient(NEXT)
    expect(button().disabled).toBe(true)
    expect(host.textContent).toContain('locked onchain')
    runtime.snapshot = snapshot(); await render()
    runtime.read.mockResolvedValue({ ...snapshot(), isOwner: false })
    await submit()
    expect(host.textContent).toContain('Connect the current Owner wallet')
    expect(runtime.send).not.toHaveBeenCalled()
  })
})
