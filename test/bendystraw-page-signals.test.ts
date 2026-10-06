// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A page's Bendystraw reads go with the page's signal: react-query's, or one the page aborts when it is left. When the
 * page is left, what it asked Bendystraw for stops, and a read whose page is gone sends nothing.
 *
 * The readers are found from the source, so a new one is checked as soon as it exists: every function a module of
 * src/lib exports that calls `bendystraw`, `getPagedItems` or another reader. Every use of a reader in the browser's
 * code (src/components and src/hooks) is a call that gives it a `signal`.
 */

const SRC = resolve('src')
const LIB = join(SRC, 'lib')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)

/** The `@/lib/...` name of a module of src/lib. */
const moduleOf = (path: string) => `@/lib/${relative(LIB, path).replace(/\.tsx?$/, '')}`

/** Each name a source imports from a module of src/lib, as `module#name`. */
function imported(source: ts.SourceFile, path: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const module = specifier.startsWith('@/lib/')
      ? specifier
      : specifier.startsWith('./') && path.startsWith(LIB)
        ? moduleOf(join(LIB, specifier))
        : null
    const bindings = statement.importClause?.namedBindings
    if (!module || !bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      names.set(element.name.text, `${module}#${(element.propertyName ?? element.name).text}`)
    }
  }
  return names
}

/** The functions a module exports, by name, with the names each one calls. */
function exportedFunctions(source: ts.SourceFile): Map<string, Set<string>> {
  const called = (body: ts.Node) => {
    const names = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(body)
    return names
  }
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const functions = new Map<string, Set<string>>()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && exported(statement)) {
      functions.set(statement.name.text, called(statement.body))
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer
        if (ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
          functions.set(declaration.name.text, called(value.body))
        }
      }
    }
  }
  return functions
}

/** Every reader, as `module#name`. */
function findReaders(): Set<string> {
  const modules = sources(LIB).map(path => {
    const source = parse(path)
    return { module: moduleOf(path), imports: imported(source, path), functions: exportedFunctions(source) }
  })
  const readers = new Set(['@/lib/bendystraw#bendystraw'])
  for (let grew = true; grew;) {
    grew = false
    for (const { module, imports, functions } of modules) {
      for (const [name, called] of functions) {
        const id = `${module}#${name}`
        if (readers.has(id)) continue
        const resolved = [...called].map(callee => imports.get(callee) ?? `${module}#${callee}`)
        if (resolved.some(callee => readers.has(callee))) {
          readers.add(id)
          grew = true
        }
      }
    }
  }
  return readers
}

/** Whether an argument gives a signal: a name `signal` anywhere in it (`{ signal }`, `leave.current?.signal`). */
function givesSignal(argument: ts.Expression): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === 'signal') found = true
    ts.forEachChild(node, visit)
  }
  visit(argument)
  return found
}

/** Each use of a reader in the browser's code that does not give it a signal, as `file:line name`. */
function unsignalled(readers: Set<string>): string[] {
  const misses: string[] = []
  for (const path of [...sources(join(SRC, 'components')), ...sources(join(SRC, 'hooks'))]) {
    const source = parse(path)
    const imports = imported(source, path)
    const visit = (node: ts.Node) => {
      const id = ts.isIdentifier(node) ? imports.get(node.text) : undefined
      if (id && readers.has(id) && !ts.isImportSpecifier(node.parent)) {
        const call = node.parent
        const ok = ts.isCallExpression(call) && call.expression === node && call.arguments.some(givesSignal)
        if (!ok) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          misses.push(`${relative(SRC, path)}:${line + 1} ${node.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return misses
}

describe("a page's Bendystraw reads", () => {
  it('are found from the source', () => {
    const readers = findReaders()
    // The readers the pages call today; the gate below checks whatever this finds.
    for (const reader of [
      '@/lib/bendystraw#getProject',
      '@/lib/bendystraw#getPagedItems',
      '@/lib/bendystraw#getAccountActivity',
      '@/lib/loans-queries#getLoans',
      '@/lib/project-participants#getProjectHolders',
      '@/lib/project-payers#getProjectPayerAddresses',
      '@/lib/project-shop#readShopCustomers',
    ]) expect(readers).toContain(reader)
    expect(readers).not.toContain('@/lib/bendystraw#normalizeBendystrawUrl')
    expect(readers).not.toContain('@/lib/project-participants#formatParticipantBalance')
  })

  it('give each reader a signal', () => {
    expect(unsignalled(findReaders())).toEqual([])
  })
})
