/** Homerun creates a FUND without a transaction: the real Next.js application and the packaged
 *  SDK against a modeled Juicebox Center and an injected test wallet. No chain, no Center
 *  service, no transaction and no real signature authority are involved. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAddress, multicall3Abi } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { SAFE_CREATE_ABI, SAFE_FACTORY } from '@bananapus/nana-sdk-core/safe'
import safeCode from './fixtures/safe-canonical-code.json' with { type: 'json' }
import { privateKeyToAccount } from 'viem/accounts'
import { CREATE_DEFAULTS } from '../web/create-model.mjs'

const appPort = Number(process.env.INTENT_APP_PORT || 3016)
const centerPort = Number(process.env.INTENT_CENTER_PORT || 3017)
const appOrigin = `http://127.0.0.1:${appPort}`
const centerOrigin = `http://127.0.0.1:${centerPort}`
const root = fileURLToPath(new URL('..', import.meta.url))
// A well-known test key. It holds nothing and signs only this modeled message.
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
// A second well-known test address, distinct from the injected wallet.
// It holds nothing and signs nothing here.
const SECOND_SIGNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const cid = 'bafkreiabcdefghijklmnopqrstuvwxyz234567'
const contentHash = `0x${'ab'.repeat(32)}`
const transactionHash = `0x${'ef'.repeat(32)}`
const intentId = randomUUID()
// Center's sponsor in this model. It signs nothing here; the forward request is a fixture.
const SPONSOR = '0x0000000000000000000000000000000000005e0d'
const projectIds = { 1: '7', 10: '41', 8453: '42' }
const relayHash = `0x${'cd'.repeat(32)}`
const pin = { cid, status: 'queued', uri: `ipfs://${cid}`, gatewayUrl: `/ipfs/${cid}` }
const metadata = {
  name: 'Neighborhood Workshop',
  description: 'Shared tools that earn revenue through community use.',
  infoUri: 'https://homerun.money',
  tokens: { name: 'Neighborhood Workshop FUND', symbol: 'FUND' },
  homerun: { version: 1, kind: 'fund', setup: { location: 'Florianópolis' }, incomeProject: null },
}
const timestamp = new Date(1_800_000_000_000).toISOString()
const uint256 = value => `0x${value.toString(16).padStart(64, '0')}`
const AGGREGATE3_SELECTOR = '0x82ad56cb'
const PROXY_CREATION_CODE_DATA = encodeFunctionData({ abi: SAFE_CREATE_ABI, functionName: 'proxyCreationCode' })
const CANONICAL_CODE = Object.fromEntries(Object.entries(safeCode.code).map(([address, code]) => [getAddress(address), code]))
/** Every read this flow makes wants one positive number, except the Safe factory's own
 *  creation code, which fixes the address of the Safe this envelope creates. */
const answerCall = (to, data) => to && getAddress(to) === SAFE_FACTORY && data === PROXY_CREATION_CODE_DATA
  ? encodeFunctionResult({ abi: SAFE_CREATE_ABI, functionName: 'proxyCreationCode', result: safeCode.proxyCreationCode })
  : uint256(10n ** 18n)

/** The receipt the visitor's own relay transaction produces, with one FundLaunched event. */
const launchReceipt = chainId => {
  const calls = stored.envelope.deploymentCalls.filter(call => call.chainId === chainId)
  const launch = calls[calls.length - 1]
  return {
    status: '0x1', blockNumber: uint256(1_000n), blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: relayHash, transactionIndex: '0x0', from: account.address, to: launch.to,
    cumulativeGasUsed: uint256(500_000n), gasUsed: uint256(500_000n), effectiveGasPrice: uint256(2_000_000_000n),
    contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, type: '0x2',
    logs: [{
      address: launch.to, blockHash: `0x${'11'.repeat(32)}`, blockNumber: uint256(1_000n),
      transactionHash: relayHash, transactionIndex: '0x0', logIndex: '0x0', removed: false,
      topics: encodeEventTopics({
        abi: FUND_LAUNCHED_ABI, eventName: 'FundLaunched',
        args: { projectId: BigInt(projectIds[chainId]), owner: stored.envelope.jb.owner },
      }),
      data: encodeAbiParameters([{ type: 'address' }], [SPONSOR]),
    }],
  }
}

