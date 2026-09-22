import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import type { Hex } from 'viem'
import { RELAY_HELD_KEY, holdDeployment, loadHeldDeployments, releaseDeployment } from '../src/lib/relay-held'

const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const other = '4f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const hash = `0x${'ab'.repeat(32)}` as Hex

/** One viewer's own storage, and nothing else: no window, no network, no share. */
function fakeStorage() {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

test('a created project this browser holds survives a reload, and is released once recorded', () => {
  const storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  holdDeployment(intentId, { chainId: 1, projectId: '7', transactionHash: hash })
  holdDeployment(other, { chainId: 1, projectId: '9', transactionHash: hash })
  // A reload reads the same record back, for this intent alone.
  assert.deepEqual([...loadHeldDeployments(intentId)], [[1, { chainId: 1, projectId: '7', transactionHash: hash }]])
  holdDeployment(intentId, { chainId: 1, projectId: '8', transactionHash: hash })
  assert.equal(loadHeldDeployments(intentId).get(1)?.projectId, '8')
  releaseDeployment(intentId, 1)
  assert.equal(loadHeldDeployments(intentId).size, 0)
  assert.equal(loadHeldDeployments(other).size, 1)
  releaseDeployment(other, 1)
  assert.equal(storage.getItem(RELAY_HELD_KEY), null)
})

test('nothing unreadable is held or read back', () => {
  const storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
  storage.setItem(RELAY_HELD_KEY, JSON.stringify([
    { intentId, chainId: 1, projectId: '7', transactionHash: hash },
    { intentId, chainId: 10, projectId: 'seven', transactionHash: hash },
    { intentId, chainId: 8453, projectId: '7', transactionHash: '0xnope' },
    { intentId: 'not-an-intent', chainId: 1, projectId: '7', transactionHash: hash },
    null,
  ]))
  assert.deepEqual([...loadHeldDeployments(intentId).keys()], [1])
  holdDeployment('not-an-intent', { chainId: 1, projectId: '7', transactionHash: hash })
  assert.deepEqual([...loadHeldDeployments('not-an-intent').keys()], [])
  storage.setItem(RELAY_HELD_KEY, 'not json')
  assert.equal(loadHeldDeployments(intentId).size, 0)
})

test('a browser that keeps no storage holds nothing and reads nothing', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('storage is blocked') },
    setItem: () => { throw new Error('storage is blocked') },
    removeItem: () => { throw new Error('storage is blocked') },
  })
  assert.equal(loadHeldDeployments(intentId).size, 0)
  holdDeployment(intentId, { chainId: 1, projectId: '7', transactionHash: hash })
  releaseDeployment(intentId, 1)
})
