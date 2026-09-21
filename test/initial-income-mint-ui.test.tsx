import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { InitialIncomeAllocationState } from '../src/lib/income-initial-allocation'
import type { TxSendOptions } from '../src/hooks/useSafeTx'

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address | undefined,
  allocation: {} as Record<string, unknown>,
  send: vi.fn(), read: vi.fn(), invalidateQueries: vi.fn(),
  phase: 'idle', busy: false, error: null as string | null, hash: null as Hex | null, safeProposalHash: null as Hex | null, receipt: null as { transactionHash: Hex } | null,
  mounted: 0, unmounted: 0, keys: [] as unknown[][],
}))
const OWNER = '0x2222222222222222222222222222222222222222' as Address
const HELPER = '0x3333333333333333333333333333333333333333' as Address
const units = 10n ** 18n
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isConnected: !!runtime.address }) }))
vi.mock('@/lib/income-initial-allocation', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/income-initial-allocation')>(), readInitialIncomeAllocation: runtime.read }))
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: (value: unknown) => value,
  useQueryClient: () => ({ invalidateQueries: runtime.invalidateQueries }),
  useQuery: (options: { queryKey: unknown[] }) => { runtime.keys.push(options.queryKey); return runtime.allocation },
}))
vi.mock('@/hooks/useSafeTx', () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string; pending: string }) => _phase === 'pending' ? labels.pending : labels.idle,
  useSafeTx: () => {
    useEffect(() => { runtime.mounted++; return () => { runtime.unmounted++ } }, [])
    return { phase: runtime.phase, busy: runtime.busy, error: runtime.error, hash: runtime.hash, safeProposalHash: runtime.safeProposalHash, receipt: runtime.receipt, send: runtime.send }
  },
}))
import { InitialIncomeMint } from '../src/components/InitialIncomeMint'

function allocation(changes: Partial<InitialIncomeAllocationState> = {}): InitialIncomeAllocationState {
  return { chainId: 8453, incomeProjectId: 8n, fundProjectId: 7n, deployer: HELPER, owner: OWNER, blockNumber: 150n, blockHash: `0x${'d'.repeat(64)}`, blockTimestamp: 15_000n, stageId: 12_000n, stageStart: 12_000n, started: true, pending: 250_000n * units, ...changes }
}

describe('initial INCOME mint to the FUND owner', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    runtime.address = '0x1111111111111111111111111111111111111111'; runtime.phase = 'idle'; runtime.busy = false; runtime.error = null; runtime.hash = null; runtime.safeProposalHash = null; runtime.receipt = null
    runtime.mounted = 0; runtime.unmounted = 0; runtime.keys = []
    runtime.allocation = { data: allocation(), isPending: false, isError: false, isPlaceholderData: false }
    runtime.send.mockReset().mockResolvedValue(null); runtime.read.mockReset().mockImplementation(async () => allocation()); runtime.invalidateQueries.mockReset()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function render(manifestUri: string | null = 'ipfs://bafymanifest') { await act(async () => root.render(<InitialIncomeMint chainId={8453} fundProjectId={7n} incomeProjectId={8n} manifestUri={manifestUri} />)) }
  function button() { return [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith('Mint'))! }

  it('shows the pending allocation, the current FUND owner, the published manifest and an enabled mint', async () => {
    await render()
    expect(host.textContent).toContain('250000 INCOME'); expect(host.textContent).toContain(OWNER)
    expect(host.textContent).toContain('settles it to the snapshot holders per the published allocation')
    expect(host.querySelector('a[href="https://juicebox.center/ipfs/bafymanifest"]')?.textContent).toBe('View the published allocation')
    expect(host.textContent).toContain('Anyone can mint this allocation to whoever owns the FUND')
    expect(button().disabled).toBe(false)
    expect(runtime.keys).toContainEqual(['initial-income-allocation', 8453, '7', '8'])
  })

  it('sends the permissionless helper mint through the shared reviewed flow and reverifies the same pending amount and recipient', async () => {
    await render(); await act(async () => button().click())
    expect(runtime.send).toHaveBeenCalledOnce()
    const [request, options] = runtime.send.mock.calls[0] as [{ address: Address; functionName: string; args: readonly unknown[]; label: string }, TxSendOptions]
    expect(request.address).toBe(HELPER); expect(request.functionName).toBe('mintInitialAllocation'); expect(request.args).toEqual([7n])
    expect(request.label).toContain(`250000 initial INCOME to the FUND owner ${OWNER}`)
    expect(options.reviewNotice).toContain('tokens never go to the sender')
    await expect(options.reverify!(request as never)).resolves.toBeUndefined()
    runtime.read.mockResolvedValueOnce(allocation({ pending: 0n }))
    await expect(options.reverify!(request as never)).rejects.toThrow('already minted')
    runtime.read.mockResolvedValueOnce(allocation({ started: false }))
    await expect(options.reverify!(request as never)).rejects.toThrow('already minted or its stage has not started')
    runtime.read.mockResolvedValueOnce(allocation({ owner: HELPER }))
    await expect(options.reverify!(request as never)).rejects.toThrow('FUND owner changed')
  })

  it('disables minting before the stage starts and once the allocation is minted', async () => {
    runtime.allocation = { data: allocation({ started: false, stageStart: 4_102_444_800n }), isPending: false, isError: false, isPlaceholderData: false }
    await render(null)
    expect(button().disabled).toBe(true); expect(host.textContent).toContain('Mints once the shared stage starts'); expect(host.querySelector('a[target="_blank"]')).toBeNull()
    runtime.allocation = { data: allocation({ pending: 0n }), isPending: false, isError: false, isPlaceholderData: false }
    await render(null)
    expect(button().disabled).toBe(true); expect(host.textContent).toContain('Minted'); expect(host.textContent).toContain('Nothing is left to mint')
    await act(async () => button().click()); expect(runtime.send).not.toHaveBeenCalled()
  })

  it('waits for the verified allocation and surfaces read failures without a mint button', async () => {
    runtime.allocation = { data: undefined, isPending: true, isError: false }
    await render()
    expect(host.textContent).toContain('Verifying the initial allocation'); expect(host.querySelector('button')).toBeNull()
    runtime.allocation = { data: undefined, isPending: false, isError: true, error: new Error('Initial allocation RPC unavailable') }
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Initial allocation RPC unavailable'); expect(host.querySelector('button')).toBeNull()
  })

  it('reports the receipt and refreshes the allocation and INCOME reads after confirmation', async () => {
    runtime.phase = 'success'; runtime.hash = `0x${'a'.repeat(64)}`; runtime.receipt = { transactionHash: `0x${'a'.repeat(64)}` }
    await render()
    expect(host.textContent).toContain('Initial INCOME minted to the FUND owner')
    expect(runtime.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['initial-income-allocation', 8453, '7', '8'] })
    expect(runtime.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['income-project', 8453, '8'] })
    expect(runtime.mounted).toBe(1); expect(runtime.unmounted).toBe(0)
  })
})
