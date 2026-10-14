'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Project721Tier } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isAddressEqual, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { newDemoShopItem, type DemoShopItem } from '@/lib/demo-shop'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { assertNoViewAs } from '@/lib/viewAs'
import {
  prepareProjectShopWrite, projectShopWriteRequest, readProjectShopWriteState, reverifyProjectShopWrite,
  type ProjectShopWriteState,
} from '@/lib/project-shop-write'
import {
  clearShopWriteSession, confirmShopWriteStep, dropShopWritePending, readShopWriteSession, shopPendingHold, shopStepIntent,
  shopWriteSessionKey, startShopWriteSession, restoreShopWritePermissions, shopWriteRequestIndex, shopWriteRequestIndices,
  verifyShopWriteProgress, withShopWriteLock, type ShopWriteSession,
} from '@/lib/project-shop-session'
import { adoptLegacyWrite } from '@/lib/write-hold'
import { HeldNotice } from '@/components/ui/HeldWriteExit'
import { ShopItemEditor, type ShopItemEditorState } from '@/components/ShopItemEditor'
import { ModalShell } from '@/components/ui/ModalShell'

const SESSION_EVENT = 'homerun-shop-session'
const message = (error: unknown) => error instanceof Error ? error.message : 'The shop update could not be completed. Try again.'
type Editor = { initial: ShopItemEditorState; snapshot: ProjectShopWriteState }
type ManagementSlots = { toolbar: ReactNode; notice: ReactNode; itemActions: (tier: Project721Tier) => ReactNode }

