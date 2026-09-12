import { type Address, type Hex } from 'viem'
import type { LaunchRelayrJournal } from './fund-launch-relayr'
import { buildFundLaunch, type FundLaunchInput } from './fund-contracts'

export const FUND_LAUNCH_KEY = 'homerun:fund-launch:v1'
export type LaunchStatus = {
  phase: 'ready' | 'signing' | 'pending' | 'confirmed' | 'reverted' | 'authorized' | 'unresolved' | 'expired'
  error?: string
  hash?: Hex
  safe?: boolean
  /** Actual receipt hash, kept separate from a pending Safe proposal identifier. */
  executionHash?: Hex
  projectId?: string
}
export type FundLaunchSession = {
  version: 1
  transport?: 'direct' | 'relayr'
  relayr?: LaunchRelayrJournal
  paymentChainId?: number
  name: string
  input: FundLaunchInput
  statuses: Record<number, LaunchStatus>
}
export function encodeLaunchSession(session: FundLaunchSession): string {
  return JSON.stringify({ ...session, input: { ...session.input, creationFees: Object.fromEntries(Object.entries(session.input.creationFees).map(([id, fee]) => [id, fee.toString()])) } })
}
export function decodeLaunchSession(raw: string): FundLaunchSession {
  // Convert only known numeric fields. A global bigint reviver corrupts names
  // such as "2026n" and any other user text matching that representation.
  const value = JSON.parse(raw) as FundLaunchSession
  const input = value?.input
  if (value?.version !== 1 || typeof value.name !== 'string' || !input
    || !input.creationFees || typeof input.creationFees !== 'object' || Array.isArray(input.creationFees)
    || !Array.isArray(input.chainIds) || !value.statuses || typeof value.statuses !== 'object') throw new Error('Saved launch is invalid. Restore its original deployment record before continuing.')
  const fees = Object.entries(input.creationFees).map(([id, rawFee]) => {
    const fee = rawFee as unknown
    // Accept the former `123n` representation when resuming old records.
    if (typeof fee !== 'string' || !/^\d+n?$/.test(fee)) throw new Error('Saved launch contains an invalid creation fee.')
    return [id, BigInt(fee.replace(/n$/, ''))] as const
  })
  input.creationFees = Object.fromEntries(fees)
  // Reuse the real transaction builder's chain, address, salt, fee, metadata,
  // precision and multichain checks instead of maintaining looser validation.
  buildFundLaunch(input)
  for (const id of input.chainIds) {
    const status = value.statuses?.[id]
    if (typeof input.creationFees?.[id] !== 'bigint' || input.creationFees[id] < 0n || !status
      || !['ready', 'signing', 'pending', 'confirmed', 'reverted', ...(value.transport === 'relayr' ? ['authorized', 'unresolved', 'expired'] : [])].includes(status.phase)
      || (status.hash !== undefined && !/^0x[\da-f]{64}$/i.test(status.hash))
      || (status.executionHash !== undefined && !/^0x[\da-f]{64}$/i.test(status.executionHash))
      || (status.safe !== undefined && typeof status.safe !== 'boolean')
      || (status.phase === 'ready' && (status.hash !== undefined || status.executionHash !== undefined || status.projectId !== undefined))
      || (status.phase === 'pending' && !status.hash)
      || (status.phase === 'reverted' && !status.hash)
      || (status.phase === 'confirmed' && (!status.hash || !/^[1-9]\d*$/.test(status.projectId ?? '')))) throw new Error('Saved launch progress is incomplete. Verify the submitted transaction before continuing.')
    if (status.projectId !== undefined && (typeof status.projectId !== 'string' || !/^[1-9]\d*$/.test(status.projectId) || BigInt(status.projectId) >= 1n << 256n)) throw new Error('Saved project ID is invalid.')
  }
  if (value.transport !== undefined && !['direct', 'relayr'].includes(value.transport)) throw new Error('Invalid launch transport.')
  if (value.relayr && value.transport !== 'relayr') throw new Error('Relayed authorizations cannot use direct deployment.')
  return value
}

