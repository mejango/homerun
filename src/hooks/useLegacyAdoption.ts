'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * A flow's move of its journal records (and its discovery of existing SDK holds) into the SDK's
 * hold: no send goes out until the latest has finished. `ready` gates the flow's controls and
 * `wait` its final send boundary (a send's `beforeWrite`), which a failed adoption refuses.
 */
export function useLegacyAdoption() {
  const latest = useRef<Promise<void> | null>(null)
  const [ready, setReady] = useState(false)
  const run = useCallback((adopt: () => Promise<void>) => {
    setReady(false)
    const current = (latest.current ?? Promise.resolve()).catch(() => undefined).then(adopt)
    latest.current = current
    void current.then(() => { if (latest.current === current) setReady(true) }, () => undefined)
    return current
  }, [])
  const wait = useCallback(async () => {
    if (!latest.current) throw new Error('Saved transactions are still being checked. Try again in a moment.')
    await latest.current
  }, [])
  return { ready, run, wait }
}
