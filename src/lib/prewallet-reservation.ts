type ReservationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Synchronous pre-wallet persistence only, under the owner's existing lock. */
export function withPrewalletReservation<T>(storage: ReservationStorage, key: string, previousRaw: string | null, candidateRaw: string, persist: () => T): T {
  if (candidateRaw === previousRaw || storage.getItem(key) !== previousRaw) throw new Error('The saved reservation changed. Reload its recovery before continuing.')
  try { return persist() }
  catch (cause) {
    try {
      const current = storage.getItem(key)
      if (current !== previousRaw) {
        if (current !== candidateRaw) throw new Error('A different reservation is now saved.')
        if (previousRaw === null) storage.removeItem(key)
        else storage.setItem(key, previousRaw)
        if (storage.getItem(key) !== previousRaw) throw new Error('The browser could not verify reservation cleanup.')
      }
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], `${cause instanceof Error ? cause.message : 'Reservation persistence failed.'} The pre-wallet reservation could not be cleared safely. Keep its saved recovery record and reload before continuing.`)
    }
    throw cause
  }
}
