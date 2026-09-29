import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({ read: vi.fn(), assert: vi.fn() }))
vi.mock('../src/lib/fund-state', () => ({ readFundProjectState: runtime.read, assertFundStateForWrite: runtime.assert }))
import { readFundPayNetwork } from '../src/lib/fund-pay-networks'

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

describe('verifying a picked FUND payment chain', () => {
  const read = (overrides: Record<string, unknown> = {}) => readFundPayNetwork(() => client(overrides), source, 8453)

  it('uses the remote contract project ID rather than the source ID', async () => {
    runtime.read.mockResolvedValue(destination)
    const state = await read()
    expect([state.chainId, state.projectId]).toEqual([8453, 42n])
  })

  it('rejects a peer that has not launched yet', async () => {
    await expect(read({ projectId: 0n })).rejects.toThrow('incomplete')
  })

  it('rejects a chain the source has no registered bridge to', async () => {
    await expect(readFundPayNetwork(() => client(), source, 10)).rejects.toThrow('Unsupported payment chain')
  })

  it('rejects a project without a reciprocal registered bridge', async () => {
    runtime.read.mockResolvedValue({ ...destination, linkedPeers: [] })
    await expect(read()).rejects.toThrow('Unverified peer project')
  })

  it('rejects an incorrect peer chain even if metadata or IDs match', async () => {
    runtime.read.mockResolvedValue(destination)
    await expect(read({ peerChainId: 10n })).rejects.toThrow('Unverified peer project')
  })

  it('rejects a peer whose block was reorganized', async () => {
    runtime.read.mockResolvedValue({ ...destination, blockHash: '0xdef' })
    await expect(read()).rejects.toThrow('Unverified peer project')
  })
})
