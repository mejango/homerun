import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireFreePort, runGroups, runSuite, startServer, summarize, waitForServer } from '../scripts/suite-runner.mjs'

const quiet = () => {}
const node = source => [process.execPath, ['-e', source]]
// Each suite gets a generous limit unless `limits` names a shorter one: a no-op suite must not race a loaded machine.
const runWithin = limits => ({ extraEnv, ...suite }) => runSuite({ ...suite, cwd: process.cwd(), env: { ...process.env, ...extraEnv }, timeoutMs: limits[suite.name] ?? 30_000 })
const runAll = async (groups, limits = {}) => {
  const errors = []
  const outcomes = await runGroups(groups, Object.keys(groups), { run: runWithin(limits), log: quiet, logError: message => errors.push(message) })
  return { outcomes, errors, ...summarize(outcomes) }
}

/** A killed process stays visible to kill(pid, 0) as a zombie until its parent, or init, reaps it. */
async function goneWithin(pid, milliseconds = 2000) {
  for (const deadline = Date.now() + milliseconds; ; await new Promise(resolve => setTimeout(resolve, 20))) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    if (Date.now() >= deadline) return false
  }
}

test('a run passes only when every suite passed', () => {
  assert.equal(summarize([{ name: 'a', ok: true, seconds: 1 }, { name: 'b', ok: true, seconds: 2 }]).exitCode, 0)
  const failed = summarize([{ name: 'a', ok: true, seconds: 1 }, { name: 'b', ok: false, seconds: 2 }])
  assert.equal(failed.exitCode, 1)
  assert.deepEqual(failed.lines, ['\nBrowser suites', '  PASS a (1s)', '  FAIL b (2s)'])
})

test('a suite is judged by its exit status', async () => {
  const [command, args] = node('')
  assert.equal((await runSuite({ name: 'passes', command, args, cwd: process.cwd(), env: process.env, timeoutMs: 30_000, log: quiet })).ok, true)
  const [failing, failingArgs] = node('process.exit(3)')
  const failed = await runSuite({ name: 'fails', command: failing, args: failingArgs, cwd: process.cwd(), env: process.env, timeoutMs: 30_000, log: quiet })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'exited with 3')
})

test('a suite that cannot start is a failed suite', async () => {
  const outcome = await runSuite({ name: 'missing', command: '/nonexistent/suite-runner-test-binary', args: [], cwd: process.cwd(), env: process.env, timeoutMs: 30_000, log: quiet })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /^could not start: /)
})

test('a suite without a time limit is refused', async () => {
  const [command, args] = node('')
  await assert.rejects(runSuite({ name: 'unbounded', command, args, cwd: process.cwd(), env: process.env, log: quiet }), TypeError)
})

test('a suite that outlives its time limit is stopped and counts as a failure', async () => {
  const [command, args] = node('setInterval(() => {}, 1000)')
  const started = Date.now()
  const outcome = await runSuite({ name: 'hangs', command, args, cwd: process.cwd(), env: process.env, timeoutMs: 300, log: quiet })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'timed out after 0.3 s')
  assert.ok(Date.now() - started < 5000, 'the suite was stopped soon after its limit')
})

test('a time limit stops the workers the suite forked', async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), 'suite-runner-'))
  const pidFile = join(logDirectory, 'worker.pid')
  const [command, args] = node(`
    const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid))
    setInterval(() => {}, 1000)`)
  const outcome = await runSuite({ name: 'forks', command, args, cwd: process.cwd(), env: process.env, timeoutMs: 3000, log: quiet })
  assert.equal(outcome.ok, false)
  const workerPid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(await goneWithin(workerPid), `the worker ${workerPid} is gone`)
})

test('a suite that times out fails the run and the suites after it still run', async () => {
  const { outcomes, exitCode } = await runAll({
    only: async suite => {
      await suite('hangs', ...node('setInterval(() => {}, 1000)'))
      await suite('after', ...node(''))
    },
  }, { hangs: 300 })
  assert.deepEqual(outcomes.map(({ name, ok }) => [name, ok]), [['hangs', false], ['after', true]])
  assert.match(outcomes[0].reason, /^timed out/)
  assert.equal(exitCode, 1)
})

