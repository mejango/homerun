import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGroups, runSuite, startServer, summarize, waitForServer } from '../scripts/suite-runner.mjs'

const quiet = () => {}
const node = source => [process.execPath, ['-e', source]]
const run = ({ extraEnv, ...suite }) => runSuite({ ...suite, cwd: process.cwd(), env: { ...process.env, ...extraEnv } })
const runAll = async groups => {
  const errors = []
  const outcomes = await runGroups(groups, Object.keys(groups), { run, log: quiet, logError: message => errors.push(message) })
  return { outcomes, errors, ...summarize(outcomes) }
}

test('a run passes only when every suite passed', () => {
  assert.equal(summarize([{ name: 'a', ok: true, seconds: 1 }, { name: 'b', ok: true, seconds: 2 }]).exitCode, 0)
  const failed = summarize([{ name: 'a', ok: true, seconds: 1 }, { name: 'b', ok: false, seconds: 2 }])
  assert.equal(failed.exitCode, 1)
  assert.deepEqual(failed.lines, ['\nBrowser suites', '  PASS a (1s)', '  FAIL b (2s)'])
})

test('a suite is judged by its exit status', async () => {
  const [command, args] = node('')
  assert.equal((await runSuite({ name: 'passes', command, args, cwd: process.cwd(), env: process.env, log: quiet })).ok, true)
  const [failing, failingArgs] = node('process.exit(3)')
  const failed = await runSuite({ name: 'fails', command: failing, args: failingArgs, cwd: process.cwd(), env: process.env, log: quiet })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'exited with 3')
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
    await waitForServer(url, server, 5)
  } finally {
    await server.stop()
    service.close()
  }
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
  await assert.rejects(async () => { process.kill(workerPid, 0) }, { code: 'ESRCH' })
})
