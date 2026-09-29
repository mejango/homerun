import './dialog-shim'
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
  idle: false,
  quote: undefined as unknown,
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: !!runtime.address }) }))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted++; return () => { runtime.unmounted++ } }, [])
    return runtime.idle
      ? { phase: 'idle', busy: false, error: null, hash: null, safeProposalHash: null, receipt: null, isSafe: false, send: vi.fn(), reset: vi.fn() }
      : { phase: 'pending', busy: true, error: null, hash: null, safeProposalHash: null, receipt: null, isSafe: false, send: vi.fn(), reset: vi.fn() }
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
    if (options.queryKey[1] === 'quote') return { data: runtime.quote, isError: false, isFetching: false }
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
beforeEach(() => {
  runtime.address = '0x1111111111111111111111111111111111111111'
  runtime.route = makeRoute(); runtime.routeAvailable = true; runtime.routeError = false; runtime.historyError = false
  runtime.mounted = 0; runtime.unmounted = 0; runtime.enabled = []
  runtime.idle = false; runtime.quote = undefined
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove() })

it('reads the route and mounts trackers as soon as the section renders', async () => {
  await render()
  expect(runtime.enabled.at(-1)).toBe(true)
  expect(runtime.mounted).toBe(6)
})
it('keeps submitted trackers through a wallet switch and disables incompatible new actions', async () => {
  await render()
  const mounted = runtime.mounted
  runtime.address = '0x9999999999999999999999999999999999999999'; runtime.routeAvailable = false
  await render()
  expect(runtime.mounted).toBe(mounted)
  expect(runtime.unmounted).toBe(0)
  expect(host.textContent).toContain('Submitted transactions stay tracked')
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
})
it('shows proof failure and the canonical project fallback without claim or relay controls', async () => {
  runtime.historyError = true
  await render()
  expect(host.textContent).toContain('Claims remain unavailable until the destination proof can be verified')
  expect([...host.querySelectorAll('button')].some(button => /Review destination claim|Review relay fee/.test(button.textContent ?? ''))).toBe(false)
  expect(host.querySelector<HTMLAnchorElement>('a[href="https://juicebox.money/base:17"]')).not.toBeNull()
})
it('keeps receipt tracking mounted when refreshed route verification fails', async () => {
  await render()
  const mounted = runtime.mounted
  runtime.routeAvailable = false; runtime.routeError = true
  await render()
  expect(runtime.mounted).toBe(mounted)
  expect(runtime.unmounted).toBe(0)
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
})

it('reviews a move in the confirm dialog, listing its approval before any prompt', async () => {
  runtime.idle = true
  const route = makeRoute()
  runtime.route = { ...route, canPrepare: true, prepareIssue: undefined, source: { ...route.source, erc20Balance: 10n * 10n ** 18n } } as unknown as FundBridgeRoute
  runtime.quote = { allowance: 0n, minTokensReclaimed: 5_000_000n, netReclaimAmount: 5_100_000n }
  await render()
  const input = [...host.querySelectorAll('label')].find(label => label.textContent?.startsWith('FUND to move'))!.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Review move')!.click())
  const dialog = host.querySelector('[data-tx-confirm]')!
  expect(dialog.textContent).toContain('Move FUND to Optimism')
  expect(dialog.textContent).toContain('2 FUND')
  expect(dialog.textContent).toContain('Backing at least5 USDC')
  expect([...dialog.querySelectorAll('li[data-state]')].map(step => step.textContent)).toEqual([
    expect.stringContaining('Approve FUND'), expect.stringContaining('Prepare the move'),
  ])
  expect([...dialog.querySelectorAll('button')].some(button => button.textContent === 'Approve FUND')).toBe(true)
})

