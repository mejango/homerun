import { describe, expect, it, vi } from 'vitest'
import { v6Address, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import {
  buildEditedProjectMetadata, buildProjectMetadataEditTx, projectMetadataDocument, publishEditedProjectMetadata,
  readProjectMetadataDocument, readProjectMetadataEditState, reverifyProjectMetadataEdit, validateProjectMetadataDraft,
} from '../src/lib/project-metadata-edit'
import type { JBCenterIpfsClient } from '../src/lib/jbcenter-ipfs'

const owner = '0x0000000000000000000000000000000000000011' as Address
const delegate = '0x0000000000000000000000000000000000000022' as Address
const operator = '0x0000000000000000000000000000000000000033' as Address
const blockHash = `0x${'11'.repeat(32)}` as const
const raw = () => ({ name: 'Garden', description: 'Our shared garden', coverImageUri: 'ipfs://bafycover', logoUri: 'ipfs://bafylogo', tokens: { name: 'Garden FUND', symbol: 'FUND' }, custom: { futureField: [1, 'keep'] }, homerun: {
  version: 1, kind: 'fund', setup: { name: 'Garden', description: 'Our shared garden', location: 'Austin', assetType: 'business', purchaseBudget: 600_000, opsReserve: 100_000, operatorFundPercent: 12, operatorSplitPercent: 60, stickySplitPercent: 25, ownerWallet: owner, operatorWallet: operator, ownerName: 'The trust', ownerIntroduction: 'We own the garden.', operatorName: 'Gardeners', operatorIntroduction: 'We grow here.', monthlyRent: 4_000, monthlyCosts: 1_000, minimumRevenue: 2_000, rentGrowthPercent: -2, costGrowthPercent: 4, networks: ['base', 'ethereum'], networkEnvironment: 'production', revnetOperatorEnabled: true, futureSetupField: 'keep' }, owner: { name: 'The trust', introduction: 'We own the garden.', photoUri: 'ipfs://bafyowner', extension: { keep: true } }, operator: { name: 'Gardeners', introduction: 'We grow here.', photoUri: 'ipfs://bafyoperator' }, incomeProject: { chainId: 1, projectId: '789', verifiedElsewhere: true }, futureLink: 'keep',
} })

function rpc(overrides: { owner?: Address; controller?: Address; uri?: string; permission?: boolean; wrapperController?: Address; chainId?: number; reorg?: boolean; blockNumber?: bigint; blockHash?: `0x${string}`; ancestorHash?: `0x${string}` } = {}) {
  const readContract = vi.fn(async (call: { functionName: string }) => {
    switch (call.functionName) {
      case 'ownerOf': return overrides.owner ?? owner
      case 'controllerOf': return overrides.controller ?? v6Address('JBController', 1)
      case 'uriOf': return overrides.uri ?? 'ipfs://bafyold'
      case 'hasPermission': return overrides.permission ?? false
      case 'CONTROLLER': return overrides.wrapperController ?? v6Address('JBController', 1)
      default: throw new Error(`Unexpected read ${call.functionName}`)
    }
  })
  const client = { chain: { id: 1 }, getChainId: vi.fn(async () => overrides.chainId ?? 1), getBlock: vi.fn(async (call: { blockNumber?: bigint }) => ({ number: call.blockNumber ?? overrides.blockNumber ?? 100n, hash: overrides.ancestorHash && call.blockNumber === 100n ? overrides.ancestorHash : overrides.reorg && call.blockNumber ? `0x${'22'.repeat(32)}` : overrides.blockHash ?? blockHash })), readContract }
  return { client: client as unknown as PublicClient, ...client }
}

describe('project metadata authoring', () => {
  it('round-trips unknown extensions, every unedited launch field, and profile extensions', () => {
    const original = raw()
    const document = projectMetadataDocument(original)
    const result = buildEditedProjectMetadata(document, { ...document.draft, name: ' New garden ', ownerName: ' New trust ', ownerWallet: delegate, minimumRevenue: '3100.25', operatorIntroduction: ' New operators ' })
    expect(result).toMatchObject({ name: 'New garden', description: original.description, custom: original.custom, tokens: original.tokens, homerun: {
      incomeProject: original.homerun.incomeProject, futureLink: 'keep', setup: { ...original.homerun.setup, name: 'New garden', ownerName: 'New trust', ownerWallet: delegate, minimumRevenue: 3100.25, operatorIntroduction: 'New operators' }, owner: { name: 'New trust', photoUri: 'ipfs://bafyowner', extension: { keep: true } }, operator: { introduction: 'New operators', photoUri: 'ipfs://bafyoperator' },
    } })
    expect(original.name).toBe('Garden')
    expect(original.homerun.owner.name).toBe('The trust')
  })

  it('does not expose arbitrary setup fields as a way to overwrite launch economics or technical bindings', () => {
    const document = projectMetadataDocument(raw())
    const draft = { ...document.draft, purchaseBudget: '1', operatorSplitPercent: '99', incomeProject: null }
    const result = buildEditedProjectMetadata(document, draft)
    expect(result).toMatchObject({ homerun: { setup: { purchaseBudget: 600_000, operatorSplitPercent: 60 }, incomeProject: raw().homerun.incomeProject } })
  })

  it('supports income profiles and descriptive inheritance without replacing income linkage or allocation facts', () => {
    const income = { name: 'Garden INCOME', description: 'Income stage', tokens: { name: 'Garden INCOME', symbol: 'INCOME' }, homerun: { version: 1, type: 'income', manifestUri: 'ipfs://bafymanifest', manifestHash: '0x1234', holderRewards: { mode: 'sticky' }, startsAtOrAfter: '100', operatorBps: 6000, fundHolderBps: 2500, operatorWallet: operator } }
    const document = projectMetadataDocument(income, projectMetadataDocument(raw()))
    expect(document.supportsPlan).toBe(true)
    expect(document.draft).toMatchObject({ name: 'Garden INCOME', location: 'Austin', ownerName: 'The trust', operatorWallet: operator })
    const result = buildEditedProjectMetadata(document, { ...document.draft, operatorName: 'Next gardeners', operatorWallet: delegate })
    expect(result).toMatchObject({ tokens: income.tokens, homerun: { ...income.homerun, setup: { operatorWallet: delegate }, operator: { name: 'Next gardeners' } } })
    expect(result.homerun).not.toHaveProperty('incomeProject')
    expect(result.homerun).not.toHaveProperty('kind')
    expect((result.homerun as { setup: object }).setup).not.toHaveProperty('purchaseBudget')
  })

  it('preserves unsupported Homerun extensions and edits only standard display fields', () => {
    const original = { name: 'Future', description: 'Later', homerun: { version: 8, kind: 'other', setup: { name: 'Canonical future' } }, extension: [1, 2] }
    const document = projectMetadataDocument(original)
    expect(document.supportsPlan).toBe(false)
    const result = buildEditedProjectMetadata(document, { ...document.draft, name: 'Updated', ownerName: 'Never write this' })
    expect(result).toEqual({ ...original, name: 'Updated' })
  })

  it('seeds legacy INCOME once and preserves intentional removals on subsequent edits', () => {
    const source = projectMetadataDocument(raw())
    const legacy = { name: 'INCOME', homerun: { version: 1, type: 'income', manifestUri: 'ipfs://bafymanifest' } }
    expect(projectMetadataDocument(legacy).needsInheritance).toBe(true)
    const seeded = projectMetadataDocument(legacy, source)
    expect(seeded.needsInheritance).toBe(false)
    const updated = buildEditedProjectMetadata(seeded, { ...seeded.draft, ownerName: '', ownerIntroduction: '' }, { owner: null, cover: null })
    const reopened = projectMetadataDocument(updated, source)
    expect(reopened.needsInheritance).toBe(false)
    expect(reopened.images.owner).toBeNull()
    expect(reopened.images.cover).toBeNull()
    expect(reopened.draft.ownerName).toBe('')
    expect(reopened.draft.ownerIntroduction).toBe('')
  })

  it.each(['-1', '1e4', 'Infinity', '2.1234567'])('rejects invalid revenue estimate %s before publishing anything', async value => {
    const document = projectMetadataDocument(raw())
    const ipfs = { pinJson: vi.fn(), pinImage: vi.fn() } as unknown as JBCenterIpfsClient
    await expect(publishEditedProjectMetadata(document, { ...document.draft, monthlyRent: value }, {}, ipfs)).rejects.toThrow('Expected monthly revenue')
    expect(ipfs.pinJson).not.toHaveBeenCalled()
    expect(ipfs.pinImage).not.toHaveBeenCalled()
  })

  it('validates profile addresses and permits the negative growth rates accepted in creation', () => {
    const document = projectMetadataDocument(raw())
    expect(validateProjectMetadataDraft(document, document.draft).rentGrowthPercent).toBe('-2')
    expect(() => validateProjectMetadataDraft(document, { ...document.draft, operatorWallet: 'paloma.eth' })).toThrow('nonzero Ethereum address')
    expect(() => validateProjectMetadataDraft(document, { ...document.draft, ownerWallet: zeroAddress })).toThrow('nonzero Ethereum address')
    expect(() => validateProjectMetadataDraft(document, { ...document.draft, ownerIntroduction: 'x'.repeat(1201) })).toThrow('1200')
  })

  it('pins reviewed image files before JSON, supports explicit removal, and leaves token metadata untouched', async () => {
    const document = projectMetadataDocument(raw())
    const file = new File(['picture'], 'next-owner.png', { type: 'image/png' })
    const pinImage = vi.fn(async () => ({ cid: 'bafynewowner' }))
    const pinJson = vi.fn(async () => ({ cid: 'bafynewmetadata' }))
    const result = await publishEditedProjectMetadata(document, document.draft, { owner: { file }, logo: { remove: true } }, { pinImage, pinJson } as unknown as JBCenterIpfsClient)
    expect(pinImage).toHaveBeenCalledExactlyOnceWith(file)
    expect(pinImage.mock.invocationCallOrder[0]).toBeLessThan(pinJson.mock.invocationCallOrder[0])
    expect(result.uri).toBe('ipfs://bafynewmetadata')
    expect(result.metadata).not.toHaveProperty('logoUri')
    expect(result.metadata).toMatchObject({ tokens: raw().tokens, homerun: { owner: { photoUri: 'ipfs://bafynewowner' } } })
  })

  it('validates every image before starting an upload and never publishes partial metadata after pin failure', async () => {
    const document = projectMetadataDocument(raw())
    const file = new File(['picture'], 'cover.png', { type: 'image/png' })
    const ipfs = { pinImage: vi.fn(async () => { throw new Error('Upload failed') }), pinJson: vi.fn() } as unknown as JBCenterIpfsClient
    await expect(publishEditedProjectMetadata(document, document.draft, { cover: { file }, owner: { file: new File(['x'], 'active.svg', { type: 'image/svg+xml' }) } }, ipfs)).rejects.toThrow('JPEG, PNG, or WebP')
    expect(ipfs.pinImage).not.toHaveBeenCalled()
    await expect(publishEditedProjectMetadata(document, document.draft, { cover: { file } }, ipfs)).rejects.toThrow('Upload failed')
    expect(ipfs.pinJson).not.toHaveBeenCalled()
  })

  it('loads current metadata only through the bounded IPFS gateway and rejects failed or non-object reads', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(raw())))
    const document = await readProjectMetadataDocument('ipfs://bafyold', fetcher)
    expect(document.raw).toEqual(raw())
    expect(fetcher.mock.calls[0][0]).toBe('https://juicebox.center/ipfs/bafyold')
    await expect(readProjectMetadataDocument('https://untrusted.example/data', fetcher)).rejects.toThrow('unsupported')
    await expect(readProjectMetadataDocument('ipfs://bafyold', async () => new Response('[]'))).rejects.toThrow('JSON object')
    await expect(readProjectMetadataDocument('ipfs://bafyold', async () => new Response('unavailable', { status: 503 }))).rejects.toThrow('could not be loaded')
    await expect(readProjectMetadataDocument('ipfs://bafyold', async () => new Response(' '.repeat(1_000_001)))).rejects.toThrow('supported size')
  })
})

