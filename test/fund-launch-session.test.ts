import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, zeroAddress, zeroHash, type Hex } from 'viem'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { adoptFundLaunchProposal, FUND_LAUNCH_KEY, archiveLaunch, canCancelLaunch, cancelUnsubmittedLaunch, decodeLaunchSession, discardUnsignedLaunch, encodeLaunchSession, refreshLaunchCreationFee, saveLaunch, sameSender, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'
import { failReservationReadback } from './support/reservation-storage'

const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const hash = `0x${'ab'.repeat(32)}` as Hex
const otherHash = `0x${'cd'.repeat(32)}` as Hex
function session(): FundLaunchSession {
  return { version: 1, name: '2026n', input: { owner, sender: owner, chainIds: [8453, 10], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 1_800_000_000, creationFees: { 8453: 9_007_199_254_740_993n, 10: 2n } }, statuses: { 8453: { phase: 'ready' }, 10: { phase: 'ready' } } }
}
beforeEach(() => localStorage.clear())

describe('durable FUND deployment journal', () => {
  it.each(['launch', 'setup'] as const)('rolls back only its exact %s reservation after a failed readback', kind => {
    for (const replacement of [undefined, 'replacement']) {
      const storage = localStorage
      storage.clear()
      const previous = saveLaunch(session()).statuses[8453], raw = storage.getItem(FUND_LAUNCH_KEY)
      const attemptId = crypto.randomUUID()
      const next = kind === 'launch' ? { phase: 'signing' as const, safe: false, attemptId }
        : { phase: 'ready' as const, multisigSetup: { safe: false, attemptId } }
      vi.stubGlobal('localStorage', failReservationReadback(storage, FUND_LAUNCH_KEY, { replacement }))
      try { expect(() => updateLaunchStatus(salt, 8453, next, previous.phase, previous, true)).toThrow() }
      finally { vi.unstubAllGlobals() }
      expect(storage.getItem(FUND_LAUNCH_KEY)).toBe(replacement ?? raw)
    }
  })
  it('roundtrips exact fees without converting user text into bigint', () => {
    expect(decodeLaunchSession(encodeLaunchSession(session()))).toEqual(session())
    const legacy = JSON.parse(encodeLaunchSession(session()))
    legacy.input.creationFees['8453'] = '9007199254740993n'
    expect(decodeLaunchSession(JSON.stringify(legacy)).input.creationFees[8453]).toBe(9_007_199_254_740_993n)
  })
  it('rejects invalid salts, owners, fees, networks, metadata and progress records', () => {
    const changes = [
      { salt: zeroHash }, { owner: zeroAddress }, { mustStartAtOrAfter: -1 },
      { chainIds: [8453, 84532] }, { chainIds: [8453, 8453] }, { projectUri: 'ipfs://' },
      { creationFees: { 8453: -1n, 10: 0n } },
    ]
    for (const change of changes) expect(() => decodeLaunchSession(encodeLaunchSession({ ...session(), input: { ...session().input, ...change } }))).toThrow()
    for (const status of [{ phase: 'pending' }, { phase: 'reverted' }, { phase: 'confirmed', hash, projectId: '0' }, { phase: 'ready', hash }, { phase: 'pending', hash, safe: 'false' }]) {
      const raw = JSON.parse(encodeLaunchSession(session())); raw.statuses[8453] = status
      expect(() => decodeLaunchSession(JSON.stringify(raw))).toThrow()
    }
  })
  it('rejects changes to a frozen launch and protects another saved launch', () => {
    const original = saveLaunch(session())
    expect(() => saveLaunch({ ...original, input: { ...original.input, salt: otherHash } })).toThrow(/already saved/)
    expect(() => saveLaunch({ ...original, input: { ...original.input, owner: '0x2222222222222222222222222222222222222222' } })).toThrow(/immutable/)
    expect(() => saveLaunch({ ...original, input: { ...original.input, mustStartAtOrAfter: original.input.mustStartAtOrAfter + 1 } })).toThrow(/immutable/)
  })
  it('accepts legacy recovery without inventing wallet provenance and rejects malformed provenance', () => {
    const legacy = session()
    legacy.statuses[8453] = { phase: 'pending', hash, multisigSetup: { safe: true, hash } }
    expect(decodeLaunchSession(encodeLaunchSession(legacy)).statuses[8453].walletReturned).toBeUndefined()
    expect(decodeLaunchSession(encodeLaunchSession(legacy)).statuses[8453].attemptId).toBeUndefined()
    for (const status of [
      { phase: 'pending', hash, walletReturned: false }, { phase: 'pending', hash, walletReturned: 'true' },
      { phase: 'signing', walletReturned: true }, { phase: 'ready', multisigSetup: { safe: true, walletReturned: true } },
      { phase: 'ready', multisigSetup: { safe: true, hash, walletReturned: false } },
      { phase: 'signing', attemptId: 'not-a-uuid' }, { phase: 'signing', attemptId: 1 },
      { phase: 'ready', multisigSetup: { safe: true, attemptId: 'not-a-uuid' } },
    ]) {
      const raw = JSON.parse(encodeLaunchSession(session())); raw.statuses[8453] = status
      expect(() => decodeLaunchSession(JSON.stringify(raw))).toThrow()
    }
  })
  it.each([undefined, hash])('holds a saved multisig setup through unsigned discard, cancellation and transport changes (%s)', setupHash => {
    const current = session()
    current.statuses[8453] = { phase: 'ready', multisigSetup: { safe: true, ...(setupHash ? { hash: setupHash } : {}) } }
    saveLaunch(current)
    expect(canCancelLaunch(current)).toBe(false)
    expect(discardUnsignedLaunch(salt)).toBe(false)
    expect(() => saveLaunch({ ...current, transport: 'relayr' })).toThrow(/cannot change transport/)
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)).toEqual(current)
  })
  it('merges two chain completions without stale-closure progress loss', () => {
    const stale = saveLaunch(session())
    updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')
    expect(() => saveLaunch({ ...stale, statuses: { ...stale.statuses, 10: { phase: 'signing' } } })).toThrow(/changed elsewhere/)
    const merged = updateLaunchStatus(salt, 10, { phase: 'signing' }, 'ready')
    expect(merged.statuses[8453].phase).toBe('signing')
    expect(merged.statuses[10].phase).toBe('signing')
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')).toThrow(/already being handled/)
  })
  it.each(['launch', 'setup'] as const)('rejects stale %s callbacks after an identical same-clock retry', kind => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      saveLaunch(session())
      const firstId = globalThis.crypto.randomUUID(), secondId = globalThis.crypto.randomUUID()
      expect(firstId).not.toBe(secondId)
      const attempt = (attemptId: string) => kind === 'launch'
        ? { phase: 'signing' as const, safe: false, attemptId }
        : { phase: 'ready' as const, multisigSetup: { safe: false, attemptId } }
      const first = updateLaunchStatus(salt, 8453, attempt(firstId), 'ready').statuses[8453]
      const ready = updateLaunchStatus(salt, 8453, { phase: 'ready' }, kind === 'launch' ? 'signing' : undefined, first).statuses[8453]
      const second = updateLaunchStatus(salt, 8453, attempt(secondId), 'ready', ready).statuses[8453]
      const staleSubmitted = kind === 'launch'
        ? { ...first, phase: 'pending' as const, hash, walletReturned: true as const }
        : { ...first, multisigSetup: { ...first.multisigSetup!, hash, walletReturned: true as const } }
      expect(() => updateLaunchStatus(salt, 8453, staleSubmitted, undefined, first)).toThrow(/changed in another tab/)
      expect(() => updateLaunchStatus(salt, 8453, { phase: 'ready' }, undefined, first)).toThrow(/changed in another tab/)
      expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453]).toEqual(second)
    } finally { clock.mockRestore() }
  })
  it('never resets a pending transaction or replaces a confirmed project', () => {
    saveLaunch(session())
    updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')
    updateLaunchStatus(salt, 8453, { phase: 'pending', hash, safe: false })
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'ready' })).toThrow()
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'pending', hash: otherHash, safe: false })).toThrow(/pending transaction/)
    updateLaunchStatus(salt, 8453, { phase: 'confirmed', hash, projectId: '17' })
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'confirmed', hash, projectId: '18' })).toThrow(/cannot be replaced/)
  })
  it('does not withdraw a multisig attempt whose hash was recorded by another tab', () => {
    saveLaunch(session())
    const reserved = updateLaunchStatus(salt, 8453, { phase: 'ready', multisigSetup: { safe: true } }).statuses[8453]
    const submitted = { ...reserved, multisigSetup: { safe: true, hash } }
    updateLaunchStatus(salt, 8453, submitted, undefined, reserved)
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'ready' }, undefined, reserved)).toThrow(/changed in another tab/)
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453]).toEqual(submitted)
  })
  it('refreshes fees only before a new attempt, retaining other chain fees and frozen payload', () => {
    saveLaunch(session())
    const updated = refreshLaunchCreationFee(salt, 10, 5n)
    expect(updated.input.creationFees).toEqual({ 8453: 9_007_199_254_740_993n, 10: 5n })
    expect(updated.input.salt).toBe(salt)
    updateLaunchStatus(salt, 10, { phase: 'signing' }, 'ready')
    expect(() => refreshLaunchCreationFee(salt, 10, 6n)).toThrow(/unsubmitted or reverted/)
    updateLaunchStatus(salt, 10, { phase: 'pending', hash })
    expect(() => refreshLaunchCreationFee(salt, 10, 6n)).toThrow()
    updateLaunchStatus(salt, 10, { phase: 'reverted', hash })
    expect(refreshLaunchCreationFee(salt, 10, 6n).input.creationFees[10]).toBe(6n)
  })
  it('archives only complete linked launches, keeping the original record', () => {
    saveLaunch(session())
    expect(() => archiveLaunch(salt)).toThrow(/every linked deployment/)
    for (const id of [8453, 10]) {
      updateLaunchStatus(salt, id, { phase: 'signing' })
      updateLaunchStatus(salt, id, { phase: 'pending', hash })
      updateLaunchStatus(salt, id, { phase: 'confirmed', hash, projectId: `${id}` })
    }
    archiveLaunch(salt)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    const history = JSON.parse(localStorage.getItem(`${FUND_LAUNCH_KEY}:history`)!)
    expect(decodeLaunchSession(history[0]).statuses[10].projectId).toBe('10')
  })
  it('rejects a disconnected or changed sender before a resumed chain launch', () => {
    expect(() => sameSender(undefined, owner)).toThrow(/Reconnect/)
    expect(() => sameSender('0x2222222222222222222222222222222222222222', owner)).toThrow(/Reconnect/)
    expect(() => sameSender(owner, owner)).not.toThrow()
  })

  const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
  function publishedSession(): FundLaunchSession {
    return { ...session(), transport: 'intent', intentId }
  }

  it('stores a published project as an intent transport with no wallet progress', () => {
    const saved = saveLaunch(publishedSession())
    expect(saved.transport).toBe('intent')
    expect(saved.intentId).toBe(intentId)
    expect(decodeLaunchSession(encodeLaunchSession(saved))).toEqual(publishedSession())
  })

  it('rejects an intent record that claims a transaction, a relay, or an invalid id', () => {
    const withStatus = JSON.parse(encodeLaunchSession(publishedSession()))
    withStatus.statuses[8453] = { phase: 'pending', hash }
    expect(() => decodeLaunchSession(JSON.stringify(withStatus))).toThrow()
    const withRelayr = JSON.parse(encodeLaunchSession(publishedSession()))
    withRelayr.relayr = { phase: 'signing', signed: [], records: [] }
    expect(() => decodeLaunchSession(JSON.stringify(withRelayr))).toThrow()
    const badId = JSON.parse(encodeLaunchSession(publishedSession()))
    badId.intentId = 'not-a-uuid'
    expect(() => decodeLaunchSession(JSON.stringify(badId))).toThrow()
    const strayId = JSON.parse(encodeLaunchSession(session()))
    strayId.intentId = intentId
    expect(() => decodeLaunchSession(JSON.stringify(strayId))).toThrow()
  })

  it('never replaces or cancels a published project, and never follows edited networks', () => {
    const saved = saveLaunch(publishedSession())
    expect(() => saveLaunch({ ...saved, intentId: '0f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f' })).toThrow(/cannot be replaced/)
    expect(canCancelLaunch(saved)).toBe(false)
    expect(discardUnsignedLaunch(saved.input.salt)).toBe(false)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  })

  it('archives a published project so another can be prepared', () => {
    const saved = saveLaunch(publishedSession())
    archiveLaunch(saved.input.salt)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(`${FUND_LAUNCH_KEY}:history`)!)).toHaveLength(1)
  })
})

