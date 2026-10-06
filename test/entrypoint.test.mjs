import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isEntrypoint } from '../scripts/entrypoint.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'entrypoint-'))
after(() => rmSync(workspace, { recursive: true, force: true }))
mkdirSync(join(workspace, 'real'))
const tool = join(workspace, 'real', 'tool.mjs')
const other = join(workspace, 'real', 'other.mjs')
writeFileSync(tool, '')
writeFileSync(other, '')
symlinkSync(join(workspace, 'real'), join(workspace, 'linked-directory'))
symlinkSync(tool, join(workspace, 'linked-file.mjs'))
// import.meta.url is a real path; the temporary directory's own name need not be (on macOS /var is a symlink).
const url = pathToFileURL(realpathSync(tool)).href

test('a module is the entry point when node was started with its path', () => {
  assert.equal(isEntrypoint(url, tool), true)
})

test('it is also when the path goes through a symlinked directory, or is a symlink to the module', () => {
  assert.equal(isEntrypoint(url, join(workspace, 'linked-directory', 'tool.mjs')), true)
  assert.equal(isEntrypoint(url, join(workspace, 'linked-file.mjs')), true)
})

test('it is not when node was started with another script, or with none', () => {
  assert.equal(isEntrypoint(url, other), false)
  assert.equal(isEntrypoint(url, undefined), false)
  assert.equal(isEntrypoint(url, ''), false)
})
