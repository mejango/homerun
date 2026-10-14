/**
 * Every screen that looks for a held write on load (`heldOnly`) must also recover what that hold
 * settled while the page was away, through the shared `recoverFromHold` rule: a settled write is never
 * discarded, so it is never offered to be sent again. Each flow's own behavior is tested in its suite:
 * Sticky creation, INCOME launch, FUND launch and multisig setup, shop steps and linked ruleset chains.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/** Fixed actions keep no record of their own: their result is the project's state, which their buttons read. */
const NO_DOMAIN_RECORD = ['src/components/ui/HeldIntents.tsx']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

it('routes every held-write lookup on load through the shared settled-write recovery', () => {
  const consumers = sources('src').filter(path => /heldOnly: true/.test(readFileSync(path, 'utf8')))
  expect(consumers.length).toBeGreaterThan(0)
  for (const path of consumers) {
    if (NO_DOMAIN_RECORD.includes(path)) continue
    const source = readFileSync(path, 'utf8')
    const lookups = source.match(/heldOnly: true/g)!.length, recoveries = source.match(/recoverFromHold\(/g)?.length ?? 0
    expect(recoveries, `${path}: ${lookups} held-write lookups, ${recoveries} recoveries`).toBeGreaterThanOrEqual(lookups)
  }
})

it('presses every check-required exit in a test that then finds the next step usable', () => {
  const tests = sources('test').map(path => readFileSync(path, 'utf8'))
  const exits = new Set(sources('src').flatMap(path => [...readFileSync(path, 'utf8').matchAll(/<CheckRequired[^>]*?action="([^"]+)"/g)].map(match => match[1])))
  expect(exits.size).toBeGreaterThan(0)
  for (const label of exits) {
    // Pressed (as a click or a button press), and in the same test file something is then asserted enabled or done.
    const pressing = tests.filter(source => source.includes(`click('${label}')`) || source.includes(`button('${label}')!.click()`))
    expect(pressing.length, `no test presses "${label}"`).toBeGreaterThan(0)
    expect(pressing.some(source => /disabled[^\n]*\.toBe\(false\)|toBeNull\(\)/.test(source.slice(source.indexOf(label)))), `"${label}" is pressed, but no usable next step is asserted after it`).toBe(true)
  }
})

