import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

/**
 * The Bendystraw readers of the source, found from it: `bendystraw` itself, and every top-level function of src/lib
 * that calls one. A top-level function is a declaration, exported or not, or a const that holds a function or a call
 * that wraps one (`cache(fn)`, `unstable_cache(fn, keys)`). A call is followed through named, default and namespace
 * imports (`import * as x`, then `x.name(...)`), through re-exports (`export { a as b } from './x'`) and through a
 * module's own export list (`export { a, b as c }`).
 *
 * Not followed: functions kept in objects or classes, `export default` of an expression, dynamic `import()`, and a
 * reader handed on as a value (a variable, a parameter, an object property) and called elsewhere.
 */

export type Source = { path: string; text: string }

export const SRC = resolve('src')
export const LIB = join(SRC, 'lib')

/** Every .ts and .tsx file under `dir`, declarations aside. */
export function sourcesUnder(dir: string): Source[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [{ path, text: readFileSync(path, 'utf8') }] : []
  })
}

export const parse = ({ path, text }: Source) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

/** The `@/lib/...` name of a file of src/lib, or null for any other file. */
function libModule(path: string): string | null {
  const within = relative(LIB, path)
  return within.startsWith('..') ? null : `@/lib/${within.replace(/\.tsx?$/, '')}`
}

/** The src/lib module an import or re-export names, or null for any other. */
function moduleNamed(specifier: string, path: string): string | null {
  if (specifier.startsWith('@/lib/')) return specifier
  return specifier.startsWith('./') || specifier.startsWith('../') ? libModule(join(path, '..', specifier)) : null
}

/** What a source's names refer to in src/lib: a name imported (`module#name`), or a namespace (`module`). */
export type Bindings = { module: string | null; names: Map<string, string>; namespaces: Map<string, string> }

export function bindingsOf(source: ts.SourceFile, path: string): Bindings {
  const bindings: Bindings = { module: libModule(path), names: new Map(), namespaces: new Map() }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = moduleNamed(statement.moduleSpecifier.text, path)
    const clause = statement.importClause
    if (!module || !clause || clause.isTypeOnly) continue
    if (clause.name) bindings.names.set(clause.name.text, `${module}#default`)
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) bindings.namespaces.set(named.name.text, module)
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (!element.isTypeOnly) bindings.names.set(element.name.text, `${module}#${(element.propertyName ?? element.name).text}`)
      }
    }
  }
  return bindings
}

/** The function an expression names: `name` through an import or the module's own top level, `x.name` through a namespace import. */
export function idOf(expression: ts.Expression, bindings: Bindings): string | undefined {
  if (ts.isIdentifier(expression)) {
    return bindings.names.get(expression.text) ?? (bindings.module ? `${bindings.module}#${expression.text}` : undefined)
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const module = bindings.namespaces.get(expression.expression.text)
    return module ? `${module}#${expression.name.text}` : undefined
  }
  return undefined
}

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
const isDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
const isFunction = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node)

/** The function a const holds: the function itself, or the one a wrapping call is given (`cache(fn)`). */
function heldFunction(value: ts.Expression | undefined): ts.Node | undefined {
  if (!value) return undefined
  if (isFunction(value)) return value.body
  if (ts.isCallExpression(value)) return value.arguments.find(isFunction)?.body
  return undefined
}

type TopLevel = { exported: boolean; calls: Set<string> }

/** Each top-level function of a module, by name, with what it calls and whether it is exported. */
function topLevel(source: ts.SourceFile, bindings: Bindings): Map<string, TopLevel> {
  const callsIn = (body: ts.Node) => {
    const calls = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const id = idOf(node.expression, bindings)
        if (id) calls.add(id)
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return calls
  }
  const functions = new Map<string, TopLevel>()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const entry = { exported: exported(statement), calls: callsIn(statement.body) }
      if (statement.name) functions.set(statement.name.text, entry)
      if (entry.exported && isDefault(statement)) functions.set('default', entry)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const body = heldFunction(declaration.initializer)
        if (ts.isIdentifier(declaration.name) && body) {
          functions.set(declaration.name.text, { exported: exported(statement), calls: callsIn(body) })
        }
      }
    }
  }
  return functions
}

/**
 * A module's export lists: `export { a as b } from './x'` makes `module#b` the function `x#a`, and `export { a as b }`
 * makes it the module's own `a`. Each such name can be imported.
 */
function exportLists(source: ts.SourceFile, path: string, module: string): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    const target = !statement.moduleSpecifier
      ? module
      : ts.isStringLiteral(statement.moduleSpecifier) ? moduleNamed(statement.moduleSpecifier.text, path) : null
    if (!target) continue
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) aliases.set(`${module}#${element.name.text}`, `${target}#${(element.propertyName ?? element.name).text}`)
    }
  }
  return aliases
}

/** Every reader in `sources` (src/lib by default), by `module#name`, and whether another module can import it. */
export function findReaders(sources: Source[] = sourcesUnder(LIB)): Map<string, { exported: boolean }> {
  const functions = new Map<string, TopLevel>()
  const aliases = new Map<string, string>()
  for (const file of sources) {
    const source = parse(file)
    const bindings = bindingsOf(source, file.path)
    if (!bindings.module) continue
    for (const [name, entry] of topLevel(source, bindings)) functions.set(`${bindings.module}#${name}`, entry)
    for (const [alias, target] of exportLists(source, file.path, bindings.module)) aliases.set(alias, target)
  }
  const readers = new Map<string, { exported: boolean }>([['@/lib/bendystraw#bendystraw', { exported: true }]])
  for (let grew = true; grew;) {
    grew = false
    for (const [id, entry] of functions) {
      if (!readers.has(id) && [...entry.calls].some(call => readers.has(call))) {
        readers.set(id, { exported: entry.exported })
        grew = true
      }
    }
    for (const [alias, target] of aliases) {
      if (readers.has(target) && !readers.get(alias)?.exported) {
        readers.set(alias, { exported: true })
        grew = true
      }
    }
  }
  return readers
}
