import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { devPort, portOf } from './support/browser-suites.mjs'

test('the dev port is read from the dev script', () => {
  assert.equal(portOf('node scripts/stage-public.mjs && next dev --webpack --port 3010'), 3010)
  assert.equal(portOf('next dev --port=3011'), 3011)
  assert.throws(() => portOf('next dev --webpack'), /--port/)
})

test('package.json still gives npm run dev a port the suites can read', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(devPort(), portOf(scripts.dev))
})
