import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

// The process and summary code behind scripts/run-browser-suites.mjs. Every server leads its own process group, so
// that stopping it stops the workers it forked too.

const running = new Set()

export function signalGroup(pid, signal) {
  try { process.kill(-pid, signal) } catch { /* already gone */ }
}

/** Kills every server that is still running. A normal exit and a signal both end here. */
export function stopAll() {
  for (const pid of running) signalGroup(pid, 'SIGKILL')
}

export async function startServer({ name, command, args, cwd, env, logDirectory }) {
  await mkdir(logDirectory, { recursive: true })
  const log = await open(join(logDirectory, `${name}-server.log`), 'w')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  running.add(child.pid)
  const exited = new Promise(resolve => child.once('exit', resolve))
  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        signalGroup(child.pid, 'SIGTERM')
        const timer = setTimeout(stopAll, 10_000)
        await exited
        clearTimeout(timer)
      }
      stopAll()
      running.delete(child.pid)
      await log.close()
    },
  }
}

export async function waitForServer(url, server, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`the server exited before ${url} answered`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      await response.arrayBuffer()
      if (response.ok) return
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`${url} did not answer within ${seconds} seconds`)
}

// The first request for a route compiles it, which can outlast a suite's own navigation timeout.
export async function warmRoutes(base, routes, log = console.log) {
  for (const route of routes) {
    try {
      const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(300_000) })
      await response.arrayBuffer()
      log(`warm ${route} -> ${response.status}`)
    } catch (error) {
      log(`warm ${route} -> ${error.message}`)
    }
  }
}

/**
 * Runs a command with its output on ours, in a process group of its own. One that outlives `timeoutMs` is stopped
 * together with the workers it forked, and reported as timed out.
 */
export async function runCommand(command, args, { cwd, env, timeoutMs }) {
  if (!(timeoutMs > 0)) throw new TypeError('A command needs a time limit: timeoutMs must be positive.')
  const child = spawn(command, args, { cwd, env, detached: true, stdio: 'inherit' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  running.add(child.pid)
  const exited = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })))
  let timedOut = false
  let killer
  const timer = setTimeout(() => {
    timedOut = true
    signalGroup(child.pid, 'SIGTERM')
    killer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 10_000)
  }, timeoutMs)
  const { status, signal } = await exited
  clearTimeout(timer)
  clearTimeout(killer)
  signalGroup(child.pid, 'SIGKILL')
  running.delete(child.pid)
  return { status, signal, timedOut }
}

/** Runs one suite to completion, or to its time limit, and describes how it went. */
export async function runSuite({ name, command, args, cwd, env, timeoutMs, log = console.log }) {
  const started = Date.now()
  const header = [command, ...args].join(' ')
  if (process.env.GITHUB_ACTIONS) log(`::group::${header}`)
  else log(`\n=== ${header} ===`)
  let result
  try {
    result = await runCommand(command, args, { cwd, env, timeoutMs })
  } catch (error) {
    if (error instanceof TypeError) throw error
    result = { status: null, error }
  }
  if (process.env.GITHUB_ACTIONS) log('::endgroup::')
  const ok = result.status === 0 && !result.timedOut
  const reason = ok ? undefined
    : result.timedOut ? `timed out after ${timeoutMs / 1000} s`
      : result.error ? `could not start: ${result.error.message}`
        : result.status === null ? `killed by ${result.signal}` : `exited with ${result.status}`
  if (!ok && process.env.GITHUB_ACTIONS) log(`::error title=Browser suite failed::${header} ${reason}`)
  return { name, ok, seconds: Math.round((Date.now() - started) / 1000), reason }
}

/**
 * Runs the selected groups one after the other. A group is an async function that calls the `suite` it is given; one
 * that throws (a server that never answers, a build that fails) counts as a single failed outcome and the next group
 * still runs. `run` executes one suite and returns its outcome.
 */
export async function runGroups(groups, selected, { run, log = console.log, logError = console.error }) {
  const outcomes = []
  const suite = async (name, command, args, extraEnv = {}) => { outcomes.push(await run({ name, command, args, extraEnv, log })) }
  for (const group of selected) {
    try {
      await groups[group](suite)
    } catch (error) {
      logError(`${group}: ${error.message}`)
      outcomes.push({ name: group, ok: false, seconds: 0, reason: error.message })
    }
  }
  return outcomes
}

export function summarize(outcomes) {
  const lines = ['\nBrowser suites', ...outcomes.map(({ name, ok, seconds }) => `  ${ok ? 'PASS' : 'FAIL'} ${name} (${seconds}s)`)]
  return { lines, exitCode: outcomes.every(outcome => outcome.ok) ? 0 : 1 }
}
