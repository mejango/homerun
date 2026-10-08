import { dehydrate, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectSeed } from '@/lib/project-seed'

const pending = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({}) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/bendystraw', async original => ({ ...await original<typeof import('@/lib/bendystraw')>(), getProject: pending, getSuckerGroupProjects: pending, getProjectActivity: pending, getProjectActivityByProject: pending }))
vi.mock('@/lib/project-participants', async original => ({ ...await original<typeof import('@/lib/project-participants')>(), getProjectHolders: pending }))
vi.mock('@/lib/project-shop', async original => ({ ...await original<typeof import('@/lib/project-shop')>(), readProjectShop: pending }))
vi.mock('@/lib/income-fund-binding', () => ({ readIncomeFundBinding: pending }))
vi.mock('@/lib/income-launch', () => ({ readIncomeLaunchBinding: pending }))
vi.mock('@/lib/fund-state', () => ({ readFundProjectState: pending, readFundAccountState: pending }))
vi.mock('@/lib/fund-project-metadata', async original => ({ ...await original<typeof import('@/lib/fund-project-metadata')>(), fetchFundProjectMetadata: pending }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({}), txPhaseLabel: () => '' }))
vi.mock('@/components/DeployRemainingChains', () => ({ DeployRemainingChains: () => null }))
vi.mock('@/components/live-transactions', () => ({}))
vi.mock('@/components/HomerunProjectLayout', () => ({ HomerunProjectLayout: ({ title, logo, metadata }: { title: ReactNode; logo: ReactNode; metadata: ReactNode }) => <main><h1>{title}</h1>{logo}{metadata}</main>, OwnersTabs: () => null }))
vi.mock('@/components/ProjectShopManagement', () => ({ ProjectShopManagement: ({ children }: { children: (value: object) => ReactNode }) => children({}) }))
vi.mock('@/components/FundProject', () => ({ FundProject: () => <p>FUND page</p> }))
vi.mock('@/components/IncomeProject', () => ({ IncomeProject: () => <p>INCOME page</p>, IncomeProjectRuntime: ({ children }: { children: (slots: object) => ReactNode }) => children({}) }))
vi.mock('@/components/ProjectPage', () => ({ ProjectPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>, ProjectOverviewView: () => null, ProjectPhoto: () => null, DemoStageHistory: () => null, ProjectRaiseStats: () => null }))

import { ProjectActivity } from '@/components/ProjectActivity'
import { ProjectAddress } from '@/components/ProjectAddress'
import { ProjectParticipants } from '@/components/ProjectParticipants'
import { ProjectShop } from '@/components/ProjectShop'
import { installQueryPersistence, PERSIST, serializeState } from '@/lib/query-persist'

const cleanups: (() => void)[] = []
const clients: QueryClient[] = []
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function client() {
  const result = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  clients.push(result)
  return result
}

async function hydrateAfterRestore(content: ReactNode, entries: [QueryKey, unknown][], serverText: string, restoredText: string) {
  const server = client()
  const saved = client()
  for (const [queryKey, data] of entries) {
    saved.setQueryDefaults(queryKey, { meta: PERSIST })
    saved.setQueryData(queryKey, data)
  }
  let stored = serializeState(dehydrate(saved))
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value }, removeItem: () => { stored = '' } } as Storage
  const browser = client()
  const firstCommit: string[] = []
  function Boundary({ children }: { children: ReactNode }) {
    useLayoutEffect(() => { firstCommit.push(host!.textContent!) }, [])
    return <div data-boundary>{children}</div>
  }
  host = document.createElement('div')
  host.innerHTML = renderToString(<QueryClientProvider client={server}><Boundary>{content}</Boundary></QueryClientProvider>)
  document.body.append(host)
  expect(host.textContent).toContain(serverText)
  const original = host.firstElementChild
  // The provider has already restored at window.load; this child boundary hydrates later.
  cleanups.push(installQueryPersistence(browser, storage))
  for (const [queryKey, data] of entries) expect(browser.getQueryData(queryKey)).toEqual(data)
  const errors: unknown[] = []
  await act(async () => {
    root = hydrateRoot(host!, <QueryClientProvider client={browser}><Boundary>{content}</Boundary></QueryClientProvider>, { onRecoverableError: error => errors.push(error) })
  })
  expect(errors).toEqual([])
  expect(host.firstElementChild).toBe(original)
  expect(firstCommit[0]).toContain(serverText)
  expect(host.textContent).toContain(restoredText)
}

