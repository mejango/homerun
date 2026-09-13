import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address, type PublicClient } from 'viem'
import type { CurrentProjectOperator } from '../src/lib/project-operator-profile'
import type { CurrentOperatorProfileProps } from '../src/components/CurrentOperatorProfile'

type QueryOptions = {
  queryKey: unknown[]
  enabled: boolean
  queryFn: () => Promise<CurrentProjectOperator> | bigint
  staleTime?: number
  refetchInterval?: number
}

const runtime = vi.hoisted(() => ({
  client: {} as PublicClient | undefined,
  data: undefined as CurrentProjectOperator | undefined,
  confirmedBlock: undefined as bigint | undefined,
  isPending: false,
  isError: false,
  query: vi.fn<(options: QueryOptions) => void>(),
  refetch: vi.fn(),
  read: vi.fn(),
}))

vi.mock('wagmi', () => ({ usePublicClient: () => runtime.client }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOptions) => {
    runtime.query(options)
    if (options.queryKey[0] === 'project-admin-confirmed-block') return { data: runtime.confirmedBlock }
    return { data: runtime.data, isPending: runtime.isPending, isError: runtime.isError, refetch: runtime.refetch }
  },
}))
vi.mock('@/lib/project-operator-profile', () => ({
  PROJECT_OPERATOR_PROFILE_QUERY: 'project-operator-profile',
  readCurrentProjectOperator: runtime.read,
}))

import { CurrentOperatorProfile, CurrentOwnerProfile } from '../src/components/CurrentOperatorProfile'
import { parseFundProjectMetadata } from '../src/lib/fund-project-metadata'

const ORIGINAL = getAddress(`0x${'a1'.repeat(20)}`)
const REPLACEMENT = getAddress(`0x${'b2'.repeat(20)}`)
const OTHER = getAddress(`0x${'c3'.repeat(20)}`)
const details = parseFundProjectMetadata({
  name: 'Community House',
  homerun: {
    version: 1,
    kind: 'fund',
    setup: { ownerWallet: ORIGINAL, operatorWallet: ORIGINAL },
    owner: { name: 'Founding trust', introduction: 'We hold the community house.', photoUri: 'ipfs://QmOwnerPhoto' },
    operator: { name: 'Original hosts', introduction: 'We welcome members and guests.', photoUri: 'ipfs://QmOperatorPhoto' },
  },
})

