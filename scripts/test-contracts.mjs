import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Foundry's external-library linker needs absolute remapping targets when
// integration tests compile the sibling protocol packages. Resolve them at
// runtime so foundry.toml remains portable across workspace locations.
const configuration = spawnSync('forge', ['config', '--json'], { encoding: 'utf8' })
if (configuration.status !== 0) {
  process.stderr.write(configuration.stderr || configuration.error?.message || 'Could not read Foundry configuration.\n')
  process.exit(configuration.status || 1)
}
const { remappings } = JSON.parse(configuration.stdout)
const normalized = await Promise.all(remappings.map(async remapping => {
  const separator = remapping.indexOf('=')
  if (separator < 1) throw new Error(`Invalid Foundry remapping: ${remapping}`)
  const target = remapping.slice(separator + 1)
  const absolute = await realpath(resolve(target))
  return `${remapping.slice(0, separator + 1)}${absolute}${target.endsWith('/') ? '/' : ''}`
}))
const result = spawnSync('forge', ['test', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, FOUNDRY_REMAPPINGS: normalized.join('\n') },
})
if (result.error) process.stderr.write(`${result.error.message}\n`)
process.exit(result.status ?? 1)
