import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({ read: vi.fn(), assert: vi.fn() }))
vi.mock('../src/lib/fund-state', () => ({ readFundProjectState: runtime.read, assertFundStateForWrite: runtime.assert }))
import { readFundPayNetworks } from '../src/lib/fund-pay-networks'

const local = `0x${'11'.repeat(20)}` as Address
const remote = `0x${'22'.repeat(20)}` as Address
const source = { chainId: 1, projectId: 7n, linkedPeers: [{ chainId: 8453, localSuckerAddress: local, suckerAddress: remote }] } as FundProjectState
const destination = { chainId: 8453, projectId: 42n, blockNumber: 100n, blockHash: '0xabc', accountingContexts: [{}], linkedPeers: [{ chainId: 1, localSuckerAddress: remote, suckerAddress: local }] } as FundProjectState
function client(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 8453,
    getBlock: async () => ({ hash: '0xabc' }),
    readContract: async ({ functionName }: { functionName: string }) => ({ projectId: 42n, peerChainId: 1n, peer: `0x${local.slice(2).padStart(64, '0')}`, ...overrides })[functionName],
  } as unknown as PublicClient
}

describe('available FUND payment networks', () => {
  it('uses the remote contract project ID rather than the source ID', async () => {
    runtime.read.mockResolvedValue(destination)
    const result = await readFundPayNetworks(() => client(), source)
    expect(result.projects.map(project => [project.chainId, project.projectId])).toEqual([[1, 7n], [8453, 42n]])
    expect(result.unavailable).toBe(0)
  })

  it('keeps the local project payable while a peer has not launched', async () => {
    const result = await readFundPayNetworks(() => client({ projectId: 0n }), source)
    expect(result.projects).toEqual([source])
    expect(result.unavailable).toBe(1)
  })

  it('excludes a project without a reciprocal registered bridge', async () => {
    runtime.read.mockResolvedValue({ ...destination, linkedPeers: [] })
    expect((await readFundPayNetworks(() => client(), source)).projects).toEqual([source])
  })

  it('excludes an incorrect peer chain even if metadata or IDs match', async () => {
    runtime.read.mockResolvedValue(destination)
    expect((await readFundPayNetworks(() => client({ peerChainId: 10n }), source)).projects).toEqual([source])
  })

  it('excludes a peer whose block was reorganized', async () => {
    runtime.read.mockResolvedValue({ ...destination, blockHash: '0xdef' })
    expect((await readFundPayNetworks(() => client(), source)).projects).toEqual([source])
  })
})
