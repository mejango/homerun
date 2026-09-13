import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import type { ProjectSplitsSnapshot } from '../src/lib/project-splits-edit'
import type { ProjectAdminSendOptions } from '../src/hooks/useProjectAdminTx'

const runtime = vi.hoisted(() => ({ address: undefined as Address | undefined, snapshot: undefined as ProjectSplitsSnapshot | undefined, queryError: false, read: vi.fn(), send: vi.fn(), invalidate: vi.fn(), busy: false, pending: false, phase: 'idle', ready: true, confirmed: undefined as undefined | (() => Promise<void>) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address }) }))
vi.mock('@/hooks/useProjectAdminTx', () => ({ useProjectAdminTx: ({ onConfirmed }: { onConfirmed: () => Promise<void> }) => { runtime.confirmed = onConfirmed; return { send: runtime.send, busy: runtime.busy, pending: runtime.pending, phase: runtime.phase, ready: runtime.ready } } }))
vi.mock('@/components/ProjectAdminTransactionStatus', () => ({ ProjectAdminTransactionStatus: () => <div>{runtime.pending ? 'Saved project update pending' : ''}</div> }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: runtime.invalidate }), useQuery: () => ({ data: runtime.snapshot, isError: runtime.queryError, isPending: false, error: new Error('RPC unavailable'), refetch: vi.fn() }) }))
vi.mock('@/lib/project-splits-edit', async original => ({ ...await original<typeof import('../src/lib/project-splits-edit')>(), readProjectSplitsSnapshot: runtime.read }))
import { ProjectSplitsEditor } from '../src/components/ProjectSplitsEditor'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address
const NEXT = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0x4444444444444444444444444444444444444444' as Address
function snapshot(): ProjectSplitsSnapshot {
  return { chainId: 1, projectId: 7n, phase: 'income', blockNumber: 100n, blockHash: `0x${'aa'.repeat(32)}` as Hex, blockTimestamp: 1_000n, owner: v6Address('REVOwner', 1), controller: v6Address('JBController', 1), account: OWNER, canEdit: true, currentRulesetId: 90n,
    stages: [90n, 100n].map((rulesetId, index) => ({ rulesetId, start: 900n + BigInt(index) * 200n, isCurrent: index === 0, reservedPercent: 2_000, groups: [{ groupId: 1n, label: 'Reserved tokens', kind: 'reserved', fallback: [], splits: [
      { percent: 300_000_000, projectId: 0n, beneficiary: RECIPIENT, hook: zeroAddress, lockedUntil: 0, preferAddToBalance: false },
      { percent: 700_000_000, projectId: 0n, beneficiary: RECIPIENT, hook: HOOK, lockedUntil: 0, preferAddToBalance: false },
    ] }] })),
  }
}

