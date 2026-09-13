import { describe, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { isVerifiedProject721Hook, readVerifiedProject721Hook } from '../src/lib/fund-hooks'

const HOOK = '0x1111111111111111111111111111111111111111' as const
const OWNER = '0x2222222222222222222222222222222222222222' as const
const input = { chainId: 1, projectId: 7n, owner: OWNER, hook: HOOK, blockNumber: 100n } as const

function fixture(values: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    deployerOf: v6Address('JB721TiersHookDeployer', 1),
    STORE: v6Address('JB721TiersHookStore', 1), DIRECTORY: v6Address('JBDirectory', 1),
    PROJECTS: v6Address('JBProjects', 1), projectId: input.projectId,
    jbOwner: [zeroAddress, input.projectId, 0], owner: OWNER, maxTierIdOf: 3n, ...values,
  }
  const readContract = vi.fn(async (request: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
    expect(request.blockNumber).toBe(input.blockNumber)
    expect(request.address).toBe(request.functionName === 'deployerOf' ? v6Address('JBAddressRegistry', 1)
      : request.functionName === 'maxTierIdOf' ? v6Address('JB721TiersHookStore', 1) : HOOK)
    expect(request.args).toEqual(['deployerOf', 'maxTierIdOf'].includes(request.functionName) ? [HOOK] : undefined)
    if (!(request.functionName in responses)) throw new Error(`Unexpected hook read: ${request.functionName}`)
    return responses[request.functionName]
  })
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe('canonical project NFT hook verification', () => {
  it('checks deployment provenance before trusting interface responses', async () => {
    const rpc = fixture({ deployerOf: OWNER })
    await expect(readVerifiedProject721Hook(rpc.client, input)).rejects.toThrow(/canonical stock deployment/)
    expect(rpc.readContract).toHaveBeenCalledTimes(1)
  })

  it('accepts both empty and nonempty canonical project-owned shops', async () => {
    for (const maxTierIdOf of [0n, 3n]) {
      const rpc = fixture({ maxTierIdOf })
      expect(await readVerifiedProject721Hook(rpc.client, input)).toEqual({ address: HOOK, verified: true, hasTiers: maxTierIdOf !== 0n })
    }
  })

  it('requires explicit direct ownership for a Revnet-owned hook', async () => {
    const rpc = fixture({ jbOwner: [OWNER, 0n, 0] })
    await expect(readVerifiedProject721Hook(rpc.client, input)).rejects.toThrow(/not scoped/)
    expect(await readVerifiedProject721Hook(rpc.client, { ...input, ownership: 'address' })).toMatchObject({ verified: true })
  })

  it.each([
    { jbOwner: [HOOK, 0n, 0] }, { jbOwner: [OWNER, 8n, 0] }, { owner: HOOK },
    { STORE: HOOK }, { DIRECTORY: HOOK }, { PROJECTS: HOOK }, { projectId: 8n },
  ])('rejects unrelated bindings even when deployed by the canonical factory (case %#)', async values => {
    await expect(readVerifiedProject721Hook(fixture({ jbOwner: [OWNER, 0n, 0], ...values }).client, { ...input, ownership: 'address' })).rejects.toThrow(/not scoped/)
  })

  it('accepts evidence only for the attached nonzero hook', () => {
    const verified = { address: HOOK, verified: true, hasTiers: true } as const
    expect(isVerifiedProject721Hook(verified, HOOK)).toBe(true)
    expect(isVerifiedProject721Hook(verified, OWNER)).toBe(false)
    expect(isVerifiedProject721Hook(undefined, HOOK)).toBe(false)
    expect(isVerifiedProject721Hook({ ...verified, address: zeroAddress }, zeroAddress)).toBe(false)
  })
})
