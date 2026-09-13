import { jbControllerAbi, jbDirectoryAbi, jbPermissionsAbi, jbProjectsAbi, revOwnerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { JBPermissionIdsV6, v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import { fundIpfsUrl } from './fund-project-metadata'
import { jbCenterIpfs, JBCENTER_MAX_IMAGE_BYTES, type JBCenterIpfsClient } from './jbcenter-ipfs'

const MAX_METADATA_BYTES = 1_000_000
const textLimits = { name: 160, description: 4_000, location: 200, assetType: 80, revenueDescription: 4_000, minimumRevenueConsequences: 2_000, ownerName: 80, ownerIntroduction: 1_200, ownerWallet: 42, operatorName: 80, operatorIntroduction: 1_200, operatorWallet: 42 } as const
const numericLimits = { monthlyRent: 1_000_000_000_000, monthlyCosts: 1_000_000_000_000, minimumRevenue: 1_000_000_000_000, rentGrowthPercent: 100, costGrowthPercent: 100 } as const
export type MetadataField = keyof typeof textLimits | keyof typeof numericLimits
export type ProjectMetadataDraft = Record<MetadataField, string>
export type MetadataImageKey = 'cover' | 'logo' | 'owner' | 'operator'
export type ProjectMetadataImages = Partial<Record<MetadataImageKey, { file?: File; remove?: boolean }>>
export type ProjectMetadataEditState = {
  chainId: JBChainId; projectId: bigint; account: Address; owner: Address; controller: Address
  projectUri: string; canEdit: boolean; blockNumber: bigint; blockHash: Hex
}
export type ProjectMetadataDocument = {
  raw: Record<string, unknown>; draft: ProjectMetadataDraft; supportsPlan: boolean; needsInheritance: boolean
  images: Record<MetadataImageKey, string | null>
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown) => typeof value === 'string' ? value : ''
const numberText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : ''

/** Read the actual NFT owner and its permission table; never infer authority from URI profiles. */
export async function readProjectMetadataEditState(client: PublicClient, { chainId, projectId, account }: { chainId: number; projectId: bigint; account: Address }): Promise<ProjectMetadataEditState> {
  if (!Number.isSafeInteger(chainId) || projectId <= 0n || projectId >= 1n << 256n || !isAddress(account) || isAddressEqual(account, zeroAddress)) throw new Error('A supported project and connected account are required.')
  if ((client.chain && client.chain.id !== chainId) || await client.getChainId() !== chainId) throw new Error('The RPC endpoint returned a different chain.')
  const chain = chainId as JBChainId
  const controller = v6Address('JBController', chain)
  const block = await client.getBlock({ blockTag: 'latest' })
  if (block.number === null || !block.hash) throw new Error('A confirmed snapshot block is required.')
  const at = { blockNumber: block.number }
  const [owner, currentController, projectUri] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', chain), abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
    client.readContract({ address: v6Address('JBDirectory', chain), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'uriOf', args: [projectId], ...at }),
  ])
  if (isAddressEqual(owner, zeroAddress) || !isAddressEqual(currentController, controller)) throw new Error('This project does not use the registered V6 controller.')
  const revOwner = v6Address('REVOwner', chain)
  if (isAddressEqual(owner, revOwner)) {
    const ownerController = await client.readContract({ address: revOwner, abi: revOwnerAbi, functionName: 'CONTROLLER', ...at })
    if (!isAddressEqual(ownerController, controller)) throw new Error('The revnet owner uses an unsupported controller.')
  }
  const canEdit = isAddressEqual(account, owner) || await client.readContract({ address: v6Address('JBPermissions', chain), abi: jbPermissionsAbi, functionName: 'hasPermission', args: [account, owner, projectId, BigInt(JBPermissionIdsV6.SET_PROJECT_URI), true, true], ...at })
  const confirmed = await client.getBlock({ blockNumber: block.number })
  if (confirmed.hash !== block.hash) throw new Error('The chain changed while reading project details. Refresh and try again.')
  return { chainId: chain, projectId, account: getAddress(account), owner, controller, projectUri, canEdit, blockNumber: block.number, blockHash: block.hash }
}

