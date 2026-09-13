'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { isAddressEqual, zeroAddress, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useWallet } from '@/hooks/useWallet'
import { useProjectAdminTx } from '@/hooks/useProjectAdminTx'
import { displayChainName } from '@/lib/chainDisplay'
import { assertSameProjectSplitsSnapshot, buildProjectSplitsTx, formatSplitPercent, isReservedTokenBurn, RESERVED_TOKEN_BURN_ADDRESS, projectSplitDrafts, readProjectSplitsSnapshot, type ProjectSplit, type ProjectSplitDraft, type ProjectSplitGroup, type ProjectSplitsSnapshot } from '@/lib/project-splits-edit'
import { ProjectAdminTransactionStatus } from './ProjectAdminTransactionStatus'
import { ModalShell } from './ui/ModalShell'

function message(reason: unknown) { return reason instanceof Error ? reason.message : 'Project splits could not be verified.' }
function recipient(split: ProjectSplit, kind: ProjectSplitGroup['kind']): string {
  if (isReservedTokenBurn(split, kind)) return 'Burn tokens (permanently destroyed)'
  if (!isAddressEqual(split.hook, zeroAddress)) return `Hook ${split.hook} · beneficiary ${split.beneficiary}${split.projectId ? ` · project ${split.projectId}` : ''}`
  return split.projectId ? `Project ${split.projectId} · beneficiary ${split.beneficiary}` : isAddressEqual(split.beneficiary, zeroAddress) ? 'Transaction caller (existing zero-address recipient)' : split.beneficiary
}
function lockLabel(timestamp: string | number): string {
  if (!timestamp || timestamp === '0') return 'No lock'
  const date = new Date(Number(timestamp) * 1_000)
  return Number.isNaN(date.valueOf()) ? `Timestamp ${timestamp}` : date.toLocaleString()
}
function dateInputValue(timestamp: string): string {
  if (!timestamp || timestamp === '0') return ''
  const date = new Date(Number(timestamp) * 1_000)
  if (Number.isNaN(date.valueOf()) || date.getFullYear() > 9999) return ''
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}T${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}
type EditorState = { snapshot: ProjectSplitsSnapshot; rulesetId: bigint; group: ProjectSplitGroup; drafts: ProjectSplitDraft[]; allowHookChanges: boolean; allowBurn: boolean }
const fieldClass = 'min-h-11 min-w-0 w-full rounded border border-smoke-300 bg-transparent px-3 py-2 text-base'

