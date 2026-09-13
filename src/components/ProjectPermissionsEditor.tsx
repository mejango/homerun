'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { useWallet } from '@/hooks/useWallet'
import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { buildProjectPermissionsTx, PROJECT_PERMISSION_CATALOG, projectPermissionIds, readProjectAuthority, reverifyProjectAuthority, unknownProjectPermissionIds, type ProjectAuthorityState } from '@/lib/project-authority'
import { displayChainName } from '@/lib/chainDisplay'
import { ProjectAdminTransactionStatus } from './ProjectAdminTransactionStatus'
import type { ProjectAuthorityEditorProps } from './ProjectOwnershipEditor'

const message = (error: unknown) => error instanceof Error ? error.message : 'Project permissions could not be read.'

export function ProjectPermissionsEditor({ chainId, projectId, client, unavailable = false }: ProjectAuthorityEditorProps) {
  const { address } = useWallet()
  const [wallet, setWallet] = useState('')
  const [operator, setOperator] = useState<Address | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const query = useQuery({
    queryKey: ['project-authority', chainId, projectId.toString(), address ?? null, operator?.toLowerCase() ?? null],
    queryFn: () => readProjectAuthority(client!, { chainId, projectId, account: address, operator }),
    enabled: !!client && !unavailable, staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  const tx = useProjectAdminTx({ chainId, projectId, onConfirmed: async () => { await query.refetch() } })
  const state = query.data
  const valid = isAddress(wallet.trim()) && !isAddressEqual(wallet.trim() as Address, zeroAddress)
  const busy = preparing || tx.busy

  async function submit(reviewed: ProjectAuthorityState, selected: number[], rootConfirmed: boolean) {
    if (!client || !address || busy || !tx.ready) return
    setPreparing(true); setError(null)
    try {
      if (selected.includes(JBPermissionIdsV6.ROOT) && !rootConfirmed) throw new Error('Confirm the ROOT permission before continuing.')
      const request = buildProjectPermissionsTx(reviewed, selected)
      await reverifyProjectAuthority(client, reviewed, request, latest => buildProjectPermissionsTx(latest, selected))
      const previous = projectPermissionIds(reviewed.operatorPermissions)
      const added = selected.filter(id => !previous.includes(id))
      const removed = previous.filter(id => PROJECT_PERMISSION_CATALOG.some(entry => entry.id === id) && !selected.includes(id))
      const names = (ids: number[]) => ids.map(id => PROJECT_PERMISSION_CATALOG.find(entry => entry.id === id)?.label ?? `Permission ${id}`).join(', ') || 'None'
      const unknown = unknownProjectPermissionIds(reviewed.operatorPermissions)
      await tx.send(request, {
        reviewNotice: `On ${displayChainName(chainId)}, update ${reviewed.operator} as a delegate of owner ${reviewed.owner} for project #${projectId} only. Grant: ${names(added)}. Revoke: ${names(removed)}. ${selected.includes(JBPermissionIdsV6.ROOT) ? 'ROOT authorizes every Juicebox project permission and lets this delegate grant non-ROOT permissions to others. It does not transfer the project NFT. ' : ''}${unknown.length ? `Preserve unrecognized permissions ${unknown.join(', ')}. ` : ''}Permissions inherited from the owner’s global grants remain effective and are not edited here.`,
        reverify: checked => reverifyProjectAuthority(client, reviewed, checked, latest => buildProjectPermissionsTx(latest, selected)),
      })
    } catch (reason) { setError(message(reason)); void query.refetch() } finally { setPreparing(false) }
  }

  return <section className="rounded-md border border-[#c4cdbb] p-5 sm:p-7" aria-label="Project permissions">
    <h3 className="text-2xl">{state ? `${state.kind === 'revnet' ? 'INCOME' : 'FUND'} permissions` : 'Permissions'}</h3>
    <p className="mt-2 text-sm">Project #{projectId.toString()} · {displayChainName(chainId)}</p>
    <p className="mt-3 text-sm">Look up a wallet’s permissions and choose what it can do for this project on {displayChainName(chainId)}. Changes apply only to this project.</p>
    {state?.kind === 'revnet' && !state.canManagePermissions && <p className="mt-3 text-sm">REVOwner defines this revnet’s control permissions. Its standard control wallet cannot grant additional permissions; ownership control can be moved in the ownership section.</p>}
    {state && state.kind !== 'revnet' && !state.canManagePermissions && <p className="mt-3 text-sm">Connect the project owner or a delegate with ROOT to edit permissions.</p>}
    <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (valid) { setOperator(wallet.trim() as Address); setError(null) } }}>
      <label className="grid min-w-0 flex-1 gap-2 text-sm">Delegate wallet<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-transparent px-3 text-base" placeholder="0x…" value={wallet} onChange={event => setWallet(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <button type="submit" className="btn-secondary min-h-12 px-5" disabled={!valid || busy || unavailable || !client}>Look up permissions</button>
    </form>
    {query.isPending && client && !unavailable && <p className="mt-4 text-sm" role="status">Reading project permissions…</p>}
    {query.isError && <p className="mt-4 text-sm text-red-800" role="alert">{message(query.error)} <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {(!client || unavailable) && <p className="mt-4 text-sm">Project permissions are temporarily unavailable.</p>}
    {state?.operator && <PermissionSelection key={state.identity} state={state} disabled={busy || !tx.ready || unavailable || query.isError} onSubmit={submit} />}
    {error && <p className="mt-4 text-sm text-red-800" role="alert">{error}</p>}
    <ProjectAdminTransactionStatus tx={tx} />
  </section>
}

function PermissionSelection({ state, disabled, onSubmit }: { state: ProjectAuthorityState; disabled: boolean; onSubmit: (state: ProjectAuthorityState, selected: number[], rootConfirmed: boolean) => Promise<void> }) {
  const original = projectPermissionIds(state.operatorPermissions)
  const [selected, setSelected] = useState(original.filter(id => PROJECT_PERMISSION_CATALOG.some(entry => entry.id === id)))
  const [rootConfirmed, setRootConfirmed] = useState(false)
  const inherited = projectPermissionIds(state.operatorGlobalPermissions)
  const unknown = unknownProjectPermissionIds(state.operatorPermissions)
  const isOwnerWallet = !!state.operator && isAddressEqual(state.operator, state.owner)
  const canEdit = state.canManagePermissions && !isOwnerWallet
  const hasRoot = selected.includes(JBPermissionIdsV6.ROOT)
  const inheritedRoot = inherited.includes(JBPermissionIdsV6.ROOT)
  const changed = selected.join(',') !== original.filter(id => PROJECT_PERMISSION_CATALOG.some(entry => entry.id === id)).join(',')
  return <form className="mt-6" onSubmit={event => { event.preventDefault(); void onSubmit(state, selected, rootConfirmed) }}>
    <p className="break-all text-sm">Permissions for {state.operator}</p>
    {isOwnerWallet && <p className="mt-3 text-sm">This wallet owns the project and already has full owner authority.</p>}
    {inherited.length > 0 && <p className="mt-3 text-sm">Inherited from global grants: {inherited.map(id => PROJECT_PERMISSION_CATALOG.find(entry => entry.id === id)?.label ?? `Permission ${id}`).join(', ')}. These remain effective even if their project checkbox is cleared.</p>}
    {unknown.length > 0 && <p className="mt-3 text-sm">Unrecognized project permissions {unknown.join(', ')} are preserved when saving.</p>}
    <fieldset className="mt-5 grid gap-3 sm:grid-cols-2" disabled={disabled || !canEdit}>
      <legend className="mb-3 text-sm font-medium">Project permissions</legend>
      {PROJECT_PERMISSION_CATALOG.map(entry => <label key={entry.id} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={selected.includes(entry.id)} disabled={disabled || !canEdit || (entry.id === JBPermissionIdsV6.ROOT && !state.isOwner && !hasRoot)} onChange={event => { setSelected(current => event.target.checked ? [...current, entry.id].sort((a, b) => a - b) : current.filter(id => id !== entry.id)); setRootConfirmed(false) }} /><span>{entry.label}{(inheritedRoot || inherited.includes(entry.id)) && <span className="block text-xs text-[#596653]">Also granted globally</span>}</span></label>)}
    </fieldset>
    {hasRoot && canEdit && !state.isOwner && <p className="mt-4 text-sm">A ROOT delegate can save non-ROOT permissions only. Clear ROOT to revoke it, or connect the project owner to retain it.</p>}
    {hasRoot && canEdit && state.isOwner && <label className="mt-5 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={rootConfirmed} disabled={disabled} onChange={event => setRootConfirmed(event.target.checked)} /><span>I understand ROOT gives every Juicebox project permission and lets this wallet delegate non-ROOT powers to others.</span></label>}
    {canEdit && <button type="submit" className="btn-primary mt-5 min-h-11 px-5" disabled={disabled || !changed || (hasRoot && (!state.isOwner || !rootConfirmed))}>Review permission changes</button>}
  </form>
}
