import { describe, expect, it } from 'vitest'
import { BaseError } from 'viem'
import { readableError } from '../src/lib/readable-error'

describe('readableError', () => {
  it('shows viem’s short message, never its request details', () => {
    const error = new BaseError('An unknown RPC error occurred.', { details: 'https://rpc.example/key-secret', metaMessages: ['data: 0xdeadbeef'] })
    expect(error.message).toContain('key-secret')
    expect(readableError(error, 'fallback')).toBe('An unknown RPC error occurred.')
  })
  it('keeps the app’s own sentences and falls back for non-errors', () => {
    expect(readableError(new Error('Refresh and review again.'), 'fallback')).toBe('Refresh and review again.')
    expect(readableError('nope', 'fallback')).toBe('fallback')
  })
})
