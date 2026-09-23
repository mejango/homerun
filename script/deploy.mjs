import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { absoluteRemappings } from '../scripts/forge-remappings.mjs';

// Every sibling checkout that compiles into the contracts (the artifact's `metadata.sources` roots), at its reviewed
// revision. The remappings in remappings.txt point at these directories; they are not npm packages, so they carry no
// integrity hash.
export const dependencies = {
  'nana-core-v6': 'feff600654aee6fb1747dded692f18068b2230a6',
  'nana-721-hook-v6': '1ec28e68a550cc0c09428416fb9d7698959591f8',
  'nana-omnichain-deployers-v6': 'd8dcd3b8c05ad9ef5a35001d84a89e48fa763312',
  'nana-ownable-v6': '99f953c823ecfa96a3f2b5b699044094540cdb60',
  'nana-suckers-v6': '80dce063e7219e49405094d941b1a13ef9eeb699',
  'revnet-core-v6': '5093359f561c0546c29b85147a9cc0de2f608ddf',
  'nana-router-terminal-v6': '55bf69bc910b1ba6588afc7f97d316a44e4b5039',
  'croptop-core-v6': '98f4a025c8131a8e7ceb28f9cafb491a17f8e1a4',
  'nana-buyback-hook-v6': '982bec7fcf941c0cb6f86dc152a9b812c1a4d04f',
  'nana-address-registry-v6': 'bcafa672489a5281ca36950f5d23aa0d1575c422',
  'nana-permission-ids-v6': 'e75d962ebcade48c0e19d849fe27a7e200b3ed74',
};

// The npm packages the contracts compile against through the siblings' node_modules. A sibling's git status never
// sees them, so their published versions are pinned here.
export const packages = {
  'nana-core-v6/node_modules/@openzeppelin/contracts': '5.6.1',
  'nana-core-v6/node_modules/@uniswap/permit2': '1.0.0',
  'revnet-core-v6/node_modules/solady': '0.1.26',
  'revnet-core-v6/node_modules/@prb/math': '4.1.2',
  'nana-suckers-v6/node_modules/@chainlink/contracts-ccip': '1.6.4',
};

export function workspace(env = process.env) {
  return env.HOMERUN_WORKSPACE_PATH || '../..';
}

