import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dependencies, packages, verifyDependencies, workspace } from '../script/deploy.mjs'

// Builds the workspace remappings.txt expects on a machine that has only this repository: every sibling protocol
// checkout at the revision script/deploy.mjs pins, and the npm packages the contracts compile against through
// their node_modules. The siblings land in HOMERUN_WORKSPACE_PATH (default ../..). verifyDependencies then checks
// the result, package versions included, against the same pins the deployment commands check.

// The siblings that do not live under Bananapus.
const owners = { 'revnet-core-v6': 'rev-net', 'croptop-core-v6': 'mejango' }
// The only submodule the remappings reach is forge-std in nana-core-v6.
const submodules = { 'nana-core-v6': ['lib/forge-std'] }

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
}

try {
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
  // The siblings' lockfiles lag their package.json, so `npm ci` refuses them; their own CI runs `npm install`, and so
  // does this. The packages that matter are pinned in `packages` and checked below. Scripts stay off: the contracts need
  // the packages' files, not their install hooks.
  for (const name of new Set(Object.keys(packages).map(path => path.split('/')[0]))) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], resolve(root, name))
  }
  verifyDependencies()
  console.log(`Workspace ready in ${root}.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
