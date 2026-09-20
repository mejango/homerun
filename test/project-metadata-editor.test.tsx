import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { v6Address, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'
import type { ProjectAdminSendOptions } from '@/hooks/useProjectAdminTx'
import type { TxPhase, TxRequest } from '@/hooks/useSafeTx'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address | undefined,
  owner: '0x1111111111111111111111111111111111111111' as Address,
  uri: 'ipfs://bafycurrent', permission: false,
  readDocument: vi.fn(), publish: vi.fn(), send: vi.fn(), recover: vi.fn(), viewAs: vi.fn(),
  onConfirmed: undefined as undefined | (() => void | Promise<unknown>),
  tx: {
    ready: true, busy: false, pending: false, phase: 'idle' as TxPhase,
    error: null as string | null, status: null as string | null, hash: null,
    safe: false, pendingLabel: null as string | null, recovering: false,
  },
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useProjectAdminTx', () => ({
  useProjectAdminTx: ({ chainId, onConfirmed }: { chainId: number; onConfirmed: () => void | Promise<unknown> }) => {
    runtime.onConfirmed = onConfirmed
    return { ...runtime.tx, chainId, send: runtime.send, recover: runtime.recover }
  },
}))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: runtime.viewAs }))
vi.mock('@/lib/project-metadata-edit', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/project-metadata-edit')>()
  return {
    ...actual,
    readProjectMetadataDocument: runtime.readDocument,
    publishEditedProjectMetadata: runtime.publish,
    reverifyProjectMetadataEdit: vi.fn(actual.reverifyProjectMetadataEdit),
  }
})
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ title, subtitle, children, footer }: { title: ReactNode; subtitle: ReactNode; children: ReactNode; footer: ReactNode }) => <div role="dialog"><h2>{title}</h2><p>{subtitle}</p>{children}{footer}</div>,
}))

import { ProjectMetadataEditor } from '@/components/ProjectMetadataEditor'
import { projectMetadataDocument, reverifyProjectMetadataEdit } from '@/lib/project-metadata-edit'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const DELEGATE = '0x2222222222222222222222222222222222222222' as const
const OPERATOR = '0x3333333333333333333333333333333333333333' as const
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const
const EXECUTION_HASH = `0x${'cd'.repeat(32)}` as const
const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  switch (functionName) {
    case 'ownerOf': return runtime.owner
    case 'controllerOf': return v6Address('JBController', 8453)
    case 'uriOf': return runtime.uri
    case 'hasPermission': return runtime.permission
    case 'CONTROLLER': return v6Address('JBController', 8453)
    default: throw new Error(`Unexpected contract read: ${functionName}`)
  }
})
const client = {
  chain: { id: 8453 }, getChainId: async () => 8453,
  getBlock: async () => ({ number: 100n, hash: BLOCK_HASH }), readContract,
} as unknown as PublicClient

function fundMetadata() {
  return {
    name: 'Garden FUND', description: 'A neighborhood garden.',
    homerun: {
      version: 1, kind: 'fund',
      setup: {
        location: 'Austin', ownerWallet: OWNER, operatorWallet: OPERATOR,
        ownerName: 'Garden trust', ownerIntroduction: 'We own the land.',
        operatorName: 'Gardeners', operatorIntroduction: 'We grow together.',
        monthlyRent: 4000, monthlyCosts: 1000, minimumRevenue: 2000,
        purchaseBudget: 600000, operatorSplitPercent: 60,
      },
    },
  }
}

let host: HTMLDivElement
let root: Root
let cache: QueryClient
let currentProps: { inheritedMetadataUri?: string; unavailable?: boolean } = {}

