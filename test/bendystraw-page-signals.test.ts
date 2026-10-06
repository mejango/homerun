// @vitest-environment node
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { bindingsOf, findReaders, idOf, LIB, parse, SRC, sourcesUnder, type Source } from './support/bendystraw-readers'

/**
 * A page's Bendystraw reads go with the page's signal: react-query's, or one the page aborts when it is left. When the
 * page is left, what it asked Bendystraw for stops, and a read whose page is gone sends nothing.
 *
 * The readers are found from the source (test/support/bendystraw-readers.ts says what that search follows and what it
 * does not). Every use of a reader in the browser's code, src/components and src/hooks, is a call that gives it a
 * signal: `{ signal }`, `{ signal: x }` with x other than `undefined`, `null` or `void`, or a signal passed as itself.
 *
 * Not checked: a page's own helper that takes an optional signal and hands it to a reader (ProjectActivity's
 * fetchPage) is checked where it calls the reader, not where it is called; and server code (src/app), which has no
 * page signal.
 */

/** Whether a value gives nothing: `undefined`, `null` or `void` anything. */
const nothing = (value: ts.Expression) =>
  (ts.isIdentifier(value) && value.text === 'undefined') || value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)

/** Whether an argument gives a signal. */
function givesSignal(argument: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isNonNullExpression(argument)) {
    argument = argument.expression
  }
  if (ts.isIdentifier(argument)) return argument.text === 'signal'
  if (ts.isPropertyAccessExpression(argument)) return argument.name.text === 'signal'
  if (!ts.isObjectLiteralExpression(argument)) return false
  return argument.properties.some(property =>
    (ts.isShorthandPropertyAssignment(property) && property.name.text === 'signal') ||
    (ts.isPropertyAssignment(property) && property.name.getText() === 'signal' && !nothing(property.initializer)))
}

/** Whether an identifier reads a binding, rather than naming a property or an import. */
function reads(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === identifier) return false
  return true
}

/** Each use of a reader in `sources` that does not give it a signal, as `file:line name`. */
function unsignalled(sources: Source[], readers: Set<string>): string[] {
  const misses: string[] = []
  for (const file of sources) {
    const source = parse(file)
    const bindings = bindingsOf(source, file.path)
    const visit = (node: ts.Node) => {
      // A reader is named by an imported identifier, or by `x.name` on a namespace import.
      const named = ts.isIdentifier(node) && reads(node) && bindings.names.has(node.text)
      const spaced = ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && bindings.namespaces.has(node.expression.text)
      const id = named || spaced ? idOf(node as ts.Expression, bindings) : undefined
      if (id && readers.has(id)) {
        const call = node.parent
        if (!(ts.isCallExpression(call) && call.expression === node && call.arguments.some(givesSignal))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          misses.push(`${relative(SRC, file.path)}:${line + 1} ${node.getText()}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return misses
}

const browserCode = () => [...sourcesUnder(join(SRC, 'components')), ...sourcesUnder(join(SRC, 'hooks'))]

describe("a page's Bendystraw reads", () => {
  it('are found from the source', () => {
    const readers = findReaders()
    for (const reader of [
      '@/lib/bendystraw#getProject',
      '@/lib/bendystraw#getPagedItems',
      '@/lib/bendystraw#getAccountActivity',
      '@/lib/loans-queries#getLoans',
      '@/lib/project-participants#getProjectHolders',
      '@/lib/project-payers#getProjectPayerAddresses',
      '@/lib/project-shop#readShopCustomers',
      // Behind React's cache().
      '@/lib/project-seed#loadProjectSeed',
    ]) expect(readers.has(reader), reader).toBe(true)
    expect(readers.has('@/lib/bendystraw#normalizeBendystrawUrl')).toBe(false)
    expect(readers.has('@/lib/project-participants#formatParticipantBalance')).toBe(false)
  })

  it('give each reader a signal', () => {
    expect(unsignalled(browserCode(), new Set(findReaders().keys()))).toEqual([])
  })
})

describe('the search for readers', () => {
  const lib = (name: string, text: string): Source => ({ path: join(LIB, `${name}.ts`), text })
  const found = findReaders([
    lib('bendystraw', 'export async function bendystraw() {}'),
    lib('hidden', "import { bendystraw } from './bendystraw'\nconst helper = () => bendystraw()\nexport async function viaHelper() { return helper() }"),
    lib('cached', "import { cache } from 'react'\nimport { viaHelper } from '@/lib/hidden'\nexport const cached = cache(async () => viaHelper())"),
    lib('stored', "import { unstable_cache } from 'next/cache'\nimport { viaHelper } from './hidden'\nconst kept = unstable_cache(async () => viaHelper(), ['kept'])\nexport { kept as stored }"),
    lib('spaced', "import * as hidden from '@/lib/hidden'\nexport function viaNamespace() { return hidden.viaHelper() }"),
    lib('again', "export { viaNamespace as again } from './spaced'"),
    lib('fallback', "import read from './defaulted'\nexport const viaDefault = () => read()"),
    lib('defaulted', "import { bendystraw } from './bendystraw'\nexport default async function read() { return bendystraw() }"),
    lib('plain', 'export function plain() { return 1 }'),
  ])

  it('follows helpers, cache wrappers, namespaces, defaults and re-exports', () => {
    expect([...found.keys()].sort()).toEqual([
      '@/lib/again#again', '@/lib/bendystraw#bendystraw', '@/lib/cached#cached', '@/lib/defaulted#default',
      '@/lib/defaulted#read', '@/lib/fallback#viaDefault', '@/lib/hidden#helper', '@/lib/hidden#viaHelper',
      '@/lib/spaced#viaNamespace', '@/lib/stored#kept', '@/lib/stored#stored',
    ])
    expect(found.get('@/lib/hidden#helper')).toEqual({ exported: false })
    expect(found.get('@/lib/stored#kept')).toEqual({ exported: false })
    expect(found.get('@/lib/stored#stored')).toEqual({ exported: true })
  })

  it('refuses a call without a signal, with one that gives nothing, or a reader used as a value', () => {
    const readers = new Set(found.keys())
    const page = (code: string) => unsignalled([{
      path: join(SRC, 'components', 'Page.tsx'),
      text: `import { viaHelper } from '@/lib/hidden'\nimport * as spaced from '@/lib/spaced'\n${code}`,
    }], readers)
    expect(page('useQuery({ queryFn: ({ signal }) => viaHelper(1, { signal }) })')).toEqual([])
    expect(page('viaHelper(1, { network, signal: controller.signal })')).toEqual([])
    expect(page('viaHelper(signal)')).toEqual([])
    expect(page('spaced.viaNamespace({ signal })')).toEqual([])
    for (const code of [
      'viaHelper(1)',
      'viaHelper(1, { signal: undefined })',
      'viaHelper(1, { network, signal: null })',
      'viaHelper(1, { signal: void 0 })',
      'viaHelper(1, { signals })',
      'spaced.viaNamespace()',
      'const read = viaHelper',
      'items.map(viaHelper)',
    ]) expect(page(code), code).toHaveLength(1)
  })
})
