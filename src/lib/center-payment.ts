import { decodeFunctionData, isAddress, keccak256, parseAbi, stringToHex, type Address } from 'viem'
import type { CenterWalletConnection, CenterWalletExpectedPayment, CenterWalletPaymentStatus, CenterWalletStorage,
  PreparedUserOperation, SmartWalletPlan, createCenterWalletClient } from '@bananapus/nana-sdk-connect/core'
import type { HomerunCenterConfig } from '@/providers/wallet-config'
import { centerReturnPath } from '@/providers/center-callback'

export interface HomerunPaymentIntent {
  projectId: string; token: Address; terminal: Address; amount: string; minimumReturnedTokens: string; returnPath: string
}
type Principal = { accountId: string; grantId: string; signer: string }
interface Journal extends Principal {
  version: 1; id: string; config: HomerunCenterConfig; intent: HomerunPaymentIntent; submitted: boolean;
  plan?: SmartWalletPlan; operation?: PreparedUserOperation; expectedPayment?: CenterWalletExpectedPayment
}
const key = 'homerun:center:payment:v1', historyKey = key + ':history', returnKey = 'homerun:center:return:v1'
const payAbi = parseAbi(['function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata)'])
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
function fail(message = 'The original payment changed. Keep its record and retry its status.'): never { throw new Error(message) }
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
const digest = (value: unknown) => keccak256(stringToHex(encode(value)))
function checkedIntent(input: HomerunPaymentIntent): HomerunPaymentIntent {
  const fields = ['projectId', 'token', 'terminal', 'amount', 'minimumReturnedTokens', 'returnPath']
  if (!input || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) fail('Invalid payment.')
  const result = { ...input }
  for (const value of [result.projectId, result.amount, result.minimumReturnedTokens])
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) fail('Invalid payment amount.')
  if (BigInt(result.projectId) === 0n || BigInt(result.amount) === 0n ||
    !isAddress(result.token) || !isAddress(result.terminal) || BigInt(result.token) <= 1n || BigInt(result.terminal) <= 1n) fail('Invalid payment target.')
  centerReturnPath(result.returnPath)
  return result
}

/** Stores original preparation IDs before network effects. The shared SDK independently
 * validates exact call semantics, the owner approval and canonical payment receipt. */
