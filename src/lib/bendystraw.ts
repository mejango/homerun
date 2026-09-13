/**
 * Minimal bendystraw client: plain fetch, no client library. Every query lives
 * here, typed by hand — auditable end to end. All queries are V6-only.
 */

import {
  bendystrawCacheTtl,
  bendystrawProjectRefsFilters as projectRefsWheres,
  matchesBendystrawProjectRef as matchesProjectRef,
  normalizeBendystrawEndpoint,
  requestBendystraw,
  resolveBendystrawNetwork,
  selectBendystrawEndpoint,
  type BendystrawCachePolicy,
  type BendystrawFilter,
  type BendystrawNetwork,
  type BendystrawProjectRef,
} from '@bananapus/nana-sdk-core'
import { compileBendystrawOperation } from '@/lib/bendystraw-operation'

type VersionedProjectRef = Required<BendystrawProjectRef>

export function normalizeBendystrawUrl(value: string): string {
  return normalizeBendystrawEndpoint(value.trim())
}

const MAINNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_BENDYSTRAW_URL ??
        'https://bendystraw.up.railway.app',
    )
const TESTNET_URL = process.env.BROWSER_BUILD_FIXTURE_ORIGIN
  ? `${process.env.BROWSER_BUILD_FIXTURE_ORIGIN}/graphql`
  : normalizeBendystrawUrl(
      process.env.NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL ??
        'https://testnet.bendystraw.xyz',
    )
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

/**
 * Endpoint-routing hint for queries whose variables carry no chainId (e.g.
 * suckerGroup-keyed reads): mirrors the chainId-variable routing in
 * `bendystraw` below. Undefined (unknown chain or no hint) falls back to the
 * default endpoint selection.
 */
export function bendystrawNetworkHint(
  chainId?: number | null,
): BendystrawNetwork | undefined {
  return typeof chainId === 'number'
    ? resolveBendystrawNetwork({ chainId })
    : undefined
}

export async function bendystraw<T>(
  query: string,
  variables: Record<string, unknown>,
  opts: {
    chainId?: number
    network?: BendystrawNetwork
    policy?: BendystrawCachePolicy
  } = {},
): Promise<T> {
  const contract = compileBendystrawOperation(query)
  const network = resolveBendystrawNetwork({
    chainId: opts.chainId,
    defaultNetwork: 'mainnet',
    network: opts.network,
    variables,
  })
  if (typeof window !== 'undefined') {
    const { requestPersistedBendystraw } = await import(
      '@/lib/bendystraw-browser'
    )
    return requestPersistedBendystraw<T>({
      contract,
      network,
      query,
      variables,
    })
  }
  const cacheOptions = IS_DETERMINISTIC_BROWSER
    ? { next: { revalidate: 1 } }
    : {
        next: {
          revalidate: bendystrawCacheTtl(opts.policy ?? 'stable') / 1_000,
        },
      }
  return requestBendystraw<T, Record<string, unknown>>(
    selectBendystrawEndpoint(
      { mainnet: MAINNET_URL, testnet: TESTNET_URL },
      {
        chainId: opts.chainId,
        network,
        variables,
      },
    ),
    query,
    variables,
    {
      fetch: (input, init) => fetch(input, { ...init, ...cacheOptions }),
      operationName: contract.operationName,
      validateData: (value): value is T => contract.validateData(value),
      validateVariables: contract.validateVariables,
    },
  )
}

export type IndexerOptions = { network?: BendystrawNetwork }

export type BsProject = {
  projectId: number
  chainId: number
  version: number
  name: string | null
  logoUri: string | null
  projectTagline: string | null
  volume: string
  volumeUsd: string
  balance: string
  paymentsCount: number
  contributorsCount: number
  createdAt: number
  suckerGroupId: string | null
  token: string | null
  tokenSymbol: string | null
  decimals: number | null
  currency: number | null
  isRevnet: boolean | null
  owner: string | null
  metadataUri: string | null
}

export type BsSearchProject = BsProject & {
  searchTicker: string | null
}

const PROJECT_FIELDS = `
  projectId chainId version name logoUri projectTagline volume volumeUsd balance
  paymentsCount contributorsCount createdAt suckerGroupId token tokenSymbol
  decimals currency isRevnet owner metadataUri
`

