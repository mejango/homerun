'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { useReviewedAction, type TxRequest } from './useReviewedAction'
import { useWallet } from './useWallet'
import { assertNoViewAs } from '@/lib/viewAs'
import { WRITE_EXIT_LABEL, browserLocks, hidesShownExit, writeExitMessage, type ReviewContextRow, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { useHeldWrite } from '@bananapus/nana-sdk-core/review/react'
import { holds } from '@/lib/write-hold'
import {
  adoptLegacyProjectAdminRecord, noteProjectAdminAccount, otherProjectAdminHolds, projectAdminLockName, projectAdminNamespace, pruneProjectAdminAccounts, type ProjectAdminHold,
} from '@/lib/project-admin-reservation'

const INVALIDATE_PREFIXES = ['project-admin', 'project-authority', 'project-metadata', 'fund-project-metadata', 'fund-project', 'income-project', 'income-operator', 'income-reserved', 'income-sticky-binding', 'sticky-project', 'sticky-rewards', 'project-operator-profile', 'project-shop-write', 'project-permissions', 'project-ownership', 'project-splits', 'project-splits-edit', 'account-projects', 'account-tokens']
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'The project update could not be completed.'
export type ProjectAdminSendOptions = {
  /**
   * The account the update was built for, whose authority the editor read.
   * Only that account may send it: while another is connected, nothing is
   * reviewed or sent.
   */
  reviewedAccount: Address
  /** Re-read authority and rebuild the exact request from current mined state. */
  reverify: (request: TxRequest) => Promise<unknown>
  reviewNotice?: string
  /** What the update does, as rows at the top of its one review. */
  context?: readonly ReviewContextRow[]
}
function requestIdentity(request: TxRequest): string {
  return `${request.chainId}:${request.address.toLowerCase()}:${request.value ?? 0n}:${encodeFunctionData(request).toLowerCase()}`
}

/**
 * Reviewed single writes for a project's editors. The SDK's write recovery holds the whole
 * project's updates (one name, whatever the call) until the chain places an unconfirmed one
 * or the user checks their wallet.
 */
export function useProjectAdminTx({ chainId, projectId, onConfirmed }: {
  chainId: number; projectId: bigint; onConfirmed?: () => void | Promise<unknown>
}) {
  const client = usePublicClient({ chainId })
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useReviewedAction(chainId)
  const resetTx = tx.reset
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('Project update')
  const [working, setWorking] = useState(false)
  /** Saved updates from before the SDK's journal are moved into it before any write. */
  const [adopted, setAdopted] = useState(false)
  /** Another wallet's unresolved update on this project. */
  const [otherHold, setOtherHold] = useState<ProjectAdminHold | null>(null)
  const inFlight = useRef(false)
  const handled = useRef<string | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  useEffect(() => { onConfirmedRef.current = onConfirmed }, [onConfirmed])
  useEffect(() => { resetTx(); setError(null); handled.current = null; setOtherHold(null) }, [chainId, projectId, resetTx])
  useEffect(() => {
    let cancelled = false
    setAdopted(false)
    adoptLegacyProjectAdminRecord(localStorage, chainId, projectId)
      .then(() => { if (!cancelled) setAdopted(true) })
      .catch(reason => { if (!cancelled) setError(errorMessage(reason)) })
    return () => { cancelled = true }
  }, [chainId, projectId])

  const invalidate = useCallback(async () => {
    const filters = { predicate: (query: { queryKey: readonly unknown[] }) => {
      const prefix = query.queryKey[0]
      if (prefix === 'project-admin-confirmed-block') return false
      return typeof prefix === 'string' && (INVALIDATE_PREFIXES.includes(prefix) || prefix.startsWith('project-admin-'))
    } }
    await cache.cancelQueries(filters)
    await cache.invalidateQueries(filters)
  }, [cache])

  // A confirmed update refreshes what the editors read, once.
  const receipt = tx.receipt
  useEffect(() => {
    if (tx.phase !== 'success') return
    const id = receipt?.transactionHash ?? tx.hash ?? tx.submissionHash ?? 'confirmed'
    if (handled.current === id) return
    handled.current = id
    if (receipt) cache.setQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()], previous => previous !== undefined && previous > receipt.blockNumber ? previous : receipt.blockNumber)
    void invalidate().then(() => onConfirmedRef.current?.())
      .catch(reason => setError(`The update confirmed, but refreshing this panel failed. ${errorMessage(reason)}`))
  }, [cache, chainId, invalidate, projectId, receipt, tx.hash, tx.phase, tx.submissionHash])

  const send = useCallback(async (request: TxRequest, options: ProjectAdminSendOptions): Promise<Hex | null> => {
    if (inFlight.current) return null
    inFlight.current = true; setWorking(true); setError(null)
    try {
      assertNoViewAs()
      if (!client || !address) throw new Error('Connect a wallet first.')
      if (request.chainId !== chainId) throw new Error('This update belongs to a different network.')
      if (!adopted) throw new Error('Wait for saved project updates to load.')
      if (typeof options?.reverify !== 'function') throw new Error('Recheck project permissions before submitting this update.')
      // Editors retain their own mutable drafts. Only this captured request reaches review.
      const captured = structuredClone(request)
      watched.current = options.reviewedAccount
      const identity = requestIdentity(captured)
      const latestConfirmedBlock = async () => {
        const block = await client.getBlock({ blockTag: 'latest' })
        if (block.number === null) throw new Error('The latest mined block could not be checked.')
        const minimumBlock = cache.getQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()])
        if (minimumBlock !== undefined && block.number < minimumBlock) throw new Error('The network has not reached the last confirmed project update. Wait for it to catch up before submitting another update.')
      }
      // The project check and the reservation run under one lock per chain and project.
      return await browserLocks().request(projectAdminLockName(chainId, projectId), { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another tab is updating this project. Finish that update first.')
        // One reservation covers the project, whichever authorized wallet made the update.
        const holds = await otherProjectAdminHolds(localStorage, client, chainId, projectId, options.reviewedAccount)
        if (holds.length) { setOtherHold(holds[0]); return null }
        setOtherHold(null)
        pruneProjectAdminAccounts(localStorage, chainId, projectId, options.reviewedAccount)
          setLabel(captured.label ?? 'Project update')
          handled.current = null
          resetTx()
          return await tx.send(captured, {
            reviewedAccount: options.reviewedAccount,
            reviewNotice: options.reviewNotice,
            context: options.context,
            recoveryNamespace: projectAdminNamespace(projectId),
        // Adopting a proposal the Safe already has skips the wallet, so the account is registered here, still under the lock.
        onExistingProposal: () => { noteProjectAdminAccount(localStorage, chainId, projectId, options.reviewedAccount) },
            reverify: async reviewed => {
              await latestConfirmedBlock()
              await options.reverify(reviewed)
              if (requestIdentity(reviewed) !== identity) throw new Error('The project update changed during review. Review the current settings again.')
            },
            beforeWrite: async () => {
              assertNoViewAs()
              if (requestIdentity(captured) !== identity) throw new Error('The project update changed during review. Review it again.')
              // Checked again right before the wallet opens: another wallet may have reserved the project meanwhile.
              const late = await otherProjectAdminHolds(localStorage, client, chainId, projectId, options.reviewedAccount)
              if (late.length) { setOtherHold(late[0]); throw new Error('Another wallet’s project update is still unresolved. Check it before sending another.') }
              noteProjectAdminAccount(localStorage, chainId, projectId, options.reviewedAccount)
              await latestConfirmedBlock()
            },
          })
      })
    } catch (reason) { setError(errorMessage(reason)); return null }
    finally { inFlight.current = false; setWorking(false) }
  }, [address, adopted, cache, chainId, client, projectId, resetTx, tx])

  // The displayed hold follows its chain proof and other tabs: it refreshes when its state changes,
  // and once it ends the project is looked at again for another wallet's update.
  const watched = useRef<Address | null>(null)
  /** The hold whose exit the user accepted: its answer, not what it reports meanwhile, decides. */
  const exiting = useRef<ProjectAdminHold['hold'] | null>(null)
  const rescan = useCallback(async (shown: ProjectAdminHold) => {
    if (!client) return
    const account = watched.current ?? shown.state.record.account
    try {
      const holds = await otherProjectAdminHolds(localStorage, client, chainId, projectId, account)
      await browserLocks().request(projectAdminLockName(chainId, projectId), { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (lock) pruneProjectAdminAccounts(localStorage, chainId, projectId, account)
      })
      setOtherHold(current => current?.hold !== shown.hold ? current : holds[0] ?? null)
    } catch { /* The next look asks again. */ }
  }, [chainId, client, projectId])
  // Watched through the SDK's held write: its events, a checked read now, on focus and every poll.
  const record = otherHold?.state.record
  const other = useHeldWrite({
    hold: holds, chainId: record?.chainId ?? chainId, account: record?.account ?? zeroAddress, safe: record?.safe,
    namespace: record ? projectAdminNamespace(projectId) : undefined,
    call: record ? { to: record.call.to, data: record.call.data, value: BigInt(record.call.value) } : undefined,
    client: record ? client as WriteHoldClient | undefined : undefined, pollMs: 15_000,
  })
  const shownOther = useRef(otherHold)
  shownOther.current = otherHold
  const otherState = other.state
  useEffect(() => {
    const shown = shownOther.current
    if (!shown || !otherState || exiting.current === shown.hold || hidesShownExit(shown.state, otherState)) return
    if (otherState.status === 'clear') void rescan(shown)
    else setOtherHold(current => current?.hold === shown.hold ? { hold: shown.hold, state: otherState } : current)
  }, [otherState, rescan])
  const phase = otherHold ? 'submitted' as const : tx.phase
  const exitOther = useCallback(async (): Promise<boolean> => {
    if (!otherHold || !client) return false
    try {
      // The hold asks the chain again as the exit is taken, for the state the user saw.
      exiting.current = otherHold.hold
      const { released, state } = await otherHold.hold.exit(otherHold.state, { checkedWallet: true }, client)
        .finally(() => { exiting.current = null })
      if (released || state.status === 'clear') { setOtherHold(null); setError(null) }
      else setOtherHold({ hold: otherHold.hold, state })
      return released
    } catch (reason) { setError(errorMessage(reason)); return false }
  }, [client, otherHold])
  const held = tx.held ?? (otherHold?.state.exit ? {
    kind: 'exit' as const, line: otherHold.state.line, warning: 'warning' in otherHold.state && otherHold.state.warning ? otherHold.state.warning : writeExitMessage(otherHold.state.record.call),
    label: WRITE_EXIT_LABEL, release: exitOther,
  } : null)
  const pending = phase === 'pending' || phase === 'submitted'
  /** Clears a settled result before the next review. A write still being followed is never cleared. */
  const reset = useCallback(() => {
    if (inFlight.current || phase === 'pending') return
    resetTx(); setError(null)
  }, [phase, resetTx])
  // Closing a review only hides it: a write in flight keeps being followed so its
  // confirmation still refreshes the editors. A line the user cannot wait out is released.
  const dismiss = useCallback(() => {
    if (phase === 'pending' || (phase === 'submitted' && !tx.confirmationUncertain)) return
    tx.dismiss(); setError(null)
  }, [phase, tx])
  return {
    send, reset, dismiss, ready: adopted,
    busy: working || tx.busy || phase === 'review', pending,
    phase, settled: tx.settled || !!otherHold, notice: otherHold ? [otherHold.state.line, otherHold.state.notice].filter(Boolean).join(' ') : phase === 'submitted' ? tx.notice : null,
    error: error ?? tx.error, status: phase === 'success' ? `${label} confirmed.` : null,
    hash: tx.hash, submissionHash: tx.submissionHash,
    safe: tx.isSafe, chainId, pendingLabel: pending ? label : null,
    held,
  }
}
export type ProjectAdminTx = ReturnType<typeof useProjectAdminTx>
