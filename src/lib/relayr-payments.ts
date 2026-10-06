import { relayrSupportsChain, type RelayrPaymentDetails } from '@bananapus/nana-sdk-core/review/relayr'
import { isAddress, isHash, type Hex } from 'viem'

/** A Relayr bundle or transaction ID, in lowercase. */
export const RELAYR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * A payment sent for a quote: the payment relayrPaymentDetails authenticated,
 * with its amount and deadline in decimal so JSON keeps them, and the hash it
 * was mined under.
 */
export type RelayrSentPayment = Omit<RelayrPaymentDetails, 'amount' | 'deadline'> & {
  amount: string
  deadline: string
  hash: Hex
}

export function sentRelayrPayment(details: RelayrPaymentDetails, hash: Hex): RelayrSentPayment {
  return { ...details, amount: details.amount.toString(), deadline: details.deadline.toString(), hash }
}

/** A saved sent payment, read strictly, or null. */
function relayrSentPaymentSnapshot(value: unknown): RelayrSentPayment | null {
  if (!value || typeof value !== 'object') return null
  const { hash, chainId, target, calldata, amount, deadline, bundleUuid } = value as Record<string, unknown>
  return typeof hash === 'string' && isHash(hash) &&
    typeof chainId === 'number' && relayrSupportsChain(chainId) &&
    typeof target === 'string' && isAddress(target) &&
    typeof calldata === 'string' && /^0x[0-9a-f]{136}$/iu.test(calldata) &&
    typeof amount === 'string' && /^\d{1,78}$/u.test(amount) &&
    typeof deadline === 'string' && /^\d{1,13}$/u.test(deadline) &&
    typeof bundleUuid === 'string' && RELAYR_UUID_RE.test(bundleUuid)
    ? { hash, chainId, target, calldata: calldata as Hex, amount, deadline, bundleUuid }
    : null
}

/** The most payments one quote's journal keeps. No payment is sent beyond them. */
export const MAX_RELAYR_SENT_PAYMENTS = 16

/** A saved list of sent payments, read strictly, or null. */
export function relayrSentPaymentsSnapshot(values: unknown): RelayrSentPayment[] | null {
  if (!Array.isArray(values) || values.length > MAX_RELAYR_SENT_PAYMENTS) return null
  const payments = values.map(relayrSentPaymentSnapshot)
  return payments.every((payment): payment is RelayrSentPayment => payment !== null) ? payments : null
}