export function createHomerunPayment(options: { config: HomerunCenterConfig;
  wallet: Pick<ReturnType<typeof createCenterWalletClient>, 'restoreConnection' | 'payments'>; storage: CenterWalletStorage }) {
  const config = structuredClone(options.config), { wallet, storage } = options, payments = wallet.payments()
  function read(): { value: Journal | null; raw: string | null } {
    const raw = storage.getItem(key)
    if (raw === null) return { value: null, raw }
    try {
      if (raw.length > 1_048_576) fail()
      const saved = JSON.parse(raw) as { value: Journal; integrity: string }, value = saved.value
      if (saved.integrity !== digest(value) || value.version !== 1 || digest(value.config) !== digest(config) ||
        !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.submitted !== 'boolean') fail()
      checkedIntent(value.intent)
      return { value, raw }
    } catch { return fail() }
  }
  function save(value: Journal, expected: string | null) {
    const raw = encode({ value, integrity: digest(value) })
    if (raw.length > 1_048_576 || storage.getItem(key) !== expected) fail()
    storage.setItem(key, raw)
    if (storage.getItem(key) !== raw) fail('This tab could not preserve the original payment.')
    return { value: JSON.parse(encode(value)) as Journal, raw }
  }
  function connection() {
    const current = wallet.restoreConnection()
    if (!current || current.chainId !== 8453 || current.accountId !== 'eip155:8453:' + current.address.toLowerCase())
      fail('Reconnect the original Juicebox wallet to continue.')
    return current
  }
  async function identity(current: CenterWalletConnection, prior?: Journal): Promise<Principal> {
    const { claims } = await current.client.authorizeRead('/api/v1/smart-accounts/bindings')
    if (claims.accountId !== current.accountId || !claims.grantId || !isAddress(claims.signer)) fail()
    const principal = { accountId: claims.accountId, grantId: claims.grantId, signer: claims.signer }
    if (prior && (principal.accountId !== prior.accountId || principal.grantId !== prior.grantId || principal.signer !== prior.signer)) fail()
    if (wallet.restoreConnection()?.accountId !== current.accountId) fail()
    return principal
  }
  function expectation(plan: SmartWalletPlan, intent: HomerunPaymentIntent, account: Address): CenterWalletExpectedPayment {
    const call = plan.draft.calls.at(-1)
    if (!call || call.chainId !== 8453 || !same(call.to, intent.terminal) || BigInt(call.value) !== 0n) fail('Center returned a different payment target.')
    const decoded = decodeFunctionData({ abi: payAbi, data: call.data })
    const [projectId, token, amount, beneficiary, minimum, memo, metadata] = decoded.args
    if (String(projectId) !== intent.projectId || !same(token, intent.token) || String(amount) !== intent.amount ||
      !same(beneficiary, account) || minimum < BigInt(intent.minimumReturnedTokens) || memo !== '' || metadata !== '0x')
      fail('The prepared payment differs from the amount, beneficiary or minimum you reviewed.')
    return { kind: 'v6-usdc-pay', chainId: 8453, account, token: intent.token, terminal: intent.terminal,
      projectId: intent.projectId, amount: intent.amount, beneficiary: account, minimumReturnedTokens: String(minimum),
      memo, metadata, maximumNetworkFee: config.maximumNetworkFee }
  }
  async function prepare(input: HomerunPaymentIntent): Promise<CenterWalletPaymentStatus> {
    const intent = checkedIntent(input), current = connection(), old = read(), principal = await identity(current, old.value ?? undefined)
    if (old.value && digest(old.value.intent) !== digest(intent)) fail('Finish or close the original payment before preparing another.')
    if (!old.value && payments.pendingPayment()) fail('The SDK has an existing payment. Recover it before preparing another.')
    let saved = old.value ? { value: old.value, raw: old.raw! } : save({ version: 1, id: crypto.randomUUID(), config, intent, submitted: false, ...principal }, old.raw)
    if (saved.value.submitted) return payments.refreshPayment()
    storage.setItem(returnKey, intent.returnPath)
    if (storage.getItem(returnKey) !== intent.returnPath) fail()
    if (!saved.value.plan) {
      const smart = current.client.smartAccounts(), bindings = await smart.bindings()
      const matches = bindings.items.filter(item => item.wallet.chainId === 8453 && same(item.wallet.address, current.address) && item.manifestId === config.manifest.id)
      if (matches.length !== 1) fail('This Juicebox wallet has no matching payment profile.')
      const binding = await smart.binding(matches[0]!.id), state = binding.state, profile = state.ownerProfile
      const timestamp = Number(state.evidence.timestamp) * 1000
      if (binding.ownerAccountId !== current.accountId || state.manifestId !== config.manifest.id || state.manifestRevision !== config.manifest.revision ||
        state.chainId !== 8453 || !same(state.address, current.address) || !same(binding.wallet.address, current.address) ||
        state.moduleConfigurationVerified !== true || state.modules?.complete !== true || state.modules.arbitrarySigningDisabled !== true ||
        state.modules.wildcardExecutionDisabled !== true || state.threshold !== 1 || profile?.version !== 'center-passkey-v1' ||
        profile.signer.kind !== 'contract' || !state.owners.some(owner => same(owner, profile.signer.address)) ||
        state.evidence.source !== 'onchain' || state.evidence.chainId !== 8453 || !Number.isSafeInteger(timestamp) ||
        timestamp < Date.now() - 300_000 || timestamp > Date.now() + 30_000) fail('The current wallet owners and payment profile could not be verified.')
      const plan = await smart.preparePlan(binding.id, 'prepare_pay', { project: { chainId: 8453, projectId: intent.projectId, version: 6 },
        account: current.address, beneficiary: current.address, token: intent.token, amount: intent.amount, slippageBps: 100, memo: '', metadata: '0x' }, 'homerun-plan:' + saved.value.id)
      const expectedPayment = expectation(plan, intent, current.address)
      await identity(current, saved.value)
      saved = save({ ...saved.value, plan, expectedPayment }, saved.raw)
    }
    if (!saved.value.operation) {
      const operation = await current.client.request<PreparedUserOperation>({ method: 'POST', requestTarget: '/api/v1/user-operations',
        idempotencyKey: 'homerun-operation:' + saved.value.id,
        json: { planId: saved.value.plan!.id, stepIndexes: saved.value.plan!.draft.calls.map((_call, index) => index) } })
      if (!('ownerProfile' in operation.signing) || operation.signing.ownerProfile !== 'center-passkey-v1') fail('A passkey owner payment review is required.')
      await identity(current, saved.value)
      saved = save({ ...saved.value, operation }, saved.raw)
    }
    await identity(current, saved.value)
    return payments.preparePayment({ plan: saved.value.plan!, operation: saved.value.operation!, expectedPayment: saved.value.expectedPayment! })
  }
  async function submit() {
    const saved = read(); if (!saved.value) fail()
    await identity(connection(), saved.value)
    if (saved.value.submitted) return payments.refreshPayment()
    if (payments.pendingPayment()?.status !== 'approved') fail('Approve this exact payment in Juicebox wallet before submitting.')
    save({ ...saved.value, submitted: true }, saved.raw)
    // An uncertain response always keeps this marker. The SDK records the original signed
    // operation before sending; subsequent calls only observe it and never send a replacement.
    return payments.submitPayment()
  }
  function pending() {
    const saved = read().value
    const observed = payments.pendingPayment()
    const status = saved?.submitted && observed && ['approved', 'reviewing'].includes(observed.status)
      ? { ...observed, status: 'unknown' as const } : observed
    return saved ? { intent: saved.intent, submitted: saved.submitted, status } : null
  }
  function clear() {
    const saved = read(); if (!saved.value) return
    const current = payments.pendingPayment()
    if (current && !['paid', 'cancelled', 'reverted', 'expired'].includes(current.status)) fail('Keep this payment until its outcome is known.')
    const rawHistory = storage.getItem(historyKey)
    if (rawHistory && rawHistory.length > 1_048_576) fail()
    const history = rawHistory ? JSON.parse(rawHistory) as { id: string; digest: string; payment: Journal; status: CenterWalletPaymentStatus | null }[] : []
    if (!Array.isArray(history) || history.length > 64) fail()
    const archived = history.find(item => item.id === saved.value!.id)
    if (archived && archived.digest !== digest(saved.value)) fail()
    if (!archived) {
      if (history.length >= 64 || !payments.pendingPayment()) fail()
      const encoded = encode([...history, { id: saved.value.id, digest: digest(saved.value), payment: saved.value, status: payments.pendingPayment() }])
      if (encoded.length > 1_048_576 || storage.getItem(historyKey) !== rawHistory) fail()
      storage.setItem(historyKey, encoded); if (storage.getItem(historyKey) !== encoded) fail()
    }
    if (storage.getItem(key) !== saved.raw) fail()
    if (payments.pendingPayment()) payments.clearPayment()
    storage.removeItem(key); if (storage.getItem(key) !== null) fail()
  }
  async function complete(callbackUrl: string) {
    const saved = read(); if (!saved.value) fail()
    await identity(connection(), saved.value)
    return payments.completePayment(callbackUrl)
  }
  return { prepare, submit, pending, clear, complete, refresh: () => payments.refreshPayment() }
}
