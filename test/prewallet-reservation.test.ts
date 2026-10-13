import { beforeEach, expect, it } from 'vitest'
import { withPrewalletReservation } from '../src/lib/prewallet-reservation'
import { failReservationReadback } from './support/reservation-storage'

beforeEach(() => localStorage.clear())
it.each([null, 'previous plan'])('restores exactly the pre-wallet state after transient readback failure (%s)', previous => {
  if (previous !== null) localStorage.setItem('reservation', previous)
  const storage = failReservationReadback(localStorage, 'reservation')
  expect(() => withPrewalletReservation(storage, 'reservation', previous, 'new attempt', () => {
    storage.setItem('reservation', 'new attempt'); storage.getItem('reservation')
  })).toThrow('Reservation readback failed')
  expect(localStorage.getItem('reservation')).toBe(previous)
})
it.each([{ replacement: 'replacement attempt' }, { unreadable: true }])('preserves replacement or unreadable recovery after failed reservation (%j)', options => {
  const storage = failReservationReadback(localStorage, 'reservation', options)
  expect(() => withPrewalletReservation(storage, 'reservation', null, 'new attempt', () => {
    storage.setItem('reservation', 'new attempt'); storage.getItem('reservation')
  })).toThrow('could not be cleared safely')
  expect(localStorage.getItem('reservation')).toBe(options.replacement ?? 'new attempt')
})