describe('cancelling a relayed launch', () => {
  const stubLocks = () => vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, fn: (lock: object) => Promise<void>) => fn({}) } })
  const published = (relayr: Partial<NonNullable<FundLaunchSession['relayr']>> = {}): FundLaunchSession => ({
    ...session(), transport: 'relayr', statuses: { 8453: { phase: 'authorized' }, 10: { phase: 'authorized' } },
    relayr: { account: owner, phase: 'quoted', signed: [], records: [], published: true, ...relayr },
  })

  it('offers cancelling a published launch only once its requests were found dead', () => {
    expect(canCancelLaunch(published())).toBe(false)
    expect(canCancelLaunch(published({ abandonable: true }))).toBe(true)
    // A chain already created stays created; the launch's record keeps its project.
    const partial = published({ abandonable: true })
    partial.statuses = { 8453: { phase: 'confirmed', hash, projectId: '12' }, 10: { phase: 'expired' } }
    expect(canCancelLaunch(partial)).toBe(true)
  })

  it('removes a published launch only when its requests are proven dead now, keeping its record', async () => {
    stubLocks()
    const saved = saveLaunch(published({ abandonable: true }))
    await expect(cancelUnsubmittedLaunch(saved.input.salt)).rejects.toThrow(/can still run/)
    await expect(cancelUnsubmittedLaunch(saved.input.salt, async () => false)).rejects.toThrow(/can still run/)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
    await cancelUnsubmittedLaunch(saved.input.salt, async launch => launch.relayr?.abandonable === true)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(`${FUND_LAUNCH_KEY}:cancelled:${saved.input.salt}`)!).relayr.abandonable).toBe(true)
  })

  it('refuses a published launch that was not found dead, however the proof answers', async () => {
    stubLocks()
    const saved = saveLaunch(published())
    await expect(cancelUnsubmittedLaunch(saved.input.salt, async () => true)).rejects.toThrow(/may already be submitted/)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  })

  it('cancels a launch whose signatures were refreshed before anything was published, with no proof to ask for', async () => {
    stubLocks()
    const proof = vi.fn(async () => false)
    const saved = saveLaunch({ ...session(), transport: 'relayr', statuses: { 8453: { phase: 'authorized' }, 10: { phase: 'ready' } },
      relayr: { account: owner, phase: 'signing', signed: [], records: [], retryNonces: { 8453: '0' } } })
    expect(canCancelLaunch(saved)).toBe(true)
    await cancelUnsubmittedLaunch(saved.input.salt, proof)
    expect(proof).not.toHaveBeenCalled()
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
  })

  it('asks for no proof of a launch that never published a signature', async () => {
    stubLocks()
    const proof = vi.fn(async () => false)
    const saved = saveLaunch({ ...session(), transport: 'relayr', statuses: { 8453: { phase: 'signing' }, 10: { phase: 'ready' } }, relayr: { account: owner, phase: 'signing', signed: [], records: [] } })
    await cancelUnsubmittedLaunch(saved.input.salt, proof)
    expect(proof).not.toHaveBeenCalled()
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
  })
})

