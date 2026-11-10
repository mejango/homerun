/** Model native per-name exclusion, including waiters used by persistence repair. */
export function installRecoveryLocks() {
  const held = new Map<string, Promise<void>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, ...args: [options: { ifAvailable?: boolean }, work: (lock: object | null) => Promise<unknown>] | [work: (lock: object | null) => Promise<unknown>]) => {
      // (name, callback) or (name, options, callback), as navigator.locks takes them.
      const [options, work] = args.length === 1 ? [{} as { ifAvailable?: boolean }, args[0]] : args
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
 * reservation pointer, `:settled` settlement and `:settled-by` history and `:released:` and `:exited:` exit markers), and none the user released.
 */
export const recoveryRecords = () => Object.keys(localStorage)
  .filter(key => key.startsWith('nana-sdk:reviewed-write:v') && !/:(latest|settled|settled-by|rejected)$|:(released|exited):/.test(key))
  .map(key => ({ key, record: JSON.parse(localStorage.getItem(key)!) }))
  .filter(({ key, record }) => localStorage.getItem(`${key}:released:${record.id}`) === null)
  .map(({ record }) => record)
