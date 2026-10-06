/**
 * Bendystraw queries for revnet loans and auto-issuances (website/ parity:
 * BENDYSTRAW_LOANS_QUERY, BENDYSTRAW_STORE_AUTO_ISSUANCE_QUERY,
 * BENDYSTRAW_AUTO_ISSUE_EVENTS_QUERY). Typed by hand, V6-only. These read
 * INDEXED history; every write flow re-reads the authoritative on-chain state
 * before sending.
 */

import { getPagedItems } from '@/lib/bendystraw'

/** One open/closed loan row from the indexer. Amounts are fixed-point strings
 *  in the loan's source-token decimals; percents are out of 1000. */
export type BsLoan = {
  id: string
  borrowAmount: string
  collateral: string
  beneficiary: string
  owner: string
  createdAt: number
  chainId: number
  prepaidFeePercent: number
  prepaidDuration: number
  sourceFeeAmount: string
  token: string
}

const LOANS_QUERY = `
  query($projectId: Int!, $chainId: Int!, $limit: Int!, $offset: Int!) {
    loans(
      where: { projectId: $projectId, version: 6, chainId: $chainId }
      orderBy: "createdAt"
      orderDirection: "desc"
      limit: $limit
      offset: $offset
    ) {
      items {
        id borrowAmount collateral beneficiary owner createdAt chainId
        prepaidFeePercent prepaidDuration sourceFeeAmount token
      }
      totalCount
    }
  }
`

/**
 * A deployment's loans, newest first. The chain and its local project ID are
 * always passed together; linked deployments are never queried with one
 * project's ID. Paginated so a busy revnet's full loan book comes back.
 */
export async function getLoans(
  projectId: number,
  chainId: number,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ items: BsLoan[]; totalCount: number }> {
  return getPagedItems<BsLoan>(
    LOANS_QUERY,
    'loans',
    { projectId, chainId },
    { pageSize: 250, max: Number.POSITIVE_INFINITY, signal },
  )
}
