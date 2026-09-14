import { connect, createConfig, http, reconnect } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { describe, expect, it, vi } from 'vitest'
import { centerWalletConnector } from '@/providers/center-connector'
const address = '0x1111111111111111111111111111111111111111' as const
function fixture() {
  let active = true
  const wallet = { restoreConnection: vi.fn(() => active ? { address, chainId: 8453, accountId: 'eip155:8453:' + address, expiresAt: Math.floor(Date.now() / 1000) + 3600 } : null),
    disconnect: vi.fn(() => { active = false }) }
  const read = vi.fn(async () => '0x17')
  const config = createConfig({ chains: [base], connectors: [centerWalletConnector({ wallet: async () => wallet, read })],
    transports: { [base.id]: http() }, storage: null, multiInjectedProviderDiscovery: false })
  return { wallet, config, connector: config.connectors[0]!, read, expire: () => { active = false } }
}
describe('Center connection never supplies generic wallet signing authority', () => {
  it('restores only the completed Center connection and fixed Base Safe identity', async () => {
    const { config, connector, read, expire } = fixture()
    expect(await reconnect(config)).toHaveLength(1)
    expect(config.state.connections.get(connector.uid)?.accounts).toEqual([address])
    expect(config.state.connections.get(connector.uid)?.chainId).toBe(8453)
    expect(read).not.toHaveBeenCalled()
    expire(); expect(await connector.isAuthorized()).toBe(false); expect(await connector.getAccounts()).toEqual([])
  })
  it('supports configured read requests but refuses arbitrary signing, sending, permissions and other chains', async () => {
    const { config, connector, read } = fixture()
    await connect(config, { connector })
    const provider = await connector.getProvider() as { request(input: { method: string; params?: unknown[] }): Promise<unknown> }
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x2105')
    expect(await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] })).toBe('0x17')
    expect(read).toHaveBeenCalledOnce()
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_grantPermissions'])
      await expect(provider.request({ method, params: [] })).rejects.toMatchObject({ code: 4200 })
    await expect(connector.switchChain!({ chainId: 1 })).rejects.toMatchObject({ code: 4902 })
    expect(read).toHaveBeenCalledOnce()
  })
  it('disconnects the local Center key and does not reconnect a disconnected or incomplete tab', async () => {
    const { config, connector, wallet } = fixture()
    await connect(config, { connector }); await connector.disconnect()
    expect(wallet.disconnect).toHaveBeenCalledOnce()
    expect(await connector.isAuthorized()).toBe(false)
    await expect(connector.connect()).rejects.toThrow('Connect your Juicebox wallet')
  })
})
