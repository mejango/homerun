import { describe, expect, it, vi } from 'vitest'
import { v6Address, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type PublicClient } from 'viem'
import { buildProjectOwnershipTx, buildProjectPermissionsTx, mergeProjectPermissionIds, projectPermissionIds, readProjectAuthority, reverifyProjectAuthority } from '../src/lib/project-authority'

const CHAIN = 8453
const OWNER = '0x1111111111111111111111111111111111111111' as Address
const DELEGATE = '0x2222222222222222222222222222222222222222' as Address
const OTHER = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'a'.repeat(64)}` as const
const ROOT = 1n << BigInt(JBPermissionIdsV6.ROOT)
const URI = 1n << BigInt(JBPermissionIdsV6.SET_PROJECT_URI)

function fixture(revnet = false) {
  const runtime = { owner: revnet ? v6Address('REVOwner', CHAIN) : OWNER, controller: v6Address('JBController', CHAIN), block: 100n, finalHash: HASH as string, approved: zeroAddress as Address, approvedForAll: false, isOperator: false, slots: new Map<string, bigint>() }
  const readContract = vi.fn(async ({ functionName, args, address }: { functionName: string; args?: unknown[]; address: Address }) => {
    switch (functionName) {
      case 'ownerOf': return runtime.owner
      case 'controllerOf': case 'CONTROLLER': return runtime.controller
      case 'PROJECTS': return v6Address('JBProjects', CHAIN)
      case 'PERMISSIONS': return v6Address('JBPermissions', CHAIN)
      case 'getApproved': return runtime.approved
      case 'isApprovedForAll': return runtime.approvedForAll
      case 'isOperatorOf': return runtime.isOperator
      case 'permissionsOf': return runtime.slots.get(`${args?.[0]}:${args?.[2]}`) ?? 0n
      default: throw new Error(`Unexpected ${address} ${functionName}`)
    }
  })
  const rpc = { getChainId: vi.fn(async () => CHAIN), getBlock: vi.fn(async (args: { blockNumber?: bigint }) => ({ number: args.blockNumber ?? runtime.block, hash: args.blockNumber ? runtime.finalHash : HASH })), readContract }
  const client = rpc as unknown as PublicClient
  const input = { chainId: CHAIN, projectId: 7n, account: OWNER, operator: DELEGATE } as const
  return { runtime, rpc, client, input }
}

describe('project authority snapshots', () => {
  it('reads NFT ownership and direct/global permission slots at one mined block', async () => {
    const f = fixture()
    f.runtime.slots.set(`${DELEGATE}:7`, URI)
    f.runtime.slots.set(`${DELEGATE}:0`, ROOT)
    const state = await readProjectAuthority(f.client, f.input)
    expect(state).toMatchObject({ owner: OWNER, kind: 'project', isOwner: true, canTransfer: true, canManagePermissions: true, operatorPermissions: URI, operatorGlobalPermissions: ROOT })
    expect(f.rpc.readContract.mock.calls.every(([call]) => 'blockNumber' in call && call.blockNumber === 100n)).toBe(true)
  })

  it('distinguishes ERC721 approval from Juicebox ROOT delegation', async () => {
    const f = fixture()
    f.runtime.slots.set(`${DELEGATE}:7`, ROOT)
    const delegated = await readProjectAuthority(f.client, { ...f.input, account: DELEGATE })
    expect(delegated).toMatchObject({ canTransfer: false, canManagePermissions: true })
    f.runtime.slots.clear(); f.runtime.approved = DELEGATE
    const approved = await readProjectAuthority(f.client, { ...f.input, account: DELEGATE })
    expect(approved).toMatchObject({ canTransfer: true, canManagePermissions: false })
    expect(buildProjectOwnershipTx(approved, OTHER).args).toEqual([OWNER, OTHER, 7n])
  })

  it('allows read-only lookup without a wallet, never authorizes writes', async () => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, { ...f.input, account: null })
    expect(state).toMatchObject({ canTransfer: false, canManagePermissions: false })
    expect(() => buildProjectOwnershipTx(state, OTHER)).toThrow('cannot change')
    expect(() => buildProjectPermissionsTx(state, [7])).toThrow('Connect the Owner')
  })

  it('fails closed on wrong chain, noncanonical controller, deployer owner and reorg', async () => {
    const f = fixture()
    f.rpc.getChainId.mockResolvedValueOnce(10)
    await expect(readProjectAuthority(f.client, f.input)).rejects.toThrow('another chain')
    f.runtime.controller = OTHER
    await expect(readProjectAuthority(f.client, f.input)).rejects.toThrow('unsupported controller')
    f.runtime.controller = v6Address('JBController', CHAIN)
    f.runtime.owner = v6Address('JBOmnichainDeployer', CHAIN)
    await expect(readProjectAuthority(f.client, f.input)).rejects.toThrow('deployment contract')
    f.runtime.owner = OWNER; f.runtime.finalHash = `0x${'b'.repeat(64)}`
    await expect(readProjectAuthority(f.client, f.input)).rejects.toThrow('chain changed')
  })

  it('disallows wildcard writes and reserved zero permission rather than dropping unknown data', async () => {
    const f = fixture()
    await expect(readProjectAuthority(f.client, { ...f.input, projectId: 0n })).rejects.toThrow('Global permission')
    f.runtime.slots.set(`${DELEGATE}:7`, 1n)
    await expect(readProjectAuthority(f.client, f.input)).rejects.toThrow('reserved permission 0')
    expect(() => projectPermissionIds(1n << 256n)).toThrow('invalid')
  })
})

describe('project ownership writes', () => {
  it('transfers the actual FUND NFT with safeTransferFrom', async () => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectOwnershipTx(state, DELEGATE)
    expect(request).toMatchObject({ address: v6Address('JBProjects', CHAIN), functionName: 'safeTransferFrom', args: [OWNER, DELEGATE, 7n] })
    expect(decodeFunctionData({ abi: request.abi, data: encodeFunctionData(request) }).functionName).toBe('safeTransferFrom')
    expect(() => buildProjectOwnershipTx(state, zeroAddress)).toThrow('nonzero')
    expect(() => buildProjectOwnershipTx(state, OWNER)).toThrow('different owner')
  })

  it('rotates only verified REVOwner control, without transferring the canonical NFT', async () => {
    const f = fixture(true)
    let state = await readProjectAuthority(f.client, f.input)
    expect(() => buildProjectOwnershipTx(state, DELEGATE)).toThrow('cannot change')
    f.runtime.isOperator = true
    state = await readProjectAuthority(f.client, f.input)
    expect(buildProjectOwnershipTx(state, DELEGATE)).toMatchObject({ address: v6Address('REVOwner', CHAIN), functionName: 'setOperatorOf', args: [7n, DELEGATE] })
    expect(state.canManagePermissions).toBe(false)
    expect(() => buildProjectOwnershipTx(state, OTHER)).toThrow('Read the new control wallet')
  })

  it('rejects changed recipient permissions during REVOwner rotation review', async () => {
    const f = fixture(true); f.runtime.isOperator = true
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectOwnershipTx(state, DELEGATE)
    f.runtime.slots.set(`${DELEGATE}:7`, URI)
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectOwnershipTx(current, DELEGATE))).rejects.toThrow('changed after review')
  })
})

describe('project permission editing', () => {
  it('preserves unknown future bits, edits one positive project scope and leaves inherited grants untouched', async () => {
    const f = fixture()
    f.runtime.slots.set(`${DELEGATE}:7`, URI | (1n << 255n))
    f.runtime.slots.set(`${DELEGATE}:0`, ROOT)
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectPermissionsTx(state, [19])
    expect(request.args).toEqual([OWNER, { operator: DELEGATE, projectId: 7n, permissionIds: [19, 255] }])
    expect(buildProjectPermissionsTx(state, []).args[1]).toMatchObject({ permissionIds: [255] })
    expect(mergeProjectPermissionIds(1n << 255n, [1, 7])).toEqual([1, 7, 255])
    expect(() => mergeProjectPermissionIds(0n, [255])).toThrow('known project permissions')
  })

  it('allows only the actual owner to grant or retain ROOT in a replacement bitmap', async () => {
    const f = fixture()
    let state = await readProjectAuthority(f.client, f.input)
    expect(buildProjectPermissionsTx(state, [1]).functionName).toBe('setPermissionsFor')
    f.runtime.slots.set(`${OTHER}:0`, ROOT)
    f.runtime.slots.set(`${DELEGATE}:7`, ROOT | URI)
    state = await readProjectAuthority(f.client, { ...f.input, account: OTHER })
    expect(() => buildProjectPermissionsTx(state, [1, 19])).toThrow('Only the project owner')
    expect(buildProjectPermissionsTx(state, [19]).args[1]).toMatchObject({ permissionIds: [19] })
  })

  it.each(['owner', 'target', 'global', 'signer'] as const)('stops stale %s changes before a reviewed permission write', async change => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectPermissionsTx(state, [7])
    if (change === 'owner') f.runtime.owner = OTHER
    if (change === 'target') f.runtime.slots.set(`${DELEGATE}:7`, 1n << 255n)
    if (change === 'global') f.runtime.slots.set(`${DELEGATE}:0`, ROOT)
    if (change === 'signer') f.runtime.slots.set(`${OWNER}:7`, ROOT)
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [7]))).rejects.toThrow('changed after review')
  })

  it('validates exact reviewed calldata and target, accepting only a current matching request', async () => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectPermissionsTx(state, [7])
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [7]))).resolves.toBeUndefined()
    await expect(reverifyProjectAuthority(f.client, state, { ...request, address: OTHER }, current => buildProjectPermissionsTx(current, [7]))).rejects.toThrow('no longer matches')
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [19]))).rejects.toThrow('no longer matches')
    f.runtime.block = 99n
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [7]))).rejects.toThrow('changed after review')
  })

  it.each([100n, 101n])('rejects a replaced review block even when authority facts match at height %s', async height => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectPermissionsTx(state, [7])
    const replaced = `0x${'b'.repeat(64)}`
    f.rpc.getBlock.mockImplementation(async args => ({ number: args.blockNumber ?? height, hash: replaced }))
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [7]))).rejects.toThrow('block used to review')
    expect(f.rpc.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n })
  })

  it('allows an advanced chain when the original review block remains canonical', async () => {
    const f = fixture()
    const state = await readProjectAuthority(f.client, f.input)
    const request = buildProjectPermissionsTx(state, [7])
    f.rpc.getBlock.mockImplementation(async args => ({ number: args.blockNumber ?? 101n, hash: args.blockNumber === 100n ? HASH : `0x${'b'.repeat(64)}` }))
    await expect(reverifyProjectAuthority(f.client, state, request, current => buildProjectPermissionsTx(current, [7]))).resolves.toBeUndefined()
    expect(f.rpc.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n })
  })
})
