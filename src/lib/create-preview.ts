import { CREATE_DRAFT_KEY, CREATE_DEFAULTS, normalizeCreateDraft } from '../../web/create-model.mjs'
import type { CreateValues } from '@/components/CreateFlow'

type Normalized = { valid: boolean; values: CreateValues }

/** The setup the create form saved in this browser, or nothing if it cannot be read. */
export function loadCreateValues(): CreateValues | null {
  let saved: unknown
  try { saved = JSON.parse(localStorage.getItem(CREATE_DRAFT_KEY) || 'null') }
  catch { return null }
  const raw = (saved as { raw?: Record<string, unknown> } | null)?.raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const merged: Record<string, unknown> = { ...CREATE_DEFAULTS }
  for (const key of Object.keys(CREATE_DEFAULTS)) {
    if (Object.hasOwn(raw, key)) merged[key] = raw[key]
  }
  const normalized = normalizeCreateDraft(merged) as unknown as Normalized
  return normalized.valid ? normalized.values : null
}
