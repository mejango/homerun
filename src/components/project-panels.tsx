'use client'

import { lazyComponent } from '@/components/lazy-component'
import { PanelSkeleton } from '@/components/ui/Skeleton'
import { preloadWhenIdle } from '@/lib/idle-preload'

// Panels that only a non-default project tab shows. Each loads when its tab first opens, behind a skeleton, and all of
// them load once the page is idle (preloadProjectPanels), so a tab opened after that shows at once.
const fallback = () => <PanelSkeleton />
export const IncomeLaunch = lazyComponent(() => import('@/components/IncomeLaunch').then(m => m.IncomeLaunch), { fallback })
export const FundBridgeActions = lazyComponent(() => import('@/components/FundBridgeActions').then(m => m.FundBridgeActions), { fallback })
export const FundOperatorActions = lazyComponent(() => import('@/components/FundOperatorActions').then(m => m.FundOperatorActions), { fallback })
export const ProjectParticipants = lazyComponent(() => import('@/components/ProjectParticipants').then(m => m.ProjectParticipants), { fallback })
export const ProjectPayerAddresses = lazyComponent(() => import('@/components/ProjectPayerAddresses').then(m => m.ProjectPayerAddresses), { fallback })
export const ProjectShop = lazyComponent(() => import('@/components/ProjectShop').then(m => m.ProjectShop), { fallback })
export const ProjectOwnershipEditor = lazyComponent(() => import('@/components/ProjectOwnershipEditor').then(m => m.ProjectOwnershipEditor), { fallback })
export const ProjectPermissionsEditor = lazyComponent(() => import('@/components/ProjectPermissionsEditor').then(m => m.ProjectPermissionsEditor), { fallback })
export const ProjectSplitsEditor = lazyComponent(() => import('@/components/ProjectSplitsEditor').then(m => m.ProjectSplitsEditor), { fallback })
export const IncomeLoanTools = lazyComponent(() => import('@/components/IncomeLoanTools').then(m => m.IncomeLoanTools), { fallback })
export const IncomeBridgeActions = lazyComponent(() => import('@/components/IncomeBridgeActions').then(m => m.IncomeBridgeActions), { fallback })
export const IncomeReservedTokens = lazyComponent(() => import('@/components/IncomeReservedTokens').then(m => m.IncomeReservedTokens), { fallback })
export const IncomeOperatorActions = lazyComponent(() => import('@/components/IncomeOperatorActions').then(m => m.IncomeOperatorActions), { fallback })
export const SiteIntegration = lazyComponent(() => import('@/components/SiteIntegration').then(m => m.SiteIntegration), { fallback })
export const InitialIncomeMint = lazyComponent(() => import('@/components/InitialIncomeMint').then(m => m.InitialIncomeMint), { fallback })

export function preloadProjectPanels() {
  return preloadWhenIdle([
    IncomeLaunch.preload,
    FundBridgeActions.preload,
    FundOperatorActions.preload,
    ProjectParticipants.preload,
    ProjectPayerAddresses.preload,
    ProjectShop.preload,
    ProjectOwnershipEditor.preload,
    ProjectPermissionsEditor.preload,
    ProjectSplitsEditor.preload,
    IncomeLoanTools.preload,
    IncomeBridgeActions.preload,
    IncomeReservedTokens.preload,
    IncomeOperatorActions.preload,
    SiteIntegration.preload,
    InitialIncomeMint.preload,
  ])
}
