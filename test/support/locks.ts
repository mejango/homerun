import { LockLostError, type LockHandle } from '@bananapus/nana-sdk-core/review/locks'

/** A lock still this tab's: every fenced write goes through. */
export const HELD: Pick<LockHandle, 'assertHeld'> = { assertHeld: async () => {} }
/** A lock another tab took meanwhile: every fenced write refuses. */
export const LOST: Pick<LockHandle, 'assertHeld'> = { assertHeld: async () => { throw new LockLostError('test') } }