export function ProjectSplitsEditor({ chainId, projectId, phase, client, unavailable = false }: { chainId: JBChainId; projectId: bigint; phase: 'fund' | 'income'; client: PublicClient; unavailable?: boolean }) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const [selection, setSelection] = useState<{ rulesetId: string; groupId: string } | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const query = useQuery({ queryKey: ['project-splits-edit', chainId, projectId.toString(), phase, address ?? null], queryFn: () => readProjectSplitsSnapshot(client, { chainId, projectId, phase, account: address }), staleTime: 10_000, refetchInterval: 20_000, retry: 1 })
  const onConfirmed = useCallback(async () => {
    setEditor(null); setError(null)
    for (const key of ['project-splits-edit', 'project-operator-profile', 'income-operator', 'income-reserved', 'income-sticky-binding', 'fund-project', 'income-project']) await cache.invalidateQueries({ queryKey: [key, chainId, projectId.toString()] })
    for (const key of ['sticky-project', 'sticky-rewards']) await cache.invalidateQueries({ queryKey: [key, chainId] })
  }, [cache, chainId, projectId])
  const tx = useProjectAdminTx({ chainId, projectId, onConfirmed })
  const snapshot = query.data
  const stage = snapshot?.stages.find(stage => stage.rulesetId.toString() === selection?.rulesetId) ?? snapshot?.stages[0]
  const group = stage?.groups.find(group => group.groupId.toString() === selection?.groupId) ?? stage?.groups[0]
  const matches = !!address && !!snapshot?.account && isAddressEqual(address, snapshot.account)
  const busy = preparing || tx.busy
  const canEdit = !!snapshot?.canEdit && matches && !query.isError && !unavailable && tx.ready && !busy && !tx.pending
  const holdOpen = preparing || ['review', 'simulating', 'signing'].includes(tx.phase)
  let validation: string | null = null
  if (editor) {
    try { buildProjectSplitsTx(editor.snapshot, editor.rulesetId, editor.group.groupId, editor.drafts, { allowHookChanges: editor.allowHookChanges, allowBurn: editor.allowBurn }) }
    catch (reason) { validation = message(reason) }
  }
  function update(index: number, patch: Partial<ProjectSplitDraft>) { setEditor(current => current ? { ...current, drafts: current.drafts.map((draft, row) => row === index ? { ...draft, ...patch } : draft) } : null); setError(null) }
  async function submit() {
    if (!editor || !address || !canEdit || validation || submitting.current) return
    submitting.current = true; setPreparing(true); setError(null)
    const reviewed = editor
    try {
      const fresh = await readProjectSplitsSnapshot(client, { chainId, projectId, phase, account: address })
      assertSameProjectSplitsSnapshot(reviewed.snapshot, fresh, reviewed.rulesetId, reviewed.group.groupId)
      const request = buildProjectSplitsTx(fresh, reviewed.rulesetId, reviewed.group.groupId, reviewed.drafts, { allowHookChanges: reviewed.allowHookChanges, allowBurn: reviewed.allowBurn })
      const targetStage = fresh.stages.find(stage => stage.rulesetId === reviewed.rulesetId)!
      const splits = request.args[2][0].splits
      const remaining = 1_000_000_000 - splits.reduce((sum, split) => sum + split.percent, 0)
      const allocations = splits.length ? splits.map(split => `${formatSplitPercent(split.percent)}% to ${recipient(split, reviewed.group.kind)}${reviewed.group.kind === 'payout' && split.preferAddToBalance ? ' (add to project balance)' : ''}${split.lockedUntil ? `, locked until ${lockLabel(split.lockedUntil)}` : ''}`).join('; ') : 'No split recipients'
      await tx.send({ ...request, label: `Edit ${reviewed.group.label.toLowerCase()} for ${targetStage.isCurrent ? 'current' : 'queued'} ${phase.toUpperCase()} stage` }, {
        reviewNotice: `${displayChainName(chainId)} · ${phase.toUpperCase()} project ${projectId} · ${targetStage.isCurrent ? 'current' : 'queued'} stage ${reviewed.rulesetId}. ${allocations}. ${remaining ? `${formatSplitPercent(remaining)}% remains for the onchain project Owner ${fresh.owner}. ` : ''}${reviewed.group.kind === 'reserved' && targetStage.isCurrent ? 'This also changes the recipients of any pending reserved tokens distributed after execution. ' : ''}Only this group and stage are changed. The reserved issuance percentage and withdrawal budgets remain as configured.${reviewed.allowHookChanges ? ' Changes to hook allocations were explicitly enabled; these may affect FUND rewards or Sticky distributions.' : ''}`,
        reverify: async () => {
          const latest = await readProjectSplitsSnapshot(client, { chainId, projectId, phase, account: address })
          assertSameProjectSplitsSnapshot(fresh, latest, reviewed.rulesetId, reviewed.group.groupId)
          buildProjectSplitsTx(latest, reviewed.rulesetId, reviewed.group.groupId, reviewed.drafts, { allowHookChanges: reviewed.allowHookChanges, allowBurn: reviewed.allowBurn })
        },
      })
    } catch (reason) { setError(message(reason)) }
    finally { submitting.current = false; setPreparing(false) }
  }

  return <section className="space-y-5" aria-label={`${phase.toUpperCase()} split recipients`}>
    <div><h3 className="text-2xl">Splits</h3><p className="mt-2 text-sm text-smoke-700">Choose a stage to manage its recipients on {displayChainName(chainId)}. Each change applies to one group in that stage.</p></div>
    {query.isPending && <p role="status">Reading project recipients and permissions…</p>}
    {query.isError && <p role="alert" className="text-sm text-red-800">{message(query.error)} <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {snapshot && stage && group && <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">Stage<select className={fieldClass} value={stage.rulesetId.toString()} onChange={event => setSelection({ rulesetId: event.target.value, groupId: group.groupId.toString() })}>{snapshot.stages.map(stage => <option key={stage.rulesetId.toString()} value={stage.rulesetId.toString()}>{stage.isCurrent ? 'Current' : 'Queued'} stage {stage.rulesetId.toString()}{!stage.isCurrent ? ` · ${lockLabel(stage.start.toString())}` : ''}</option>)}</select></label>
        <label className="grid gap-2 text-sm">Split group<select className={fieldClass} value={group.groupId.toString()} onChange={event => setSelection({ rulesetId: stage.rulesetId.toString(), groupId: event.target.value })}>{stage.groups.map(group => <option key={group.groupId.toString()} value={group.groupId.toString()}>{group.label}</option>)}</select></label>
      </div>
      <p className="text-sm text-smoke-700">{group.kind === 'reserved' ? <>This stage reserves {stage.reservedPercent / 100}% of newly issued tokens. The shares below divide that reserved amount.</> : <>These shares divide payouts in this token. Withdrawal budgets are configured separately.</>}</p>
      <SplitRows splits={group.splits} timestamp={snapshot.blockTimestamp} kind={group.kind} />
      <p className="break-words text-sm text-smoke-700">{formatSplitPercent(1_000_000_000 - group.splits.reduce((sum, split) => sum + split.percent, 0))}% unallocated, sent to the onchain project Owner: <span className="font-mono">{snapshot.owner}</span>.</p>
      {group.fallback.length > 0 && <details className="rounded border border-smoke-200 p-4 text-sm"><summary className="cursor-pointer">Default recipients</summary><p className="my-3">These apply when this stage has no explicit recipients. To avoid activating them unintentionally, keep at least one recipient when replacing this group.</p><SplitRows splits={group.fallback} timestamp={snapshot.blockTimestamp} kind={group.kind} /></details>}
      {!snapshot.canEdit || !matches ? <p className="text-sm text-smoke-700">Connect the Owner or a wallet with permission to edit split groups.</p> : null}
      <button type="button" className="btn-secondary min-h-11 px-5" disabled={!canEdit} onClick={() => { setError(null); setEditor({ snapshot, rulesetId: stage.rulesetId, group, drafts: projectSplitDrafts(group), allowHookChanges: false, allowBurn: false }) }}>Edit recipients</button>
    </>}
    <ProjectAdminTransactionStatus tx={tx} />
    {editor && <ModalShell title={`Edit ${editor.group.label.toLowerCase()}`} subtitle={`${phase.toUpperCase()} · stage ${editor.rulesetId} · ${displayChainName(chainId)}`} maxWidth="max-w-3xl" busy={holdOpen} onClose={() => setEditor(null)} footer={<div className="flex flex-wrap justify-end gap-3"><button type="button" className="btn-secondary min-h-11 px-5" onClick={() => setEditor(null)} disabled={holdOpen}>Close</button><button type="button" className="btn-primary min-h-11 px-5" onClick={() => void submit()} disabled={!canEdit || !!validation}>{preparing ? 'Preparing…' : tx.pending ? 'Awaiting confirmation…' : 'Review changes'}</button></div>}>
      <div className="space-y-5">
        {editor.drafts.map((draft, index) => {
          const original = draft.sourceIndex === undefined ? undefined : editor.group.splits[draft.sourceIndex]
          const hooked = !!original && !isAddressEqual(original.hook, zeroAddress)
          const locked = !!original && BigInt(original.lockedUntil) > editor.snapshot.blockTimestamp
          const immutable = busy || locked || (hooked && !editor.allowHookChanges)
          return <fieldset key={draft.sourceIndex === undefined ? `new-${index}` : `old-${draft.sourceIndex}`} className="space-y-4 rounded border border-smoke-200 p-4" disabled={busy}>
            <legend className="px-1 text-sm">Recipient {index + 1}</legend>
            {hooked && <p className="break-words text-xs text-smoke-700">Hook: {original.hook}. Existing routing is preserved.</p>}
            {locked && <p className="text-sm text-smoke-700">Locked until {lockLabel(original.lockedUntil)}. Its recipient and percentage must stay the same until then.</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm">Share (%)<input className={fieldClass} inputMode="decimal" maxLength={20} value={draft.percent} disabled={immutable} onChange={event => update(index, { percent: event.target.value })} /></label>
              <label className="grid gap-2 text-sm">Recipient type<select className={fieldClass} value={draft.recipient} disabled={immutable || hooked} onChange={event => update(index, { recipient: event.target.value as 'wallet' | 'project', preferAddToBalance: editor.group.kind === 'payout' ? false : draft.preferAddToBalance })}><option value="wallet">Wallet</option><option value="project">Juicebox project</option></select></label>
            </div>
            {draft.recipient === 'project' && <label className="grid gap-2 text-sm">Recipient project ID<input className={fieldClass} inputMode="numeric" value={draft.projectId} disabled={immutable || hooked} onChange={event => update(index, { projectId: event.target.value })} /></label>}
            <label className="grid gap-2 text-sm">{draft.recipient === 'project' ? 'Wallet receiving project tokens or fallback funds' : 'Recipient wallet'}<input className={`${fieldClass} font-mono`} autoComplete="off" spellCheck={false} placeholder="0x…" value={draft.beneficiary} disabled={immutable || hooked} onChange={event => update(index, { beneficiary: event.target.value.trim() })} /></label>
            {draft.recipient === 'project' && editor.group.kind === 'payout' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.preferAddToBalance} disabled={immutable || hooked} onChange={event => update(index, { preferAddToBalance: event.target.checked })} />Add to the recipient project’s balance without issuing its tokens</label>}
            <label className="grid gap-2 text-sm">Locked until (your local time)<input type="datetime-local" step="1" className={fieldClass} value={dateInputValue(draft.lockedUntil)} disabled={busy || (hooked && !editor.allowHookChanges)} onChange={event => update(index, { lockedUntil: event.target.value ? Math.floor(new Date(event.target.value).valueOf() / 1_000).toString() : '' })} /></label>
            {!!draft.lockedUntil && !dateInputValue(draft.lockedUntil) && <p className="text-sm">Existing lock: {lockLabel(draft.lockedUntil)}.</p>}
            <button type="button" className="min-h-11 text-sm underline" disabled={immutable} onClick={() => { setEditor(current => current ? { ...current, drafts: current.drafts.filter((_, row) => row !== index) } : null); setError(null) }}>Remove recipient {index + 1}</button>
          </fieldset>
        })}
        {editor.group.splits.some(split => !isAddressEqual(split.hook, zeroAddress)) && <label className="flex items-start gap-3 rounded border border-smoke-200 p-4 text-sm"><input type="checkbox" className="mt-1" checked={editor.allowHookChanges} disabled={busy} onChange={event => setEditor(current => current ? { ...current, allowHookChanges: event.target.checked } : null)} /><span>Allow changes to existing hook allocations. Changing or removing these shares may affect FUND rewards or Sticky distributions.</span></label>}
        {editor.group.kind === 'reserved' && editor.drafts.some(draft => draft.recipient === 'wallet' && draft.beneficiary.toLowerCase() === RESERVED_TOKEN_BURN_ADDRESS.toLowerCase() && (draft.sourceIndex === undefined || isAddressEqual(editor.group.splits[draft.sourceIndex].hook, zeroAddress))) && <label className="flex items-start gap-3 rounded border border-smoke-200 p-4 text-sm"><input type="checkbox" className="mt-1" checked={editor.allowBurn} disabled={busy} onChange={event => setEditor(current => current ? { ...current, allowBurn: event.target.checked } : null)} /><span>Confirm burning reserved tokens sent directly to the burn address. These tokens are permanently destroyed instead of being received by a wallet.</span></label>}
        <button type="button" className="btn-secondary min-h-11 px-5" disabled={busy || editor.drafts.length >= 64} onClick={() => setEditor(current => current ? { ...current, drafts: [...current.drafts, { percent: '', recipient: 'wallet', beneficiary: '', projectId: '', preferAddToBalance: false, lockedUntil: '' }] } : null)}>Add recipient</button>
        <p className="text-sm text-smoke-700">Any unallocated share goes to the onchain project Owner. A lock protects the exact recipient and percentage within this stage until its expiry.</p>
        {validation && <p className="text-sm text-smoke-700" role="status">{validation}</p>}
        {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
        <ProjectAdminTransactionStatus tx={tx} />
      </div>
    </ModalShell>}
  </section>
}

function SplitRows({ splits, timestamp, kind }: { splits: readonly ProjectSplit[]; timestamp: bigint; kind: 'reserved' | 'payout' }) {
  return splits.length ? <ul className="divide-y divide-smoke-200 rounded border border-smoke-200">{splits.map((split, index) => <li key={index} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:gap-4"><span className="shrink-0 font-medium sm:w-28">{formatSplitPercent(split.percent)}%</span><div className="min-w-0 break-words text-sm"><p>{recipient(split, kind)}</p>{kind === 'payout' && split.preferAddToBalance && <p className="mt-1 text-xs text-smoke-700">Add to project balance</p>}{BigInt(split.lockedUntil) > timestamp && <p className="mt-1 text-xs text-smoke-700">Locked until {lockLabel(split.lockedUntil)}</p>}</div></li>)}</ul> : <p className="rounded border border-smoke-200 p-4 text-sm">No split recipients. The entire share goes to the onchain project Owner.</p>
}
