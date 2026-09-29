// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { formatParticipantBalance, getProjectHolders, getProjectParticipants, indexedParticipantProjectId } from '../src/lib/project-participants'

function row(overrides: Record<string, unknown> = {}) {
  return { address: '0x1111111111111111111111111111111111111111', chainId: 8453, projectId: 7, version: 6, balance: '30', creditBalance: '10', erc20Balance: '20', ...overrides }
}

function indexPage(items: unknown[], totalCount = items.length) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: { participants: { items, totalCount } } }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('project participants', () => {
  it('reads an exact V6 deployment without group or recent-activity filters, preserving credit-only accounts', async () => {
    const holder = row({ balance: '123', creditBalance: '123', erc20Balance: '0' })
    const fetcher = indexPage([holder], 26)
    expect(await getProjectParticipants(8453, 7n)).toEqual({ items: [holder], totalCount: 26, offset: 0, nextOffset: 1 })
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.variables).toEqual({ where: { AND: [{ chainId: 8453 }, { projectId: 7 }, { version: 6 }, { balance_gt: '0' }] }, limit: 25, offset: 0 })
    expect(body.query).toContain('creditBalance erc20Balance')
    expect(body.query).not.toContain('suckerGroup')
    expect(body.query).not.toContain('lastPaid')
  })

  it('routes testnet reads correctly and preserves pagination offsets', async () => {
    const holder = row({ chainId: 84532 })
    const fetcher = indexPage([holder], 26)
    expect(await getProjectParticipants(84532, '7', 25)).toMatchObject({ offset: 25, nextOffset: null, totalCount: 26 })
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).variables.offset).toBe(25)
  })

  it.each([
    { chainId: 1 }, { projectId: 8 }, { version: 5 },
    { address: 'bad' }, { creditBalance: null }, { erc20Balance: '-1' },
    { balance: '31' }, { balance: 'NaN' }, { creditBalance: 10 },
  ])('rejects malformed or mismatched indexed rows: %j', async overrides => {
    indexPage([row(overrides)])
    await expect(getProjectParticipants(8453, 7)).rejects.toThrow(/holder index/)
  })

  it('rejects duplicate account rows rather than double counting ownership', async () => {
    indexPage([row(), row()])
    await expect(getProjectParticipants(8453, 7)).rejects.toThrow('do not reconcile')
  })

  it('keeps zero-address credits in the indexed ownership list', async () => {
    const holder = row({ address: `0x${'0'.repeat(40)}`, creditBalance: '30', erc20Balance: '0' })
    indexPage([holder])
    expect((await getProjectParticipants(8453, 7)).items).toEqual([holder])
  })

  it('does not turn failed or incomplete index reads into zero holders', async () => {
    indexPage([], 4)
    await expect(getProjectParticipants(8453, 7)).rejects.toThrow('changed while loading')
    indexPage([row()], 0)
    await expect(getProjectParticipants(8453, 7)).rejects.toThrow('changed while loading')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })))
    await expect(getProjectParticipants(8453, 7)).rejects.toThrow('503')
  })

  it('distinguishes a successful empty index from an unavailable one', async () => {
    indexPage([])
    expect(await getProjectParticipants(8453, 7)).toEqual({ items: [], totalCount: 0, offset: 0, nextOffset: null })
  })

  it('rejects unsupported identities and offsets before fetching', async () => {
    const fetcher = indexPage([])
    for (const [chainId, projectId] of [[8453, '1.5'], [8453, '-1'], [8453, '9007199254740993'], [999, '7'], [8453, '0']] as const) {
      expect(indexedParticipantProjectId(chainId, projectId)).toBeNull()
      await expect(getProjectParticipants(chainId, projectId)).rejects.toThrow('not supported')
    }
    await expect(getProjectParticipants(8453, 7, -1)).rejects.toThrow('not supported')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves precision for large and fractional balances without displaying tiny balances as zero', () => {
    expect(formatParticipantBalance('0')).toBe('0')
    expect(formatParticipantBalance('1')).toBe('<0.0001')
    expect(formatParticipantBalance('1234500000000000000')).toBe('1.2345')
    expect(formatParticipantBalance('9007199254740993123450000000000000')).toBe('9,007,199,254,740,993.1234')
  })

  it('folds each holder across chains, largest chain first, from complete per-deployment reads', async () => {
    const second = '0x2222222222222222222222222222222222222222'
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body))
      const chainId = variables.where.AND[0].chainId
      const items = chainId === 10
        ? [row({ chainId: 10, projectId: 9, balance: '50', creditBalance: '0', erc20Balance: '50' })]
        : [row(), row({ address: second, balance: '7', creditBalance: '7', erc20Balance: '0' })]
      return new Response(JSON.stringify({ data: { participants: { items, totalCount: items.length } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const { holders, complete } = await getProjectHolders([[8453, 7], [10, 9]])
    expect(complete).toBe(true)
    expect(holders.map(holder => [holder.address, holder.balance, holder.creditBalance, holder.erc20Balance, holder.chains])).toEqual([
      ['0x1111111111111111111111111111111111111111', 80n, 10n, 70n, [10, 8453]],
      [second, 7n, 7n, 0n, [8453]],
    ])
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).variables.limit)).toEqual([250, 250])
  })

  it('says so when a deployment has more holders than one read covers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body))
      const items = Array.from({ length: 250 }, (_, index) => row({ address: `0x${(variables.offset + index + 1).toString(16).padStart(40, '0')}`, balance: '1', creditBalance: '0', erc20Balance: '1' }))
      return new Response(JSON.stringify({ data: { participants: { items, totalCount: 1_200 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const { holders, complete } = await getProjectHolders([[8453, 7]])
    expect(holders).toHaveLength(1_000)
    expect(complete).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})

