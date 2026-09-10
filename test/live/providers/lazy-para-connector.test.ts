import { connect, createConfig, http, reconnect } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { describe, expect, it, vi } from 'vitest'
import { lazyParaConnector } from '@/providers/lazy-para-connector'

describe('lazyParaConnector', () => {
  it('keeps Para unloaded until wagmi uses the connector and initializes it once', async () => {
    const account = '0x0000000000000000000000000000000000000001' as const
    const provider = { request: vi.fn() }
    const setup = vi.fn(async () => {})
    const implementation = {
      id: 'para',
      name: 'Para',
      type: 'para',
      setup,
      connect: vi.fn(async () => ({ accounts: [account], chainId: mainnet.id })),
      disconnect: vi.fn(async () => {}),
      getAccounts: vi.fn(async () => [account]),
      getChainId: vi.fn(async () => mainnet.id),
      getProvider: vi.fn(async () => provider),
      isAuthorized: vi.fn(async () => true),
      switchChain: vi.fn(async () => mainnet),
      onAccountsChanged: vi.fn(),
      onChainChanged: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onMessage: vi.fn(),
    }
    const createParaWagmiConnector = vi.fn(
      () => () => implementation,
    )
    const load = vi.fn(async () => ({ createParaWagmiConnector }))
    const config = createConfig({
      chains: [mainnet],
      connectors: [
        lazyParaConnector({
          load: load as never,
          shouldRestore: () => true,
        }),
      ],
      transports: { [mainnet.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    })
    const [connector] = config.connectors

    expect(connector?.id).toBe('para')
    expect(load).not.toHaveBeenCalled()

    await connector?.getProvider()
    await connector?.getProvider()

    expect(load).toHaveBeenCalledOnce()
    expect(createParaWagmiConnector).toHaveBeenCalledOnce()
    expect(setup).toHaveBeenCalledOnce()

    await connect(config, { connector: connector! })

    expect(implementation.connect).toHaveBeenCalledOnce()
    expect(config.state.status).toBe('connected')
    expect(config.state.current).toBe(connector?.uid)
  })

  it('lets wagmi reconnect anonymous wallets without loading Para', async () => {
    const load = vi.fn()
    const config = createConfig({
      chains: [mainnet],
      connectors: [
        lazyParaConnector({
          load: load as never,
          shouldRestore: () => false,
        }),
      ],
      transports: { [mainnet.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    })

    await expect(reconnect(config)).resolves.toEqual([])

    expect(load).not.toHaveBeenCalled()
    expect(config.state.status).toBe('disconnected')
  })

  it('loads and restores Para when the reconnect marker is present', async () => {
    const account = '0x0000000000000000000000000000000000000001' as const
    const provider = { request: vi.fn() }
    const implementation = {
      id: 'para',
      name: 'Para',
      type: 'para',
      setup: vi.fn(async () => {}),
      connect: vi.fn(async () => ({ accounts: [account], chainId: mainnet.id })),
      disconnect: vi.fn(async () => {}),
      getAccounts: vi.fn(async () => [account]),
      getChainId: vi.fn(async () => mainnet.id),
      getProvider: vi.fn(async () => provider),
      isAuthorized: vi.fn(async () => true),
      switchChain: vi.fn(async () => mainnet),
      onAccountsChanged: vi.fn(),
      onChainChanged: vi.fn(),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onMessage: vi.fn(),
    }
    const load = vi.fn(async () => ({
      createParaWagmiConnector: vi.fn(() => () => implementation),
    }))
    const config = createConfig({
      chains: [mainnet],
      connectors: [
        lazyParaConnector({
          load: load as never,
          shouldRestore: () => true,
        }),
      ],
      transports: { [mainnet.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    })

    const connections = await reconnect(config)

    expect(load).toHaveBeenCalledOnce()
    expect(implementation.isAuthorized).toHaveBeenCalledOnce()
    expect(implementation.connect).toHaveBeenCalledWith({
      isReconnecting: true,
    })
    expect(connections).toHaveLength(1)
    expect(config.state.status).toBe('connected')
  })
})
