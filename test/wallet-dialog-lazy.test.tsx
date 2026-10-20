import { act, useContext, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ loaded: vi.fn() }))

vi.mock('@/providers/ExternalWalletDialog', () => {
  runtime.loaded()
  return { ExternalWalletDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog"><button onClick={onClose}>Close</button></div> }
})
vi.mock('@/components/TransactionReviewProvider', () => ({ TransactionReviewProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/safe-wallet-peer', () => ({ watchSafeWalletPeer: () => () => {} }))
vi.mock('@/lib/query-persist', () => ({ installQueryPersistence: () => () => {} }))

import { Providers } from '@/providers/Providers'
import { WalletAuthContext } from '@/providers/WalletAuthContext'

let host: HTMLDivElement
let root: Root
let requestSignIn: () => Promise<void>

function Probe() {
  requestSignIn = useContext(WalletAuthContext).requestSignIn
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

describe('sign-in dialog loading', () => {
  it('loads the dialog only when sign-in is requested and resolves the request on close', async () => {
    await act(async () => root.render(<Providers><Probe /></Providers>))
    expect(runtime.loaded).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    let resolved = false
    await act(async () => { void requestSignIn().then(() => { resolved = true }) })
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).not.toBeNull())
    expect(runtime.loaded).toHaveBeenCalledTimes(1)

    await act(async () => host.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(resolved).toBe(true)
  })
})
