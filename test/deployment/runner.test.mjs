import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { artifacts, dependencies, networks, packages, preflight, requireOneAddressPerGroup, run, verifyDependencies } from '../../script/deploy.mjs';

const WORKSPACE = '/workspace';

function fixture(group) {
  const env = { SPHINX_ORG_ID: JSON.parse(readFileSync('sphinx.lock')).orgId, SPHINX_API_KEY: 'test-key',
    SPHINX_MANAGED_BASE_URL: 'https://sphinx.example.test', HOMERUN_WORKSPACE_PATH: WORKSPACE };
  const files = {};
  const manifest = JSON.stringify({ allowlistHook: '0xbb', deployer: '0xcc', protocolConfigHash: '0xdd' });
  for (const [, chainId, key, folder] of networks[group]) {
    env[key] = 'http://127.0.0.1:8545';
    for (const [repo, name] of artifacts) {
      files[`${WORKSPACE}/${repo}/deployments/${folder}/${name}.json`] = JSON.stringify({
        address: '0x' + '12'.repeat(20), chainId: `0x${chainId.toString(16)}`,
      });
    }
    files[`deployments/${folder}/simulation.json`] = manifest;
    files[`deployments/${folder}/verified.json`] = manifest;
  }
  for (const [path, version] of Object.entries(packages)) {
    files[`${WORKSPACE}/${path}/package.json`] = JSON.stringify({ version });
  }
  return { env, files, read: file => files[file] ?? readFileSync(file, 'utf8'), remappings: async () => 'a=/b/', registry: () => undefined };
}

const block = { number: '0x64', hash: '0x' + 'ab'.repeat(32) };
function readOnlyTool(command, args) {
  if (command === 'cast') return { status: 0, stdout: JSON.stringify({ schema_version: 1, success: true, data: block }) };
  if (command !== 'git') return;
  if (args[0] === '-C') {
    return { status: 0, stdout: args[2] === 'rev-parse' ? dependencies[args[1].replace(`${WORKSPACE}/`, '')] : '' };
  }
  return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc123\n' : '' };
}

for (const group of Object.keys(networks)) {
  test(`${group}: all four rehearsals precede the Sphinx proposal`, async () => {
    const calls = [];
    await run('propose', group, { ...fixture(group), spawn(command, args, options) {
      const tool = readOnlyTool(command, args);
      if (tool) return tool;
      calls.push({ command, args, chainId: options.env.HOMERUN_EXPECTED_CHAIN_ID });
      assert.equal(options.env.FOUNDRY_PROFILE, 'deploy');
      assert.equal(options.env.FOUNDRY_REMAPPINGS, 'a=/b/');
      assert.equal(options.env.HOMERUN_REVISION, 'abc123');
      if (command === 'forge') {
        assert.equal(options.env.HOMERUN_RPC_BLOCK_NUMBER, '100');
        assert.equal(options.env.HOMERUN_RPC_BLOCK_HASH, block.hash);
        assert.deepEqual(args.slice(4, 6), ['--fork-block-number', '100']);
      }
      return { status: 0 };
    } });
    assert.deepEqual(calls.slice(0, 4).map(call => call.args[3]), networks[group].map(([alias]) => alias));
    assert.deepEqual(calls.slice(0, 4).map(call => call.chainId), networks[group].map(([, id]) => String(id)));
    assert.equal(calls[4].chainId, '0');
    assert.equal(calls[4].command, 'node_modules/.bin/sphinx');
    assert.deepEqual(calls[4].args.slice(-2), ['--networks', group]);
    assert.equal(calls.length, 5);
  });
}

test('failed rehearsal prevents proposal submission and remaining execution', async () => {
  let attempts = 0;
  await assert.rejects(run('propose', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    attempts++;
    assert.equal(command, 'forge');
    return { status: 1 };
  } }), /stopping/);
  assert.equal(attempts, 1);
});

test('verification only runs read-only Verify on every destination', async () => {
  let attempts = 0;
  await run('verify', 'mainnets', { ...fixture('mainnets'), spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    attempts++;
    assert.equal(command, 'forge');
    assert.equal(args[1], 'script/Verify.s.sol:Verify');
    assert.ok(!args.includes('--broadcast'));
    return { status: 0 };
  } });
  assert.equal(attempts, 4);
});

test('preflight rejects missing RPCs and mismatched artifacts without leaking values', () => {
  const { env, read } = fixture('testnets');
  delete env.RPC_BASE_SEPOLIA;
  assert.throws(() => preflight('testnets', env, read), /missing RPC_BASE_SEPOLIA/);
  assert.throws(() => preflight('mainnets', env, () => JSON.stringify({ address: '0x' + '12'.repeat(20), chainId: 1 })), /invalid JBController/);
  assert.throws(() => preflight('unknown'), /Network group/);
});

test('missing proposal credentials fail before any child process starts', async () => {
  const setup = fixture('testnets');
  delete setup.env.SPHINX_API_KEY;
  await assert.rejects(run('propose', 'testnets', { ...setup, spawn() { assert.fail('must not execute'); } }), /Missing SPHINX_API_KEY/);
});

test('runner destinations match the Sphinx entrypoint exactly', () => {
  const source = readFileSync('script/Deploy.s.sol', 'utf8');
  for (const group of Object.keys(networks)) {
    const line = source.split('\n').find(line => line.includes(`sphinxConfig.${group} =`));
    const configured = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1));
    assert.deepEqual(networks[group].map(([alias]) => alias), configured);
  }
});

