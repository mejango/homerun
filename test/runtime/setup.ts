import { afterEach, beforeEach, vi } from 'vitest'

function blockedNetworkConstructor(transport: string) {
  return class {
    constructor(url?: string | URL) {
      throw new Error(
        `Unexpected ${transport} connection in unit test: ${String(url ?? 'unknown URL')}`,
      )
    }
  }
}

function installTestGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  })
}

beforeEach(() => {
  // Match the reference Vitest config's clearMocks policy for shared spies.
  vi.clearAllMocks()
  // These are the environment baseline, not temporary test stubs. Recovery
  // tests use unstubAllGlobals() after simulating a broken storage provider;
  // their cleanup must restore jsdom and the network guards instead of
  // exposing Node 26's native globals.
  const browser = (globalThis as unknown as { jsdom?: { window: Window } }).jsdom?.window
  if (browser) {
    installTestGlobal('localStorage', browser.localStorage)
    installTestGlobal('sessionStorage', browser.sessionStorage)
  }
  // React 19 requires test environments to opt into act() semantics
  // explicitly. Every renderer mutation in the component suites is wrapped
  // in act(), so advertise that contract and fail loudly if a future test is
  // not.
  installTestGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobal(
    'fetch',
    vi.fn(async input => {
      throw new Error(
        `Unexpected network request in unit test: ${String(input)}`,
      )
    }),
  )
  installTestGlobal('XMLHttpRequest', blockedNetworkConstructor('XMLHttpRequest'))
  installTestGlobal('WebSocket', blockedNetworkConstructor('WebSocket'))
  installTestGlobal('EventSource', blockedNetworkConstructor('EventSource'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
