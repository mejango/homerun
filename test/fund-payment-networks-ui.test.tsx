import { act, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({ projects: [] as FundProjectState[] }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: { projects: runtime.projects, unavailable: 0 }, refetch: vi.fn() }) }))
vi.mock('wagmi', () => ({ usePublicClient: ({ chainId }: { chainId: number }) => ({ chainId }) }))
import { FundPaymentNetworks } from '../src/components/FundPaymentNetworks'

function Payment({ state, selector, busy, onBusy }: { state: FundProjectState; selector: ReactNode; busy: boolean; onBusy: (value: boolean) => void }) {
  useEffect(() => onBusy(busy), [busy, onBusy])
  return <>{selector}<p data-project>{state.chainId}:{state.projectId.toString()}</p></>
}

describe('FUND payment chain selection', () => {
  it('chooses the remote project and locks selection while a transaction is tracked', async () => {
    const source = { chainId: 1, projectId: 7n, blockNumber: 100n, metadata: { pausePay: false } } as FundProjectState
    const remote = { ...source, chainId: 8453, projectId: 42n } as FundProjectState
    runtime.projects = [source, remote]
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const render = async (busy = false) => act(async () => root.render(<FundPaymentNetworks state={source}>{(state, _client, selector, onBusy) => <Payment state={state} selector={selector} onBusy={onBusy} busy={busy} />}</FundPaymentNetworks>))
    try {
      await render()
      const select = host.querySelector('select')!
      expect([...select.options].map(option => option.text)).toEqual(['Ethereum', 'Base'])
      await act(async () => { select.value = '8453'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(host.querySelector('[data-project]')?.textContent).toBe('8453:42')
      await render(true)
      expect(host.querySelector('select')?.disabled).toBe(true)
      await render(false)
      expect(host.querySelector('select')?.disabled).toBe(false)
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
