/** Model native per-name exclusion, including waiters used by persistence repair. */
export function installRecoveryLocks() {
  const held = new Map<string, Promise<void>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, options: { ifAvailable?: boolean }, work: (lock: object | null) => Promise<unknown>) => {
      if (options.ifAvailable && held.has(name)) return work(null)
      while (held.has(name)) await held.get(name)
      let release!: () => void
      const done = new Promise<void>(resolve => { release = resolve })
      held.set(name, done)
      try { return await work({ name }) }
      finally { held.delete(name); release() }
    },
  } })
}

export const recoveryRecords = () => Object.keys(localStorage)
  .filter(key => key.startsWith('nana-sdk:reviewed-write:'))
  .map(key => JSON.parse(localStorage.getItem(key)!))
