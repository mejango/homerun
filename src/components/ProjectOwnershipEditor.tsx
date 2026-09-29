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
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'

export type ProjectAuthorityEditorProps = { chainId: JBChainId; projectId: bigint; client: PublicClient | null | undefined; unavailable?: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : 'Project ownership could not be read.'

export function ProjectOwnershipEditor({ chainId, projectId, client, unavailable = false }: ProjectAuthorityEditorProps) {
  const { address } = useWallet()
  const [recipient, setRecipient] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  // Juicebox Money's confirm dialog: the change, then one action.
  const [reviewing, setReviewing] = useState(false)
  const valid = isAddress(recipient.trim()) && !isAddressEqual(recipient.trim() as Address, zeroAddress)
  const query = useQuery({
    queryKey: ['project-authority', chainId, projectId.toString(), address ?? null, valid ? recipient.trim().toLowerCase() : null],
    queryFn: () => readProjectAuthority(client!, { chainId, projectId, account: address, operator: valid ? recipient.trim() as Address : null }),
    enabled: !!client && !unavailable, retry: 1,
  })
  const tx = useProjectAdminTx({ chainId, projectId, onConfirmed: async () => { await query.refetch() } })
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

  return <section className="demo-section" aria-label="Project ownership">
    <h2>{state ? isRevnet ? 'INCOME control' : 'FUND ownership' : 'Project ownership'}</h2>
    {state && <>
      <dl className="demo-live-rows"><div><dt>Project</dt><dd>#{projectId.toString()} on {displayChainName(chainId)}</dd></div><div><dt>{isRevnet ? 'Project NFT owner · REVOwner' : 'Current project owner'}</dt><dd className="break-all">{state.owner}</dd></div>{isRevnet && state.isRevnetOperator && <div><dt>Connected control wallet</dt><dd className="break-all">{address}</dd></div>}</dl>
      <p className="mt-4 text-xs text-[var(--muted)]">{isRevnet ? 'The revnet contract holds the project NFT. Its control wallet can move the management permissions to another wallet.' : 'The project NFT controls this project. It is separate from holding FUND or INCOME.'}</p>
    </>}
    {!state && <p className="text-sm text-[var(--muted)]">Project #{projectId.toString()} on {displayChainName(chainId)}</p>}
    {query.isPending && client && !unavailable && <p className="mt-4 text-sm" role="status">Reading project ownership…</p>}
    {query.isError && <p className="mt-4 text-sm text-red-800" role="alert">{message(query.error)} <button type="button" className="quiet-button" onClick={() => void query.refetch()}>Retry</button></p>}
    {!client || unavailable ? <p className="mt-4 text-sm text-[var(--muted)]">Project ownership is temporarily unavailable.</p> : !address ? <p className="mt-4 text-sm text-[var(--muted)]">Connect your wallet to manage project ownership.</p> : state && !state.canTransfer ? <p className="mt-4 text-sm text-[var(--muted)]">{isRevnet ? 'Connect the INCOME control wallet to transfer its permissions. An Operator split does not give this authority.' : 'Connect the project owner or an approved project NFT operator to transfer ownership.'}</p> : null}
    {state?.canTransfer && <form className="mt-6 grid gap-4 border-t border-[var(--line)] pt-6" onSubmit={event => { event.preventDefault(); tx.reset(); setError(null); setReviewing(true) }}>
      <label className="grid gap-2 text-sm">{isRevnet ? 'New control wallet' : 'New project owner wallet'}<input className="min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" placeholder="0x…" value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); setError(null) }} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      {recipient.trim() && !valid && <p className="text-sm text-red-800">Enter a valid, nonzero wallet address.</p>}
      <label className="flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || !different} /><span>{isRevnet ? 'I understand this transfers the connected wallet’s control permissions to the selected wallet.' : 'I understand the new owner will control this project on this chain.'}</span></label>
      <button className="btn-primary min-h-11 justify-self-start px-5" type="submit" disabled={!different || !confirmed || busy || !tx.ready || query.isError || unavailable}>Review ownership change</button>
    </form>}
    {error && !reviewing && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    {!reviewing && <ProjectAdminTransactionStatus tx={tx} />}
    <TxConfirmDialog
      open={reviewing && !!state}
      eyebrow={isRevnet ? 'INCOME control' : 'Project ownership'}
      title={tx.phase === 'success' ? (isRevnet ? 'Control moved' : 'Ownership transferred') : isRevnet ? 'Move INCOME control' : 'Transfer ownership'}
      rows={state ? [
        { label: 'Project', value: `#${projectId.toString()} on ${displayChainName(chainId)}` },
        { label: 'From', value: isRevnet ? address ?? '' : state.owner, mono: true },
        { label: 'To', value: recipient.trim(), mono: true, strong: true },
      ] : []}
      steps={[{ key: 'transfer', title: isRevnet ? 'Move the control permissions' : 'Transfer the project NFT', detail: isRevnet ? 'The project NFT stays with REVOwner.' : 'Other chains need their own transfers.' }]}
      activeIndex={busy ? 0 : -1}
      action="Confirm & transfer"
      onConfirm={() => void submit()}
      busy={preparing || (tx.busy && !tx.pending)}
      complete={tx.phase === 'success'}
      error={error}
      onClose={() => { if (tx.phase === 'success') { setRecipient(''); setConfirmed(false) } setReviewing(false) }}
    >
      <p className="text-sm text-smoke-600">{isRevnet ? 'The selected wallet gets this revnet’s Operator permissions; the connected wallet’s are cleared.' : 'The new owner controls this project on this chain. Existing permissions granted by the previous owner stop applying.'}</p>
      <ProjectAdminTransactionStatus tx={tx} />
    </TxConfirmDialog>
  </section>
}
