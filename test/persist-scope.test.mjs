import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import ts from 'typescript';
import * as queryPersist from '../src/lib/query-persist.ts';

/**
 * Persisted queries outlive the session in localStorage. Anything keyed to a wallet must never go there: a later
 * visitor on the same browser would see the previous account's balances, allowances or holdings restored as if they
 * were their own.
 *
 * This reads the source rather than the runtime because the risk is a future edit tagging the wrong query, and that
 * should fail in CI, not in a browser.
 *
 * It parses each file with the TypeScript compiler API. From every tag it walks out to the object literal that has a
 * `queryKey`, however far apart the two are, and reads that key. A tag is `meta: PERSIST`, `immutableQuery(...)` and
 * `cachedQuery(...)` (spread, called through an import alias or a namespace), and any `persist` property. The persister
 * writes every query whose `meta.persist` is truthy, whatever the type says of it, so a `persist` that is anything but
 * false, null, undefined or '' is a tag. What the scan cannot read fails: a key that is not an array literal, one with a
 * spread in it, or a tag with no key to be found. ALLOWED excuses one key in one file, with the reason it is safe, and
 * does the same for a key with an account word in it that is about something public. An excused key that is a variable
 * is held to the account words through the declaration it is read from. TAG_NAMES and NOT_TAGS list every export of
 * query-persist.ts, so a new helper fails a test until someone says whether it tags.
 *
 * It reads the names in a key, not the values they hold: a wallet carried by a variable that is not named for one is
 * not seen.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Words that say a key is about an account, matched anywhere in the key's text and in any letter case, so
 * `walletAddress`, `viewAsAccount` and `depositorOf` are all seen. */
const ACCOUNT_HINTS = [
  'address',
  'holder',
  'account',
  'wallet',
  'owner',
  'user',
  'viewer',
  'viewed',
  'viewas',
  'depositor',
  'sender',
  'spender',
  'payer',
  'beneficiary',
  'recipient',
  'staker',
  'signer',
  'operator',
  'authority',
];

/** The helpers of query-persist.ts that tag a query for the persister. The other tag is a `persist` property. */
const TAG_NAMES = ['PERSIST', 'immutableQuery', 'cachedQuery'];

/** The other exports of query-persist.ts. Each export is in one of the two lists, and the test that says so fails for
 * one that is in neither. */
const NOT_TAGS = ['deserializeState', 'installQueryPersistence', 'serializeState'];

/** The source of query-persist.ts writes the tags themselves; it tags no query. */
const TAG_DEFINITIONS = join('src', 'lib', 'query-persist.ts');

/** The key under which the persister writes the browser's storage. */
const STORE_KEY = 'homerun:query-cache:v1';

/** Persisted queries that the scan may not pass, and are safe: the file, the key as the scan reports it, and why. */
const ALLOWED = [
  {
    file: join('src', 'components', 'FundProject.tsx'),
    key: 'snapshotKey',
    reason:
      "snapshotKey is ['fund-display', chainId, projectId], one project's figures. projectSnapshot() resets the account, every balance, every permission and the allowlist entry before anything is written to it.",
  },
];

/** Every file that can hold code: TypeScript and JavaScript, in each module flavour, with or without JSX. */
const isSource = name => /\.[cm]?[jt]sx?$/.test(name);

const SCRIPT_KINDS = {
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/** The files under `dir`, as paths from the repository root. */
function sourceFiles(dir = 'src') {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return isSource(entry.name) ? [full] : [];
  });
}

const read = file => readFileSync(join(ROOT, file), 'utf8');

const squash = text => text.replace(/\s+/g, ' ').trim();

/** `x as const`, `(x)`, `x!` and `<T>x` are x. */
function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** The names a file calls the helpers by: their own, and any it imports them as. */
function tagNames(source) {
  const names = new Set(TAG_NAMES);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith('query-persist')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (TAG_NAMES.includes((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
  }
  return names;
}

/** Whether `node` uses a name, as against declaring it, importing it, or being a property called that. */
function isReference(node) {
  const { parent } = node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent)
  ) {
    return parent.name !== node;
  }
  return true;
}

