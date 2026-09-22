/**
 * Records the canonical Safe 1.4.1 runtime bytecode and proxy creation code that
 * `test/intent-browser.mjs` serves from its modeled Center. The SDK checks the same
 * hashes at test time, so a recording that drifts cannot pass unnoticed.
 *
 * Usage: node scripts/fetch-safe-canonical-code.mjs [--rpc <url>]
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, keccak256 } from 'viem'
import { base } from '@bananapus/nana-sdk-core/chains'
import { SAFE_CREATE_ABI, SAFE_FACTORY, SAFE_FALLBACK, SAFE_SINGLETON } from '@bananapus/nana-sdk-core/safe'

const HASHES = {
  [SAFE_FACTORY]: '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317',
  [SAFE_SINGLETON]: '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4',
  [SAFE_FALLBACK]: '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9',
}
const flag = process.argv.indexOf('--rpc')
const url = flag > 0 ? process.argv[flag + 1] : process.env.SAFE_CODE_RPC_URL || 'https://mainnet.base.org'
const client = createPublicClient({ chain: base, transport: http(url) })

const code = {}
for (const [address, hash] of Object.entries(HASHES)) {
  const runtime = await client.getCode({ address })
  if (!runtime || keccak256(runtime) !== hash) {
    throw new Error(`The code at ${address} is not the canonical Safe 1.4.1 contract on ${url}.`)
  }
  code[address] = runtime
}
const proxyCreationCode = await client.readContract({
  address: SAFE_FACTORY, abi: SAFE_CREATE_ABI, functionName: 'proxyCreationCode',
})
if (!/^0x(?:[\da-f]{2}){1,2048}$/i.test(proxyCreationCode)) throw new Error('The factory returned invalid proxy creation code.')

const target = fileURLToPath(new URL('../test/fixtures/safe-canonical-code.json', import.meta.url))
await writeFile(target, `${JSON.stringify({ code, proxyCreationCode }, null, 2)}\n`)
console.log(`Recorded ${Object.keys(code).length} canonical Safe contracts and ${(proxyCreationCode.length - 2) / 2} bytes of proxy creation code.`)
