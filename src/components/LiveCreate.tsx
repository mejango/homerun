'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import CreateFlow from './CreateFlow'
import { PanelSkeleton } from '@/components/ui/Skeleton'
import { preloadWhenIdle } from '@/lib/idle-preload'

// The launch machinery shows only on the last step. It loads once the form is idle, so that step opens at once.
const FundDeploy = dynamic(() => import('./FundDeploy').then(m => m.FundDeploy), { loading: () => <PanelSkeleton /> })
const preloadFundDeploy = () => preloadWhenIdle([() => import('./FundDeploy')])

export default function LiveCreate() {
  const [lockedChains, setLockedChains] = useState<readonly number[] | null>(null)
  const [record, setRecord] = useState<string | null>(null)
  useEffect(preloadFundDeploy, [])
  return <CreateFlow lockedChains={lockedChains} onImportRecord={setRecord}
    renderDeploy={values => <FundDeploy values={values} onLockChange={setLockedChains} importedRecord={record} onRecordUsed={() => setRecord(null)} />} />
}
