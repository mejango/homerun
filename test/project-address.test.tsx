import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ project: vi.fn(), binding: vi.fn(), replace: vi.fn() }))
vi.mock('@/lib/bendystraw', () => ({ getProject: mocks.project }))
vi.mock('@/lib/income-fund-binding', () => ({ readIncomeFundBinding: mocks.binding }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/components/FundProject', () => ({ FundProject: ({ projectId }: { projectId: string }) => <p>FUND page {projectId}</p> }))
vi.mock('@/components/IncomeProject', () => ({ IncomeProject: ({ projectId }: { projectId: bigint }) => <p>INCOME page {projectId.toString()}</p> }))
vi.mock('@/components/ProjectPage', () => ({ ProjectPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

import { ProjectAddress } from '../src/components/ProjectAddress'

const row = (projectId: number, isRevnet: boolean | null) => ({ chainId: 1, projectId, version: 6, isRevnet })

describe('one address per project', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks() })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  async function render(projectId: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => root.render(<QueryClientProvider client={client}><ProjectAddress chainId={1} projectId={projectId} /></QueryClientProvider>))
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }

  it('forwards an INCOME ID to the FUND it was launched from', async () => {
    mocks.project.mockResolvedValue(row(71, true))
    mocks.binding.mockResolvedValue(70n)
    await render('71')
    expect(mocks.binding).toHaveBeenCalledWith(expect.anything(), { chainId: 1, incomeProjectId: 71n })
    expect(mocks.replace).toHaveBeenCalledWith('/eth:70')
    expect(host.textContent).not.toContain('FUND page')
  })

  it('shows a FUND at its own address without reading an INCOME binding', async () => {
    mocks.project.mockResolvedValue(row(70, false))
    await render('70')
    expect(host.textContent).toContain('FUND page 70')
    expect(mocks.binding).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('keeps an INCOME with no Homerun FUND at its own address', async () => {
    mocks.project.mockResolvedValue(row(72, true))
    mocks.binding.mockResolvedValue(null)
    await render('72')
    expect(host.textContent).toContain('INCOME page 72')
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