/** Whether a property is called `text`: `text`, `'text'` or `['text']`. */
function isNamed(name, text) {
  if (ts.isComputedPropertyName(name)) {
    return (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression)) && name.expression.text === text;
  }
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === text;
}

/** A `persist` property that turns persistence on. The persister writes any query whose `meta.persist` is truthy.
 * The scan passes only the falsy literals false, null, undefined and '' (in any quotes, or as an empty template
 * literal); anything else is a tag, including falsy values it does not evaluate, such as 0 or `void 0`. */
function isPersistProperty(node) {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text === 'persist';
  if (!ts.isPropertyAssignment(node) || !isNamed(node.name, 'persist')) return false;
  const tier = unwrap(node.initializer);
  if (ts.isStringLiteral(tier) || ts.isNoSubstitutionTemplateLiteral(tier)) return tier.text !== '';
  return !(
    tier.kind === ts.SyntaxKind.NullKeyword ||
    tier.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(tier) && tier.text === 'undefined')
  );
}

/** The call that a tag names, when it is the callee: `immutableQuery(...)` or `persist.immutableQuery(...)`. */
function calleeOf(tag) {
  let callee = tag;
  if (ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee) callee = callee.parent;
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : null;
}

function keyProperty(object) {
  return object.properties.find(
    property =>
      (ts.isPropertyAssignment(property) && isNamed(property.name, 'queryKey')) ||
      (ts.isShorthandPropertyAssignment(property) && property.name.text === 'queryKey'),
  );
}

/** The object literal that says which query a tag is on: the argument of an `immutableQuery({...})` when it has a
 * key, else the nearest object around the tag that does. */
function optionsFor(tag) {
  const argument = calleeOf(tag)?.arguments[0];
  const given = argument && unwrap(argument);
  if (given && ts.isObjectLiteralExpression(given) && keyProperty(given)) return given;
  for (let node = tag.parent; node; node = node.parent) {
    if (ts.isObjectLiteralExpression(node) && keyProperty(node)) return node;
  }
  return null;
}

/** One tag as `{ line, key, readable, hint }`: the key's text, whether the scan can read it, and the first account
 * word in it. */
function persistedOf(tag, source) {
  const line = source.getLineAndCharacterOfPosition(tag.getStart(source)).line + 1;
  const options = optionsFor(tag);
  const property = options ? keyProperty(options) : undefined;
  if (!property) {
    const anchor = ts.isPropertyAssignment(tag) || ts.isShorthandPropertyAssignment(tag) ? tag : (calleeOf(tag) ?? tag.parent);
    return { line, key: squash(anchor.getText(source)), readable: false, hint: null };
  }
  if (!ts.isPropertyAssignment(property)) return { line, key: 'queryKey', readable: false, hint: null };
  const value = unwrap(property.initializer);
  const key = squash(value.getText(source));
  if (!ts.isArrayLiteralExpression(value) || value.elements.some(ts.isSpreadElement)) {
    return { line, key, readable: false, hint: null };
  }
  return { line, key, readable: true, hint: ACCOUNT_HINTS.find(hint => key.toLowerCase().includes(hint)) ?? null };
}

