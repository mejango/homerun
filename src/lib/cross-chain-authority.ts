import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  MAX_SAFE_OWNERS,
  readBoundedSafeMasterCopy,
  readBoundedSafeModules,
  readBoundedSafeOwners,
  readBoundedSafeThreshold,
  readBoundedSafeVersion,
} from '@/lib/safe-reads'

export { MAX_SAFE_OWNERS, SAFE_OWNERS_READ_GAS } from '@/lib/safe-reads'

const SAFE_MODULES_SENTINEL =
  '0x0000000000000000000000000000000000000001' as Address
const SAFE_SINGLETON_SLOT =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
const SAFE_GUARD_SLOT =
  '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8' as Hex
const SAFE_FALLBACK_HANDLER_SLOT =
  '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5' as Hex

// Canonical Safe and SafeL2 singletons used by the v1.3.0 and v1.4.1
// deployments supported by the app's same-address deployment flow.
const SUPPORTED_SAFE_SINGLETON_VERSION = new Map<string, string>([
  ['0xd9db270c1b5e3bd161e8c8503c55ceabee709552', '1.3.0'],
  ['0x3e5c63644e683549055b9be8653de26e0b4cd36e', '1.3.0'],
  ['0x41675c099f32341bf84bfc5382af534df5c7461a', '1.4.1'],
  ['0x29fcb43b46531bca003ddc8fcb67ffe91900c762', '1.4.1'],
])

const SUPPORTED_SAFE_FACTORY_VERSION = new Map<string, string>([
  ['0xa6b71e26c5e0845f74c812102ca7114b6a896ab2', '1.3.0'],
  ['0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67', '1.4.1'],
])

/**
 * Safe's canonical 1.4.1 creation calls `SafeToL2Setup.setupToL2` as `setup`'s
 * delegatecall hook. That library repoints slot zero at SafeL2 on every chain
 * except Ethereum, so one initializer produces the same address with a
 * different — but paired — singleton per chain. Rejecting the pair would
 * reject every Safe the Safe interface deploys on an L2.
 */
export const SAFE_TO_L2_SETUP_ADDRESS =
  '0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54' as Address

/** keccak256 of SafeToL2Setup's runtime, identical on every canonical chain. */
export const SAFE_TO_L2_SETUP_CODE_HASH =
  '0x2f25df28caf984366ee584e13241707e85dcd5a6ea0c14267928dafc1fd6274b' as Hex

/**
 * Safe's vanity `paymentReceiver` marker. It stays inert because the accepted
 * initializer subset still requires a zero `payment`.
 */
export const SAFE_CANONICAL_PAYMENT_RECEIVER =
  '0x5afe7a11e7000000000000000000000000000000' as Address

/** Ethereum singleton to its SafeL2 counterpart, per supported release. */
export const SAFE_L1_L2_SINGLETON_PAIRS = [
  [
    '0x41675C099F32341bf84BFc5382aF534df5C7461a',
    '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  ],
] as const satisfies readonly (readonly [Address, Address])[]

export const safeToL2SetupAbi = [
  {
    type: 'function',
    name: 'setupToL2',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'l2Singleton', type: 'address' }],
    outputs: [],
  },
] as const

/** The SafeL2 singleton `SafeToL2Setup` may install for `singleton`, if any. */
function pairedSafeL2Singleton(singleton: Address): Address | null {
  const pair = SAFE_L1_L2_SINGLETON_PAIRS.find(([l1]) =>
    isAddressEqual(l1, singleton),
  )
  return pair ? getAddress(pair[1]) : null
}

/**
 * True when two singletons describe one supported release: the same address,
 * or its exact Ethereum/SafeL2 pair. Both halves stay allow-listed elsewhere.
 */
