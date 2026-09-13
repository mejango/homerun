import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytes32ToCidV0, jbPermissionsAbi } from '@bananapus/nana-sdk-core'
import { v6Address, type Project721Shop } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { newDemoShopItem } from '../src/lib/demo-shop'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'

const mocks = vi.hoisted(() => ({ shop: vi.fn(), fund: vi.fn(), verifyHook: vi.fn(), pinJson: vi.fn(), pinMedia: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async () => ({ ...await vi.importActual('@bananapus/nana-sdk-core/v6'), getProject721Shop: mocks.shop }))
vi.mock('../src/lib/fund-state', () => ({ readFundProjectState: mocks.fund }))
vi.mock('../src/lib/fund-hooks', () => ({ readVerifiedProject721Hook: mocks.verifyHook }))
vi.mock('../src/lib/jbcenter-ipfs', () => ({ jbCenterIpfs: { pinJson: mocks.pinJson, pinMedia: mocks.pinMedia } }))
import { parseProjectShopWrite, prepareProjectShopWrite, projectShopWriteRequest, readProjectShopWriteState, reverifyProjectShopWrite, serializeProjectShopWrite } from '../src/lib/project-shop-write'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const METADATA = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'1'.repeat(64)}` as const
const DIGEST = `0x${'2'.repeat(64)}` as const
const CHAIN = 8453
const flags = { noNewTiersWithReserves: false, noNewTiersWithVotes: false, noNewTiersWithOwnerMinting: false, preventOverspending: false, issueTokensForSplits: true }
const item = (overrides = {}) => ({ ...newDemoShopItem(), name: 'Weekend stay', price: '25', ...overrides })
function fixture({ existing = true, account = OWNER, revnet = false }: { existing?: boolean; account?: Address; revnet?: boolean } = {}) {
  const configuration = initialFundRuleset()
  const runtime = {
    owner: revnet ? v6Address('REVOwner', CHAIN) : OWNER,
    controller: v6Address('JBController', CHAIN),
    granted: false,
    deployerPermissions: 1n << 255n,
    flags: { ...flags },
    maxTierId: 2n,
    removed: false,
    locked: false,
    supply: 10,
    pricing: { currency: 2, decimals: 6 },
    metadataChanged: false,
    blockHash: HASH as string,
  }
  const ruleset = { cycleNumber: 1, id: 1, basedOnId: 0, start: 1_700_000_000, duration: 0, weight: configuration.weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n }
  const shop = (): Project721Shop => ({ hook: HOOK, store: v6Address('JB721TiersHookStore', CHAIN), metadataIdTarget: METADATA, pricing: runtime.pricing, tiers: [] })
  mocks.shop.mockImplementation(async () => existing ? shop() : null)
  mocks.fund.mockImplementation(async () => ({
    chainId: CHAIN, projectId: 7n, blockNumber: 100n, owner: runtime.owner,
    controller: runtime.controller, supportedController: true, knownOwnerWrapper: true, supportedTerminals: true,
    accountingContexts: [{}], linkedPeers: [], linkedChainIds: [CHAIN], ruleset,
    hasPendingRuleset: false, projectUri: 'ipfs://project', permissions: { queueRulesets: true },
    rulesetSnapshot: { chainId: CHAIN, projectId: 7n, blockNumber: 100n, controller: runtime.controller, currentRulesetId: 1n, upcomingRulesetId: 0n, linkedChainIds: [CHAIN], configuration },
  } as unknown as FundProjectState))
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    switch (functionName) {
      case 'ownerOf': case 'owner': return runtime.owner
      case 'controllerOf': return runtime.controller
      case 'currentRulesetOf': return [ruleset, { ...configuration.metadata, ...(existing ? { dataHook: HOOK, useDataHookForPay: true } : {}), ...(runtime.metadataChanged ? { pausePay: true } : {}) }]
      case 'projectId': return 7n
      case 'flagsOf': return runtime.flags
      case 'maxTierIdOf': return runtime.maxTierId
      case 'permissionsOf': return runtime.deployerPermissions
      case 'hasPermission': return args?.[0] === v6Address('JB721TiersHookProjectDeployer', CHAIN) ? runtime.deployerPermissions & 4n ? true : false : runtime.granted
      case 'isTierRemoved': return runtime.removed
      case 'tierOf': return { id: Number(args?.[1]), price: 25_000_000n, remainingSupply: runtime.supply, initialSupply: 10, votingUnits: 0n, reserveFrequency: 0, reserveBeneficiary: zeroAddress, encodedIpfsUri: DIGEST, category: 0, discountPercent: 0, flags: { allowOwnerMint: false, transfersPausable: false, cantBeRemoved: runtime.locked, cantIncreaseDiscountPercent: false, cantBuyWithCredits: false }, splitPercent: 0, resolvedUri: '' }
      default: throw new Error(`Unexpected read ${functionName}`)
    }
  })
  const rpc = { getChainId: vi.fn(async () => CHAIN), getBlock: vi.fn(async () => ({ number: 100n, hash: runtime.blockHash, timestamp: 1_800_000_000n })), readContract }
  return { runtime, configuration, rpc, client: rpc as unknown as PublicClient, input: { chainId: CHAIN, projectId: 7n, account } as const }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pinJson.mockResolvedValue({ cid: bytes32ToCidV0(DIGEST) })
  mocks.verifyHook.mockResolvedValue({ address: HOOK, verified: true, hasTiers: true })
})

describe('live shop write state and preparation', () => {
  it('verifies canonical FUND and REVOwner hook ownership at a pinned block', async () => {
    const f = fixture()
    const state = await readProjectShopWriteState(f.client, f.input)
    expect(state).toMatchObject({ mode: 'existing', canAdd: true, canRemove: true, currency: 'USD' })
    expect(mocks.verifyHook).toHaveBeenCalledWith(expect.anything(), { chainId: CHAIN, projectId: 7n, owner: OWNER, hook: HOOK, blockNumber: 100n, ownership: 'project' })
    expect(f.rpc.readContract.mock.calls.every(([call]) => 'blockNumber' in call)).toBe(true)
    const rev = fixture({ revnet: true })
    rev.runtime.granted = true
    await readProjectShopWriteState(rev.client, rev.input)
    expect(mocks.verifyHook).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ owner: v6Address('REVOwner', CHAIN), ownership: 'address' }))
  })

  it('inherits exact shop pricing, uploads once, and submits directly to its hook', async () => {
    const f = fixture()
    f.runtime.pricing.decimals = 18
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item({ price: '1.000000000000000001' })] })
    expect(plan.requestKinds).toEqual(['adjust'])
    expect(plan.requests[0]).toMatchObject({ address: HOOK, functionName: 'adjustTiers' })
    const tier = (plan.requests[0].args[0] as { price: bigint; flags: { useVotingUnits: boolean } }[])[0]
    expect(tier.price).toBe(1_000_000_000_000_000_001n)
    expect(tier.flags.useVotingUnits).toBe(true)
    expect(mocks.pinJson).toHaveBeenCalledOnce()
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 0, plan.requests[0])).resolves.toBeUndefined()
  })

  it('requires real permissions and rejects failed canonical proofs without uploading', async () => {
    const f = fixture({ account: OTHER })
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    expect(snapshot.canAdd).toBe(false)
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item()] })).rejects.toThrow('permission')
    expect(mocks.pinJson).not.toHaveBeenCalled()
    mocks.verifyHook.mockRejectedValueOnce(new Error('not a canonical hook'))
    await expect(readProjectShopWriteState(f.client, f.input)).rejects.toThrow('canonical hook')
  })

  it('allows removal without pinning or adding and ignores ordinary sales at revalidation', async () => {
    const f = fixture()
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, removeTierIds: [1] })
    expect(plan.requests[0].args).toEqual([[], [1n]])
    expect(mocks.pinJson).not.toHaveBeenCalled()
    f.runtime.supply = 9
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER)).resolves.toBeUndefined()
    f.runtime.locked = true
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER)).rejects.toThrow('permanently locked')
  })

  it('rejects removed or permanently locked tiers before uploads', async () => {
    const f = fixture()
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    f.runtime.removed = true
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item()], removeTierIds: [1] })).rejects.toThrow('no longer available')
    f.runtime.removed = false; f.runtime.locked = true
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item()], removeTierIds: [1] })).rejects.toThrow('permanently locked')
    expect(mocks.pinJson).not.toHaveBeenCalled()
  })

  it('enforces immutable flags before upload but permits explicit zero votes', async () => {
    const f = fixture()
    f.runtime.flags = { ...flags, noNewTiersWithVotes: true, noNewTiersWithReserves: true, noNewTiersWithOwnerMinting: true }
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item({ votingUnits: '1' })] })).rejects.toThrow('voting units')
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item({ reserveN: '2', reserveBeneficiary: OWNER })] })).rejects.toThrow('reserved inventory')
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item({ allowOwnerMint: true })] })).rejects.toThrow('owner minting')
    expect(mocks.pinJson).not.toHaveBeenCalled()
    await expect(prepareProjectShopWrite(f.client, { snapshot, items: [item()] })).resolves.toMatchObject({ requestKinds: ['adjust'] })
  })

  it('fails on changed permissions, rulesets, RPC errors, and wrong chains', async () => {
    const f = fixture({ account: OTHER }); f.runtime.granted = true
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    f.runtime.granted = false
    await expect(reverifyProjectShopWrite(f.client, plan, OTHER)).rejects.toThrow('permissions changed')
    f.runtime.granted = true; f.runtime.metadataChanged = true
    await expect(reverifyProjectShopWrite(f.client, plan, OTHER)).rejects.toThrow('changed since review')
    f.runtime.metadataChanged = false
    mocks.shop.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(readProjectShopWriteState(f.client, f.input)).rejects.toThrow('RPC unavailable')
    f.rpc.getChainId.mockResolvedValueOnce(1)
    await expect(readProjectShopWriteState(f.client, f.input)).rejects.toThrow('another chain')
  })
})

describe('first shop permission sequence and recovered plans', () => {
  it('grants only project queue permission, creates atomically, and restores unknown existing bits', async () => {
    const f = fixture({ existing: false })
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    expect(plan.requestKinds).toEqual(['grant', 'create', 'restore'])
    const decode = (i: number) => decodeFunctionData({ abi: jbPermissionsAbi, data: encodeFunctionData(plan.requests[i]) })
    expect(decode(0)).toMatchObject({ functionName: 'setPermissionsFor', args: [OWNER, { operator: getAddress(v6Address('JB721TiersHookProjectDeployer', CHAIN)), projectId: 7n, permissionIds: [2, 255] }] })
    expect(decode(2)).toMatchObject({ args: [OWNER, { permissionIds: [255] }] })
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 0)).resolves.toBeUndefined()
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 1)).rejects.toThrow('permissions changed')
    f.runtime.deployerPermissions |= 4n
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 1)).resolves.toBeUndefined()
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 2)).resolves.toBeUndefined()
    f.runtime.deployerPermissions |= 8n
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 2)).rejects.toThrow('will not overwrite')
  })

  it('uses one creation request when the deployer already has authority', async () => {
    const f = fixture({ existing: false }); f.runtime.deployerPermissions |= 4n
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    expect((await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })).requestKinds).toEqual(['create'])
  })

  it('rejects recovered permission facts that would silently retain the temporary queue grant', async () => {
    const f = fixture({ existing: false })
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    const raw = serializeProjectShopWrite(plan)
    const originalBitmap = snapshot.create!.deployerPermissions
    const tampered = raw.replace(`"deployerPermissions":{"$bigint":"${originalBitmap}"}`, `"deployerPermissions":{"$bigint":"${originalBitmap | 4n}"}`)
    expect(tampered).not.toBe(raw)
    expect(parseProjectShopWrite(tampered)).toBeNull()
    plan.snapshot.create!.deployerPermissions |= 4n
    expect(() => projectShopWriteRequest(plan, 2)).toThrow('contradicts its previous permissions')
  })

  it('recovers facts while rebuilding executable requests and rejecting corrupt saved data', async () => {
    const f = fixture()
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    const raw = serializeProjectShopWrite(plan)
    expect(raw).not.toContain('"abi"')
    const parsed = parseProjectShopWrite(raw)!
    expect(encodeFunctionData(parsed.requests[0])).toEqual(encodeFunctionData(plan.requests[0]))
    parsed.requests[0].address = OTHER
    expect(projectShopWriteRequest(parsed, 0).address).toBe(HOOK)
    for (const invalid of [null, '{}', raw.replace('"version":1', '"version":2'), raw.replace('"$bigint":"7"', '"$bigint":"-1"')]) expect(parseProjectShopWrite(invalid)).toBeNull()
  })

  it('rejects persisted target or pricing tampering even with an unchanged identity string', async () => {
    const f = fixture()
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    const targetTamper = parseProjectShopWrite(serializeProjectShopWrite(plan))!
    targetTamper.snapshot.shop!.hook = OTHER
    await expect(reverifyProjectShopWrite(f.client, targetTamper, OWNER)).rejects.toThrow('Saved shop settings')
    const priceTamper = parseProjectShopWrite(serializeProjectShopWrite(plan))!
    priceTamper.snapshot.pricing.decimals = 18
    await expect(reverifyProjectShopWrite(f.client, priceTamper, OWNER)).rejects.toThrow('Saved shop settings')
    await expect(reverifyProjectShopWrite(f.client, plan, OTHER)).rejects.toThrow('another account')
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 0, { ...plan.requests[0], address: OTHER })).rejects.toThrow('differs from the reviewed')
  })

  it('rejects persisted ruleset changes and ownership changes before temporary permission cleanup', async () => {
    const f = fixture({ existing: false })
    const snapshot = await readProjectShopWriteState(f.client, f.input)
    const plan = await prepareProjectShopWrite(f.client, { snapshot, items: [item()] })
    f.runtime.deployerPermissions |= 4n
    const tampered = parseProjectShopWrite(serializeProjectShopWrite(plan))!
    tampered.snapshot.create!.configuration!.metadata.cashOutTaxRate = 5000
    await expect(reverifyProjectShopWrite(f.client, tampered, OWNER, 1)).rejects.toThrow('Saved shop settings')
    f.runtime.owner = OTHER
    await expect(reverifyProjectShopWrite(f.client, plan, OWNER, 2)).rejects.toThrow('ownership')
  })
})
