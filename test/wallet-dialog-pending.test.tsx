import { act, useContext, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  return { gate, release: () => release() }
})

vi.mock('@/providers/ExternalWalletDialog', async () => {
  await runtime.gate
  return { ExternalWalletDialog: () => <div role="dialog" /> }
})
vi.mock('@/components/TransactionReviewProvider', () => ({ TransactionReviewProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/safe-wallet-peer', () => ({ watchSafeWalletPeer: () => () => {} }))
vi.mock('@/lib/query-persist', () => ({ installQueryPersistence: () => () => {} }))

import { Providers } from '@/providers/Providers'
import { WalletAuthContext } from '@/providers/WalletAuthContext'

let host: HTMLDivElement
let root: Root
let auth: { requestSignIn: () => Promise<void>; signInPending: boolean }

function Probe() {
  auth = useContext(WalletAuthContext)
  return null
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('sign-in requested while the dialog code loads', () => {
  it('shows it is pending, and Escape cancels so the dialog never opens over what came next', async () => {
    await act(async () => root.render(<Providers><Probe /></Providers>))
    let resolved = false
    await act(async () => { void auth.requestSignIn().then(() => { resolved = true }) })
    expect(auth.signInPending).toBe(true)

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(auth.signInPending).toBe(false)
    expect(resolved).toBe(true)

    await act(async () => runtime.release())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})
