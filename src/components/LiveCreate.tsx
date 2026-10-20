'use client'
import { useEffect, useState } from 'react'
import { lazyComponent } from '@/components/lazy-component'
import CreateFlow from './CreateFlow'
import { PanelSkeleton } from '@/components/ui/Skeleton'
import { preloadWhenIdle } from '@/lib/idle-preload'

// The launch machinery shows only on the last step. It loads once the form is idle, so that step opens at once.
const FundDeploy = lazyComponent(() => import('./FundDeploy').then(m => m.FundDeploy), { fallback: () => <PanelSkeleton /> })
const preloadFundDeploy = () => preloadWhenIdle([FundDeploy.preload])

export default function LiveCreate() {
  const [lockedChains, setLockedChains] = useState<readonly number[] | null>(null)
  const [record, setRecord] = useState<string | null>(null)
  useEffect(preloadFundDeploy, [])
  return <CreateFlow lockedChains={lockedChains} onImportRecord={setRecord}
    renderDeploy={values => <FundDeploy values={values} onLockChange={setLockedChains} importedRecord={record} onRecordUsed={() => setRecord(null)} />} />
}
