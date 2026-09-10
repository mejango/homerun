import type { JBProjectMetadata } from '@bananapus/nana-sdk-core'
import type { CreateValues } from '@/components/CreateFlow'
import { JBCENTER_IPFS_GATEWAY } from './jbcenter-ipfs'

/** Standard Juicebox display metadata with Homerun's descriptive plan extension. */
export function buildFundProjectMetadata(
  values: CreateValues,
  images: { coverImageUri?: string; logoUri?: string } = {},
) {
  for (const uri of [images.coverImageUri, images.logoUri]) {
    if (uri !== undefined && !fundIpfsUrl(uri)) throw new Error('Publish project images to IPFS before saving metadata.')
  }
  const { photo: _photo, ...setup } = values
  const metadata = {
    name: values.name.trim(),
    description: values.description.trim() || undefined,
    coverImageUri: images.coverImageUri,
    logoUri: images.logoUri,
    infoUri: 'https://homerun.money',
  } satisfies JBProjectMetadata
  return {
    ...metadata,
    tokens: { name: `${metadata.name} FUND`, symbol: 'FUND' },
    homerun: {
      version: 1 as const,
      kind: 'fund' as const,
      setup,
      incomeProject: null,
      note: 'Income terms are a future plan. This deployment creates only FUND; it does not enforce an asset purchase, outcome, or income distribution.',
    },
  }
}

export type FundProjectMetadata = {
  name: string | null
  description: string | null
  location: string | null
  coverUrl: string | null
  plan: {
    purchaseBudget: number | null
    opsReserve: number | null
    monthlyRent: number | null
    monthlyCosts: number | null
    operatorFundPercent: number | null
    operatorSplitPercent: number | null
    fundHolderSplitPercent: number | null
  } | null
}

/** Same gateway and bounded path handling as the reference apps' appIpfsUrl. */
export function fundIpfsUrl(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  const suffix = uri.replace(/^ipfs:\/\//i, '')
  const segments = suffix.split('/')
  if (!segments.length || segments.length > 8 || segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z\d._~-]{1,128}$/.test(segment))) return null
  return `${JBCENTER_IPFS_GATEWAY}${segments.map(encodeURIComponent).join('/')}`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null
}

function number(value: unknown, maximum = 1_000_000_000_000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

/** Metadata can describe a plan; it cannot grant permissions or prove a phase. */
export function parseFundProjectMetadata(value: unknown): FundProjectMetadata {
  const metadata = record(value)
  if (!metadata) throw new Error('Project metadata is not a JSON object.')
  const homerun = record(metadata.homerun)
  const setup = homerun?.version === 1 && homerun.kind === 'fund' ? record(homerun.setup) : null
  return {
    name: text(metadata.name, 160),
    description: text(metadata.description, 4_000),
    location: setup ? text(setup.location, 200) : null,
    coverUrl: fundIpfsUrl(metadata.coverImageUri) ?? fundIpfsUrl(metadata.logoUri),
    plan: setup ? {
      purchaseBudget: number(setup.purchaseBudget),
      opsReserve: number(setup.opsReserve),
      monthlyRent: number(setup.monthlyRent),
      monthlyCosts: number(setup.monthlyCosts),
      operatorFundPercent: number(setup.operatorFundPercent, 100),
      operatorSplitPercent: number(setup.operatorSplitPercent, 100),
      fundHolderSplitPercent: number(setup.stickySplitPercent, 100),
    } : null,
  }
}

export async function fetchFundProjectMetadata(uri: string, fetcher: typeof fetch = fetch): Promise<FundProjectMetadata> {
  const url = fundIpfsUrl(uri)
  if (!url) throw new Error('The project metadata URI is unsupported.')
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body) throw new Error('The project details could not be loaded from IPFS.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > 1_000_000) {
        await reader.cancel()
        throw new Error('The project metadata exceeds the supported size.')
      }
      body += decoder.decode(result.value, { stream: true })
    }
    body += decoder.decode()
  } finally { reader.releaseLock() }
  return parseFundProjectMetadata(JSON.parse(body))
}