describe('reading a saved Relayr journal', () => {
  type Journal = Record<string, any>
  const call = (chain: number) => ({ chain, target: owner, data: '0x1234', value: '0' })
  const signed = (chainId: number) => ({ chainId, entry: call(chainId), nonce: '0', deadline: 1_900_003_600 })
  const journal = (): Journal => ({ account: owner, phase: 'quoted', signed: [signed(8453), signed(10)], superseded: [{ ...signed(10), unposted: true }],
    retryNonces: { 8453: '0', 10: '0' }, records: [], published: true, abandonable: true })
  const decoded = (relayr: unknown) => decodeLaunchSession(JSON.stringify({ ...JSON.parse(encodeLaunchSession(session())), transport: 'relayr',
    statuses: { 8453: { phase: 'authorized' }, 10: { phase: 'authorized' } }, relayr }))

  it('keeps a journal that rotated its signatures and marked those it never posted', () => {
    expect(decoded(journal()).relayr).toEqual(journal())
    expect(decoded({ account: owner, phase: 'signing', signed: [], records: [] }).relayr?.phase).toBe('signing')
  })

  it.each<[string, (value: Journal) => void]>([
    ['no account', value => { delete value.account }],
    ['an account that is not an address', value => { value.account = '0x12' }],
    ['an unknown phase', value => { value.phase = 'done' }],
    ['signatures that are not a list', value => { value.signed = {} }],
    ['signatures that are an empty string', value => { value.signed = '' }],
    ['superseded signatures that are not a list', value => { value.superseded = {} }],
    ['superseded signatures that are an empty string', value => { value.superseded = '' }],
    ['records that are not a list', value => { value.records = {} }],
    ['a quote asked for and no published mark', value => { delete value.published }],
    ['a published mark other than true', value => { value.published = 'yes' }],
    ['a journal still signing with a published mark of false', value => { value.phase = 'signing'; value.published = false }],
    ['abandonable set to false', value => { value.abandonable = false }],
    ['abandonable set to a string', value => { value.abandonable = 'true' }],
    ['a signature of a chain outside the launch', value => { value.signed[0] = signed(1) }],
    ['a deadline that is not a positive integer', value => { value.signed[0].deadline = 0 }],
    ['a nonce that is not decimal', value => { value.signed[0].nonce = '0x1' }],
    ['a signature without its call', value => { delete value.signed[0].entry }],
    ['a call on another chain than its signature', value => { value.signed[0].entry.chain = 10 }],
    ['a call to something that is not an address', value => { value.signed[0].entry.target = 'forwarder' }],
    ['call data that is not hex', value => { value.signed[0].entry.data = '0x123' }],
    ['a call value that is not decimal', value => { value.signed[0].entry.value = '0x1' }],
    ['a superseded signature that cannot be read', value => { value.superseded[0].nonce = 1 }],
    ['an unposted mark other than true', value => { value.superseded[0].unposted = 'yes' }],
    ['saved nonces that are not a map', value => { value.retryNonces = [] }],
    ['a saved nonce of a chain outside the launch', value => { value.retryNonces = { 1: '0' } }],
    ['a saved nonce that is not decimal', value => { value.retryNonces = { 8453: 0 } }],
  ])('refuses a journal with %s', (_name, change) => {
    const value = journal()
    change(value)
    expect(() => decoded(value)).toThrow()
  })

  it('refuses a journal that is not an object', () => {
    for (const value of [null, 'journal', 7]) expect(() => decoded(value)).toThrow()
  })

  it('refuses to save a journal it would refuse to read, so no record can be written that frees a launch wrongly', () => {
    const unpublished = { ...session(), transport: 'relayr' as const, statuses: { 8453: { phase: 'authorized' as const }, 10: { phase: 'authorized' as const } },
      relayr: { ...journal(), published: undefined, abandonable: undefined } as unknown as FundLaunchSession['relayr'] }
    expect(() => saveLaunch(unpublished)).toThrow()
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
  })
})