const PROJECTS_BY_FILTER_QUERY = `query ProjectsByFilter($where: projectFilter!, $limit: Int!) {
  projects(
    where: $where
    orderBy: "volume"
    orderDirection: "desc"
    limit: $limit
  ) { items { ${PROJECT_FIELDS} } }
}`

export async function getProject(
  chainId: number,
  projectId: number,
): Promise<BsProject | null> {
  const data = await bendystraw<{ project: BsProject | null }>(
    `query($chainId: Float!, $projectId: Float!) {
      project(chainId: $chainId, projectId: $projectId, version: 6) { ${PROJECT_FIELDS} }
    }`,
    { chainId, projectId },
    { policy: 'standard' },
  )
  return data.project
}

export async function searchProjects(
  text: string,
  limit = 24,
  options: IndexerOptions = {},
): Promise<BsSearchProject[]> {
  const searchText = text.trim().replace(/^\$/, '')
  const numericId = /^\d+$/.test(searchText) ? Number(searchText) : null
  const idFilter: BendystrawFilter | null =
    numericId !== null && Number.isSafeInteger(numericId) && numericId > 0
      ? { projectId: numericId }
      : null
  const searchBranches: BendystrawFilter[] = [
    { name_contains_nocase: searchText },
    ...(idFilter ? [idFilter] : []),
  ]
  const [projectData, tickerData] = await Promise.all([
    bendystraw<{ projects: { items: BsProject[] } }>(
      PROJECTS_BY_FILTER_QUERY,
      { where: { AND: [{ version: 6 }, { OR: searchBranches }] }, limit },
      { ...options, policy: 'standard' },
    ),
    bendystraw<{
      deployErc20Events: {
        items: { chainId: number; projectId: number; symbol: string }[]
      }
    }>(
      `query($text: String!) {
        deployErc20Events(
          where: { symbol_contains_nocase: $text, version: 6 }
          limit: 100
        ) {
          items { chainId projectId symbol }
        }
      }`,
      { text: searchText },
      { ...options, policy: 'standard' },
    ),
  ])

  const tickerByDeployment = new Map<string, string>()
  for (const event of tickerData.deployErc20Events.items) {
    tickerByDeployment.set(
      `${event.chainId}:${event.projectId}`,
      event.symbol,
    )
  }
  // Bendystraw does not AND sibling fields inside one OR branch, so each
  // ticker deployment becomes an explicit AND group (see getProjectsByRefs).
  const tickerRefs = Array.from(tickerByDeployment.keys()).map(pair => {
    const [chainId, projectId] = pair.split(':').map(Number)
    return { chainId, projectId, version: 6 }
  })
  const tickerWheres = projectRefsWheres(tickerRefs)
  const tickerProjects =
    tickerWheres.length > 0
      ? (
          await Promise.all(
            tickerWheres.map(where =>
              bendystraw<{ projects: { items: BsProject[] } }>(
                PROJECTS_BY_FILTER_QUERY,
                { where, limit },
                { ...options, policy: 'standard' },
              ),
            ),
          )
        ).flatMap(page =>
          page.projects.items.filter(project =>
            matchesProjectRef(
              {
                chainId: project.chainId,
                projectId: project.projectId,
                version: project.version,
              },
              tickerRefs,
            ),
          ),
        )
      : []

  const projects = new Map<string, BsProject>()
  for (const project of [...projectData.projects.items, ...tickerProjects]) {
    projects.set(`${project.chainId}:${project.projectId}`, project)
  }
  return Array.from(projects.values())
    .map(project => ({
      ...project,
      searchTicker:
        tickerByDeployment.get(
          `${project.chainId}:${project.projectId}`,
        ) ?? null,
    }))
    .slice(0, limit)
}

