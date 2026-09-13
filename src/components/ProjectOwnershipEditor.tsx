'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useWallet } from '@/hooks/useWallet'
import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { buildProjectOwnershipTx, readProjectAuthority, reverifyProjectAuthority } from '@/lib/project-authority'
import { displayChainName } from '@/lib/chainDisplay'
import { ProjectAdminTransactionStatus } from './ProjectAdminTransactionStatus'

export type ProjectAuthorityEditorProps = { chainId: JBChainId; projectId: bigint; client: PublicClient | null | undefined; unavailable?: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : 'Project ownership could not be read.'

export function ProjectOwnershipEditor({ chainId, projectId, client, unavailable = false }: ProjectAuthorityEditorProps) {
  const { address } = useWallet()
  const [recipient, setRecipient] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const valid = isAddress(recipient.trim()) && !isAddressEqual(recipient.trim() as Address, zeroAddress)
  const query = useQuery({
    queryKey: ['project-authority', chainId, projectId.toString(), address ?? null, valid ? recipient.trim().toLowerCase() : null],
    queryFn: () => readProjectAuthority(client!, { chainId, projectId, account: address, operator: valid ? recipient.trim() as Address : null }),
    enabled: !!client && !unavailable, staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  const tx = useProjectAdminTx({ chainId, projectId, onConfirmed: async () => { setRecipient(''); setConfirmed(false); await query.refetch() } })
  const state = query.data
  const busy = preparing || tx.busy
  const isRevnet = state?.kind === 'revnet'
  const different = valid && !!state && !isAddressEqual(recipient.trim() as Address, isRevnet ? address ?? zeroAddress : state.owner)

  async function submit() {
    if (!client || !address || !confirmed || !state || busy || !tx.ready) return
    setPreparing(true); setError(null)
    try {
      const fresh = await readProjectAuthority(client, { chainId, projectId, account: address, operator: recipient.trim() as Address })
      if (fresh.identity !== state.identity) throw new Error('Project ownership or permissions changed. Review the refreshed information before continuing.')
      const request = buildProjectOwnershipTx(fresh, recipient)
      await tx.send(request, {
        reviewNotice: fresh.kind === 'revnet'
          ? `On ${displayChainName(chainId)}, move INCOME control from ${address} to ${recipient.trim()}. This clears the current control wallet’s project permission slot and replaces the new wallet’s slot with this revnet’s configured Operator permissions. The project NFT remains with REVOwner. Economic Operator split recipients are configured separately under Owners → Splits.`
          : `On ${displayChainName(chainId)}, transfer project #${projectId} ownership from ${fresh.owner} to ${recipient.trim()}. The recipient controls this project’s owner powers. Existing permissions are scoped to the previous owner and will no longer authorize this project; any permissions the recipient previously granted for this project become effective. Other chains require separate ownership transfers. Token balances and economic split recipients are unchanged.`,
        reverify: checked => reverifyProjectAuthority(client, fresh, checked, latest => buildProjectOwnershipTx(latest, recipient)),
      })
    } catch (reason) { setError(message(reason)); void query.refetch() } finally { setPreparing(false) }
  }

  return <section className="rounded-md border border-[#c4cdbb] p-5 sm:p-7" aria-label="Project ownership">
    <h3 className="text-2xl">{state ? isRevnet ? 'INCOME control' : 'FUND ownership' : 'Project ownership'}</h3>
    <p className="mt-2 text-sm">Project #{projectId.toString()} · {displayChainName(chainId)}</p>
    {state && <>
      <dl className="mt-4 grid gap-2 text-sm"><div><dt className="font-medium">{isRevnet ? 'Project NFT owner · REVOwner' : 'Current project owner'}</dt><dd className="mt-1 break-all">{state.owner}</dd></div></dl>
      <p className="mt-3 text-sm">{isRevnet ? 'The revnet contract holds the project NFT. Its current control wallet can move the configured management permissions to another wallet.' : 'The project NFT gives its wallet control over this project. This is separate from holding FUND or INCOME tokens.'}</p>
      {isRevnet && state.isRevnetOperator && <p className="mt-3 break-words text-sm">Connected control wallet: {address}</p>}
    </>}
    {query.isPending && client && !unavailable && <p className="mt-4 text-sm" role="status">Reading project ownership…</p>}
    {query.isError && <p className="mt-4 text-sm text-red-800" role="alert">{message(query.error)} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {!client || unavailable ? <p className="mt-4 text-sm">Project ownership is temporarily unavailable.</p> : !address ? <p className="mt-4 text-sm">Connect your wallet to manage project ownership.</p> : state && !state.canTransfer ? <p className="mt-4 text-sm">{isRevnet ? 'Connect the current INCOME control wallet to transfer its management permissions. Receiving an economic Operator split does not give this authority.' : 'Connect the current project owner or an approved project NFT operator to transfer ownership.'}</p> : null}
    {state?.canTransfer && <form className="mt-5 grid gap-4" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label className="grid gap-2 text-sm">{isRevnet ? 'New control wallet' : 'New project owner wallet'}<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-transparent px-3 text-base" placeholder="0x…" value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); setError(null) }} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      {recipient.trim() && !valid && <p className="text-sm text-red-800">Enter a valid, nonzero wallet address.</p>}
      <label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || !different} /><span>{isRevnet ? 'I understand this transfers the connected wallet’s control permissions to the selected wallet.' : 'I understand the new owner will control this project on this chain.'}</span></label>
      <button className="btn-primary min-h-11 justify-self-start px-5" type="submit" disabled={!different || !confirmed || busy || !tx.ready || query.isError || unavailable}>{preparing ? 'Preparing…' : 'Review ownership change'}</button>
    </form>}
    {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    <ProjectAdminTransactionStatus tx={tx} />
  </section>
}
