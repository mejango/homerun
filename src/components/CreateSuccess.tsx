'use client'

import { useEffect, useState } from 'react'
import { loadLaunchSession, type FundLaunchSession } from '@/lib/fund-launch-session'
import { displayChainName } from '@/lib/chainDisplay'

export default function CreateSuccess() {
  const [session, setSession] = useState<FundLaunchSession | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    try {
      const saved = loadLaunchSession()
      if (saved && saved.input.chainIds.every(id => saved.statuses[id].phase === 'confirmed')) setSession(saved)
    } catch { setSession(null) } finally { setLoaded(true) }
  }, [])
  if (!loaded) return <p role="status">Checking your project…</p>
  if (!session) return <section>
    <h1 className="text-4xl sm:text-5xl">Check your deployment</h1>
    <p className="my-6">There is no completed launch saved in this browser.</p>
    <a className="create-primary" href="/create/recover">Resume creation</a>
  </section>
  const chainId = session.input.chainIds[0]
  return <section aria-labelledby="creation-success-title">
    <p className="mb-4 text-lg" role="status">Project created successfully</p>
    <h1 id="creation-success-title" className="text-4xl sm:text-6xl">{session.name} is ready.</h1>
    <p className="my-6">Your FUND raise is live on {session.input.chainIds.map(displayChainName).join(', ')}.</p>
    <a className="create-primary" href={`/project/${chainId}/${session.statuses[chainId].projectId}`}>View project on Homerun ↗</a>
  </section>
}