let stored = null
let deployRequests = 0
let relayRequests = 0
let intentReads = 0
let queued = []
let recorded = []

// HomerunDeployer's own event, as `src/lib/income-contracts.ts` declares it.
const FUND_LAUNCHED_ABI = [{
  type: 'event', name: 'FundLaunched', inputs: [
    { name: 'projectId', type: 'uint256', indexed: true },
    { name: 'owner', type: 'address', indexed: true },
    { name: 'caller', type: 'address', indexed: false },
  ],
}]

function intentRecord() {
  const chains = [...new Set([...queued, ...recorded])]
  return {
    id: intentId, status: chains.length === 3 ? 'deployed' : 'undeployed', contentHash,
    envelope: stored.envelope, publisher: stored.publisher, signature: stored.signature,
    createdAt: timestamp,
    deployments: chains.map(chainId => ({
      chainId, projectId: projectIds[chainId],
      transactionHash: chainId === 1 ? relayHash : transactionHash, createdAt: timestamp,
      forwarded: true,
    })),
    deploys: chains.map(chainId => ({
      chainId, status: 'confirmed',
      transactionHash: chainId === 1 ? relayHash : transactionHash,
      bundleUuid: null, error: null, createdAt: timestamp, updatedAt: timestamp,
    })),
    name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null,
    owner: account.address,
  }
}

