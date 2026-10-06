import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')

const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gim)]
const baseImages = []
const aliases = new Set()
for (const [, image, alias] of stages) {
  if (!aliases.has(image)) baseImages.push(image)
  if (alias) aliases.add(alias)
}

test('every base image is pinned to a tag and the digest of its multi-platform index', () => {
  assert.ok(baseImages.length > 0, 'the Dockerfile has no base image')
  for (const image of baseImages) assert.match(image, /^[^:@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/, image)
})

const finalStage = dockerfile.slice(stages.at(-1).index)
const healthcheck = finalStage.match(/^HEALTHCHECK\b.*\bCMD node -e "(.+)"$/m)?.[1]

test('the image declares a healthcheck on /api/healthz', () => {
  assert.ok(healthcheck, 'the final stage has no `HEALTHCHECK ... CMD node -e "..."`')
  assert.match(healthcheck, /\/api\/healthz/)
})

// The check's own time limit is the HEALTHCHECK's --timeout (5s in the Dockerfile).
const runHealthcheck = async port => {
  assert.ok(healthcheck, 'no healthcheck command to run')
  try {
    await promisify(execFile)(process.execPath, ['-e', healthcheck], { env: { ...process.env, PORT: String(port) }, timeout: 4500 })
    return 0
  } catch (error) {
    return error.killed ? 'timed out' : error.code
  }
}

const listening = async status => {
  const requested = []
  const server = createServer((request, response) => {
    requested.push(request.url)
    response.statusCode = status
    response.end('{"status":"ok"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, requested, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

test('the healthcheck passes on a 200 from /api/healthz and fails on a 503 or a 404', async () => {
  for (const [status, expected] of [[200, 0], [503, 1], [404, 1]]) {
    const server = await listening(status)
    try {
      assert.equal(await runHealthcheck(server.port), expected, `status ${status}`)
      assert.deepEqual(server.requested, ['/api/healthz'])
    } finally {
      await server.close()
    }
  }
})

test('the healthcheck fails when nothing is listening', async () => {
  const server = await listening(200)
  const { port } = server
  await server.close()
  assert.equal(await runHealthcheck(port), 1)
})

// The container job's smoke step, as written in ci.yml, run against stand-ins for docker and curl.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n')

function stepScript(name) {
  const at = workflow.findIndex(line => line.trim() === `- name: ${name}`)
  assert.notEqual(at, -1, `ci.yml has no step named "${name}"`)
  const end = workflow.findIndex((line, index) => index > at && /^\s*- (name|uses):/.test(line))
  const step = workflow.slice(at, end === -1 ? undefined : end)
  const run = step.findIndex(line => line.trim() === 'run: |')
  assert.notEqual(run, -1, `step "${name}" has no multi-line run`)
  const indent = step[run].search(/\S/) + 2
  return step.slice(run + 1).map(line => line.slice(indent)).join('\n')
}

// FAKE_REVISION is what /api/healthz reports (nothing: connection refused), FAKE_ROOT whether / answers, FAKE_USER the image's user.
// curl prints a failure only under --show-error, as the real one does with --silent.
const shims = {
  sleep: 'exit 0',
  docker: `case "$1" in
  inspect) echo "$FAKE_USER" ;;
  logs) echo "CONTAINER LOGS" ;;
esac`,
  curl: `for url; do :; done
case "$*" in *--show-error*) loud=true ;; *) loud=false ;; esac
case "$url" in
  */api/healthz)
    [ -n "$FAKE_REVISION" ] || exit 7
    echo "{\\"status\\":\\"ok\\",\\"revision\\":\\"$FAKE_REVISION\\"}" ;;
  *)
    [ "$FAKE_ROOT" = ok ] && exit 0
    $loud && echo "curl: (22) The requested URL returned error: 500" >&2
    exit 22 ;;
esac`,
}

const built = '0123456789abcdef0123456789abcdef01234567'
const healthy = { FAKE_REVISION: built, FAKE_ROOT: 'ok', FAKE_USER: 'node' }

function runSmokeStep(fake) {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-step-'))
  try {
    for (const [name, body] of Object.entries(shims)) {
      writeFileSync(join(directory, name), `#!/bin/bash\n${body}\n`)
      chmodSync(join(directory, name), 0o755)
    }
    const script = join(directory, 'step.sh')
    writeFileSync(script, stepScript('Run the image as non-root and check it serves the built revision'))
    // The runner's default shell for a run step.
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      env: { PATH: `${directory}:${process.env.PATH}`, GITHUB_SHA: built, ...fake },
      encoding: 'utf8',
      timeout: 20_000,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the smoke step passes, and prints no logs, when the container serves the built revision as node', () => {
  const result = runSmokeStep(healthy)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /CONTAINER LOGS/)
})

for (const [situation, fake, ...messages] of [
  ['never answers /api/healthz', { ...healthy, FAKE_REVISION: '' }, /did not report revision .* \(last response: none\)/],
  ['serves another revision', { ...healthy, FAKE_REVISION: 'f'.repeat(40) }, /did not report revision .* \(last response: \{.*ffff/],
  ['serves the revision but its home page fails', { ...healthy, FAKE_ROOT: 'down' }, /\/ did not answer with a success status/, /The requested URL returned error: 500/],
  ['serves the revision but runs as root', { ...healthy, FAKE_USER: 'root' }, /does not run as node/],
]) {
  test(`the smoke step fails, naming the check and printing the container's logs, when the container ${situation}`, () => {
    const result = runSmokeStep(fake)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    for (const message of messages) assert.match(result.stdout + result.stderr, message)
    assert.match(result.stdout, /CONTAINER LOGS/)
  })
}
