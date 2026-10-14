import { describe, expect, it, vi } from 'vitest'
import { proveLostLaunchWrite } from '@/lib/fund-launch-recovery'

describe('a lost launch write', () => {
  it('stays pending when only an effect shows it, so another sender’s deployment never releases the marker', async () => {
    const client = { getChainId: vi.fn(async () => 8453), getTransaction: vi.fn(), getTransactionCount: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), request: vi.fn() }
    const request = { chainId: 8453, address: '0x2222222222222222222222222222222222222222', abi: [{ type: 'function', name: 'go', inputs: [], outputs: [], stateMutability: 'nonpayable' }], functionName: 'go', args: [] } as never
    const found = await proveLostLaunchWrite(client as never, { request, sender: '0x1111111111111111111111111111111111111111', safe: false, attemptId: 'a' })
    expect(found.status).toBe('pending')
  })
})
