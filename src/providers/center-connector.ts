'use client'
import { createConnector, type CreateConnectorFn } from 'wagmi'
import { base } from 'wagmi/chains'
import type { Address } from 'viem'
type Wallet = {
  restoreConnection(): { address: Address; chainId: 8453; accountId: string; expiresAt: number } | null
  disconnect(): void
}
const reads = new Set(['eth_call', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_blockNumber', 'eth_getLogs'])
const unsupported = (chain = false) => Object.assign(new Error(chain
  ? 'This Juicebox wallet uses Base. Connect an external wallet for other networks.'
  : 'This action requires its own wallet review. Use Juicebox payment review, or connect an external wallet.'), { code: chain ? 4902 : 4200 })

/** The API request key cannot sign or send arbitrary wallet operations. Supported Center
 * payments use the separate exact-plan review workflow, outside this read-only provider. */
export function centerWalletConnector(options: {
  wallet(): Promise<Wallet>
  read(input: { method: string; params?: unknown[] }): Promise<unknown>
}): CreateConnectorFn {
  return createConnector(config => {
    const connection = async () => {
      const value = (await options.wallet()).restoreConnection()
      if (!value || value.chainId !== 8453 || value.accountId !== 'eip155:8453:' + value.address.toLowerCase() ||
        value.expiresAt <= Math.floor(Date.now() / 1000)) return null
      return value
    }
    const provider = { async request(input: { method: string; params?: unknown[] }) {
      const current = await connection()
      if (input.method === 'eth_chainId') return '0x2105'
      if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return current ? [current.address] : []
      if (input.method === 'wallet_switchEthereumChain') {
        if ((input.params?.[0] as { chainId?: string } | undefined)?.chainId !== '0x2105') throw unsupported(true)
        return null
      }
      if (reads.has(input.method)) return options.read(input)
      throw unsupported()
    } }
    return {
      id: 'juicebox-center', name: 'Juicebox wallet', type: 'juicebox-center',
      async connect(parameters) {
        if (parameters?.chainId !== undefined && parameters.chainId !== 8453) throw unsupported(true)
        const current = await connection()
        if (!current) throw new Error('Connect your Juicebox wallet from the sign-in menu.')
        return { accounts: parameters?.withCapabilities ? [{ address: current.address, capabilities: {} }] : [current.address], chainId: 8453 } as never
      },
      async disconnect() { (await options.wallet()).disconnect() },
      async getAccounts() { const current = await connection(); return current ? [current.address] : [] },
      async getChainId() { return 8453 },
      async getProvider() { return provider },
      async isAuthorized() { return !!await connection() },
      async switchChain({ chainId }) { if (chainId !== 8453) throw unsupported(true); config.emitter.emit('change', { chainId }); return base },
      onAccountsChanged(accounts) { if (!accounts.length) config.emitter.emit('disconnect'); else config.emitter.emit('change', { accounts: accounts as Address[] }) },
      onChainChanged(chainId) { if (Number(chainId) !== 8453) config.emitter.emit('disconnect') },
      onDisconnect() { config.emitter.emit('disconnect') },
    }
  })
}
