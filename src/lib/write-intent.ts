import { keccak256, stringToHex } from 'viem'

/** A param the user chose for a write: an amount, a token, a loan or project id, a recipient. */
export type WriteIntentParam = string | number | bigint | boolean

/**
 * The stable name a held write is kept under when its calldata is rebuilt on every attempt: a
 * fresh quote's minimum, a deadline, a Permit2 expiration or signature, an accruing ceiling. Pass it
 * as `recoveryNamespace`. It is built from the action and the params the user chose, never a
 * volatile field, so a retry of the same choice is held by the attempt before it (and needs the
 * user's exit), while a changed choice is a new write. The hold already scopes it to the chain and
 * the account. The params are hashed, so the name fits the SDK's namespace rule (lowercase, 128
 * characters) whatever they hold.
 */
export function writeIntent(action: string, params: Record<string, WriteIntentParam>): string {
  if (!/^[a-z0-9-]{1,40}$/.test(action)) throw new Error(`Invalid write intent action: ${action}`)
  const fields = Object.keys(params).sort().map(key => `${key}=${String(params[key]).toLowerCase()}`)
  return `homerun:intent:${action}:${keccak256(stringToHex(fields.join('\n'))).slice(2)}`
}
