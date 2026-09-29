/**
 * Last-seen project reads, kept in this browser so a return visit renders at once.
 * Display only: callers must never authorize a write from a cached value.
 */
const PREFIX = 'homerun:display-cache:v1:'
const BIGINT = '$bigint'

export function loadDisplayCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw, (_, value) => value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value[BIGINT] === 'string' ? BigInt(value[BIGINT]) : value) as T : null
  } catch { return null }
}

export function saveDisplayCache(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value, (_, item) => typeof item === 'bigint' ? { [BIGINT]: item.toString() } : item)) }
  catch { /* Storage full or blocked: the page still reads live. */ }
}
