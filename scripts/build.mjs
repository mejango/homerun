import { cp, mkdir, readFile, access } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
for (const path of ['web/create/index.html', 'web/create.css', 'web/create-app.mjs', 'web/create-model.mjs', 'web/create-networks.mjs', 'web/create-income-preview.mjs', 'web/create-income-preview.css', 'web/assets/networks/ethereum.svg', 'web/assets/networks/optimism.svg', 'web/assets/networks/base.svg', 'web/assets/networks/arbitrum.svg', 'web/asset-sketch.mjs', 'web/project/index.html', 'web/project-entry.mjs']) await access(new URL(path, root));
for (const path of ['web/index.html', 'web/home.css', 'web/ballpark.mjs', 'web/founderhause/index.html', 'web/network.css', 'web/lifecycle.css', 'web/network-app.mjs', 'web/network-model.mjs', 'web/owner-actions.mjs', 'web/project-page.css', 'web/project-journey.mjs', 'web/project-journey.css', 'web/pay-panel.mjs', 'web/payment-currencies.mjs', 'web/pay-panel.css', 'web/pay-details.css', 'web/income-payment-preview.mjs']) await access(new URL(path, root));
await mkdir(new URL('dist/', root), { recursive: true });
await cp(new URL('web/', root), new URL('dist/', root), { recursive: true });
await mkdir(new URL('dist/docs/', root), { recursive: true });
for (const name of ['NETWORK_DESIGN.md', 'OWNER_ACTIONS.md', 'PLAYBOOK.md', 'MECHANISM.md', 'FOUNDER_HAUS_SOURCES.md']) {
  await cp(new URL(`docs/${name}`, root), new URL(`dist/docs/${name}`, root));
}
for (const [page, entries] of [['index.html', ['ballpark.mjs', 'home.css']], ['founderhause/index.html', ['network-app.mjs', 'network.css', 'project-page.css']]]) {
  const html = await readFile(new URL(`dist/${page}`, root), 'utf8');
  for (const entry of entries) if (!html.includes(entry)) throw new Error(`Missing ${entry} entry in ${page}`);
}
for (const [page, entries] of [['create/index.html', ['create-app.mjs', 'create.css']], ['project/index.html', ['project-entry.mjs', 'project-page.css']]]) {
  const html = await readFile(new URL(`dist/${page}`, root), 'utf8');
  for (const entry of entries) if (!html.includes(entry)) throw new Error(`Missing ${entry} entry in ${page}`);
}
process.stdout.write('Built Homerun homepage, creation flow, project previews and demo in dist/. No external runtime dependencies.\n');
