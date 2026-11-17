import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The browser's own dropdown arrow sits flush against the edge. One global rule replaces it with an inset caret; this
// gate fails when the rule stops being global, or when a sheet or a select could bring the browser arrow back.
const root = process.cwd()
const home = 'src/components/select-controls.css'
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const files = (dir: string, ext: string): string[] => readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(dir, entry.name), ext) : entry.name.endsWith(ext) ? [join(dir, entry.name)] : [])

describe('select caret', () => {
  it('one global important rule owns the caret on every dropdown', () => {
    const rules = [...read(home).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    expect(rules.map(rule => rule[1].trim())).toEqual(['select:not([multiple]):not([size])'])
    for (const property of ['appearance', '-webkit-appearance', 'padding-right', 'background-image', 'background-repeat', 'background-position', 'background-size']) {
      expect(rules[0][2], property).toMatch(new RegExp(`(^|[;\\s])${property}:[^;]*!important;`))
    }
    expect(rules[0][2]).toMatch(/appearance: none !important/)
    expect(rules[0][2]).toMatch(/padding-right: var\(--select-padding-right, 40px\)/)
    expect(rules[0][2]).toMatch(/background-position: right var\(--select-chevron-inset, 12px\) center/)
    // Unlayered in the root layout's sheet, so it reaches every route and beats every Tailwind utility.
    expect(read('src/app/globals.css')).toMatch(/^@import '\.\.\/components\/select-controls\.css';$/m)
    expect(read('src/app/layout.tsx')).toContain("import './globals.css'")
  })

  it('no sheet and no select can opt out', () => {
    const sheets = [...files('src', '.css'), ...files('web', '.css')].filter(file => file !== home)
    for (const file of sheets) {
      const css = read(file)
      expect(css, file).not.toMatch(/appearance\s*:\s*(auto|menulist|revert|initial|unset)/)
      // Only another important declaration could override the rule.
      expect(css, file).not.toMatch(/(padding(-right|-inline|-inline-end)?|background(-image|-position|-size|-repeat)?|appearance)\s*:[^;}]*!important/)
    }
    const selects = files('src', '.tsx').flatMap(file => [...read(file).matchAll(/<select\b[\s\S]*?<\/select>/g)].map(match => ({ file, tag: match[0] })))
    expect(selects.length).toBeGreaterThan(20)
    for (const { file, tag } of selects) {
      expect(tag, file).not.toMatch(/\bstyle=|appearance|\bmultiple\b|\bsize=/)
      // Tailwind's important utilities are the one layered way past an unlayered rule.
      expect(tag, file).not.toMatch(/(^|[\s"'`:])!(p|pr|px|pe|bg)-|\b(p|pr|px|pe|bg)-[^\s"'`]*!(?=[\s"'`])/)
    }
  })
})
