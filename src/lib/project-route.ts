import { notFound } from 'next/navigation'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { displayChainId } from '@/lib/chainDisplay'
import { FUND_CHAIN_IDS } from '@/lib/fund-contracts'

/** `<chainSlug>:<projectId>`, e.g. `op:11`, on a supported chain. Anything else is not a project address. */
export function projectFromUrn(urn: string): { chainId: JBChainId; projectId: string } {
  let decoded: string
  try { decoded = decodeURIComponent(urn) } catch { notFound() }
  const match = /^([a-z]+):([1-9]\d*)$/.exec(decoded)
  if (!match || match[2].length > 78) notFound()
  const chainId = displayChainId(match[1])
  if (chainId === null || !(FUND_CHAIN_IDS as readonly number[]).includes(chainId) || BigInt(match[2]) >= 1n << 256n) notFound()
  return { chainId: chainId as JBChainId, projectId: match[2] }
}

/** The older `<chainId>/<projectId>` form, kept only to forward links to the URN form. */
export function projectFromIds(chainId: string, projectId: string): { chainId: JBChainId; projectId: string } {
  if (!/^[1-9]\d*$/.test(chainId) || !/^[1-9]\d*$/.test(projectId) || projectId.length > 78) notFound()
  const chain = Number(chainId)
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(chain) || BigInt(projectId) >= 1n << 256n) notFound()
  return { chainId: chain as JBChainId, projectId }
}
