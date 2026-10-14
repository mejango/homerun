import { createWriteHold } from '@bananapus/nana-sdk-core/review'

/** The one controller around every held wallet write in this app. */
export const holds = createWriteHold()
