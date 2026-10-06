import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
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
