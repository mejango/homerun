import { beforeEach, describe, expect, it } from 'vitest'
import { zeroAddress, zeroHash, type Hex } from 'viem'
import { FUND_LAUNCH_KEY, archiveLaunch, decodeLaunchSession, encodeLaunchSession, refreshLaunchCreationFee, saveLaunch, sameSender, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'

const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const hash = `0x${'ab'.repeat(32)}` as Hex
const otherHash = `0x${'cd'.repeat(32)}` as Hex
function session(): FundLaunchSession {
  return { version: 1, name: '2026n', input: { owner, sender: owner, chainIds: [8453, 10], projectUri: 'ipfs://bafkreimetadata', salt, mustStartAtOrAfter: 1_800_000_000, creationFees: { 8453: 9_007_199_254_740_993n, 10: 2n } }, statuses: { 8453: { phase: 'ready' }, 10: { phase: 'ready' } } }
}
beforeEach(() => localStorage.clear())

describe('durable FUND deployment journal', () => {
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
  it('merges two chain completions without stale-closure progress loss', () => {
    const stale = saveLaunch(session())
    updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')
    expect(() => saveLaunch({ ...stale, statuses: { ...stale.statuses, 10: { phase: 'signing' } } })).toThrow(/changed elsewhere/)
    const merged = updateLaunchStatus(salt, 10, { phase: 'signing' }, 'ready')
    expect(merged.statuses[8453].phase).toBe('signing')
    expect(merged.statuses[10].phase).toBe('signing')
    expect(() => updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')).toThrow(/already being handled/)
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
})
