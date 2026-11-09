import type { Address } from 'viem'
import { loadLaunchSession } from './fund-launch-session'
import { browserLocks } from '@bananapus/nana-sdk-core/review/locks'

/** One durable active launch plus sorted per-signer nonce locks across browser tabs. */
export async function withForwarderAuthorizationLock<T>({ account, chainIds, owner, execute }: {
  account: Address; chainIds: number[]; owner: `launch:${string}`;
  execute: (assertAvailable: (destinations?: number[]) => void) => Promise<T>
}): Promise<T> {
  const chains = [...new Set(chainIds)].sort((a, b) => a - b)
  const assertAvailable = (destinations = chains) => {
    if (destinations.some(chain => !chains.includes(chain))) throw new Error('The authorization destinations changed.')
    const launch = loadLaunchSession()
    if (!launch || `launch:${launch.input.salt}` !== owner || launch.input.sender.toLowerCase() !== account.toLowerCase()) throw new Error('The saved launch or signing wallet changed. Resume its original record.')
  }
  const lock = async (index: number): Promise<T> => index === chains.length ? execute(assertAvailable)
    : browserLocks().request(`homerun:forwarder:${account.toLowerCase()}:${chains[index]}`, { ifAvailable: true }, held => {
      if (!held) throw new Error('Another tab is using this wallet’s launch authorization. Wait for it to finish.')
      return lock(index + 1)
    })
  return lock(0)
}