export function safeSingletonsAreEquivalent(
  left: Address,
  right: Address,
): boolean {
  if (isAddressEqual(left, right)) return true
  return SAFE_L1_L2_SINGLETON_PAIRS.some(
    ([l1, l2]) =>
      (isAddressEqual(l1, left) && isAddressEqual(l2, right)) ||
      (isAddressEqual(l1, right) && isAddressEqual(l2, left)),
  )
}

/**
 * Byte-exact `setupToL2(l2Singleton)` naming the SafeL2 counterpart of the
 * initializer's own singleton. Nothing else may be delegatecalled at setup.
 */
function isExactSetupToL2Call(data: Hex, singleton: Address): boolean {
  const l2Singleton = pairedSafeL2Singleton(singleton)
  if (!l2Singleton) return false
  const expected = encodeFunctionData({
    abi: safeToL2SetupAbi,
    functionName: 'setupToL2',
    args: [l2Singleton],
  })
  return data.toLowerCase() === expected.toLowerCase()
}

/** True when this initializer delegatecalls the canonical SafeToL2Setup. */
export function initializerUsesSafeToL2Setup(initializer: Hex): boolean {
  try {
    const decoded = decodeFunctionData({ abi: safeSetupAbi, data: initializer })
    return (
      decoded.functionName === 'setup' &&
      isAddressEqual(decoded.args[2] as Address, SAFE_TO_L2_SETUP_ADDRESS)
    )
  } catch {
    return false
  }
}

export const safeSetupAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const

// keccak256(runtime bytecode) of SafeProxy returned by proxyCreationCode() on
// the canonical v1.3.0 and v1.4.1 Safe proxy factories. Checking this before
// trusting slot zero prevents an arbitrary contract which merely imitates the
// Safe owner API from being classified as a Safe.
const SUPPORTED_SAFE_PROXY_CODE_HASHES = new Set<string>([
  '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000',
  '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c',
])

type SafeAuthorityIdentity = {
  kind: 'safe'
  owners: Address[]
  threshold: number
  ownersAreEoas: boolean
  hasModules: boolean
  proxyCodeHash: Hex
  singleton: Address
  singletonCodeHash: Hex
  version: string
  guard: Address
  fallbackHandler: Address
  fallbackHandlerCodeHash: Hex | null
}

export type AuthorityIdentity =
  | { kind: 'eoa' }
  | { kind: 'delegated-eoa'; delegation: Address }
  | { kind: 'contract' }
  | SafeAuthorityIdentity

export type SafeCreationIdentity = {
  factory: Address
  singleton: Address
  initializer: Hex
  saltNonce: bigint
}

function storageAddress(word: Hex | undefined): Address | null {
  if (!word || !/^0x0{24}[0-9a-f]{40}$/i.test(word)) return null
  try {
    return getAddress(`0x${word.slice(-40)}`)
  } catch {
    return null
  }
}

