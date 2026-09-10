/**
 * Unsigned release candidates and an isolated Forge-VM rehearsal. Never broadcasts,
 * changes an Anvil node, signs, or writes deployment/SDK registry records.
 *
 * node --import tsx scripts/rehearse-income-release.mts --prepare-only
 * node --import tsx scripts/rehearse-income-release.mts --network base
 * node --import tsx scripts/rehearse-income-release.mts --network base --local-rpc http://127.0.0.1:18793
 *
 * Requires the eight stock unsigned packets and their matching simulation.json
 * files, plus exact current Homerun IPFS artifacts/build info and stock artifacts.
 * Output is confined to ignored artifacts/income-release-rehearsal.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { access, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { jbContractAddress, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { concatHex, encodeAbiParameters, getAddress, getCreate2Address, isAddressEqual, keccak256, padHex, toHex, toFunctionSelector, zeroAddress, type AbiParameter, type Address, type Hex } from 'viem'
import { prepareIncomeRelease } from './prepare-income-release.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stockRoot = resolve(root, '../JBSticky')
const outputRoot = resolve(root, 'artifacts/income-release-rehearsal')
const forgeBinary = resolve(root, 'artifacts/income-release-tools/v1.8.1/forge')
const forgeCommit = '982849d3140c01fd3b72905759581a132df7aa98'
const factory = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C')
const factoryCodehash = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989'
const chainNames = [
  [1, 'ethereum'], [10, 'optimism'], [8453, 'base'], [42161, 'arbitrum'],
  [84532, 'base_sepolia'], [421614, 'arbitrum_sepolia'], [11155111, 'sepolia'], [11155420, 'optimism_sepolia'],
] as const
const stockNames = ['JBStickyDeployer', 'JBTokenDistributor', 'JBStickyRewardPockets', 'JBStickyAutoStick'] as const
const stockFields = { JBStickyDeployer: 'deployer', JBTokenDistributor: 'distributor', JBStickyRewardPockets: 'pockets', JBStickyAutoStick: 'autoStick' } as const
const helperSalt = keccak256(toHex('homerun.income-deployer.global.v2'))
const immutableNames = ['CONTROLLER', 'DIRECTORY', 'PROJECTS', 'TOKENS', 'REV_DEPLOYER', 'REV_OWNER', 'SUCKER_REGISTRY', 'TOKEN_DISTRIBUTOR', 'USDC', 'STICKY_DEPLOYER', 'OMNICHAIN_DEPLOYER', 'PROTOCOL_CONFIG_HASH', 'FUND_TOKEN_CODE_HASH'].sort()
const stringify = (value: unknown) => `${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)}\n`
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const sameHex = (actual: string, expected: string, label: string) => assert.equal(actual.toLowerCase(), expected.toLowerCase(), label)
const word = (value: Address | Hex) => padHex(value, { size: 32 })
const isArbitrum = (chainId: number) => chainId === 42161 || chainId === 421614
const proxyMethods = ['web3_clientVersion', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getProof', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_gasPrice', 'net_version']
const centerOrigin = 'https://homerun.money'

type Artifact = {
  abi: { type: string; inputs?: AbiParameter[] }[]
  bytecode: { object: Hex; linkReferences?: Record<string, unknown> }
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]>; linkReferences?: Record<string, unknown> }
  metadata: { compiler: { version: string }; settings: { evmVersion: string; viaIR: boolean; optimizer: { enabled: boolean; runs: number }; metadata: { bytecodeHash: string } }; sources: Record<string, { keccak256: Hex }> }
  ast: unknown
}
type StockCall = {
  name: typeof stockNames[number]; chainId: number; to: Address; value: Hex; data: Hex; salt: Hex
  constructorArguments: unknown[]; encodedConstructorArguments: Hex; predictedAddress: Address
  initCodeKeccak256: Hex; initCodeBytes: number; artifactSha256: string; simulatedRuntimeCodehash: Hex
}
type ForkEvidence = { endpoint: string; client: string; chainId: number; forkBlock: number; forkBlockHash: Hex; timestamp: number; nodeInfoConfirmed: boolean; revision: string; forgeVersion: string; anvilVersion?: string; evmBlockNumber?: number; transport?: string; upstream?: string; origin?: string; proxyEvidencePath?: string }
type StockPacket = { format: string; kind: string; broadcast: boolean; liveDeploymentEvidence: boolean; chainId: number; fork: ForkEvidence; hookCreatedByDeployerConstructor: Address; calls: StockCall[] }
type NetworkEvidence = { name: string; chainId: number; packet: StockPacket; simulation: Record<string, string | number>; packetSha256: string; simulationSha256: string; proxyEvidenceSha256?: string }

function centerUrl(chainId: number, value?: string) {
  const expected = `https://juicebox.center/v1/rpc/${chainId}`
  assert.equal(value, expected, 'The read-only proxy must target the exact canonical Center chain URL.')
  return expected
}

function registered(name: string, chainId: number): Address {
  const value = name === 'USDC' ? (USDC_ADDRESSES as Record<number, Address>)[chainId] : (jbContractAddress['6'] as Record<string, Record<number, Address>>)[name]?.[chainId]
  assert(value && !isAddressEqual(value, zeroAddress), `Missing canonical SDK ${name} on ${chainId}`)
  return getAddress(value)
}

function localUrl(value: string): string {
  const url = new URL(value)
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash, 'Only a plain HTTP localhost/127.0.0.1 Anvil URL is allowed.')
  return url.href.replace(/\/$/, '')
}

function options() {
  let network = 'base', rpc: string | undefined, prepareOnly = false
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare-only') prepareOnly = true
    else if (args[i] === '--network') network = args[++i] ?? ''
    else if (args[i] === '--local-rpc') rpc = localUrl(args[++i] ?? '')
    else throw new Error(`Unsupported argument ${args[i]}; no wallet, broadcast, remote RPC, or registry options exist.`)
  }
  assert(chainNames.some(([, name]) => name === network), 'Use a network from the eight-chain release profile.')
  return { network, rpc, prepareOnly }
}

async function requireStockEvidenceFiles() {
  const paths = chainNames.flatMap(([, name]) => [
    resolve(stockRoot, `cache/homerun-release-rehearsal/${name}-unsigned-payloads.json`),
    resolve(stockRoot, `deployments/${name}/simulation.json`),
  ])
  const missing = (await Promise.all(paths.map(async path => {
    try { await access(path); return null } catch { return path }
  }))).filter((path): path is string => path !== null)
  if (missing.length) throw new Error(`The complete eight-network stock rehearsal evidence is required before preparing a shared helper candidate. Missing:\n${missing.join('\n')}\nUse prepare-income-release.mts for the available offline source/registry packet. No missing address or fork result will be inferred.`)
}

async function readArtifact(path: string, metadataHash: 'ipfs' | 'none', sourceRoot: string) {
  const bytes = await readFile(path), artifact = JSON.parse(bytes.toString()) as Artifact
  const settings = artifact.metadata.settings
  assert.equal(artifact.metadata.compiler.version, '0.8.28+commit.7893614a')
  assert.equal(settings.evmVersion, 'cancun'); assert.equal(settings.viaIR, true)
  assert.deepEqual(settings.optimizer, { enabled: true, runs: 200 }); assert.equal(settings.metadata.bytecodeHash, metadataHash)
  assert(/^0x(?:[\da-f]{2})+$/i.test(artifact.bytecode.object) && /^0x(?:[\da-f]{2})+$/i.test(artifact.deployedBytecode.object), 'Executable artifact bytecode is required.')
  assert.equal(Object.keys(artifact.bytecode.linkReferences ?? {}).length, 0)
  assert.equal(Object.keys(artifact.deployedBytecode.linkReferences ?? {}).length, 0)
  await Promise.all(Object.entries(artifact.metadata.sources).map(async ([unit, expected]) => {
    const path = isAbsolute(unit) ? unit : resolve(sourceRoot, unit)
    sameHex(keccak256(toHex(await readFile(path))), expected.keccak256, `Stale source: ${unit}`)
  }))
  return { artifact, sha256: sha256(bytes) }
}

async function stockEvidence(): Promise<NetworkEvidence[]> {
  const artifacts = new Map(await Promise.all(stockNames.map(async name => [name, await readArtifact(resolve(stockRoot, `out/${name}.sol/${name}.json`), 'none', stockRoot)] as const)))
  return Promise.all(chainNames.map(async ([chainId, name]) => {
    const packetPath = resolve(stockRoot, `cache/homerun-release-rehearsal/${name}-unsigned-payloads.json`)
    const simulationPath = resolve(stockRoot, `deployments/${name}/simulation.json`)
    const [packetBytes, simulationBytes] = await Promise.all([readFile(packetPath), readFile(simulationPath)])
    const packet = JSON.parse(packetBytes.toString()) as StockPacket, simulation = JSON.parse(simulationBytes.toString()) as NetworkEvidence['simulation']
    assert.equal(packet.format, 'homerun-sticky-unsigned-candidate-payloads/v1')
    assert.equal(packet.kind, 'unsigned-fork-reviewed-candidate-payloads')
    assert.equal(packet.broadcast, false); assert.equal(packet.liveDeploymentEvidence, false)
    assert.equal(packet.chainId, chainId); assert.equal(packet.fork.chainId, chainId); assert.equal(simulation.chainId, chainId)
    assert.equal(simulation.kind, 'simulation')
    assert(packet.fork.forgeVersion.includes('Version: 1.8.1') && packet.fork.forgeVersion.includes(forgeCommit), `${name}: regenerate stock evidence using pinned Forge 1.8.1.`)
    let proxyEvidenceSha256: string | undefined
    if (packet.fork.transport === 'read-only-center-proxy') {
      assert(isArbitrum(chainId), 'The read-only proxy fallback is restricted to Arbitrum.')
      assert.equal(packet.fork.nodeInfoConfirmed, false); assert.equal(packet.fork.origin, centerOrigin)
      centerUrl(chainId, packet.fork.upstream)
      const proxyBytes = await readFile(resolve(stockRoot, `cache/homerun-release-rehearsal/${name}-readonly-proxy.json`))
      const proxy = JSON.parse(proxyBytes.toString()) as Record<string, unknown>
      assert.equal(proxy.format, 'homerun-readonly-center-proxy-evidence/v1'); assert.equal(proxy.chainId, chainId)
      assert.equal(proxy.origin, centerOrigin); centerUrl(chainId, proxy.upstream as string)
      assert.equal(proxy.noAnvilUsed, true); assert.equal(proxy.noStateOverrides, true); assert.equal(proxy.stopped, true)
      assert(Array.isArray(proxy.forwardedMethods) && proxy.forwardedMethods.every(method => proxyMethods.includes(method)), 'Stock proxy evidence must contain only approved read methods.')
      assert(proxy.denialSelfTest, 'Stock proxy must prove its write denial self-test.')
      proxyEvidenceSha256 = sha256(proxyBytes)
    } else {
      assert.equal(packet.fork.nodeInfoConfirmed, true)
      assert(packet.fork.anvilVersion?.includes('Version: 1.8.1') && packet.fork.anvilVersion.includes(forgeCommit), `${name}: regenerate stock evidence using pinned Anvil 1.8.1.`)
    }
    assert(Number.isSafeInteger(simulation.blockNumber) && Number(simulation.blockNumber) > 0, 'Stock simulation must identify its EVM block height.')
    assert.equal(simulation.blockNumber, packet.fork.evmBlockNumber ?? packet.fork.forkBlock, 'Stock EVM-height evidence differs from its simulation.')
    assert.equal(simulation.timestamp, packet.fork.timestamp)
    assert.equal(simulation.revision, packet.fork.revision)
    sameHex(simulation.create2Factory as string, factory, 'Canonical stock factory')
    sameHex(simulation.create2FactoryCodehash as string, factoryCodehash, 'Canonical factory runtime')
    sameHex(simulation.hook as string, packet.hookCreatedByDeployerConstructor, 'Sticky constructor hook')
    assert.deepEqual(packet.calls.map(call => call.name), stockNames, 'Expected four ordered stock factory calls.')
    const deployer = packet.calls[0].predictedAddress, distributor = packet.calls[1].predictedAddress
    const constructorValues = [
      [registered('JBController', chainId), registered('JBMultiTerminal', chainId)],
      [registered('JBDirectory', chainId), registered('JBController', chainId), zeroAddress, zeroAddress, 604_800n, 4n, 94_608_000n],
      [distributor], [deployer, distributor],
    ]
    packet.calls.forEach((call, index) => {
      const compiled = artifacts.get(call.name)!
      assert.equal(call.chainId, chainId); sameHex(call.to, factory, 'Stock factory target'); assert.equal(BigInt(call.value), 0n)
      assert.equal(call.artifactSha256, compiled.sha256, `${name}/${call.name} artifact fingerprint changed.`)
      const saltText = call.name === 'JBStickyAutoStick' ? 'JBStickyAutoStickV6' : 'JBStickyDeployerV6'
      sameHex(call.salt, padHex(toHex(saltText), { size: 32, dir: 'right' }), 'Stock release salt')
      const encoded = encodeAbiParameters(compiled.artifact.abi.find(entry => entry.type === 'constructor')!.inputs!, constructorValues[index] as never)
      sameHex(call.encodedConstructorArguments, encoded, 'Stock constructor arguments')
      const initCode = concatHex([compiled.artifact.bytecode.object, encoded])
      sameHex(call.data, concatHex([call.salt, initCode]), 'Exact unsigned stock factory calldata')
      sameHex(call.initCodeKeccak256, keccak256(initCode), 'Stock initcode hash')
      assert.equal(call.initCodeBytes, (initCode.length - 2) / 2); assert(call.initCodeBytes <= 49_152)
      sameHex(call.predictedAddress, getCreate2Address({ from: factory, salt: call.salt, bytecode: initCode }), 'Stock CREATE2 prediction')
      sameHex(simulation[stockFields[call.name]] as string, call.predictedAddress, 'Stock simulation address')
      sameHex(simulation[`${stockFields[call.name]}Codehash`] as string, call.simulatedRuntimeCodehash, 'Stock simulation complete runtime hash')
    })
    return { name, chainId, packet, simulation, packetSha256: sha256(packetBytes), simulationSha256: sha256(simulationBytes), proxyEvidenceSha256 }
  }))
}

/** Ephemeral fixed-chain transport. Rejected write methods are never forwarded. */
async function startReadOnlyProxy(evidence: NetworkEvidence) {
  const upstream = centerUrl(evidence.chainId, evidence.packet.fork.upstream)
  const methodCounts: Record<string, number> = {}, rejectedMethods: Record<string, number> = {}
  const upstreamErrors: { method: string; status?: number }[] = []
  const server = createServer(async (request, response) => {
    const reply = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      assert.equal(request.method, 'POST')
      let body = ''
      for await (const bytes of request) { body += bytes.toString(); assert(body.length <= 2_000_000, 'RPC body too large') }
      const raw = JSON.parse(body) as unknown, batch = Array.isArray(raw) ? raw : [raw]
      assert(batch.length > 0 && batch.length <= 100, 'Invalid RPC batch')
      const replies = await Promise.all(batch.map(async rawItem => {
        const item = rawItem as { jsonrpc?: string; method?: string; params?: unknown[]; id?: unknown }
        const method = item?.method ?? 'invalid', params = item?.params ?? []
        if (!item || item.jsonrpc !== '2.0' || !Array.isArray(params) || !proxyMethods.includes(method) || (method === 'eth_call' && params.length > 2)) {
          rejectedMethods[method] = (rejectedMethods[method] ?? 0) + 1
          return { jsonrpc: '2.0', id: item?.id ?? null, error: { code: -32601, message: 'Only approved read methods without state overrides are forwarded.' } }
        }
        methodCounts[method] = (methodCounts[method] ?? 0) + 1
        try {
          const result = await fetch(upstream, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', origin: centerOrigin }, body: JSON.stringify(item), signal: AbortSignal.timeout(60_000) })
          if (!result.ok) { upstreamErrors.push({ method, status: result.status }); throw new Error('Upstream read failed') }
          return await result.json()
        } catch { return { jsonrpc: '2.0', id: item.id ?? null, error: { code: -32000, message: 'Canonical upstream read failed.' } } }
      }))
      reply(Array.isArray(raw) ? replies : replies[0])
    } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid read-only RPC request.' } }) }
  })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let stopped = false
  const close = async () => { if (!stopped) { await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); stopped = true } }
  try {
    for (const item of [{ method: 'eth_sendRawTransaction', params: ['0x'] }, { method: 'eth_call', params: [{}, 'latest', {}] }]) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...item }) })
      const result = await response.json() as { error?: { code?: number } }
      assert.equal(result.error?.code, -32601, 'The proxy must reject writes and state overrides.')
    }
  } catch (error) { await close(); throw error }
  return { endpoint, close, evidence: () => ({ format: 'homerun-helper-readonly-proxy-evidence/v1', chainId: evidence.chainId, upstream, origin: centerOrigin, endpoint, forwardedMethods: proxyMethods, methodCounts, rejectedMethods, upstreamErrors, denialSelfTest: true, noAnvilUsed: true, noStateOverrides: true, stopped }) }
}

