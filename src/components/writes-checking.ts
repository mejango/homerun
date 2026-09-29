import { createContext } from 'react'

/** True while this visit's first verified read is still running: forms stay closed and say so on their button. */
export const WritesChecking = createContext(false)