export type BsActivityEvent = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  from: string
  txHash: string
  payEvent: {
    amount: string
    amountUsd: string | null
    beneficiary: string
    memo: string | null
    newlyIssuedTokenCount: string
  } | null
  cashOutTokensEvent: {
    cashOutCount: string
    reclaimAmount: string
    reclaimAmountUsd: string | null
    beneficiary: string
  } | null
  projectCreateEvent?: {
    from: string
  } | null
  addToBalanceEvent?: {
    amount: string
    from: string
    memo: string | null
  } | null
  mintTokensEvent?: {
    beneficiaryTokenCount: string
    beneficiary: string
    caller: string
    from: string
  } | null
  sendPayoutsEvent?: {
    amount: string
    amountPaidOut: string
    amountPaidOutUsd: string | null
    caller: string
    from: string
  } | null
  sendPayoutToSplitEvent?: {
    amount: string
    amountUsd: string | null
    beneficiary: string
    splitProjectId: number
    from: string
  } | null
  sendReservedTokensToSplitEvent?: {
    tokenCount: string
    beneficiary: string
    splitProjectId: number
    from: string
  } | null
  sendReservedTokensToSplitsEvent?: {
    tokenCount: string
    from: string
  } | null
  autoIssueEvent?: {
    beneficiary: string
    count: string
    stageId: string
    from: string
  } | null
  borrowLoanEvent?: {
    borrowAmount: string
    collateral: string
    beneficiary: string
    token: string
    from: string
  } | null
  repayLoanEvent?: {
    repayBorrowAmount: string
    collateralCountToReturn: string
    from: string
  } | null
  liquidateLoanEvent?: {
    borrowAmount: string
    collateral: string
    from: string
  } | null
  mintNftEvent?: {
    tierId: string
    tokenId: string
    beneficiary: string
    totalAmountPaid: string
    from: string
  } | null
  deployErc20Event?: {
    symbol: string
    name: string
    token: string
    from: string
  } | null
  setUriEvent?: {
    uri: string
    caller: string
    from: string
  } | null
  projectTransferEvent?: {
    previousOwner: string
    owner: string
    from: string
  } | null
  operatorPermissionsSetEvent?: {
    account: string
    operator: string
    isRevnetOperator: boolean | null
    caller: string
    from: string
  } | null
  rulesetQueuedEvent?: {
    cycleNumber: number
    caller: string
    from: string
  } | null
  addNftTierEvent?: {
    tierId: string
    price: string
    category: string
    caller: string
    from: string
  } | null
  removeNftTierEvent?: {
    tierId: string
    caller: string
    from: string
  } | null
  swapEvent?: {
    direction: string
    terminalTokenAmount: string
    projectTokenAmount: string
    caller: string
    from: string
  } | null
  buybackPoolEvent?: {
    terminalToken: string
    poolId: string
    caller: string
    from: string
  } | null
  bridgeClaimEvent?: {
    peerChainId: number
    token: string
    beneficiary: string
    projectTokenCount: string
    terminalTokenAmount: string
    caller: string
    from: string
  } | null
}

const ACTIVITY_EVENT_FIELDS = `
  id chainId projectId timestamp from txHash
  payEvent {
    amount amountUsd beneficiary memo newlyIssuedTokenCount
  }
  cashOutTokensEvent {
    cashOutCount reclaimAmount reclaimAmountUsd beneficiary
  }
  projectCreateEvent { from }
  addToBalanceEvent { amount memo from }
  mintTokensEvent {
    beneficiary beneficiaryTokenCount caller from
  }
  sendPayoutsEvent {
    amount amountPaidOut amountPaidOutUsd caller from
  }
  sendReservedTokensToSplitsEvent { tokenCount from }
  sendPayoutToSplitEvent {
    amount amountUsd beneficiary splitProjectId from
  }
  sendReservedTokensToSplitEvent {
    tokenCount beneficiary splitProjectId from
  }
  autoIssueEvent { beneficiary count stageId from }
  borrowLoanEvent {
    borrowAmount collateral beneficiary token from
  }
  repayLoanEvent {
    repayBorrowAmount collateralCountToReturn from
  }
  liquidateLoanEvent { borrowAmount collateral from }
  mintNftEvent {
    tierId tokenId beneficiary totalAmountPaid from
  }
  deployErc20Event { symbol name token from }
  setUriEvent { uri caller from }
  projectTransferEvent { previousOwner owner from }
  operatorPermissionsSetEvent {
    account operator isRevnetOperator caller from
  }
  rulesetQueuedEvent { cycleNumber caller from }
  addNftTierEvent { tierId price category caller from }
  removeNftTierEvent { tierId caller from }
  swapEvent {
    direction terminalTokenAmount projectTokenAmount caller from
  }
  buybackPoolEvent { terminalToken poolId caller from }
  bridgeClaimEvent {
    peerChainId token beneficiary projectTokenCount
    terminalTokenAmount caller from
  }
`

