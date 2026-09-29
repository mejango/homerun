import { act, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({ remote: undefined as FundProjectState | undefined, error: false, keys: [] as unknown[][] }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled: boolean }) => {
    if (enabled) runtime.keys.push(queryKey)
    return { data: enabled && !runtime.error ? runtime.remote : undefined, isError: enabled && runtime.error, refetch: vi.fn() }
  },
}))
vi.mock('wagmi', () => ({ usePublicClient: ({ chainId }: { chainId: number }) => ({ chainId }) }))
import { FundPaymentNetworks } from '../src/components/FundPaymentNetworks'

function Payment({ state, selector, busy, onBusy }: { state: FundProjectState; selector: ReactNode; busy: boolean; onBusy: (value: boolean) => void }) {
  useEffect(() => onBusy(busy), [busy, onBusy])
  return <>{selector}<p data-project>{state.chainId}:{state.projectId.toString()}</p></>
}

const source = { chainId: 1, projectId: 7n, blockNumber: 100n, metadata: { pausePay: false }, linkedPeers: [{ chainId: 8453 }, { chainId: 42161 }] } as FundProjectState

async function mount(run: (host: HTMLElement, render: (busy?: boolean) => Promise<void>) => Promise<void>) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const render = async (busy = false) => act(async () => root.render(<FundPaymentNetworks state={source}>{(state, _client, selector, onBusy) => <Payment state={state} selector={selector} onBusy={onBusy} busy={busy} />}</FundPaymentNetworks>))
  try { await render(); await run(host, render) } finally { await act(async () => root.unmount()); host.remove() }
}
const pick = async (host: HTMLElement, chainId: string) => act(async () => { const select = host.querySelector('select')!; select.value = chainId; select.dispatchEvent(new Event('change', { bubbles: true })) })

describe('FUND payment chain selection', () => {
  it('lists every linked chain before reading any of them, then reads only the picked one', async () => {
    runtime.remote = { ...source, chainId: 8453, projectId: 42n } as FundProjectState; runtime.error = false; runtime.keys = []
    await mount(async (host, render) => {
      expect([...host.querySelector('select')!.options].map(option => option.text)).toEqual(['Ethereum', 'Base', 'Arbitrum'])
      expect(runtime.keys).toEqual([])
      await pick(host, '8453')
      expect(runtime.keys.every(key => key[3] === 8453)).toBe(true)
      expect(host.querySelector('[data-project]')?.textContent).toBe('8453:42')
      await render(true)
      expect(host.querySelector('select')?.disabled).toBe(true)
      await render(false)
      expect(host.querySelector('select')?.disabled).toBe(false)
    })
  })

  it('keeps the chain list and says so when a picked chain cannot take payments yet', async () => {
    runtime.error = true
    await mount(async host => {
      await pick(host, '42161')
      expect(host.textContent).toContain('isn’t ready for payments on Arbitrum yet')
      expect(host.querySelector('[data-project]')).toBeNull()
      expect(host.querySelectorAll('select option')).toHaveLength(3)
    })
  })
})
