import { spawnSync } from 'node:child_process'
import { absoluteRemappings } from './forge-remappings.mjs'

let FOUNDRY_REMAPPINGS
try {
  FOUNDRY_REMAPPINGS = await absoluteRemappings()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
const result = spawnSync('forge', ['test', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, FOUNDRY_REMAPPINGS },
})
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exit(result.status ?? 1)
