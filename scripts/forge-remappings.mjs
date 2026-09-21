import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Foundry's external-library linker needs absolute remapping targets when
// scripts and integration tests compile the sibling protocol packages.
// Resolve them at runtime so foundry.toml remains portable across workspace
// locations.
export async function absoluteRemappings(env = process.env) {
  const configuration = spawnSync('forge', ['config', '--json'], { encoding: 'utf8', env })
  if (configuration.status !== 0) {
    throw new Error(configuration.stderr || configuration.error?.message || 'Could not read Foundry configuration.')
  }
  const { remappings } = JSON.parse(configuration.stdout)
  const normalized = await Promise.all(remappings.map(async remapping => {
    const separator = remapping.indexOf('=')
    if (separator < 1) throw new Error(`Invalid Foundry remapping: ${remapping}`)
    const target = remapping.slice(separator + 1)
    const absolute = await realpath(resolve(target))
    return `${remapping.slice(0, separator + 1)}${absolute}${target.endsWith('/') ? '/' : ''}`
  }))
  return normalized.join('\n')
}