function snapshot(address = ORIGINAL): CurrentProjectOperator {
  return {
    chainId: 1,
    incomeProjectId: 7n,
    blockNumber: 100n,
    blockHash: `0x${'ab'.repeat(32)}`,
    rulesetId: 90n,
    reservedPercent: 2_000,
    recipients: [{ address, percent: 300_000_000 }],
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  runtime.client = {} as PublicClient
  runtime.data = snapshot()
  runtime.confirmedBlock = undefined
  runtime.isPending = false
  runtime.isError = false
  runtime.query.mockClear()
  runtime.refetch.mockReset()
  runtime.read.mockReset()
  runtime.read.mockResolvedValue(runtime.data)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function renderOperator(props: Partial<CurrentOperatorProfileProps> = {}) {
  await act(async () => root.render(<CurrentOperatorProfile chainId={1} incomeProjectId={7n} fundDetails={details} {...props} />))
}

function expectNoPublishedOperator() {
  expect(host.textContent).not.toContain('Original hosts')
  expect(host.textContent).not.toContain('We welcome members and guests.')
  expect(host.querySelector('img')).toBeNull()
}

function queryOptions(key = 'project-operator-profile') {
  return runtime.query.mock.calls.findLast(([options]) => options.queryKey[0] === key)![0]
}

describe('current Operator profile', () => {
  it('keeps the published identity when the current incentive wallet still matches it', async () => {
    await renderOperator()
    expect(host.textContent).toContain('Original hosts')
    expect(host.textContent).toContain('We welcome members and guests.')
    expect(host.textContent).toContain('Current Operator wallet')
    expect(host.querySelector('a')?.textContent).toBe(ORIGINAL)
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${ORIGINAL}`)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(details.operator!.photoUrl)
  })

  it('replaces the displayed address without assigning the former Operator identity to it', async () => {
    await renderOperator()
    runtime.data = snapshot(REPLACEMENT)
    await renderOperator()
    expect(host.textContent).toContain('Current Operator wallet')
    expect(host.querySelector('a')?.textContent).toBe(REPLACEMENT)
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${REPLACEMENT}`)
    expect(host.textContent).not.toContain(ORIGINAL)
    expectNoPublishedOperator()
  })

  it('shows every direct recipient without presenting any one of them as the published Operator', async () => {
    runtime.data!.recipients = [
      { address: ORIGINAL, percent: 100_000_000 },
      { address: OTHER, percent: 200_000_000 },
    ]
    await renderOperator()
    expect(host.textContent).toContain('multiple direct incentive recipients')
    expect(Array.from(host.querySelectorAll('a'), link => link.textContent)).toEqual([ORIGINAL, OTHER])
    expect(host.textContent).toContain('10% of reserved INCOME')
    expect(host.textContent).toContain('20% of reserved INCOME')
    expectNoPublishedOperator()
  })

  it('shows no active Operator when the verified stage has no direct incentive recipients', async () => {
    runtime.data!.recipients = []
    await renderOperator()
    expect(host.textContent).toContain('No Operator incentive wallet is configured for the current INCOME stage.')
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOperator()
  })

  it('explicitly labels the published profile as planned before an INCOME project exists', async () => {
    await renderOperator({ incomeProjectId: undefined })
    expect(host.textContent).toContain('Planned Operator for the INCOME phase.')
    expect(host.textContent).toContain('Published Operator wallet')
    expect(host.textContent).not.toContain('Current Operator wallet')
    expect(host.textContent).toContain('Original hosts')
    expect(host.querySelector('a')?.textContent).toBe(ORIGINAL)
    expect(queryOptions().enabled).toBe(false)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('hides cached recipients when verification fails and lets the user retry', async () => {
    runtime.isError = true
    await renderOperator()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('The current Operator could not be verified.')
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOperator()
    await act(async () => host.querySelector('button')!.click())
    expect(runtime.refetch).toHaveBeenCalledOnce()
  })

  it.each([7n, undefined])('does not expose cached or planned addresses when the phase binding is unavailable (INCOME %s)', async incomeProjectId => {
    await renderOperator({ incomeProjectId, bindingUnavailable: true })
    expect(host.textContent).toContain('The current Operator could not be verified.')
    expect(host.textContent).not.toContain('Planned Operator')
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
    expect(queryOptions().enabled).toBe(false)
    expectNoPublishedOperator()
  })

  it.each(['chain', 'project', 'pending', 'missing', 'client'] as const)('does not label an unverified address as current when %s changes', async reason => {
    if (reason === 'chain') runtime.data!.chainId = 8453
    if (reason === 'project') runtime.data!.incomeProjectId = 8n
    if (reason === 'pending') runtime.isPending = true
    if (reason === 'missing') runtime.data = undefined
    if (reason === 'client') runtime.client = undefined
    await renderOperator()
    expect(host.textContent).toContain('Reading the current Operator…')
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOperator()
  })

  it('scopes refreshes to the chain and INCOME project and periodically reads current splits', async () => {
    runtime.data = { ...snapshot(), chainId: 84532, incomeProjectId: 21n }
    await renderOperator({ chainId: 84532, incomeProjectId: 21n })
    const query = queryOptions()
    expect(query.queryKey).toEqual(['project-operator-profile', 84532, '21'])
    expect(query.enabled).toBe(true)
    expect(query.staleTime).toBe(10_000)
    expect(query.refetchInterval).toBe(20_000)
    await query.queryFn()
    expect(runtime.read).toHaveBeenCalledWith(runtime.client, expect.objectContaining({ chainId: 84532, incomeProjectId: 21n }))
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${ORIGINAL}?network=testnet`)
  })

  it('hides the old identity after a confirmed update until a read reaches its block', async () => {
    await renderOperator()
    expect(host.textContent).toContain('Original hosts')

    runtime.confirmedBlock = 101n
    await renderOperator()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Waiting for the confirmed Operator update…')
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOperator()

    runtime.data = { ...snapshot(REPLACEMENT), blockNumber: 101n }
    await renderOperator()
    expect(host.textContent).not.toContain('Waiting for the confirmed Operator update')
    expect(host.textContent).toContain('Current Operator wallet')
    expect(host.querySelector('a')?.textContent).toBe(REPLACEMENT)
    expectNoPublishedOperator()
  })

  it('subscribes to the confirmed block for this chain and project and enforces it on fresh reads', async () => {
    runtime.confirmedBlock = 110n
    runtime.data = { ...snapshot(REPLACEMENT), chainId: 84532, incomeProjectId: 21n, blockNumber: 110n }
    await renderOperator({ chainId: 84532, incomeProjectId: 21n })
    const confirmed = queryOptions('project-admin-confirmed-block')
    expect(confirmed.queryKey).toEqual(['project-admin-confirmed-block', 84532, '21'])
    expect(confirmed.enabled).toBe(false)
    await queryOptions().queryFn()
    expect(runtime.read).toHaveBeenCalledWith(runtime.client, { chainId: 84532, incomeProjectId: 21n, minimumBlockNumber: 110n })
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${REPLACEMENT}?network=testnet`)
  })

  it('keeps a stale Operator hidden when no RPC client can verify the confirmed update', async () => {
    runtime.confirmedBlock = 101n
    runtime.client = undefined
    await renderOperator()
    expect(queryOptions().enabled).toBe(false)
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOperator()
    expect(runtime.read).not.toHaveBeenCalled()
  })
})

describe('current Owner profile', () => {
  async function renderOwner(owner: Address | null | undefined, unavailable = false) {
    await act(async () => root.render(<CurrentOwnerProfile chainId={1} owner={owner} details={details} unavailable={unavailable} />))
  }

  function expectNoPublishedOwner() {
    expect(host.textContent).not.toContain('Founding trust')
    expect(host.textContent).not.toContain('We hold the community house.')
    expect(host.querySelector('img')).toBeNull()
  }

  it('shows the published Owner identity only while its wallet still owns the project', async () => {
    await renderOwner(ORIGINAL)
    expect(host.textContent).toContain('Current Owner wallet')
    expect(host.textContent).toContain('Founding trust')
    expect(host.textContent).toContain('We hold the community house.')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(details.owner!.photoUrl)
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${ORIGINAL}`)

    await renderOwner(REPLACEMENT)
    expect(host.textContent).toContain('Current Owner wallet')
    expect(host.querySelector('a')?.textContent).toBe(REPLACEMENT)
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${REPLACEMENT}`)
    expect(host.textContent).not.toContain(ORIGINAL)
    expectNoPublishedOwner()
  })

  it('labels a published Owner wallet separately when current ownership has not been requested', async () => {
    await renderOwner(undefined)
    expect(host.textContent).toContain('Published Owner wallet')
    expect(host.textContent).not.toContain('Current Owner wallet')
    expect(host.textContent).toContain('Founding trust')
    expect(host.querySelector('a')?.textContent).toBe(ORIGINAL)
  })

  it.each([
    { owner: null, unavailable: false },
    { owner: ORIGINAL, unavailable: true },
    { owner: undefined, unavailable: true },
  ])('hides addresses and identity when ownership cannot be verified (%j)', async ({ owner, unavailable }) => {
    await renderOwner(owner, unavailable)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('The current Owner could not be verified.')
    expect(host.querySelector('a')).toBeNull()
    expectNoPublishedOwner()
  })

  it('keeps the verified Owner address visible when no profile metadata is available', async () => {
    await act(async () => root.render(<CurrentOwnerProfile chainId={84532} owner={REPLACEMENT} />))
    expect(host.textContent).toContain('Current Owner wallet')
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`/account/${REPLACEMENT}?network=testnet`)
    expectNoPublishedOwner()
  })
})
