import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ project: vi.fn(), metadata: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/bendystraw', () => ({ getProject: mocks.project }))
vi.mock('@/lib/fund-project-metadata', () => ({ fetchFundProjectMetadata: mocks.metadata }))
vi.mock('@/lib/income-fund-binding', () => ({ readIncomeFundBinding: mocks.binding }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: (chainId: number) => ({ chainId }) }))
vi.mock('next/cache', () => ({ unstable_cache: <T>(fn: T) => fn }))
vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()), cache: <T>(fn: T) => fn }))

import { loadIncomeFund, loadProjectSeed, type ProjectSeed } from '../src/lib/project-seed'

const row = { chainId: 10, projectId: 11, version: 6, name: 'Some Glorious asset', metadataUri: 'ipfs://bafy' }

describe('server project seed', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('seeds the exact V6 project and its published details', async () => {
    mocks.project.mockResolvedValue(row)
    mocks.metadata.mockResolvedValue({ name: 'Some Glorious asset' })
    await expect(loadProjectSeed(10, '11')).resolves.toEqual({ indexed: row, details: { name: 'Some Glorious asset' } })
    expect(mocks.metadata.mock.calls[0][0]).toBe('ipfs://bafy')
  })

  it('never seeds a row for another project, chain or version', async () => {
    for (const other of [{ ...row, projectId: 12 }, { ...row, chainId: 1 }, { ...row, version: 5 }]) {
      mocks.project.mockResolvedValue(other)
      await expect(loadProjectSeed(10, '11')).resolves.toEqual({ indexed: null, details: null })
    }
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('gives up on a slow or failing index instead of holding the page', async () => {
    vi.useFakeTimers()
    mocks.project.mockReturnValue(new Promise(() => {}))
    const seed = loadProjectSeed(10, '11')
    await vi.advanceTimersByTimeAsync(2_600)
    await expect(seed).resolves.toEqual({ indexed: null, details: null })
    vi.useRealTimers()
    mocks.project.mockRejectedValue(new Error('down'))
    await expect(loadProjectSeed(10, '11')).resolves.toEqual({ indexed: null, details: null })
  })

  it('answers an indexed revnet\'s FUND on the server, and only when it is known in time', async () => {
    const revnet = { indexed: { ...row, isRevnet: true }, details: null } as unknown as ProjectSeed
    const fund = { indexed: { ...row, isRevnet: false }, details: null } as unknown as ProjectSeed
    await expect(loadIncomeFund(10, '11', fund)).resolves.toBeUndefined()
    expect(mocks.binding).not.toHaveBeenCalled()
    mocks.binding.mockResolvedValueOnce(70n)
    await expect(loadIncomeFund(10, '11', revnet)).resolves.toBe('70')
    expect(mocks.binding).toHaveBeenCalledWith({ chainId: 10 }, { chainId: 10, incomeProjectId: 11n })
    mocks.binding.mockResolvedValueOnce(null)
    await expect(loadIncomeFund(10, '11', revnet)).resolves.toBeNull()
    mocks.binding.mockRejectedValueOnce(new Error('archive unavailable'))
    await expect(loadIncomeFund(10, '11', revnet)).resolves.toBeUndefined()
    vi.useFakeTimers()
    mocks.binding.mockReturnValueOnce(new Promise(() => {}))
    const slow = loadIncomeFund(10, '11', revnet)
    await vi.advanceTimersByTimeAsync(2_600)
    await expect(slow).resolves.toBeUndefined()
  })
})

