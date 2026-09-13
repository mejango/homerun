import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { CREATE_DEFAULTS, normalizeCreateDraft, deploymentDraft } from '../web/create-model.mjs'
import { buildFundLaunch } from '@/lib/fund-contracts'
import { decodeLaunchSession, encodeLaunchSession, type FundLaunchSession } from '@/lib/fund-launch-session'
import { bundleMultisigLaunch, unbundleMultisigLaunch, verifyMultisigLaunchSimulation, multisigInitializer, predictMultisig, validateMultisigs, resolveCreateMultisigs, verifyCreatedMultisigs, SAFE_CREATE_ABI, CREATE_BATCH_ABI, SAFE_FACTORY, SAFE_SINGLETON, SAFE_FALLBACK, MULTICALL3, type CreateMultisig } from '@/lib/create-multisig'
import type { CreateValues } from '@/components/CreateFlow'

const identity = vi.hoisted(() => vi.fn())
vi.mock('@/lib/cross-chain-authority', () => ({ readAuthorityIdentity: identity }))
const owners = [1, 2, 3].map(value => getAddress(`0x${String(value).repeat(40)}`))
const salt = `0x${'ab'.repeat(32)}` as Hex
const policy = { owners, threshold: 2, saltNonce: salt, proxyCreationCode: '0x6000' as Hex }
const plan: CreateMultisig = { ...policy, role: 'owner', address: predictMultisig(policy) }
const fresh = (patch: Record<string, unknown> = {}) => ({ ...CREATE_DEFAULTS, name: 'Cooperative', ownerSigners: owners, ...patch })

