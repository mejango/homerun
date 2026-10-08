import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { FUND_LAUNCH_KEY, encodeLaunchSession, type FundLaunchSession } from '@/lib/fund-launch-session'

const runtime = vi.hoisted(() => ({ run: vi.fn(), navigate: { push: vi.fn(), replace: vi.fn() } }))
vi.mock('@bananapus/nana-sdk-core', async original => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await original()))
vi.mock('next/navigation', () => ({ useRouter: () => runtime.navigate }))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: OWNER }), getPublicClient: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER, isCenterWallet: false }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false }) }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, useSafeConnection: () => false, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/lib/fund-launch-relayr', () => ({ runRelayrLaunch: runtime.run, launchRequestsDead: vi.fn() }))

import { FundDeploy } from '@/components/LiveCreate'

const OWNER = '0x1111111111111111111111111111111111111111' as const
let root: Root
let host: HTMLDivElement
let raw: string
beforeEach(() => {
  const session: FundLaunchSession = {
    version: 1, name: 'House', transport: 'relayr',
    input: { owner: OWNER, sender: OWNER, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: `0x${'12'.repeat(32)}` as Hex, mustStartAtOrAfter: 1_800_000_000, creationFees: { 8453: 0n } },
    statuses: { 8453: { phase: 'unresolved', error: 'Relayr HTTP 500: SimulationReverted' } },
  }
  raw = encodeLaunchSession(session)
  localStorage.setItem(FUND_LAUNCH_KEY, raw)
  runtime.run.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('formats saved failures, progress and runtime errors without changing recovery evidence', async () => {
  await act(async () => root.render(<FundDeploy />))
  expect(host.textContent).toContain('Transaction simulation failed')
  expect(host.textContent).not.toContain('Relayr')
  const waiting = Promise.withResolvers<void>()
  runtime.run.mockImplementation(async ({ onProgress }: { onProgress: (message: string) => void }) => {
    onProgress('Checking Relayr payment')
    await waiting.promise
  })
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Continue creation')!.click())
  expect(host.textContent).toContain('Checking payment')
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBe(raw)
  await act(async () => waiting.reject(Object.assign(new Error('RPC details that must stay private'), { shortMessage: 'Relayr HTTP 503: request unavailable' })))
  expect(host.textContent).toContain('Transaction request failed (HTTP 503): request unavailable')
  expect(host.textContent).not.toMatch(/Relayr|RPC details/)
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBe(raw)
})