/** IPFS JSON is loaded intact so unrelated extensions and launch facts survive every edit. */
export async function readProjectMetadataDocument(uri: string, fetcher: typeof fetch = fetch): Promise<ProjectMetadataDocument> {
  let raw: Record<string, unknown> = {}
  if (uri) {
    const url = fundIpfsUrl(uri)
    if (!url) throw new Error('The current metadata URI is unsupported. Its contents must be preserved before editing.')
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) throw new Error('The current project details could not be loaded. Retry before editing.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let body = ''
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        bytes += result.value.byteLength
        if (bytes > MAX_METADATA_BYTES) { await reader.cancel(); throw new Error('The project metadata exceeds the supported size.') }
        body += decoder.decode(result.value, { stream: true })
      }
      body += decoder.decode()
    } finally { reader.releaseLock() }
    const parsed = record(JSON.parse(body))
    if (!parsed) throw new Error('The project metadata must be a JSON object.')
    raw = parsed
  }
  return projectMetadataDocument(raw)
}

export function projectMetadataDocument(raw: Record<string, unknown>, inherited?: ProjectMetadataDocument): ProjectMetadataDocument {
  const originalHomerun = record(raw.homerun)
  const supportsPlan = originalHomerun?.version === 1 && ((originalHomerun.kind === 'fund' && !!record(originalHomerun.setup)) || originalHomerun.type === 'income')
  // INCOME launches historically published only linkage and allocation facts.
  // Seed its review with inherited descriptive fields, never the FUND bindings or economics.
  if (supportsPlan && originalHomerun?.type === 'income' && !record(originalHomerun.setup) && inherited?.supportsPlan) {
    const setup = { ...record(originalHomerun.setup) }
    for (const key of [...Object.keys(textLimits), ...Object.keys(numericLimits)] as MetadataField[]) {
      if (!Object.hasOwn(setup, key) && inherited.draft[key] !== '') setup[key] = key in numericLimits ? Number(inherited.draft[key]) : inherited.draft[key]
    }
    const inheritedHomerun = record(inherited?.raw.homerun)
    const homerun: Record<string, unknown> = { ...originalHomerun, setup }
    for (const role of ['owner', 'operator']) if (!Object.hasOwn(homerun, role) && record(inheritedHomerun?.[role])) homerun[role] = inheritedHomerun![role]
    raw = { ...raw, homerun }
    for (const key of ['coverImageUri', 'logoUri']) if (!Object.hasOwn(raw, key) && inherited?.raw[key]) raw[key] = inherited.raw[key]
  }
  const homerun = record(raw.homerun)
  const setup = supportsPlan ? record(homerun?.setup) ?? {} : {}
  const owner = supportsPlan ? record(homerun?.owner) : null
  const operator = supportsPlan ? record(homerun?.operator) : null
  const draft = Object.fromEntries(Object.keys(textLimits).map(key => [key, text(key === 'name' || key === 'description' ? raw[key] : setup[key])])) as ProjectMetadataDraft
  for (const key of Object.keys(numericLimits) as (keyof typeof numericLimits)[]) draft[key] = numberText(setup[key])
  draft.ownerName = text(owner?.name ?? setup.ownerName)
  draft.ownerIntroduction = text(owner?.introduction ?? setup.ownerIntroduction)
  draft.operatorName = text(operator?.name ?? setup.operatorName)
  draft.operatorIntroduction = text(operator?.introduction ?? setup.operatorIntroduction)
  draft.ownerWallet = text(setup.ownerWallet)
  draft.operatorWallet = text(setup.operatorWallet ?? (originalHomerun?.type === 'income' ? originalHomerun.operatorWallet : undefined))
  return { raw, supportsPlan, needsInheritance: supportsPlan && originalHomerun?.type === 'income' && !record(homerun?.setup), draft, images: { cover: fundIpfsUrl(raw.coverImageUri), logo: fundIpfsUrl(raw.logoUri), owner: fundIpfsUrl(owner?.photoUri), operator: fundIpfsUrl(operator?.photoUri) } }
}

