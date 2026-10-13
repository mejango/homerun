'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, type TxRequest } from './useSafeTx'
import { useWallet } from './useWallet'
import { assertNoViewAs } from '@/lib/viewAs'

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
  const tx = useSafeTx(chainId)
  const resetTx = tx.reset
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('Project update')
  const [working, setWorking] = useState(false)
  const inFlight = useRef(false)
  const handled = useRef<string | null>(null)
  const onConfirmedRef = useRef(onConfirmed)
  useEffect(() => { onConfirmedRef.current = onConfirmed }, [onConfirmed])
  useEffect(() => { resetTx(); setError(null); handled.current = null }, [chainId, projectId, resetTx])

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
      if (typeof options?.reverify !== 'function') throw new Error('Recheck project permissions before submitting this update.')
      // Editors retain their own mutable drafts. Only this captured request reaches review.
      const captured = structuredClone(request)
      const identity = requestIdentity(captured)
      const latestConfirmedBlock = async () => {
        const block = await client.getBlock({ blockTag: 'latest' })
        if (block.number === null) throw new Error('The latest mined block could not be checked.')
        const minimumBlock = cache.getQueryData<bigint>(['project-admin-confirmed-block', chainId, projectId.toString()])
        if (minimumBlock !== undefined && block.number < minimumBlock) throw new Error('The network has not reached the last confirmed project update. Wait for it to catch up before submitting another update.')
      }
      setLabel(captured.label ?? 'Project update')
      handled.current = null
      resetTx()
      return await tx.send(captured, {
        reviewedAccount: options.reviewedAccount,
        reviewNotice: options.reviewNotice,
        recoveryNamespace: `homerun:project-admin:${projectId}`,
        action: 'project update',
        reverify: async reviewed => {
          await latestConfirmedBlock()
          await options.reverify(reviewed)
          if (requestIdentity(reviewed) !== identity) throw new Error('The project update changed during review. Review the current settings again.')
        },
        beforeWrite: async () => {
          assertNoViewAs()
          if (requestIdentity(captured) !== identity) throw new Error('The project update changed during review. Review it again.')
          await latestConfirmedBlock()
        },
      })
    } catch (reason) { setError(errorMessage(reason)); return null }
    finally { inFlight.current = false; setWorking(false) }
  }, [address, cache, chainId, client, projectId, resetTx, tx])

  const phase = tx.phase
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
    send, reset, dismiss, ready: true,
    busy: working || tx.busy || phase === 'review', pending,
    phase, settled: tx.settled, notice: phase === 'submitted' ? tx.notice : null,
    error: error ?? tx.error, status: phase === 'success' ? `${label} confirmed.` : null,
    hash: tx.hash, submissionHash: tx.submissionHash,
    safe: tx.isSafe, chainId, pendingLabel: pending ? label : null,
    held: tx.held,
  }
}
export type ProjectAdminTx = ReturnType<typeof useProjectAdminTx>
