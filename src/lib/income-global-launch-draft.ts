/** A small frozen plan; the complete holder manifest lives in the published file. */
import { decodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, zeroHash, type Address, type Hex } from 'viem'
import { FUND_CHAIN_IDS } from './fund-contracts'
import { fundGlobalManifestHash, parseFundGlobalManifest, type FundGlobalManifest } from './fund-global-manifest'
import { homerunIncomeDeployerAbi } from './income-contracts'
import { exportIncomeLaunchPending, type IncomeLaunchPending } from './income-launch-session'

export const INCOME_GLOBAL_DRAFT_KEY = 'homerun:income-global-launch:drafts:v1'
export type IncomeGlobalChainDraft = {
  chainId: number; fundProjectId: string; initialIncomeAmount: string; stickyProjectId?: string
  /** Saved evidence must be reverified after every remount/import. */
  execution?: { hash: Hex; record: IncomeLaunchPending }
}
export type IncomeGlobalLaunchDraft = {
  version: 1; root: { chainId: number; projectId: string }; helper: Address
  manifestUri: string; manifestHash: Hex; sourceSetHash: Hex; launchSalt: Hex
  name: string; metadataUri: string; startsAtOrAfter: number; operatorBps: number; fundHolderBps: number
  chains: IncomeGlobalChainDraft[]
}
type Store = Pick<Storage, 'getItem' | 'setItem'>
const uint = (value: unknown, positive = false): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78 && BigInt(value) < 1n << 256n && (!positive || BigInt(value) > 0n)
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value) && value.toLowerCase() !== zeroHash
const chain = (value: unknown): value is number => typeof value === 'number' && FUND_CHAIN_IDS.some(id => id === value)
const ipfs = (value: unknown): value is string => typeof value === 'string' && value.length <= 2_048 && /^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(value)
const invalid = () => new Error('The saved global INCOME plan is invalid. Restore the original launch file before continuing.')
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); return value as Record<string, unknown> }

export function parseIncomeGlobalDraft(value: unknown): IncomeGlobalLaunchDraft {
  const raw = object(value), root = object(raw.root)
  if (raw.version !== 1 || !chain(root.chainId) || !uint(root.projectId, true) || typeof raw.helper !== 'string' || !isAddress(raw.helper) || isAddressEqual(raw.helper, zeroAddress)
    || !ipfs(raw.manifestUri) || !hash(raw.manifestHash) || !hash(raw.sourceSetHash) || !hash(raw.launchSalt)
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 160 || !ipfs(raw.metadataUri)
    || typeof raw.startsAtOrAfter !== 'number' || !Number.isSafeInteger(raw.startsAtOrAfter) || raw.startsAtOrAfter <= 0 || raw.startsAtOrAfter >= 2 ** 48
    || typeof raw.operatorBps !== 'number' || typeof raw.fundHolderBps !== 'number' || !Number.isInteger(raw.operatorBps) || !Number.isInteger(raw.fundHolderBps) || raw.operatorBps < 0 || raw.fundHolderBps <= 0 || raw.operatorBps + raw.fundHolderBps > 10_000
    || !Array.isArray(raw.chains) || !raw.chains.length || raw.chains.length > FUND_CHAIN_IDS.length) throw invalid()
  const descriptor: IncomeGlobalLaunchDraft = { version: 1, root: { chainId: root.chainId, projectId: root.projectId }, helper: getAddress(raw.helper), manifestUri: raw.manifestUri, manifestHash: raw.manifestHash.toLowerCase() as Hex, sourceSetHash: raw.sourceSetHash.toLowerCase() as Hex, launchSalt: raw.launchSalt.toLowerCase() as Hex, name: raw.name, metadataUri: raw.metadataUri, startsAtOrAfter: raw.startsAtOrAfter, operatorBps: raw.operatorBps, fundHolderBps: raw.fundHolderBps, chains: [] }
  for (const row of raw.chains) {
    const local = object(row)
    if (!chain(local.chainId) || !uint(local.fundProjectId, true) || !uint(local.initialIncomeAmount) || (descriptor.chains.at(-1)?.chainId ?? 0) >= local.chainId || (local.stickyProjectId !== undefined && (!uint(local.stickyProjectId, true) || local.stickyProjectId === local.fundProjectId))) throw invalid()
    const next: IncomeGlobalChainDraft = { chainId: local.chainId, fundProjectId: local.fundProjectId, initialIncomeAmount: local.initialIncomeAmount, ...(local.stickyProjectId ? { stickyProjectId: local.stickyProjectId as string } : {}) }
    if (local.execution !== undefined) {
      const evidence = object(local.execution)
      if (!hash(evidence.hash) || !next.stickyProjectId) throw invalid()
      const record = JSON.parse(exportIncomeLaunchPending(evidence.record as IncomeLaunchPending)) as IncomeLaunchPending
      const decoded = decodeFunctionData({ abi: homerunIncomeDeployerAbi, data: record.data })
      if (decoded.functionName !== 'deployIncome') throw invalid()
      const [fundId, snapshot, description, operator, stakers, stickyId, start] = decoded.args
      if (record.chainId !== next.chainId || record.projectId !== next.fundProjectId || !isAddressEqual(record.target, descriptor.helper) || fundId.toString() !== next.fundProjectId || snapshot.manifestHash.toLowerCase() !== descriptor.manifestHash || snapshot.manifestUri !== descriptor.manifestUri || snapshot.sourceSetHash.toLowerCase() !== descriptor.sourceSetHash || description.salt.toLowerCase() !== descriptor.launchSalt || description.name !== descriptor.name || description.uri !== descriptor.metadataUri || operator !== descriptor.operatorBps || stakers !== descriptor.fundHolderBps || stickyId.toString() !== next.stickyProjectId || start !== descriptor.startsAtOrAfter) throw invalid()
      next.execution = { hash: evidence.hash.toLowerCase() as Hex, record }
    }
    descriptor.chains.push(next)
  }
  if (!descriptor.chains.some(local => local.chainId === descriptor.root.chainId && local.fundProjectId === descriptor.root.projectId) || descriptor.chains.reduce((sum, local) => sum + BigInt(local.initialIncomeAmount), 0n) !== 500_000n * 10n ** 18n) throw invalid()
  return descriptor
}

