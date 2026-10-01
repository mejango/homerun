import { createPublicClient, custom, encodeFunctionData, erc20Abi, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { buildErc20ApproveRequest } from '../src/lib/transaction-builders'

const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address
const SPENDER = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address

describe('ERC-20 approvals', () => {
  it('approves a token whose approve returns nothing, such as USDT, with erc20Abi’s calldata', async () => {
    const request = buildErc20ApproveRequest({ chainId: 1, token: TOKEN, spender: SPENDER, amount: 123_456n })
    expect(encodeFunctionData(request)).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 123_456n] }))
    expect(request.abi[0].outputs).toEqual([])

    // A USDT-style token: a successful approve() whose call returns no data.
    const client = createPublicClient({
      chain: mainnet,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_call') return '0x'
          throw new Error(`Unexpected ${method}`)
        },
      }),
    })
    const approval = { address: request.address, functionName: request.functionName, args: request.args, account: ALICE }
    await expect(client.simulateContract({ ...approval, abi: request.abi })).resolves.toMatchObject({ request: { functionName: 'approve' } })
    // A declared bool output cannot be decoded from that empty return.
    await expect(client.simulateContract({ ...approval, abi: erc20Abi })).rejects.toThrow(/returned no data/)
  })
})
