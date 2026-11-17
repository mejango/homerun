import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POLLED, REFRESH_MS, retryRead } from '@/lib/refresh'

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}
const files = sources(join(process.cwd(), 'src')).map(path => ({ path, text: readFileSync(path, 'utf8') }))

describe('how often a page asks again', () => {
  it('tries a failed read once more, and a rate-limited one never', () => {
    expect(retryRead(0, new Error('offline'))).toBe(true)
    expect(retryRead(1, new Error('offline'))).toBe(false)
    expect(retryRead(0, Object.assign(new Error('limited'), { status: 429 }))).toBe(false)
    expect(retryRead(0, new Error('wrapped', { cause: { code: 429 } }))).toBe(false)
  })

  it('polls every 30 seconds while the tab shows and catches up as it shows again', () => {
    expect(REFRESH_MS).toBe(30_000)
    expect(POLLED).toEqual({ refetchInterval: 30_000, refetchOnWindowFocus: true })
  })

  it('has no query polling faster than the shared cadence', () => {
    const intervals = files.flatMap(({ path, text }) => [...text.matchAll(/refetchInterval:\s*([^,}\s]+)/g)].map(match => ({ path, value: match[1] })))
    expect(intervals.length).toBeGreaterThan(0)
    expect(intervals.filter(({ value }) => value !== 'REFRESH_MS' && !(Number(value.replaceAll('_', '')) >= REFRESH_MS))).toEqual([])
  })

  it('leaves the one retry to the query default, which skips a rate limit', () => {
    expect(files.filter(({ text }) => /\bretry:\s*\d/.test(text)).map(({ path }) => path)).toEqual([])
    expect(files.find(({ path }) => path.endsWith('providers/Providers.tsx'))!.text).toContain('retry: retryRead')
  })
})