export function loadLaunchSession(_options?: { strict?: boolean }): FundLaunchSession | null {
  const raw = localStorage.getItem(FUND_LAUNCH_KEY)
  try { return raw ? decodeLaunchSession(raw) : null }
  catch (cause) { throw new Error('Saved launch authorizations could not be read. Keep the original deployment record before continuing.', { cause }) }
}

function frozenInput(session: FundLaunchSession): string {
  return JSON.stringify({ name: session.name, ...session.input, creationFees: undefined })
}

const transitions: Record<LaunchStatus['phase'], readonly LaunchStatus['phase'][]> = {
  ready: ['ready', 'signing'],
  authorized: ['authorized', 'signing', 'confirmed', 'reverted', 'expired', 'unresolved'],
  unresolved: ['unresolved', 'signing', 'confirmed', 'reverted', 'expired'],
  expired: ['expired', 'signing'],
  signing: ['signing', 'pending', 'confirmed', 'reverted', 'authorized', 'unresolved', 'expired'],
  pending: ['pending', 'confirmed', 'reverted'],
  confirmed: ['confirmed'],
  reverted: ['reverted', 'signing'],
}

function assertTransition(previous: LaunchStatus, next: LaunchStatus, cancelled = false): void {
  if (cancelled && previous.phase === 'signing' && next.phase === 'ready') return
  if (!transitions[previous.phase].includes(next.phase)) throw new Error('Launch progress changed elsewhere. Reload the saved record before continuing.')
  if (previous.phase === 'confirmed' && (next.hash !== previous.hash || next.projectId !== previous.projectId)) throw new Error('A confirmed deployment cannot be replaced.')
  if (previous.phase === 'pending' && next.phase === 'pending' && (next.hash !== previous.hash || next.safe !== previous.safe)) throw new Error('Verify the pending transaction before submitting or recording another.')
}

export function saveLaunch(session: FundLaunchSession, options: { cancelledChainId?: number } = {}): FundLaunchSession {
  const validated = decodeLaunchSession(encodeLaunchSession(session))
  const existing = localStorage.getItem(FUND_LAUNCH_KEY)
  if (existing) {
    const previous = decodeLaunchSession(existing)
    if (previous.input.salt !== validated.input.salt) throw new Error('Another FUND launch is already saved. Finish that launch before preparing another.')
    if ((previous.transport ?? 'direct') !== (validated.transport ?? 'direct') && !(validated.transport === 'relayr' && !previous.relayr && Object.values(previous.statuses).every(status => status.phase === 'ready'))) throw new Error('A submitted launch cannot change transport.')
    if (previous.relayr?.published && !validated.relayr) throw new Error('Published authorizations must be retained for recovery.')
    if (frozenInput(previous) !== frozenInput(validated)) throw new Error('A saved launch plan is immutable. Finish it before changing deployment parameters.')
    for (const chainId of previous.input.chainIds) {
      assertTransition(previous.statuses[chainId], validated.statuses[chainId], options.cancelledChainId === chainId)
      if (previous.input.creationFees[chainId] !== validated.input.creationFees[chainId] && !['ready', 'reverted'].includes(previous.statuses[chainId].phase) && !(validated.transport === 'relayr' && validated.relayr?.phase === 'signing')) throw new Error('A submitted or unresolved deployment fee cannot change.')
    }
  }
  localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession(validated))
  return validated
}

function requireLaunch(salt: Hex): FundLaunchSession {
  const raw = localStorage.getItem(FUND_LAUNCH_KEY)
  if (!raw) throw new Error('The saved launch is missing. Restore its deployment record before continuing.')
  const session = decodeLaunchSession(raw)
  if (session.input.salt !== salt) throw new Error('A different deployment is now saved. Reload before continuing.')
  return session
}

