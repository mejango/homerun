/**
 * No app-local hold or recovery logic: the SDK's held-write view, saved-attempt recovery and copy own
 * every rule. Homerun keeps only its domain journals and the two callbacks each flow supplies
 * (`authenticate`, `confirmRetirable`). This gate fails when a copy of what the SDK owns comes back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}
const src = sources('src').map(path => ({ path, source: readFileSync(path, 'utf8') }))

it('keeps none of the app-local hold watchers, adoption, recovery or check helpers the SDK replaced', () => {
  const removed = [
    /\buseWriteHoldWatch\b/, /\buseLegacyAdoption\b/, /\badoptLegacyWrite\b/, /\brecoverFromHold\b/, /\bholdOutcome\b/,
    /\bsameShownHold\b/, /\bLegacyWriteEvidence\b/, /\bHeldIntents\b/, /\bCheckRequired\b/, /heldOnly: true/,
    // App copies of what the SDK exports (importing them is fine; defining them is not).
    /(?:function|const|let)\s+hidesShownExit\b/, /(?:function|const|let)\s+settledLine\b/,
  ]
  for (const { path, source } of src) for (const pattern of removed) expect(pattern.test(source), `${path}: ${pattern}`).toBe(false)
})

it('takes the held, released, checked and away lines from the SDK, never a copy', () => {
  const copies = [
    /Your earlier transaction went through\./, /is no longer held here/, /['"`]I checked (?:it|my wallet)\b/,
    /['`]Send it again['`]/, /This went through while you were away/, /may already be in your wallet/,
  ]
  for (const { path, source } of src) for (const pattern of copies) expect(pattern.test(source), `${path}: ${pattern}`).toBe(false)
})

it('leaves the SDK’s hold records to the SDK: no storage keys, and held states read only by the write adapter', () => {
  // The write hold adapter (useReviewedAction), its controller, and the cross-wallet project-admin scan open holds directly.
  const adapters = ['src/lib/write-hold.ts', 'src/hooks/useReviewedAction.ts', 'src/lib/project-admin-reservation.ts']
  for (const { path, source } of src) {
    expect(/nana-sdk:/.test(source), `${path} names an SDK storage key`).toBe(false)
    if (adapters.includes(path)) continue
    expect(/\.peek\(\)|\bholds\.open\(|createBrowserWriteRecovery|readBrowserWriteRecovery/.test(source), `${path} reads a hold itself`).toBe(false)
  }
})

it('takes every held-write view from the SDK’s review/react hooks, never binding one itself', () => {
  for (const { path, source } of src) {
    expect(/@bananapus\/nana-sdk-react|held-binding/.test(source), `${path} uses a binding other than the SDK's`).toBe(false)
    expect(/\bcreateHeldWriteView\b/.test(source), `${path} binds a held-write view itself`).toBe(false)
    if (path !== 'src/lib/write-hold.ts') expect(/\bcreateSavedAttemptRecovery\b/.test(source), `${path} makes its own recovery`).toBe(false)
  }
})

it('recovers every saved journal through the SDK, shows its check, and retires an exit', () => {
  const flows = ['FundDeploy', 'IncomeLaunch', 'StickyCreate', 'ProjectShopManagement', 'FundOperatorActions', 'ProjectPayerAddresses', 'StickyHolder']
  for (const name of flows) {
    const source = readFileSync(`src/components/${name}.tsx`, 'utf8')
    expect(/\buseSavedAttempt\(/.test(source), `${name} recovers through useSavedAttempt`).toBe(true)
    expect(/<SavedAttemptNotice\b/.test(source), `${name} shows the SDK's check action`).toBe(true)
    // A held write's exit retires its saved attempt, so recovery never asks for it again (StickyHolder's record goes once held).
    if (name !== 'StickyHolder') expect(/\bretiringExit\(/.test(source), `${name} retires its exit`).toBe(true)
  }
})

it('presses every check action a flow offers in a test', () => {
  const tests = sources('test').map(path => readFileSync(path, 'utf8')).join('\n')
  const nexts = new Set(src.flatMap(({ source }) => [...source.matchAll(/checkNext: ['"]([^'"]+)['"]/g)].map(match => match[1])))
  expect(nexts.size).toBeGreaterThan(0)
  for (const next of nexts) expect(tests.includes(`checkedItLabel('${next}')`), `no test presses "I checked it. ${next}."`).toBe(true)
  // A flow with the default action ("Review it again").
  expect(tests.includes('checkedItLabel()')).toBe(true)
})