test('release dependencies must match pinned clean sibling checkouts and package versions', () => {
  const env = { HOMERUN_WORKSPACE_PATH: WORKSPACE };
  const { read } = fixture('mainnets');
  verifyDependencies(readOnlyTool, env, read);
  assert.throws(() => verifyDependencies((command, args) => ({ status: 0, stdout: args[2] === 'rev-parse' ? 'wrong' : '' }), env, read), /reviewed revision/);
  assert.throws(() => verifyDependencies((command, args) => args[2] === 'status'
    ? { status: 0, stdout: ' M src/JBController.sol' } : readOnlyTool(command, args), env, read), /must be clean/);
  assert.throws(() => verifyDependencies(readOnlyTool, env, file => file.endsWith('package.json') ? '{"version":"0.0.0"}' : read(file)), /reviewed version/);
  // Every source root the compiled deployer depends on is pinned: sibling checkouts by revision, their packages by version.
  const artifact = JSON.parse(readFileSync('out/HomerunDeployer.sol/HomerunDeployer.json', 'utf8'));
  const root = realpathSync(resolve('../..')) + '/';
  for (const source of Object.keys(artifact.metadata.sources)) {
    if (!source.startsWith(root)) {
      assert.ok(/^(src|script)\//.test(source), `${source} must be this repository's or a sibling's source`);
      continue;
    }
    const relative = source.slice(root.length);
    const pkg = relative.match(/^([^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (pkg) assert.ok(packages[pkg], `${pkg} must be pinned for release`);
    else assert.ok(dependencies[relative.split('/')[0]], `${relative.split('/')[0]} must be pinned for release`);
  }
  // Every remapped protocol source the contracts import is pinned.
  const remappings = readFileSync('remappings.txt', 'utf8');
  for (const source of ['src/HomerunDeployer.sol', 'src/HomerunAllowlistHook.sol']) {
    for (const [, prefix] of readFileSync(source, 'utf8').matchAll(/from "(@[^/]+\/[^/]+)\//g)) {
      if (prefix === '@openzeppelin/contracts') continue;
      const target = remappings.match(new RegExp(`^${prefix.replace(/[/@-]/g, '\\$&')}/=\\.\\./\\.\\./([^/]+)/`, 'm'))?.[1];
      assert.ok(target, `${prefix} must remap to a sibling checkout`);
      assert.ok(dependencies[target], `${target} must be pinned for release`);
    }
  }
});

test('missing block identity stops before any Forge or Sphinx execution', async () => {
  await assert.rejects(run('rehearse', 'testnets', { ...fixture('testnets'), spawn(command, args) {
    if (command === 'cast') return { status: 1, stdout: '' };
    assert.equal(command, 'git');
    return readOnlyTool(command, args);
  } }), /canonical RPC block/);
});

test('proposal rejects a missing lock, wrong organization, or unregistered project', async () => {
  for (const fault of ['missing', 'organization', 'project']) {
    const setup = fixture('testnets');
    const read = setup.read;
    setup.read = file => {
      if (file !== 'sphinx.lock') return read(file);
      if (fault === 'missing') throw new Error('not found');
      const lock = JSON.parse(read(file));
      if (fault === 'organization') lock.orgId = 'different-org';
      if (fault === 'project') lock.projects = {};
      return JSON.stringify(lock);
    };
    await assert.rejects(run('propose', 'testnets', { ...setup, spawn() { assert.fail('must not execute'); } }));
  }
});

test('an uncommitted checkout can rehearse but neither propose nor verify', async () => {
  const dirtyGit = (command, args) => command === 'git' && args[0] === 'status' ? { status: 0, stdout: ' M src/HomerunDeployer.sol' } : readOnlyTool(command, args);
  for (const action of ['propose', 'verify']) {
    await assert.rejects(run(action, 'testnets', { ...fixture('testnets'), spawn(command, args) {
      const tool = dirtyGit(command, args);
      if (tool) return tool;
      assert.fail(`${action} must not execute anything from a dirty checkout`);
    } }), /uncommitted/);
  }
  let forgeRuns = 0;
  await run('rehearse', 'testnets', { ...fixture('testnets'), spawn(command, args, options) {
    const tool = dirtyGit(command, args);
    if (tool) return tool;
    forgeRuns++;
    assert.equal(options.env.HOMERUN_REVISION, 'abc123-dirty');
    return { status: 0 };
  } });
  assert.equal(forgeRuns, 4);
});

test('a chain predicting different addresses stops the group before the Sphinx proposal', async () => {
  const setup = fixture('mainnets');
  setup.files['deployments/base/simulation.json'] = JSON.stringify({ allowlistHook: '0xbb', deployer: '0xee', protocolConfigHash: '0xdd' });
  assert.throws(() => requireOneAddressPerGroup('mainnets', 'simulation', setup.read), /base predicts a different deployment/);
  await assert.rejects(run('propose', 'mainnets', { ...setup, spawn(command, args) {
    const tool = readOnlyTool(command, args);
    if (tool) return tool;
    assert.notEqual(command, 'node_modules/.bin/sphinx', 'the proposal must not be collected');
    return { status: 0 };
  } }), /different deployment/);
});

test('preflight rejects an artifact that disagrees with the SDK registry', () => {
  const { env, read } = fixture('mainnets');
  preflight('mainnets', env, read, () => '0x' + '12'.repeat(20));
  assert.throws(() => preflight('mainnets', env, read, name => name === 'REVDeployer' ? '0x' + '34'.repeat(20) : undefined), /REVDeployer artifact .* differs from the SDK registry/);
});
