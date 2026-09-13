import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { resolveSafeAddress } from '@bananapus/nana-sdk-core/safe'
import { resolveCreateMultisigs, MULTICALL3 } from '@/lib/create-multisig'
import { CREATE_DEFAULTS } from '../web/create-model.mjs'
import type { CreateValues } from '@/components/CreateFlow'

// Canonical contract verification is covered by the SDK's official-bytecode tests.
// This fixture isolates the app's role selection and draft-to-SDK boundary.
vi.mock('@bananapus/nana-sdk-core/safe', async original => {
  const sdk = await original<typeof import('@bananapus/nana-sdk-core/safe')>()
  return { ...sdk, resolveSafeAddress: vi.fn(async (input: Parameters<typeof sdk.resolveSafeAddress>[0]) => {
    if (input.kind === 'existing') return sdk.resolveSafeAddress(input, [])
    const policy = { owners: input.owners, threshold: input.threshold, saltNonce: input.saltNonce, proxyCreationCode: '0x6000' as Hex }
    const plan = { ...policy, address: sdk.predictSafeAddress(policy) }
    return { address: plan.address, plan }
  }) }
})

const owners = ['0x000000000000000000000000000000000000dEad', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333']
const salt = `0x${'ab'.repeat(32)}` as Hex
const getCode = vi.fn().mockResolvedValue('0x6000')
const clients = [{ getCode }] as unknown as PublicClient[]
const draft = (patch: Partial<CreateValues> = {}) => ({ ...CREATE_DEFAULTS, ownerSigners: owners, ...patch }) as CreateValues

beforeEach(() => { vi.clearAllMocks() })

describe('create-flow Safe resolution', () => {
  it('normalizes mixed-case draft signers and creates one Safe when Owner is also Operator', async () => {
    const resolved = await resolveCreateMultisigs(draft({ operatorSigners: ['bad'], operatorThreshold: 99 }), clients, salt)
    expect(resolved.plans).toHaveLength(1)
    expect(resolved.plans[0]).toMatchObject({ role: 'owner', owners: owners.map(address => getAddress(address)), threshold: 2 })
    expect(resolved.operator).toBe(resolved.owner)
    expect(resolved.values).toMatchObject({ ownerWallet: resolved.owner, operatorWallet: resolved.owner })
    expect(resolveSafeAddress).toHaveBeenCalledTimes(1)
    expect(getCode).toHaveBeenCalledWith({ address: MULTICALL3 })
  })

  it('keeps independent policies and stable distinct role salts for separate Owner and Operator Safes', async () => {
    const input = draft({ ownerIsOperator: false, operatorSigners: owners, operatorThreshold: 3 })
    const first = await resolveCreateMultisigs(input, clients, salt)
    const resumed = await resolveCreateMultisigs(input, clients, salt)
    expect(first.plans.map(plan => [plan.role, plan.threshold])).toEqual([['owner', 2], ['operator', 3]])
    expect(first.plans[0].saltNonce).not.toBe(first.plans[1].saltNonce)
    expect(first.owner).not.toBe(first.operator)
    expect(resumed.plans).toEqual(first.plans)
  })

  it('can create an Operator Safe while keeping an existing Owner address', async () => {
    const owner = owners[1] as Address
    const resolved = await resolveCreateMultisigs(draft({ ownerMode: 'existing', ownerWallet: owner, ownerSigners: ['bad'], ownerIsOperator: false, operatorSigners: owners }), clients, salt)
    expect(resolved.owner).toBe(owner)
    expect(resolved.plans).toHaveLength(1)
    expect(resolved.plans[0].role).toBe('operator')
    expect(resolved.operator).toBe(resolved.plans[0].address)
  })
})
