import { encodePacked, getAddress, isAddressEqual, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import {
  MULTICALL3,
  buildSafeInitializer,
  predictSafeAddress,
  resolveSafeAddress,
  verifySafeDeployments,
  checkSafeDeployments,
  buildSafeDeploymentCalls,
  buildSafeDeploymentTx,
  bundleSafeLaunch,
  unbundleSafeLaunch,
  verifySafeLaunchSimulation,
  type SafeDeploymentPlan,
} from '@bananapus/nana-sdk-core/safe'
import type { CreateValues } from '@/components/CreateFlow'
import type { FundTransaction } from './fund-contracts'
import type { RelayrEntry } from './relayr'

export { SAFE_FACTORY, SAFE_SINGLETON, SAFE_FALLBACK, MULTICALL3, SAFE_CREATE_ABI, CREATE_BATCH_ABI } from '@bananapus/nana-sdk-core/safe'

// Keep the saved role/plan shape and role-derived salts stable across SDK upgrades.
export type CreateMultisig = SafeDeploymentPlan & { role: 'owner' | 'operator' }

export function multisigInitializer(plan: Pick<CreateMultisig, 'owners' | 'threshold'>): Hex {
  if (!Array.isArray(plan.owners) || plan.owners.length < 2 || plan.owners.length > 20) throw new Error('A multisig needs 2–20 unique nonzero owner addresses.')
  return buildSafeInitializer(plan)
}
export function predictMultisig(plan: Omit<CreateMultisig, 'address' | 'role'>): Address {
  multisigInitializer(plan)
  return predictSafeAddress(plan)
}
export function validateMultisigs(plans: readonly CreateMultisig[] = [], owner?: Address): void {
  if (!Array.isArray(plans) || plans.length > 2 || new Set(plans.map(plan => plan.role)).size !== plans.length) throw new Error('Invalid multisig deployment plan.')
  for (const plan of plans) {
    if (!['owner', 'operator'].includes(plan.role) || !isAddressEqual(predictMultisig(plan), plan.address)
      || (plan.role === 'owner' && owner && !isAddressEqual(plan.address, owner))) throw new Error('The multisig address differs from its saved owners and policy.')
  }
}
async function requireCreationBatch(client: PublicClient): Promise<void> {
  const code = await client.getCode({ address: MULTICALL3 })
  if (!code || code === '0x') throw new Error('Multicall3 is unavailable on this network.')
}
export async function resolveCreateMultisigs(values: CreateValues, clients: PublicClient[], salt: Hex) {
  const plans: CreateMultisig[] = []
  const needed = values.ownerMode === 'create' || (!values.ownerIsOperator && values.operatorMode === 'create')
  if (needed) await Promise.all(clients.map(requireCreationBatch))
  const resolve = async (role: 'owner' | 'operator') => {
    const creating = values[`${role}Mode`] === 'create'
    const policy = { owners: creating ? (values[`${role}Signers`] ?? []).map(address => getAddress(address)) : [], threshold: values[`${role}Threshold`]! }
    if (creating) multisigInitializer(policy)
    const resolved = await resolveSafeAddress(creating
      ? { kind: 'create', ...policy, saltNonce: keccak256(encodePacked(['bytes32', 'string'], [salt, role])) }
      : { kind: 'existing', address: values[`${role}Wallet`].trim() as Address }, clients)
    if (resolved.plan) plans.push({ ...resolved.plan, role })
    return resolved.address
  }
  const owner = await resolve('owner')
  const operator = values.ownerIsOperator ? owner : await resolve('operator')
  return { owner, operator, plans, values: { ...values, ownerWallet: owner, operatorWallet: operator } }
}

export async function verifyCreatedMultisigs(client: PublicClient, plans: readonly CreateMultisig[], allowMissing = false, blockNumber?: bigint): Promise<boolean> {
  validateMultisigs(plans)
  return verifySafeDeployments(client, plans, { allowMissing, blockNumber })
}
export async function checkCreateMultisigs(client: PublicClient, plans: readonly CreateMultisig[] = []): Promise<void> {
  if (!plans.length) return
  validateMultisigs(plans)
  await requireCreationBatch(client)
  await checkSafeDeployments(client, plans)
}
export function multisigDeploymentCalls(plans: readonly CreateMultisig[]) {
  validateMultisigs(plans)
  return buildSafeDeploymentCalls(plans)
}
export function multisigDeploymentRequest(chainId: number, plans: readonly CreateMultisig[]): FundTransaction {
  validateMultisigs(plans)
  return buildSafeDeploymentTx(chainId, plans)
}
export function bundleMultisigLaunch(entry: RelayrEntry, plans: readonly CreateMultisig[] = []): RelayrEntry {
  if (!plans.length) return entry
  validateMultisigs(plans)
  // Relayr entries already target the trusted forwarder, preserving the launch sender.
  const call = bundleSafeLaunch({ to: entry.target, data: entry.data, value: BigInt(entry.value) }, plans)
  return { ...entry, target: call.to, data: call.data }
}
export function unbundleMultisigLaunch(entry: RelayrEntry, plans: readonly CreateMultisig[] = []): RelayrEntry {
  if (!plans.length) return entry
  validateMultisigs(plans)
  const call = unbundleSafeLaunch({ to: entry.target, data: entry.data, value: BigInt(entry.value) }, plans)
  return { ...entry, target: call.to, data: call.data }
}
export function multisigReview(plans: readonly CreateMultisig[] = []): string {
  return plans.map(plan => `${plan.role === 'owner' ? 'Owner' : 'Operator'}: create Safe ${plan.address}, ${plan.threshold}/${plan.owners.length} approvals. Owners: ${plan.owners.join(', ')}.`).join('\n')
}
export async function verifyMultisigLaunchSimulation(client: PublicClient, plans: readonly CreateMultisig[] = [], data?: Hex): Promise<void> {
  validateMultisigs(plans)
  await verifySafeLaunchSimulation(client, plans, data)
}