/** Returns `totalCount` alongside the page: the feed is capped, and the caller offers
 *  "Load more" only if it can tell how much it is holding back. Category filters apply to
 *  what has been LOADED, so a discarded total let a populated category render as empty. */
export async function getProjectActivity(
  suckerGroupId: string,
  limit = 20,
  chainId?: number,
  offset = 0,
): Promise<{ items: BsActivityEvent[]; totalCount: number }> {
  const page = await getPagedItems<BsActivityEvent>(
    `query($suckerGroupId: String!, $limit: Int!, $offset: Int!) {
      activityEvents(
        where: {
          suckerGroupId: $suckerGroupId
          version: 6
          OR: [
            { payEvent_not: null }
            { cashOutTokensEvent_not: null }
            { sendPayoutsEvent_not: null }
            { sendReservedTokensToSplitsEvent_not: null }
            { sendReservedTokensToSplitEvent_not: null }
            { autoIssueEvent_not: null }
            { mintTokensEvent_not: null }
            { borrowLoanEvent_not: null }
            { repayLoanEvent_not: null }
            { liquidateLoanEvent_not: null }
            { mintNftEvent_not: null }
            { deployErc20Event_not: null }
            { projectCreateEvent_not: null }
            { addToBalanceEvent_not: null }
            { setUriEvent_not: null }
            { projectTransferEvent_not: null }
            { rulesetQueuedEvent_not: null }
            { addNftTierEvent_not: null }
            { removeNftTierEvent_not: null }
            { swapEvent_not: null }
            { buybackPoolEvent_not: null }
            { bridgeClaimEvent_not: null }
          ]
        }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items { ${ACTIVITY_EVENT_FIELDS} }
        totalCount
      }
    }`,
    'activityEvents',
    { suckerGroupId },
    {
      network: bendystrawNetworkHint(chainId),
      pageSize: limit,
      max: limit,
      startOffset: offset,
      policy: 'live',
    },
  )
  return page
}

export async function getProjectActivityByProject(
  chainId: number,
  projectId: number,
  limit = 20,
  offset = 0,
): Promise<{ items: BsActivityEvent[]; totalCount: number }> {
  const page = await getPagedItems<BsActivityEvent>(
    `query($chainId: Int!, $projectId: Int!, $limit: Int!, $offset: Int!) {
      activityEvents(
        where: {
          chainId: $chainId
          projectId: $projectId
          version: 6
          OR: [
            { payEvent_not: null }
            { cashOutTokensEvent_not: null }
            { sendPayoutsEvent_not: null }
            { sendReservedTokensToSplitsEvent_not: null }
            { sendReservedTokensToSplitEvent_not: null }
            { autoIssueEvent_not: null }
            { mintTokensEvent_not: null }
            { borrowLoanEvent_not: null }
            { repayLoanEvent_not: null }
            { liquidateLoanEvent_not: null }
            { mintNftEvent_not: null }
            { deployErc20Event_not: null }
            { projectCreateEvent_not: null }
            { addToBalanceEvent_not: null }
            { setUriEvent_not: null }
            { projectTransferEvent_not: null }
            { rulesetQueuedEvent_not: null }
            { addNftTierEvent_not: null }
            { removeNftTierEvent_not: null }
            { swapEvent_not: null }
            { buybackPoolEvent_not: null }
            { bridgeClaimEvent_not: null }
          ]
        }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items { ${ACTIVITY_EVENT_FIELDS} }
        totalCount
      }
    }`,
    'activityEvents',
    { chainId, projectId },
    {
      network: bendystrawNetworkHint(chainId),
      pageSize: limit,
      max: limit,
      startOffset: offset,
      policy: 'live',
    },
  )
  return page
}