test('when every suite passes the run exits zero', async () => {
  const { outcomes, exitCode } = await runAll({
    first: async suite => { await suite('one', ...node('')) },
    second: async suite => { await suite('two', ...node('')) },
  })
  assert.deepEqual(outcomes.map(({ name, ok }) => [name, ok]), [['one', true], ['two', true]])
  assert.equal(exitCode, 0)
})

test('a failing suite does not stop the suites after it and the run exits non-zero', async () => {
  const { outcomes, exitCode } = await runAll({
    only: async suite => {
      await suite('fails', ...node('process.exit(1)'))
      await suite('after', ...node(''))
    },
  })
  assert.deepEqual(outcomes.map(({ name, ok }) => [name, ok]), [['fails', false], ['after', true]])
  assert.equal(exitCode, 1)
})

test('a group that throws is one failed outcome and the next group still runs', async () => {
  const { outcomes, errors, exitCode } = await runAll({
    broken: async () => { throw new Error('the server never answered') },
    fine: async suite => { await suite('fine', ...node('')) },
  })
  assert.deepEqual(outcomes.map(({ name, ok }) => [name, ok]), [['broken', false], ['fine', true]])
  assert.deepEqual(errors, ['broken: the server never answered'])
  assert.equal(exitCode, 1)
})

async function serverWith(source) {
  const logDirectory = await mkdtemp(join(tmpdir(), 'suite-runner-'))
  const server = await startServer({ name: 'probe', command: process.execPath, args: ['-e', source], cwd: process.cwd(), env: process.env, logDirectory })
  return { server, logDirectory }
}

async function answeringOn(handler = (_request, response) => response.end('ok')) {
  const service = createServer(handler)
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  return { service, url: `http://127.0.0.1:${service.address().port}/` }
}

test('a server that is running and answering is ready', async () => {
  const { service, url } = await answeringOn()
  const { server } = await serverWith('setInterval(() => {}, 1000)')
  try {
    await waitForServer(url, server, 5, { settleMs: 50 })
  } finally {
    await server.stop()
    service.close()
  }
})

test('an answer is not trusted when the server exits right after it', async () => {
  // The answer comes from something else, and the server that was started dies once it has been given.
  let started
  const { service, url } = await answeringOn((_request, response) => { response.end('ok'); started.child.kill('SIGKILL') })
  started = (await serverWith('setInterval(() => {}, 1000)')).server
  try {
    await assert.rejects(waitForServer(url, started, 5, { settleMs: 500 }), /the server exited right after .* first answered/)
  } finally {
    await started.stop()
    service.close()
  }
})

test('a port that already answers is refused, and named', async () => {
  const { service } = await answeringOn()
  const { port } = service.address()
  try {
    await assert.rejects(requireFreePort(port, '127.0.0.1'), new RegExp(`port ${port} already answers`))
  } finally {
    service.close()
    await once(service, 'close')
  }
  await requireFreePort(port, '127.0.0.1')
})

test('a server that exits before it answers is not ready', async () => {
  const { server } = await serverWith('')
  await once(server.child, 'exit')
  await assert.rejects(waitForServer('http://127.0.0.1:9/', server, 5), /the server exited before/)
  await server.stop()
})

test('stopping a server stops the workers it forked', async () => {
  const { server, logDirectory } = await serverWith(`
    const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    console.log(worker.pid)
    setInterval(() => {}, 1000)`)
  let workerPid
  for (let attempt = 0; attempt < 50 && !workerPid; attempt++) {
    workerPid = Number((await readFile(join(logDirectory, 'probe-server.log'), 'utf8')).trim()) || undefined
    if (!workerPid) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(workerPid, 'the server reported its worker')
  process.kill(workerPid, 0)
  await server.stop()
  assert.ok(await goneWithin(workerPid), `the worker ${workerPid} is gone`)
})
