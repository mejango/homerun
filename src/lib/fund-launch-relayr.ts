'use client'

import {
  JBCoreContracts,
  erc2771ForwarderAbi,
  jbContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getProjectCreationFee } from '@bananapus/nana-sdk-core/v6'
import { getAccount } from '@wagmi/core'
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Abi,
  type Hex,
} from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { buildFundLaunch, type FundTransaction } from '@/lib/fund-contracts'
import { verifyFundLaunch } from '@/lib/fund-launch-verification'
import { loadLaunchSession, saveLaunch as saveLaunchSession, type LaunchStatus as LaunchChainStatus, type FundLaunchSession as LaunchSession } from '@/lib/fund-launch-session'
import { gasWithHeadroom } from '@/lib/gas'
import {
  prepareForwardedTx,
  TRUSTED_FORWARDER_ABI,
  relayrDestinationHash,
  relayrPay,
  relayrPaymentDetails,
  relayrPaymentOptions,
  relayrPaymentLabel,
  relayrPoll,
  relayrPostBundle,
  type RelayrEntry,
  type RelayrQuote,
  type RelayrTransactionRecord,
} from '@/lib/relayr'
import { isSafeConnection } from '@/lib/safe-connector'
import { assertNoViewAs } from '@/lib/viewAs'
import { publicClient } from '@/lib/wallet-core'
import { displayChainName as chainName } from '@/lib/chainDisplay'
import { withForwarderAuthorizationLock } from '@/lib/forwarder-authorization'
import { relayrPaymentChains, relayrSupportsChains } from '@/lib/relayr-chains'
import { requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'

const activeLaunches = new Set<string>()
class LaunchSignaturesNeedRefresh extends Error {}

type SignedLaunch = {
  chainId: number
  entry: RelayrEntry
  nonce: string
  deadline: number
}

/** Exact signatures and quote bindings survive refreshes, including the wallet's no-hash send window. */
export type LaunchRelayrJournal = {
  account: Address
  paymentChainId?: number
  phase: 'signing' | 'quoting' | 'quoted' | 'payment-signing' | 'submitted' | 'executing'
  signed: SignedLaunch[]
  superseded?: SignedLaunch[]
  /** Retrying a known failed attempt must reuse its nonce, even if the old signature is still live. */
  retryNonces?: Record<number, string>
  quote?: RelayrQuote
  paymentHash?: Hex
  paymentDeadline?: string
  records: RelayrTransactionRecord[]
  published?: true
  abandonable?: true
}

function requestFor(session: LaunchSession, chainId: number, fee: bigint): FundTransaction {
  return buildFundLaunch({ ...session.input, creationFees: { ...session.input.creationFees, [chainId]: fee } }).requests.find(request => request.chainId === chainId)!
}

function launchData(request: FundTransaction): Hex {
  return encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: request.args }).toLowerCase() as Hex
}

export function canRelayrLaunch(session: LaunchSession): boolean {
  return session.transport === 'relayr' && session.input.chainIds.length > 1 &&
    session.input.chainIds.length <= 4 && relayrSupportsChains(session.input.chainIds)
}

function forwarderFor(chainId: number): Address {
  const address = jbContractAddress['6'][JBCoreContracts.ERC2771Forwarder][chainId as JBChainId]
  if (!address) throw new Error(`No V6 forwarder is configured on ${chainName(chainId)}.`)
  return address
}

function requestOf(signed: SignedLaunch) {
  if (!isAddressEqual(signed.entry.target, forwarderFor(signed.chainId)) ||
      signed.entry.chain !== signed.chainId) throw new Error('The saved launch forwarder changed.')
  const decoded = decodeFunctionData({ abi: erc2771ForwarderAbi, data: signed.entry.data })
  if (decoded.functionName !== 'execute') throw new Error('The saved launch is not a forwarder execution.')
  const request = decoded.args[0]
  if (request.deadline !== signed.deadline || request.value !== BigInt(signed.entry.value)) {
    throw new Error('The saved launch authorization changed.')
  }
  return request
}

