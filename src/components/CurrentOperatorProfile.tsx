'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddressEqual, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { OperatorProfile } from '@/components/OperatorProfile'
import type { FundProjectMetadata } from '@/lib/fund-project-metadata'
import { PROJECT_OPERATOR_PROFILE_QUERY, readCurrentProjectOperator } from '@/lib/project-operator-profile'

export type CurrentOperatorProfileProps = {
  chainId: JBChainId
  incomeProjectId?: bigint
  fundDetails?: FundProjectMetadata
  /** The parent has not established the FUND/INCOME connection, or its binding read failed. */
  bindingUnavailable?: boolean
}

export function CurrentOperatorProfile({ chainId, incomeProjectId, fundDetails, bindingUnavailable = false }: CurrentOperatorProfileProps) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const confirmed = useQuery({
    queryKey: ['project-admin-confirmed-block', chainId, incomeProjectId?.toString()],
    queryFn: () => 0n, enabled: false,
  })
  const query = useQuery({
    queryKey: [PROJECT_OPERATOR_PROFILE_QUERY, chainId, incomeProjectId?.toString()],
    enabled: !!client && incomeProjectId !== undefined && !bindingUnavailable,
    queryFn: () => readCurrentProjectOperator(client!, { chainId, incomeProjectId: incomeProjectId!, minimumBlockNumber: confirmed.data }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  const profile = fundDetails?.operator
  const publishedAddress = fundDetails?.plan?.operatorWallet ?? null
  if (incomeProjectId === undefined && !bindingUnavailable) return <section className="operator-profile" aria-label="Planned Operator">
    <h2>Operator</h2>
    <p className="mb-4 text-sm">Planned Operator for the INCOME phase.</p>
    <OperatorProfile chainId={chainId} {...profile} address={publishedAddress} addressLabel="Published Operator wallet" showHeading={false} />
  </section>
  // Never present cached recipients as current after a failed verification or changed binding.
  if (bindingUnavailable || !client || query.isPending || query.isError || !query.data || query.data.chainId !== chainId || query.data.incomeProjectId !== incomeProjectId) return <section className="operator-profile" aria-label="Current Operator">
    <h2>Operator</h2>
    <p role="status">{bindingUnavailable || query.isError ? 'The current Operator could not be verified.' : 'Reading the current Operator…'}</p>
    {query.isError && !bindingUnavailable && <button type="button" className="mt-3 underline" onClick={() => void query.refetch()}>Retry</button>}
  </section>
  if (confirmed.data !== undefined && query.data.blockNumber < confirmed.data) return <section className="operator-profile" aria-label="Current Operator"><h2>Operator</h2><p role="status">Waiting for the confirmed Operator update…</p></section>
  const { recipients } = query.data
  if (recipients.length === 0) return <section className="operator-profile" aria-label="Current Operator">
    <h2>Operator</h2>
    <p>No Operator incentive wallet is configured for the current INCOME stage.</p>
  </section>
  if (recipients.length > 1) return <section className="operator-profile" aria-label="Current Operator recipients">
    <h2>Operator</h2>
    <p className="mb-4 text-sm">The current INCOME stage has multiple direct incentive recipients.</p>
    <div className="grid gap-4">{recipients.map(recipient => <div key={recipient.address}>
      <OperatorProfile chainId={chainId} address={recipient.address} addressLabel="Current INCOME recipient" showHeading={false} />
      <p className="mt-2 text-sm">{recipient.percent / 10_000_000}% of reserved INCOME</p>
    </div>)}</div>
  </section>
  const address = recipients[0].address
  const matchesProfile = publishedAddress !== null && isAddressEqual(publishedAddress, address)
  return <OperatorProfile chainId={chainId} {...(matchesProfile ? profile : undefined)} address={address} addressLabel="Current Operator wallet" />
}

/** Ownership transfers do not transfer a published person's introduction to the new wallet. */
export function CurrentOwnerProfile({ chainId, owner, details, unavailable = false }: {
  chainId: JBChainId; owner: Address | null | undefined; details?: FundProjectMetadata; unavailable?: boolean
}) {
  if (unavailable || owner === null) return <section className="operator-profile" aria-label="Current Owner"><h2>Owner</h2><p role="status">The current Owner could not be verified.</p></section>
  const publishedAddress = details?.plan?.ownerWallet ?? null
  if (owner === undefined) return <OperatorProfile chainId={chainId} role="Owner" {...details?.owner} address={publishedAddress} addressLabel="Published Owner wallet" />
  const matchesProfile = publishedAddress !== null && isAddressEqual(publishedAddress, owner)
  return <OperatorProfile chainId={chainId} role="Owner" {...(matchesProfile ? details?.owner : undefined)} address={owner} addressLabel="Current Owner wallet" />
}
