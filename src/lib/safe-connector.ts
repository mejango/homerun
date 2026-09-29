'use client'

import type { Config } from 'wagmi'
import { getAccount } from 'wagmi/actions'

export {
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  safeQueueUrl,
  safeServiceBase,
  swapDeadline,
  waitForSafeExecutionHash,
} from '@bananapus/nana-sdk-core/safe-service'

export function isSafeConnection(config: Config): boolean {
  try {
    const connector = getAccount(config).connector
    return `${connector?.id ?? ''} ${connector?.name ?? ''}`
      .toLowerCase()
      .includes('safe')
  } catch {
    return false
  }
}