export function verifyDependencies(spawn = spawnSync, env = process.env, read = readFileSync) {
  for (const [name, expected] of Object.entries(dependencies)) {
    const args = ['-C', `${workspace(env)}/${name}`];
    const revision = spawn('git', [...args, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const status = spawn('git', [...args, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
    // Only a sibling's `src/` compiles into the contracts; tests, scratch files and Finder droppings do not.
    const sourceChanges = status.stdout?.split('\n')
      .filter(line => /^.{3}(.* -> )?src\//.test(line) && !/\/\.DS_Store$/.test(line)) ?? [];
    if (revision.status !== 0 || revision.stdout.trim() !== expected || status.status !== 0 || sourceChanges.length) {
      throw new Error(`${name} must be clean under src/ at the reviewed revision ${expected}.`);
    }
  }
  for (const [path, expected] of Object.entries(packages)) {
    let version;
    try {
      version = JSON.parse(read(`${workspace(env)}/${path}/package.json`, 'utf8')).version;
    } catch {
      version = undefined;
    }
    if (version !== expected) throw new Error(`${path} must be the reviewed version ${expected}.`);
  }
}

export const networks = {
  mainnets: [
    ['ethereum', 1, 'RPC_ETHEREUM_MAINNET', 'ethereum'],
    ['optimism', 10, 'RPC_OPTIMISM_MAINNET', 'optimism'],
    ['base', 8453, 'RPC_BASE_MAINNET', 'base'],
    ['arbitrum', 42161, 'RPC_ARBITRUM_MAINNET', 'arbitrum'],
  ],
  testnets: [
    ['ethereum_sepolia', 11155111, 'RPC_ETHEREUM_SEPOLIA', 'sepolia'],
    ['optimism_sepolia', 11155420, 'RPC_OPTIMISM_SEPOLIA', 'optimism_sepolia'],
    ['base_sepolia', 84532, 'RPC_BASE_SEPOLIA', 'base_sepolia'],
    ['arbitrum_sepolia', 421614, 'RPC_ARBITRUM_SEPOLIA', 'arbitrum_sepolia'],
  ],
};

// The protocol artifacts the deployer binds on every chain of a group; the core is read from the revnet deployer.
export const artifacts = [
  ['revnet-core-v6', 'REVDeployer'],
  ['nana-omnichain-deployers-v6', 'JBOmnichainDeployer'],
];

// The Nana SDK's deployment registry is an independent record of the same addresses.
export async function sdkRegistry() {
  const { jbContractAddress } = await import('@bananapus/nana-sdk-core');
  return (name, chainId) => jbContractAddress['6']?.[name]?.[chainId];
}

export function preflight(group, env = process.env, read = readFileSync, registry = () => undefined) {
  if (!networks[group]) throw new Error('Network group must be testnets or mainnets.');
  const errors = [];
  for (const [alias, chainId, variable, folder] of networks[group]) {
    if (!env[variable]?.trim()) errors.push(`${alias}: missing ${variable}`);
    for (const [repo, name] of artifacts) {
      const file = `${workspace(env)}/${repo}/deployments/${folder}/${name}.json`;
      try {
        const artifact = JSON.parse(read(file, 'utf8'));
        if (!/^0x[\da-fA-F]{40}$/.test(artifact.address || '') || /^0x0{40}$/.test(artifact.address)) {
          throw new Error('invalid contract address');
        }
        if (BigInt(artifact.chainId) !== BigInt(chainId)) throw new Error('wrong chain ID');
        const registered = registry(name, chainId);
        if (registered && registered.toLowerCase() !== artifact.address.toLowerCase()) {
          errors.push(`${alias}: ${name} artifact ${artifact.address} differs from the SDK registry ${registered}`);
        }
      } catch {
        errors.push(`${alias}: missing or invalid ${name} artifact (address/chain ID)`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

// Every chain of a group must predict one hook and one deployer.
export function requireOneAddressPerGroup(group, kind, read = readFileSync) {
  const fields = ['allowlistHook', 'deployer'];
  let expected;
  for (const [alias, , , folder] of networks[group]) {
    const manifest = JSON.parse(read(`deployments/${folder}/${kind}.json`, 'utf8'));
    const identity = fields.map(field => `${field}=${String(manifest[field]).toLowerCase()}`).join(' ');
    expected ??= identity;
    if (identity !== expected) throw new Error(`${alias} predicts a different deployment than the rest of ${group}: ${identity}`);
  }
}

export async function run(action, group, {
  env = process.env, spawn = spawnSync, read = readFileSync, remappings = absoluteRemappings, registry,
} = {}) {
  if (!['preflight', 'rehearse', 'propose', 'broadcast', 'verify', 'artifacts'].includes(action)) {
    throw new Error('Usage: deploy.sh <preflight|rehearse|propose|broadcast|verify|artifacts> <testnets|mainnets>');
  }
  preflight(group, env, read, registry ?? await sdkRegistry());
  if (action === 'propose') {
    for (const key of ['SPHINX_MANAGED_BASE_URL', 'SPHINX_ORG_ID', 'SPHINX_API_KEY']) {
      if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
    }
    // Sphinx resolves the organization and Safe from this public lock before collecting any transactions.
    let lock;
    let projectName;
    try {
      lock = JSON.parse(read('sphinx.lock', 'utf8'));
      projectName = read('script/Deploy.s.sol', 'utf8').match(/sphinxConfig\.projectName\s*=\s*"([^"]+)"/)?.[1];
      if (!projectName || lock.projects?.[projectName]?.projectName !== projectName) throw new Error();
    } catch {
      throw new Error('The committed sphinx.lock must contain the deployment script\'s registered Sphinx project.');
    }
    if (lock.orgId !== env.SPHINX_ORG_ID.trim()) {
      throw new Error('SPHINX_ORG_ID does not match the committed sphinx.lock organization.');
    }
  }
  if (action !== 'rehearse') verifyDependencies(spawn, env, read);
  if (action === 'preflight') return;
  const revision = spawn('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (revision.status !== 0) throw new Error('Cannot record the source revision.');
  const status = spawn('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
  if (status.status !== 0) throw new Error('Cannot inspect the source checkout.');
  // The runner's own outputs under deployments/ do not make the reviewed source dirty.
  const dirty = status.stdout.split('\n').some(line => line.trim() && !/^.{3}deployments\//.test(line));
  // Only a committed checkout may reach the Safe or certify a live deployment; rehearsals may carry development changes.
  if (dirty && action !== 'rehearse') throw new Error(`Commit the reviewed checkout before ${action}; it has uncommitted changes.`);
  // A broadcast sends the deployments from a funded key instead of collecting a Safe proposal; the factory makes the
  // addresses equal. Only the Homerun Safe can set the deployer's chain-specific constants, so a proposal follows.
  const deployerKey = env.HOMERUN_DEPLOYER_KEY?.trim();
  if (action === 'broadcast' && !deployerKey) throw new Error('Missing HOMERUN_DEPLOYER_KEY');
  const childEnv = {
    ...env, FOUNDRY_PROFILE: 'deploy', FOUNDRY_REMAPPINGS: await remappings(env),
    HOMERUN_REVISION: revision.stdout.trim() + (dirty ? '-dirty' : ''),
  };
  const execute = (command, args, chainId = 0, block = { number: '0', hash: '0x' + '00'.repeat(32) }) => {
    const result = spawn(command, args, { env: {
      ...childEnv, HOMERUN_EXPECTED_CHAIN_ID: String(chainId),
      HOMERUN_RPC_BLOCK_NUMBER: block.number, HOMERUN_RPC_BLOCK_HASH: block.hash,
    }, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${command} failed; stopping ${group} ${action}.`);
  };
  // Explorer verification and per-contract artifacts read the verified manifests, so they follow a verify.
  if (action === 'artifacts') {
    execute('node', ['script/artifacts.mjs', group]);
    return;
  }
  if (action === 'broadcast') {
    for (const [alias, chainId] of networks[group]) {
      console.log(`broadcast: ${alias}`);
      execute('forge', ['script', 'script/Broadcast.s.sol:Broadcast', '--rpc-url', alias, '--broadcast', '--private-key',
        deployerKey, '-vv'], chainId);
    }
  }
  // Rehearse every destination successfully before creating a Sphinx proposal, and after a broadcast, where the
  // rehearsal simulates the Safe's configuration of what the broadcast deployed.
  const script = action === 'verify' ? 'Verify' : 'Rehearse';
  for (const [alias, chainId] of networks[group]) {
    console.log(`${action}: ${alias}`);
    // RPC block heights identify fork state even on chains where EVM block.number means an L1 height.
    const header = spawn('cast', ['block', 'latest', '--json', '--rpc-url', alias], { env: childEnv, encoding: 'utf8' });
    let block;
    try {
      if (header.status !== 0) throw new Error();
      const payload = JSON.parse(header.stdout);
      if (payload.success === false) throw new Error();
      block = payload.data ?? payload;
      block.number = BigInt(block.number).toString();
      if (BigInt(block.number) <= 0n || !/^0x[\da-fA-F]{64}$/.test(block.hash)) throw new Error();
    } catch {
      throw new Error(`${alias}: cannot read a canonical RPC block; stopping ${action}.`);
    }
    execute('forge', ['script', `script/${script}.s.sol:${script}`, '--rpc-url', alias,
      '--fork-block-number', block.number, '-vv'], chainId, block);
  }
  requireOneAddressPerGroup(group, script === 'Verify' ? 'verified' : 'simulation', read);
  if (action === 'propose') {
    execute('node_modules/.bin/sphinx', ['propose', 'script/Deploy.s.sol', '--target-contract', 'Deploy', '--networks', group]);
  }
  if (action === 'broadcast') {
    console.log(`Deployed ${group}. Run deploy:propose:${group} so the Safe sets the chain-specific constants, then deploy:verify:${group}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: deploy.sh <preflight|rehearse|propose|broadcast|verify|artifacts> <testnets|mainnets>');
    await run(process.argv[2], process.argv[3]);
    console.log(`Homerun ${process.argv[2]} completed for ${process.argv[3]}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
