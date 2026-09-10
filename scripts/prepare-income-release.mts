/**
 * Local release evidence only. No RPC, wallet, signature, deployment, or registry mutation.
 * Run from this checkout: node --import tsx scripts/prepare-income-release.mts
 * Redirect stdout to a review artifact if desired. Artifacts must already exist.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { CCIP_SUCKER_DEPLOYER_ADDRESSES, jbContractAddress, USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { concatHex, encodeAbiParameters, getAddress, getCreate2Address, isAddress, keccak256, padHex, toHex, zeroAddress, type AbiParameter, type Address, type Hex } from 'viem'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, '../..')
const profile = 'homerun-income-global-stock-sticky-v2-candidate'
const chainIds = [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420] as const
const linkedGroups = { mainnet: [1, 10, 8453, 42161], testnet: [84532, 421614, 11155111, 11155420] }
const deterministicFactory = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const
const helperSaltText = 'homerun.income-deployer.global.v2'
const helperSalt = keccak256(toHex(helperSaltText))
const distributionType = 'HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)'
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const pathLabel = (path: string) => relative(workspace, path)
type SourceMetadata = { keccak256: Hex }
type Artifact = {
  abi: { type: string; inputs?: (AbiParameter & { name: string })[] }[]
  bytecode: { object: Hex; linkReferences?: Record<string, unknown> }
  deployedBytecode: { object: Hex; linkReferences?: Record<string, unknown>; immutableReferences?: Record<string, { start: number; length: number }[]> }
  metadata: {
    compiler: { version: string }
    settings: Record<string, unknown> & { metadata?: { bytecodeHash?: string }; compilationTarget?: Record<string, string> }
    sources: Record<string, SourceMetadata>
  }
}
type ArtifactSpec = { name: string; location: string; sourceRoot: string; metadataHash: 'ipfs' | 'none'; constructor: string[] }

const specs: ArtifactSpec[] = [
  { name: 'HomerunIncomeDeployer', location: 'out', sourceRoot: root, metadataHash: 'ipfs', constructor: ['chains:tuple[](chainId:uint32,controller:address,revDeployer:address,tokenDistributor:address,usdc:address,stickyDeployer:address,omnichainDeployer:address)'] },
  { name: 'HomerunInitialIncomeVault', location: 'out', sourceRoot: root, metadataHash: 'ipfs', constructor: ['incomeToken:address', 'incomeProjectId:uint256', 'fundProjectId:uint256', 'snapshotBlockNumber:uint256', 'snapshotBlockHash:bytes32', 'totalFundSupply:uint256', 'launchSalt:bytes32', 'merkleRoot:bytes32', 'leafCount:uint256', 'manifestHash:bytes32', 'manifestUri_:string', 'sourceSetHash:bytes32', 'localInitialIncomeSupply:uint256'] },
  ...[
    ['JBStickyDeployer', ['controller:address', 'terminal:address']],
    ['JBStickyHook', ['directory:address', 'deployer:address']],
    ['JBTokenDistributor', ['directory:address', 'controller:address', 'revLoans:address', 'revOwner:address', 'initialRoundDuration:uint256', 'initialVestingRounds:uint256', 'initialClaimDuration:uint48']],
    ['JBStickyRewardPockets', ['distributor:address']],
    ['JBStickyRewardPocket', ['distributor:address', 'stickyToken:address']],
    ['JBStickyAutoStick', ['deployer:address', 'distributor:address']],
    ['JBStickyToken', ['name:string', 'symbol:string', 'tokens:address', 'projectId:uint256', 'hook:address', 'soulbound:bool']],
    ['JBStickyPriceFeed', ['hook:address', 'terminal:address', 'token:address', 'projectId:uint256', 'underlyingToken:address']],
  ].map(([name, constructor]) => ({ name: name as string, constructor: constructor as string[], location: 'artifacts/income-release-stock/out', sourceRoot: resolve(root, '../JBSticky'), metadataHash: 'none' as const })),
]

function parameterShape(input: AbiParameter): string {
  const components = 'components' in input ? `(${input.components.map(parameterShape).join(',')})` : ''
  return `${input.name}:${input.type}${components}`
}

type BuildInfo = { input?: unknown; output?: { contracts?: Record<string, Record<string, { evm?: { bytecode?: { object?: string }; deployedBytecode?: { object?: string } } }>> } }
const buildInfoCache = new Map<string, Promise<{ path: string; bytes: Buffer; info: BuildInfo }[]>>()
async function matchingBuildInfo(spec: ArtifactSpec, artifact: Artifact) {
  const directory = resolve(root, spec.location === 'out' ? 'out/build-info' : 'artifacts/income-release-stock/build-info')
  if (!buildInfoCache.has(directory)) buildInfoCache.set(directory, (async () => {
    const paths = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
    return Promise.all(paths.map(async name => {
      const path = resolve(directory, name), bytes = await readFile(path)
      return { path, bytes, info: JSON.parse(bytes.toString()) as BuildInfo }
    }))
  })())
  const [unit, contractName] = Object.entries(artifact.metadata.settings.compilationTarget ?? {})[0] ?? []
  for (const entry of await buildInfoCache.get(directory)!) {
    const compiled = entry.info.output?.contracts?.[unit]?.[contractName]
    if (!entry.info.input || !compiled) continue
    if (compiled.evm?.bytecode?.object?.replace(/^0x/, '') !== artifact.bytecode.object.slice(2)
      || compiled.evm?.deployedBytecode?.object?.replace(/^0x/, '') !== artifact.deployedBytecode.object.slice(2)) continue
    return { path: pathLabel(entry.path), sha256: sha256(entry.bytes), standardJsonInputSha256: sha256(JSON.stringify(entry.info.input)), containsExactCompilerInputAndOutput: true }
  }
  throw new Error(`${spec.name}: exact full build info is missing. Recompile with --build-info before release preparation.`)
}

async function fingerprint(spec: ArtifactSpec) {
  const artifactPath = resolve(root, spec.location, `${spec.name}.sol`, `${spec.name}.json`)
  const raw = await readFile(artifactPath)
  const artifact = JSON.parse(raw.toString()) as Artifact
  const constructor = artifact.abi.find(entry => entry.type === 'constructor')?.inputs ?? []
  const shape = constructor.map(parameterShape)
  if (JSON.stringify(shape) !== JSON.stringify(spec.constructor)) throw new Error(`${spec.name}: constructor changed; this release profile must be reviewed again.`)
  if (!/^0x(?:[\da-f]{2})+$/i.test(artifact.bytecode.object) || !/^0x(?:[\da-f]{2})+$/i.test(artifact.deployedBytecode.object)
    || Object.keys(artifact.bytecode.linkReferences ?? {}).length || Object.keys(artifact.deployedBytecode.linkReferences ?? {}).length) throw new Error(`${spec.name}: executable bytecode is missing or requires linked libraries.`)
  const settings = artifact.metadata.settings
  if (artifact.metadata.compiler.version !== '0.8.28+commit.7893614a' || settings.evmVersion !== 'cancun' || settings.viaIR !== true || JSON.stringify(settings.optimizer) !== JSON.stringify({ enabled: true, runs: 200 }) || settings.metadata?.bytecodeHash !== spec.metadataHash) {
    throw new Error(`${spec.name}: compilation settings differ from the reviewed profile.`)
  }
  const sources = await Promise.all(Object.entries(artifact.metadata.sources).map(async ([unit, source]) => {
    const sourcePath = isAbsolute(unit) ? unit : resolve(spec.sourceRoot, unit)
    const actual = keccak256(toHex(await readFile(sourcePath)))
    if (actual !== source.keccak256) throw new Error(`${spec.name}: stale artifact source ${unit}. Recompile before preparing evidence.`)
    return { path: pathLabel(sourcePath), keccak256: actual }
  }))
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const creationBytes = (artifact.bytecode.object.length - 2) / 2
  const runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2
  if (creationBytes > 49_152 || runtimeBytes > 24_576) throw new Error(`${spec.name}: bytecode exceeds an EVM deployment size limit.`)
  const immutableReferences = artifact.deployedBytecode.immutableReferences ?? {}
  for (const references of Object.values(immutableReferences)) for (const reference of references) {
    if (!Number.isInteger(reference.start) || reference.start < 0 || reference.length !== 32 || reference.start + reference.length > runtimeBytes) throw new Error(`${spec.name}: invalid immutable word reference in the runtime template.`)
  }
  const buildInfo = await matchingBuildInfo(spec, artifact)
  return {
    artifact,
    summary: {
      name: spec.name, artifact: pathLabel(artifactPath), artifactSha256: sha256(raw),
      compiler: artifact.metadata.compiler.version, settings, constructor,
      creationBytecodeKeccak256: keccak256(artifact.bytecode.object), creationBytes,
      runtimeTemplateKeccak256: keccak256(artifact.deployedBytecode.object), runtimeBytes,
      eip170RuntimeHeadroomBytes: 24_576 - runtimeBytes,
      runtimeTemplateIsDeployedCode: false,
      immutableReferences, buildInfo,
      sourceGraphKeccak256: keccak256(toHex(JSON.stringify(sources))), sources,
    },
  }
}

function repository(name: string, path: string) {
  try {
    return {
      name, path: pathLabel(path),
      commit: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      trackedChanges: execFileSync('git', ['-C', path, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    }
  } catch { return { name, path: pathLabel(path), commit: null, status: 'revision-unavailable' } }
}

function registered(name: string, chainId: number): Address | null {
  const registry = jbContractAddress['6'] as Record<string, Partial<Record<number, string>>>
  const address = name === 'USDC' ? (USDC_ADDRESSES as Record<number, string>)[chainId] : registry[name]?.[chainId]
  return address && isAddress(address) && address.toLowerCase() !== zeroAddress ? getAddress(address) : null
}

function missingInput(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.some(missingInput)
  return typeof value === 'object' && Object.values(value).some(missingInput)
}

function constructorPlan(artifact: Artifact | undefined, values: unknown[], knownArgumentBytes?: number) {
  const creationBytes = artifact ? (artifact.bytecode.object.length - 2) / 2 : null
  const knownInitCodeBytes = creationBytes !== null && knownArgumentBytes !== undefined ? creationBytes + knownArgumentBytes : null
  const pending = { arguments: values, encodedArguments: null, initCodeKeccak256: null, encodedArgumentBytes: knownArgumentBytes ?? null, initCodeBytes: knownInitCodeBytes, eip3860InitcodeHeadroomBytes: knownInitCodeBytes === null ? null : 49_152 - knownInitCodeBytes }
  if (knownInitCodeBytes !== null && knownInitCodeBytes > 49_152) throw new Error('The full initcode, including constructor arguments, exceeds EIP-3860.')
  if (missingInput(values)) return { ...pending, status: 'missing-verified-registry-input' }
  if (!artifact) return { ...pending, status: 'artifact-unavailable-or-invalid' }
  const inputs = artifact.abi.find(entry => entry.type === 'constructor')?.inputs ?? []
  const encodedArguments = encodeAbiParameters(inputs, values as never)
  const initCode = concatHex([artifact.bytecode.object, encodedArguments])
  const initCodeBytes = (initCode.length - 2) / 2
  if (initCodeBytes > 49_152) throw new Error('The full initcode, including constructor arguments, exceeds EIP-3860.')
  return {
    arguments: values, encodedArguments, encodedArgumentBytes: (encodedArguments.length - 2) / 2,
    initCodeKeccak256: keccak256(initCode), initCodeBytes, eip3860InitcodeHeadroomBytes: 49_152 - initCodeBytes,
    status: 'encoded-from-sdk-inputs; live-code-and-bindings-not-verified-by-this-script',
  }
}

export async function prepareIncomeRelease() {
  const blockers = ['No executed helper/Sticky deployment receipts or per-chain runtime/immutable verification are established by this offline packet.', 'The new helper and claim-vault source must be frozen with its reviewed compiler inputs before a production release.']
  const helperSource = await readFile(resolve(root, 'src/HomerunIncomeDeployer.sol'), 'utf8')
  const vaultSource = await readFile(resolve(root, 'src/HomerunInitialIncomeVault.sol'), 'utf8')
  const normalized = helperSource.replace(/\s+/g, ' ')
  const sourceAssertions = [
    'constructor(HomerunIncomeChainConfig[] memory chains)',
    'PROTOCOL_CONFIG_HASH = keccak256(abi.encode(chains));',
    'config.scopeCashOutsToLocalBalances = false;',
    'return distributor.REV_OWNER() == address(0) && distributor.REV_LOANS() == address(0);',
    'distributor.ROUND_DURATION() != 7 days', 'distributor.VESTING_ROUNDS() != 4', 'distributor.CLAIM_DURATION() != 3 * 365 days',
    'totalIncome != INITIAL_INCOME_SUPPLY', 'uint256 stageId = block.timestamp;', 'extraMetadata: 4', distributionType,
  ]
  if (sourceAssertions.some(expected => !normalized.includes(expected)) || !vaultSource.includes(distributionType) || !vaultSource.includes('LOCAL_INITIAL_INCOME_SUPPLY - totalClaimed')) {
    throw new Error('The source no longer matches the global stock-Sticky release profile. Review the changed semantics before regenerating release evidence.')
  }
  const collected = await Promise.all(specs.map(async spec => {
    try { return { name: spec.name, result: await fingerprint(spec) } }
    catch (error) {
      const issue = error instanceof Error ? error.message : String(error)
      blockers.push(issue)
      const artifactPath = resolve(root, spec.location, `${spec.name}.sol`, `${spec.name}.json`)
      const artifactBytes = await readFile(artifactPath).catch(() => null)
      return { name: spec.name, issue, artifact: pathLabel(artifactPath), artifactSha256: artifactBytes ? sha256(artifactBytes) : null }
    }
  }))
  const byName = new Map(collected.map(entry => [entry.name, entry.result?.artifact]))
  const required = ['JBController', 'JBDirectory', 'JBProjects', 'JBTokens', 'JBMultiTerminal', 'JBSuckerRegistry', 'JBOmnichainDeployer', 'REVDeployer', 'REVOwner', 'REVLoans', 'USDC', 'JBStickyDeployer', 'JBTokenDistributor', 'HomerunIncomeDeployer']
  const networks = chainIds.map(chainId => {
    const addresses = Object.fromEntries(required.map(name => [name, registered(name, chainId)]))
    const missingRegistryEntries = required.filter(name => !addresses[name])
    if (missingRegistryEntries.length) blockers.push(`Chain ${chainId}: missing SDK registry entries ${missingRegistryEntries.join(', ')}.`)
    return {
      chainId, addresses, missingRegistryEntries, addressEvidence: 'installed SDK registry; no live RPC performed',
      constructors: {
        JBStickyDeployer: constructorPlan(byName.get('JBStickyDeployer'), [addresses.JBController, addresses.JBMultiTerminal], 64),
        JBTokenDistributor: constructorPlan(byName.get('JBTokenDistributor'), [addresses.JBDirectory, addresses.JBController, zeroAddress, zeroAddress, 604_800n, 4n, 94_608_000n], 224),
        JBStickyRewardPockets: constructorPlan(byName.get('JBStickyRewardPockets'), [addresses.JBTokenDistributor], 32),
        JBStickyAutoStick: constructorPlan(byName.get('JBStickyAutoStick'), [addresses.JBStickyDeployer, addresses.JBTokenDistributor], 64),
      },
      helperConstructor: 'sharedHelper.constructor; identical eight-chain array on every network',
      ccipRoutes: (Object.values(linkedGroups).find(group => group.includes(chainId)) ?? []).filter(remote => remote !== chainId).map(remoteChainId => {
        const address = CCIP_SUCKER_DEPLOYER_ADDRESSES[6][chainId]?.[remoteChainId as keyof typeof CCIP_SUCKER_DEPLOYER_ADDRESSES[6][typeof chainId]] ?? null
        if (!address) blockers.push(`Chain ${chainId}: missing SDK CCIP deployer for ${remoteChainId}.`)
        return {
          remoteChainId, sdkDeployer: address, defaultPeer: `0x${'00'.repeat(32)}`,
          localToken: addresses.USDC, remoteToken: registered('USDC', remoteChainId) ? padHex(registered('USDC', remoteChainId)!) : null, minGas: 200_000,
          evidence: 'SDK address only; allowlist, singleton, router, selector and reciprocal peer compatibility require live verification',
        }
      }),
    }
  })
  const chainConfiguration = networks.map(({ chainId, addresses }) => ({
    chainId, controller: addresses.JBController, revDeployer: addresses.REVDeployer,
    tokenDistributor: addresses.JBTokenDistributor, usdc: addresses.USDC,
    stickyDeployer: addresses.JBStickyDeployer, omnichainDeployer: addresses.JBOmnichainDeployer,
  }))
  if (chainConfiguration.some((entry, index) => index > 0 && entry.chainId <= chainConfiguration[index - 1].chainId)) throw new Error('The shared helper constructor must contain strictly increasing chain IDs.')
  const helperConstructor = constructorPlan(byName.get('HomerunIncomeDeployer'), [chainConfiguration], 64 + 224 * chainIds.length)
  const protocolConfigHash = helperConstructor.encodedArguments ? keccak256(helperConstructor.encodedArguments) : null
  const helperPredictedAddress = helperConstructor.initCodeKeccak256 ? getCreate2Address({ from: deterministicFactory, salt: helperSalt, bytecodeHash: helperConstructor.initCodeKeccak256 }) : null
  if (helperPredictedAddress && networks.some(network => network.addresses.HomerunIncomeDeployer && network.addresses.HomerunIncomeDeployer !== helperPredictedAddress)) blockers.push('A registered helper differs from the address implied by the reviewed shared constructor, artifact and salt.')
  const sdkPackage = await readFile(resolve(root, 'node_modules/@bananapus/nana-sdk-core/package.json'))
  const historicalEvidence = await readFile(resolve(root, 'docs/STICKY_REWARDS.md'))
  return {
    format: 'homerun-income-release-manifest/v2', profile, releaseReady: false, deploymentAuthorized: false,
    supersedesProfile: 'homerun-income-single-chain-stock-sticky-v1-draft',
    capturedAt: new Date().toISOString(), liveRpcCalls: 0, walletCalls: 0,
    helperSourceKeccak256: keccak256(toHex(helperSource)),
    vaultSourceKeccak256: keccak256(toHex(vaultSource)),
    profileChecks: { recursiveConstructorShape: true, sourceAssertions, sourceAssertionsAreFormalVerification: false, metadataHash: { Homerun: 'ipfs', stockSticky: 'none' }, fullInitcodeIncludesConstructor: true },
    semantics: {
      initialIncomeSupply: '500000000000000000000000', allocationScope: 'one global allocation; local and pending-bridge-destination claims preserve chain identity',
      sourceSetHash: 'keccak256 of canonical full global snapshot report', distributionType, distributionTypeHash: keccak256(toHex(distributionType)),
      rootAuthority: 'operator-attested; membership proofs do not establish historical truth, completeness or sum',
      localVault: 'immutable local cap; zero cap and zero-income dust roots allowed; exact rational beneficial ownership can yield positive INCOME with zero integer FUND display balance; perpetual fixed-beneficiary claims; no admin/sweep/expiry',
      snapshotClock: { arbitrumChainIds: [42_161, 421_614], arbitrumPrecompile: '0x0000000000000000000000000000000000000064', arbitrumMethods: ['arbBlockNumber()', 'arbBlockHash(uint256)'], otherChains: 'EVM NUMBER/BLOCKHASH', recentHashWindow: 256, olderHashes: 'explicit operator attestation; independently reconstructed and finalized by the client' },
      deployment: 'stock asynchronous cross-chain deployment with local atomic premint; remote accounting is asynchronous, not an all-chain readiness barrier',
      revnet: { initialIssuance: '10000000000000000000', quarterSeconds: 7_884_000, cuts: 8, cutPercent: 50_000_000, finalStageAfterSeconds: 63_072_000, splitPercent: 8_000, operatorSplitPercent: 875_000_000, fundSplitPercent: 125_000_000, splitLockedUntil: '281474976710655', extraMetadata: 4, scopeCashOutsToLocalBalances: false, commonAbsoluteStartRequired: true, lateCashOutAndLoanDelaySeconds: 604_800 },
      ongoingRewards: { source: 'chain-local stock Sticky SHARE snapshots', stakeAgeMinimum: 0, ageMultiplier: false, stickyCashOutTaxRate: 0, roundDuration: 604_800, vestingRounds: 4, claimDuration: 94_608_000, revOwner: zeroAddress, revLoans: zeroAddress, startingTimestamp: 'immutable deployment timestamp; must be positive and no later than observation time' },
    },
    sdk: { version: JSON.parse(sdkPackage.toString()).version, packageSha256: sha256(sdkPackage), lockfileSha256: sha256(await readFile(resolve(root, 'package-lock.json'))) },
    repositories: [repository('homerun', root), repository('core-v6', resolve(workspace, 'nana-core-v6')), repository('revnet-v6', resolve(workspace, 'revnet-core-v6')), repository('suckers-v6', resolve(workspace, 'nana-suckers-v6')), repository('omnichain-deployers-v6', resolve(workspace, 'nana-omnichain-deployers-v6')), repository('distributor-v6', resolve(workspace, 'nana-distributor-v6')), repository('JBSticky', resolve(root, '../JBSticky'))],
    artifacts: collected.map(entry => entry.result?.summary ?? { name: entry.name, artifact: entry.artifact, artifactSha256: entry.artifactSha256, status: 'unavailable-or-invalid', issue: entry.issue }),
    sharedHelper: {
      factory: deterministicFactory, factoryEvidence: 'canonical source constant; live factory code not checked by this script',
      saltDerivation: `keccak256(UTF8(${JSON.stringify(helperSaltText)}))`, salt: helperSalt, saltStatus: 'prepared release constant; not a deployment record',
      chainIds, linkedGroups, constructor: helperConstructor, protocolConfigHash, predictedAddress: helperPredictedAddress,
      addressStatus: helperPredictedAddress ? 'deterministic prediction only; requires executed receipt and runtime verification' : 'unavailable until actual registered dependency inputs exist',
      runtimePolicy: 'same initcode/address and PROTOCOL_CONFIG_HASH across chains; local immutable dependencies can make deployed runtime hashes different',
      perProjectVaultInitcode: 'measure creation bytecode plus all 13 encoded arguments, including the UTF-8 manifest URI, against 49,152 bytes; no singleton vault address is predicted',
    },
    networks,
    historicalCodeCheck: {
      source: 'docs/STICKY_REWARDS.md', sourceSha256: sha256(historicalEvidence), reportedDate: '2026-09-10',
      chainIds,
      addresses: { JBStickyDeployer: '0x548B27933aD9005bcc66d9A465069bc8553Fa2e2', JBStickyHook: '0xe96d1eda8A34BC3054b5373757B09BEaF9608A7a', JBTokenDistributor: '0xEDa8563977EB0857616C163b8084B3152332e6BE' },
      result: 'The prior read-only check reported eth_getCode = 0x for all 24 chain/address pairs.',
      limitation: 'Historical simulation predictions only, not current predictions or verified deployment addresses. No block hashes were recorded in that note. This script does not repeat or upgrade that evidence.',
    },
    requiredPostDeploymentEvidence: ['Executed deployment receipts with chain/block/transaction identity, identical shared helper constructor inputs, factory and salt.', 'Full executable-runtime and every immutable-word verification against the exact reviewed artifacts on each chain; template hashes above are not live runtime hashes. Verify shared PROTOCOL_CONFIG_HASH and every usdcOf entry.', 'Stock Sticky per-chain verified.json with the reviewed source revision and observed runtime hashes; simulation.json is never sufficient.', 'For every directed SDK CCIP route, verify registry allowlisting, directory/tokens, singleton runtime, ccipRemoteChainId, ccipRemoteChainSelector, ccipRouter and reciprocal default-peer predictions. A merely approved alternative deployer is not proof of cross-chain compatibility.', 'Explorer/Sourcify source verification for helper, each vault, Sticky suite and distributor using the exact compiler input and metadata settings.', 'Published V6 SDK registry/artifact update for executed chains only, then pin that SDK release in Homerun and re-run onchain wiring/transaction smoke checks.'],
    blockers,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('This offline evidence script accepts no wallet, address, broadcast, or network options.')
  const manifest = await prepareIncomeRelease()
  process.stdout.write(`${JSON.stringify(manifest, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`)
}