export function verifyIncomeGlobalDraftManifest(draft: IncomeGlobalLaunchDraft, value: unknown): FundGlobalManifest {
  const checked = parseIncomeGlobalDraft(draft), manifest = parseFundGlobalManifest(value)
  if (!isAddressEqual(checked.helper, manifest.helper) || checked.launchSalt !== manifest.launchSalt || checked.sourceSetHash !== manifest.sourceSetHash || checked.manifestHash !== fundGlobalManifestHash(manifest) || checked.chains.length !== manifest.allocations.length || checked.chains.some((local, index) => local.chainId !== manifest.allocations[index].chainId || local.fundProjectId !== manifest.allocations[index].fundProjectId || local.initialIncomeAmount !== manifest.allocations[index].incomeAmount)) throw new Error('The published manifest does not match the frozen global launch plan.')
  return manifest
}
function allDrafts(storage: Store): IncomeGlobalLaunchDraft[] {
  const raw = storage.getItem(INCOME_GLOBAL_DRAFT_KEY)
  if (raw === null) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw invalid() }
  if (!Array.isArray(value)) throw invalid()
  const drafts = value.map(parseIncomeGlobalDraft)
  const used = new Set<string>()
  for (const draft of drafts) for (const local of draft.chains) { const key = `${local.chainId}:${local.fundProjectId}`; if (used.has(key)) throw invalid(); used.add(key) }
  return drafts
}
export function readIncomeGlobalDraft(storage: Store, chainId: number, projectId: bigint): IncomeGlobalLaunchDraft | null {
  return allDrafts(storage).find(draft => draft.chains.some(local => local.chainId === chainId && local.fundProjectId === projectId.toString())) ?? null
}
function stable(draft: IncomeGlobalLaunchDraft) { return JSON.stringify({ ...draft, chains: draft.chains.map(({ chainId, fundProjectId, initialIncomeAmount }) => ({ chainId, fundProjectId, initialIncomeAmount })) }) }
/** Merge append-only verified progress; a stale tab cannot change shared terms or erase another chain. */
export function saveIncomeGlobalDraft(storage: Store, value: IncomeGlobalLaunchDraft): IncomeGlobalLaunchDraft {
  const next = parseIncomeGlobalDraft(value), drafts = allDrafts(storage)
  const prior = drafts.find(draft => draft.chains.some(left => next.chains.some(right => left.chainId === right.chainId && left.fundProjectId === right.fundProjectId)))
  if (prior && stable(prior) !== stable(next)) throw new Error('This FUND already has a frozen global INCOME launch. Restore that plan instead of changing its terms.')
  if (prior) next.chains = next.chains.map((local, index) => {
    const old = prior.chains[index]
    if (old.stickyProjectId && local.stickyProjectId && old.stickyProjectId !== local.stickyProjectId || old.execution && local.execution && JSON.stringify(old.execution) !== JSON.stringify(local.execution)) throw new Error('A different confirmed action is already saved for this chain. Verify the existing record before continuing.')
    return { ...local, ...(old.stickyProjectId ? { stickyProjectId: old.stickyProjectId } : {}), ...(old.execution ? { execution: old.execution } : {}) }
  })
  const updated = prior ? drafts.map(draft => draft === prior ? next : draft) : [...drafts, next]
  const encoded = JSON.stringify(updated)
  storage.setItem(INCOME_GLOBAL_DRAFT_KEY, encoded)
  if (storage.getItem(INCOME_GLOBAL_DRAFT_KEY) !== encoded) throw new Error('The browser could not save the global INCOME launch. Download the plan before attempting any transaction.')
  return next
}
/** Serializes no holder list. Imported completion records remain evidence to verify, never success flags. */
export function serializeIncomeGlobalDraft(draft: IncomeGlobalLaunchDraft): string { return `${JSON.stringify(parseIncomeGlobalDraft(draft), null, 2)}\n` }
export async function withIncomeGlobalDraftLock<T>(task: () => Promise<T> | T): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('Use a browser with Web Locks support to coordinate the global launch across tabs.')
  return navigator.locks.request(INCOME_GLOBAL_DRAFT_KEY, { mode: 'exclusive' }, async lock => { if (!lock) throw new Error('The global INCOME plan is being updated in another tab.'); return task() })
}
