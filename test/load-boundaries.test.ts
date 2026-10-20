import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// What a page loads up front is set by its static imports. These pin the boundaries the route budget gate measured
// (npm run budget), so a later edit that pulls a lazy module back in fails here with the file that did it.
const source = (path: string) => readFileSync(path, 'utf8')
const staticImports = (path: string) =>
  [...source(path).matchAll(/^import\s(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1])

describe('load boundaries', () => {
  it('keeps the layout transport apart from the Center public client', () => {
    expect(source('src/lib/jbcenter-rpc.ts')).not.toMatch(/createPublicClient/)
    expect(staticImports('src/providers/Providers.tsx')).not.toContain('@/lib/jbcenter-public-client')
  })

  it('loads the sign-in dialog and the account menu on use', () => {
    expect(staticImports('src/providers/Providers.tsx')).not.toContain('./ExternalWalletDialog')
    expect(staticImports('src/components/WalletButton.tsx')).not.toContain('./SignedInWallet')
  })

  it('keeps the demo page out of live project modules', () => {
    for (const path of ['src/components/FundProject.tsx', 'src/components/IncomeProject.tsx', 'src/components/ProjectAddress.tsx', 'src/app/[urn]/loading.tsx']) {
      expect(staticImports(path), path).not.toContain('@/components/ProjectPage')
    }
  })

  it('loads tab-only panels through project-panels', () => {
    const panels = ['IncomeLaunch', 'FundBridgeActions', 'FundOperatorActions', 'ProjectParticipants', 'ProjectPayerAddresses', 'ProjectShop',
      'ProjectOwnershipEditor', 'ProjectPermissionsEditor', 'ProjectSplitsEditor', 'IncomeLoanTools', 'IncomeBridgeActions',
      'IncomeReservedTokens', 'IncomeOperatorActions', 'InitialIncomeMint', 'SiteIntegration']
    for (const path of ['src/components/FundProject.tsx', 'src/components/IncomeProject.tsx', 'src/components/live-transactions.tsx', 'src/components/ProjectPage.tsx']) {
      const imports = staticImports(path)
      for (const panel of panels) expect(imports.some(name => name.endsWith(`/${panel}`)), `${path} imports ${panel}`).toBe(false)
    }
    const panelSource = source('src/components/project-panels.tsx')
    for (const panel of panels) expect(panelSource, `${panel} preloads`).toContain(`() => import('@/components/${panel}'),`)
  })
})
