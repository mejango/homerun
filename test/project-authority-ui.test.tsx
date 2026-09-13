import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'
import type { ProjectAuthorityState } from '../src/lib/project-authority'

const mocks = vi.hoisted(() => ({ state: null as unknown, send: vi.fn(), read: vi.fn(), reverify: vi.fn(), refetch: vi.fn(), busy: false }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: mocks.state, isPending: false, isError: false, refetch: mocks.refetch }) }))
vi.mock('../src/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('../src/hooks/useProjectAdminTx', () => ({ useProjectAdminTx: () => ({ ready: true, busy: mocks.busy, send: mocks.send }) }))
vi.mock('../src/components/ProjectAdminTransactionStatus', () => ({ ProjectAdminTransactionStatus: () => null }))
vi.mock('../src/lib/project-authority', async () => ({ ...await vi.importActual('../src/lib/project-authority'), readProjectAuthority: mocks.read, reverifyProjectAuthority: mocks.reverify }))
import { ProjectOwnershipEditor } from '../src/components/ProjectOwnershipEditor'
import { ProjectPermissionsEditor } from '../src/components/ProjectPermissionsEditor'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const DELEGATE = '0x2222222222222222222222222222222222222222' as Address
const client = {} as PublicClient
let root: Root, host: HTMLDivElement
const snapshot = (changes: Partial<ProjectAuthorityState> = {}): ProjectAuthorityState => ({ chainId: 8453, projectId: 7n, account: OWNER, owner: OWNER, controller: v6Address('JBController', 8453), kind: 'project', blockNumber: 10n, blockHash: `0x${'a'.repeat(64)}`, isOwner: true, isRevnetOperator: false, canTransfer: true, canManagePermissions: true, accountPermissions: 0n, accountGlobalPermissions: 0n, operator: DELEGATE, operatorPermissions: 0n, operatorGlobalPermissions: 0n, identity: 'snapshot', ...changes })
function checkbox(text: string) {
  const label = Array.from(host.querySelectorAll('label')).find(node => node.textContent?.includes(text))
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error(`Missing checkbox ${text}`)
  return input
}
function button(text: string) {
  const element = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.trim() === text)
  if (!element) throw new Error(`Missing button ${text}`)
  return element
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(kind: 'ownership' | 'permissions') {
  await act(async () => root.render(kind === 'ownership' ? <ProjectOwnershipEditor chainId={8453} projectId={7n} client={client} /> : <ProjectPermissionsEditor chainId={8453} projectId={7n} client={client} />))
}
beforeEach(() => {
  mocks.state = snapshot(); mocks.busy = false; mocks.send.mockReset(); mocks.read.mockReset(); mocks.reverify.mockReset(); mocks.refetch.mockReset()
  mocks.read.mockImplementation(async () => mocks.state)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('project permission controls', () => {
  it('requires explicit ROOT acknowledgment before reviewing a grant', async () => {
    await mount('permissions')
    await act(async () => checkbox('All project permissions (ROOT)').click())
    expect(button('Review permission changes').disabled).toBe(true)
    await act(async () => checkbox('I understand ROOT').click())
    expect(button('Review permission changes').disabled).toBe(false)
    await act(async () => button('Review permission changes').click())
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ functionName: 'setPermissionsFor', args: [OWNER, { operator: DELEGATE, projectId: 7n, permissionIds: [1] }] }), expect.objectContaining({ reviewNotice: expect.stringContaining('ROOT authorizes every Juicebox project permission') }))
  })

  it('shows global and unknown grants while preserving future bits in the submitted project scope', async () => {
    mocks.state = snapshot({ operatorPermissions: 1n << 255n, operatorGlobalPermissions: 1n << 7n })
    await mount('permissions')
    expect(host.textContent).toContain('Inherited from global grants: Edit project details')
    expect(host.textContent).toContain('Unrecognized project permissions 255 are preserved')
    await act(async () => checkbox('Edit payout and reserved token splits').click())
    await act(async () => button('Review permission changes').click())
    expect(mocks.send.mock.calls[0][0].args[1]).toEqual({ operator: DELEGATE, projectId: 7n, permissionIds: [19, 255] })
  })

  it('lets a ROOT delegate revoke ROOT but prevents retaining it with another edit', async () => {
    mocks.state = snapshot({ isOwner: false, operatorPermissions: 2n })
    await mount('permissions')
    await act(async () => checkbox('Edit project details').click())
    expect(button('Review permission changes').disabled).toBe(true)
    expect(host.textContent).toContain('A ROOT delegate can save non-ROOT permissions only')
    await act(async () => checkbox('All project permissions (ROOT)').click())
    expect(checkbox('All project permissions (ROOT)').disabled).toBe(true)
    expect(button('Review permission changes').disabled).toBe(false)
  })

  it('does not open transaction review if onchain permission state changed', async () => {
    mocks.reverify.mockRejectedValue(new Error('Project ownership or permissions changed after review.'))
    await mount('permissions')
    await act(async () => checkbox('Edit project details').click())
    await act(async () => button('Review permission changes').click())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(host.textContent).toContain('permissions changed after review')
  })

  it('keeps standard Revnet permission lookup read-only', async () => {
    mocks.state = snapshot({ kind: 'revnet', owner: v6Address('REVOwner', 8453), isOwner: false, isRevnetOperator: true, canManagePermissions: false })
    await mount('permissions')
    expect(host.textContent).toContain('Its standard control wallet cannot grant additional permissions')
    expect(Array.from(host.querySelectorAll('button')).some(node => node.textContent === 'Review permission changes')).toBe(false)
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
  })
})

describe('project ownership controls', () => {
  it('requires ownership acknowledgment, then reviews the exact owner and recipient', async () => {
    await mount('ownership')
    await change(host.querySelector('input')!, DELEGATE)
    expect(button('Review ownership change').disabled).toBe(true)
    await act(async () => checkbox('I understand the new owner').click())
    await act(async () => button('Review ownership change').click())
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ functionName: 'safeTransferFrom', args: [OWNER, DELEGATE, 7n] }), expect.objectContaining({ reviewNotice: expect.stringContaining('Other chains require separate ownership transfers') }))
  })

  it('blocks a stale owner and presents only control-wallet rotation for a verified revnet', async () => {
    mocks.state = snapshot({ kind: 'revnet', owner: v6Address('REVOwner', 8453), isOwner: false, isRevnetOperator: true })
    await mount('ownership')
    expect(host.textContent).toContain('Project NFT owner · REVOwner')
    expect(host.textContent).toContain('Connected control wallet')
    await change(host.querySelector('input')!, DELEGATE)
    await act(async () => checkbox('I understand this transfers').click())
    mocks.read.mockResolvedValue({ ...mocks.state as object, identity: 'changed' })
    await act(async () => button('Review ownership change').click())
    expect(mocks.send).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Project ownership or permissions changed')
  })
})