describe('what a relayed launch chain may read as the finalized chain moves on', () => {
  const statusOf = (phase: string, hash: Hex = '0x' + 'ab'.repeat(32) as Hex) => ({
    ready: { phase: 'ready' }, authorized: { phase: 'authorized' }, unresolved: { phase: 'unresolved' }, expired: { phase: 'expired' },
    reverted: { phase: 'reverted', hash }, confirmed: { phase: 'confirmed', hash, projectId: '12' },
  } as Record<string, FundLaunchSession['statuses'][number]>)[phase]
  const relayed = (phase: string): FundLaunchSession => ({
    ...session(), transport: 'relayr', statuses: { 8453: statusOf(phase), 10: { phase: 'authorized' } },
  })
  /** Saves a launch whose Base chain reads `from`, then moves it to `to`. */
  const move = (from: string, to: string) => {
    const saved = saveLaunch(relayed(from))
    return () => updateLaunchStatus(saved.input.salt, 8453, statusOf(to))
  }

  it.each([
    ['authorized', 'unresolved'], ['authorized', 'expired'], ['authorized', 'reverted'],
    ['unresolved', 'expired'], ['unresolved', 'reverted'], ['unresolved', 'confirmed'],
    // A request found unused can be found run, or reverted, once the node answers; a revert can be found expired or run.
    ['expired', 'unresolved'], ['expired', 'reverted'],
    ['reverted', 'unresolved'], ['reverted', 'expired'],
  ])('lets a chain read %s be read %s', (from, to) => {
    expect(move(from, to)).not.toThrow()
    expect(saved(to)).toBe(true)
  })

  it.each([
    ['confirmed', 'unresolved'], ['confirmed', 'expired'], ['confirmed', 'reverted'], ['confirmed', 'authorized'],
    ['expired', 'confirmed'], ['expired', 'authorized'], ['reverted', 'confirmed'], ['reverted', 'authorized'],
    ['unresolved', 'authorized'],
  ])('never lets a chain read %s be read %s', (from, to) => {
    expect(move(from, to)).toThrow(/changed elsewhere/)
  })

  function saved(phase: string): boolean {
    return JSON.parse(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453].phase === phase
  }
})


