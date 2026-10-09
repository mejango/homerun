/** Fail only after the candidate was durably written, before its caller receives it. */
export function failReservationReadback(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, target: string, options: { replacement?: string; unreadable?: boolean } = {}) {
  let written = false, failed = false
  return {
    getItem(key: string) {
      if (key === target && written && (!failed || options.unreadable)) {
        failed = true
        if (options.replacement !== undefined) storage.setItem(key, options.replacement)
        throw new Error('Reservation readback failed')
      }
      return storage.getItem(key)
    },
    setItem(key: string, raw: string) { storage.setItem(key, raw); if (key === target) written = true },
    removeItem(key: string) { storage.removeItem(key) },
  }
}