export async function getPagedItems<T>(
  query: string,
  field: string,
  variables: Record<string, unknown>,
  {
    pageSize = 1_000,
    max = Number.POSITIVE_INFINITY,
    startOffset = 0,
    network,
    policy = 'standard',
  }: {
    pageSize?: number
    max?: number
    /**
     * Row index the run starts at. `offset` inside `variables` is IGNORED — this function
     * owns paging — so a caller resuming after a first page must say so here. Without it
     * every "load more" re-fetched rows [0, limit) forever.
     */
    startOffset?: number
    network?: BendystrawNetwork
    policy?: BendystrawCachePolicy
  } = {},
): Promise<{ items: T[]; totalCount: number }> {
  const items: T[] = []
  let totalCount = 0

  while (items.length < max) {
    const pageLimit = Math.min(pageSize, max - items.length)
    const data = await bendystraw<
      Record<string, { items: T[]; totalCount: number }>
    >(
      query,
      { ...variables, limit: pageLimit, offset: startOffset + items.length },
      { network, policy },
    )
    const root = data[field]
    if (!root || !Array.isArray(root.items) || !Number.isSafeInteger(root.totalCount) || root.totalCount < 0) {
      throw new Error(`Bendystraw returned an invalid ${field} page`)
    }
    const page = root.items
    totalCount = root.totalCount
    items.push(...page)
    if (page.length === 0 || startOffset + items.length >= totalCount) {
      break
    }
  }

  return { items, totalCount: totalCount || startOffset + items.length }
}

