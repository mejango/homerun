import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { FundBridgeRoute } from '../src/lib/fund-bridge'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address | undefined,
  route: null as FundBridgeRoute | null,
  routeAvailable: true,
  routeError: false,
  historyError: false,
  mounted: 0, unmounted: 0,
  enabled: [] as boolean[],
  cache: { invalidateQueries: vi.fn() },
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: !!runtime.address }) }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted++; return () => { runtime.unmounted++ } }, [])
    return { phase: 'pending', busy: true, error: null, hash: null, safeProposalHash: null, receipt: null, isSafe: false, send: vi.fn(), reset: vi.fn() }
  },
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => runtime.cache,
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[1] === 'route') {
      runtime.enabled.push(!!options.enabled)
      return { data: options.enabled && runtime.routeAvailable ? runtime.route : undefined, isError: runtime.routeError, isFetching: false, error: new Error('Route unavailable'), refetch: vi.fn() }
    }
    if (options.queryKey[1] === 'movements') return { data: runtime.historyError ? undefined : { route: runtime.route, movements: [] }, isError: runtime.historyError, error: new Error('Missing destination root proof'), isPending: false, isFetching: false, refetch: vi.fn() }
    return { data: undefined, isError: false, isFetching: false }
  },
}))

import { FundBridgeActions } from '../src/components/FundBridgeActions'

let host: HTMLDivElement
let root: Root
function makeRoute(): FundBridgeRoute {
  const source = { chainId: 8453, projectId: 17n, account: runtime.address, blockNumber: 10n, creditBalance: 5n, erc20Balance: 0n, linkedPeers: [{ chainId: 10 }] }
  const destination = { ...source, chainId: 10, projectId: 9n }
  return { source, destination, sourceSucker: '0x2222222222222222222222222222222222222222', destinationSucker: '0x3333333333333333333333333333333333333333', sourceToken: '0x4444444444444444444444444444444444444444', destinationToken: '0x5555555555555555555555555555555555555555', sourceContext: { symbol: 'USDC', decimals: 6 }, destinationContext: { symbol: 'USDC', decimals: 6 }, canPrepare: false, prepareIssue: 'Claim FUND credits as ERC20 tokens before bridging.', transport: 'ccip', baseFee: 1n } as unknown as FundBridgeRoute
}
async function render() { await act(async () => { root.render(<FundBridgeActions state={runtime.route!.source} />) }) }
async function expand() { await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click() }) }
beforeEach(() => {
  runtime.address = '0x1111111111111111111111111111111111111111'
  runtime.route = makeRoute(); runtime.routeAvailable = true; runtime.routeError = false; runtime.historyError = false
  runtime.mounted = 0; runtime.unmounted = 0; runtime.enabled = []
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

it('defers bridge reads until expanded and preserves pending trackers when collapsed', async () => {
  await render()
  expect(runtime.enabled.every(value => !value)).toBe(true)
  expect(runtime.mounted).toBe(0)
  await expand()
  expect(runtime.enabled.at(-1)).toBe(true)
  expect(runtime.mounted).toBe(6)
  await expand()
  expect(runtime.unmounted).toBe(0)
  expect(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
})
it('keeps submitted trackers through a wallet switch and disables incompatible new actions', async () => {
  await render(); await expand()
  const mounted = runtime.mounted
  runtime.address = '0x9999999999999999999999999999999999999999'; runtime.routeAvailable = false
  await render()
  expect(runtime.mounted).toBe(mounted)
  expect(runtime.unmounted).toBe(0)
  expect(host.textContent).toContain('Submitted transactions remain tracked')
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
})
it('shows proof failure and the canonical project fallback without claim or relay controls', async () => {
  runtime.historyError = true
  await render(); await expand()
  expect(host.textContent).toContain('Claims remain unavailable until the destination proof can be verified')
  expect([...host.querySelectorAll('button')].some(button => /Review destination claim|Review relay fee/.test(button.textContent ?? ''))).toBe(false)
  expect(host.querySelector<HTMLAnchorElement>('a[href="https://juicebox.money/base:17"]')).not.toBeNull()
})
it('keeps receipt tracking mounted when refreshed route verification fails', async () => {
  await render(); await expand()
  const mounted = runtime.mounted
  runtime.routeAvailable = false; runtime.routeError = true
  await render()
  expect(runtime.mounted).toBe(mounted)
  expect(runtime.unmounted).toBe(0)
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
})