/** Every persist tag of a file, with the key it is on. */
function persistedQueries(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS);
  const names = tagNames(source);
  const found = [];
  const visit = node => {
    if ((ts.isIdentifier(node) && names.has(node.text) && isReference(node)) || isPersistProperty(node)) {
      found.push(persistedOf(node, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What a variable of a file is declared as, as text, or null when the file declares none by that name. */
function declaredAs(file, name) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS);
  let declared = null;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      declared = squash(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declared;
}

/** What is wrong with the persisted queries of a file, as `file:line: key ...`, and which exceptions it used. */
function check(file, text, allowed = ALLOWED) {
  const offenders = [];
  const used = new Set();
  for (const persisted of persistedQueries(file, text)) {
    if (persisted.readable && persisted.hint === null) continue;
    const excuse = allowed.find(entry => entry.file === file && entry.key === persisted.key);
    if (excuse) {
      used.add(excuse);
      continue;
    }
    const key = persisted.key.length > 100 ? `${persisted.key.slice(0, 97)}...` : persisted.key;
    offenders.push(`${file}:${persisted.line}: ${key} ${persisted.readable ? `names ${persisted.hint}` : 'cannot be read'}`);
  }
  return { offenders, used };
}

describe('persisted query scope', () => {
  const files = sourceFiles().filter(file => file !== TAG_DEFINITIONS);
  const results = files.map(file => check(file, read(file)));

  it('never persists a query keyed to an account, or one whose key cannot be read', () => {
    assert.deepEqual(results.flatMap(result => result.offenders), []);
  });

  it('lists only exceptions that are still needed, each with its reason', () => {
    const used = new Set(results.flatMap(result => [...result.used]));
    assert.deepEqual(ALLOWED.filter(entry => !used.has(entry)), []);
    assert.deepEqual(ALLOWED.filter(entry => entry.reason.trim().length < 20), []);
  });

  it('knows every export of query-persist.ts as a tag or as not one', () => {
    assert.deepEqual(Object.keys(queryPersist).sort(), [...TAG_NAMES, ...NOT_TAGS].sort());
  });

  it('finds no account in what an excused variable key is declared as', () => {
    for (const entry of ALLOWED.filter(entry => /^[\w$]+$/.test(entry.key))) {
      const declared = declaredAs(entry.file, entry.key);
      assert.ok(declared, `${entry.file} declares no ${entry.key}`);
      assert.equal(ACCOUNT_HINTS.find(hint => declared.toLowerCase().includes(hint)), undefined, `${entry.key} is ${declared}`);
    }
  });

  it('finds the tagged queries at all, so the scan cannot silently pass', () => {
    const tagged = files.filter(file => persistedQueries(file, read(file)).length > 0);
    // The floor is the number of files that tag a persisted query. Raise it when a task tags another file, and lower it
    // only when a file stops persisting one on purpose.
    assert.ok(tagged.includes(join('src', 'components', 'ProjectShop.tsx')), tagged.join(', '));
    assert.ok(tagged.length >= 5, `${tagged.length} files tag a persisted query`);
  });
});

const IMPORTS = [
  "import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'",
  "import { PERSIST, cachedQuery, immutableQuery } from '@/lib/query-persist'",
].join('\n');

/** A module with `body` in a hook, so that a fixture is only the query. */
const hook = body => `${IMPORTS}\n\nexport function useThing() {\n${body}\n}\n`;

describe('the scan itself', () => {
  // Persisted queries that name an account, or whose key cannot be read, in the shapes they take. Each must fail, for
  // the reason it is given.
  const MISSED = [
    [
      'a long queryFn between the key and the tag',
      hook(`  return useQuery({
    queryKey: ['positions', holder],
    queryFn: async ({ signal }) => {
      const first = await read(1, signal)
      const second = await read(2, signal)
      const third = await read(3, signal)
      const fourth = await read(4, signal)
      const fifth = await read(5, signal)
      return [first, second, third, fourth, fifth]
    },
    enabled: found !== null,
    ...(found !== null ? immutableQuery({}) : {}),
  })`),
      'names',
    ],
    [
      'a wallet-keyed query within six lines after a project-keyed one',
      hook(`  const project = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const balance = useQuery({ queryKey: ['balance', walletAddress], queryFn, meta: PERSIST })
  return [project, balance]`),
      'names',
    ],
    [
      'a key that a function builds, with an account in its arguments',
      hook('  return useQuery({ queryKey: balanceKey(chainId, address), queryFn, meta: PERSIST })'),
      'cannot be read',
    ],
    [
      'a key that a function builds, whatever is in its arguments',
      hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })'),
      'cannot be read',
    ],
    [
      'a key that is a variable',
      hook(`  const key = ['balance', address]
  return useQuery({ queryKey: key, queryFn, meta: PERSIST })`),
      'cannot be read',
    ],
    [
      'a shorthand key',
      hook(`  const queryKey = ['balance']
  return useQuery({ queryKey, queryFn, meta: PERSIST })`),
      'cannot be read',
    ],
    [
      'a key with a spread in it',
      hook('  return useQuery({ queryKey: [...base, chainId], queryFn, meta: PERSIST })'),
      'cannot be read',
    ],
    [
      'a key eight lines after the tag',
      hook(`  return useQuery({
    meta: PERSIST,
    staleTime: 1,
    gcTime: 2,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    networkMode: 'always',
    queryKey: ['balance', address],
    queryFn,
  })`),
      'names',
    ],
    [
      'a tier in double quotes',
      hook('  return useQuery({ queryKey: [\'balance\', address], queryFn, meta: { persist: "immutable" } })'),
      'names',
    ],
    [
      'a tier in a template literal',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `revalidate` } })"),
      'names',
    ],
    [
      'a tier that is not a literal',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: tier } })"),
      'names',
    ],
    [
      'a tier that names none of the two the type lists',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'none' } })"),
      'names',
    ],
    [
      'a tier in a template literal that names none of them',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `none` } })"),
      'names',
    ],
    [
      'a tier of session',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'session' } })"),
      'names',
    ],
    [
      'a tier in another letter case',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: 'Immutable' } })"),
      'names',
    ],
    [
      'a tier of true',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: true } })"),
      'names',
    ],
    [
      'a tier under a computed name',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { ['persist']: true } })"),
      'names',
    ],
    [
      'PERSIST spread into meta',
      hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { ...PERSIST } })"),
      'names',
    ],
    [
      'a key under a quoted name',
      hook("  return useQuery({ 'queryKey': ['balance', address], queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'a key under a computed name',
      hook("  return useQuery({ ['queryKey']: ['balance', address], queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'a key that ends in as const',
      hook("  return useQuery({ queryKey: ['balance', address] as const, queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'a template literal in the key',
      hook('  return useQuery({ queryKey: [`stake-${address}`], queryFn, meta: PERSIST })'),
      'names',
    ],
    [
      'cachedQuery around the options',
      hook("  return useQuery(cachedQuery({ queryKey: ['x', wallet], queryFn }))"),
      'names',
    ],
    [
      'immutableQuery around options that are somewhere else',
      hook('  return useQuery(immutableQuery(options))'),
      'cannot be read',
    ],
    [
      'a key in useQueries, whichever query it is in',
      hook(`  return useQueries({
    queries: ids.map(id => ({ queryKey: ['stake', id, holder], queryFn, meta: PERSIST })),
  })`),
      'names',
    ],
    [
      'a key in queryOptions',
      hook("  return queryOptions({ queryKey: ['x', address], queryFn, meta: PERSIST })"),
      'names',
    ],
    [
      'defaults set for a wallet-keyed query',
      hook("  queryClient.setQueryDefaults(['balance', address], { meta: PERSIST })"),
      'cannot be read',
    ],
    [
      'a helper imported under another name',
      `import { useQuery } from '@tanstack/react-query'
import { immutableQuery as forever } from '@/lib/query-persist'

export const useThing = () => useQuery(forever({ queryKey: ['x', address], queryFn }))
`,
      'names',
    ],
    [
      'a helper reached through a namespace',
      `import { useQuery } from '@tanstack/react-query'
import * as persist from '@/lib/query-persist'

export const useThing = () => useQuery({ queryKey: ['x', address], queryFn, meta: persist.PERSIST })
`,
      'names',
    ],
  ];

  for (const [what, source, why] of MISSED) {
    it(`fails ${what}`, () => {
      const { offenders } = check('x.ts', source);
      assert.equal(offenders.length, 1, offenders.join('\n'));
      assert.ok(offenders[0].includes(why), offenders[0]);
    });
  }

  for (const word of [
    'address',
    'holder',
    'account',
    'wallet',
    'owner',
    'user',
    'viewer',
    'viewed',
    'viewAs',
    'depositor',
    'sender',
    'spender',
    'payer',
    'beneficiary',
    'recipient',
    'staker',
    'signer',
    'operator',
    'authority',
  ]) {
    it(`fails a key that has ${word} in it, in any letter case, whatever the rest of it says`, () => {
      for (const spelled of [word, word.toUpperCase(), `${word}Of`, `current${word[0].toUpperCase()}${word.slice(1)}`]) {
        const source = hook(`  return useQuery({ queryKey: ['stake', ${spelled}], queryFn, meta: PERSIST })`);
        assert.equal(check('x.ts', source).offenders.length, 1, spelled);
      }
    });
  }

  it('says which key, where, and why', () => {
    const named = hook(`  const a = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const b = useQuery({ queryKey: ['balance', walletAddress], queryFn, meta: PERSIST })
  return [a, b]`);
    assert.deepEqual(check('x.ts', named).offenders, ["x.ts:6: ['balance', walletAddress] names address"]);
    const built = hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })');
    assert.deepEqual(check('x.ts', built).offenders, ['x.ts:5: positionsKey(chainId, who) cannot be read']);
    const elsewhere = hook('  return useQuery(immutableQuery(options))');
    assert.deepEqual(check('x.ts', elsewhere).offenders, ['x.ts:5: immutableQuery(options) cannot be read']);
  });

  for (const name of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts']) {
    it(`reads ${name} as source`, () => {
      assert.equal(isSource(name), true);
    });
  }

  for (const name of ['a.md', 'a.json', 'a.css', 'a.ts.map', 'ts', 'a.d']) {
    it(`does not read ${name}`, () => {
      assert.equal(isSource(name), false);
    });
  }

  for (const file of ['x.js', 'x.mjs', 'x.cjs']) {
    it(`finds a tag in ${file}, which has no types`, () => {
      const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export const useThing = () => useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
`;
      assert.equal(check(file, source).offenders.length, 1);
    });
  }

  it('finds a tag in a jsx file, and in a js file that has jsx in it', () => {
    // The backtick in the text of the first element opens a template literal if the file is read as TypeScript, and
    // that swallows the query after it. Read as jsx, it is text.
    const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export function Balance() {
  const note = <p>use \` to quote</p>
  const { data } = useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
  return <span>{String(data)}{note}</span>
}
`;
    assert.equal(check('x.jsx', source).offenders.length, 1);
    assert.equal(check('x.js', source).offenders.length, 1);
    assert.equal(check('x.tsx', source).offenders.length, 1);
  });

  it('reads a tag in a component file', () => {
    const source = `import { useQuery } from '@tanstack/react-query'
import { PERSIST } from '@/lib/query-persist'

export function Balance() {
  const { data } = useQuery({ queryKey: ['balance', address], queryFn, meta: PERSIST })
  return <span>{String(data)}</span>
}
`;
    assert.equal(check('x.tsx', source).offenders.length, 1);
  });

  const LEGIT = [
    [
      'a tag spread in after a long queryFn, on a project key',
      hook(`  return useQuery({
    queryKey: ['project-metadata', 'v1', found],
    queryFn: async ({ signal }) => {
      const first = await read(1, signal)
      const second = await read(2, signal)
      const third = await read(3, signal)
      const fourth = await read(4, signal)
      const fifth = await read(5, signal)
      return [first, second, third, fourth, fifth]
    },
    enabled: found !== null,
    ...(found !== null ? immutableQuery({}) : {}),
  })`),
    ],
    ['a project key tagged meta: PERSIST', hook("  return useQuery({ queryKey: ['project', chainId, projectId], queryFn, meta: PERSIST })")],
    ['a project key in cachedQuery', hook("  return useQuery(cachedQuery({ queryKey: ['home', network], queryFn }))")],
    ['a project key that ends in as const', hook("  return useQuery({ queryKey: ['project', chainId] as const, queryFn, meta: PERSIST })")],
    [
      'a project key in each query of useQueries',
      hook(`  return useQueries({
    queries: ids.map(id => ({ queryKey: ['projectRow', chainId, id], queryFn, meta: PERSIST })),
  })`),
    ],
    [
      'a wallet-keyed query that is not tagged, beside one that is',
      hook(`  const project = useQuery({ queryKey: ['project', chainId], queryFn, meta: PERSIST })
  const balance = useQuery({ queryKey: ['balance', walletAddress], queryFn })
  return [project, balance]`),
    ],
    ['a tier that is false, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: false } })")],
    ['a tier that is empty, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: '' } })")],
    ['a tier that is an empty template literal, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: `` } })")],
    ['a tier that is null, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: null } })")],
    ['a tier that is undefined, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: undefined } })")],
    ['a tier that is false and cast, on a wallet key', hook("  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: false as boolean } })")],
    [
      'a tag in a comment and in a string',
      hook(`  // meta: PERSIST would put this on disk, and this key names a wallet: ['balance', address]
  const note = "immutableQuery({ queryKey: ['balance', address] })"
  return useQuery({ queryKey: ['project', note], queryFn })`),
    ],
    [
      'the helpers imported and not used',
      `import { PERSIST, cachedQuery, immutableQuery } from '@/lib/query-persist'\n\nexport const unused = 1\n`,
    ],
  ];

  for (const [what, source] of LEGIT) {
    it(`passes ${what}`, () => {
      assert.deepEqual(check('x.ts', source).offenders, []);
    });
  }

  it('passes the real project shop, and sees its meta: PERSIST tag', () => {
    const file = join('src', 'components', 'ProjectShop.tsx');
    const text = read(file);
    assert.equal(persistedQueries(file, text).length, 1);
    assert.deepEqual(check(file, text).offenders, []);
  });

  it('sees all three tags of the real fund page, and passes them only on the exception for its snapshot key', () => {
    const file = join('src', 'components', 'FundProject.tsx');
    const text = read(file);
    assert.equal(persistedQueries(file, text).length, 3);
    assert.deepEqual(check(file, text).offenders, []);
    assert.deepEqual(check(file, text, []).offenders.map(offender => offender.replace(/^[^:]+:\d+: /, '')), ['snapshotKey cannot be read']);
  });

  describe('an exception', () => {
    const source = hook('  return useQuery({ queryKey: positionsKey(chainId, who), queryFn, meta: PERSIST })');
    const entry = {
      file: 'x.ts',
      key: 'positionsKey(chainId, who)',
      reason: 'The builder takes a chain and a project, which are public.',
    };

    it('excuses that key in that file, and is reported as used', () => {
      const excused = check('x.ts', source, [entry]);
      assert.deepEqual(excused.offenders, []);
      assert.deepEqual([...excused.used], [entry]);
    });

    it('does not excuse the same key in another file, or another key in that file', () => {
      assert.equal(check('y.ts', source, [entry]).offenders.length, 1);
      assert.equal(check('x.ts', source, [{ ...entry, key: 'positionsKey(chainId)' }]).offenders.length, 1);
      assert.equal(check('x.ts', source, [{ ...entry, key: 'positionsKey(chainId, who)' }, { ...entry, file: 'y.ts' }]).used.size, 1);
    });

    it('excuses a key with an account word in it, and only that key', () => {
      const listed = hook(`  const a = useQuery({ queryKey: ['owners', chainId], queryFn, meta: PERSIST })
  const b = useQuery({ queryKey: ['owners', chainId, address], queryFn, meta: PERSIST })
  return [a, b]`);
      const allowed = [{ file: 'x.ts', key: "['owners', chainId]", reason: 'The project controllers, which are public.' }];
      assert.equal(check('x.ts', listed, []).offenders.length, 2);
      assert.equal(check('x.ts', listed, allowed).offenders.length, 1);
      assert.ok(check('x.ts', listed, allowed).offenders[0].includes('address'));
    });

    it('matches a key by its text, with each run of white space as one space', () => {
      const laidOut = hook(`  return useQuery({
    queryKey: positionsKey(chainId,
      who),
    queryFn,
    meta: PERSIST,
  })`);
      assert.deepEqual(check('x.ts', laidOut, [entry]).offenders, []);
    });
  });
});

function memoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

/** The keys of the queries that the real persister writes to the browser's storage once `queries` have settled in one
 * client, each as its text. */
async function persistedKeys(queries) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const storage = memoryStorage();
    const client = new QueryClient();
    const stop = queryPersist.installQueryPersistence(client, storage);
    for (const query of queries) await client.fetchQuery({ ...query, queryFn: async () => 1 });
    mock.timers.tick(1_500);
    stop();
    const stored = storage.getItem(STORE_KEY);
    if (stored === null) return [];
    return JSON.parse(stored).queries.map(query => JSON.stringify(query.queryKey));
  } finally {
    mock.timers.reset();
  }
}

const PROBE = ['balance', '0x1111111111111111111111111111111111111111'];

/** A query tagged with the real PERSIST. It settles beside the probe, so the persister always has a write to make. */
const COMPANION = ['companion'];

/** Whether the real persister writes a wallet-keyed query with `meta: { persist: value }`: whether the query itself is
 * in what it stores. The companion is always written, so the write happens whatever the tier is, and the tier alone
 * decides whether the probe is in it. */
async function persisterWrites(value) {
  const written = await persistedKeys([
    { queryKey: PROBE, meta: { persist: value } },
    { queryKey: COMPANION, meta: queryPersist.PERSIST },
  ]);
  assert.ok(written.includes(JSON.stringify(COMPANION)), 'the companion is written');
  return written.includes(JSON.stringify(PROBE));
}

describe('a persist tier', () => {
  // The persister writes any query whose `meta.persist` is truthy, whatever the type says of it, so the scan tags
  // every `persist` that is not false, null, undefined or ''. Each row is the tier as it is written, and its value.
  const TIERS = [
    ["'immutable'", 'immutable'],
    ["'revalidate'", 'revalidate'],
    ["'none'", 'none'],
    ["'session'", 'session'],
    ["'Immutable'", 'Immutable'],
    ["'false'", 'false'],
    ['true', true],
    ['1', 1],
    ['{}', {}],
    ['false', false],
    ["''", ''],
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
  ];
  const OFF = ['false', "''", 'null', 'undefined'];

  for (const [literal, value] of TIERS) {
    it(`${literal}: the scan tags every one that the persister writes, and none of the four that leave a query off`, async () => {
      const written = await persisterWrites(value);
      const { offenders } = check('x.ts', hook(`  return useQuery({ queryKey: ['balance', address], queryFn, meta: { persist: ${literal} } })`));
      // The persister's rule: a truthy tier is written.
      assert.equal(written, Boolean(value));
      // Nothing it writes gets past the scan. (0 is not written and is tagged all the same: a tier that is not a
      // literal false, null, undefined or '' is read as on.)
      assert.ok(offenders.length > 0 || !written);
      if (OFF.includes(literal)) assert.deepEqual(offenders, []);
    });
  }
});

describe('an untagged query', () => {
  it('is left out of what the persister writes for the tagged query beside it', async () => {
    const tagged = ['project', 1, 2];
    const written = await persistedKeys([{ queryKey: ['balance', '0xabc'] }, { queryKey: tagged, meta: { persist: 'revalidate' } }]);
    assert.deepEqual(written, [JSON.stringify(tagged)]);
  });
});
