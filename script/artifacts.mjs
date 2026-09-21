// Verifies the deployed sources on the explorer and emits one `sphinx-sol-ct-artifact-1` JSON per contract and
// chain, the layout every V6 repository keeps under `deployments/<network>/`. Reads the addresses from the
// `verified.json` the runner wrote, the compiled artifact from `out/` and the creation transaction from Etherscan.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeAbiParameters } from 'viem';
import { networks } from './deploy.mjs';

export const contracts = [
  { name: 'HomerunAllowlistHook', field: 'allowlistHook', sourceName: 'src/HomerunAllowlistHook.sol' },
  { name: 'HomerunDeployer', field: 'deployer', sourceName: 'src/HomerunDeployer.sol' },
];

// One Etherscan v2 key serves every chain.
const explorer = 'https://api.etherscan.io/v2/api';

export async function emit(group, { env = process.env, spawn = spawnSync, fetchJson = explorerFetch, verifySources = true } = {}) {
  if (!networks[group]) throw new Error('Network group must be testnets or mainnets.');
  const key = env.ETHERSCAN_API_KEY?.trim();
  if (!key) throw new Error('Missing ETHERSCAN_API_KEY');
  // Verification rebuilds from the committed relative remappings, so the explorer sees paths it can resolve; the
  // runner's absolute remappings would put unresolvable paths into the standard JSON.
  const { FOUNDRY_REMAPPINGS: _absolute, ...inherited } = env;
  const childEnv = { ...inherited, FOUNDRY_PROFILE: 'deploy' };
  for (const [alias, chainId, , folder] of networks[group]) {
    const manifest = JSON.parse(readFileSync(`deployments/${folder}/verified.json`, 'utf8'));
    for (const contract of contracts) {
      const address = manifest[contract.field];
      const artifact = JSON.parse(readFileSync(`out/${contract.name}.sol/${contract.name}.json`, 'utf8'));
      const creation = await fetchJson(`${explorer}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`);
      const txHash = creation.result?.[0]?.txHash;
      if (!txHash) throw new Error(`${alias}: no creation transaction for ${contract.name} at ${address}`);
      const receipt = (await fetchJson(`${explorer}?chainid=${chainId}&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${key}`)).result;
      if (!receipt?.blockHash) throw new Error(`${alias}: no receipt for ${txHash}`);
      // The explorer's creation bytecode is the factory's payload without the salt: creation code then arguments.
      const argsHex = constructorArgs(creation.result[0].creationBytecode, artifact.bytecode.object);
      if (verifySources) verify({ alias, chainId, address, contract, argsHex, spawn, env: childEnv, key });
      const ctor = artifact.abi.find(entry => entry.type === 'constructor');
      const args = argsHex ? decodeAbiParameters(ctor.inputs, `0x${argsHex}`).map(plain) : [];
      const record = {
        format: 'sphinx-sol-ct-artifact-1',
        address: address.toLowerCase(),
        sourceName: contract.sourceName,
        contractName: contract.name,
        chainId: `0x${Number(chainId).toString(16)}`,
        abi: artifact.abi,
        args,
        solcInputHash: createHash('md5').update(artifact.rawMetadata).digest('hex'),
        receipt,
        bytecode: artifact.bytecode.object,
        deployedBytecode: artifact.deployedBytecode.object,
        metadata: artifact.rawMetadata,
        gitCommit: manifest.revision,
        gitDirty: String(manifest.revision).endsWith('-dirty'),
        history: [],
      };
      writeFileSync(`deployments/${folder}/${contract.name}.json`, `${JSON.stringify(record, null, '\t')}\n`);
      console.log(`${alias}: ${contract.name}.json`);
    }
  }
}

function constructorArgs(creationBytecode, creationCode) {
  const input = String(creationBytecode || '').replace(/^0x/, '').toLowerCase();
  const code = creationCode.replace(/^0x/, '').toLowerCase();
  if (!input.startsWith(code)) throw new Error('The creation bytecode does not start with the compiled creation code.');
  return input.slice(code.length);
}

function verify({ alias, chainId, address, contract, argsHex, spawn, env, key }) {
  const args = ['verify-contract', address, `${contract.sourceName}:${contract.name}`, '--chain-id', String(chainId),
    '--verifier', 'etherscan', '--verifier-url', `${explorer}?chainid=${chainId}`, '--etherscan-api-key', key,
    '--compiler-version', '0.8.28', '--num-of-optimizations', '200', '--evm-version', 'cancun', '--via-ir',
    '--skip-is-verified-check', '--watch', '--retries', '12', '--delay', '10'];
  if (argsHex) args.push('--constructor-args', `0x${argsHex}`);
  const result = spawn('forge', args, { env, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !/already verified/i.test(output)) {
    throw new Error(`${alias}: explorer verification of ${contract.name} failed:\n${output.slice(-800)}`);
  }
  console.log(`${alias}: ${contract.name} source verified`);
}

// Tuples decode to objects and integers to bigints; the artifact keeps them as JSON.
function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

async function explorerFetch(url) {
  for (let attempt = 1; ; attempt++) {
    await sleep(250);
    const body = await (await fetch(url)).json();
    if (!/rate limit|max calls/i.test(String(body.message ?? body.result ?? '')) || attempt === 8) return body;
    await sleep(1000 * 2 ** attempt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: artifacts.mjs <testnets|mainnets>');
    await emit(process.argv[2]);
    console.log(`Homerun artifacts completed for ${process.argv[2]}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