describe('live metadata authority and lost-update protection', () => {
  it('checks delegated SET_PROJECT_URI including owner ROOT and wildcard permissions at one mined block', async () => {
    const mocked = rpc({ permission: true })
    const state = await readProjectMetadataEditState(mocked.client, { chainId: 1, projectId: 123n, account: delegate })
    expect(state.canEdit).toBe(true)
    expect(mocked.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'hasPermission', args: [delegate, owner, 123n, BigInt(JBPermissionIdsV6.SET_PROJECT_URI), true, true], blockNumber: 100n }))
    expect(mocked.readContract.mock.calls.every(([call]) => (call as unknown as { blockNumber: bigint }).blockNumber === 100n)).toBe(true)
    expect(buildProjectMetadataEditTx(state, 'ipfs://bafynew')).toMatchObject({ chainId: 1, address: v6Address('JBController', 1), functionName: 'setUriOf', args: [123n, 'ipfs://bafynew'] })
  })

  it('uses direct NFT ownership and does not infer permission from an operator profile address', async () => {
    const mocked = rpc()
    const own = await readProjectMetadataEditState(mocked.client, { chainId: 1, projectId: 123n, account: owner })
    expect(own.canEdit).toBe(true)
    expect(mocked.readContract.mock.calls.some(([call]) => call.functionName === 'hasPermission')).toBe(false)
    const unauthorized = await readProjectMetadataEditState(mocked.client, { chainId: 1, projectId: 123n, account: operator })
    expect(() => buildProjectMetadataEditTx(unauthorized, 'ipfs://bafynew')).toThrow('cannot edit')
  })

  it('supports the registered REVOwner via its actual delegated permission and verifies its controller', async () => {
    const wrappedOwner = v6Address('REVOwner', 1)
    const state = await readProjectMetadataEditState(rpc({ owner: wrappedOwner, permission: true }).client, { chainId: 1, projectId: 123n, account: delegate })
    expect(state.owner).toBe(wrappedOwner)
    expect(state.canEdit).toBe(true)
    await expect(readProjectMetadataEditState(rpc({ owner: wrappedOwner, wrapperController: owner, permission: true }).client, { chainId: 1, projectId: 123n, account: delegate })).rejects.toThrow('unsupported controller')
  })

  it('fails closed on changed ownership, URI, account, permission, controller, RPC chain or a reorganized snapshot', async () => {
    const state = await readProjectMetadataEditState(rpc({ permission: true }).client, { chainId: 1, projectId: 123n, account: delegate })
    await expect(reverifyProjectMetadataEdit(rpc({ owner: operator, permission: true }).client, state, delegate)).rejects.toThrow('ownership')
    await expect(reverifyProjectMetadataEdit(rpc({ uri: 'ipfs://bafynewer', permission: true }).client, state, delegate)).rejects.toThrow('changed while you were editing')
    await expect(reverifyProjectMetadataEdit(rpc({ permission: true }).client, state, owner)).rejects.toThrow('account changed')
    await expect(reverifyProjectMetadataEdit(rpc().client, state, delegate)).rejects.toThrow('permission')
    await expect(reverifyProjectMetadataEdit(rpc({ controller: operator }).client, state, delegate)).rejects.toThrow('registered V6 controller')
    await expect(reverifyProjectMetadataEdit(rpc({ chainId: 10 }).client, state, delegate)).rejects.toThrow('different chain')
    await expect(reverifyProjectMetadataEdit(rpc({ reorg: true }).client, state, delegate)).rejects.toThrow('chain changed')
  })

  it('rejects a lagging RPC and replacement of the reviewed block at the same or a later height', async () => {
    const state = await readProjectMetadataEditState(rpc({ permission: true }).client, { chainId: 1, projectId: 123n, account: delegate })
    await expect(reverifyProjectMetadataEdit(rpc({ permission: true, blockNumber: 99n }).client, state, delegate)).rejects.toThrow('RPC is behind')
    await expect(reverifyProjectMetadataEdit(rpc({ permission: true, blockHash: `0x${'22'.repeat(32)}` }).client, state, delegate)).rejects.toThrow('no longer canonical')
    await expect(reverifyProjectMetadataEdit(rpc({ permission: true, blockNumber: 110n, ancestorHash: `0x${'22'.repeat(32)}` }).client, state, delegate)).rejects.toThrow('no longer canonical')
    await expect(reverifyProjectMetadataEdit(rpc({ permission: true, blockNumber: 110n }).client, state, delegate)).resolves.toMatchObject({ blockNumber: 110n })
  })
})