function walletRejected(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (item.code === 4001 || item.name === 'UserRejectedRequestError') return true
    current = item.cause
  }
  return false
}

/**
 * One authorization per destination, one reviewed payment on the user's selected chain.
 * The launch journal owns recovery: provider labels never establish creation or permit a new payment.
 */
export async function runRelayrLaunch({ session, account, onStatus, onProgress }: {
  session: LaunchSession
  account: Address
  onStatus: (chainId: number, status: LaunchChainStatus & { error?: string }) => void
  onProgress: (message: string) => void
}): Promise<void> {
  assertNoViewAs()
  if (!canRelayrLaunch(session) || isSafeConnection(wagmiConfig)) {
    throw new Error('Relayed creation requires an ordinary wallet and multiple supported chains from the same network environment.')
  }
  if (!session.input.sender || !isAddressEqual(session.input.sender, account)) {
    throw new Error('Connect the wallet that originally signed this launch.')
  }
  if (activeLaunches.has(session.input.salt)) throw new Error('This launch is already running.')
  activeLaunches.add(session.input.salt)
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      throw new Error('This browser cannot coordinate launch recovery across tabs. Use a browser with Web Locks support.')
    }
    await navigator.locks.request('homerun:fund-launch', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This launch is already running in another tab.')
      await withForwarderAuthorizationLock({ account, chainIds: [...session.input.chainIds], owner: `launch:${session.input.salt}`,
        execute: run })
    })
  } finally {
    activeLaunches.delete(session.input.salt)
  }

  async function run(assertAuthorizationAvailable: (destinations?: number[]) => void) {
    const saved = loadLaunchSession({ strict: true })
    if (saved && saved.input.salt !== session.input.salt) throw new Error('Another launch is saved in this browser. Resume it before starting a different launch.')
    const current = saved?.input.salt === session.input.salt ? saved : session
    if (!canRelayrLaunch(current)) {
      throw new Error('The saved launch must use supported chains from the same network environment.')
    }
    const persist = () => {
      const latest = loadLaunchSession()
      if (latest && latest.input.salt !== current.input.salt) throw new Error('Another tab changed the active launch. Stop and recover the original launch before continuing.')
      if (!saveLaunchSession(current)) {
        throw new Error('Allow browser storage before launching so payment and destination transactions can be recovered safely.')
      }
    }
    const status = (chainId: number, next: LaunchChainStatus & { error?: string }) => {
      // The React caller merges patches. Explicitly clear fields absent from this full
      // snapshot so a failed attempt's hash cannot attach itself to a newly signed bundle.
      const snapshot = { hash: undefined, projectId: undefined,
        error: undefined, ...next }
      current.statuses = { ...current.statuses, [chainId]: snapshot }
      persist()
      onStatus(chainId, snapshot)
    }
    const requireAccount = () => {
      const connected = getAccount(wagmiConfig).address
      if (!connected || !isAddressEqual(connected, account) || isSafeConnection(wagmiConfig)) {
        throw new Error('Connected account changed. Return to the wallet that started this launch.')
      }
    }
    requireAccount()
    if (!current.input.sender || !isAddressEqual(current.input.sender, account) || current.transport !== 'relayr') {
      throw new Error('The saved launch identity or payment chain changed.')
    }
    let journal = current.relayr
    if (journal && (!Array.isArray(journal.signed) || !Array.isArray(journal.records) ||
        !isAddressEqual(journal.account, account) ||
        journal.signed.length > current.input.chainIds.length ||
        new Set(journal.signed.map(item => item.chainId)).size !== journal.signed.length ||
        journal.signed.some(item => !current.input.chainIds.includes(item.chainId)) ||
        !['signing', 'quoting', 'quoted', 'payment-signing', 'submitted', 'executing'].includes(journal.phase))) {
      throw new Error('The saved Relayr launch is invalid. Keep its original transaction records before continuing.')
    }
    if (journal && ['payment-signing', 'submitted', 'executing'].includes(journal.phase)) {
      if (journal.paymentChainId === undefined || !relayrPaymentChains(current.input.chainIds).includes(journal.paymentChainId)) {
        throw new Error('The original Relayr payment requires its saved payment chain in the launch network environment.')
      }
      current.paymentChainId = journal.paymentChainId
    } else {
      // Older unfunded sessions may contain a pre-quote preference. Every new
      // payment requires a fresh, explicit choice among the actual quote offers.
      delete current.paymentChainId
      if (journal) {
        delete journal.paymentChainId
        delete journal.paymentDeadline
      }
    }
    const pinnedRequest = (signed: SignedLaunch) => {
      const request = requestOf(signed)
      const expected = requestFor(current, signed.chainId, request.value)
      if (!isAddressEqual(request.from, account) || !isAddressEqual(request.to, expected.address) ||
          request.data !== launchData(expected)) throw new Error('The saved signature does not match this pinned launch.')
      return request
    }
    for (const signed of journal?.signed ?? []) pinnedRequest(signed)
    for (const signed of journal?.superseded ?? []) pinnedRequest(signed)
    const unusedSignaturesExpired = async (signed: SignedLaunch[]): Promise<boolean> => {
      if (!signed.length) return false
      try {
        for (const item of signed) {
          if (current.statuses[item.chainId]?.phase === 'confirmed') continue
          const client = publicClient(item.chainId as JBChainId)
          const block = await client.getBlock({ blockTag: 'finalized' })
          const nonce = await client.readContract({ address: item.entry.target, abi: erc2771ForwarderAbi,
            functionName: 'nonces', args: [account], blockNumber: block.number })
          const canonical = await client.getBlock({ blockNumber: block.number })
          if (canonical.hash !== block.hash || block.timestamp <= BigInt(item.deadline) || nonce !== BigInt(item.nonce)) return false
        }
        return true
      } catch { return false }
    }
    const originalPaymentExpired = async (): Promise<boolean> => {
      if (!journal?.paymentDeadline) return false
      try {
        const client = publicClient(journal.paymentChainId as JBChainId)
        const block = await client.getBlock({ blockTag: 'finalized' })
        const canonical = await client.getBlock({ blockNumber: block.number })
        return canonical.hash === block.hash && block.timestamp > BigInt(journal.paymentDeadline)
      } catch { return false }
    }
    if (journal?.published && !journal.abandonable &&
        ['signing', 'quoting', 'quoted'].includes(journal.phase) &&
        await unusedSignaturesExpired([...journal.signed, ...(journal.superseded ?? [])])) {
      journal.abandonable = true
      persist()
      throw new Error('All outstanding launch authorizations expired unused. You can change the setup or retry this launch; any earlier relay payments are not refunded automatically.')
    }
    if (journal?.abandonable && ['signing', 'quoting', 'quoted'].includes(journal.phase) && journal.signed.length) {
      const previous = journal
      journal = { account, phase: 'signing', signed: [], records: [],
        published: true, abandonable: true,
        retryNonces: { ...previous.retryNonces, ...Object.fromEntries(previous.signed.map(item => [item.chainId, item.nonce])) },
        superseded: [...(previous.superseded ?? []), ...previous.signed] }
      current.relayr = journal
      persist()
    }
    const requireQuoteBindings = () => {
      const bindings = journal?.quote?.expectedTransactions
      if (!bindings?.length || bindings.length !== journal!.signed.length ||
          new Set(bindings.map(item => item.txUuid)).size !== bindings.length ||
          new Set(bindings.map(item => item.chain)).size !== bindings.length) {
        throw new Error('The launch quote does not bind each signed destination exactly once.')
      }
      for (const signed of journal!.signed) {
        const binding = bindings.find(item => item.chain === signed.chainId)
        if (!binding || binding.entry.chain !== signed.chainId ||
            !isAddressEqual(binding.entry.target, signed.entry.target) || binding.entry.data !== signed.entry.data ||
            binding.entry.value !== signed.entry.value) throw new Error('The saved launch quote changed its destination calls.')
      }
      return bindings
    }

    /** Receipts are accepted only for the exact signed outer call on its bound chain. */
    const reconcile = async (): Promise<boolean> => {
      const bindings = requireQuoteBindings()
      const original = journal!
      let allDone = true
      let allRemainingRetryable = true
      let allRemainingExpired = true
      for (const signed of original.signed) {
        const request = pinnedRequest(signed)
        const client = publicClient(signed.chainId as JBChainId)
        const binding = bindings.find(item => item.chain === signed.chainId)
        if (!binding || !isAddressEqual(binding.entry.target, signed.entry.target) ||
            binding.entry.data !== signed.entry.data || binding.entry.value !== signed.entry.value) {
          throw new Error('The saved launch quote does not match its signed destination.')
        }
        // A record's chain/request is provider input. Only the quote's bound UUID identifies its destination.
        const matching = original.records.filter(record => record.tx_uuid === binding.txUuid)
        if (matching.length > 1) throw new Error('Relayr returned conflicting destination records.')
        const hash = current.statuses[signed.chainId]?.hash ??
          (matching[0] ? relayrDestinationHash(matching[0]) : null)
        if (hash) {
          try {
            const [tx, receipt] = await Promise.all([
              client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
            ])
            if (!tx.to || !isAddressEqual(tx.to, signed.entry.target) || tx.input !== signed.entry.data ||
                tx.value !== BigInt(signed.entry.value) || receipt.transactionHash !== hash ||
                tx.hash !== hash || tx.chainId !== signed.chainId || tx.blockHash !== receipt.blockHash) {
              throw new Error('Relayr destination transaction does not match the signed launch.')
            }
            const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
            if (canonical.hash !== receipt.blockHash) throw new Error('The destination receipt is no longer canonical.')
            if (receipt.status === 'success') {
              const projectId = (await verifyFundLaunch(client, requestFor(current, signed.chainId, request.value), current.input, receipt, false, signed.entry)).toString()
              if (!projectId) throw new Error('The launch confirmed but its project ID could not be verified.')
              status(signed.chainId, { phase: 'confirmed', hash: hash, projectId })
              continue
            }
            // A reverted execute leaves the nonce unused. Its old authorization can only compete
            // with a retry of that SAME nonce, never create an additional project after a success.
            const nonce = await client.readContract({ address: signed.entry.target, abi: erc2771ForwarderAbi,
              functionName: 'nonces', args: [account] })
            if (nonce !== BigInt(signed.nonce)) throw new Error('The launch authorization was consumed elsewhere.')
            status(signed.chainId, { phase: 'reverted', hash: hash, error: 'The destination launch reverted.' })
            allDone = false
            allRemainingExpired = false
            continue
          } catch (error) {
            status(signed.chainId, { phase: 'unresolved', hash: hash,
              error: error instanceof Error ? error.message : 'Destination confirmation is unavailable.' })
          }
        } else {
          // At a canonical block after expiry, an unchanged nonce proves this authorization
          // never succeeded and can no longer do so. Wall-clock expiry alone proves neither.
          try {
            const block = await client.getBlock({ blockTag: 'finalized' })
            const nonce = await client.readContract({ address: signed.entry.target, abi: erc2771ForwarderAbi,
              functionName: 'nonces', args: [account], blockNumber: block.number })
            const canonical = await client.getBlock({ blockNumber: block.number })
            if (block.hash === canonical.hash && block.timestamp > BigInt(request.deadline) && nonce === BigInt(signed.nonce)) {
              status(signed.chainId, { phase: 'expired', error: 'The unexecuted launch authorization expired.' })
              allDone = false
              continue
            }
          } catch { /* An unavailable RPC cannot prove absence of execution. */ }
          status(signed.chainId, { phase: 'unresolved', error: 'Waiting for the original Relayr destination transaction.' })
        }
        allDone = false
        allRemainingRetryable = false
      }
      if (allDone) return true
      if (allRemainingRetryable) {
        current.relayr = {
          account, phase: 'signing', signed: [], records: [],
          published: true,
          ...(allRemainingExpired ? { abandonable: true } : {}),
          superseded: [...(original.superseded ?? []), ...original.signed]
            .filter(item => current.statuses[item.chainId]?.phase !== 'confirmed'),
          retryNonces: Object.fromEntries(original.signed.filter(item => current.statuses[item.chainId]?.phase !== 'confirmed')
            .map(item => [item.chainId, item.nonce])),
        }
        delete current.paymentChainId
        persist()
      }
      return false
    }

    if (journal && ['payment-signing', 'submitted', 'executing'].includes(journal.phase)) {
      onProgress('Checking the original payment and destination transactions. No new payment will be requested.')
      try {
        const records = await relayrPoll(journal.quote!.bundle_uuid, journal.signed.length, records => {
          journal!.records = records
          persist()
        }, 2_500, 15_000)
        journal.records = records
        persist()
      } catch { /* Provider failure labels and timeouts still require independent onchain reconciliation. */ }
      if (await reconcile()) return
      if (current.relayr === journal) {
        throw new Error('This launch is still unresolved. Check the original bundle; do not pay or launch again.')
      }
      // A no-hash funding attempt remains ambiguous even when destination signatures expire.
      // Re-running would risk paying twice. Keep the original funding journal for manual resolution.
      if (journal.phase === 'payment-signing' && !journal.paymentHash) {
        current.relayr = journal
        current.paymentChainId = journal.paymentChainId
        if (await unusedSignaturesExpired([...journal.signed, ...(journal.superseded ?? [])]) &&
            await originalPaymentExpired()) journal.abandonable = true
        persist()
        throw new Error(journal.abandonable
          ? 'The launch authorizations and payment quote expired. You may abandon this launch, but the earlier payment may have been charged; check your wallet. No refund is implied.'
          : 'Your wallet may have sent the Relayr payment without returning its hash. Check its activity before another payment.')
      }
      journal = current.relayr
    }

    journal ??= { account, phase: 'signing', signed: [], records: [] }
    current.relayr = journal
    persist()
    const remaining = current.input.chainIds.filter(chainId => current.statuses[chainId]?.phase !== 'confirmed')
    if (!remaining.length) return

    const verifySigned = async () => {
      requireAccount()
      assertAuthorizationAvailable(remaining)
      for (const signed of journal!.signed) {
        const request = requestOf(signed)
        const client = publicClient(signed.chainId as JBChainId)
        const creationFee = await getProjectCreationFee(client, signed.chainId as JBChainId)
        const expected = requestFor(current, signed.chainId, creationFee)
        const data = launchData(expected)
        if (!isAddressEqual(request.from, account) || !isAddressEqual(request.to, expected.address) ||
            request.data !== data || request.value !== expected.value) {
          throw new LaunchSignaturesNeedRefresh('A creation fee changed. Review fresh launch authorizations before payment.')
        }
        const [trusted, valid, code] = await Promise.all([
          client.readContract({ address: expected.address, abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [signed.entry.target] }),
          client.readContract({ address: signed.entry.target, abi: erc2771ForwarderAbi, functionName: 'verify', args: [request] }),
          client.getCode({ address: account }),
        ])
        if (request.deadline < Math.floor(Date.now() / 1000) + 120) {
          throw new LaunchSignaturesNeedRefresh('Launch signatures are about to expire. Review fresh authorizations before payment.')
        }
        if (!trusted || !valid || (code && code !== '0x')) {
          throw new Error('The wallet, forwarder, or launch authorization changed. Check the original bundle before continuing.')
        }
        // Simulate the exact signed forwarder execution as well as its authorization.
        // This catches stale launch prerequisites and an insufficient signed gas limit
        // before the user funds Relayr. Only native balance is supplied by the override.
        await client.call({ account, to: signed.entry.target, data: signed.entry.data, value: request.value,
          gas: request.gas + request.gas / 63n + 100_000n,
          stateOverride: [{ address: account, balance: request.value + 100n * 10n ** 18n }] })
      }
    }

    const authorizations: { chainId: number; nonce: bigint; prepared: Awaited<ReturnType<typeof prepareForwardedTx>> }[] = []
    for (const chainId of remaining) {
      if (journal.signed.some(item => item.chainId === chainId)) continue
      requireAccount()
      assertAuthorizationAvailable(remaining)
      const client = publicClient(chainId as JBChainId)
      const creationFee = await getProjectCreationFee(client, chainId as JBChainId)
      const request = requestFor(current, chainId, creationFee)
      current.input = { ...current.input, creationFees: { ...current.input.creationFees, [chainId]: creationFee } }
      persist()
      const forwarder = forwarderFor(chainId)
      const [code, forwarderCode, trusted, nonce] = await Promise.all([
        client.getCode({ address: account }), client.getCode({ address: forwarder }),
        client.readContract({ address: request.address, abi: TRUSTED_FORWARDER_ABI, functionName: 'isTrustedForwarder', args: [forwarder] }),
        client.readContract({ address: forwarder, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account] }),
      ])
      if ((code && code !== '0x') || !forwarderCode || forwarderCode === '0x' || !trusted) {
        throw new Error(`An ordinary wallet and the canonical trusted forwarder are required on ${chainName(chainId)}.`)
      }
      if (journal.retryNonces?.[chainId] !== undefined && nonce !== BigInt(journal.retryNonces[chainId])) {
        throw new Error('An earlier launch authorization may have executed. Check its original destination before signing again.')
      }
      const data = launchData(request)
      // Relayr supplies each destination's creation fee. Override ONLY the ordinary signer's
      // native balance for this launch estimate; no destination ETH balance or token approval
      // is needed. No contract storage/code is overridden, so the real launch rules still execute.
      const estimate = await client.estimateGas({ account, to: request.address, data, value: request.value,
        stateOverride: [{ address: account, balance: creationFee + 100n * 10n ** 18n }] })
      const prepared = await prepareForwardedTx({ chainId: chainId as JBChainId, target: request.address,
        data, value: request.value, gas: gasWithHeadroom(estimate), abi: request.abi,
        functionName: request.functionName, args: request.args, label: `Launch on ${chainName(chainId)}` }, account, nonce)
      authorizations.push({ chainId, nonce, prepared })
    }
    if (authorizations.length) {
      await requireTransactionReview({
        kind: 'authorization', title: 'Create your project',
        description: 'Review the FUND launch across your selected chains. Next, sign once for each chain in your wallet. Relayr will then return execution quotes for you to choose from.',
        confirmLabel: 'Continue to wallet',
        calls: authorizations.flatMap(item => item.prepared.review.calls),
        authorization: { type: 'EIP-712 launch authorizations', requests: authorizations.map(item => item.prepared.review.authorization) },
      })
    }
    for (const { chainId, nonce, prepared } of authorizations) {
      requireAccount()
      assertAuthorizationAvailable(remaining)
      onProgress(`Sign the launch authorization for ${chainName(chainId)}.`)
      status(chainId, { phase: 'signing' })
      const entry = await prepared.sign()
      const decoded = decodeFunctionData({ abi: erc2771ForwarderAbi, data: entry.data })
      if (decoded.functionName !== 'execute') throw new Error('Invalid launch authorization.')
      journal.signed.push({ chainId, entry, nonce: nonce.toString(), deadline: decoded.args[0].deadline })
      persist()
      status(chainId, { phase: 'authorized' })
    }
    try {
      await verifySigned()
    } catch (error) {
      if (error instanceof LaunchSignaturesNeedRefresh) {
        // No payment has been attempted here. Old and new authorizations retain the SAME
        // per-chain nonce, so even previously published signatures cannot create duplicates.
        const retryNonces = { ...journal.retryNonces }
        for (const signed of journal.signed) {
          const nonce = await publicClient(signed.chainId as JBChainId).readContract({
            address: signed.entry.target, abi: erc2771ForwarderAbi, functionName: 'nonces', args: [account],
          })
          if (nonce !== BigInt(signed.nonce)) throw new Error('An earlier launch authorization may have executed. Check its original bundle.')
          retryNonces[signed.chainId] = signed.nonce
        }
        current.relayr = { account, phase: 'signing', signed: [], records: [],
          retryNonces, ...(journal.published ? { published: true, superseded: [...(journal.superseded ?? []), ...journal.signed] } : {}) }
        persist()
      }
      throw error
    }
    const requestQuote = async () => {
      assertAuthorizationAvailable(remaining)
      journal!.phase = 'quoting'
      journal!.published = true
      delete journal!.abandonable
      delete journal!.quote
      delete journal!.paymentChainId
      delete journal!.paymentDeadline
      delete current.paymentChainId
      persist() // exact signed entries are durable BEFORE publishing them to Relayr
      onProgress('Getting payment options for all selected chains.')
      journal!.quote = await relayrPostBundle(journal!.signed.map(item => item.entry))
      journal!.phase = 'quoted'
      persist()
    }
    if (!journal.quote) await requestQuote()
    requireQuoteBindings()
    const destinations = journal.signed.map(item => item.chainId)
    let payments = relayrPaymentOptions(journal.quote!, destinations)
    if (!payments.length) {
      // An unfunded quote can be refreshed using exactly the same signed calls.
      // Its returned funding options must be explicitly reviewed again.
      await requestQuote()
      requireQuoteBindings()
      payments = relayrPaymentOptions(journal.quote!, destinations)
    }
    if (!payments.length) throw new Error('Relayr returned no usable payment options for this launch. Retry to request a new quote; nothing was paid.')
    onProgress('Choose a quoted funding chain for the launch payment.')
    const paymentChainId = await requireFundingChainSelection(payments.map(payment => ({ chainId: payment.chain, label: relayrPaymentLabel(payment) })))
    const payment = payments.find(option => option.chain === paymentChainId)
    if (!payment) throw new Error('The selected funding chain is not available in this quote. No payment was sent.')
    requireAccount()
    requireQuoteBindings()
    // The chooser has no time limit. An expired offer must never reach the
    // wallet; retry refreshes it and asks for another explicit funding choice.
    const details = relayrPaymentDetails(payment, journal.quote!.bundle_uuid)
    if (details.chainId !== paymentChainId || !relayrPaymentChains(destinations).includes(details.chainId)) {
      throw new Error('The launch funding option changed. Review the quote again.')
    }
    journal.paymentChainId = paymentChainId
    current.paymentChainId = paymentChainId
    journal.paymentDeadline = details.deadline.toString()
    persist()
    onProgress(`Approve one payment on ${chainName(paymentChainId)} to launch on every selected chain.`)
    try {
      journal.paymentHash = await relayrPay(payment, account, journal.quote!.bundle_uuid, destinations, hash => {
        journal!.paymentHash = hash
        journal!.phase = 'submitted'
        persist()
      }, verifySigned, () => {
        journal!.phase = 'payment-signing'
        persist() // reload during the wallet prompt cannot silently pay again
      })
    } catch (error) {
      if (journal.phase === 'payment-signing' && !journal.paymentHash && walletRejected(error)) {
        journal.phase = 'quoted'
        delete journal.paymentChainId
        delete journal.paymentDeadline
        delete current.paymentChainId
        persist()
      }
      throw error
    }
    journal.phase = 'executing'
    persist()
    onProgress('Payment confirmed. Checking each destination launch onchain.')
    try {
      journal.records = await relayrPoll(journal.quote!.bundle_uuid, journal.signed.length, records => {
        journal!.records = records
        persist()
      })
    } catch { /* Reconcile exact receipts even when the provider calls the bundle failed. */ }
    persist()
    if (!(await reconcile())) {
      throw new Error('Some destination launches are unfinished. Resume this launch to check them; confirmed projects are kept.')
    }
  }
}