function immutableGroups(artifact: Artifact) {
  const names = new Map<string, string>()
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const item = node as Record<string, unknown>
    if (item.nodeType === 'VariableDeclaration' && item.mutability === 'immutable') names.set(String(item.id), String(item.name))
    Object.values(item).forEach(walk)
  }
  walk(artifact.ast)
  const used = new Set<number>(), runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2
  const groups = Object.entries(artifact.deployedBytecode.immutableReferences ?? {}).map(([id, references]) => {
    const name = names.get(id); assert(name && references.length, `Unrecognized immutable AST group ${id}`)
    for (const { start, length } of references) {
      assert(Number.isInteger(start) && start >= 0 && length === 32 && start + length <= runtimeBytes)
      assert.equal(artifact.deployedBytecode.object.slice(2 + start * 2, 2 + (start + length) * 2), '00'.repeat(32), `Nonzero template word ${name}`)
      for (let offset = start; offset < start + length; offset++) { assert(!used.has(offset), 'Overlapping immutable references'); used.add(offset) }
    }
    return { id, name, references }
  })
  assert.deepEqual(groups.map(group => group.name).sort(), immutableNames, 'The complete immutable profile changed; review the harness.')
  assert(runtimeBytes <= 24_576, 'Helper runtime exceeds EIP-170.')
  return groups
}

