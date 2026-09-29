import { bendystraw } from '@/lib/bendystraw'
import { displayChainSlug } from '@/lib/chainDisplay'

export const PROJECT_PARTICIPANTS_PAGE_SIZE = 25

const PROJECT_PARTICIPANTS_QUERY = `query ProjectParticipants(
  $where: participantFilter!
  $limit: Int!
  $offset: Int!
) {
  participants(
    where: $where
    orderBy: "balance"
    orderDirection: "desc"
    limit: $limit
    offset: $offset
  ) {
    items { address chainId projectId version balance creditBalance erc20Balance }
    totalCount
  }
}`

export type ProjectParticipant = {
  address: string
  chainId: number
  projectId: number
  version: number
  /** Total project tokens, including unclaimed credits; 18 decimals. */
  balance: string
  creditBalance: string
  erc20Balance: string
}

export type ProjectParticipantsPage = {
  items: ProjectParticipant[]
  totalCount: number
  offset: number
  nextOffset: number | null
}

export function indexedParticipantProjectId(chainId: number, projectId: string | number | bigint): number | null {
  const id = Number(projectId)
  return displayChainSlug(chainId) !== null && /^\d+$/.test(String(projectId)) && Number.isSafeInteger(id) && id > 0
    ? id : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBalance(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78
}

/**
 * Read an exact deployment, as Juicebox Money does. A sucker group's identity
 * can change without migrating inactive participants; filtering by that group
 * would silently hide their balances. This indexed view never authorizes writes.
 */
export async function getProjectParticipants(
  chainId: number,
  projectId: string | number | bigint,
  offset = 0,
  limit = PROJECT_PARTICIPANTS_PAGE_SIZE,
): Promise<ProjectParticipantsPage> {
  const id = indexedParticipantProjectId(chainId, projectId)
  if (id === null || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('This project identity or holder page is not supported by the index.')
  }
  const data = await bendystraw<{ participants: unknown }>(PROJECT_PARTICIPANTS_QUERY, {
    where: { AND: [{ chainId }, { projectId: id }, { version: 6 }, { balance_gt: '0' }] },
    limit,
    offset,
  }, { chainId, policy: 'live' })
  const page = data.participants
  if (!isRecord(page) || !Array.isArray(page.items) || !Number.isSafeInteger(page.totalCount) || Number(page.totalCount) < 0 || page.items.length > limit) {
    throw new Error('The holder index returned an incomplete page.')
  }
  const seen = new Set<string>()
  const items = page.items.map((row): ProjectParticipant => {
    if (!isRecord(row) || typeof row.address !== 'string' || !/^0x[\da-f]{40}$/i.test(row.address) || row.chainId !== chainId || row.projectId !== id || row.version !== 6 || !isBalance(row.balance) || !isBalance(row.creditBalance) || !isBalance(row.erc20Balance)) {
      throw new Error('The holder index returned an invalid account or balance.')
    }
    if (BigInt(row.balance) !== BigInt(row.creditBalance) + BigInt(row.erc20Balance) || seen.has(row.address.toLowerCase())) {
      throw new Error('The holder index returned balances that do not reconcile.')
    }
    seen.add(row.address.toLowerCase())
    return { address: row.address, chainId, projectId: id, version: 6, balance: row.balance, creditBalance: row.creditBalance, erc20Balance: row.erc20Balance }
  })
  const totalCount = Number(page.totalCount)
  // If the index changed while paging, disclose the failure rather than imply
  // the missing rows or unclaimed-credit balances are zero.
  if ((items.length > 0 && offset + items.length > totalCount) || (items.length === 0 && totalCount > offset)) {
    throw new Error('The holder index changed while loading this page. Refresh to try again.')
  }
  const next = offset + items.length
  return { items, totalCount, offset, nextOffset: next < totalCount ? next : null }
}

export type ProjectHolder = {
  address: string
  /** Summed across the project's chains; 18 decimals. */
  balance: bigint
  creditBalance: bigint
  erc20Balance: bigint
  /** Chains holding a balance, largest first; the first is where the explorer link points. */
  chains: number[]
}

const HOLDER_PAGE = 250
const HOLDERS_PER_DEPLOYMENT = 1_000

/**
 * Every holder of a project across its chains, one row per address, as Juicebox Money's
 * Owners tab reads them: per deployment (never by sucker group, whose re-stamping drops
 * inactive holders), then folded by address. `complete` is false when a deployment had
 * more holders than one read covers.
 */
export async function getProjectHolders(refs: readonly (readonly [number, number])[]): Promise<{ holders: ProjectHolder[]; complete: boolean }> {
  let complete = true
  const rows = (await Promise.all(refs.map(async ([chainId, projectId]) => {
    const collected: ProjectParticipant[] = []
    for (let offset: number | null = 0; offset !== null && collected.length < HOLDERS_PER_DEPLOYMENT;) {
      const page: ProjectParticipantsPage = await getProjectParticipants(chainId, projectId, offset, HOLDER_PAGE)
      collected.push(...page.items)
      offset = page.nextOffset
      if (offset !== null && collected.length >= HOLDERS_PER_DEPLOYMENT) complete = false
    }
    return collected
  }))).flat()
  const byAddress = new Map<string, ProjectHolder & { perChain: Map<number, bigint> }>()
  for (const row of rows) {
    const key = row.address.toLowerCase()
    const holder = byAddress.get(key) ?? { address: row.address, balance: 0n, creditBalance: 0n, erc20Balance: 0n, chains: [], perChain: new Map() }
    holder.balance += BigInt(row.balance)
    holder.creditBalance += BigInt(row.creditBalance)
    holder.erc20Balance += BigInt(row.erc20Balance)
    holder.perChain.set(row.chainId, (holder.perChain.get(row.chainId) ?? 0n) + BigInt(row.balance))
    byAddress.set(key, holder)
  }
  const holders = [...byAddress.values()].map(({ perChain, ...holder }) => ({
    ...holder,
    chains: [...perChain].sort(([leftChain, left], [rightChain, right]) => right > left ? 1 : right < left ? -1 : leftChain - rightChain).map(([chainId]) => chainId),
  }))
  holders.sort((left, right) => right.balance > left.balance ? 1 : right.balance < left.balance ? -1 : 0)
  return { holders, complete }
}

/** Format without converting large balances to floating point or tiny ones to zero. */
export function formatParticipantBalance(value: string): string {
  const digits = value.padStart(19, '0')
  const whole = digits.slice(0, -18).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = digits.slice(-18).replace(/0+$/, '')
  if (!fraction) return whole
  if (whole === '0' && /^0{4}/.test(fraction)) return '<0.0001'
  return `${whole}.${fraction.slice(0, 4)}`
}