const center = createServer((request, response) => {
  const url = new URL(request.url, centerOrigin)
  const headers = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-headers': 'content-type,accept',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  }
  const json = (status, body) => {
    response.writeHead(status, { ...headers, 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (request.method === 'OPTIONS') { response.writeHead(204, headers); return response.end() }
  const withBody = handler => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => handler(Buffer.concat(chunks)))
  }
  if (url.pathname === '/v1/pins/json' || url.pathname === '/v1/pins/file') {
    return withBody(() => json(200, pin))
  }
  if (url.pathname === '/v1/intents/message') {
    // Center's own signing message, word for word: the SDK refuses to sign anything else.
    return withBody(body => json(200, {
      contentHash,
      message: `Juice Central project intent\nVersion: 1\nContent hash: ${contentHash}`,
      envelope: JSON.parse(body.toString()),
    }))
  }
  if (url.pathname === '/v1/intents' && request.method === 'POST') {
    return withBody(body => {
      const published = JSON.parse(body.toString())
      const { publisher, signature, ...envelope } = published
      stored = { envelope, publisher, signature }
      return json(201, intentRecord())
    })
  }
  if (url.pathname === `/v1/intents/${intentId}` && request.method === 'GET') {
    intentReads++
    return json(200, intentRecord())
  }
  if (url.pathname === `/v1/intents/${intentId}/deploy` && request.method === 'POST') {
    deployRequests++
    return withBody(body => {
      const requested = JSON.parse(body.toString() || '{}').chainIds ?? [10, 8453]
      queued = [...new Set([...queued, ...requested])]
      return json(202, { deploys: intentRecord().deploys })
    })
  }
  if (url.pathname === `/v1/intents/${intentId}/relay` && request.method === 'POST') {
    relayRequests++
    return withBody(body => {
      const { chainId } = JSON.parse(body.toString())
      const calls = stored.envelope.deploymentCalls.filter(call => call.chainId === chainId)
      const launch = calls[calls.length - 1]
      const deadline = Math.floor(Date.now() / 1000) + 1_800
      return json(200, {
        chainId,
        to: v6Address('ERC2771Forwarder', chainId),
        value: '0',
        gas: '900000',
        deadline,
        data: encodeFunctionData({
          abi: erc2771ForwarderAbi,
          functionName: 'execute',
          args: [{ from: SPONSOR, to: launch.to, value: 0n, gas: 900_000n, deadline, data: launch.data, signature: `0x${'ab'.repeat(65)}` }],
        }),
        setup: calls.slice(0, -1).map(call => ({ to: call.to, data: call.data, value: '0' })),
      })
    })
  }
  if (url.pathname === `/v1/intents/${intentId}/deployments` && request.method === 'POST') {
    return withBody(body => {
      const deployment = JSON.parse(body.toString())
      recorded = [...new Set([...recorded, deployment.chainId])]
      return json(201, { ...deployment, createdAt: timestamp })
    })
  }
  if (url.pathname === '/v1/search') {
    return json(200, { items: [], totalCount: 0, nextCursor: null })
  }
  if (url.pathname.startsWith('/v1/rpc/')) {
    const chainId = Number(url.pathname.slice('/v1/rpc/'.length))
    return withBody(body => {
      const calls = JSON.parse(body.toString())
      const answer = call => {
        if (call.method === 'eth_chainId') return uint256(BigInt(chainId))
        if (call.method === 'eth_blockNumber') return uint256(1_000n)
        if (call.method === 'eth_gasPrice') return uint256(2_000_000_000n)
        if (call.method === 'eth_getTransactionCount') return uint256(0n)
        if (call.method === 'eth_getTransactionReceipt') return launchReceipt(chainId)
        if (call.method === 'eth_getCode') {
          const address = call.params?.[0]
          if (!address) return '0x60006000'
          // A Safe this envelope creates exists only once its setup call is sent.
          const safes = stored?.envelope.jb.safes ?? []
          if (safes.some(safe => getAddress(safe.address) === getAddress(address))) return '0x'
          return CANONICAL_CODE[getAddress(address)] ?? '0x60006000'
        }
        if (call.method === 'eth_call') {
          const { to, data = '0x' } = call.params?.[0] ?? {}
          if (!data.startsWith(AGGREGATE3_SELECTOR)) return answerCall(to, data)
          const [batched] = decodeFunctionData({ abi: multicall3Abi, data }).args
          return encodeFunctionResult({
            abi: multicall3Abi, functionName: 'aggregate3',
            result: batched.map(item => ({ success: true, returnData: answerCall(item.target, item.callData) })),
          })
        }
        if (call.method === 'eth_getBlockByNumber') return {
          number: uint256(1_000n), hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`,
          timestamp: uint256(1_800_000_000n), gasLimit: uint256(30_000_000n), gasUsed: '0x0',
          miner: `0x${'33'.repeat(20)}`, extraData: '0x', baseFeePerGas: uint256(1n),
          logsBloom: `0x${'00'.repeat(256)}`, transactions: [], uncles: [], sha3Uncles: `0x${'44'.repeat(32)}`,
          stateRoot: `0x${'55'.repeat(32)}`, transactionsRoot: `0x${'66'.repeat(32)}`, receiptsRoot: `0x${'77'.repeat(32)}`,
          difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', nonce: '0x0000000000000000', mixHash: `0x${'88'.repeat(32)}`,
        }
        return null
      }
      const reply = call => ({ jsonrpc: '2.0', id: call.id, result: answer(call) })
      return json(200, Array.isArray(calls) ? calls.map(reply) : reply(calls))
    })
  }
  return json(404, { error: 'not modeled' })
})

async function ready(url, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* the server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`${url} never became ready`)
}

center.listen(centerPort, '127.0.0.1')
const app = spawn('npx', ['next', 'dev', '--webpack', '--port', String(appPort)], {
  cwd: root,
  env: {
    ...process.env,
    NEXT_PUBLIC_SITE_URL: appOrigin,
    NEXT_PUBLIC_JBCENTER_URL: centerOrigin,
    NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'false',
    NEXT_DIST_DIR: '.next-intent-test',
  },
  stdio: 'inherit',
})

let browser
try {
  await ready(`${appOrigin}/create`)
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  await context.exposeFunction('__homerunTestSign', hexMessage => account.signMessage({ message: { raw: hexMessage } }))
  await context.addInitScript(({ address, chainId, relayHashForWallet }) => {
    // The wallet reports the chain it was last switched to, as a real one does:
    // a switch that never lands leaves every chain-scoped request waiting.
    let current = chainId
    const listeners = new Map()
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
        if (method === 'eth_chainId') return current
        if (method === 'net_version') return String(Number.parseInt(current, 16))
        if (method === 'personal_sign') return window.__homerunTestSign(params[0])
        if (method === 'wallet_switchEthereumChain') {
          current = params[0].chainId
          for (const handler of listeners.get('chainChanged') ?? []) handler(current)
          return null
        }
        if (method === 'eth_sendTransaction') {
          window.__homerunSends = [...window.__homerunSends ?? [], params[0].to]
          return relayHashForWallet
        }
        if (method === 'eth_estimateGas') return '0xdbba0'
        throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 })
      },
      on(event, handler) { listeners.set(event, [...listeners.get(event) ?? [], handler]) },
      removeListener(event, handler) { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== handler)) },
    }
    const info = { uuid: '7f0c1c3a-0000-4000-8000-000000000001', name: 'Test Wallet', rdns: 'test.homerun.money', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { address: account.address, chainId: '0x2105', relayHashForWallet: relayHash })
  await context.addInitScript(saved => {
    try { localStorage.setItem('homerun:create-draft:v1', JSON.stringify(saved)) } catch { /* storage is unavailable on about:blank */ }
  }, {
    raw: {
      ...CREATE_DEFAULTS,
      name: 'Neighborhood Workshop',
      location: 'Florianópolis',
      description: 'Shared tools that earn revenue through community use.',
      revenueDescription: 'Members pay for tool hire and repairs.',
      fundTokenName: 'Neighborhood Workshop FUND',
      fundTicker: 'FUND',
      ownerMode: 'create', ownerSigners: [account.address, SECOND_SIGNER], ownerThreshold: 2, ownerIsOperator: true,
      operatorMode: 'existing', operatorWallet: account.address,
      networks: ['ethereum', 'optimism', 'base'], networkEnvironment: 'production',
    },
    step: 4,
    incomeDefaultsVersion: 3,
  })
  // The IPFS gateway constant points at production Juicebox Center; serve the pinned
  // metadata from here so this run reaches no network but the modeled Center.
  await context.route('https://juicebox.center/ipfs/**', route => route.fulfill({ json: metadata }))

  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.setDefaultNavigationTimeout(180_000)
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(`${appOrigin}/create`)
  await page.getByRole('heading', { name: 'Create your project', exact: true }).waitFor()
  // The injected wallet authorizes this origin, so wagmi restores the connection
  // on mount and the header reports the account without opening the chooser.
  await page.locator('.site-header').getByRole('button', { name: /^Signed in/ }).waitFor()

  const preview = page.getByRole('button', { name: 'Show preview', exact: true })
  await preview.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Create with a transaction', exact: true }).count(), 0)
  await preview.click()

  await page.waitForURL(`${appOrigin}/create/preview`)
  await page.getByText('Preview. Nothing is created yet.', { exact: true }).waitFor()
  assert.match(await page.locator('main').textContent(), /Neighborhood Workshop/)
  assert.match(await page.locator('main').textContent(), /Ethereum, Optimism, Base/)
  assert.equal(await page.evaluate(() => localStorage.getItem('homerun:fund-launch:v1')), null)

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.waitForURL(`${appOrigin}/create`)
  await page.getByRole('heading', { name: 'Create your project', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Show preview', exact: true }).click()
  await page.waitForURL(`${appOrigin}/create/preview`)

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const review = page.getByRole('dialog')
  await review.getByText('Create your project', { exact: false }).first().waitFor()
  await review.getByText('2/2 approvals', { exact: false }).first().waitFor()
  await review.getByRole('checkbox').check()
  await review.getByRole('button', { name: 'Continue to wallet', exact: true }).click()

  await page.waitForURL(`${appOrigin}/intent/${intentId}`)
  await page.getByText('Deploys on first use', { exact: false }).first().waitFor()
  const intentText = await page.locator('main').textContent()
  assert.match(intentText, /Neighborhood Workshop/)
  assert.match(intentText, /free/)
  assert.match(intentText, /Owner: create Safe/)
  assert.match(intentText, new RegExp(SECOND_SIGNER, 'i'))
  await page.getByText(/costs ~[\d.]+ ETH/).first().waitFor()
  assert.deepEqual(errors, [])

  await page.locator('input[type="checkbox"][value="1"]').check()
  await page.getByRole('button', { name: 'Deploy selected', exact: true }).click()
  const relayReview = page.getByRole('dialog')
  await relayReview.getByText('Create this project on Ethereum', { exact: false }).first().waitFor()
  await relayReview.getByRole('checkbox').check()
  await relayReview.getByRole('button', { name: 'Continue to wallet', exact: true }).click()

  await page.waitForURL(new RegExp(`${appOrigin}/project/1/7\\?intent=${intentId}$`), { timeout: 60_000 })

  // The Safe this project owns does not exist on Ethereum yet, so the visitor
  // creates it before the project, and both are sent from their own wallet.
  // A project Center recorded is no longer held by this browser.
  assert.equal(await page.evaluate(() => localStorage.getItem('homerun:relay-held:v1')), null)
  const sends = await page.evaluate(() => window.__homerunSends ?? [])
  assert.equal(sends.length, 2)
  assert.equal(getAddress(sends[0]), SAFE_FACTORY)
  assert.equal(getAddress(sends[1]), getAddress(v6Address('ERC2771Forwarder', 1)))

  assert.equal(deployRequests, 1)
  assert.equal(relayRequests >= 1, true)
  assert.deepEqual(queued.sort((a, b) => a - b), [10, 8453])
  assert.deepEqual(recorded, [1])
  assert.equal(stored.envelope.format, 'homerun.money/fund.v1')
  assert.equal(stored.envelope.deploymentVersion, '6')
  assert.deepEqual(stored.envelope.chainIds, [1, 10, 8453])
  assert.equal(stored.envelope.deploymentCalls.length, 6)
  assert.deepEqual(stored.envelope.deploymentCalls.map(call => call.chainId), [1, 1, 10, 10, 8453, 8453])
  assert.equal(getAddress(stored.envelope.deploymentCalls[0].to), SAFE_FACTORY)
  assert.equal(Object.hasOwn(stored.envelope.deploymentCalls[0], 'value'), false)
  assert.equal(Object.hasOwn(stored.envelope.deploymentCalls[1], 'value'), false)
  assert.equal(stored.envelope.jb.safes.length, 1)
  assert.equal(stored.envelope.jb.safes[0].role, 'owner')
  assert.equal(stored.envelope.jb.safes[0].threshold, 2)
  assert.deepEqual(
    stored.envelope.jb.safes[0].owners.map(owner => owner.toLowerCase()),
    [account.address.toLowerCase(), SECOND_SIGNER.toLowerCase()],
  )
  assert.equal(stored.envelope.jb.owner, stored.envelope.jb.safes[0].address)
  assert.equal(stored.envelope.jb.app, 'homerun')
  assert.equal(stored.envelope.jb.kind, 'fund')
  assert.equal(stored.envelope.jb.projectUri, `ipfs://${cid}`)
  assert.equal(stored.publisher.toLowerCase(), account.address.toLowerCase())
  assert.match(stored.signature, /^0x[0-9a-f]{130}$/i)

  await mkdir('test-results/intent', { recursive: true })
  await writeFile('test-results/intent/summary.json', JSON.stringify({
    passed: true, browser: browser.version(),
    evidence: 'real Next.js application and packaged SDK; modeled Center responses and injected test wallet',
    intentId, deployRequests, relayRequests, intentReads, pageErrors: errors,
    safes: stored.envelope.jb.safes, queued, recorded,
  }, null, 2))
  console.log('PASS Homerun: previewed a FUND, published it, deployed two sponsored chains and paid for Ethereum')
} finally {
  await browser?.close()
  app.kill('SIGTERM')
  center.close()
}
