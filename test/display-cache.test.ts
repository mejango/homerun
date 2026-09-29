// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadDisplayCache, saveDisplayCache } from '../src/lib/display-cache'

describe('display cache', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips bigints and plain values', () => {
    saveDisplayCache('k', { supply: 10n ** 30n, nested: [{ balance: 7n }], name: 'x', none: null })
    expect(loadDisplayCache('k')).toEqual({ supply: 10n ** 30n, nested: [{ balance: 7n }], name: 'x', none: null })
  })
  it('returns null for a missing or corrupt entry', () => {
    expect(loadDisplayCache('missing')).toBeNull()
    localStorage.setItem('homerun:display-cache:v1:bad', '{')
    expect(loadDisplayCache('bad')).toBeNull()
  })
})
