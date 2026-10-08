import { keccak256, toBytes } from 'viem'

// Model Center's exact signing payload independently of the SDK verifier.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function prepareIntentEnvelope(envelope) {
  const contentHash = keccak256(toBytes(canonicalJson(envelope)))
  return { envelope, contentHash, message: `Juice Central project intent\nVersion: 1\nContent hash: ${contentHash}` }
}
