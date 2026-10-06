import { readFileSync } from 'node:fs'

// What the browser suites and scripts/run-browser-suites.mjs agree on.

/** The port a dev script such as package.json's `next dev --webpack --port 3010` serves on. */
export function portOf(script) {
  const port = /--port[ =](\d+)/.exec(script)?.[1]
  if (!port) throw new Error('The dev script must give its port as --port <number>.')
  return Number(port)
}

/** The port `npm run dev` serves on. package.json owns it; the suites and the runner read it from there. */
export function devPort() {
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return portOf(scripts.dev)
}

/** Where test:center finds the production build the runner serves from its standalone output. */
export const centerPort = 54064

/**
 * The environment of the build test:center runs against. A build with the Center wallet enabled needs a manifest and a
 * fee bound of the right shape, and the suite models every Center response, so these mean nothing beyond their shape.
 * The issuer and audience stay at the app's defaults, the only https pair a build accepts (src/providers/wallet-config.ts).
 */
export const centerBuildEnv = {
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'browser-fixture',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
}
