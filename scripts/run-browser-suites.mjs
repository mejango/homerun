import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { centerBuildEnv, centerPort, devPort } from '../test/support/browser-suites.mjs'
import { requireFreePort, runCommand, runGroups, runSuite, startServer, stopAll, summarize, waitForServer, warmRoutes } from './suite-runner.mjs'

// Runs the browser suites with the servers each one needs, one group after the other, and exits non-zero when any
// of them failed, so one run reports every broken suite. CI runs this; a developer machine runs it the same way:
//
//   node scripts/run-browser-suites.mjs [dev] [intent] [center]
//
// dev     test:browser, test:create, test:a11y and test:shop share one development server (npm run dev).
// intent  test:intent starts its own servers.
// center  test:center needs a production build with the Center wallet enabled, served from its standalone output on
//         127.0.0.1. The ports and the build's pins are in test/support/browser-suites.mjs.
//
// A group whose port already answers does not start, and says which port: a server that finds its port taken exits, and
// the suites would otherwise run against whatever is already there.
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

process.on('exit', stopAll)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1))

const npmRun = (suite, script, extraEnv) => suite(script, 'npm', ['run', script], extraEnv)

const groups = {
  async dev(suite) {
    const port = devPort()
    const base = `http://localhost:${port}/`
    await requireFreePort(port)
    const server = await startServer({ name: 'dev', command: 'npm', args: ['run', 'dev'], cwd: root, env, logDirectory: results })
    try {
      await waitForServer(base, server, 300)
      await warmRoutes(base, ['/founderhaus', '/create', '/project?id=warm'])
      for (const script of ['test:browser', 'test:create', 'test:a11y', 'test:shop']) await npmRun(suite, script, { BASE_URL: base })
    } finally {
      await server.stop()
    }
  },
  async intent(suite) {
    await npmRun(suite, 'test:intent')
  },
  async center(suite) {
    const base = `http://127.0.0.1:${centerPort}`
    await requireFreePort(centerPort, '127.0.0.1')
    const build = await runCommand('npm', ['run', 'build'], { cwd: root, env: { ...env, ...centerBuildEnv, NEXT_DIST_DIR: centerDist }, timeoutMs: buildTimeoutMs })
    if (build.timedOut) throw new Error(`the Center-enabled build timed out after ${buildTimeoutMs / 60_000} minutes`)
    if (build.status !== 0) throw new Error('the Center-enabled build failed')
    // A standalone server serves neither public/ nor the build's static files itself.
    await cp(join(root, 'public'), join(root, centerDist, 'standalone/public'), { recursive: true })
    await cp(join(root, centerDist, 'static'), join(root, centerDist, 'standalone', centerDist, 'static'), { recursive: true })
    const server = await startServer({
      name: 'center', command: process.execPath, args: [join(root, centerDist, 'standalone/server.js')],
      cwd: root, env: { ...env, PORT: String(centerPort), HOSTNAME: '127.0.0.1' }, logDirectory: results,
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
