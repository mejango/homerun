import { createPublicClient, custom, concatHex, decodeFunctionResult, decodeFunctionData, encodeFunctionData, encodePacked, getAddress, getContractAddress, isAddress, isAddressEqual, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { CreateValues } from '@/components/CreateFlow'
import type { FundTransaction } from './fund-contracts'
import type { RelayrEntry } from './relayr'
import { readAuthorityIdentity } from './cross-chain-authority'

// Canonical Safe 1.4.1 deployments and runtime hashes from safe-global/safe-deployments.
// Keep the same singleton/initializer on every chain for identical CREATE2 addresses.
export const SAFE_FACTORY = getAddress('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67')
export const SAFE_SINGLETON = getAddress('0x41675C099F32341bf84BFc5382aF534df5C7461a')
export const SAFE_FALLBACK = getAddress('0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99')
export const MULTICALL3 = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11')
const contracts = [
  [SAFE_FACTORY, '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317'],
  [SAFE_SINGLETON, '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4'],
  [SAFE_FALLBACK, '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9'],
] as const
export const SAFE_CREATE_ABI = parseAbi([
  'function proxyCreationCode() pure returns (bytes)',
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
])
export const CREATE_BATCH_ABI = parseAbi(['function aggregate3Value((address target,bool allowFailure,uint256 value,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)'])
export type CreateMultisig = { role: 'owner' | 'operator'; owners: Address[]; threshold: number; saltNonce: Hex; proxyCreationCode: Hex; address: Address }

export function multisigInitializer(plan: Pick<CreateMultisig, 'owners' | 'threshold'>): Hex {
  if (!Array.isArray(plan.owners) || plan.owners.length < 2 || plan.owners.length > 20 || plan.owners.some(owner => !isAddress(owner) || BigInt(owner) <= 1n)
    || new Set(plan.owners.map(owner => owner.toLowerCase())).size !== plan.owners.length) throw new Error('A multisig needs 2–20 unique nonzero owner addresses.')
  if (!Number.isInteger(plan.threshold) || plan.threshold < 1 || plan.threshold > plan.owners.length) throw new Error('Invalid multisig approval policy.')
  return encodeFunctionData({ abi: SAFE_CREATE_ABI, functionName: 'setup', args: [plan.owners, BigInt(plan.threshold), zeroAddress, '0x', SAFE_FALLBACK, zeroAddress, 0n, zeroAddress] })
}
export function predictMultisig(plan: Omit<CreateMultisig, 'address' | 'role'>): Address {
  if (!/^0x[\da-f]{64}$/i.test(plan.saltNonce) || !/^0x(?:[\da-f]{2}){1,2048}$/i.test(plan.proxyCreationCode)) throw new Error('Invalid multisig deployment record.')
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(multisigInitializer(plan)), BigInt(plan.saltNonce)]))
  return getContractAddress({ opcode: 'CREATE2', from: SAFE_FACTORY, salt, bytecode: concatHex([plan.proxyCreationCode, toHex(BigInt(SAFE_SINGLETON), { size: 32 })]) })
}
export function validateMultisigs(plans: readonly CreateMultisig[] = [], owner?: Address): void {
  if (!Array.isArray(plans) || plans.length > 2 || new Set(plans.map(plan => plan.role)).size !== plans.length) throw new Error('Invalid multisig deployment plan.')
  for (const plan of plans) {
    if (!['owner', 'operator'].includes(plan.role) || !isAddressEqual(predictMultisig(plan), plan.address)
      || (plan.role === 'owner' && owner && !isAddressEqual(plan.address, owner))) throw new Error('The multisig address differs from its saved owners and policy.')
  }
}
export async function readMultisigCreationCode(client: PublicClient): Promise<Hex> {
  await Promise.all(contracts.map(async ([address, hash]) => {
    const code = await client.getCode({ address })
    if (!code || keccak256(code) !== hash) throw new Error(`The canonical Safe 1.4.1 contract is unavailable at ${address}.`)
  }))
  const batchCode = await client.getCode({ address: MULTICALL3 })
  if (!batchCode || batchCode === '0x') throw new Error('Multicall3 is unavailable on this network.')
  return client.readContract({ address: SAFE_FACTORY, abi: SAFE_CREATE_ABI, functionName: 'proxyCreationCode' })
}
export async function resolveCreateMultisigs(values: CreateValues, clients: PublicClient[], salt: Hex) {
  const plans: CreateMultisig[] = []
  const needed = values.ownerMode === 'create' || (!values.ownerIsOperator && values.operatorMode === 'create')
  const codes = needed ? await Promise.all(clients.map(readMultisigCreationCode)) : []
  if (codes.some(code => code !== codes[0])) throw new Error('Safe creation code differs across the selected networks.')
  const resolve = (role: 'owner' | 'operator') => {
    if (values[`${role}Mode`] !== 'create') {
      const address = values[`${role}Wallet`].trim()
      if (!isAddress(address) || BigInt(address) <= 1n) throw new Error(`Enter a valid ${role} address.`)
      return getAddress(address)
    }
    const policy = { owners: (values[`${role}Signers`] ?? []).map(address => getAddress(address)), threshold: values[`${role}Threshold`]!,
      saltNonce: keccak256(encodePacked(['bytes32', 'string'], [salt, role])), proxyCreationCode: codes[0] }
    const address = predictMultisig(policy)
    plans.push({ ...policy, role, address })
    return address
  }
  const owner = resolve('owner')
  const operator = values.ownerIsOperator ? owner : resolve('operator')
  return { owner, operator, plans, values: { ...values, ownerWallet: owner, operatorWallet: operator } }
}