it('hydrates a delayed shop as pending, then displays the restored empty shop while its read is pending', async () => {
  await hydrateAfterRestore(<ProjectShop chainId={1} projectId={7n} />, [[['project-shop', 1, '7'], null]], 'Reading the project’s shop…', 'No items yet')
})

it('hydrates delayed activity with the server loading state before the restored successful page', async () => {
  await hydrateAfterRestore(<ProjectActivity chainId={1} projectId={7} />, [[['project-activity', 1, 7, null], { items: [], totalCount: 0 }]], 'Loading activity', 'No activity yet.')
})

it('hydrates delayed participants before displaying persisted holders', async () => {
  await hydrateAfterRestore(<ProjectParticipants chainId={1} projectId={7} />, [
    [['indexed-project', 1, 7], null],
    [['project-participants', 1, 7, '1:7'], { holders: [], complete: true }],
  ], 'Loading FUND holders…', 'No one holds FUND yet.')
})

it('preserves the server INCOME seed and null binding when the restored row says FUND', async () => {
  const seed = { indexed: { chainId: 1, projectId: 7, version: 6, isRevnet: true }, details: null } as ProjectSeed
  await hydrateAfterRestore(<ProjectAddress chainId={1} projectId="7" seed={seed} incomeFund={null} />, [
    [['indexed-project', 1, 7], { ...seed.indexed, isRevnet: false }],
  ], 'INCOME page', 'FUND page')
})

it('preserves a seeded null INCOME binding before exposing the restored binding', async () => {
  const seed = { indexed: { chainId: 1, projectId: 7, version: 6, isRevnet: true }, details: null } as ProjectSeed
  await hydrateAfterRestore(<ProjectAddress chainId={1} projectId="7" seed={seed} incomeFund={null} />, [
    [['income-fund-binding', 1, '7'], 8n],
  ], 'INCOME page', 'Opening this project…')
})

it('preserves the FUND server metadata before showing a restored project URI', async () => {
  const { FundProject } = await vi.importActual<typeof import('@/components/FundProject')>('@/components/FundProject')
  const { parseFundProjectMetadata } = await import('@/lib/fund-project-metadata')
  const seed = { indexed: { chainId: 1, projectId: 7, version: 6, isRevnet: false, metadataUri: 'ipfs://server', decimals: 6, balance: '0' }, details: parseFundProjectMetadata({ name: 'Server house' }) } as ProjectSeed
  await hydrateAfterRestore(<FundProject chainId={1} projectId="7" seed={seed} />, [
    [['indexed-project', 1, 7], { ...seed.indexed, metadataUri: 'ipfs://restored' }],
    [['fund-project-metadata', 'ipfs://restored'], parseFundProjectMetadata({ name: 'Restored house' })],
  ], 'Server house', 'Restored house')
})

it('shows kept data on the first commit of a later client navigation', async () => {
  const browser = client()
  browser.setQueryData(['project-shop', 1, '7'], null)
  let firstCommit: string | undefined
  function Navigation() {
    useLayoutEffect(() => { firstCommit = host!.textContent! }, [])
    return <ProjectShop chainId={1} projectId={7n} />
  }
  host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={browser}><Navigation /></QueryClientProvider>)
  })
  expect(firstCommit).toContain('No items yet')
  expect(firstCommit).not.toContain('Reading the project’s shop…')
})
