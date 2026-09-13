import { fundIpfsUrl } from './fund-project-metadata'
import { JBCENTER_IPFS_GATEWAY } from './jbcenter-ipfs'

export type ShopItemMetadata = { name: string | null; description: string | null; image: string | null }

function text(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null
}

function ipfsUrl(value: string): string | null {
  return fundIpfsUrl(value.startsWith(JBCENTER_IPFS_GATEWAY) ? value.slice(JBCENTER_IPFS_GATEWAY.length) : value)
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null
  if (value.startsWith('ipfs://')) return ipfsUrl(value)
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch { return null }
}

/** Item descriptions remain text, and remote metadata reads stay on the app's IPFS gateway. */
export async function readShopItemMetadata(uri: string, fetcher: typeof fetch = fetch): Promise<ShopItemMetadata | null> {
  if (!uri || uri.length > 100_000) return null
  let value: unknown
  if (uri.startsWith('data:application/json,')) {
    value = JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)))
  } else if (uri.startsWith('data:application/json;base64,')) {
    value = JSON.parse(atob(uri.slice('data:application/json;base64,'.length)))
  } else {
    const url = ipfsUrl(uri)
    if (!url) return null
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) throw new Error('Item details could not be loaded.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = '', bytes = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > 1_000_000) {
          await reader.cancel()
          throw new Error('Item details exceed the supported size.')
        }
        body += decoder.decode(result.value, { stream: true })
      }
      body += decoder.decode()
    } finally { reader.releaseLock() }
    value = JSON.parse(body)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const metadata = value as Record<string, unknown>
  return { name: text(metadata.name, 200), description: text(metadata.description, 10_000), image: imageUrl(metadata.image ?? metadata.imageUri) }
}