/** Reused deployments must still have exactly the reviewed policy, with no modules or guard. */
export async function verifyCreatedMultisigs(client: PublicClient, plans: readonly CreateMultisig[], allowMissing = false, blockNumber?: bigint): Promise<boolean> {
  // Receipt recovery checks the policy at execution, even if the owners have since updated it.
  // Pin the raw RPC transport too: bounded Safe reads use eth_call directly.
  const reader = blockNumber === undefined ? client : createPublicClient({
    transport: custom({ request: ({ method, params }) => {
      const at = Array.isArray(params) && ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(method)
        ? [...params.slice(0, -1), toHex(blockNumber)] : params
      return client.request({ method, params: at } as Parameters<PublicClient['request']>[0])
    } }),
  }) as PublicClient
  let complete = true
  for (const plan of plans) {
    const identity = await readAuthorityIdentity(reader, plan.address)
    if (allowMissing && identity?.kind === 'eoa') { complete = false; continue }
    if (identity?.kind !== 'safe' || !isAddressEqual(identity.singleton, SAFE_SINGLETON) || identity.threshold !== plan.threshold
      || identity.hasModules || identity.guard !== zeroAddress || !isAddressEqual(identity.fallbackHandler, SAFE_FALLBACK)
      || identity.owners.length !== plan.owners.length || plan.owners.some(owner => !identity.owners.some(actual => isAddressEqual(actual, owner)))) throw new Error(`The ${plan.role} multisig does not match its reviewed owners and policy.`)
  }
  return complete
}
export async function checkCreateMultisigs(client: PublicClient, plans: readonly CreateMultisig[] = []): Promise<void> {
  if (!plans.length) return
  validateMultisigs(plans)
  const code = await readMultisigCreationCode(client)
  if (plans.some(plan => plan.proxyCreationCode !== code)) throw new Error('The saved Safe creation code changed.')
  await verifyCreatedMultisigs(client, plans, true)
}
export function multisigDeploymentCalls(plans: readonly CreateMultisig[]) {
  validateMultisigs(plans)
  // CREATE2 makes this idempotent when someone has already deployed the exact initializer.
  // A failed factory call never substitutes a different owner; preflight and receipts verify the policy.
  return plans.map(plan => ({ target: SAFE_FACTORY, allowFailure: true, value: 0n, callData: encodeFunctionData({ abi: SAFE_CREATE_ABI,
    functionName: 'createProxyWithNonce', args: [SAFE_SINGLETON, multisigInitializer(plan), BigInt(plan.saltNonce)] }) }))
}
export function multisigDeploymentRequest(chainId: number, plans: readonly CreateMultisig[]): FundTransaction {
  return { chainId, address: MULTICALL3, abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [multisigDeploymentCalls(plans)], value: 0n }
}
export function bundleMultisigLaunch(entry: RelayrEntry, plans: readonly CreateMultisig[] = []): RelayrEntry {
  if (!plans.length) return entry
  const calls = [...multisigDeploymentCalls(plans), { target: entry.target, allowFailure: false, value: BigInt(entry.value), callData: entry.data }]
  return { ...entry, target: MULTICALL3, data: encodeFunctionData({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [calls] }) }
}
export function unbundleMultisigLaunch(entry: RelayrEntry, plans: readonly CreateMultisig[] = []): RelayrEntry {
  if (!plans.length) return entry
  if (!isAddressEqual(entry.target, MULTICALL3)) throw new Error('The saved multisig launch is not a creation batch.')
  const { args } = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: entry.data })
  const last = args[0].at(-1)
  if (!last) throw new Error('The saved creation batch is empty.')
  const inner = { ...entry, target: last.target, data: last.callData }
  if (bundleMultisigLaunch(inner, plans).data.toLowerCase() !== entry.data.toLowerCase()) throw new Error('The saved creation batch differs from its reviewed multisigs and launch.')
  return inner
}
export function multisigReview(plans: readonly CreateMultisig[] = []): string {
  return plans.map(plan => `${plan.role === 'owner' ? 'Owner' : 'Operator'}: create Safe ${plan.address}, ${plan.threshold}/${plan.owners.length} approvals. Owners: ${plan.owners.join(', ')}.`).join('\n')
}

/** A successful outer simulation must also prove each optional factory call created its intended Safe. */
export async function verifyMultisigLaunchSimulation(client: PublicClient, plans: readonly CreateMultisig[] = [], data?: Hex): Promise<void> {
  if (!plans.length) return
  if (!data) throw new Error('The multisig creation simulation returned no results.')
  const results = decodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', data })
  if (results.length !== plans.length + 1 || !results.at(-1)?.success) throw new Error('The creation batch did not simulate every required call.')
  for (const [index, plan] of plans.entries()) {
    const result = results[index]
    if (result.success) {
      if (result.returnData.toLowerCase() !== toHex(BigInt(plan.address), { size: 32 }).toLowerCase()) throw new Error('The simulated factory returned a different multisig address.')
    } else {
      // A duplicate CREATE2 deployment is the only accepted failure: the exact Safe must already exist.
      await verifyCreatedMultisigs(client, [plan])
    }
  }
}
