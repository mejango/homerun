import { getAddress, isAddress, zeroAddress } from 'viem'

export const DEMO_PROJECT_DETAIL_FIELDS = [
  'name', 'location', 'description', 'photo',
  'ownerName', 'ownerIntroduction', 'ownerPhoto',
  'operatorName', 'operatorIntroduction', 'operatorPhoto',
] as const
export type DemoProjectDetails = Record<typeof DEMO_PROJECT_DETAIL_FIELDS[number], string>
export const DEMO_PROJECT_PERMISSIONS = [
  'Edit project details', 'Manage splits', 'Queue rulesets', 'Manage shop items', 'Manage permissions',
] as const
export type DemoProjectPermission = typeof DEMO_PROJECT_PERMISSIONS[number]
export type DemoProjectDelegate = { address: string; permissions: DemoProjectPermission[] }
export type DemoProjectSplit = { address: string; percent: string }
export type DemoProjectManagement = {
  version: 1
  details: DemoProjectDetails
  ownerAddress: string
  operatorAddress: string
  delegates: DemoProjectDelegate[]
  splits: { fund: DemoProjectSplit[]; income: DemoProjectSplit[] }
}

export function demoProjectManagementKey(projectKey: string) {
  return `homerun:project-management:v1:${encodeURIComponent(projectKey)}`
}

export function demoManagementAddress(value: string): string {
  if (!isAddress(value.trim(), { strict: false }) || value.trim().toLowerCase() === zeroAddress) throw new Error('Enter a nonzero wallet address beginning with 0x.')
  return getAddress(value.trim())
}

function validateImage(value: string) {
  if (!value) return
  if (value.length <= 1_500_000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new Error('Use an HTTPS image URL.')
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return
  } catch { /* Report one actionable validation error. */ }
  throw new Error('Use an HTTPS image URL.')
}

export function validateDemoProjectDetails(details: DemoProjectDetails): DemoProjectDetails {
  const result = {} as DemoProjectDetails
  for (const key of DEMO_PROJECT_DETAIL_FIELDS) {
    if (typeof details[key] !== 'string') throw new Error('Project details are invalid.')
    result[key] = details[key].trim()
    const limit = key === 'description' ? 10_000 : key.endsWith('Introduction') ? 1200 : key === 'photo' || key.endsWith('Photo') ? 1_500_000 : 160
    if (result[key].length > limit) throw new Error(`${key} is too long.`)
    if (key === 'photo' || key.endsWith('Photo')) validateImage(result[key])
  }
  if (!result.name) throw new Error('Enter a project name.')
  return result
}

/** Percentage units match Juicebox's seven decimal places exactly. */
export function demoSplitUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,7})?$/.test(value)) throw new Error('Enter a split percentage with up to seven decimal places.')
  const [whole, decimal = ''] = value.split('.')
  const units = BigInt(whole) * 10_000_000n + BigInt(decimal.padEnd(7, '0'))
  if (units <= 0n || units > 1_000_000_000n) throw new Error('Each split must be greater than 0% and at most 100%.')
  return units
}

export function validateDemoProjectSplits(splits: DemoProjectSplit[]): DemoProjectSplit[] {
  if (!Array.isArray(splits) || splits.length > 20) throw new Error('Use at most 20 split recipients.')
  let total = 0n
  const addresses = new Set<string>()
  const result = splits.map(split => {
    const address = demoManagementAddress(split.address)
    if (addresses.has(address)) throw new Error('Each split recipient can appear only once.')
    addresses.add(address)
    total += demoSplitUnits(split.percent)
    return { address, percent: split.percent }
  })
  if (total > 1_000_000_000n) throw new Error('Split percentages cannot total more than 100%.')
  return result
}

export function validateDemoProjectDelegates(delegates: DemoProjectDelegate[]): DemoProjectDelegate[] {
  if (!Array.isArray(delegates) || delegates.length > 20) throw new Error('Use at most 20 delegated accounts.')
  const addresses = new Set<string>()
  return delegates.map(delegate => {
    const address = demoManagementAddress(delegate.address)
    if (addresses.has(address)) throw new Error('Each delegated account can appear only once.')
    addresses.add(address)
    if (!Array.isArray(delegate.permissions) || delegate.permissions.length === 0 || delegate.permissions.some(permission => !DEMO_PROJECT_PERMISSIONS.includes(permission))) throw new Error('Choose at least one permission for each account.')
    return { address, permissions: [...new Set(delegate.permissions)] }
  })
}

export function validateDemoProjectManagement(state: DemoProjectManagement): DemoProjectManagement {
  if (state.version !== 1) throw new Error('Unsupported demo project version.')
  return {
    version: 1,
    details: validateDemoProjectDetails(state.details),
    ownerAddress: state.ownerAddress ? demoManagementAddress(state.ownerAddress) : '',
    operatorAddress: state.operatorAddress ? demoManagementAddress(state.operatorAddress) : '',
    delegates: validateDemoProjectDelegates(state.delegates),
    splits: { fund: validateDemoProjectSplits(state.splits.fund), income: validateDemoProjectSplits(state.splits.income) },
  }
}

export function parseDemoProjectManagement(raw: string | null): DemoProjectManagement | null {
  if (!raw || raw.length > 4_800_000) return null
  try { return validateDemoProjectManagement(JSON.parse(raw)) } catch { return null }
}

/** Profiles follow their actual demo holder; old introductions are not attributed to a new account. */
export function replaceDemoProjectRole(state: DemoProjectManagement, role: 'owner' | 'operator', value: string): DemoProjectManagement {
  const address = demoManagementAddress(value)
  const field = role === 'owner' ? 'ownerAddress' : 'operatorAddress'
  if (state[field].toLowerCase() === address.toLowerCase()) return state
  return {
    ...state,
    [field]: address,
    details: { ...state.details, [`${role}Name`]: '', [`${role}Introduction`]: '', [`${role}Photo`]: '' },
    // An Owner's delegated grants do not become grants from the new Owner.
    delegates: role === 'owner' ? [] : state.delegates,
  }
}
