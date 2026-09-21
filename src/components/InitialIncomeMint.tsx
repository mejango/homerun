'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { formatUnits, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { fundIpfsUrl } from '@/lib/fund-project-metadata'
import { buildInitialIncomeMint, readInitialIncomeAllocation } from '@/lib/income-initial-allocation'

const message = (error: unknown) => error instanceof Error ? error.message : 'The initial allocation could not be verified.'

/** The recorded allocation is minted to whoever owns the FUND at that moment, who settles it offchain; it is a promise, not a claim. */
export function InitialIncomeMint({ chainId, fundProjectId, incomeProjectId, manifestUri }: { chainId: JBChainId; fundProjectId: bigint; incomeProjectId: bigint; manifestUri: string | null }) {
  const { address } = useWallet()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const cache = useQueryClient(), tx = useSafeTx(chainId)
  const [error, setError] = useState<string | null>(null), [preparing, setPreparing] = useState(false)
  const confirmed = useRef<string | null>(null)
  const query = useQuery({
    queryKey: ['initial-income-allocation', chainId, fundProjectId.toString(), incomeProjectId.toString()], enabled: !!client,
    queryFn: () => readInitialIncomeAllocation(client!, { chainId, incomeProjectId, fundProjectId }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1, placeholderData: keepPreviousData,
  })
  const state = query.data?.chainId === chainId && query.data.incomeProjectId === incomeProjectId && query.data.fundProjectId === fundProjectId ? query.data : undefined
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || confirmed.current === tx.receipt.transactionHash) return
    confirmed.current = tx.receipt.transactionHash
    void cache.invalidateQueries({ queryKey: ['initial-income-allocation', chainId, fundProjectId.toString(), incomeProjectId.toString()] })
    void cache.invalidateQueries({ queryKey: ['income-project', chainId, incomeProjectId.toString()] })
  }, [cache, chainId, fundProjectId, incomeProjectId, tx.phase, tx.receipt])
  const blocked = !client || !address || !state || query.isError || query.isPlaceholderData || state.pending === 0n || !state.started || preparing || tx.busy || tx.phase === 'review'
  async function mint() {
    if (blocked || !client || !state) return
    setPreparing(true); setError(null)
    try {
      const reverify = async () => {
        const latest = await readInitialIncomeAllocation(client, { chainId, incomeProjectId, fundProjectId })
        if (latest.stageId !== state.stageId || latest.pending !== state.pending || !latest.started) throw new Error('The initial allocation was already minted or its stage has not started. Refresh before continuing.')
        if (latest.owner !== state.owner) throw new Error('The FUND owner changed. Refresh to review the new recipient.')
      }
      await tx.send({ ...buildInitialIncomeMint(state), label: `Mint ${formatUnits(state.pending, 18)} initial INCOME to the FUND owner ${state.owner}` }, {
        reviewNotice: 'This mints the initial allocation recorded at launch to whoever owns the FUND when it executes; the owner settles it to the snapshot holders per the published allocation. Anyone can send it; the tokens never go to the sender, and it runs once.',
        reverify,
      })
    } catch (failure) { setError(message(failure)) } finally { setPreparing(false) }
  }
  const link = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  const published = manifestUri ? fundIpfsUrl(manifestUri) : null
  return <section className="mt-8 rounded border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7" aria-label="Initial INCOME allocation">
    <h3 className="text-2xl">Initial INCOME</h3>
    <p className="mt-3 text-sm">The initial 500,000 INCOME is divided across all FUND holders and linked chains at the snapshot, including inactive balances and pending bridge transfers. Each chain’s share is minted to the FUND owner, who settles it to the snapshot holders per the published allocation.</p>
    {query.isPending && <p role="status" className="mt-4">Verifying the initial allocation…</p>}
    {query.isError && <p role="alert" className="mt-4">{message(query.error)}</p>}
    {state && <>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-sm">{displayChainName(chainId)} allocation</dt><dd className="mt-2 break-all text-2xl">{state.pending > 0n ? `${formatUnits(state.pending, 18)} INCOME` : 'Minted'}</dd></div><div><dt className="text-sm">FUND owner</dt><dd className="mt-2 break-all text-sm">{state.owner}</dd></div></dl>
      <p className="mt-3 text-sm">{state.pending === 0n ? 'Nothing is left to mint on this chain: its allocation has been minted to the FUND owner or is zero.' : state.started ? 'The shared stage has started. Anyone can mint this allocation to whoever owns the FUND at that moment.' : `Mints once the shared stage starts ${new Date(Number(state.stageStart) * 1_000).toLocaleString()}.`}</p>
      {published && <p className="mt-3 text-sm"><a href={published} target="_blank" rel="noreferrer" className="underline">View the published allocation</a></p>}
      <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={blocked} onClick={() => void mint()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Mint initial INCOME to the FUND owner', pending: 'Minting…' })}</button>
    </>}
    <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
      {tx.safeProposalHash ? <p>Proposed to Safe. The allocation is not minted until the proposal executes.</p> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? <p>Initial INCOME minted to the FUND owner.</p> : null}
      {link && <a href={link} target="_blank" rel="noreferrer" className="underline">View transaction</a>}
    </div>
    {(error || tx.error) && <p role="alert" className="mt-3 text-sm text-red-800">{error ?? tx.error}</p>}
  </section>
}