/** Every RPC method is read-only. The Forge script has no broadcast cheatcodes. */
async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  assert(['anvil_nodeInfo', 'web3_clientVersion', 'eth_chainId', 'eth_accounts', 'eth_getBlockByNumber', 'eth_getCode'].includes(method), 'Only read-only local fork RPC methods are supported.')
  const response = await fetch(localUrl(url), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) })
  assert(response.ok, `Local Anvil RPC HTTP ${response.status}`)
  const data = await response.json() as { result?: unknown; error?: { message?: string } }
  assert(!data.error, `Local RPC ${method} failed: ${data.error?.message ?? 'unknown error'}`)
  return data.result
}

async function observeLocalFork(url: string, evidence: NetworkEvidence, helper: Address) {
  const proxy = evidence.packet.fork.transport === 'read-only-center-proxy'
  const [node, version, chain, accounts, block] = await Promise.all([
    proxy ? null : rpc(url, 'anvil_nodeInfo'), rpc(url, 'web3_clientVersion'), rpc(url, 'eth_chainId'), proxy ? null : rpc(url, 'eth_accounts'), rpc(url, 'eth_getBlockByNumber', [proxy ? toHex(evidence.packet.fork.forkBlock) : 'latest', false]),
  ])
  if (!proxy) {
    assert(node && typeof node === 'object', 'Anvil nodeInfo is required.')
    assert(typeof version === 'string' && version.toLowerCase().includes('anvil/v1.8.1'), 'The local node must use pinned Anvil 1.8.1.')
    assert.deepEqual(accounts, [], 'The rehearsal requires Anvil started with --accounts 0.')
  }
  assert.equal(Number(BigInt(chain as string)), evidence.chainId)
  const header = block as { number: Hex; hash: Hex; parentHash: Hex; timestamp: Hex }
  assert.equal(Number(BigInt(header.number)), evidence.packet.fork.forkBlock, 'Use the unchanged stock rehearsal fork block.')
  sameHex(header.hash, evidence.packet.fork.forkBlockHash, 'Local fork header changed')
  assert.equal(Number(BigInt(header.timestamp)), evidence.packet.fork.timestamp, 'Local fork timestamp changed')
  // Arbitrum exposes an L1-origin height to EVM NUMBER, while RPC headers use
  // L2 heights. The stock Forge observation records the EVM parent separately.
  if (!isArbitrum(evidence.chainId)) sameHex(header.parentHash, evidence.simulation.parentBlockHash as string, 'Local fork parent changed')
  const addresses = [factory, ...evidence.packet.calls.map(call => call.predictedAddress), evidence.packet.hookCreatedByDeployerConstructor, helper]
  const codes = await Promise.all(addresses.map(async address => ({ address, code: await rpc(url, 'eth_getCode', [address, header.number]) as Hex })))
  sameHex(keccak256(codes[0].code), factoryCodehash, 'Local canonical factory code')
  // Do not persist nodeInfo: it can contain a private upstream RPC URL.
  return { localEndpoint: localUrl(url), transport: proxy ? 'read-only-center-proxy' : 'local-anvil', client: version, chainId: evidence.chainId, accounts: proxy ? null : 0, blockNumber: evidence.packet.fork.forkBlock, blockHash: header.hash, parentBlockHash: header.parentHash, evmBlockNumber: evidence.simulation.blockNumber, evmParentBlockHash: evidence.simulation.parentBlockHash, timestamp: evidence.packet.fork.timestamp, nodeInfoConfirmed: !proxy, codes }
}