describe('project split editing', () => {
  let root: Root; let host: HTMLDivElement
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.close = function () { this.open = false }
    runtime.address = OWNER; runtime.snapshot = snapshot(); runtime.queryError = false; runtime.busy = false; runtime.pending = false; runtime.phase = 'idle'; runtime.ready = true
    runtime.read.mockReset(); runtime.read.mockImplementation(async () => runtime.snapshot)
    runtime.send.mockReset(); runtime.send.mockImplementation(async (request, options: ProjectAdminSendOptions) => { await options.reverify(request); return `0x${'bb'.repeat(32)}` })
    runtime.invalidate.mockReset(); runtime.confirmed = undefined
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const render = async (unavailable = false) => act(async () => root.render(<ProjectSplitsEditor chainId={1} projectId={7n} phase="income" client={{} as PublicClient} unavailable={unavailable} />))
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  const click = async (text: string) => act(async () => button(text).click())
  async function input(selector: string, value: string) {
    await act(async () => {
      const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  }

  it('shows the full reserved allocation and actual onchain Owner, with current and queued stages', async () => {
    await render()
    expect(host.textContent).toContain('reserves 20%')
    expect(host.textContent).toContain('30%')
    expect(host.textContent).toContain('70%')
    expect(host.textContent).toContain(v6Address('REVOwner', 1))
    expect(host.querySelectorAll('select')[0].options).toHaveLength(2)
    expect(button('Edit recipients').disabled).toBe(false)
  })
  it.each(['unauthorized', 'wrong-wallet', 'failed-read', 'parent-unavailable', 'saved-pending', 'journal-not-ready'])('blocks new changes when %s', async mode => {
    if (mode === 'unauthorized') runtime.snapshot!.canEdit = false
    if (mode === 'wrong-wallet') runtime.address = RECIPIENT
    if (mode === 'failed-read') runtime.queryError = true
    if (mode === 'saved-pending') { runtime.pending = true; runtime.busy = true }
    if (mode === 'journal-not-ready') runtime.ready = false
    await render(mode === 'parent-unavailable')
    expect(button('Edit recipients').disabled).toBe(true)
    expect(runtime.send).not.toHaveBeenCalled()
    if (mode === 'saved-pending') expect(host.textContent).toContain('Saved project update pending')
  })
  it('reviews only the selected queued group and revalidates before sending', async () => {
    await render(); await input('select', '100'); await click('Edit recipients')
    await input('dialog fieldset input[placeholder="0x…"]', NEXT)
    await click('Review changes')
    expect(runtime.read).toHaveBeenCalledTimes(2)
    const [request, options] = runtime.send.mock.calls[0]
    expect(request.functionName).toBe('setSplitGroupsOf')
    expect(request.args[1]).toBe(100n)
    expect(request.args[2]).toHaveLength(1)
    expect(request.args[2][0].splits[0].beneficiary).toBe(NEXT)
    expect(request.args[2][0].splits[1]).toEqual(snapshot().stages[1].groups[0].splits[1])
    expect(options.reviewNotice).toContain('queued stage 100')
    expect(options.reviewNotice).toContain('30%')
    expect(options.reviewNotice).toContain(NEXT)
    expect(options.reviewNotice).not.toContain('pending reserved tokens')
  })
  it('makes the impact on pending reserved issuance clear for the current stage', async () => {
    await render(); await click('Edit recipients'); await input('dialog fieldset input[placeholder="0x…"]', NEXT); await click('Review changes')
    expect(runtime.send.mock.calls[0][1].reviewNotice).toContain('pending reserved tokens')
  })
  it('rejects changed chain recipients before opening wallet review', async () => {
    await render(); await click('Edit recipients'); await input('dialog fieldset input[placeholder="0x…"]', NEXT)
    runtime.read.mockImplementation(async () => { const fresh = snapshot(); fresh.stages[0].groups[0].splits[0] = { ...fresh.stages[0].groups[0].splits[0], beneficiary: OWNER }; return fresh })
    await click('Review changes')
    expect(runtime.send).not.toHaveBeenCalled()
    expect(host.textContent).toContain('changed during review')
  })
  it('keeps locked routing and percentage disabled, allowing only lock extension', async () => {
    runtime.snapshot!.stages[0].groups[0].splits[0] = { ...runtime.snapshot!.stages[0].groups[0].splits[0], lockedUntil: 2_000 }
    await render(); await click('Edit recipients')
    const row = host.querySelector('dialog fieldset')!
    expect(row.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.disabled).toBe(true)
    expect(row.querySelector<HTMLInputElement>('input[placeholder="0x…"]')!.disabled).toBe(true)
    expect(row.querySelector<HTMLInputElement>('input[type="datetime-local"]')!.disabled).toBe(false)
    expect(button('Remove recipient 1').disabled).toBe(true)
  })
  it('requires explicit hook-allocation opt-in while keeping its routing immutable', async () => {
    await render(); await click('Edit recipients')
    const row = host.querySelectorAll('dialog fieldset')[1]
    expect(row.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click())
    expect(row.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.disabled).toBe(false)
    expect(row.querySelector<HTMLInputElement>('input[placeholder="0x…"]')!.disabled).toBe(true)
    expect(button('Remove recipient 2').disabled).toBe(false)
  })
  it('blocks accidental clearing into nonempty fallback recipients', async () => {
    const group = runtime.snapshot!.stages[0].groups[0]
    group.splits = [group.splits[0]]; group.fallback = [{ ...group.splits[0], beneficiary: NEXT }]
    await render(); await click('Edit recipients'); await click('Remove recipient 1')
    expect(button('Review changes').disabled).toBe(true)
    expect(host.textContent).toContain('Clearing this group would activate its default recipients')
  })
  it('allows closing a pending Safe update and refreshes Operators only after confirmation', async () => {
    await render(); await click('Edit recipients'); await input('dialog fieldset input[placeholder="0x…"]', NEXT); await click('Review changes')
    runtime.pending = true; runtime.busy = true; runtime.phase = 'pending'; await render()
    expect(button('Close').disabled).toBe(false)
    expect(runtime.invalidate).not.toHaveBeenCalled()
    await click('Close')
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.textContent).toContain('Saved project update pending')
    await act(async () => runtime.confirmed!())
    expect(runtime.invalidate).toHaveBeenCalledWith({ queryKey: ['project-operator-profile', 1, '7'] })
    expect(runtime.invalidate).toHaveBeenCalledWith({ queryKey: ['income-reserved', 1, '7'] })
  })
  it('labels reserved burns accurately and requires confirmation before creating one', async () => {
    const target = runtime.snapshot!.stages[0].groups[0]
    target.splits = [target.splits[0]]
    await render(); await click('Edit recipients'); await input('dialog fieldset input[placeholder="0x…"]', '0x000000000000000000000000000000000000dEaD')
    expect(button('Review changes').disabled).toBe(true)
    expect(host.textContent).toContain('permanently destroyed')
    await act(async () => host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click())
    await click('Review changes')
    expect(runtime.send.mock.calls[0][1].reviewNotice).toContain('Burn tokens (permanently destroyed)')
  })
})
