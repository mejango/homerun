import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

/** Public routes must never fan out an attacker-sized Safe owner list. */
export const MAX_SAFE_OWNERS = 50
const MAX_SAFE_MODULE_PAGE = 64
export const SAFE_SCALAR_READ_GAS = 100_000n
export const SAFE_OWNERS_READ_GAS = 400_000n
const SAFE_MODULES_READ_GAS = 500_000n

export const SAFE_READ_ABI = [
  {
    type: 'function',
    name: 'masterCopy',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'VERSION',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'getThreshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getModulesPaginated',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'address' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      { name: 'array', type: 'address[]' },
      { name: 'next', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approvedHashes',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'hash', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

async function rawBoundedCall(
  client: PublicClient,
  address: Address,
  data: Hex,
  gas: bigint,
  maxReturnBytes: number,
): Promise<Hex | null> {
  // Use JSON-RPC directly: Viem's contract/call helpers may follow
  // OffchainLookup according to the client-level CCIP policy. A Safe address
  // is untrusted until these reads finish, so it must never choose a URL the
  // server or browser fetches.
  const result = await client.request({
    method: 'eth_call',
    params: [{ to: address, data, gas: numberToHex(gas) }, 'latest'],
  })
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/iu.test(result)) {
    return null
  }
  const bytes = (result.length - 2) / 2
  return Number.isSafeInteger(bytes) && bytes <= maxReturnBytes
    ? (result as Hex)
    : null
}

async function readSafeUint(
  client: PublicClient,
  address: Address,
  functionName: 'getThreshold' | 'nonce',
): Promise<bigint | null> {
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({ abi: SAFE_READ_ABI, functionName }),
    SAFE_SCALAR_READ_GAS,
    32,
  )
  if (!data || data.length !== 66) return null
  try {
    return decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName,
      data,
    })
  } catch {
    return null
  }
}

export function readBoundedSafeThreshold(
  client: PublicClient,
  address: Address,
): Promise<bigint | null> {
  return readSafeUint(client, address, 'getThreshold')
}

export function readBoundedSafeNonce(
  client: PublicClient,
  address: Address,
): Promise<bigint | null> {
  return readSafeUint(client, address, 'nonce')
}

export async function readBoundedSafeApprovedHash(
  client: PublicClient,
  address: Address,
  owner: Address,
  hash: Hex,
): Promise<bigint | null> {
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({
      abi: SAFE_READ_ABI,
      functionName: 'approvedHashes',
      args: [owner, hash],
    }),
    SAFE_SCALAR_READ_GAS,
    32,
  )
  if (!data || data.length !== 66) return null
  try {
    return decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName: 'approvedHashes',
      data,
    })
  } catch {
    return null
  }
}

export async function readBoundedSafeOwners(
  client: PublicClient,
  address: Address,
): Promise<readonly Address[] | null> {
  const maxBytes = 64 + MAX_SAFE_OWNERS * 32
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({ abi: SAFE_READ_ABI, functionName: 'getOwners' }),
    SAFE_OWNERS_READ_GAS,
    maxBytes,
  )
  if (!data || data.length < 130) return null
  const bytes = (data.length - 2) / 2
  const offset = BigInt(`0x${data.slice(2, 66)}`)
  const count = BigInt(`0x${data.slice(66, 130)}`)
  if (
    offset !== 32n ||
    count > BigInt(MAX_SAFE_OWNERS) ||
    BigInt(bytes) !== 64n + count * 32n
  ) {
    return null
  }
  try {
    const owners = decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName: 'getOwners',
      data,
    })
    return owners.every(owner => isAddress(owner)) ? owners : null
  } catch {
    return null
  }
}

export async function readBoundedSafeMasterCopy(
  client: PublicClient,
  address: Address,
): Promise<Address | null> {
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({ abi: SAFE_READ_ABI, functionName: 'masterCopy' }),
    SAFE_SCALAR_READ_GAS,
    32,
  )
  if (!data || data.length !== 66) return null
  try {
    const value = decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName: 'masterCopy',
      data,
    })
    return isAddress(value) ? value : null
  } catch {
    return null
  }
}

export async function readBoundedSafeVersion(
  client: PublicClient,
  address: Address,
): Promise<string | null> {
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({ abi: SAFE_READ_ABI, functionName: 'VERSION' }),
    SAFE_SCALAR_READ_GAS,
    128,
  )
  if (!data || data.length < 130) return null
  try {
    const version = decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName: 'VERSION',
      data,
    })
    return version.length <= 32 ? version : null
  } catch {
    return null
  }
}

export async function readBoundedSafeModules(
  client: PublicClient,
  address: Address,
  start: Address,
): Promise<readonly [readonly Address[], Address] | null> {
  const maxBytes = 96 + MAX_SAFE_MODULE_PAGE * 32
  const data = await rawBoundedCall(
    client,
    address,
    encodeFunctionData({
      abi: SAFE_READ_ABI,
      functionName: 'getModulesPaginated',
      args: [start, BigInt(MAX_SAFE_MODULE_PAGE)],
    }),
    SAFE_MODULES_READ_GAS,
    maxBytes,
  )
  if (!data || data.length < 194) return null
  const bytes = (data.length - 2) / 2
  const offset = BigInt(`0x${data.slice(2, 66)}`)
  const count = BigInt(`0x${data.slice(130, 194)}`)
  if (
    offset !== 64n ||
    count > BigInt(MAX_SAFE_MODULE_PAGE) ||
    BigInt(bytes) !== 96n + count * 32n
  ) {
    return null
  }
  try {
    const result = decodeFunctionResult({
      abi: SAFE_READ_ABI,
      functionName: 'getModulesPaginated',
      data,
    })
    return result[0].every(module => isAddress(module)) && isAddress(result[1])
      ? result
      : null
  } catch {
    return null
  }
}