/** Merge one chain's result into the latest record, not a stale React closure. */
export function updateLaunchStatus(salt: Hex, chainId: number, status: LaunchStatus, expectedPhase?: LaunchStatus['phase']): FundLaunchSession {
  const session = requireLaunch(salt)
  if (!session.input.chainIds.includes(chainId)) throw new Error('This chain is not part of the saved launch.')
  if (expectedPhase && session.statuses[chainId].phase !== expectedPhase) throw new Error('This deployment is already being handled. Reload its progress before continuing.')
  return saveLaunch({ ...session, statuses: { ...session.statuses, [chainId]: status } }, { cancelledChainId: expectedPhase === 'signing' && status.phase === 'ready' ? chainId : undefined })
}

export function refreshLaunchCreationFee(salt: Hex, chainId: number, creationFee: bigint): FundLaunchSession {
  const session = requireLaunch(salt)
  if (!session.input.chainIds.includes(chainId) || !['ready', 'reverted'].includes(session.statuses[chainId].phase)) throw new Error('Only an unsubmitted or reverted deployment can refresh its fee.')
  return saveLaunch({ ...session, input: { ...session.input, creationFees: { ...session.input.creationFees, [chainId]: creationFee } } })
}

/** Keep completed history before clearing the active record for a new project. */
export function archiveLaunch(salt: Hex): void {
  const session = requireLaunch(salt)
  if (!session.input.chainIds.every(id => session.statuses[id].phase === 'confirmed')) throw new Error('Confirm every linked deployment before archiving this launch.')
  const historyKey = `${FUND_LAUNCH_KEY}:history`
  const rawHistory = localStorage.getItem(historyKey)
  const history: unknown = rawHistory ? JSON.parse(rawHistory) : []
  if (!Array.isArray(history)) throw new Error('Saved launch history is invalid. Download the deployment record before continuing.')
  localStorage.setItem(historyKey, JSON.stringify([...history, encodeLaunchSession(session)]))
  localStorage.removeItem(FUND_LAUNCH_KEY)
}
export function sameSender(actual: Address | undefined, expected: Address): void {
  if (actual?.toLowerCase() !== expected.toLowerCase()) throw new Error('Reconnect the wallet that prepared this launch. Every linked deployment must use the same sender.')
}

/** Only a plan that has never acquired an authorization can follow edited networks. */
export function discardUnsignedLaunch(salt: Hex): boolean {
  const session = requireLaunch(salt)
  if (!Object.values(session.statuses).every(status => status.phase === 'ready')
    || session.relayr?.signed.length || session.relayr?.superseded?.length
    || session.relayr?.published || session.relayr?.quote || session.relayr?.paymentHash
    || (session.relayr && session.relayr.phase !== 'signing')) return false
  localStorage.removeItem(FUND_LAUNCH_KEY)
  return true
}

export function canCancelLaunch(session: FundLaunchSession): boolean {
  const phases = session.transport === 'relayr' ? ['ready', 'signing', 'authorized'] : ['ready']
  return Object.values(session.statuses).every(status => phases.includes(status.phase) && !status.hash && !status.executionHash)
    && (!session.relayr || (['signing', 'quoting'].includes(session.relayr.phase)
      && !session.relayr.published && !session.relayr.quote && !session.relayr.paymentHash
      && !session.relayr.superseded?.length && !session.relayr.records.length))
}

/** Discard only unpublished work, while excluding writers in every browser tab. */
export async function cancelUnsubmittedLaunch(salt: Hex): Promise<void> {
  if (!navigator.locks) throw new Error('This browser cannot coordinate cancellation across tabs.')
  await navigator.locks.request('homerun:fund-launch', { ifAvailable: true }, async relayLock => {
    if (!relayLock) throw new Error('Finish or close the active wallet request before cancelling.')
    await navigator.locks.request(`homerun:fund-launch:${salt}`, { ifAvailable: true }, directLock => {
      if (!directLock) throw new Error('Finish or close the active wallet request before cancelling.')
      const session = requireLaunch(salt)
      if (!canCancelLaunch(session)) throw new Error('This launch may already be submitted. Resume it to check its execution before starting another.')
      localStorage.setItem(`${FUND_LAUNCH_KEY}:cancelled:${salt}`, encodeLaunchSession(session))
      localStorage.removeItem(FUND_LAUNCH_KEY)
    })
  })
}
