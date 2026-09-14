'use client'
import { createContext, useContext } from 'react'
export const WalletAuthContext = createContext({ requestSignIn: () => {} })
export const useWalletAuth = () => useContext(WalletAuthContext)
