import { describe, expect, it } from 'vitest'
import { centerWalletConfiguration } from '../src/providers/wallet-config'
import { centerBuildEnv } from './support/browser-suites.mjs'

describe('the Center build that test:center runs against', () => {
  it('is an enabled wallet configuration the app accepts, with the default issuer and audience', () => {
    const configuration = centerWalletConfiguration({
      enabled: centerBuildEnv.NEXT_PUBLIC_CENTER_WALLET_ENABLED,
      manifestId: centerBuildEnv.NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID,
      manifestRevision: centerBuildEnv.NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION,
      maximumNetworkFee: centerBuildEnv.NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI,
    })
    expect(configuration).toMatchObject({ issuer: 'https://signa.center', audience: 'https://api.signa.center' })
  })
})
