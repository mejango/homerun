import { createHeldWriteStorage, createWriteHold } from '@bananapus/nana-sdk-core/review'

/** The browser's storage with the tab's memory behind it: every read of a held write goes through it. */
export const heldStorage = createHeldWriteStorage()

/** The one controller around every held wallet write in this app. */
export const holds = createWriteHold({ storage: heldStorage })
