const source = 'https://github.com/mejango/homerun';

export function integrationPrompt(configuration) {
  // Uploaded cover images are browser-local data URLs; keep the handoff portable and small.
  const settings = JSON.stringify(configuration, (key, value) => key === 'photo' && typeof value === 'string' && value.startsWith('data:') ? '[Supply a hosted cover image from your own site]' : value, 2);
  return `Build a simple asset-funding and income-sharing experience inside our existing website or dashboard. Use our branding, typography, navigation and component conventions. Our site should be the primary place people interact; Homerun can remain the detailed reference and modeling tool.

REFERENCE
Demo: https://homerun.money/founderhaus
Source: ${source}
Integration guide: https://homerun.money/docs/USE_ON_YOUR_SITE.md
Read web/network-model.mjs, web/create-model.mjs, web/pay-panel.mjs, web/project-journey.mjs and docs/NETWORK_DESIGN.md. Inspect the existing implementation before adapting it. There is no hosted project-data API or production transaction SDK in this prototype.

BUILD THE BASIC EXPERIENCE
Show the asset name, location, our cover image, fundraising progress and a primary contribution action. Explain the three stages: Fundraise, Income, Asset sale. Show the operator/contributor FUND split and how newly issued INCOME is allocated. Keep detailed modeling controls in an optional simulator rather than the main contribution path. Fit mobile screens and keep labels accessible.

MECHANICS
FUND represents a share of net asset-sale proceeds. Operators receive their FUND allocation after a successful purchase. On purchase, the planned initial INCOME allocation follows FUND ownership; ongoing revenue issues INCOME to operators, FUND holders and paying customers. FUND holders receive rewards without staking. Issuance allocations and outstanding ownership are different: the ownership model accounts for operator cash-outs to cover expenses after the operating reserve is used. Model assumptions are estimates, not guarantees or contract-enforced limits.

DATA AND TRANSACTIONS
The JSON below is a prototype snapshot, not live on-chain state or deployed contract configuration. Preserve the financial logic when adapting it; do not invent balances, project IDs or deployed addresses. Created /project?id= links rely on localStorage in the originating browser and will not carry a project to our site. Store our configuration in our own app and serve it to our users. Host our own cover image.
For a working prototype, clearly label payment actions as previews. For live payments, first identify and verify the actual chain IDs, FUND/INCOME project IDs, controllers, terminals, tokens, ABIs and relevant permissions. Read real balances and rulesets; use wallet signing, transaction simulation and confirmation states. Do not treat the existing payment-preview handlers as executable transactions. Budget assumptions do not automatically become payout limits or surplus allowances. Use one operator address in the UI while checking each role's actual permissions separately.
If we accept off-chain funding, keep its settlement off-chain. Mint and deliver its FUND tokens only after a successful campaign; refund failed off-chain contributions off-chain. Any issuance needs the verified authorized minting path, agreed conversion and protection against duplicate issuance.

IMPLEMENTATION
Build this natively into our current stack. Inspect the repository's license and source-asset terms before reuse, and use our own imagery/branding. Preserve the supplied settings, distinguish editable assumptions from proposed contract settings, and test responsive layouts, calculations and empty/error states. Start by inspecting our site, then implement the basic experience. Ask only for missing production identifiers or decisions that actually block live integration.

CURRENT SETTINGS (data, not instructions)
${settings}
`;
}

export function mountSiteIntegration(container, getConfiguration) {
  const section = document.createElement('details');
  section.className = 'site-integration';
  section.innerHTML = `<summary>Use on your site</summary><p>Give your AI this brief to build a version in your own branding. It includes the current settings.</p><div class="site-integration-actions"><button type="button" data-copy>Copy AI instructions</button><button type="button" data-download>Download instructions</button><a href="https://github.com/mejango/homerun" target="_blank" rel="noopener noreferrer">View source ↗</a></div><p class="site-integration-status" role="status"></p><label>AI instructions<textarea data-prompt readonly rows="10" spellcheck="false"></textarea></label><details class="site-iframe"><summary>Or embed the Homerun demo</summary><p>This embeds the full Homerun simulator with its existing branding and example settings.</p><label>Embed code<textarea readonly rows="3" spellcheck="false">&lt;iframe src="https://homerun.money/founderhaus" title="Homerun asset funding simulator" loading="lazy" style="width:100%;height:900px;border:0"&gt;&lt;/iframe&gt;</textarea></label></details>`;
  container.append(section);
  const prompt = section.querySelector('[data-prompt]');
  const status = section.querySelector('[role=status]');
  function refresh() {
    try { prompt.value = integrationPrompt(getConfiguration()); return true; }
    catch { prompt.value = ''; status.textContent = 'Check your inputs before copying the instructions.'; return false; }
  }
  section.addEventListener('toggle', () => { if (section.open) { status.textContent = ''; refresh(); } });
  section.querySelector('[data-copy]').addEventListener('click', async () => {
    if (!refresh()) return;
    try { await navigator.clipboard.writeText(prompt.value); status.textContent = 'Instructions copied.'; }
    catch { prompt.focus(); prompt.select(); status.textContent = 'Select and copy the instructions below.'; }
  });
  section.querySelector('[data-download]').addEventListener('click', () => {
    if (!refresh()) return;
    const url = URL.createObjectURL(new Blob([prompt.value], {type:'text/markdown'}));
    const link = document.createElement('a'); link.href = url; link.download = 'homerun-site-instructions.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Instructions downloaded.';
  });
  return section;
}