async function render(props = currentProps) {
  currentProps = props
  await act(async () => root.render(<QueryClientProvider client={cache}><ProjectMetadataEditor chainId={8453} projectId={7n} client={client} {...props} /></QueryClientProvider>))
}
async function settle(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assertion()
  }, { timeout: 5000, interval: 10 })
}
function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
}
async function click(label: string) {
  const target = button(label)
  expect(target, `Missing button: ${label}`).toBeDefined()
  expect(target!.disabled).toBe(false)
  await act(async () => target!.click())
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const node = [...host.querySelectorAll('label')].find(node => node.textContent === label)
  if (!node) throw new Error(`Missing field: ${label}`)
  return document.getElementById(node.htmlFor) as HTMLInputElement | HTMLTextAreaElement
}
async function change(label: string, value: string) {
  const target = field(label)
  await act(async () => {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open(props = currentProps) {
  await render(props)
  await settle(() => expect(button('Edit project details')?.disabled).toBe(false))
  await click('Edit project details')
}
async function review() {
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

beforeEach(() => {
  runtime.account = OWNER; runtime.owner = OWNER; runtime.uri = 'ipfs://bafycurrent'; runtime.permission = false
  runtime.tx = { ready: true, busy: false, pending: false, phase: 'idle', error: null, status: null, hash: null, safe: false, pendingLabel: null, recovering: false }
  runtime.onConfirmed = undefined
  runtime.readDocument.mockReset().mockResolvedValue(projectMetadataDocument(fundMetadata()))
  runtime.publish.mockReset().mockResolvedValue({ uri: 'ipfs://bafyupdated' })
  runtime.send.mockReset().mockImplementation(async (request: TxRequest, options: ProjectAdminSendOptions) => {
    await options.reverify(request)
    return EXECUTION_HASH
  })
  runtime.viewAs.mockReset()
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  currentProps = {}
})
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove() })

describe('live project metadata editor', () => {
  it.each([['Owner', OWNER, false], ['delegated editor', DELEGATE, true]] as const)('allows the %s using current contract authority', async (_role, account, permission) => {
    runtime.account = account; runtime.permission = permission
    await open()
    expect(field('Project name').value).toBe('Garden FUND')
    expect(runtime.readDocument).toHaveBeenCalledExactlyOnceWith('ipfs://bafycurrent')
    if (account === DELEGATE) expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'hasPermission', args: [DELEGATE, OWNER, 7n, BigInt(JBPermissionIdsV6.SET_PROJECT_URI), true, true], blockNumber: 100n,
    }))
    else expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'hasPermission' }))
    expect(runtime.publish).not.toHaveBeenCalled()
  })

  it('does not expose editing to a profile address without permission or a disconnected visitor', async () => {
    runtime.account = OPERATOR
    await render()
    await settle(() => expect(cache.getQueryState(['project-metadata-edit', 8453, '7', OPERATOR])?.status).toBe('success'))
    expect(button('Edit project details')).toBeUndefined()
    expect(runtime.readDocument).not.toHaveBeenCalled()
    runtime.account = undefined
    await render()
    expect(button('Edit project details')).toBeUndefined()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(runtime.publish).not.toHaveBeenCalled()
  })

  it('reviews normalized descriptive changes before publishing and builds only the phase-specific URI update', async () => {
    await open()
    await change('Project name', '  Updated garden  ')
    await change('About Ownership', '  The community owns the garden.  ')
    await change('Owner profile address', DELEGATE)
    await change('Operator profile address', OWNER)
    expect(host.textContent).toContain('Transfer ownership under Owner controls.')
    expect(host.textContent).toContain('Change the paid Operator under Operator controls.')
    expect(host.textContent).not.toContain('Purchase budget')
    await review()
    expect(host.textContent).toContain('Review project details')
    expect(host.textContent).toContain('Project #7 on Base')
    expect(host.textContent).toContain('Other phases and networks keep their own published details.')
    expect(host.textContent).toContain('Profile addresses describe the people shown here.')
    expect(host.querySelector('form')).toBeNull()
    expect(runtime.publish).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
    await click('Publish changes')
    expect(runtime.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ raw: fundMetadata() }), expect.objectContaining({ name: 'Updated garden', ownerIntroduction: 'The community owns the garden.', ownerWallet: DELEGATE, operatorWallet: OWNER }), {})
    expect(vi.mocked(reverifyProjectMetadataEdit).mock.invocationCallOrder[0]).toBeLessThan(runtime.publish.mock.invocationCallOrder[0])
    expect(runtime.publish.mock.invocationCallOrder[0]).toBeLessThan(runtime.send.mock.invocationCallOrder[0])
    expect(runtime.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chainId: 8453, address: v6Address('JBController', 8453), functionName: 'setUriOf', args: [7n, 'ipfs://bafyupdated'] }), expect.objectContaining({ reverify: expect.any(Function), reviewNotice: expect.stringContaining('does not transfer ownership, change payment splits, or change contract terms') }))
    expect(reverifyProjectMetadataEdit).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('confirmed.')
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('preserves a concurrent metadata update by rejecting the stale URI before pinning or submitting', async () => {
    await open(); await change('Description', 'My draft'); await review()
    runtime.uri = 'ipfs://bafyconcurrent'
    await click('Publish changes')
    expect(host.textContent).toContain('Project details changed while you were editing. Reload to preserve the latest update.')
    expect(runtime.publish).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
    expect(button('Back to details')?.disabled).toBe(false)
  })

  it('rejects a lagging RPC before publishing when another update confirmed after review opened', async () => {
    await open(); await change('Description', 'My draft'); await review()
    cache.setQueryData(['project-admin-confirmed-block', 8453, '7'], 101n)
    await click('Publish changes')
    expect(host.textContent).toContain('The RPC is behind the last confirmed project update. Wait for it to catch up before editing.')
    expect(runtime.publish).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
    expect(button('Back to details')?.disabled).toBe(false)
  })

  it('rechecks authority after publishing if project ownership changes before wallet review', async () => {
    await open(); await review()
    runtime.publish.mockImplementation(async () => { runtime.owner = DELEGATE; return { uri: 'ipfs://bafyupdated' } })
    await click('Publish changes')
    expect(runtime.publish).toHaveBeenCalledOnce()
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(reverifyProjectMetadataEdit).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Project ownership or its controller changed. Reload before editing.')
    expect(host.textContent).not.toContain('confirmed.')
  })

  it('does not submit a completed metadata upload after navigating to a different project', async () => {
    let resolveUpload!: (result: { uri: string }) => void
    runtime.publish.mockImplementation(() => new Promise<{ uri: string }>(resolve => { resolveUpload = resolve }))
    await open(); await review(); await click('Publish changes')
    await settle(() => expect(runtime.publish).toHaveBeenCalledOnce())
    expect(button('Publishing reviewed details…')?.disabled).toBe(true)
    await act(async () => root.render(<QueryClientProvider client={cache}><ProjectMetadataEditor chainId={8453} projectId={8n} client={client} /></QueryClientProvider>))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => resolveUpload({ uri: 'ipfs://bafyupdated' }))
    expect(runtime.send).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await settle(() => expect(button('Edit project details')?.disabled).toBe(false))
    await click('Edit project details')
    expect(host.textContent).toContain('Project #8 on Base')
    expect(host.textContent).not.toContain('Review project details')
  })

  it('blocks duplicate submissions while pending and keeps review open until confirmation', async () => {
    runtime.send.mockImplementation(async (request: TxRequest, options: ProjectAdminSendOptions) => {
      await options.reverify(request)
      runtime.tx = { ...runtime.tx, pending: true, phase: 'success', safe: true, pendingLabel: 'Update project details' }
      return EXECUTION_HASH
    })
    await open(); await review(); await click('Publish changes')
    expect(button('Waiting for confirmation…')?.disabled).toBe(true)
    expect(button('Edit project details')?.disabled).toBe(true)
    expect(host.textContent).toContain('Check Safe for signatures and execution.')
    expect(host.textContent).not.toContain('confirmed.')
    await act(async () => button('Waiting for confirmation…')!.click())
    expect(runtime.publish).toHaveBeenCalledOnce()
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    runtime.tx = { ...runtime.tx, pending: false, phase: 'success', status: 'Update project details confirmed.' }
    await act(async () => { await runtime.onConfirmed!() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.textContent).toContain('Update project details confirmed.')
  })

  it('blocks invalid profile associations and operating estimates during review', async () => {
    await open(); await change('Owner profile address', 'paloma.eth'); await review()
    expect(host.textContent).toContain('Owner profile address must be a nonzero Ethereum address.')
    expect(button('Publish changes')).toBeUndefined()
    await change('Owner profile address', OWNER); await change('Minimum monthly revenue', '-1'); await review()
    expect(host.textContent).toContain('Minimum monthly revenue must be between 0 and 1000000000000')
    expect(button('Publish changes')).toBeUndefined()
    expect(runtime.publish).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('inherits descriptive INCOME fields for review while publishing to the selected phase only', async () => {
    runtime.uri = 'ipfs://bafyincome'
    const income = { name: 'Garden INCOME', description: 'Our income phase.', homerun: { version: 1, type: 'income', manifestUri: 'ipfs://bafymanifest', operatorBps: 6000, fundHolderBps: 2500, operatorWallet: OPERATOR } }
    runtime.readDocument.mockImplementation(async (uri: string) => projectMetadataDocument(uri === runtime.uri ? income : fundMetadata()))
    await open({ inheritedMetadataUri: 'ipfs://bafyfund' })
    expect(runtime.readDocument.mock.calls).toEqual([['ipfs://bafyincome'], ['ipfs://bafyfund']])
    expect(field('Project name').value).toBe('Garden INCOME')
    expect(field('Description').value).toBe('Our income phase.')
    expect(field('About Ownership').value).toBe('We own the land.')
    expect(field('Expected monthly revenue').value).toBe('4000')
    await review(); await click('Publish changes')
    const [document] = runtime.publish.mock.calls[0]
    expect(document.raw).toMatchObject({ name: income.name, homerun: { type: 'income', manifestUri: 'ipfs://bafymanifest', operatorBps: 6000, fundHolderBps: 2500 } })
    expect(document.raw.homerun).not.toHaveProperty('kind')
    expect(document.raw.homerun.setup).not.toHaveProperty('purchaseBudget')
    expect(runtime.send.mock.calls[0][0]).toMatchObject({ chainId: 8453, functionName: 'setUriOf', args: [7n, 'ipfs://bafyupdated'] })
  })

  it('keeps edited INCOME omissions without fetching or restoring inherited FUND details', async () => {
    runtime.uri = 'ipfs://bafyincome'
    const income = {
      name: 'Garden INCOME', description: 'Our updated income phase.',
      homerun: { version: 1, type: 'income', manifestUri: 'ipfs://bafymanifest', setup: { ownerWallet: OWNER, operatorWallet: OPERATOR }, owner: { name: 'New trust' } },
    }
    runtime.readDocument.mockImplementation(async (uri: string) => {
      if (uri !== runtime.uri) throw new Error('The original FUND metadata is unavailable.')
      return projectMetadataDocument(income)
    })
    await open({ inheritedMetadataUri: 'ipfs://bafyfund' })
    expect(runtime.readDocument).toHaveBeenCalledExactlyOnceWith('ipfs://bafyincome')
    expect(field('Owner name').value).toBe('New trust')
    expect(field('About Ownership').value).toBe('')
    expect(field('Expected monthly revenue').value).toBe('')
    expect(field('Location').value).toBe('')
    await review(); await click('Publish changes')
    const [document, draft] = runtime.publish.mock.calls[0]
    expect(document.raw).toEqual(income)
    expect(draft).toMatchObject({ ownerName: 'New trust', ownerIntroduction: '', monthlyRent: '', location: '' })
    expect(runtime.readDocument).toHaveBeenCalledOnce()
    expect(runtime.send).toHaveBeenCalledOnce()
  })
})
