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
export const incomeReleasePolicy = {
  profile: 'homerun-deployer-global-v4-candidate',
  helperSaltText: 'homerun.deployer.global.v4',
  splitLockedUntil: '0',
  roles: { controlWallet: 'FUND owner; the signer becomes the stock Revnet operator and holds the whole unlocked reserved split' },
  economics: { fundWeight: '10,000 per USD', fundCashOutTaxBps: 1000, incomeInitialIssuance: '10 per USD', incomeCutPercentPerQuarter: 2, incomeCashOutTaxBps: 1000, stages: 1 },
  shop: { currency: 2, decimals: 6, ownerCanAdjustTiers: true, ownerCanUpdateCollectionMetadata: false, ownerCanMint: false, ownerCanIncreaseDiscountPercent: false, newTiersWithReserves: false, newTiersWithVotes: false, newTiersWithOwnerMinting: false },
} as const
const profile = incomeReleasePolicy.profile
const chainIds = [1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420] as const
const linkedGroups = { mainnet: [1, 10, 8453, 42161], testnet: [84532, 421614, 11155111, 11155420] }
const deterministicFactory = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const
const helperSaltText = incomeReleasePolicy.helperSaltText
const helperSalt = keccak256(toHex(helperSaltText))
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
  { name: 'HomerunDeployer', location: 'out', sourceRoot: root, metadataHash: 'ipfs', constructor: ['chains:tuple[](chainId:uint32,revDeployer:address,usdc:address,omnichainDeployer:address,allowlistHook:address)'] },
  { name: 'HomerunAllowlistHook', location: 'out', sourceRoot: root, metadataHash: 'ipfs', constructor: ['projects:address', 'trustedForwarder:address'] },
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
  const linkedLibraries = [artifact.bytecode.linkReferences, artifact.deployedBytecode.linkReferences].flatMap(references => Object.values(references ?? {}).flatMap(file => Object.keys(file)))
  if (!/^0x(?:[\da-f]{2})+$/i.test(artifact.bytecode.object) || !/^0x(?:[\da-f]{2})+$/i.test(artifact.deployedBytecode.object) || linkedLibraries.length) throw new Error(`${spec.name}: executable bytecode is missing or links a library the reviewed profile does not expect.`)
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
      linkedLibraries,
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

/** Deliberately narrow source checks supplement exact artifact fingerprints, not formal verification. */
export function assertIncomeReleaseSource(helperSource: string) {
  const normalized = helperSource.replace(/\s+/g, ' ')
  const sourceAssertions = [
    'constructor(HomerunChainConfig[] memory chains)',
    'CONTROLLER = REV_DEPLOYER.CONTROLLER();', 'ROUTER_TERMINAL_REGISTRY = REV_DEPLOYER.ROUTER_TERMINAL_REGISTRY();',
    'if (!isFund[fundProjectId]) revert HomerunDeployer_UnsupportedFund(fundProjectId);',
    'if (PROJECTS.ownerOf(fundProjectId) != _msgSender()) revert HomerunDeployer_Unauthorized(_msgSender());',
    'configuration.operator = _msgSender();',
    'uint112 public constant override FUND_WEIGHT = 10_000e18;', 'uint16 public constant override FUND_CASH_OUT_TAX_RATE = 1000;',
    'uint112 public constant override INCOME_INITIAL_ISSUANCE = 10e18;', 'uint32 public constant override INCOME_CUT_PERCENT = 20_000_000;', 'uint16 public constant override INCOME_CASH_OUT_TAX_RATE = 1000;',
    'suckerDeploymentConfiguration.salt = scopedSalt;', 'keccak256(abi.encode(_msgSender(), owner, salt))', 'originalPayer = JBPayerTrackerLib.resolve(_msgSender());', 'beneficiary: payable(_msgSender()),',
    'configuration.stageConfigurations = new REVStageConfig[](1);',
    'token = address(CONTROLLER.deployERC20For({projectId: projectId, name: name, symbol: ticker, salt: scopedSalt}));',
    'rulesetConfigurations[0].metadata.dataHook = address(ALLOWLIST_HOOK);', 'rulesetConfigurations[0].metadata.useDataHookForPay = true;',
    'configuration.scopeCashOutsToLocalBalances = false;',
    'tiered721HookConfiguration.baseline721HookConfiguration.tiersConfig.currency = JBCurrencyIds.USD;',
    'tiered721HookConfiguration.baseline721HookConfiguration.tiersConfig.decimals = _USDC_DECIMALS;',
    'tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithReserves = true;',
    'tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithVotes = true;',
    'tiered721HookConfiguration.baseline721HookConfiguration.flags.noNewTiersWithOwnerMinting = true;',
    'tiered721HookConfiguration.preventOperatorAdjustingTiers = false;',
    'tiered721HookConfiguration.preventOperatorUpdatingMetadata = true;',
    'tiered721HookConfiguration.preventOperatorMinting = true;',
    'tiered721HookConfiguration.preventOperatorIncreasingDiscountPercent = true;',
    'totalIncome != INITIAL_INCOME_SUPPLY', 'extraMetadata: _INCOME_STAGE_EXTRA_METADATA', 'count: snapshot.allocations[i].incomeAmount, beneficiary: address(this)', 'address owner = PROJECTS.ownerOf(fundProjectId);',
  ]
  const splitLocks = [...normalized.matchAll(/\blockedUntil\s*:\s*([^,}]+)/g)]
  if (sourceAssertions.some(expected => !normalized.includes(expected)) || splitLocks.length !== 1 || splitLocks.some(match => match[1].trim() !== incomeReleasePolicy.splitLockedUntil)
) {
    throw new Error('The source no longer matches the global release profile. Review the changed semantics before regenerating release evidence.')
  }
  return sourceAssertions
}

