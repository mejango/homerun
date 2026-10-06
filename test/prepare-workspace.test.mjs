import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencies } from '../script/deploy.mjs'
import { pinnedInstalls } from '../scripts/prepare-workspace.mjs'

const pins = {
  'core/node_modules/@scope/library': '1.2.3',
  'core/node_modules/pinned-to-git': '1.0.0',
  'core/node_modules/ranged': '2.0.0',
  'other/node_modules/transitive': '3.1.4',
}
const declared = sibling => ({
  core: { '@scope/library': '1.2.3', 'pinned-to-git': 'github:org/pinned-to-git#0123456789abcdef', ranged: '^2.0.0' },
  other: {},
})[sibling]

test('every pinned registry package is installed at exactly its pinned version, in the sibling that holds it', () => {
  assert.deepEqual([...pinnedInstalls(pins, declared)], [
    ['core', ['@scope/library@1.2.3', 'ranged@2.0.0']],
    ['other', ['transitive@3.1.4']],
  ])
})

test('a package the sibling takes from git or a URL is left to the sibling\'s own pin', () => {
  for (const spec of ['github:org/name#abc', 'git+ssh://git@github.com/org/name.git#abc', 'git://example.test/name.git', 'https://example.test/name.tgz']) {
    assert.equal(pinnedInstalls({ 'core/node_modules/name': '1.0.0' }, () => ({ name: spec })).size, 0, spec)
  }
})

const script = fileURLToPath(new URL('../scripts/prepare-workspace.mjs', import.meta.url))

// A workspace that already holds every sibling makes the script stop at the first one, which proves that it ran
// without cloning or installing anything.
function runInOccupiedWorkspace(entry, t) {
  const workspace = mkdtempSync(join(tmpdir(), 'prepare-workspace-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  for (const name of Object.keys(dependencies)) mkdirSync(join(workspace, name))
  return spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, HOMERUN_WORKSPACE_PATH: workspace } })
}

test('started by its path, the script runs', t => {
  const result = runInOccupiedWorkspace(script, t)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exists; this script only creates checkouts/)
})

test('started through a symlinked directory, the script still runs instead of exiting 0 having done nothing', t => {
  const links = mkdtempSync(join(tmpdir(), 'prepare-workspace-links-'))
  t.after(() => rmSync(links, { recursive: true, force: true }))
  symlinkSync(dirname(script), join(links, 'scripts'))
  const result = runInOccupiedWorkspace(join(links, 'scripts', 'prepare-workspace.mjs'), t)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exists; this script only creates checkouts/)
})
