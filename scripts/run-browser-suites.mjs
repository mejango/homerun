import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { runCommand, runGroups, runSuite, startServer, stopAll, summarize, waitForServer, warmRoutes } from './suite-runner.mjs'

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
// A suite that runs for more than 10 minutes is stopped with the workers it forked and counts as a failure; they take
// one to two minutes each. The Center build gets 15 minutes. A hung suite therefore ends the run in failure, with the
// server logs in test-results/, instead of running into the CI job's own limit.
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
const suiteTimeoutMs = 10 * 60_000
const buildTimeoutMs = 15 * 60_000
const centerDist = '.next-center-test'
const centerWallet = {
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'browser-fixture',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
}

process.on('exit', stopAll)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1))

const npmRun = (suite, script, extraEnv) => suite(script, 'npm', ['run', script], extraEnv)

const groups = {
  async dev(suite) {
    const base = 'http://localhost:3010/'
    const server = await startServer({ name: 'dev', command: 'npm', args: ['run', 'dev'], cwd: root, env, logDirectory: results })
    try {
      await waitForServer(base, server, 300)
      await warmRoutes(base, ['/founderhaus', '/create', '/project?id=warm'])
      for (const script of ['test:browser', 'test:create', 'test:a11y']) await npmRun(suite, script, { BASE_URL: base })
    } finally {
      await server.stop()
    }
  },
  async intent(suite) {
    await npmRun(suite, 'test:intent')
  },
  async center(suite) {
    const base = 'http://localhost:54064'
    const build = await runCommand('npm', ['run', 'build'], { cwd: root, env: { ...env, ...centerWallet, NEXT_DIST_DIR: centerDist }, timeoutMs: buildTimeoutMs })
    if (build.timedOut) throw new Error(`the Center-enabled build timed out after ${buildTimeoutMs / 60_000} minutes`)
    if (build.status !== 0) throw new Error('the Center-enabled build failed')
    // A standalone server serves neither public/ nor the build's static files itself.
    await cp(join(root, 'public'), join(root, centerDist, 'standalone/public'), { recursive: true })
    await cp(join(root, centerDist, 'static'), join(root, centerDist, 'standalone', centerDist, 'static'), { recursive: true })
    const server = await startServer({
      name: 'center', command: process.execPath, args: [join(root, centerDist, 'standalone/server.js')],
      cwd: root, env: { ...env, PORT: '54064', HOSTNAME: '0.0.0.0' }, logDirectory: results,
    })
    try {
      await waitForServer(`${base}/founderhaus`, server, 60)
      await npmRun(suite, 'test:center', { BASE_URL: base })
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
const outcomes = await runGroups(groups, selected, {
  run: ({ extraEnv, ...suite }) => runSuite({ ...suite, cwd: root, env: { ...env, ...extraEnv }, timeoutMs: suiteTimeoutMs }),
})
const { lines, exitCode } = summarize(outcomes)
for (const line of lines) console.log(line)
process.exitCode = exitCode
