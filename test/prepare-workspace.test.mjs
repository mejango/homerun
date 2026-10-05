import test from 'node:test'
import assert from 'node:assert/strict'
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
