import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencies, packages, verifyDependencies, workspace } from '../script/deploy.mjs'

// Builds the workspace remappings.txt expects on a machine that has only this repository: every sibling protocol
// checkout at the revision script/deploy.mjs pins, and the npm packages the contracts compile against through
// their node_modules. The siblings land in HOMERUN_WORKSPACE_PATH (default ../..). verifyDependencies then checks
// the result, package versions included, against the same pins the deployment commands check.

// The siblings that do not live under Bananapus.
const owners = { 'revnet-core-v6': 'rev-net', 'croptop-core-v6': 'mejango' }
// The only submodule the remappings reach is forge-std in nana-core-v6.
const submodules = { 'nana-core-v6': ['lib/forge-std'] }

/**
 * The exact versions to install in each sibling once its own install is done: the registry packages among the pins in
 * script/deploy.mjs, keyed by sibling. `declared(sibling)` gives what the sibling's package.json asks for. A package it
 * takes from git (@uniswap/permit2 is a GitHub dependency pinned to a commit) is not on the registry and cannot
 * float, so the sibling's own install already fixed it.
 */
export function pinnedInstalls(pins, declared) {
  const installs = new Map()
  for (const [path, version] of Object.entries(pins)) {
    const [sibling, name] = path.split('/node_modules/')
    if (/^(github:|git[+:]|https?:)/.test(declared(sibling)[name] ?? '')) continue
    installs.set(sibling, [...(installs.get(sibling) ?? []), `${name}@${version}`])
  }
  return installs
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
}

function prepareWorkspace() {
  const root = resolve(workspace())
  mkdirSync(root, { recursive: true })
  for (const [name, revision] of Object.entries(dependencies)) {
    const directory = resolve(root, name)
    if (existsSync(directory)) throw new Error(`${directory} exists; this script only creates checkouts`)
    mkdirSync(directory)
    run('git', ['init', '--quiet'], directory)
    run('git', ['fetch', '--quiet', '--depth', '1', `https://github.com/${owners[name] ?? 'Bananapus'}/${name}.git`, revision], directory)
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], directory)
    for (const path of submodules[name] ?? []) run('git', ['submodule', 'update', '--quiet', '--init', '--depth', '1', path], directory)
  }
  // The siblings' lockfiles lag their package.json, so `npm ci` refuses them. Their own workflows run `npm install`
  // (nana-core-v6's with --omit=dev) and so does this, with the dev dependencies: the remappings reach revnet-core-v6's
  // @uniswap/v4-core, a devDependency. A plain install lets versions float with upstream publishes, so the versions
  // pinned in `packages` are installed again, exactly, afterwards. Scripts stay off: the contracts need the packages'
  // files, not their install hooks.
  const install = ['--ignore-scripts', '--no-audit', '--no-fund']
  const declared = sibling => {
    const manifest = JSON.parse(readFileSync(resolve(root, sibling, 'package.json'), 'utf8'))
    return { ...manifest.dependencies, ...manifest.devDependencies }
  }
  const pins = pinnedInstalls(packages, declared)
  for (const name of new Set(Object.keys(packages).map(path => path.split('/node_modules/')[0]))) {
    run('npm', ['install', ...install], resolve(root, name))
    if (pins.has(name)) run('npm', ['install', '--no-save', ...install, ...pins.get(name)], resolve(root, name))
  }
  verifyDependencies()
  console.log(`Workspace ready in ${root}.`)
}

// Started through a symlink, argv[1] is the link and import.meta.url the real path, so compare the real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepareWorkspace()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
