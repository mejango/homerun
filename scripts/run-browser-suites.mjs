import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Runs the browser suites with the servers each one needs, one group after the other, and exits non-zero when any
// of them failed, so one run reports every broken suite. CI runs this; a developer machine runs it the same way:
//
//   node scripts/run-browser-suites.mjs [dev] [intent] [center]
//
// dev     test:browser, test:create and test:a11y share one development server (npm run dev, port 3010).
// intent  test:intent starts its own servers.
// center  test:center needs a production build with the Center wallet enabled, served from its standalone output
//         (port 54064). The manifest and fee pins it builds with have the right shape and nothing else: the suite
//         models every Center response, and the issuer and audience are the ones the app defaults to.
//
// CHROME_PATH and PLAYWRIGHT_MODULE default to Playwright's own Chromium (npx playwright install chromium) and the
// Playwright installed here. Server logs go to test-results/.

const root = fileURLToPath(new URL('..', import.meta.url))
const results = join(root, 'test-results')
const env = {
  ...process.env,
  CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath(),
  PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE || join(root, 'node_modules/playwright/index.mjs'),
}
const centerDist = '.next-center-test'
const centerWallet = {
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'browser-fixture',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
}
const outcomes = []
const running = new Set()

// Each server leads its own process group so that stopping it stops the workers it forked too.
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal) } catch { /* already gone */ }
}
function stopNow() {
  for (const pid of running) signalGroup(pid, 'SIGKILL')
}
process.on('exit', stopNow)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1))

async function start(name, command, args, extraEnv = {}) {
  await mkdir(results, { recursive: true })
  const log = await open(join(results, `${name}-server.log`), 'w')
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', log.fd, log.fd] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  running.add(child.pid)
  const exited = new Promise(resolve => child.once('exit', resolve))
  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        signalGroup(child.pid, 'SIGTERM')
        const timer = setTimeout(stopNow, 10_000)
        await exited
        clearTimeout(timer)
      }
      stopNow()
      running.delete(child.pid)
      await log.close()
    },
  }
}

async function ready(url, server, seconds) {
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
async function warm(base, routes) {
  for (const route of routes) {
    try {
      const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(300_000) })
      await response.arrayBuffer()
      console.log(`warm ${route} -> ${response.status}`)
    } catch (error) {
      console.log(`warm ${route} -> ${error.message}`)
    }
  }
}

function suite(name, extraEnv = {}) {
  const started = Date.now()
  if (process.env.GITHUB_ACTIONS) console.log(`::group::npm run ${name}`)
  else console.log(`\n=== npm run ${name} ===`)
  const result = spawnSync('npm', ['run', name], { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' })
  if (process.env.GITHUB_ACTIONS) console.log('::endgroup::')
  const ok = result.status === 0
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=Browser suite failed::npm run ${name} exited with ${result.status ?? result.signal}`)
  outcomes.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) })
}

const groups = {
  async dev() {
    const base = 'http://localhost:3010/'
    const server = await start('dev', 'npm', ['run', 'dev'])
    try {
      await ready(base, server, 300)
      await warm(base, ['/founderhaus', '/create', '/project?id=warm'])
      for (const name of ['test:browser', 'test:create', 'test:a11y']) suite(name, { BASE_URL: base })
    } finally {
      await server.stop()
    }
  },
  async intent() {
    suite('test:intent')
  },
  async center() {
    const base = 'http://localhost:54064'
    const build = spawnSync('npm', ['run', 'build'], { cwd: root, env: { ...env, ...centerWallet, NEXT_DIST_DIR: centerDist }, stdio: 'inherit' })
    if (build.status !== 0) throw new Error('the Center-enabled build failed')
    // A standalone server serves neither public/ nor the build's static files itself.
    await cp(join(root, 'public'), join(root, centerDist, 'standalone/public'), { recursive: true })
    await cp(join(root, centerDist, 'static'), join(root, centerDist, 'standalone', centerDist, 'static'), { recursive: true })
    const server = await start('center', process.execPath, [join(root, centerDist, 'standalone/server.js')], { PORT: '54064', HOSTNAME: '0.0.0.0' })
    try {
      await ready(`${base}/founderhaus`, server, 60)
      suite('test:center', { BASE_URL: base })
    } finally {
      await server.stop()
    }
  },
}

const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(groups)
const unknown = selected.filter(name => !Object.hasOwn(groups, name))
if (unknown.length) {
  console.error(`Unknown group ${unknown.join(', ')}; use ${Object.keys(groups).join(', ')}.`)
  process.exit(2)
}
for (const name of selected) {
  try {
    await groups[name]()
  } catch (error) {
    console.error(`${name}: ${error.message}`)
    outcomes.push({ name, ok: false, seconds: 0 })
  }
}
console.log('\nBrowser suites')
for (const { name, ok, seconds } of outcomes) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} (${seconds}s)`)
process.exitCode = outcomes.every(outcome => outcome.ok) ? 0 : 1