describe('create multisig policies', () => {
  it('defaults to a 2/3 owner Safe shared with the operator and ignores inactive operator inputs', () => {
    const result = normalizeCreateDraft(fresh({ operatorWallet: 'bad', operatorSigners: [null], operatorThreshold: 99 }))
    expect(result.valid).toBe(true)
    expect(result.values).toMatchObject({ ownerIsOperator: true, ownerThreshold: 2, ownerSigners: owners })
    expect(normalizeCreateDraft(fresh({ ownerIsOperator: false })).errors.operatorSigners).toBeTruthy()
  })
  it('rejects duplicate, missing, zero, sentinel, oversized and malformed owners and invalid thresholds', () => {
    for (const signers of [[owners[0], owners[0].toLowerCase()], [owners[0]], [...owners, zeroAddress], [...owners, '0x0000000000000000000000000000000000000001'], Array(21).fill(owners[0]), null, [42, owners[1]]]) {
      expect(normalizeCreateDraft(fresh({ ownerSigners: signers })).errors.ownerSigners).toBeTruthy()
    }
    for (const threshold of [0, 4, 1.5, '2/3', null]) expect(normalizeCreateDraft(fresh({ ownerThreshold: threshold })).errors.ownerThreshold).toBeTruthy()
    expect(() => normalizeCreateDraft({ operatorWallet: 42 })).not.toThrow()
  })
  it('keeps legacy addresses and independent recipients, and resolves shared existing addresses without RPC', async () => {
    const legacy = normalizeCreateDraft({ name: 'Legacy', ownerWallet: owners[0], operatorWallet: owners[1] })
    expect(legacy.values).toMatchObject({ ownerMode: 'existing', operatorMode: 'existing', ownerWallet: owners[0], operatorWallet: owners[1] })
    const resolved = await resolveCreateMultisigs({ ...legacy.values, ownerIsOperator: true } as CreateValues, [], salt)
    expect(resolved).toMatchObject({ owner: owners[0], operator: owners[0], plans: [] })
  })
  it('exports policies and round-trips them without bigint conversion or owner drift', () => {
    const values = normalizeCreateDraft(fresh()).values
    expect(deploymentDraft(values).owner.multisig).toMatchObject({ owners, threshold: 2 })
    const input = { owner: plan.address, sender: owners[0], operator: plan.address, chainIds: [1], projectUri: 'ipfs://bafymetadata', salt, mustStartAtOrAfter: 0, creationFees: { 1: 0n }, multisigs: [plan] }
    const session: FundLaunchSession = { version: 1, transport: 'relayr', name: '2026n', input, statuses: { 1: { phase: 'ready' } } }
    expect(decodeLaunchSession(encodeLaunchSession(session))).toEqual(session)
    expect(() => buildFundLaunch({ ...input, owner: owners[1] })).toThrow('multisig address')
    expect(() => validateMultisigs([{ ...plan, threshold: 3 }])).toThrow('multisig address')
  })
  it('initializes only the requested owners and threshold, with no setup delegatecall, module or payment', () => {
    const decoded = decodeFunctionData({ abi: SAFE_CREATE_ABI, data: multisigInitializer(policy) })
    expect(decoded.args).toEqual([owners, 2n, zeroAddress, '0x', SAFE_FALLBACK, zeroAddress, 0n, zeroAddress])
    expect(predictMultisig(policy)).toBe(predictMultisig({ ...policy }))
    expect(predictMultisig({ ...policy, threshold: 3 })).not.toBe(plan.address)
  })
  it('batches both Safe deployments before the exact launch and refuses reordered, optional or substituted launch calls', () => {
    const operator = { ...plan, role: 'operator' as const, threshold: 3, address: predictMultisig({ ...policy, threshold: 3 }) }
    const entry = { chain: 1, target: owners[0], data: '0x12345678' as Hex, value: '17' }
    const batch = bundleMultisigLaunch(entry, [plan, operator])
    expect(batch.target).toBe(MULTICALL3)
    expect(unbundleMultisigLaunch(batch, [plan, operator])).toEqual(entry)
    const calls = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: batch.data }).args[0]
    expect(calls.map(call => call.target)).toEqual([SAFE_FACTORY, SAFE_FACTORY, entry.target])
    expect(calls.map(call => call.value)).toEqual([0n, 0n, 17n])
    expect(calls[2].allowFailure).toBe(false)
    const mutated = [...calls.slice(0, 2), { ...calls[2], allowFailure: true }]
    expect(() => unbundleMultisigLaunch({ ...batch, data: encodeFunctionData({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [mutated] }) }, [plan, operator])).toThrow('differs')
    expect(() => unbundleMultisigLaunch(batch, [operator, plan])).toThrow('differs')
  })
  it('does not fund a batch when the factory silently fails to create a missing Safe', async () => {
    identity.mockResolvedValue({ kind: 'eoa' })
    const data = encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{ success: false, returnData: '0x' }, { success: true, returnData: '0x' }] })
    await expect(verifyMultisigLaunchSimulation({} as PublicClient, [plan], data)).rejects.toThrow('policy')
    identity.mockResolvedValue({ kind: 'safe', singleton: SAFE_SINGLETON, threshold: 2, hasModules: false, guard: zeroAddress, fallbackHandler: SAFE_FALLBACK, owners })
    await expect(verifyMultisigLaunchSimulation({} as PublicClient, [plan], data)).resolves.toBeUndefined()
  })
  it('pins receipt recovery policy reads to the execution block, including raw bounded RPC calls', async () => {
    const request = vi.fn().mockResolvedValue('0x6000')
    identity.mockImplementationOnce(async (reader: PublicClient, address: Address) => {
      await reader.getCode({ address })
      await reader.getStorageAt({ address, slot: `0x${'00'.repeat(32)}` })
      await reader.request({ method: 'eth_call', params: [{ to: address, data: '0x' }, 'latest'] })
      return { kind: 'safe', singleton: SAFE_SINGLETON, threshold: 2, hasModules: false, guard: zeroAddress, fallbackHandler: SAFE_FALLBACK, owners }
    })
    await verifyCreatedMultisigs({ request } as unknown as PublicClient, [plan], false, 123n)
    expect(request.mock.calls.map(([call]) => call.params.at(-1))).toEqual(['0x7b', '0x7b', '0x7b'])
  })
  it('requires the deployed Safe policy and refuses missing, modified or module-enabled authority', async () => {
    const client = {} as PublicClient
    const safe = { kind: 'safe', singleton: SAFE_SINGLETON, threshold: 2, hasModules: false, guard: zeroAddress, fallbackHandler: SAFE_FALLBACK, owners }
    identity.mockResolvedValue(safe)
    await expect(verifyCreatedMultisigs(client, [plan])).resolves.toBe(true)
    for (const changed of [{ kind: 'eoa' }, { ...safe, threshold: 1 }, { ...safe, owners: [owners[0]] }, { ...safe, hasModules: true }, null]) {
      identity.mockResolvedValue(changed)
      await expect(verifyCreatedMultisigs(client, [plan])).rejects.toThrow('policy')
    }
    identity.mockResolvedValue({ kind: 'eoa' })
    await expect(verifyCreatedMultisigs(client, [plan], true)).resolves.toBe(false)
  })
})
