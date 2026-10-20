'use client'

import dynamic from 'next/dynamic'
import { PanelSkeleton } from '@/components/ui/Skeleton'
import { preloadWhenIdle } from '@/lib/idle-preload'

// Panels that only a non-default project tab shows. Each loads when its tab first opens, behind a skeleton, and all of
// them load once the page is idle (preloadProjectPanels), so a tab opened after that shows at once.
const loading = () => <PanelSkeleton />
export const IncomeLaunch = dynamic(() => import('@/components/IncomeLaunch').then(m => m.IncomeLaunch), { loading })
export const FundBridgeActions = dynamic(() => import('@/components/FundBridgeActions').then(m => m.FundBridgeActions), { loading })
export const FundOperatorActions = dynamic(() => import('@/components/FundOperatorActions').then(m => m.FundOperatorActions), { loading })
export const ProjectParticipants = dynamic(() => import('@/components/ProjectParticipants').then(m => m.ProjectParticipants), { loading })
export const ProjectPayerAddresses = dynamic(() => import('@/components/ProjectPayerAddresses').then(m => m.ProjectPayerAddresses), { loading })
export const ProjectShop = dynamic(() => import('@/components/ProjectShop').then(m => m.ProjectShop), { loading })
export const ProjectOwnershipEditor = dynamic(() => import('@/components/ProjectOwnershipEditor').then(m => m.ProjectOwnershipEditor), { loading })
export const ProjectPermissionsEditor = dynamic(() => import('@/components/ProjectPermissionsEditor').then(m => m.ProjectPermissionsEditor), { loading })
export const ProjectSplitsEditor = dynamic(() => import('@/components/ProjectSplitsEditor').then(m => m.ProjectSplitsEditor), { loading })
export const IncomeLoanTools = dynamic(() => import('@/components/IncomeLoanTools').then(m => m.IncomeLoanTools), { loading })
export const IncomeBridgeActions = dynamic(() => import('@/components/IncomeBridgeActions').then(m => m.IncomeBridgeActions), { loading })
export const IncomeReservedTokens = dynamic(() => import('@/components/IncomeReservedTokens').then(m => m.IncomeReservedTokens), { loading })
export const IncomeOperatorActions = dynamic(() => import('@/components/IncomeOperatorActions').then(m => m.IncomeOperatorActions), { loading })
export const SiteIntegration = dynamic(() => import('@/components/SiteIntegration').then(m => m.SiteIntegration), { loading })
export const InitialIncomeMint = dynamic(() => import('@/components/InitialIncomeMint').then(m => m.InitialIncomeMint), { loading })

export function preloadProjectPanels() {
  return preloadWhenIdle([
    () => import('@/components/IncomeLaunch'),
    () => import('@/components/FundBridgeActions'),
    () => import('@/components/FundOperatorActions'),
    () => import('@/components/ProjectParticipants'),
    () => import('@/components/ProjectPayerAddresses'),
    () => import('@/components/ProjectShop'),
    () => import('@/components/ProjectOwnershipEditor'),
    () => import('@/components/ProjectPermissionsEditor'),
    () => import('@/components/ProjectSplitsEditor'),
    () => import('@/components/IncomeLoanTools'),
    () => import('@/components/IncomeBridgeActions'),
    () => import('@/components/IncomeReservedTokens'),
    () => import('@/components/IncomeOperatorActions'),
    () => import('@/components/InitialIncomeMint'),
    () => import('@/components/SiteIntegration'),
  ])
}
