import { describe, expect, it, vi } from 'vitest'

/** A CID reads back from the Center it was pinned to, never from another one. */
describe('the Juicebox Center IPFS gateway', () => {
  const gateway = async () => {
    vi.resetModules()
    return (await import('../src/lib/jbcenter-ipfs')).JBCENTER_IPFS_GATEWAY
  }

  it('uses production Center when no endpoint is configured', async () => {
    expect(await gateway()).toBe('https://juicebox.center/ipfs/')
  })

  it('uses the configured Center, so a dev pin is read from dev', async () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'https://dev.juicebox.center')
    expect(await gateway()).toBe('https://dev.juicebox.center/ipfs/')
  })

  it('reads a project pinned to a configured Center from that Center', async () => {
    vi.stubEnv('NEXT_PUBLIC_JBCENTER_URL', 'http://127.0.0.1:3017/')
    vi.resetModules()
    const { fundIpfsUrl } = await import('../src/lib/fund-project-metadata')
    expect(fundIpfsUrl('ipfs://bafyexample')).toBe('http://127.0.0.1:3017/ipfs/bafyexample')
  })
})
