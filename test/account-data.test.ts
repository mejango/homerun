// @vitest-environment node
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Lexer, Source, TokenKind } from 'graphql'
import { getAccountActivity, getAccountNfts, getOperatorGrants } from '@/lib/bendystraw'
import registry from '@/lib/bendystraw-operation-registry.json'

const ACCOUNT = '0xAbCd111111111111111111111111111111111111'

function graphqlResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function bodyOf(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown>; operation?: string }
}

const BENEFICIARY_LISTS = [
  'payEvents', 'cashOutTokensEvents', 'mintTokensEvents', 'autoIssueEvents',
  'borrowLoanEvents', 'mintNftEvents', 'bridgeClaimEvents',
  'sendPayoutToSplitEvents', 'sendReservedTokensToSplitEvents',
]

const RELATED_EVENT_LISTS = [
  'payEvents',
  'cashOutTokensEvents',
  'projectCreateEvents',
  'addToBalanceEvents',
  'mintTokensEvents',
  'sendPayoutsEvents',
  'sendReservedTokensToSplitsEvents',
  'sendPayoutToSplitEvents',
  'sendReservedTokensToSplitEvents',
  'autoIssueEvents',
  'borrowLoanEvents',
  'repayLoanEvents',
  'liquidateLoanEvents',
  'mintNftEvents',
  'deployErc20Events',
  'setUriEvents',
  'projectTransferEvents',
  'operatorPermissionsSetEvents',
  'rulesetQueuedEvents',
  'addNftTierEvents',
  'removeNftTierEvents',
  'swapEvents',
  'buybackPoolEvents',
  'bridgeClaimEvents',
]

function completeActivityRow(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'event',
    chainId: 1,
    projectId: 1,
    timestamp: 1,
    from: '0xfrom',
    caller: '0xcaller',
    txHash: '0xtx',
    version: 6,
    project: null,
    payEvent: null,
    cashOutTokensEvent: null,
    projectCreateEvent: null,
    addToBalanceEvent: null,
    mintTokensEvent: null,
    sendPayoutsEvent: null,
    sendReservedTokensToSplitsEvent: null,
    sendPayoutToSplitEvent: null,
    sendReservedTokensToSplitEvent: null,
    autoIssueEvent: null,
    borrowLoanEvent: null,
    repayLoanEvent: null,
    liquidateLoanEvent: null,
    mintNftEvent: null,
    deployErc20Event: null,
    setUriEvent: null,
    projectTransferEvent: null,
    operatorPermissionsSetEvent: null,
    rulesetQueuedEvent: null,
    addNftTierEvent: null,
    removeNftTierEvent: null,
    swapEvent: null,
    buybackPoolEvent: null,
    bridgeClaimEvent: null,
    ...overrides,
  }
}

function accountActivityResponse(
  overrides: Record<string, { totalCount: number; items: unknown[] }> = {},
): Response {
  const data: Record<string, { totalCount: number; items: unknown[] }> = {
    activityEvents: { totalCount: 0, items: [] },
  }
  for (const list of RELATED_EVENT_LISTS) {
    data[list] = { totalCount: 0, items: [] }
  }
  const merged = { ...data, ...overrides }
  return graphqlResponse({
    data: Object.fromEntries(
      Object.entries(merged).map(([name, page]) => [
        name,
        {
          ...page,
          items: page.items.map(item =>
            completeActivityRow(item as Record<string, unknown>),
          ),
        },
      ]),
    ),
  })
}

