import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isEntrypoint } from '../scripts/entrypoint.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

const workspace = mkdtempSync(join(tmpdir(), 'entrypoint-'))
after(() => rmSync(workspace, { recursive: true, force: true }))
mkdirSync(join(workspace, 'real'))
const tool = join(workspace, 'real', 'tool.mjs')
const other = join(workspace, 'real', 'other.mjs')
writeFileSync(tool, '')
writeFileSync(other, '')
symlinkSync(join(workspace, 'real'), join(workspace, 'linked-directory'))
symlinkSync(tool, join(workspace, 'linked-file.mjs'))
symlinkSync(join(repository, 'script'), join(workspace, 'script'))
symlinkSync(join(repository, 'scripts'), join(workspace, 'scripts'))
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

test('it is also when the module URL keeps the symlink, as under node --preserve-symlinks-main', () => {
  const linked = join(workspace, 'linked-directory', 'tool.mjs')
  assert.equal(isEntrypoint(pathToFileURL(linked).href, linked), true)
  assert.equal(isEntrypoint(pathToFileURL(linked).href, tool), true)
})

test('a path that does not exist, or a module URL that is no file, is not the entry point and not an error', () => {
  assert.equal(isEntrypoint(url, join(workspace, 'missing.mjs')), false)
  // `node -` reads the script from stdin and gives process.argv[1] as "-".
  assert.equal(isEntrypoint(url, '-'), false)
  assert.equal(isEntrypoint('data:text/javascript,0', tool), false)
})

// Each of these reaches a usage error only when its entry check holds. Started through a symlinked directory, they used
// to exit 0 having done nothing.
for (const [name, argv, message] of [
  ['script/deploy.mjs', [join(workspace, 'script', 'deploy.mjs')], /Usage: deploy\.sh/],
  ['script/artifacts.mjs', [join(workspace, 'script', 'artifacts.mjs')], /Usage: artifacts\.mjs/],
  ['scripts/prepare-income-release.mts', ['--import', 'tsx', join(workspace, 'scripts', 'prepare-income-release.mts'), 'argument'], /accepts no wallet, address, broadcast, or network options/],
]) {
  test(`${name} started through a symlinked directory runs instead of exiting 0 having done nothing`, () => {
    const result = spawnSync(process.execPath, argv, { cwd: repository, encoding: 'utf8', timeout: 60_000 })
    assert.match(result.stderr, message)
    assert.equal(result.status, 1)
  })
}

test('no script compares process.argv[1] with its own URL by hand', () => {
  const offenders = []
  for (const directory of ['script', 'scripts']) {
    for (const name of readdirSync(join(repository, directory))) {
      if (!/\.(mjs|mts|cjs|js|ts)$/.test(name) || (directory === 'scripts' && name === 'entrypoint.mjs')) continue
      const source = readFileSync(join(repository, directory, name), 'utf8')
      if (/argv\[1\].*import\.meta\.url|import\.meta\.url.*argv\[1\]/.test(source)) offenders.push(`${directory}/${name}`)
    }
  }
  assert.deepEqual(offenders, [], 'use isEntrypoint(import.meta.url) from scripts/entrypoint.mjs')
})
