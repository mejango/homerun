import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

// Route budget gate: starts the built app, fetches each route's rendered HTML and gzips every script and stylesheet it
// loads (the <script>/<link> tags plus the client chunks its flight data names). Next's per-route manifests misattribute
// modules a layout and a page share and drop chunks whose path carries `?dpl=`, so the gate reads what a visitor gets.
// Nomodule polyfills are excluded. Run after `npm run build`: `npm run budget`. Ceilings are KiB of gzip; lower them
// when a change lands under them so the saving holds.
//
//   node scripts/check-client-budgets.mjs [--json out.json]

const KIB = 1024
const distDir = process.env.NEXT_DIST_DIR || '.next'
const dist = resolve(distDir)
const budgets = {
  '/': { js: 277, css: 29 },
  '/founderhaus': { js: 347, css: 33 },
  '/project': { js: 347, css: 33 },
  '/projects': { js: 282, css: 29 },
  '/create': { js: 429, css: 30 },
  '/create/preview': { js: 464, css: 33 },
  '/create/recover': { js: 429, css: 30 },
  '/create/success': { js: 303, css: 29 },
  '/center/callback': { js: 237, css: 28 },
  '/account/0x0000000000000000000000000000000000000001': { js: 287, css: 30 },
  '/intent/00000000-0000-4000-8000-000000000000': { js: 435, css: 33 },
  '/op:11': { js: 655, css: 33 },
  '/not-a-route/x': { js: 236, css: 28 },
}

if (!existsSync(join(dist, 'BUILD_ID'))) {
  console.error(`No build in ${dist}; run npm run build first.`)
  process.exit(1)
}

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  env: { ...process.env, NEXT_DIST_DIR: distDir },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const stop = () => server.exitCode === null && server.kill('SIGTERM')
process.on('exit', stop)

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`)
    try {
      await fetch(`${base}/api/healthz`)
      return
    } catch {
      await new Promise(done => setTimeout(done, 500))
    }
  }
  throw new Error('next start did not answer within 60 s')
}

const polyfills = new Set(JSON.parse(readFileSync(join(dist, 'build-manifest.json'), 'utf8')).polyfillFiles)
const gzipped = new Map()
const gzipSize = file => {
  if (!gzipped.has(file)) gzipped.set(file, gzipSync(readFileSync(join(dist, file))).byteLength)
  return gzipped.get(file)
}

// Paths under /_next/, query (`?dpl=`) and fragment dropped, nomodule scripts skipped.
function assetsOf(html) {
  const scripts = [...html.matchAll(/<script([^>]*)\bsrc="\/_next\/([^"?#]+\.js)[^"]*"([^>]*)>/g)]
    .filter(match => !/nomodule/i.test(match[1] + match[3]))
    .map(match => match[2])
  const flight = [...html.matchAll(/static\/chunks\/[^"\\?#]+?\.js/g)].map(match => match[0])
  const styles = [...html.matchAll(/<link[^>]*\bhref="\/_next\/([^"?#]+\.css)[^"]*"[^>]*>/g)].map(match => match[1])
  const flightStyles = [...html.matchAll(/static\/(?:chunks|css)\/[^"\\?#]+?\.css/g)].map(match => match[0])
  const unique = list => [...new Set(list.map(decodeURIComponent))]
  return {
    js: unique([...scripts, ...flight]).filter(file => !polyfills.has(file)),
    css: unique([...styles, ...flightStyles]),
  }
}

const total = files => files.reduce((sum, file) => sum + gzipSize(file), 0)
const results = {}
const failures = []
try {
  await waitForServer()
  for (const [route, ceiling] of Object.entries(budgets)) {
    const response = await fetch(base + route, { redirect: 'manual' })
    const assets = assetsOf(await response.text())
    const js = total(assets.js)
    const css = total(assets.css)
    results[route] = { status: response.status, js, css, files: assets }
    const line = `${(js / KIB).toFixed(1).padStart(6)} / ${ceiling.js} KiB js  ${(css / KIB).toFixed(1).padStart(5)} / ${ceiling.css} KiB css  ${response.status}  ${route}`
    console.log(line)
    if (response.status >= 500) failures.push(`${route} answered ${response.status}`)
    if (!assets.js.length) failures.push(`${route} references no scripts`)
    if (js > ceiling.js * KIB) failures.push(`${route} loads ${(js / KIB).toFixed(1)} KiB of JavaScript, over its ${ceiling.js} KiB ceiling`)
    if (css > ceiling.css * KIB) failures.push(`${route} loads ${(css / KIB).toFixed(1)} KiB of CSS, over its ${ceiling.css} KiB ceiling`)
  }
} finally {
  stop()
}

const jsonAt = process.argv.indexOf('--json')
if (jsonAt > 0) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(results, null, 1))
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Route budgets pass.')
