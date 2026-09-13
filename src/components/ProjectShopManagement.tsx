'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Project721Tier } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isAddressEqual, type Hex, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { newDemoShopItem, type DemoShopItem } from '@/lib/demo-shop'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { assertNoViewAs } from '@/lib/viewAs'
import { waitForSafeExecutionHash } from '@/lib/safe-connector'
import {
  prepareProjectShopWrite, projectShopWriteRequest, readProjectShopWriteState, reverifyProjectShopWrite,
  type ProjectShopWriteState,
} from '@/lib/project-shop-write'
import {
  beginShopWriteSubmission, clearShopWriteSession, confirmShopWriteExecution, readShopWriteSession,
  recordShopWriteHash, rejectShopWriteSubmission, shopWriteSessionKey, startShopWriteSession,
  restoreShopWritePermissions, shopWriteRequestIndex, shopWriteRequestIndices,
  verifyShopWriteProgress, withShopWriteLock, type ShopWriteSession,
} from '@/lib/project-shop-session'
import { ShopItemEditor, type ShopItemEditorState } from '@/components/ShopItemEditor'
import { ModalShell } from '@/components/ui/ModalShell'

const HASH = /^0x[\da-fA-F]{64}$/
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
  const [executionHash, setExecutionHash] = useState('')
  const action = useRef(false)
  const state = useQuery({
    queryKey: ['project-shop-write', chainId, projectId.toString(), address ?? null],
    enabled: !!client && !!address && !unavailable,
    queryFn: () => readProjectShopWriteState(client!, { chainId, projectId, account: address! }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1,
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

  const confirm = useCallback(async (captured: ShopWriteSession, hash: Hex) => {
    if (!client) throw new Error('The network connection is unavailable.')
    const result = await confirmShopWriteExecution(client, localStorage, key, captured, hash)
    setSession(result.session)
    resetTx()
    setCheckedProgress(`${result.session.id}:${result.session.completed.length}`)
    setProgress(result.status === 'reverted' ? 'The transaction reverted. Review this step and try again.' : 'Transaction confirmed.')
    setError(null)
    window.dispatchEvent(new Event(SESSION_EVENT))
    await invalidate()
  }, [client, invalidate, key, resetTx])
  useEffect(() => {
    if (!client || !session?.pending?.hash) return
    const captured = session
    const pending = session.pending
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function check() {
      try {
        const hash = pending!.safe
          ? await waitForSafeExecutionHash(chainId, pending!.hash!, { pollingIntervalMs: 5_000, signal: controller.signal })
          : pending!.hash!
        if (!controller.signal.aborted) await withShopWriteLock(key, () => confirm(captured, hash))
      } catch (reason) {
        if (controller.signal.aborted) return
        setProgress(`Waiting for confirmation. ${message(reason)}`)
        timer = setTimeout(() => void check(), 5_000)
      }
    }
    void check()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [chainId, client, confirm, key, session])

  const snapshot = state.data
  const canStart = ready && !storageError && !session && !unavailable && !state.isError && !!snapshot && !!address && isAddressEqual(snapshot.account, address)
  const busy = working || tx.busy || tx.phase === 'review'
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
    if (!client || !session || !address || !accountMatches || session.pending || complete || action.current || storageError) return
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
        let submitting: ShopWriteSession | null = null
        await reverifyProjectShopWrite(client, captured.plan, account, index, request)
        const hash = await tx.send(request, {
          reviewNotice: captured.restoring ? 'Cancel shop creation by restoring the shop deployer’s previous permissions for this project. No shop will be created.' : captured.plan.notice,
          reverify: async reviewed => {
            prerequisiteBlock = await verifyShopWriteProgress(client, captured)
            await reverifyProjectShopWrite(client, captured.plan, account, index, reviewed)
          },
          beforeWrite: async () => {
            const currentBlock = await client.getBlock({ blockTag: 'latest' })
            if (currentBlock.number === null) throw new Error('The latest block could not be read.')
            if (currentBlock.number < prerequisiteBlock) throw new Error('The network has not caught up with the previous shop transaction. Try again shortly.')
            submitting = beginShopWriteSubmission(localStorage, key, captured, { safe: tx.isSafe, afterBlock: currentBlock.number })
            changed()
          },
          onBeforeWriteAborted: () => { if (submitting) { rejectShopWriteSubmission(localStorage, key, submitting, 'before-write-aborted'); changed() } },
          onWriteRejected: () => { if (submitting) { rejectShopWriteSubmission(localStorage, key, submitting, 'wallet-rejected'); changed() } },
        })
        if (hash && submitting) { recordShopWriteHash(localStorage, key, submitting, hash); changed() }
      })
    } catch (reason) { setError(message(reason)) }
    finally { action.current = false; setWorking(false) }
  }
  async function recover() {
    if (!session?.pending || !HASH.test(executionHash) || action.current) return
    action.current = true; setWorking(true); setError(null)
    try { await withShopWriteLock(key, () => confirm(session, executionHash as Hex)); tx.reset() }
    catch (reason) { setError(message(reason)) }
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
  const link = lastHash ? explorerTxUrl(chainId, lastHash) : session?.pending?.hash && !session.pending.safe ? explorerTxUrl(chainId, session.pending.hash) : null
  const toolbar = session ? <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>{complete ? 'Shop update complete' : 'Resume shop update'}</button>
    : snapshot?.canAdd && <button type="button" className="btn-primary" disabled={!canStart || busy} onClick={add}>Add items for sale</button>
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
          {!session.pending && session.completed.length === 0 && <button type="button" className="ds-button ds-button-secondary" disabled={busy} onClick={() => void finish()}>Cancel update</button>}
          {!session.pending && !session.restoring && session.completed.length === 1 && session.plan.requestKinds.join(',') === 'grant,create,restore' && <button type="button" className="ds-button ds-button-secondary" disabled={busy || !accountMatches} onClick={() => void restore()}>Cancel creation and restore permissions</button>}
          {!session.pending && <button type="button" className="ds-button ds-button-primary" disabled={busy || !accountMatches || checkedProgress !== progressKey || !!storageError} onClick={() => void submit()}>{txPhaseLabel(tx.phase, { idle: 'Review transaction', pending: 'Waiting for confirmation…' })}</button>}
        </> : !working && <button type="button" className="ds-button ds-button-secondary" onClick={() => { setOpen(false); if (retryDraft) setEditor(retryDraft) }}>{retryDraft ? 'Back to items' : 'Close'}</button>}
    </div>}>
      <div className="grid gap-4 text-sm">
        {session && <>
          <p>{session.restoring ? 'Cancel shop creation by restoring the deployer’s previous permissions. Confirm the restoration transaction to finish.' : session.plan.notice}</p>
          <ol className="list-decimal space-y-3 pl-5">{indices.map((requestIndex, index) => <li key={requestIndex}>{session.plan.requests[requestIndex].label}<span className="ml-2">{index < session.completed.length ? checkedProgress === progressKey ? 'Confirmed' : 'Verifying…' : index === session.completed.length ? session.pending ? 'Waiting for confirmation' : 'Ready' : 'Next'}</span></li>)}</ol>
          {!accountMatches && !complete && <p>Connect {session.plan.snapshot.account} to continue this update.</p>}
          {session.pending?.safe && <p>Proposed to Safe. Execution is required before the next step.</p>}
          {session.pending && <details><summary className="cursor-pointer">Check an execution transaction</summary><p className="mt-3">If you already confirmed this step, enter its onchain transaction hash.</p><label className="mt-3 grid gap-2">Execution transaction hash<input className="min-h-11 w-full rounded border border-[#bfc9b5] bg-transparent px-3" value={executionHash} onChange={event => setExecutionHash(event.target.value.trim())} /></label><button type="button" className="btn-secondary mt-3" disabled={working || !HASH.test(executionHash)} onClick={() => void recover()}>Check execution</button></details>}
          {complete && <p>{session.restoring ? 'The previous permissions have been restored. Shop creation was cancelled.' : session.plan.snapshot.mode === 'create' ? 'The shop and first items are created. They become available when the attached ruleset is active.' : 'Your inventory changes are confirmed onchain.'}</p>}
        </>}
        {progress && !complete && <p role="status">{progress}</p>}
        {(error || tx.error) && <p role="alert">{error ?? tx.error}</p>}
        {link && <a href={link} className="underline" target="_blank" rel="noreferrer">View transaction</a>}
      </div>
    </ModalShell>}
  </>
}
