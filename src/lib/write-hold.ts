import { createHeldWriteStorage, createWriteHold, type WriteHoldState } from '@bananapus/nana-sdk-core/review'

/** The browser's storage with the tab's memory behind it: every read of a held write goes through it. */
export const heldStorage = createHeldWriteStorage()

/** The one controller around every held wallet write in this app. */
export const holds = createWriteHold({ storage: heldStorage })

/**
 * Whether two hold states show the same: the same record, status, exit, line, warning, notice and
 * reservation. A view that keeps a state it already shows compares through this, so an exit that a
 * later check offers for the same record and status still appears.
 */
export function sameShownHold(a: WriteHoldState, b: WriteHoldState): boolean {
  const shown = (state: WriteHoldState) => JSON.stringify({
    status: state.status, reservation: state.reservation, notice: state.notice,
    ...(state.status === 'clear' ? { settled: state.settled } : {
      record: state.record, exit: state.exit, line: state.line, warning: 'warning' in state ? state.warning : undefined,
    }),
  })
  return shown(a) === shown(b)
}
