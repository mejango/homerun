import { describe, expect, it, vi } from 'vitest'
import { buildFundProjectMetadata, fetchFundProjectMetadata, fundIpfsUrl, parseFundProjectMetadata } from '../src/lib/fund-project-metadata'
import { CREATE_DEFAULTS } from '../web/create-model.mjs'
import type { CreateValues } from '../src/components/CreateFlow'

describe('FUND project metadata stays descriptive', () => {
  it('publishes the standard cover field and preserves the plan without the local photo payload', () => {
    const values = { ...CREATE_DEFAULTS, name: ' Founder Haus ', description: ' A place to build. ', photo: 'data:image/png;base64,local-only' } as CreateValues
    const metadata = buildFundProjectMetadata(values, { coverImageUri: 'ipfs://bafycover', logoUri: 'ipfs://bafylogo' })
    expect(metadata).toMatchObject({ name: 'Founder Haus', description: 'A place to build.', coverImageUri: 'ipfs://bafycover', logoUri: 'ipfs://bafylogo', homerun: { version: 1, kind: 'fund', incomeProject: null } })
    expect(metadata.homerun.setup).not.toHaveProperty('photo')
    expect(JSON.stringify(metadata)).not.toContain('local-only')
    expect(parseFundProjectMetadata(metadata)).toMatchObject({ name: 'Founder Haus', coverUrl: 'https://juicebox.center/ipfs/bafycover', plan: { purchaseBudget: values.purchaseBudget } })
  })

  it('rejects unpublished local or external cover images', () => {
    for (const coverImageUri of ['blob:https://homerun.money/photo', 'data:image/png;base64,picture', 'https://tracker.example/image']) {
      expect(() => buildFundProjectMetadata(CREATE_DEFAULTS as CreateValues, { coverImageUri })).toThrow('IPFS')
    }
  })

  it('accepts the published Homerun plan without granting permissions or a lifecycle status', () => {
    const result = parseFundProjectMetadata({
      name: 'Founder Haus',
      description: 'A place to build.',
      owner: '0x0000000000000000000000000000000000000001',
      phase: 'successful',
      homerun: { version: 1, kind: 'fund', setup: { location: 'Florianópolis', purchaseBudget: 500_000, opsReserve: 100_000, monthlyRent: 10_000, monthlyCosts: 6_000, operatorFundPercent: 20, operatorSplitPercent: 70, stickySplitPercent: 10 } },
    })
    expect(result.name).toBe('Founder Haus')
    expect(result.plan?.fundHolderSplitPercent).toBe(10)
    expect(result).not.toHaveProperty('owner')
    expect(result).not.toHaveProperty('phase')
    expect(result).not.toHaveProperty('permissions')
  })

  it('does not interpret unknown metadata versions or project kinds as a Homerun plan', () => {
    expect(parseFundProjectMetadata({ homerun: { version: 2, kind: 'fund', setup: {} } }).plan).toBeNull()
    expect(parseFundProjectMetadata({ homerun: { version: 1, kind: 'income', setup: {} } }).plan).toBeNull()
  })

  it('rejects invalid model values without fabricating zero estimates', () => {
    const plan = parseFundProjectMetadata({ homerun: { version: 1, kind: 'fund', setup: { purchaseBudget: -1, opsReserve: Infinity, monthlyRent: '10000', monthlyCosts: 0, operatorFundPercent: 101 } } }).plan
    expect(plan).toMatchObject({ purchaseBudget: null, opsReserve: null, monthlyRent: null, monthlyCosts: 0, operatorFundPercent: null })
  })

  it('routes only safe IPFS paths to the reference gateway', () => {
    expect(fundIpfsUrl('ipfs://bafyexample/project.json')).toBe('https://juicebox.center/ipfs/bafyexample/project.json')
    for (const uri of ['javascript:alert(1)', 'https://example.com/track', 'ipfs://cid/../private', 'ipfs://cid/%2e%2e/private', 'data:image/svg+xml,<svg/>']) expect(fundIpfsUrl(uri)).toBeNull()
  })

  it('does not allow arbitrary image origins through project metadata', () => {
    expect(parseFundProjectMetadata({ logoUri: 'https://tracker.example/image' }).coverUrl).toBeNull()
    expect(parseFundProjectMetadata({ coverImageUri: 'https://tracker.example/image' }).coverUrl).toBeNull()
  })

  it('uses the standard cover field while supporting older logo-only Homerun pins', () => {
    expect(parseFundProjectMetadata({ coverImageUri: 'ipfs://bafycover', logoUri: 'ipfs://bafylogo' }).coverUrl).toBe('https://juicebox.center/ipfs/bafycover')
    expect(parseFundProjectMetadata({ logoUri: 'ipfs://bafylogo' }).coverUrl).toBe('https://juicebox.center/ipfs/bafylogo')
  })

  it('bounds text fields and rejects nonobject JSON', () => {
    expect(parseFundProjectMetadata({ name: 'a'.repeat(200), description: 'b'.repeat(5000) })).toMatchObject({ name: 'a'.repeat(160), description: 'b'.repeat(4000) })
    expect(() => parseFundProjectMetadata([])).toThrow('JSON object')
  })

  it('fetches only the onchain URI through the configured IPFS gateway', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ name: 'Live project' })))
    expect((await fetchFundProjectMetadata('ipfs://bafyexample', fetcher)).name).toBe('Live project')
    expect(fetcher.mock.calls[0][0]).toBe('https://juicebox.center/ipfs/bafyexample')
    expect(fetcher.mock.calls[0][1]?.signal).toBeDefined()
  })

  it('bounds the received body rather than trusting Content-Length', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001), { headers: { 'Content-Length': '1' } }))
    await expect(fetchFundProjectMetadata('ipfs://bafyexample', fetcher)).rejects.toThrow('supported size')
  })

  it('reports gateway failures and never substitutes prototype metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: 503 }))
    await expect(fetchFundProjectMetadata('ipfs://bafyexample', fetcher)).rejects.toThrow('could not be loaded')
  })
})