/** Only descriptive fields are writable here. Funding economics, addresses and bindings remain unchanged. */
export function validateProjectMetadataDraft(document: ProjectMetadataDocument, draft: ProjectMetadataDraft, images: ProjectMetadataImages = {}): ProjectMetadataDraft {
  const normalized = { ...draft }
  for (const [key, maximum] of Object.entries(textLimits) as [keyof typeof textLimits, number][]) {
    if (!document.supportsPlan && key !== 'name' && key !== 'description') continue
    if (typeof draft[key] !== 'string' || draft[key].trim().length > maximum) throw new Error(`${metadataFieldLabel(key)} must be at most ${maximum} characters.`)
    normalized[key] = draft[key].trim()
  }
  if (!normalized.name) throw new Error('Enter a project name.')
  if (document.supportsPlan) for (const role of ['owner', 'operator'] as const) {
    const key = `${role}Wallet` as const
    if (normalized[key] && (!isAddress(normalized[key], { strict: false }) || isAddressEqual(normalized[key] as Address, zeroAddress))) throw new Error(`${metadataFieldLabel(key)} must be a nonzero Ethereum address.`)
    if (normalized[key]) normalized[key] = getAddress(normalized[key])
  }
  if (document.supportsPlan) for (const [key, maximum] of Object.entries(numericLimits) as [keyof typeof numericLimits, number][]) {
    const value = draft[key].trim()
    const minimum = key === 'rentGrowthPercent' || key === 'costGrowthPercent' ? -100 : 0
    if (value && (!/^-?(?:\d+)(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum)) throw new Error(`${metadataFieldLabel(key)} must be between ${minimum} and ${maximum}, with at most 6 decimal places.`)
    normalized[key] = value
  }
  for (const [key, image] of Object.entries(images)) {
    if (!['cover', 'logo', 'owner', 'operator'].includes(key)) throw new Error('Unsupported project image.')
    if (!document.supportsPlan && (key === 'owner' || key === 'operator')) throw new Error('This project does not use supported Homerun profiles.')
    if (image.file && image.remove) throw new Error('Choose either a replacement image or remove the existing image.')
    if (image.file && (!/^image\/(png|jpeg|webp)$/.test(image.file.type) || image.file.size <= 0 || image.file.size > JBCENTER_MAX_IMAGE_BYTES)) throw new Error('Choose a JPEG, PNG, or WebP image up to 25 MB.')
  }
  return normalized
}

export function metadataFieldLabel(key: MetadataField): string {
  return ({ name: 'Project name', description: 'Description', location: 'Location', assetType: 'Asset type', revenueDescription: 'How the asset earns revenue', minimumRevenueConsequences: 'What happens below the minimum revenue?', ownerName: 'Owner name', ownerIntroduction: 'About Ownership', ownerWallet: 'Owner profile address', operatorName: 'Operator name', operatorIntroduction: 'About the Operator', operatorWallet: 'Operator profile address', monthlyRent: 'Expected monthly revenue', monthlyCosts: 'Expected monthly expenses', minimumRevenue: 'Minimum monthly revenue', rentGrowthPercent: 'Annual revenue growth (%)', costGrowthPercent: 'Annual expense growth (%)' })[key]
}

export function buildEditedProjectMetadata(document: ProjectMetadataDocument, draft: ProjectMetadataDraft, imageUris: Partial<Record<MetadataImageKey, string | null>> = {}): Record<string, unknown> {
  const values = validateProjectMetadataDraft(document, draft)
  const next = JSON.parse(JSON.stringify(document.raw)) as Record<string, unknown>
  next.name = values.name
  next.description = values.description
  const setImage = (target: Record<string, unknown>, key: string, value: string | null | undefined) => {
    if (value === undefined) return
    if (value === null) delete target[key]
    else { if (!value.startsWith('ipfs://') || !fundIpfsUrl(value)) throw new Error('Publish replacement images to IPFS first.'); target[key] = value }
  }
  setImage(next, 'coverImageUri', imageUris.cover)
  setImage(next, 'logoUri', imageUris.logo)
  if (document.supportsPlan) {
    const homerun = next.homerun as Record<string, unknown>
    const setup = { ...record(homerun.setup) }
    homerun.setup = setup
    for (const key of Object.keys(textLimits) as (keyof typeof textLimits)[]) setup[key] = values[key]
    for (const key of Object.keys(numericLimits) as (keyof typeof numericLimits)[]) {
      if (values[key] === '') delete setup[key]
      else setup[key] = Number(values[key])
    }
    for (const role of ['owner', 'operator'] as const) {
      const profile = { ...record(homerun[role]), name: values[`${role}Name`], introduction: values[`${role}Introduction`] }
      setImage(profile, 'photoUri', imageUris[role])
      homerun[role] = profile
    }
  }
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_METADATA_BYTES) throw new Error('The edited project metadata exceeds the supported size.')
  return next
}