describe('account dashboard data', () => {
  it('scopes activity to V6 account sends and beneficiary receipts on the selected network', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => accountActivityResponse())
    vi.stubGlobal('fetch', fetcher)
    await getAccountActivity(ACCOUNT, { network: 'testnet', limit: 25, offset: 50 })
    const { variables } = bodyOf(fetcher.mock.calls[0][1])
    const query = fetcher.mock.calls.map(([, init]) => bodyOf(init).query).join('\n')
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(variables).toEqual({ address: ACCOUNT.toLowerCase(), limit: 75, offset: 0 })
    expect(query).toContain('from: $address, version: 6')
    expect(query).toContain('project { name logoUri tokenSymbol decimals isRevnet }')
    for (const list of BENEFICIARY_LISTS) expect(query).toContain(`${list}(`)
    expect(query.match(/OR: \[\{ beneficiary: \$address \}, \{ caller: \$address \}\]/g)).toHaveLength(BENEFICIARY_LISTS.length)
    expect(query.match(/AND: \[\{ from_not: \$address \}, \{ version: 6 \}/g)).toHaveLength(RELATED_EVENT_LISTS.length)
    expect(query).not.toContain('projectId_in')
  })

  it('merges sent and received activity newest first, dedupes exact identities, and slices the union', async () => {
    const recipient = {
      id: 'received', chainId: 8453, projectId: 7, version: 6, timestamp: 200, txHash: '0x2', from: '0xother',
      project: { name: 'P', logoUri: null, tokenSymbol: 'USDC', decimals: 6, isRevnet: true },
      amount: '2500000', amountUsd: '2500000000000000000', beneficiary: ACCOUNT.toLowerCase(), memo: null, newlyIssuedTokenCount: '0',
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => accountActivityResponse({
      activityEvents: { totalCount: 3, items: [
        { id: 'new', chainId: 1, projectId: 2, version: 6, timestamp: 300 },
        { id: 'duplicate', chainId: 8453, projectId: 7, version: 6, timestamp: 100 },
        { id: 'duplicate', chainId: 1, projectId: 7, version: 6, timestamp: 50 },
      ] },
      payEvents: { totalCount: 2, items: [recipient, { ...recipient, id: 'duplicate', timestamp: 100 }] },
    }))
    vi.stubGlobal('fetch', fetcher)
    const page = await getAccountActivity(ACCOUNT, { limit: 2, offset: 1 })
    expect(page.totalCount).toBe(4)
    expect(page.items.map(item => item.id)).toEqual(['received', 'duplicate'])
    expect(page.items[0]).toMatchObject({ project: { isRevnet: true }, payEvent: { amount: '2500000', beneficiary: ACCOUNT.toLowerCase() }, cashOutTokensEvent: null })
    expect(bodyOf(fetcher.mock.calls[0][1]).variables).toEqual({ address: ACCOUNT.toLowerCase(), limit: 3, offset: 0 })
  })

  it('includes Safe actions submitted by another wallet through the event caller', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => accountActivityResponse({
      setUriEvents: { totalCount: 1, items: [{
        id: 'safe-update', chainId: 8453, projectId: 7, timestamp: 200,
        from: '0xexecutor', caller: ACCOUNT.toLowerCase(), uri: 'ipfs://project-metadata',
      }] },
    }))
    vi.stubGlobal('fetch', fetcher)
    const page = await getAccountActivity(ACCOUNT)
    expect(page.totalCount).toBe(1)
    expect(page.items[0]).toMatchObject({
      from: '0xexecutor',
      setUriEvent: { caller: ACCOUNT.toLowerCase(), uri: 'ipfs://project-metadata' },
    })
    expect(fetcher.mock.calls.map(([, init]) => bodyOf(init).query).join('\n')).toContain('AND: [{ from_not: $address }, { version: 6 }, { caller: $address }]')
  })

  it('fetches multiple bounded source windows when a later activity page exceeds 500 rows', async () => {
    const rows = Array.from({ length: 530 }, (_, index) => ({ id: `event-${index}`, timestamp: 1000 - index }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { variables } = bodyOf(init)
      const offset = Number(variables.offset)
      return accountActivityResponse({ activityEvents: { totalCount: rows.length, items: rows.slice(offset, offset + Number(variables.limit)) } })
    })
    vi.stubGlobal('fetch', fetcher)
    const page = await getAccountActivity(ACCOUNT, { offset: 500, limit: 25 })
    expect(page.items.map(item => item.id)).toEqual(rows.slice(500, 525).map(item => item.id))
    expect(page.totalCount).toBe(530)
    expect(fetcher.mock.calls.map(([, init]) => bodyOf(init).variables)).toEqual([
      ...Array.from({ length: 4 }, () => ({ address: ACCOUNT.toLowerCase(), limit: 500, offset: 0 })),
      ...Array.from({ length: 4 }, () => ({ address: ACCOUNT.toLowerCase(), limit: 25, offset: 500 })),
    ])
  })

  it('preserves the source order of tied timestamps as activity windows grow', async () => {
    const rows = [{ id: 'z', timestamp: 100 }, { id: 'a', timestamp: 100 }]
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { variables } = bodyOf(init)
      return accountActivityResponse({ activityEvents: { totalCount: 2, items: rows.slice(0, Number(variables.limit)) } })
    })
    vi.stubGlobal('fetch', fetcher)
    const first = await getAccountActivity(ACCOUNT, { limit: 1 })
    const second = await getAccountActivity(ACCOUNT, { limit: 1, offset: 1 })
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(['z', 'a'])
  })

  it('loads all current V6 store holdings with collection and tier identity on the selected network', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      chainId: 84532, projectId: 7, tokenId: String(index + 1), tierId: 1, createdAt: 1000 - index,
      hook: { address: index % 2 ? '0xhookA' : '0xhookB' },
      tier: { resolvedUri: null, metadata: { name: 'A stay', image: 'ipfs://image' } },
    }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { variables } = bodyOf(init)
      const offset = Number(variables.offset)
      return graphqlResponse({ data: { nfts: { totalCount: rows.length, items: rows.slice(offset, offset + Number(variables.limit)) } } })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await getAccountNfts(ACCOUNT, { network: 'testnet' })).toEqual({ totalCount: 205, items: rows })
    expect(fetcher.mock.calls.every(([url]) => url === 'https://testnet.bendystraw.xyz/graphql')).toBe(true)
    expect(fetcher.mock.calls.map(([, init]) => bodyOf(init).variables)).toEqual([
      { owner: ACCOUNT.toLowerCase(), limit: 200, offset: 0 },
      { owner: ACCOUNT.toLowerCase(), limit: 200, offset: 200 },
    ])
    expect(bodyOf(fetcher.mock.calls[0][1]).query).toContain('owner: $owner, version: 6')
  })

  it('returns live V6 operator grants including wildcard grants and excludes revocations', async () => {
    const grant = { chainId: 84532, projectId: 7, permissions: [1, 2], account: '0xowner', operator: ACCOUNT.toLowerCase(), isRevnetOperator: false, version: 6 }
    const wildcard = { ...grant, projectId: 0 }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => graphqlResponse({ data: { permissionHolders: { totalCount: 3, items: [grant, wildcard, { ...grant, projectId: 8, permissions: [] }] } } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await getOperatorGrants(ACCOUNT, { network: 'testnet' })).toEqual([grant, wildcard])
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(bodyOf(fetcher.mock.calls[0][1]).variables).toEqual({ operator: ACCOUNT.toLowerCase(), limit: 200, offset: 0 })
    expect(bodyOf(fetcher.mock.calls[0][1]).query).toContain('operator: $operator, version: 6')
  })

  it('propagates indexer failures and malformed pages instead of displaying an empty account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => graphqlResponse({ errors: [{ message: 'Indexer offline' }] }))
    vi.stubGlobal('fetch', fetcher)
    for (const load of [getAccountActivity, getAccountNfts, getOperatorGrants]) {
      await expect(load(ACCOUNT)).rejects.toThrow('Indexer offline')
    }
    fetcher.mockImplementation(async () => graphqlResponse({ data: { nfts: null } }))
    await expect(getAccountNfts(ACCOUNT)).rejects.toThrow('invalid nfts page')
    fetcher.mockImplementation(async () => accountActivityResponse({ activityEvents: { totalCount: -1, items: [] } }))
    await expect(getAccountActivity(ACCOUNT)).rejects.toThrow('invalid account activity page')
  })

  it('keeps every account activity document below the deployed indexer token limit', () => {
    const queries = Object.values(registry).filter(query => /^query Account(?:Related)?Activity/u.test(query))
    expect(queries).toHaveLength(4)
    for (const query of queries) {
      const lexer = new Lexer(new Source(query))
      let tokens = 0
      while (lexer.advance().kind !== TokenKind.EOF) tokens += 1
      expect(tokens).toBeLessThanOrEqual(1000)
    }
  })

  it('registers every new operation for browser account reads', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('crypto', webcrypto)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { operation } = bodyOf(init)
      const query = registry[operation as keyof typeof registry]
      if (query.includes('permissionHolders(')) return graphqlResponse({ data: { permissionHolders: { items: [], totalCount: 0 } } })
      if (query.includes('nfts(')) return graphqlResponse({ data: { nfts: { items: [], totalCount: 0 } } })
      return accountActivityResponse()
    })
    vi.stubGlobal('fetch', fetcher)
    await getAccountActivity(ACCOUNT)
    await getAccountNfts(ACCOUNT)
    await getOperatorGrants(ACCOUNT)
    for (const [url, init] of fetcher.mock.calls) {
      const payload = bodyOf(init)
      expect(url).toBe('/api/bendystraw/mainnet/query')
      expect(payload).not.toHaveProperty('query')
      expect(registry[payload.operation as keyof typeof registry]).toContain('version: 6')
    }
  })
})
