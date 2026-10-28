import { hexToString, toHex, type Address, type Hex } from 'viem'

type Fake = {
  chain?: { id: number }
  sendTransaction?: (request: { account: Address; chain: { id: number }; to: Address; data: Hex; value?: bigint; gas?: bigint }) => Promise<Hex>
  signMessage?: (request: { account: Address; message: string }) => Promise<Hex>
  signTypedData?: (request: { domain?: { chainId?: number | bigint } } & Record<string, unknown>) => Promise<Hex>
  /** A failure the wallet's chain read answers with, before anything is sent. */
  chainRead?: () => Error | null | undefined
}

/**
 * A test's fake wallet client as the provider requests the adapter's client dispatches: viem turns
 * each wallet call into an RPC request, and this answers it with the fake's matching method.
 */
export function providerClient(fake: Fake) {
  const chain = () => fake.chain ?? { id: 1 }
  return {
    get chain() { return fake.chain },
    account: undefined,
    // One provider, as a wallet connector's client is: core refuses a composite transport.
    transport: { type: 'custom' },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') {
        const failure = fake.chainRead?.()
        if (failure) throw failure
        return toHex(chain().id)
      }
      if (method === 'eth_sendTransaction') {
        const [tx] = params as [{ from: Address; to: Address; data: Hex; value?: Hex; gas?: Hex }]
        return fake.sendTransaction!({ account: tx.from, chain: chain(), to: tx.to, data: tx.data,
          ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }), ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }) })
      }
      if (method === 'personal_sign') {
        const [message, account] = params as [Hex, Address]
        return fake.signMessage!({ account, message: hexToString(message) })
      }
      if (method === 'eth_signTypedData_v4') return fake.signTypedData!(JSON.parse((params as [Address, string])[1]))
      throw new Error(`Unexpected wallet request ${method}`)
    },
  }
}
