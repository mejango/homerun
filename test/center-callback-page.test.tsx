import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://signa.center'
const ORIGIN = window.location.origin
const CONFIG = {
  issuer: ISSUER,
  audience: 'https://api.signa.center',
  manifest: { id: 'reviewed-base-passkey', revision: `0x${'11'.repeat(32)}` },
  maximumNetworkFee: '100000000000000',
}
const RETURN_KEY = 'homerun:center:return:v1'
const CODE_PATH = `/center/callback?code=abc&state=def&iss=${encodeURIComponent(ISSUER)}`

const mocks = vi.hoisted(() => {
  const payments = { pendingPayment: vi.fn(), refreshPayment: vi.fn(), completePayment: vi.fn() }
  return {
    payments,
    deliver: vi.fn(),
    connect: vi.fn(),
    createClient: vi.fn(),
    signa: { id: 'juicebox-center', uid: 'signa-uid' },
    wagmi: { connectors: [] as { id: string; uid: string }[], state: { current: null as string | null } },
    wallet: { completeConnection: vi.fn(), retryConnection: vi.fn(), payments: () => payments },
  }
})

vi.mock('@bananapus/nana-sdk-connect/core', () => ({
  createCenterWalletClient: mocks.createClient,
  deliverCenterCallback: mocks.deliver,
}))
vi.mock('@wagmi/core', () => ({ connect: mocks.connect }))
vi.mock('@/providers/Providers', () => ({ get wagmiConfig() { return mocks.wagmi } }))
vi.mock('@/providers/wallet-config', () => ({ CENTER_WALLET_CONFIG: CONFIG }))

let host: HTMLDivElement
let root: Root
let replace: ReturnType<typeof vi.fn>
/** What the address bar showed each time the SDK was handed the callback. */
let searchSeenBySdk: string[]

beforeEach(() => {
  mocks.wagmi.connectors = [{ id: 'injected', uid: 'injected-uid' }, mocks.signa]
  mocks.wagmi.state.current = null
  mocks.payments.pendingPayment.mockReturnValue(null)
  mocks.deliver.mockImplementation(async () => {
    searchSeenBySdk.push(document.location.search)
    return false
  })
  mocks.createClient.mockReturnValue(mocks.wallet)
  mocks.wallet.completeConnection.mockResolvedValue({})
  mocks.wallet.retryConnection.mockResolvedValue({})
  searchSeenBySdk = []
  window.sessionStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.history.replaceState(null, '', '/')
  window.sessionStorage.clear()
})

// The page is a fresh load every time: the address bar first, then the page's own modules.
async function load(path: string) {
  window.history.replaceState(null, '', path)
  vi.resetModules()
  return (await import('@/app/center/callback/page')).default
}

// jsdom cannot navigate: watch where the page would send the tab. Everything else is the real address bar.
function watchNavigation() {
  replace = vi.fn()
  vi.stubGlobal('location', {
    get href() { return document.location.href },
    get pathname() { return document.location.pathname },
    get search() { return document.location.search },
    get hash() { return document.location.hash },
    origin: ORIGIN,
    replace,
  })
}

async function openCallback(path: string) {
  const CenterCallbackPage = await load(path)
  watchNavigation()
  // Next's router writes back the URL it booted with, callback data included, as it mounts.
  window.history.replaceState(null, '', path)
  expect(document.location.search).toBe(new URL(path, ORIGIN).search)
  await act(async () => root.render(<CenterCallbackPage />))
}

async function until(condition: () => unknown) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(condition()).toBeTruthy()
}

describe('the Center callback page', () => {
  it('has cleared the code from the address bar again, after the router wrote it back, before the SDK is asked anything', async () => {
    await openCallback(CODE_PATH)
    await until(() => replace.mock.calls.length === 1)

    expect(searchSeenBySdk).toEqual([''])
    expect(document.location.search).toBe('')
    expect(document.location.pathname).toBe('/center/callback')
  })

  it('still finishes a full-page sign-in with the original callback and returns to the saved page', async () => {
    window.sessionStorage.setItem(RETURN_KEY, '/op:11')
    await openCallback(CODE_PATH)
    await until(() => replace.mock.calls.length === 1)

    expect(mocks.wallet.completeConnection).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}${CODE_PATH}`)
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(mocks.wagmi, { connector: mocks.signa })
    expect(replace).toHaveBeenCalledExactlyOnceWith('/op:11')
  })

  it('still hands the original callback to the Homerun page that opened this window', async () => {
    mocks.deliver.mockResolvedValue(true)
    await openCallback(CODE_PATH)
    await until(() => host.querySelector('[role="status"]')?.textContent === 'Done. You can close this window.')

    expect(mocks.deliver).toHaveBeenCalledOnce()
    expect(mocks.deliver.mock.calls[0][0]).toBe(`${ORIGIN}${CODE_PATH}`)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })
})
