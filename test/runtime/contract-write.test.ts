import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { assertReviewedAccountConnected, REVIEWED_ACCOUNT_CHANGED } from '@/lib/contract-write'
import { VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const CHECKSUMMED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' as Address

it('says how to send while viewing as another account, in two plain sentences', () => {
  expect(VIEW_AS_WRITE_BLOCKED).toBe("You're viewing the site as another account. Exit View as to transact.")
})

describe('the reviewed account', () => {
  it('matches the connected account in any letter case', () => {
    expect(() =>
      assertReviewedAccountConnected(CHECKSUMMED, CHECKSUMMED.toLowerCase() as Address),
    ).not.toThrow()
  })

  it('refuses another account, or none, plainly', () => {
    expect(() => assertReviewedAccountConnected(ALICE, BOB)).toThrow(
      'The connected account changed. Review again.',
    )
    expect(() => assertReviewedAccountConnected(ALICE, undefined)).toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(() => assertReviewedAccountConnected(ALICE, BOB, 'Review the batch again.')).toThrow(
      'Review the batch again.',
    )
  })
})
