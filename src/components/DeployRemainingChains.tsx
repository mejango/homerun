'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { DeployChains } from '@/components/DeployChains'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { decodeFundIntent } from '@/lib/fund-intent'
import { findProjectIntent } from '@/lib/fund-intent-lookup'
import { loadLaunchSession } from '@/lib/fund-launch-session'

/** The creator's own browser knows the intent; a link says it; otherwise Center is asked. */
export function DeployRemainingChains({ chainId, projectId, owner, intentId }: {
  chainId: number
  projectId: string
  owner?: Address
  intentId?: string
}) {
  const [saved, setSaved] = useState<string | undefined>(undefined)
  useEffect(() => { try { setSaved(loadLaunchSession()?.intentId) } catch { setSaved(undefined) } }, [])
  const intent = useQuery({
    queryKey: ['project-intent', chainId, projectId, intentId ?? null, saved ?? null, owner ?? null],
    staleTime: 60_000,
    retry: 1,
    queryFn: ({ signal }) => findProjectIntent(jbCenterClient, { chainId, projectId }, [intentId, saved], owner, { signal }),
  })
  if (!intent.data) return null
  let chainIds: number[]
  try { chainIds = decodeFundIntent(intent.data).chainIds } catch { return null }
  if (chainIds.every(id => intent.data!.deployments.some(row => row.chainId === id))) return null
  return <DeployChains intent={intent.data} heading="Also deploy on" chainIds={chainIds} onDeployed={() => void intent.refetch()} />
}
