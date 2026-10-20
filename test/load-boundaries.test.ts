import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect(staticImports('src/providers/preload-center.ts')).not.toContain('./ExternalWalletDialog')
    expect(staticImports('src/components/WalletButton.tsx')).not.toContain('./SignedInWallet')
  })

  it('keeps the demo page out of live project modules', () => {
    for (const path of ['src/components/FundProject.tsx', 'src/components/IncomeProject.tsx', 'src/components/ProjectAddress.tsx', 'src/app/[urn]/loading.tsx']) {
      expect(staticImports(path), path).not.toContain('@/components/ProjectPage')
    }
  })

  it('keeps the launch machinery off the create form', () => {
    expect(staticImports('src/components/LiveCreate.tsx')).not.toContain('./FundDeploy')
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
    for (const panel of panels) {
      expect(panelSource, `${panel} loads lazily`).toContain(`lazyComponent(() => import('@/components/${panel}')`)
      expect(panelSource, `${panel} preloads`).toContain(`${panel}.preload,`)
    }
  })

  // A failed chunk must show the reload state, so every lazy load goes through lazyComponent.
  it('loads every lazy component through lazyComponent', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
    for (const path of walk('src').filter(path => path !== join('src', 'components', 'lazy-component.tsx'))) {
      expect(source(path), path).not.toMatch(/from ['"]next\/dynamic['"]|\blazy\(\s*\(\)/)
    }
  })
})