/** Keeps receipt tracking mounted when inventory, wallet identity or project reads refresh. */
export function ProjectShopManagement({ chainId, projectId, client, unavailable, children }: {
  chainId: JBChainId; projectId: bigint; client?: PublicClient; unavailable: boolean; children: (slots: ManagementSlots) => ReactNode
}) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useSafeTx(chainId)
  const resetTx = tx.reset
  const key = shopWriteSessionKey(chainId, projectId)
  const [session, setSession] = useState<ShopWriteSession | null>(null)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [retryDraft, setRetryDraft] = useState<Editor | null>(null)
  const [removing, setRemoving] = useState<Project721Tier | null>(null)
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checkedProgress, setCheckedProgress] = useState('')
  const action = useRef(false)
  const state = useQuery({
    queryKey: ['project-shop-write', chainId, projectId.toString(), address ?? null],
    enabled: !!client && !!address && !unavailable,
    queryFn: () => readProjectShopWriteState(client!, { chainId, projectId, account: address! }),
    retry: 1,
  })

  const refreshSession = useCallback(() => {
    try { setSession(readShopWriteSession(localStorage, key)); setStorageError(null) }
    catch (reason) { setStorageError(message(reason)) }
    finally { setReady(true) }
  }, [key])
  useEffect(() => {
    refreshSession()
    window.addEventListener('storage', refreshSession)
    window.addEventListener(SESSION_EVENT, refreshSession)
    return () => { window.removeEventListener('storage', refreshSession); window.removeEventListener(SESSION_EVENT, refreshSession) }
  }, [refreshSession])

  const invalidate = useCallback(async () => {
    await Promise.all(['project-shop', 'project-shop-write', 'fund-project', 'income-project'].map(prefix => cache.invalidateQueries({ queryKey: [prefix, chainId, projectId.toString()] })))
  }, [cache, chainId, projectId])
  function changed() { refreshSession(); window.dispatchEvent(new Event(SESSION_EVENT)) }
  const progressKey = session ? `${session.id}:${session.completed.length}` : ''
  useEffect(() => {
    if (!client || !session) return
    let cancelled = false
    void verifyShopWriteProgress(client, session).then(() => {
      if (!cancelled) setCheckedProgress(`${session.id}:${session.completed.length}`)
    }).catch(reason => { if (!cancelled) { setCheckedProgress(''); setError(message(reason)) } })
    return () => { cancelled = true }
  }, [client, session])

  /** The step this screen sent or adopted: what its settled execution is recorded against. */
  const sent = useRef<{ session: string; step: number; safe: boolean; afterBlock: bigint } | null>(null)
  const track = tx.track
  // A step the journal saved as pending before SDK holds is adopted into its hold, then dropped from the journal.
  useEffect(() => {
    if (!client || !session?.pending) return
    const captured = session
    let cancelled = false
    void withShopWriteLock(key, async () => {
      const pending = shopPendingHold(captured)
      if (!pending) return
      await adoptLegacyWrite(pending.input, pending.evidence, client)
      const next = dropShopWritePending(localStorage, key, captured)
      if (cancelled) return
      sent.current = { session: next.id, step: pending.step, safe: !!pending.input.safe, afterBlock: BigInt(captured.pending!.afterBlock) }
      setSession(next); window.dispatchEvent(new Event(SESSION_EVENT))
      await track(projectShopWriteRequest(next.plan, pending.step), { reviewedAccount: next.plan.snapshot.account, recoveryNamespace: pending.input.namespace, safe: pending.input.safe })
    }).catch(reason => { if (!cancelled) setStorageError(message(reason)) })
    return () => { cancelled = true }
  }, [client, key, session, track])

  // The SDK's hold settled the step: its exact execution is verified and recorded before the next one.
  const settledReceipt = tx.phase === 'success' ? tx.receipt : null
  const submissionHash = tx.submissionHash
  useEffect(() => {
    const step = sent.current
    if (!client || !settledReceipt || !session || !step || step.session !== session.id || shopWriteRequestIndex(session) !== step.step) return
    const captured = session
    let cancelled = false
    void withShopWriteLock(key, async () => {
      const result = await confirmShopWriteStep(client, localStorage, key, captured, { safe: step.safe, hash: submissionHash ?? undefined, afterBlock: step.afterBlock }, settledReceipt.transactionHash)
      if (cancelled) return
      sent.current = null
      setSession(result.session)
      resetTx()
      setCheckedProgress(`${result.session.id}:${result.session.completed.length}`)
      setProgress(result.status === 'reverted' ? 'The transaction reverted. Review this step and try again.' : 'Transaction confirmed.')
      setError(null)
      window.dispatchEvent(new Event(SESSION_EVENT))
      await invalidate()
    }).catch(reason => { if (!cancelled) setError(message(reason)) })
    return () => { cancelled = true }
  }, [client, invalidate, key, resetTx, session, settledReceipt, submissionHash])

  const snapshot = state.data
  const canStart = ready && !storageError && !session && !unavailable && !state.isError && !!snapshot && !!address && isAddressEqual(snapshot.account, address)
  const busy = working || tx.busy || tx.phase === 'review'
  /** A step is with the wallet, the chain or a Safe: nothing else is reviewed meanwhile. */
  const stepActive = tx.busy || tx.phase === 'review' || tx.phase === 'submitted' || tx.phase === 'success'
  const indices = session ? shopWriteRequestIndices(session) : []
  const complete = !!session && session.completed.length === indices.length && checkedProgress === progressKey
  const accountMatches = !!session && !!address && isAddressEqual(address, session.plan.snapshot.account)

  function add() {
    if (!canStart || !snapshot?.canAdd || !snapshot.currency) return
    setError(null)
    setEditor({ snapshot, initial: { mode: 'add', items: [newDemoShopItem()], currency: snapshot.currency } })
  }
  async function prepare(captured: ProjectShopWriteState, items: DemoShopItem[] = [], removeTierIds: number[] = []) {
    if (!client || action.current || !ready || storageError) return
    action.current = true; setWorking(true); setOpen(true); setError(null); setProgress('Checking shop permissions…')
    try {
      assertNoViewAs()
      const plan = await prepareProjectShopWrite(client, { snapshot: captured, items, removeTierIds, onStatus: setProgress })
      await withShopWriteLock(key, async () => {
        const next = startShopWriteSession(localStorage, key, plan)
        setSession(next); window.dispatchEvent(new Event(SESSION_EVENT))
      })
      setProgress('Ready to review the transaction.'); setRetryDraft(null)
    } catch (reason) { setError(message(reason)) }
    finally { action.current = false; setWorking(false) }
  }
  async function submit() {
    if (!client || !session || !address || !accountMatches || complete || action.current || storageError) return
    const captured = session
    const account = address
    action.current = true; setWorking(true); setError(null)
    try {
      assertNoViewAs()
      await withShopWriteLock(key, async () => {
        let prerequisiteBlock = await verifyShopWriteProgress(client, captured)
        const index = shopWriteRequestIndex(captured)
        if (index === null) throw new Error('This shop update is already complete.')
        const request = projectShopWriteRequest(captured.plan, index)
        await reverifyProjectShopWrite(client, captured.plan, account, index, request)
        const remember = () => { sent.current = { session: captured.id, step: index, safe: tx.isSafe, afterBlock: prerequisiteBlock } }
        remember()
        await tx.send(request, {
          reviewedAccount: captured.plan.snapshot.account,
          recoveryNamespace: shopStepIntent(captured, index),
          reviewNotice: captured.restoring ? 'Cancel shop creation by restoring the shop deployer’s previous permissions for this project. No shop will be created.' : captured.plan.notice,
          reverify: async reviewed => {
            prerequisiteBlock = await verifyShopWriteProgress(client, captured)
            await reverifyProjectShopWrite(client, captured.plan, account, index, reviewed)
            remember()
          },
          beforeWrite: async () => {
            const currentBlock = await client.getBlock({ blockTag: 'latest' })
            if (currentBlock.number === null) throw new Error('The latest block could not be read.')
            if (currentBlock.number < prerequisiteBlock) throw new Error('The network has not caught up with the previous shop transaction. Try again shortly.')
          },
        })
      })
    } catch (reason) { setError(message(reason)) }
    finally { action.current = false; setWorking(false) }
  }
  async function finish() {
    if (!session || !client || action.current) return
    action.current = true; setWorking(true)
    try {
      await withShopWriteLock(key, async () => {
        await clearShopWriteSession(localStorage, key, session, client)
        changed()
      })
      tx.reset(); setOpen(false); setProgress(''); setError(null); setRetryDraft(null)
    } catch (reason) { setError(message(reason)) }
    finally { action.current = false; setWorking(false) }
  }
  async function restore() {
    if (!client || !session || action.current || !accountMatches) return
    action.current = true; setWorking(true); setError(null)
    try {
      await withShopWriteLock(key, async () => {
        await verifyShopWriteProgress(client, session)
        const next = restoreShopWritePermissions(localStorage, key, session)
        setSession(next); window.dispatchEvent(new Event(SESSION_EVENT))
      })
      resetTx(); setProgress('Review the transaction to restore the shop deployer’s previous permissions. No shop will be created.')
    } catch (reason) { setError(message(reason)) }
    finally { action.current = false; setWorking(false) }
  }

  const lastHash = session?.completed.at(-1)?.executionHash
  const link = tx.hash ? explorerTxUrl(chainId, tx.hash) : lastHash ? explorerTxUrl(chainId, lastHash) : null
  const toolbar = session ? <button type="button" className="ds-button ds-button-secondary" onClick={() => setOpen(true)}>{complete ? 'Shop update complete' : 'Resume shop update'}</button>
    : snapshot?.canAdd && <button type="button" className="ds-button ds-button-primary" disabled={!canStart || busy} onClick={add}>Add items for sale</button>
  const notice = <>
    {storageError && <p role="alert" className="mb-4 text-sm">{storageError}</p>}
    {address && state.isError && <p role="status" className="mb-4 text-sm">Shop permissions could not be checked. <button type="button" className="underline" onClick={() => void state.refetch()}>Try again</button></p>}
    {address && !session && snapshot?.blockedReason && <p className="mb-4 text-sm">{snapshot.blockedReason}</p>}
  </>
  return <>
    {children({ toolbar, notice, itemActions: tier => snapshot?.canRemove ? <button type="button" className="mt-4 text-sm underline" disabled={!canStart || busy} onClick={() => { setError(null); setRemoving(tier) }}>Remove item #{tier.id}</button> : null })}
    {editor && <ShopItemEditor initial={editor.initial} categories={[]} maximumItems={20} priceDecimals={editor.snapshot.pricing.decimals} variant="live" onClose={() => setEditor(null)} onSave={items => {
      setRetryDraft({ ...editor, initial: { ...editor.initial, items } }); setEditor(null); void prepare(editor.snapshot, items)
    }} />}
    {removing && <ModalShell title={`Remove item #${removing.id}?`} subtitle="Existing owners keep their items. New purchases of this item will stop." onClose={() => setRemoving(null)} footer={<div className="ds-footer"><button type="button" className="ds-button ds-button-secondary" onClick={() => setRemoving(null)}>Keep item</button><button type="button" className="ds-button ds-button-primary" disabled={!canStart || busy} onClick={() => { const tier = removing; setRemoving(null); if (snapshot) void prepare(snapshot, [], [tier.id]) }}>Continue to transaction</button></div>}><p className="text-sm">Review the removal before confirming it in your wallet.</p></ModalShell>}
    {open && <ModalShell title={complete ? session?.restoring ? 'Shop creation cancelled' : 'Shop updated' : session?.restoring ? 'Restore shop permissions' : session?.plan.snapshot.mode === 'create' ? 'Create your shop' : 'Update your shop'} onClose={() => { if (!working && tx.phase !== 'review' && tx.phase !== 'signing') setOpen(false) }} busy={working || tx.phase === 'review' || tx.phase === 'signing'} footer={<div className="ds-footer">
      {complete ? <button type="button" className="ds-button ds-button-primary" onClick={() => void finish()}>Done</button>
        : session ? <>
          {!stepActive && session.completed.length === 0 && <button type="button" className="ds-button ds-button-secondary" disabled={busy} onClick={() => void finish()}>Cancel update</button>}
          {!stepActive && !session.restoring && session.completed.length === 1 && session.plan.requestKinds.join(',') === 'grant,create,restore' && <button type="button" className="ds-button ds-button-secondary" disabled={busy || !accountMatches} onClick={() => void restore()}>Cancel creation and restore permissions</button>}
          {(!stepActive || tx.phase === 'submitted') && <button type="button" className="ds-button ds-button-primary" disabled={busy || !accountMatches || checkedProgress !== progressKey || !!storageError} onClick={() => void submit()}>{txPhaseLabel(tx.phase, { idle: 'Review transaction', pending: 'Waiting for confirmation…' })}</button>}
        </> : !working && <button type="button" className="ds-button ds-button-secondary" onClick={() => { setOpen(false); if (retryDraft) setEditor(retryDraft) }}>{retryDraft ? 'Back to items' : 'Close'}</button>}
    </div>}>
      <div className="grid gap-4 text-sm">
        {session && <>
          <p>{session.restoring ? 'Cancel shop creation by restoring the deployer’s previous permissions. Confirm the restoration transaction to finish.' : session.plan.notice}</p>
          <ol className="list-decimal space-y-3 pl-5">{indices.map((requestIndex, index) => <li key={requestIndex}>{session.plan.requests[requestIndex].label}<span className="ml-2">{index < session.completed.length ? checkedProgress === progressKey ? 'Confirmed' : 'Verifying…' : index === session.completed.length ? stepActive ? 'Waiting for confirmation' : 'Ready' : 'Next'}</span></li>)}</ol>
          {!accountMatches && !complete && <p>Connect {session.plan.snapshot.account} to continue this update.</p>}
          {tx.phase === 'submitted' && <HeldNotice tx={tx} />}
          {tx.phase === 'pending' && <p>Submitted. Waiting for onchain confirmation…</p>}
          {complete && <p>{session.restoring ? 'The previous permissions have been restored. Shop creation was cancelled.' : session.plan.snapshot.mode === 'create' ? 'The shop and first items are created. They become available when the attached ruleset is active.' : 'Your inventory changes are confirmed onchain.'}</p>}
        </>}
        {progress && !complete && <p role="status">{progress}</p>}
        {(error || tx.error) && <p role="alert">{error ?? tx.error}</p>}
        {link && <a href={link} className="underline" target="_blank" rel="noreferrer">View transaction</a>}
      </div>
    </ModalShell>}
  </>
}
