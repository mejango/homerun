import type { JBCenterDeploymentInput } from '@bananapus/nana-sdk-core/jbcenter'
import type { Hex } from 'viem'

/**
 * A project this browser paid for and created, which Juicebox Center has not
 * recorded yet. It is kept so a reload cannot send the same creation twice; it
 * stays in the one browser that made it and reaches nobody else.
 */
export const RELAY_HELD_KEY = 'homerun:relay-held:v1'

/** Enough room for every chain of a few projects, and no growth beyond that. */
const HELD_LIMIT = 24

type HeldRecord = { intentId: string; chainId: number; projectId: string; transactionHash: Hex }

const INTENT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function readable(value: unknown): value is HeldRecord {
  const record = value as Partial<HeldRecord> | null
  return !!record && typeof record === 'object'
    && typeof record.intentId === 'string' && INTENT_ID.test(record.intentId)
    && Number.isSafeInteger(record.chainId) && (record.chainId as number) > 0
    && typeof record.projectId === 'string' && /^\d{1,78}$/.test(record.projectId)
    && typeof record.transactionHash === 'string' && /^0x[\da-f]{64}$/i.test(record.transactionHash)
}

function readAll(): HeldRecord[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RELAY_HELD_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter(readable) : []
  } catch { return [] }
}

function writeAll(records: readonly HeldRecord[]): void {
  try {
    if (!records.length) localStorage.removeItem(RELAY_HELD_KEY)
    else localStorage.setItem(RELAY_HELD_KEY, JSON.stringify(records.slice(-HELD_LIMIT)))
  } catch { /* this browser keeps no storage; the run still records what it created */ }
}

/** The projects this browser created for one intent, by chain. */
export function loadHeldDeployments(intentId: string): Map<number, JBCenterDeploymentInput> {
  return new Map(readAll()
    .filter(record => record.intentId === intentId)
    .map(record => [record.chainId, { chainId: record.chainId, projectId: record.projectId, transactionHash: record.transactionHash }]))
}

/** Held the moment the receipt is read, before Center is asked to record it. */
export function holdDeployment(intentId: string, deployment: JBCenterDeploymentInput): void {
  const record = { intentId, ...deployment }
  if (!readable(record)) return
  writeAll([...readAll().filter(saved => saved.intentId !== intentId || saved.chainId !== deployment.chainId), record])
}

export function releaseDeployment(intentId: string, chainId: number): void {
  writeAll(readAll().filter(saved => saved.intentId !== intentId || saved.chainId !== chainId))
}
