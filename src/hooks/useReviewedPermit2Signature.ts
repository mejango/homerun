'use client'

import { getAccount } from '@wagmi/core'
import { useCallback } from 'react'
import { useConfig, useSignTypedData, useSwitchChain } from 'wagmi'
import {
  permit2TypedData,
  type Permit2SignatureAuthorization,
} from '@bananapus/nana-sdk-core/v6/permit2'
import { requireTransactionReview } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import type { Address } from 'viem'

export function useReviewedPermit2Signature(options?: {
  reviewedInParent?: boolean
}) {
  const config = useConfig()
  const { signTypedDataAsync } = useSignTypedData()
  const { switchChainAsync } = useSwitchChain()

  const signPermit2Async = useCallback(
    async ({
      authorization,
      expectedAccount,
    }: {
      authorization: Permit2SignatureAuthorization
      expectedAccount: Address
    }) => {
      assertNoViewAs()
      const typedData = permit2TypedData(authorization)
      if (!options?.reviewedInParent) {
        await requireTransactionReview({
          title: 'Sign the swap authorization',
          calls: [],
          kind: 'authorization',
          authorization: typedData,
        })
      }
      assertNoViewAs()
      let current = getAccount(config)
      if (
        !current.address ||
        current.address.toLowerCase() !== expectedAccount.toLowerCase()
      ) {
        throw new Error('Connected account changed. Review the payment again.')
      }
      if (current.chainId !== authorization.chainId) {
        await switchChainAsync({ chainId: authorization.chainId })
      }
      current = getAccount(config)
      if (
        !current.address ||
        current.address.toLowerCase() !== expectedAccount.toLowerCase() ||
        current.chainId !== authorization.chainId
      ) {
        throw new Error('Wallet account or network changed. Review the payment again.')
      }
      assertNoViewAs()
      const signature = await signTypedDataAsync({
        account: expectedAccount,
        ...typedData,
      })
      assertNoViewAs()
      const after = getAccount(config)
      if (
        !after.address ||
        after.address.toLowerCase() !== expectedAccount.toLowerCase() ||
        after.chainId !== authorization.chainId
      ) {
        throw new Error('Wallet account or network changed after signing. Nothing was sent.')
      }
      return signature
    },
    [config, options?.reviewedInParent, signTypedDataAsync, switchChainAsync],
  )

  return { signPermit2Async }
}
