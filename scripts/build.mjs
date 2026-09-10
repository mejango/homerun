import { cp, mkdir, readFile, access, writeFile, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
for (const path of ['web/create/index.html', 'web/create.css', 'web/create-app.mjs', 'web/create-model.mjs', 'web/create-networks.mjs', 'web/create-income-preview.mjs', 'web/create-income-preview.css', 'web/assets/networks/ethereum.svg', 'web/assets/networks/optimism.svg', 'web/assets/networks/base.svg', 'web/assets/networks/arbitrum.svg', 'web/asset-sketch.mjs', 'web/project/index.html', 'web/project-entry.mjs']) await access(new URL(path, root));
for (const path of ['web/index.html', 'web/home.css', 'web/ballpark.mjs', 'web/founderhaus/index.html', 'web/network.css', 'web/lifecycle.css', 'web/network-app.mjs', 'web/network-model.mjs', 'web/owner-actions.mjs', 'web/project-page.css', 'web/project-journey.mjs', 'web/project-journey.css', 'web/pay-panel.mjs', 'web/payment-currencies.mjs', 'web/pay-panel.css', 'web/pay-details.css', 'web/income-payment-preview.mjs']) await access(new URL(path, root));
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/', root), { recursive: true });
await cp(new URL('web/', root), new URL('dist/', root), { recursive: true });
await mkdir(new URL('dist/docs/', root), { recursive: true });
for (const name of ['NETWORK_DESIGN.md', 'OWNER_ACTIONS.md', 'PLAYBOOK.md', 'MECHANISM.md', 'FOUNDER_HAUS_SOURCES.md']) {
  await cp(new URL(`docs/${name}`, root), new URL(`dist/docs/${name}`, root));
}
for (const [page, entries] of [['index.html', ['ballpark.mjs', 'home.css']], ['founderhaus/index.html', ['network-app.mjs', 'network.css', 'project-page.css']]]) {
  const html = await readFile(new URL(`dist/${page}`, root), 'utf8');
  for (const entry of entries) if (!html.includes(entry)) throw new Error(`Missing ${entry} entry in ${page}`);
}
for (const [page, entries] of [['create/index.html', ['create-app.mjs', 'create.css']], ['project/index.html', ['project-entry.mjs', 'project-page.css']]]) {
  const html = await readFile(new URL(`dist/${page}`, root), 'utf8');
  for (const entry of entries) if (!html.includes(entry)) throw new Error(`Missing ${entry} entry in ${page}`);
}
process.stdout.write('Built Homerun homepage, creation flow, project previews and demo in dist/. No external runtime dependencies.\n');

// Discover the static module graph at build time so navigation fetches dependencies together.
const webOrigin = new URL('https://homerun.money');
async function moduleDependencies(path, found = new Set()) {
  if (found.has(path)) return found;
  found.add(path);
  const source = await readFile(new URL(`web${path}`, root), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([./][^'"]+\.mjs)['"]/g)) {
    await moduleDependencies(new URL(match[1], new URL(path, webOrigin)).pathname, found);
  }
  return found;
}
for (const [page, entry] of [['index.html','/ballpark.mjs'],['create/index.html','/create-app.mjs'],['project/index.html','/project-entry.mjs'],['founderhaus/index.html','/network-app.mjs']]) {
  const dependencies = await moduleDependencies(entry);
  dependencies.delete(entry);
  const preload = [...dependencies].map(path => `  <link rel="modulepreload" href="${path}">`).join('\n');
  const target = new URL(`dist/${page}`, root);
  await writeFile(target, (await readFile(target,'utf8')).replace('</head>', `${preload}\n</head>`));
}