export async function prepareIncomeRelease() {
  const blockers = ['No executed helper deployment receipts or per-chain runtime/immutable verification are established by this offline packet.', 'The new helper source must be frozen with its reviewed compiler inputs before a production release.']
  const helperSource = await readFile(resolve(root, 'src/HomerunDeployer.sol'), 'utf8')
  const sourceAssertions = assertIncomeReleaseSource(helperSource)
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
  const required = ['JBController', 'JBDirectory', 'JBProjects', 'JBTokens', 'JBMultiTerminal', 'JBRouterTerminalRegistry', 'JBSuckerRegistry', 'JBOmnichainDeployer', 'REVDeployer', 'REVOwner', 'REVLoans', 'USDC', 'HomerunAllowlistHook', 'HomerunDeployer']
  const networks = chainIds.map(chainId => {
    const addresses = Object.fromEntries(required.map(name => [name, registered(name, chainId)]))
    const missingRegistryEntries = required.filter(name => !addresses[name])
    if (missingRegistryEntries.length) blockers.push(`Chain ${chainId}: missing SDK registry entries ${missingRegistryEntries.join(', ')}.`)
    return {
      chainId, addresses, missingRegistryEntries, addressEvidence: 'installed SDK registry; no live RPC performed',
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
    chainId, revDeployer: addresses.REVDeployer, usdc: addresses.USDC,
    omnichainDeployer: addresses.JBOmnichainDeployer, allowlistHook: addresses.HomerunAllowlistHook,
  }))
  if (chainConfiguration.some((entry, index) => index > 0 && entry.chainId <= chainConfiguration[index - 1].chainId)) throw new Error('The shared helper constructor must contain strictly increasing chain IDs.')
  const helperArtifact = byName.get('HomerunDeployer')
  const helperConstructor = constructorPlan(helperArtifact, [chainConfiguration], 64 + 160 * chainIds.length)
  const helperPredictedAddress = helperConstructor.initCodeKeccak256 ? getCreate2Address({ from: deterministicFactory, salt: helperSalt, bytecodeHash: helperConstructor.initCodeKeccak256 }) : null
  if (helperPredictedAddress && networks.some(network => network.addresses.HomerunDeployer && network.addresses.HomerunDeployer !== helperPredictedAddress)) blockers.push('A registered helper differs from the address implied by the reviewed shared constructor, artifact and salt.')
  const sdkPackage = await readFile(resolve(root, 'node_modules/@bananapus/nana-sdk-core/package.json'))
  return {
    format: 'homerun-income-release-manifest/v3', profile, releaseReady: false, deploymentAuthorized: false,
    supersedesProfile: 'homerun-income-global-stock-sticky-v3-candidate',
    fundLaunch: { entrypoint: 'launchFundFor(owner,projectUri,name,ticker,mustStartAtOrAfter,salt,peerSuckerDeployers)', rules: incomeReleasePolicy.economics, terminals: ['JBMultiTerminal USDC context', 'JBRouterTerminalRegistry with no contexts'], tokenDeployedAtLaunch: true, payHook: 'HomerunAllowlistHook as the omnichain extra pay hook; owner-managed beneficiary allowlist, closed by default; cash outs ungated', identity: 'isFund(projectId) + FundLaunched event' },
    capturedAt: new Date().toISOString(), liveRpcCalls: 0, walletCalls: 0,
    helperSourceKeccak256: keccak256(toHex(helperSource)),
    profileChecks: { recursiveConstructorShape: true, sourceAssertions, sourceAssertionsAreFormalVerification: false, metadataHash: { Homerun: 'ipfs' }, fullInitcodeIncludesConstructor: true },
    semantics: {
      roles: incomeReleasePolicy.roles, shop: incomeReleasePolicy.shop,
      initialIncomeSupply: '500000000000000000000000', allocationScope: 'one global allocation; each chain\'s share is recorded for the owner on that chain',
      sourceSetHash: 'keccak256 of canonical full global snapshot report',
      allocationAuthority: 'FUND-owner-attested published manifest; each chain\'s share is a stock revnet auto-issuance to the helper that anyone mints to the current FUND owner, who settles it offchain; no claim contract, root or proof',
      deployment: 'stock asynchronous cross-chain deployment; each chain records its allocation at launch and anyone mints it to the current FUND owner once the shared stage starts',
      revnet: { initialIssuance: '10000000000000000000', quarterSeconds: 7_884_000, cutPercent: 20_000_000, cutsForever: true, stages: 1, cashOutTaxRate: 1000, splitPercent: 'caller-supplied reservedBps (0..10000)', splits: 'one unlocked split, 100% to the FUND owner', splitLockedUntil: incomeReleasePolicy.splitLockedUntil, extraMetadata: 4, scopeCashOutsToLocalBalances: false, ticker: 'caller-supplied' },
      ongoingRewards: { status: 'deferred; the owner redirects the reserved split once Sticky or other recipients exist' },
    },
    sdk: { version: JSON.parse(sdkPackage.toString()).version, packageSha256: sha256(sdkPackage), lockfileSha256: sha256(await readFile(resolve(root, 'package-lock.json'))) },
    repositories: [repository('homerun', root), repository('core-v6', resolve(workspace, 'nana-core-v6')), repository('revnet-v6', resolve(workspace, 'revnet-core-v6')), repository('suckers-v6', resolve(workspace, 'nana-suckers-v6')), repository('omnichain-deployers-v6', resolve(workspace, 'nana-omnichain-deployers-v6')), repository('router-terminal-v6', resolve(workspace, 'nana-router-terminal-v6'))],
    artifacts: collected.map(entry => entry.result?.summary ?? { name: entry.name, artifact: entry.artifact, artifactSha256: entry.artifactSha256, status: 'unavailable-or-invalid', issue: entry.issue }),
    sharedHelper: {
      factory: deterministicFactory, factoryEvidence: 'canonical source constant; live factory code not checked by this script',
      saltDerivation: `keccak256(UTF8(${JSON.stringify(helperSaltText)}))`, salt: helperSalt, saltStatus: 'prepared release constant; not a deployment record',
      chainIds, linkedGroups, constructor: helperConstructor, predictedAddress: helperPredictedAddress,
      addressStatus: helperPredictedAddress ? 'deterministic prediction only; requires executed receipt and runtime verification' : 'unavailable until actual registered dependency inputs exist',
      runtimePolicy: 'same initcode/address across chains, which commits to the shared chain configuration; local immutable dependencies can make deployed runtime hashes different',
    },
    networks,
    requiredPostDeploymentEvidence: ['Executed deployment receipts with chain/block/transaction identity, identical shared helper constructor inputs, factory and salt.', 'Full executable-runtime and every immutable-word verification against the exact reviewed artifacts on each chain; template hashes above are not live runtime hashes. Verify CONTROLLER, TERMINAL, ROUTER_TERMINAL_REGISTRY and every usdcOf entry.', 'Verify the FUND owner becomes the INCOME operator and holds one unlocked reserved split, and the Owner-managed stock 721 inventory with the reviewed USD denomination and restricted tier flags.', 'For every directed SDK CCIP route, verify registry allowlisting, directory/tokens, singleton runtime, ccipRemoteChainId, ccipRemoteChainSelector, ccipRouter and reciprocal default-peer predictions. A merely approved alternative deployer is not proof of cross-chain compatibility.', 'Explorer/Sourcify source verification for the helper using the exact compiler input and metadata settings.', 'Published V6 SDK registry/artifact update for executed chains only, then pin that SDK release in Homerun and re-run onchain wiring/transaction smoke checks.'],
    blockers,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('This offline evidence script accepts no wallet, address, broadcast, or network options.')
  const manifest = await prepareIncomeRelease()
  process.stdout.write(`${JSON.stringify(manifest, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`)
}
