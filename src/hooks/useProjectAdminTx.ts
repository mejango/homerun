'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { encodeFunctionData, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, type TxPhase, type TxRequest } from './useSafeTx'
import { useWallet } from './useWallet'
import { assertNoViewAs } from '@/lib/viewAs'
import { waitForSafeExecutionHash } from '@/lib/safe-connector'
import {
  beginProjectAdminSubmission, confirmProjectAdminExecution, projectAdminSessionKey,
  readProjectAdminPending, recordProjectAdminHash, rejectProjectAdminSubmission,
  withProjectAdminLock, type ProjectAdminPending,
} from '@/lib/project-admin-session'

const SESSION_EVENT = 'homerun-project-admin-session'
const RESOLVED_EVENT = 'homerun-project-admin-resolved'
const INVALIDATE_PREFIXES = ['project-admin', 'project-authority', 'project-metadata', 'fund-project-metadata', 'fund-project', 'income-project', 'income-operator', 'income-reserved', 'income-sticky-binding', 'sticky-project', 'sticky-rewards', 'project-operator-profile', 'project-shop-write', 'project-permissions', 'project-ownership', 'project-splits', 'project-splits-edit', 'account-projects', 'account-tokens']
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : 'The project update could not be completed.'
type Resolution = { key: string; id: string; status: 'confirmed' | 'reverted'; hash: Hex; label: string }
export type ProjectAdminSendOptions = {
  /** Re-read authority and rebuild the exact request from current mined state. */
  reverify: (request: TxRequest) => Promise<unknown>
  reviewNotice?: string
}
function requestIdentity(request: TxRequest): string {
  return `${request.chainId}:${request.address.toLowerCase()}:${request.value ?? 0n}:${encodeFunctionData(request).toLowerCase()}`
}