function normalizedOwners(owners: readonly Address[]): Address[] | null {
  try {
    const normalized = owners.map(getAddress)
    if (
      normalized.length === 0 ||
      normalized.length > MAX_SAFE_OWNERS ||
      normalized.some(owner => isAddressEqual(owner, zeroAddress)) ||
      new Set(normalized.map(owner => owner.toLowerCase())).size !==
        normalized.length
    ) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function ownerSetsMatch(
  left: readonly Address[],
  right: readonly Address[],
): boolean {
  const leftOwners = [...new Set(left.map(owner => owner.toLowerCase()))].sort()
  const rightOwners = [
    ...new Set(right.map(owner => owner.toLowerCase())),
  ].sort()
  return (
    leftOwners.length === left.length &&
    rightOwners.length === right.length &&
    leftOwners.length === rightOwners.length &&
    leftOwners.every((owner, index) => owner === rightOwners[index])
  )
}

/** The narrow source-Safe policy eligible for deterministic mainnet replay. */
export function isDeployableSafeAuthority(
  identity: AuthorityIdentity,
): identity is SafeAuthorityIdentity {
  return (
    identity.kind === 'safe' &&
    identity.ownersAreEoas &&
    !identity.hasModules &&
    isAddressEqual(identity.guard, zeroAddress)
  )
}

/**
 * Prove before sending that Safe's original setup still represents the live
 * project-chain policy. Delegate setup calls, payments, unknown factory/
 * singleton pairs, and rotated owners are deliberately not replayed.
 */
export function safeCreationMatchesAuthorityIdentity(
  creation: SafeCreationIdentity,
  identity: AuthorityIdentity,
): boolean {
  if (!isDeployableSafeAuthority(identity) || creation.saltNonce < 0n) {
    return false
  }
  const factoryVersion = SUPPORTED_SAFE_FACTORY_VERSION.get(
    creation.factory.toLowerCase(),
  )
  const singletonVersion = SUPPORTED_SAFE_SINGLETON_VERSION.get(
    creation.singleton.toLowerCase(),
  )
  if (
    !factoryVersion ||
    factoryVersion !== singletonVersion ||
    singletonVersion !== identity.version ||
    !safeSingletonsAreEquivalent(creation.singleton, identity.singleton)
  ) {
    return false
  }

  try {
    const decoded = decodeFunctionData({
      abi: safeSetupAbi,
      data: creation.initializer,
    })
    if (decoded.functionName !== 'setup') return false
    const [rawOwners, thresholdRaw, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] =
      decoded.args
    const owners = normalizedOwners(rawOwners)
    const threshold = Number(thresholdRaw)
    return (
      !!owners &&
      Number.isSafeInteger(threshold) &&
      threshold > 0 &&
      threshold <= owners.length &&
      threshold === identity.threshold &&
      ownerSetsMatch(owners, identity.owners) &&
      // The only accepted delegatecall hook is the canonical SafeToL2Setup
      // installing this release's own SafeL2 counterpart.
      (isAddressEqual(to, SAFE_TO_L2_SETUP_ADDRESS)
        ? isExactSetupToL2Call(data, creation.singleton)
        : isAddressEqual(to, zeroAddress) && data === '0x') &&
      isAddressEqual(fallbackHandler, identity.fallbackHandler) &&
      isAddressEqual(paymentToken, zeroAddress) &&
      payment === 0n &&
      (isAddressEqual(paymentReceiver, zeroAddress) ||
        isAddressEqual(paymentReceiver, SAFE_CANONICAL_PAYMENT_RECEIVER))
    )
  } catch {
    return false
  }
}

async function bytecodeOf(
  client: PublicClient,
  address: Address,
): Promise<Hex | undefined | null> {
  try {
    return await client.getBytecode({ address })
  } catch {
    return null
  }
}

/**
 * EIP-7702 leaves authority with the EOA key while installing the exact
 * 23-byte delegation designator `0xef0100 || address` as account code. Keep
 * this exact: a normal contract which merely starts with the prefix is not an
 * EOA and must continue through the fail-closed contract path.
 */
function eip7702Delegation(code: Hex | undefined | null): Address | null {
  if (!code || !/^0xef0100[0-9a-f]{40}$/iu.test(code)) return null
  try {
    return getAddress(`0x${code.slice(8).toLowerCase()}`)
  } catch {
    return null
  }
}

export function isEip7702DelegatedEoaRuntime(
  code: Hex | undefined | null,
): boolean {
  return eip7702Delegation(code) !== null
}

function isEoaRuntime(code: Hex | undefined | null): boolean {
  return !code || code === '0x' || isEip7702DelegatedEoaRuntime(code)
}

function isEoaAuthority(
  identity: AuthorityIdentity,
): identity is Extract<
  AuthorityIdentity,
  { kind: 'eoa' | 'delegated-eoa' }
> {
  return identity.kind === 'eoa' || identity.kind === 'delegated-eoa'
}

/**
 * Classify an authority from live bytecode. A contract is recognized as a
 * supported Safe only when it is a canonical SafeProxy pointing at a known
 * official singleton and all policy/storage reads succeed. RPC failures are
 * unknown (`null`), never evidence that the address is an EOA or Safe.
 */
export async function readAuthorityIdentity(
  client: PublicClient,
  authority: Address,
): Promise<AuthorityIdentity | null> {
  const code = await bytecodeOf(client, authority)
  if (code === null) return null
  if (!code || code === '0x') return { kind: 'eoa' }
  const delegation = eip7702Delegation(code)
  if (delegation) return { kind: 'delegated-eoa', delegation }
  // A provider should return Hex, but malformed or odd-length bytecode must
  // still fail closed instead of reaching keccak256 and escaping classification.
  if (!/^0x(?:[0-9a-f]{2})+$/iu.test(code)) return { kind: 'contract' }

  const proxyCodeHash = keccak256(code)
  if (!SUPPORTED_SAFE_PROXY_CODE_HASHES.has(proxyCodeHash.toLowerCase())) {
    return { kind: 'contract' }
  }

  let singletonWord: Hex | undefined
  try {
    singletonWord = await client.getStorageAt({
      address: authority,
      slot: SAFE_SINGLETON_SLOT,
    })
  } catch {
    return null
  }
  const singleton = storageAddress(singletonWord)
  if (
    !singleton ||
    !SUPPORTED_SAFE_SINGLETON_VERSION.has(singleton.toLowerCase())
  ) {
    return { kind: 'contract' }
  }
  const singletonCode = await bytecodeOf(client, singleton)
  if (singletonCode === null) return null
  if (!singletonCode || singletonCode === '0x') return { kind: 'contract' }
  let masterCopy: Address | null
  try {
    masterCopy = await readBoundedSafeMasterCopy(client, authority)
  } catch {
    return null
  }
  if (!masterCopy || !isAddressEqual(masterCopy, singleton)) {
    return { kind: 'contract' }
  }

  // Only after slot zero names a supported, deployed singleton may any call
  // delegate through the proxy. Every such read is a raw, gas/returndata-
  // bounded eth_call, so OffchainLookup can never trigger a fetch.
  let thresholdRaw: bigint | null
  let rawOwners: readonly Address[] | null
  let modulePage: readonly [readonly Address[], Address] | null
  let version: string | null
  let guardWord: Hex | undefined
  let fallbackHandlerWord: Hex | undefined
  try {
    ;[
      thresholdRaw,
      rawOwners,
      modulePage,
      version,
      guardWord,
      fallbackHandlerWord,
    ] = await Promise.all([
      readBoundedSafeThreshold(client, authority),
      readBoundedSafeOwners(client, authority),
      readBoundedSafeModules(client, authority, SAFE_MODULES_SENTINEL),
      readBoundedSafeVersion(client, authority),
      client.getStorageAt({ address: authority, slot: SAFE_GUARD_SLOT }),
      client.getStorageAt({
        address: authority,
        slot: SAFE_FALLBACK_HANDLER_SLOT,
      }),
    ])
  } catch {
    return null
  }

  const owners = rawOwners ? normalizedOwners(rawOwners) : null
  const threshold = thresholdRaw === null ? NaN : Number(thresholdRaw)
  const guard = storageAddress(guardWord)
  const fallbackHandler = storageAddress(fallbackHandlerWord)
  if (
    !owners ||
    !modulePage ||
    !version ||
    !Number.isSafeInteger(threshold) ||
    threshold <= 0 ||
    threshold > owners.length ||
    !guard ||
    !fallbackHandler
  ) {
    return { kind: 'contract' }
  }

  const supportedVersion = SUPPORTED_SAFE_SINGLETON_VERSION.get(singleton.toLowerCase())
  if (
    !supportedVersion ||
    version !== supportedVersion
  ) {
    return { kind: 'contract' }
  }

  const addressesToRead = [...owners]
  if (!isAddressEqual(fallbackHandler, zeroAddress)) {
    addressesToRead.push(fallbackHandler)
  }
  const bytecodes = await Promise.all(
    addressesToRead.map(address => bytecodeOf(client, address)),
  )
  if (bytecodes.some(bytecode => bytecode === null)) return null

  const ownerCodes = bytecodes.slice(0, owners.length)
  const ownersAreEoas = ownerCodes.every(isEoaRuntime)
  const fallbackHandlerCode = isAddressEqual(fallbackHandler, zeroAddress)
    ? null
    : bytecodes.at(-1)
  if (
    !isAddressEqual(fallbackHandler, zeroAddress) &&
    (!fallbackHandlerCode ||
      fallbackHandlerCode === '0x' ||
      isEip7702DelegatedEoaRuntime(fallbackHandlerCode))
  ) {
    // A Safe owner only needs the same EOA key on both chains, so an exact
    // EIP-7702 designator is safe in the owner list. A fallback handler is
    // executable policy: calls follow its delegation target, whose runtime
    // can differ by chain even when the 23-byte marker is identical. Reject
    // that indirection instead of certifying a marker hash as equal behavior.
    return { kind: 'contract' }
  }

  const [modules, next] = modulePage
  return {
    kind: 'safe',
    owners,
    threshold,
    ownersAreEoas,
    hasModules:
      modules.length > 0 || !isAddressEqual(next, SAFE_MODULES_SENTINEL),
    proxyCodeHash,
    singleton,
    singletonCodeHash: keccak256(singletonCode),
    version,
    guard,
    fallbackHandler,
    fallbackHandlerCodeHash: fallbackHandlerCode
      ? keccak256(fallbackHandlerCode)
      : null,
  }
}

/**
 * Cross-chain handle claims support only EOAs or canonical, module-free Safes
 * with EOA signers and the exact same implementation and execution policy.
 */
export function authorityIdentitiesMatch(
  source: AuthorityIdentity,
  destination: AuthorityIdentity,
): boolean {
  const sourceIsEoa = isEoaAuthority(source)
  const destinationIsEoa = isEoaAuthority(destination)
  if (sourceIsEoa || destinationIsEoa) {
    return sourceIsEoa && destinationIsEoa
  }
  if (source.kind !== 'safe' || destination.kind !== 'safe') return false
  if (
    source.hasModules ||
    destination.hasModules ||
    !source.ownersAreEoas ||
    !destination.ownersAreEoas ||
    !isAddressEqual(source.guard, zeroAddress) ||
    !isAddressEqual(destination.guard, zeroAddress) ||
    source.threshold !== destination.threshold ||
    source.proxyCodeHash.toLowerCase() !==
      destination.proxyCodeHash.toLowerCase() ||
    !safeSingletonsAreEquivalent(source.singleton, destination.singleton) ||
    // Paired Ethereum/SafeL2 singletons are distinct implementations of one
    // release, so their runtimes only have to match when the address does.
    (isAddressEqual(source.singleton, destination.singleton) &&
      source.singletonCodeHash.toLowerCase() !==
        destination.singletonCodeHash.toLowerCase()) ||
    source.version !== destination.version ||
    !isAddressEqual(source.fallbackHandler, destination.fallbackHandler) ||
    source.fallbackHandlerCodeHash?.toLowerCase() !==
      destination.fallbackHandlerCodeHash?.toLowerCase()
  ) {
    return false
  }
  return ownerSetsMatch(source.owners, destination.owners)
}

export async function readMatchingAuthorityIdentities({
  sourceClient,
  destinationClient,
  authority,
}: {
  sourceClient: PublicClient
  destinationClient: PublicClient
  authority: Address
}): Promise<{
  source: AuthorityIdentity
  destination: AuthorityIdentity
  matches: boolean
} | null> {
  const [source, destination] = await Promise.all([
    readAuthorityIdentity(sourceClient, authority),
    readAuthorityIdentity(destinationClient, authority),
  ])
  if (!source || !destination) return null
  return {
    source,
    destination,
    matches: authorityIdentitiesMatch(source, destination),
  }
}
