import { describe, expect, it, vi } from 'vitest'
import { readShopItemMetadata } from '../src/lib/shop-item-metadata'
import { JBCENTER_IPFS_GATEWAY } from '../src/lib/jbcenter-ipfs'

describe('shop item metadata display', () => {
  it('loads pinned names, text and images through the IPFS gateway', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: 'Weekend stay', description: '<script>plain text</script>', image: 'ipfs://bafyimage' })))
    expect(await readShopItemMetadata('ipfs://bafymetadata', fetcher)).toEqual({ name: 'Weekend stay', description: '<script>plain text</script>', image: `${JBCENTER_IPFS_GATEWAY}bafyimage` })
    expect(fetcher).toHaveBeenCalledWith(`${JBCENTER_IPFS_GATEWAY}bafymetadata`, expect.anything())
  })

  it('does not fetch arbitrary metadata hosts or expose active image URLs', async () => {
    const fetcher = vi.fn()
    expect(await readShopItemMetadata('https://untrusted.example/details', fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readShopItemMetadata(`data:application/json,${encodeURIComponent(JSON.stringify({ name: 'Plain item', image: 'javascript:alert(1)' }))}`)).toEqual({ name: 'Plain item', description: null, image: null })
  })

  it('rejects oversized remote metadata before parsing it', async () => {
    const fetcher = vi.fn(async () => new Response(' '.repeat(1_000_001)))
    await expect(readShopItemMetadata('ipfs://bafyhuge', fetcher)).rejects.toThrow('supported size')
  })
})