describe('existing FUND Safe proposal adoption', () => {
  const proposalFor = (saved: FundLaunchSession) => {
    const request = buildFundLaunch(saved.input).requests.find(item => item.chainId === 8453)!
    return { proposalHash: hash, call: { to: request.address, data: encodeFunctionData(request), value: request.value } }
  }
  it('adopts a ready exact immutable plan without a signing transition or changing another chain', () => {
    const original = saveLaunch(session())
    updateLaunchStatus(salt, 10, { phase: 'signing' })
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'pending', hash, safe: true })).toThrow('changed elsewhere')
    const adopted = adoptFundLaunchProposal(salt, 8453, proposalFor(original))
    expect(adopted.statuses[8453]).toEqual({ phase: 'pending', hash, safe: true, walletReturned: true, attemptId: expect.any(String) })
    expect(adopted.statuses[10].phase).toBe('signing')
    expect(adopted.input).toEqual(original.input)
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)).toEqual(adopted)
    expect(() => adoptFundLaunchProposal(salt, 8453, proposalFor(original))).toThrow('Only an unsubmitted')
  })
  it('adopts after a proven reverted attempt but refuses a different plan, hash or transport', () => {
    const original = saveLaunch(session()), proposal = proposalFor(original)
    for (const changed of [{ ...proposal, proposalHash: zeroHash }, { ...proposal, call: { ...proposal.call, value: 0n } }])
      expect(() => adoptFundLaunchProposal(salt, 8453, changed)).toThrow()
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)).toEqual(original)
    updateLaunchStatus(salt, 8453, { phase: 'signing' })
    updateLaunchStatus(salt, 8453, { phase: 'pending', hash: otherHash })
    updateLaunchStatus(salt, 8453, { phase: 'reverted', hash: otherHash })
    expect(adoptFundLaunchProposal(salt, 8453, proposal).statuses[8453]).toEqual({ phase: 'pending', safe: true, hash, walletReturned: true, attemptId: expect.any(String) })
    localStorage.clear()
    saveLaunch({ ...session(), transport: 'intent' })
    expect(() => adoptFundLaunchProposal(salt, 8453, proposal)).toThrow('direct deployment')
  })
})