function solidityHarness(inputFile: string, resultFile: string, groups: ReturnType<typeof immutableGroups>, expected: Record<string, Hex>, tokens: Address) {
  const checks = groups.map(group => {
    const value = group.name === 'FUND_TOKEN_CODE_HASH' ? '_fundTokenHash()' : `bytes32(${expected[group.name]})`
    return `        value = _word(helper, hex"${toFunctionSelector(`${group.name}()`).slice(2)}");\n        require(value == ${value}, "${group.name}");\n${group.references.map(reference => `        _patch(runtime, ${reference.start}, value);`).join('\n')}\n        values = vm.serializeBytes32("immutableWords", "${group.name}", value);`
  }).join('\n')
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Rehearsal only: no broadcast, signing, impersonation, etch, or persistent node mutation.
interface LocalVm {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function serializeAddress(string calldata, string calldata, address) external returns (string memory);
    function serializeBytes32(string calldata, string calldata, bytes32) external returns (string memory);
    function serializeUint(string calldata, string calldata, uint256) external returns (string memory);
    function serializeBool(string calldata, string calldata, bool) external returns (string memory);
    function serializeString(string calldata, string calldata, string calldata) external returns (string memory);
    function writeJson(string calldata, string calldata) external;
}
contract IncomeReleaseRehearsal {
    LocalVm constant vm = LocalVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant FACTORY = ${factory};
    string constant INPUT = ${JSON.stringify(inputFile)};
    string constant RESULT = ${JSON.stringify(resultFile)};
    function run() external {
        string memory json = vm.readFile(INPUT);
        require(block.chainid == vm.parseJsonUint(json, ".chainId"), "chain");
        require(block.number == vm.parseJsonUint(json, ".evmBlockNumber"), "EVM block");
        require(block.timestamp == vm.parseJsonUint(json, ".timestamp"), "timestamp");
        require(blockhash(block.number - 1) == vm.parseJsonBytes32(json, ".evmParentBlockHash"), "EVM parent block");
        require(FACTORY.codehash == ${factoryCodehash}, "factory runtime");
${stockNames.map((_, index) => `        _stock(json, ".stock${index}");`).join('\n')}
        address hook = vm.parseJsonAddress(json, ".hook");
        require(hook.codehash == vm.parseJsonBytes32(json, ".hookCodehash"), "stock hook runtime");
        address helper = vm.parseJsonAddress(json, ".helper.address");
        bytes memory payload = vm.parseJsonBytes(json, ".helper.payload");
        bool created = _deployOrReuse(helper, payload);
        (bytes32 first, string memory values) = _verify(helper, json);
        require(!_deployOrReuse(helper, payload), "second pass must reuse");
        (bytes32 second,) = _verify(helper, json);
        require(first == second, "reused helper changed");
        string memory result = vm.serializeString("result", "kind", "isolated-forge-vm-rehearsal");
        result = vm.serializeBool("result", "liveDeploymentEvidence", false);
        result = vm.serializeBool("result", "broadcast", false);
        result = vm.serializeBool("result", "firstPassCreated", created);
        result = vm.serializeBool("result", "secondPassReused", true);
        result = vm.serializeAddress("result", "helper", helper);
        result = vm.serializeBytes32("result", "helperRuntimeCodehash", first);
        result = vm.serializeBytes32("result", "reusedRuntimeCodehash", second);
        result = vm.serializeUint("result", "immutableGroups", ${groups.length});
        result = vm.serializeUint("result", "immutableOccurrences", ${groups.reduce((sum, group) => sum + group.references.length, 0)});
        result = vm.serializeUint("result", "chainId", block.chainid);
        result = vm.serializeUint("result", "evmBlockNumber", block.number);
        result = vm.serializeUint("result", "rpcBlockNumber", vm.parseJsonUint(json, ".rpcBlockNumber"));
        result = vm.serializeString("result", "immutableWordsJson", values);
        vm.writeJson(result, RESULT);
    }
    function _stock(string memory json, string memory key) private {
        address target = vm.parseJsonAddress(json, string.concat(key, ".address"));
        _deployOrReuse(target, vm.parseJsonBytes(json, string.concat(key, ".payload")));
        require(target.codehash == vm.parseJsonBytes32(json, string.concat(key, ".codehash")), "stock full runtime");
    }
    function _deployOrReuse(address expected, bytes memory payload) private returns (bool created) {
        if (expected.code.length != 0) return false;
        (bool ok, bytes memory result) = FACTORY.call(payload);
        require(ok && result.length == 20 && address(bytes20(result)) == expected && expected.code.length != 0, "factory create2");
        return true;
    }
    function _verify(address helper, string memory json) private returns (bytes32 codehash, string memory values) {
        bytes memory runtime = vm.parseJsonBytes(json, ".helper.runtimeTemplate");
        bytes32 value;
${checks}
        require(helper.code.length == runtime.length && helper.codehash == keccak256(runtime), "complete helper runtime");
${chainNames.map(([chainId]) => `        require(_word(helper, abi.encodeWithSignature("usdcOf(uint32)", uint32(${chainId}))) == bytes32(${word(registered('USDC', chainId))}), "USDC ${chainId}");`).join('\n')}
        require(_word(helper, abi.encodeWithSignature("usdcOf(uint32)", uint32(31337))) == bytes32(0), "foreign USDC");
        require(_word(helper, abi.encodeWithSignature("originalPayer()")) == bytes32(0), "initial payer");
        require(_word(helper, abi.encodeWithSignature("incomeProjectIdOf(uint256)", uint256(1))) == bytes32(0), "initial binding");
        codehash = helper.codehash;
    }
    function _fundTokenHash() private view returns (bytes32) {
        address implementation = address(uint160(uint256(_word(${tokens}, abi.encodeWithSignature("TOKEN()")))));
        require(implementation.code.length != 0, "canonical token implementation");
        return keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }
    function _word(address target, bytes memory data) private view returns (bytes32 value) {
        (bool ok, bytes memory result) = target.staticcall(data);
        require(ok && result.length == 32, "getter");
        value = abi.decode(result, (bytes32));
    }
    function _patch(bytes memory data, uint256 start, bytes32 value) private pure {
        require(start + 32 <= data.length, "immutable range");
        assembly ("memory-safe") { mstore(add(add(data, 32), start), value) }
    }
}
`
}

async function runForge(directory: string, url: string, blockNumber: number) {
  const args = ['script', 'script/Rehearse.s.sol:IncomeReleaseRehearsal', '--root', directory, '--rpc-url', localUrl(url), '--fork-block-number', String(blockNumber), '--sig', 'run()', '--json']
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, reject) => {
    const process = spawn(forgeBinary, args, { cwd: directory, env: { ...globalThis.process.env, FOUNDRY_PROFILE: 'default', FOUNDRY_FFI: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', bytes => { stdout += bytes }); process.stderr.on('data', bytes => { stderr += bytes })
    process.on('error', reject); process.on('close', code => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
  await writeFile(resolve(directory, 'forge.log'), result.stdout + result.stderr)
  assert.equal(result.code, 0, `Isolated Forge rehearsal failed. Inspect ${resolve(directory, 'forge.log')}`)
  return { command: [forgeBinary, ...args], logSha256: sha256(result.stdout + result.stderr) }
}

async function main() {
  const opts = options()
  await requireStockEvidenceFiles()
  assert.equal(process.version, 'v22.23.1', 'Run this release rehearsal with pinned Node 22.23.1.')
  const forgeVersion = execFileSync(forgeBinary, ['--version'], { encoding: 'utf8' })
  assert(forgeVersion.includes('Version: 1.8.1') && forgeVersion.includes(forgeCommit), 'Pinned official Forge 1.8.1 is required.')
  const [release, networks] = await Promise.all([prepareIncomeRelease(), stockEvidence()])
  const helperEvidence = release.artifacts.find(entry => entry.name === 'HomerunIncomeDeployer')
  assert(helperEvidence && 'creationBytecodeKeccak256' in helperEvidence, 'Current exact helper build/source evidence is required; run the existing release preparation after compiling with --build-info.')
  const compiled = await readArtifact(resolve(root, 'out/HomerunIncomeDeployer.sol/HomerunIncomeDeployer.json'), 'ipfs', root)
  assert.equal(compiled.sha256, helperEvidence.artifactSha256, 'The helper artifact changed during preparation.')
  const groups = immutableGroups(compiled.artifact)
  const chainConfiguration = networks.map(({ chainId, packet }) => ({ chainId, controller: registered('JBController', chainId), revDeployer: registered('REVDeployer', chainId), tokenDistributor: getAddress(packet.calls[1].predictedAddress), usdc: registered('USDC', chainId), stickyDeployer: getAddress(packet.calls[0].predictedAddress), omnichainDeployer: registered('JBOmnichainDeployer', chainId) }))
  assert.deepEqual(chainConfiguration.map(entry => entry.chainId), chainNames.map(([chainId]) => chainId))
  const constructorArguments = encodeAbiParameters(compiled.artifact.abi.find(entry => entry.type === 'constructor')!.inputs!, [chainConfiguration])
  assert.equal((constructorArguments.length - 2) / 2, 64 + 224 * chainNames.length)
  const initCode = concatHex([compiled.artifact.bytecode.object, constructorArguments])
  assert((initCode.length - 2) / 2 <= 49_152, 'Full helper initcode exceeds EIP-3860.')
  const helper = getCreate2Address({ from: factory, salt: helperSalt, bytecode: initCode })
  const protocolConfigHash = keccak256(constructorArguments), payload = concatHex([helperSalt, initCode])
  const selected = networks.find(entry => entry.name === opts.network)!
  const directory = resolve(outputRoot, opts.network), resultFile = resolve(directory, 'result.json'), inputFile = resolve(directory, 'input.json')
  await mkdir(resolve(directory, 'script'), { recursive: true })
  const expected = Object.fromEntries([
    ...['CONTROLLER', 'DIRECTORY', 'PROJECTS', 'TOKENS'].map(name => [name, word(registered(`JB${name[0]}${name.slice(1).toLowerCase()}`, selected.chainId))]),
    ['REV_DEPLOYER', word(registered('REVDeployer', selected.chainId))], ['REV_OWNER', word(registered('REVOwner', selected.chainId))],
    ['SUCKER_REGISTRY', word(registered('JBSuckerRegistry', selected.chainId))], ['TOKEN_DISTRIBUTOR', word(selected.packet.calls[1].predictedAddress)],
    ['STICKY_DEPLOYER', word(selected.packet.calls[0].predictedAddress)], ['OMNICHAIN_DEPLOYER', word(registered('JBOmnichainDeployer', selected.chainId))],
    ['USDC', word(registered('USDC', selected.chainId))], ['PROTOCOL_CONFIG_HASH', protocolConfigHash],
  ]) as Record<string, Hex>
  const input = {
    chainId: selected.chainId, rpcBlockNumber: selected.packet.fork.forkBlock, evmBlockNumber: selected.simulation.blockNumber, timestamp: selected.packet.fork.timestamp, evmParentBlockHash: selected.simulation.parentBlockHash,
    ...Object.fromEntries(selected.packet.calls.map((call, index) => [`stock${index}`, { address: call.predictedAddress, payload: call.data, codehash: call.simulatedRuntimeCodehash }])),
    hook: selected.packet.hookCreatedByDeployerConstructor, hookCodehash: selected.simulation.hookCodehash,
    helper: { address: helper, payload, runtimeTemplate: compiled.artifact.deployedBytecode.object },
  }
  const harness = solidityHarness(inputFile, resultFile, groups, expected, registered('JBTokens', selected.chainId))
  assert(!/\b(?:startBroadcast|broadcast|createSelectFork|etch|prank)\s*\(/.test(harness), 'Unexpected state-changing cheatcode in harness.')
  const inputBytes = stringify(input)
  await writeFile(inputFile, inputBytes)
  await writeFile(resolve(directory, 'script/Rehearse.s.sol'), harness)
  await writeFile(resolve(directory, 'foundry.toml'), `[profile.default]\nsrc = "script"\nscript = "script"\nsolc = "0.8.28"\nevm_version = "cancun"\noptimizer = true\noptimizer_runs = 200\nvia_ir = true\nbytecode_hash = "none"\nisolate = false\nffi = false\nfs_permissions = [{ access = "read", path = ${JSON.stringify(inputFile)} }, { access = "write", path = ${JSON.stringify(resultFile)} }]\n`)
  const candidate = {
    format: 'homerun-income-unsigned-rehearsal-candidate/v1', kind: 'unverified-candidate', releaseReady: false, deploymentAuthorized: false, broadcast: false, liveDeploymentEvidence: false, registryEntriesWritten: 0,
    dependencyAddressEvidence: 'unsigned stock fork candidates; not live deployments or SDK registry inputs',
    toolchain: { node: process.version, forgeVersion, forgeBinarySha256: sha256(await readFile(forgeBinary)) }, helperArtifact: helperEvidence, helperArtifactSha256: compiled.sha256, harnessSha256: sha256(harness), harnessInputSha256: sha256(inputBytes),
    factory, salt: helperSalt, constructorArguments: chainConfiguration, encodedConstructorArguments: constructorArguments, protocolConfigHash,
    initCodeKeccak256: keccak256(initCode), initCodeBytes: (initCode.length - 2) / 2, predictedAddress: helper,
    unsignedCalls: chainNames.map(([chainId]) => ({ chainId, to: factory, value: '0x0', data: payload })),
    stockEvidence: networks.map(({ name, chainId, packetSha256, simulationSha256, proxyEvidenceSha256, packet }) => ({ name, chainId, packetSha256, simulationSha256, proxyEvidenceSha256, forkBlock: packet.fork.forkBlock, forkBlockHash: packet.fork.forkBlockHash, revision: packet.fork.revision })),
    rehearsal: { network: opts.network, status: opts.prepareOnly ? 'not-run' : 'pending' },
    limitations: ['No deployment receipt or production verification is established.', 'Stock dependency addresses are unsigned fork predictions and must not be registered as deployed.', 'Only the selected chain is rehearsed by this run; the shared constructor includes all eight reviewed candidate networks.', 'The harness loads the exact helper IPFS artifact bytes. Its own compilation settings never recompile the helper.'],
  }
  const candidateFile = resolve(directory, 'unsigned-candidate.json')
  await writeFile(candidateFile, stringify(candidate))
  if (opts.prepareOnly) { console.log(`Prepared unverified unsigned candidate and isolated harness: ${candidateFile}`); return }
  if (selected.packet.fork.transport === 'read-only-center-proxy') assert(!opts.rpc, 'Arbitrum uses an internally managed read-only proxy, without an external engine override.')
  const proxy = selected.packet.fork.transport === 'read-only-center-proxy' ? await startReadOnlyProxy(selected) : undefined
  const url = localUrl(proxy?.endpoint ?? opts.rpc ?? selected.packet.fork.endpoint)
  let completed: Record<string, unknown> | undefined
  try {
    const before = await observeLocalFork(url, selected, helper)
    console.log(`Rehearsing ${opts.network} in an isolated Forge VM at block ${before.blockNumber}; no broadcast.`)
    await rm(resultFile, { force: true })
    let command: Awaited<ReturnType<typeof runForge>> | undefined
    try { command = await runForge(directory, url, before.blockNumber) }
    finally {
      const after = await observeLocalFork(url, selected, helper)
      assert.deepEqual(after, before, 'The pinned fork state changed during the rehearsal.')
    }
    const result = JSON.parse(await readFile(resultFile, 'utf8')) as Record<string, unknown>
    assert.equal(result.kind, 'isolated-forge-vm-rehearsal'); assert.equal(result.broadcast, false); assert.equal(result.liveDeploymentEvidence, false)
    sameHex(result.helper as string, helper, 'Rehearsed helper address')
    assert.equal(result.secondPassReused, true); assert.equal(result.immutableGroups, groups.length)
    assert.equal(result.chainId, selected.chainId); assert.equal(result.rpcBlockNumber, selected.packet.fork.forkBlock)
    assert.equal(result.evmBlockNumber, selected.simulation.blockNumber)
    sameHex(result.helperRuntimeCodehash as string, result.reusedRuntimeCodehash as string, 'Reused helper runtime')
    const immutableWords = JSON.parse(result.immutableWordsJson as string) as Record<string, Hex>
    assert.deepEqual(Object.keys(immutableWords).sort(), immutableNames)
    for (const [name, value] of Object.entries(expected)) sameHex(immutableWords[name], value, `Observed ${name}`)
    // Refuse to attach successful evidence to bytes that changed while Forge ran.
    assert.equal((await readArtifact(resolve(root, 'out/HomerunIncomeDeployer.sol/HomerunIncomeDeployer.json'), 'ipfs', root)).sha256, compiled.sha256)
    assert.equal(sha256(await readFile(inputFile)), sha256(inputBytes), 'Rehearsal inputs changed while Forge ran.')
    assert.equal(sha256(await readFile(resolve(directory, 'script/Rehearse.s.sol'))), sha256(harness), 'Rehearsal harness changed while Forge ran.')
    completed = { network: opts.network, status: 'passed-local-fork-only', observation: before, ...command, result: { ...result, immutableWords, immutableWordsJson: undefined }, pinnedStateUnchanged: true, persistentAnvilStateUnchanged: proxy ? undefined : true }
  } finally {
    if (proxy) { await proxy.close(); await writeFile(resolve(directory, 'readonly-proxy.json'), stringify(proxy.evidence())) }
  }
  assert(completed)
  await writeFile(candidateFile, stringify({ ...candidate, rehearsal: { ...completed, readOnlyProxy: proxy?.evidence() } }))
  console.log(`Passed complete runtime/immutable verification and CREATE2 reuse. Unverified candidate: ${candidateFile}`)
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
