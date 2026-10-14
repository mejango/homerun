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

/**
 * The held writes saved now: each record, without the SDK's markers beside it (its `:latest`
 * reservation pointer, `:settled` settlement and `:released:` exit markers), and none the user released.
 */
export const recoveryRecords = () => Object.keys(localStorage)
  .filter(key => key.startsWith('nana-sdk:reviewed-write:v') && !/:(latest|settled)$|:released:/.test(key))
  .map(key => ({ key, record: JSON.parse(localStorage.getItem(key)!) }))
  .filter(({ key, record }) => localStorage.getItem(`${key}:released:${record.id}`) === null)
  .map(({ record }) => record)