export async function getProjectsOwnedBy(
  owners: string[],
  options: IndexerOptions = {},
): Promise<BsProject[]> {
  if (!owners.length) return []
  const page = await getPagedItems<BsProject>(
    `query($owners: [String!]!, $limit: Int!, $offset: Int!) {
      projects(
        where: { owner_in: $owners, version: 6 }
        orderBy: "volume"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) { items { ${PROJECT_FIELDS} } totalCount }
    }`,
    'projects',
    { owners: owners.map(owner => owner.toLowerCase()) },
    { ...options, pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
  return page.items
}

export async function getProjectsByRefs(
  refs: VersionedProjectRef[],
  options: IndexerOptions = {},
): Promise<BsProject[]> {
  const wheres = projectRefsWheres(refs)
  if (!wheres.length) return []
  const pages = await Promise.all(
    wheres.map(where =>
      bendystraw<{ projects: { items: BsProject[] } }>(
        PROJECTS_BY_FILTER_QUERY,
        { where, limit: 200 },
        { ...options, policy: 'stable' },
      ),
    ),
  )
  return pages.flatMap(data =>
    data.projects.items.filter(project =>
      matchesProjectRef(
        {
          chainId: project.chainId,
          projectId: project.projectId,
          version: project.version,
        },
        refs,
      ),
    ),
  )
}

export type BsAccountTokenHolding = {
  chainId: number
  projectId: number
  /** 18-decimal fixed-point token balance (credits + claimed ERC-20). */
  balance: string
  /** The unclaimed-credit share of `balance`. */
  creditBalance: string
  /** The claimed ERC-20 share of `balance`. */
  erc20Balance: string
}

/**
 * Positive V6 project-token balances held by an account, across chains,
 * largest first, paginated to completion.
 */
export async function getAccountTokenHoldings(
  account: string,
  options: IndexerOptions = {},
): Promise<{ items: BsAccountTokenHolding[]; totalCount: number }> {
  return getPagedItems<BsAccountTokenHolding>(
    `query($address: String!, $limit: Int!, $offset: Int!) {
      participants(
        where: { address: $address, balance_gt: "0", version: 6 }
        orderBy: "balance"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items { chainId projectId balance creditBalance erc20Balance }
        totalCount
      }
    }`,
    'participants',
    { address: account.toLowerCase() },
    { ...options, pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
}

export type BsAccountActivityEvent = BsActivityEvent & {
  /** Protocol version; account activity is scoped to V6. */
  version: number
  project: {
    name: string | null
    logoUri: string | null
    tokenSymbol: string | null
    decimals: number | null
    isRevnet: boolean | null
  } | null
}

/**
 * activityEvents only indexes the transaction sender. Related event tables
 * identify the beneficiary and contract caller, including actions by Safes
 * submitted by another account. Read those rows directly, excluding sends
 * already covered by activityEvents, and wrap them in the activity shape.
 */
const ACCOUNT_EVENT_SOURCES = [
  {
    list: 'payEvents',
    field: 'payEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'amount amountUsd beneficiary memo newlyIssuedTokenCount',
  },
  {
    list: 'cashOutTokensEvents',
    field: 'cashOutTokensEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'cashOutCount reclaimAmount reclaimAmountUsd beneficiary',
  },
  {
    list: 'projectCreateEvents',
    field: 'projectCreateEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: '',
  },
  {
    list: 'addToBalanceEvents',
    field: 'addToBalanceEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'amount memo',
  },
  {
    list: 'mintTokensEvents',
    field: 'mintTokensEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'beneficiary beneficiaryTokenCount',
  },
  {
    list: 'sendPayoutsEvents',
    field: 'sendPayoutsEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'amount amountPaidOut amountPaidOutUsd',
  },
  {
    list: 'sendReservedTokensToSplitsEvents',
    field: 'sendReservedTokensToSplitsEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'tokenCount',
  },
  {
    list: 'sendPayoutToSplitEvents',
    field: 'sendPayoutToSplitEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'amount amountUsd beneficiary splitProjectId',
  },
  {
    list: 'sendReservedTokensToSplitEvents',
    field: 'sendReservedTokensToSplitEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'tokenCount beneficiary splitProjectId',
  },
  {
    list: 'autoIssueEvents',
    field: 'autoIssueEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'beneficiary count stageId',
  },
  {
    list: 'borrowLoanEvents',
    field: 'borrowLoanEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'borrowAmount collateral beneficiary token',
  },
  {
    list: 'repayLoanEvents',
    field: 'repayLoanEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'repayBorrowAmount collateralCountToReturn',
  },
  {
    list: 'liquidateLoanEvents',
    field: 'liquidateLoanEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'borrowAmount collateral',
  },
  {
    list: 'mintNftEvents',
    field: 'mintNftEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'tierId tokenId beneficiary totalAmountPaid',
  },
  {
    list: 'deployErc20Events',
    field: 'deployErc20Event',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'symbol name token',
  },
  {
    list: 'setUriEvents',
    field: 'setUriEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'uri',
  },
  {
    list: 'projectTransferEvents',
    field: 'projectTransferEvent',
    filter: '{ OR: [{ owner: $address }, { previousOwner: $address }] }',
    callerSelection: '',
    selection: 'previousOwner owner',
  },
  {
    list: 'operatorPermissionsSetEvents',
    field: 'operatorPermissionsSetEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'account operator isRevnetOperator',
  },
  {
    list: 'rulesetQueuedEvents',
    field: 'rulesetQueuedEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'cycleNumber',
  },
  {
    list: 'addNftTierEvents',
    field: 'addNftTierEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'tierId price category',
  },
  {
    list: 'removeNftTierEvents',
    field: 'removeNftTierEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'tierId',
  },
  {
    list: 'swapEvents',
    field: 'swapEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'direction terminalTokenAmount projectTokenAmount',
  },
  {
    list: 'buybackPoolEvents',
    field: 'buybackPoolEvent',
    filter: '{ caller: $address }',
    callerSelection: 'caller',
    selection: 'terminalToken poolId',
  },
  {
    list: 'bridgeClaimEvents',
    field: 'bridgeClaimEvent',
    filter: '{ OR: [{ beneficiary: $address }, { caller: $address }] }',
    callerSelection: 'caller',
    selection: 'peerChainId token beneficiary projectTokenCount terminalTokenAmount',
  },
] as const

const ACCOUNT_RELATED_ACTIVITY_FIELDS = ACCOUNT_EVENT_SOURCES.map(
  source => `
    ${source.list}(
      where: { AND: [{ from_not: $address }, { version: 6 }, ${source.filter}] }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      totalCount
      items {
        id chainId projectId timestamp txHash from version ${source.callerSelection}
        project { name logoUri tokenSymbol decimals isRevnet }
        ${source.selection}
      }
    }`,
)

const ACCOUNT_ACTIVITY_QUERY = `query AccountActivity(
  $address: String!
  $limit: Int!
  $offset: Int!
) {
  activityEvents(
    where: { from: $address, version: 6 }
    orderBy: "timestamp"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) {
    totalCount
    items {
      version
      project { name logoUri tokenSymbol decimals isRevnet }
      ${ACTIVITY_EVENT_FIELDS}
    }
  }
}`

const ACCOUNT_RELATED_ACTIVITY_QUERY_1 = `query AccountRelatedActivity1(
  $address: String!
  $limit: Int!
  $offset: Int!
) {
  ${ACCOUNT_RELATED_ACTIVITY_FIELDS.slice(0, 8).join('\n')}
}`

const ACCOUNT_RELATED_ACTIVITY_QUERY_2 = `query AccountRelatedActivity2(
  $address: String!
  $limit: Int!
  $offset: Int!
) {
  ${ACCOUNT_RELATED_ACTIVITY_FIELDS.slice(8, 16).join('\n')}
}`

const ACCOUNT_RELATED_ACTIVITY_QUERY_3 = `query AccountRelatedActivity3(
  $address: String!
  $limit: Int!
  $offset: Int!
) {
  ${ACCOUNT_RELATED_ACTIVITY_FIELDS.slice(16, 24).join('\n')}
}`

type BsAccountRelatedEventRow = {
  id: string
  chainId: number
  projectId: number
  timestamp: number
  txHash: string
  from: string
  version: number
  project: BsAccountActivityEvent['project']
} & Record<string, unknown>

/**
 * Everything an account did across V6 projects and chains, newest first.
 * One page per call — the account view's load-more grows the offset instead
 * of paginating to exhaustion.
 *
 * Two branches merge into a page: activityEvents the account sent, plus
 * caller/beneficiary rows from the per-type event tables (which exclude
 * self-sent rows at the source, so the branches are disjoint). Every branch
 * is read from the head down to offset + limit and the merged, deduped
 * window is sliced — offset pagination spans the union exactly.
 */
export async function getAccountActivity(
  address: string,
  { limit = 25, offset = 0, network }: IndexerOptions & { limit?: number; offset?: number } = {},
): Promise<{ items: BsAccountActivityEvent[]; totalCount: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError('Invalid account activity pagination')
  }
  const addressLower = address.toLowerCase()
  const targetCount = offset + limit
  const listNames = [
    'activityEvents',
    ...ACCOUNT_EVENT_SOURCES.map(source => source.list),
  ]
  const pages = Object.fromEntries(
    listNames.map(name => [name, { items: [] as unknown[], totalCount: 0 }]),
  ) as Record<string, { items: unknown[]; totalCount: number }>

  let pageOffset = 0
  while (pageOffset < targetCount) {
    const pageLimit = Math.min(500, targetCount - pageOffset)
    // Bendystraw limits each GraphQL document to 1,000 tokens. Keep event
    // sources in bounded persisted operations, then merge their result pages.
    const responses = await Promise.all([
      ACCOUNT_ACTIVITY_QUERY,
      ACCOUNT_RELATED_ACTIVITY_QUERY_1,
      ACCOUNT_RELATED_ACTIVITY_QUERY_2,
      ACCOUNT_RELATED_ACTIVITY_QUERY_3,
    ].map(query => bendystraw<Record<string, { items: unknown[]; totalCount: number }>>(
      query,
      { address: addressLower, limit: pageLimit, offset: pageOffset },
      { network, policy: 'standard' },
    )))
    const data = Object.assign({}, ...responses) as Record<string, { items: unknown[]; totalCount: number }>
    for (const name of listNames) {
      const root = data[name]
      if (!root || !Array.isArray(root.items) || !Number.isSafeInteger(root.totalCount) || root.totalCount < 0) {
        throw new Error('Bendystraw returned an invalid account activity page')
      }
      pages[name].items.push(...root.items)
      pages[name].totalCount = root.totalCount
    }
    pageOffset += pageLimit
    if (
      listNames.every(
        name => pages[name].items.length >= pages[name].totalCount,
      )
    ) {
      break
    }
  }

  let totalCount = pages.activityEvents.totalCount
  const merged = [
    ...(pages.activityEvents.items as BsAccountActivityEvent[]),
  ]
  for (let index = 0; index < ACCOUNT_EVENT_SOURCES.length; index += 1) {
    const source = ACCOUNT_EVENT_SOURCES[index]
    const page = pages[source.list]
    totalCount += page.totalCount
    for (const row of page.items as BsAccountRelatedEventRow[]) {
      const {
        id,
        chainId,
        projectId,
        timestamp,
        txHash,
        from,
        version,
        project,
        ...eventFields
      } = row
      merged.push({
        id,
        chainId,
        projectId,
        timestamp,
        txHash,
        from,
        version,
        project,
        payEvent: null,
        cashOutTokensEvent: null,
        [source.field]: { ...eventFields, from },
      })
    }
  }

  // Preserve each source's order for tied timestamps. Adding an ID tie-breaker
  // here can reorder a previously loaded prefix when the next window widens.
  merged.sort((a, b) => b.timestamp - a.timestamp)
  const seen = new Set<string>()
  const deduped = merged.filter(event => {
    const key = `${event.chainId}:${event.version}:${event.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // `totalCount` is the sum of per-branch counts, but the branches are deduped by id. Any row
  // counted twice would otherwise make "Load more (X of Y)" overstate Y and leave a page that
  // never arrives — subtract what the dedupe actually removed.
  const duplicatesInWindow = merged.length - deduped.length
  return {
    items: deduped.slice(offset, offset + limit),
    totalCount: totalCount - duplicatesInWindow,
  }
}

export type BsOperatorGrant = {
  chainId: number
  projectId: number
  /** JBPermissionIds the operator holds. */
  permissions: number[]
  /** The account that granted the permissions. */
  account: string
  operator: string
  isRevnetOperator: boolean | null
  /** Protocol version of the granting project. */
  version: number
}

/** Every live permission grant held BY an operator, across all V6 projects. */
export async function getOperatorGrants(
  operator: string,
  options: IndexerOptions = {},
): Promise<BsOperatorGrant[]> {
  const page = await getPagedItems<BsOperatorGrant>(
    `query($operator: String!, $limit: Int!, $offset: Int!) {
      permissionHolders(
        where: { operator: $operator, version: 6 }
        limit: $limit
        offset: $offset
      ) {
        items {
          chainId projectId permissions account operator isRevnetOperator
          version
        }
        totalCount
      }
    }`,
    'permissionHolders',
    { operator: operator.toLowerCase() },
    { ...options, pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
  return page.items.filter(row => (row.permissions?.length ?? 0) > 0)
}

export type BsAccountNft = {
  chainId: number
  projectId: number
  tokenId: string
  tierId: number
  createdAt: number
  hook: { address: string } | null
  /** Indexed tier display metadata; either field may be missing. */
  tier: {
    resolvedUri: string | null
    metadata: Record<string, unknown> | null
  } | null
}

/**
 * Every indexed V6 721 shop item an account currently owns, across chains,
 * newest first, paginated to completion.
 */
export async function getAccountNfts(
  account: string,
  options: IndexerOptions = {},
): Promise<{ items: BsAccountNft[]; totalCount: number }> {
  const page = await getPagedItems<BsAccountNft>(
    `query($owner: String!, $limit: Int!, $offset: Int!) {
      nfts(
        where: { owner: $owner, version: 6 }
        orderBy: "createdAt"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) {
        items {
          chainId projectId tokenId tierId createdAt
          hook { address }
          tier { resolvedUri metadata }
        }
        totalCount
      }
    }`,
    'nfts',
    { owner: account.toLowerCase() },
    { ...options, pageSize: 200, max: Number.POSITIVE_INFINITY },
  )
  return {
    items: page.items.map(row => ({
      ...row,
      tokenId: String(row.tokenId),
      tierId: Number(row.tierId),
      createdAt: Number(row.createdAt),
    })),
    totalCount: page.totalCount,
  }
}