/** Reviewed single writes with a durable lock shared by every editor for this project. */
export function useProjectAdminTx({ chainId, projectId, onConfirmed }: {
  chainId: number; projectId: bigint; onConfirmed?: () => void | Promise<unknown>
}) {
  const client = usePublicClient({ chainId })
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useSafeTx(chainId)
  const resetTx = tx.reset
  const key = projectAdminSessionKey(chainId, projectId)
  const [record, setRecord] = useState<ProjectAdminPending | null>(null)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [resolution, setResolution] = useState<Resolution | null>(null)
  const [working, setWorking] = useState(false)
  const inFlight = useRef(false)
  const submittedId = useRef<string | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  useEffect(() => { onConfirmedRef.current = onConfirmed }, [onConfirmed])

  const invalidate = useCallback(async () => {
    await cache.invalidateQueries({ predicate: query => {
      const prefix = query.queryKey[0]
      if (prefix === 'project-admin-confirmed-block') return false
      return typeof prefix === 'string' && (INVALIDATE_PREFIXES.includes(prefix) || prefix.startsWith('project-admin-'))
    } })
  }, [cache])
  const refresh = useCallback(() => {
    try { setRecord(readProjectAdminPending(localStorage, key)); setStorageError(null) }
    catch (reason) { setStorageError(errorMessage(reason)) }
    finally { setReady(true) }
  }, [key])
  useEffect(() => {
    setReady(false); setRecord(null); setResolution(null); setError(null); setStatus(null)
    submittedId.current = null
    resetTx()
    refresh()
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return
      refresh()
      // A different tab may have confirmed the update. Re-read authoritative data.
      if (event.oldValue && !event.newValue) { resetTx(); setError(null); setStatus(null); void invalidate() }
    }
    window.addEventListener('storage', storageChanged)
    window.addEventListener(SESSION_EVENT, refresh)
    return () => { window.removeEventListener('storage', storageChanged); window.removeEventListener(SESSION_EVENT, refresh) }
  }, [invalidate, key, refresh, resetTx])
  useEffect(() => {
    const resolved = (event: Event) => {
      const detail = (event as CustomEvent<Resolution>).detail
      if (detail.key !== key) return
      refresh(); resetTx(); setResolution(detail); setError(null)
      setStatus(detail.status === 'confirmed' ? `${detail.label} confirmed.` : `${detail.label} reverted onchain. Review the current settings before trying again.`)
      if (detail.status === 'confirmed' && submittedId.current === detail.id) {
        submittedId.current = null
        void Promise.resolve().then(() => onConfirmedRef.current?.()).catch(reason => setError(`The update confirmed, but refreshing this panel failed. ${errorMessage(reason)}`))
      }
    }
    window.addEventListener(RESOLVED_EVENT, resolved)
    return () => window.removeEventListener(RESOLVED_EVENT, resolved)
  }, [key, refresh, resetTx])
  const changed = useCallback(() => {
    refresh()
    window.dispatchEvent(new Event(SESSION_EVENT))
  }, [refresh])

  const confirm = useCallback(async (captured: ProjectAdminPending, hash: Hex) => {
    if (!client) throw new Error('The network connection is unavailable.')
    const current = readProjectAdminPending(localStorage, key)
    // Another mounted editor or browser tab may have completed this same check.
    if (!current || current.id !== captured.id) { refresh(); return }
    const confirmed = await confirmProjectAdminExecution(client, localStorage, key, captured, hash)
    if (confirmed.status === 'confirmed') cache.setQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()], previous => previous !== undefined && previous > confirmed.blockNumber ? previous : confirmed.blockNumber)
    const detail: Resolution = { key, id: captured.id, status: confirmed.status, hash, label: captured.label }
    window.dispatchEvent(new CustomEvent(RESOLVED_EVENT, { detail }))
    changed()
    await invalidate()
  }, [cache, chainId, changed, client, invalidate, key, projectId, refresh])
  useEffect(() => {
    if (!client || !record?.hash) return
    const captured = record
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function check() {
      try {
        const hash = captured.safe
          ? await waitForSafeExecutionHash(chainId, captured.hash!, { pollingIntervalMs: 5_000, signal: controller.signal })
          : captured.hash!
        if (!controller.signal.aborted) await withProjectAdminLock(key, () => confirm(captured, hash))
      } catch (reason) {
        if (controller.signal.aborted) return
        setStatus(`Waiting for the saved project update to confirm. ${errorMessage(reason)}`)
        timer = setTimeout(() => void check(), 5_000)
      }
    }
    void check()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [chainId, client, confirm, key, record])

  const send = useCallback(async (request: TxRequest, options: ProjectAdminSendOptions): Promise<Hex | null> => {
    if (inFlight.current) return null
    inFlight.current = true; setWorking(true); setError(null); setStatus(null); setResolution(null)
    try {
      assertNoViewAs()
      if (!ready || storageError) throw new Error(storageError ?? 'Wait for saved project updates to load.')
      if (!client || !address) throw new Error('Connect a wallet first.')
      if (request.chainId !== chainId) throw new Error('This update belongs to a different network.')
      if (typeof options?.reverify !== 'function') throw new Error('Recheck project permissions before submitting this update.')
      // Editors retain their own mutable drafts. Only this captured request reaches review.
      const captured = structuredClone(request)
      const identity = requestIdentity(captured)
      const latestConfirmedBlock = async () => {
        const block = await client.getBlock({ blockTag: 'latest' })
        if (block.number === null) throw new Error('The latest mined block could not be checked.')
        const minimumBlock = cache.getQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()])
        if (minimumBlock !== undefined && block.number < minimumBlock) throw new Error('The network has not reached the last confirmed project update. Wait for it to catch up before submitting another update.')
        return block.number
      }
      return await withProjectAdminLock(key, async () => {
        if (readProjectAdminPending(localStorage, key)) throw new Error('A project update may already be pending. Verify its execution before submitting another update.')
        resetTx()
        let submitting: ProjectAdminPending | null = null
        const reject = (reason: 'wallet-rejected' | 'before-write-aborted') => {
          if (!submitting) return
          rejectProjectAdminSubmission(localStorage, key, submitting, reason)
          submitting = null; submittedId.current = null; changed()
        }
        const hash = await tx.send(captured, {
          reviewNotice: options.reviewNotice,
          reverify: async reviewed => {
            await latestConfirmedBlock()
            await options.reverify(reviewed)
            if (requestIdentity(reviewed) !== identity) throw new Error('The project update changed during review. Review the current settings again.')
          },
          beforeWrite: async () => {
            assertNoViewAs()
            if (requestIdentity(captured) !== identity) throw new Error('The project update changed during review. Review it again.')
            const afterBlock = await latestConfirmedBlock()
            submitting = beginProjectAdminSubmission(localStorage, key, { request: captured, projectId, account: address, safe: tx.isSafe, afterBlock })
            submittedId.current = submitting.id
            changed()
          },
          onBeforeWriteAborted: () => reject('before-write-aborted'),
          onWriteRejected: () => reject('wallet-rejected'),
        })
        if (hash && submitting) {
          recordProjectAdminHash(localStorage, key, submitting, hash)
          changed()
        }
        return hash
      })
    } catch (reason) { setError(errorMessage(reason)); refresh(); return null }
    finally { inFlight.current = false; setWorking(false) }
  }, [address, cache, chainId, changed, client, key, projectId, ready, refresh, resetTx, storageError, tx])

  const recover = useCallback(async (hash: Hex) => {
    if (inFlight.current) return
    inFlight.current = true; setWorking(true); setError(null)
    try {
      await withProjectAdminLock(key, async () => {
        const captured = readProjectAdminPending(localStorage, key)
        if (!captured) throw new Error('There is no saved project update to check.')
        await confirm(captured, hash)
      })
    } catch (reason) { setError(errorMessage(reason)); refresh() }
    finally { inFlight.current = false; setWorking(false) }
  }, [confirm, key, refresh])

  const pending = !!record
  const phase: TxPhase = pending ? (working && tx.phase !== 'idle' ? tx.phase : 'pending') : resolution?.status === 'confirmed' ? 'success' : resolution?.status === 'reverted' ? 'error' : tx.phase
  return {
    send, recover, ready: ready && !storageError, busy: working || pending || tx.busy || tx.phase === 'review', pending,
    phase, error: storageError ?? error ?? tx.error, status, hash: record?.safe ? null : record?.hash ?? resolution?.hash ?? null,
    safe: record?.safe ?? tx.isSafe, chainId, pendingLabel: record?.label ?? null,
    /** Recovery is read-only and may be used even while a transaction is pending. */
    recovering: working,
  }
}
export type ProjectAdminTx = ReturnType<typeof useProjectAdminTx>