export async function publishEditedProjectMetadata(document: ProjectMetadataDocument, draft: ProjectMetadataDraft, images: ProjectMetadataImages = {}, ipfs: Pick<JBCenterIpfsClient, 'pinImage' | 'pinJson'> = jbCenterIpfs) {
  const values = validateProjectMetadataDraft(document, draft, images)
  const imageUris: Partial<Record<MetadataImageKey, string | null>> = {}
  for (const key of ['cover', 'logo', 'owner', 'operator'] as const) {
    const image = images[key]
    if (image?.remove) imageUris[key] = null
    else if (image?.file) imageUris[key] = `ipfs://${(await ipfs.pinImage(image.file)).cid}`
  }
  const metadata = buildEditedProjectMetadata(document, values, imageUris)
  const result = await ipfs.pinJson(metadata)
  const uri = `ipfs://${result.cid}`
  if (!fundIpfsUrl(uri)) throw new Error('Publishing returned an invalid IPFS reference.')
  return { uri, metadata }
}

export function buildProjectMetadataEditTx(state: ProjectMetadataEditState, uri: string): TxRequest {
  if (!state.canEdit) throw new Error('The connected account cannot edit project details.')
  if (!isAddressEqual(state.controller, v6Address('JBController', state.chainId))) throw new Error('Unsupported project controller.')
  if (!uri.startsWith('ipfs://') || !fundIpfsUrl(uri)) throw new Error('Publish the reviewed project details to IPFS first.')
  return { chainId: state.chainId, address: state.controller, abi: jbControllerAbi, functionName: 'setUriOf', args: [state.projectId, uri], label: 'Update project details' }
}

export async function reverifyProjectMetadataEdit(client: PublicClient, state: ProjectMetadataEditState, account: Address) {
  if (!isAddressEqual(account, state.account)) throw new Error('The connected account changed. Review the details again.')
  const current = await readProjectMetadataEditState(client, { chainId: state.chainId, projectId: state.projectId, account })
  if (current.blockNumber < state.blockNumber) throw new Error('The RPC is behind the reviewed project details. Wait for it to catch up before publishing.')
  const originalBlock = current.blockNumber === state.blockNumber ? { hash: current.blockHash } : await client.getBlock({ blockNumber: state.blockNumber })
  if (originalBlock.hash !== state.blockHash) throw new Error('The reviewed block is no longer canonical. Reload project details before publishing.')
  if (!isAddressEqual(current.owner, state.owner) || !isAddressEqual(current.controller, state.controller)) throw new Error('Project ownership or its controller changed. Reload before editing.')
  if (current.projectUri !== state.projectUri) throw new Error('Project details changed while you were editing. Reload to preserve the latest update.')
  if (!current.canEdit) throw new Error('Your permission to edit project details changed.')
  return current
}
