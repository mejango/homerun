import { CREATE_DEFAULTS, CREATE_DRAFT_KEY, normalizeCreateDraft, creationSummary, deploymentDraft, saveCreatedProject } from './create-model.mjs';
import { initCreateIncomePreview } from './create-income-preview.mjs';
import { NETWORK_FAMILIES } from './create-networks.mjs';
import { drawAssetSketch } from './asset-sketch.mjs';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const labels = ['The asset', 'Fundraise', 'Income', 'Review & create'];
const groups = [ ['name', 'assetType', 'location', 'description', 'photo'], ['purchaseBudget', 'opsReserve', 'operatorFundPercent'], ['revenueDescription', 'monthlyRent', 'monthlyCosts', 'rentGrowthPercent', 'costGrowthPercent', 'operatorSplitPercent', 'stickySplitPercent'], ['networks', 'networkEnvironment', 'revnetOperatorEnabled', 'operatorWallet'] ];
let raw = { ...CREATE_DEFAULTS }, step = 0, furthest = 0, created;
let storageNotice = '';
try {
  const saved = JSON.parse(localStorage.getItem(CREATE_DRAFT_KEY) || 'null');
  if (saved?.raw && typeof saved.raw === 'object') {
    raw = { ...CREATE_DEFAULTS, ...Object.fromEntries(Object.keys(CREATE_DEFAULTS).filter(key => Object.hasOwn(saved.raw, key)).map(key => [key, saved.raw[key]])) };
    if (!Object.hasOwn(saved.raw, 'networks') && Object.hasOwn(saved.raw, 'network')) raw.networks = [saved.raw.network];
    if (!Object.hasOwn(saved.raw, 'revnetOperatorEnabled') && typeof saved.raw.operatorWallet === 'string') raw.revnetOperatorEnabled = Boolean(saved.raw.operatorWallet.trim());
    if (((saved.incomeDefaultsVersion ?? 0) < 2 && [[75, 15], [81, 6]].some(([operators, holders]) => Number(raw.operatorSplitPercent) === operators && Number(raw.stickySplitPercent) === holders)) || ((saved.incomeDefaultsVersion ?? 0) < 3 && Number(raw.operatorSplitPercent) === 68 && Number(raw.stickySplitPercent) === 13)) {
      raw.operatorSplitPercent = CREATE_DEFAULTS.operatorSplitPercent;
      raw.stickySplitPercent = CREATE_DEFAULTS.stickySplitPercent;
    }
    if (raw.name === 'Untitled Homerun') raw.name = 'Untitled';
    step = Number.isInteger(saved.step) ? Math.min(3, Math.max(0, saved.step)) : 0;
    furthest = step;
  }
} catch { storageNotice = 'Draft saving is unavailable. Keep this tab open while you work.'; }
raw.revnetOperatorEnabled = true;

function field(name, label, { prefix = '', suffix = '', placeholder = '', help = '', maxLength, rows, type = 'text' } = {}) {
  const numeric = name !== 'revenueDescription' && (groups[1].includes(name) || groups[2].includes(name));
  return `<div class="create-field"><label for="create-${name}">${label}</label><div class="create-input">${prefix ? `<span aria-hidden="true">${prefix}</span>` : ''}${rows ? `<textarea id="create-${name}" name="${name}" rows="${rows}" maxlength="${maxLength}" aria-describedby="${name}-help ${name}-error"></textarea>` : `<input id="create-${name}" name="${name}" type="${type}" ${numeric ? 'inputmode="decimal"' : ''} ${maxLength ? `maxlength="${maxLength}"` : ''} placeholder="${placeholder}" autocomplete="off" aria-describedby="${name}-help ${name}-error">`}${suffix ? `<span aria-hidden="true">${suffix}</span>` : ''}</div><p class="create-help" id="${name}-help">${help}</p><p class="create-error" id="${name}-error" hidden></p></div>`;
}
document.querySelector('#main').innerHTML = `<div class="create-intro"><div><h1>Design the game</h1></div><span class="prototype-tag">Deployment preview</span></div>
<div id="create-workspace" class="create-workspace">
  <section class="create-editor" aria-label="Design the game">
    <nav class="create-steps" aria-label="Setup steps">${labels.map((label,index) => `<button type="button" data-create-step="${index}"><span>${index+1}</span>${label}</button>`).join('')}</nav>
    <form id="create-form" novalidate>
      <section class="create-step" data-step-panel="0" aria-labelledby="step-title-0"><h2 id="step-title-0" tabindex="-1">Asset</h2>
        ${field('name', 'Title', { placeholder:'e.g. Neighborhood Workshop',maxLength:60 })}
        <div class="create-pair"><div class="create-field"><label for="create-assetType">Asset type</label><select id="create-assetType" name="assetType" aria-describedby="assetType-error"><option value="real-estate">Real estate</option><option value="business">Business</option><option value="equipment">Equipment</option><option value="energy">Energy</option><option value="other">Other asset</option></select><p id="assetType-error" class="create-error" hidden></p></div>${field('location','Location (optional)',{placeholder:'City, region',maxLength:100})}</div>
        ${field('description','The idea (optional)',{rows:3,maxLength:600,placeholder:'',help:'A short introduction to the asset and how it earns income.'})}
        <div class="create-field"><label for="create-photo">Cover photo (optional)</label><label class="photo-picker" for="create-photo"><span aria-hidden="true">＋</span><span>Choose a photo<small>JPG, PNG or WebP | up to 8 MB</small></span><input id="create-photo" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="photo-error"></label><button id="remove-photo" class="quiet-button" type="button" hidden>Remove photo</button><p class="create-error" id="photo-error" hidden></p></div>
      </section>
      <section class="create-step" data-step-panel="1" aria-labelledby="step-title-1" hidden><h2 id="step-title-1" tabindex="-1">Fundraise</h2>
        <div class="fundraise-inputs">${field('purchaseBudget','Asset price',{prefix:'$'})}${field('opsReserve','Cash reserve',{prefix:'$',help:'Cash set aside to cover operating expenses.'})}${field('operatorFundPercent','Operator FUND ownership',{suffix:'%',help:'Allocated after a successful purchase.'})}
        <div class="create-callout fundraise-goal"><span>Total fundraising goal</span><strong id="create-raise-goal">—</strong><p id="create-fee-note"></p></div>
        <div class="create-callout fundraise-ownership"><span>Operator FUND share</span><div id="create-fund-pie" class="fund-ownership-pie" role="img" aria-label="Operator FUND ownership"><strong id="create-fund-share" aria-hidden="true">—</strong></div></div></div>
        <p class="create-note">Contributors receive FUND. If the purchase succeeds, FUND represents a share of net asset-sale proceeds. A failed raise returns the remaining funds.</p>
      </section>
      <section class="create-step" data-step-panel="2" aria-labelledby="step-title-2" hidden><h2 id="step-title-2" tabindex="-1">Income</h2>
        <fieldset class="income-field-group"><legend>Revenue and expenses</legend><div class="income-inputs">${field('monthlyRent','Expected monthly revenue',{prefix:'$'})}${field('monthlyCosts','Expected monthly expenses',{prefix:'$'})}${field('rentGrowthPercent','Target revenue growth rate (%)',{suffix:'%',help:'Per year.'})}${field('costGrowthPercent','Target expense growth rate (%)',{suffix:'%',help:'Per year.'})}</div></fieldset><fieldset class="income-field-group"><legend>New INCOME allocation</legend><div class="income-inputs">${field('operatorSplitPercent','To operators',{suffix:'%'})}${field('stickySplitPercent','To FUND holders',{suffix:'%'})}</div></fieldset>
        <section class="income-preview-panel" aria-labelledby="income-preview-heading"><header><h3 id="income-preview-heading">Income preview</h3><p>Based on your inputs. Move the timeline to explore ownership.</p></header>
        <h4 class="income-chart-heading">New tokens per revenue payment</h4>
        <div id="create-income-split" class="create-split" aria-live="polite"></div>
        <p class="create-note">Customers receive the remaining new tokens. INCOME holders can cash out or borrow.</p>
        <div id="create-income-ownership"></div></section>
        ${field('revenueDescription','How will it earn revenue? (optional)',{rows:3,maxLength:1000,placeholder:'Describe what customers will pay for.'})}
        <details class="create-terms"><summary>Starting token terms</summary><p>At purchase, 500,000 initial INCOME is allocated across FUND holders. Revenue starts by issuing 10 INCOME per USDC, shared using the percentages above. Issuance falls 5% each quarter for two years.</p><p>FUND holders receive ongoing INCOME automatically. Borrowing or cashing out INCOME does not sell FUND.</p></details>
      </section>
      <section class="create-step" data-step-panel="3" aria-labelledby="step-title-3" hidden><h2 id="step-title-3" tabindex="-1">Review</h2>
        <div id="create-review"></div>
        <fieldset class="create-network-settings"><legend>Networks</legend>
          <div class="create-network-options"><div id="create-networkEnvironment" class="network-environments" role="group" aria-label="Deployment environment" tabindex="-1"><button type="button" data-environment="production">Production</button><button type="button" data-environment="testnet">Testnets</button></div>
          <div id="create-networks" class="network-symbols" role="group" aria-label="Selected networks" tabindex="-1" aria-describedby="networks-error">${NETWORK_FAMILIES.map(family=>`<button type="button" data-network="${family.id}" aria-label="${family.name}" title="${family.name}"><img src="${family.icon}" width="26" height="26" alt=""></button>`).join('')}</div></div>
          <p id="networks-error" class="create-error" hidden></p><p id="networkEnvironment-error" class="create-error" hidden></p>
        </fieldset>
        <section class="create-operator-settings" aria-label="Project operator">
          <div id="revnet-operator-address">${field('operatorWallet','Operator address',{placeholder:'0x…',maxLength:42,help:'One wallet or multisig for the FUND project and limited INCOME controls, across all selected networks. Leave blank to decide later.'})}</div>
          <input type="checkbox" id="create-revnetOperatorEnabled" name="revnetOperatorEnabled" checked hidden>
          <p id="revnetOperatorEnabled-error" class="create-error" hidden></p>
          <details class="create-terms operator-permissions"><summary>INCOME permissions</summary><p>Can update project and token details, manage buyback settings and approved payment terminals and bridges, and transfer the operator role.</p><p>Cannot change issuance, cash-out terms or the stage schedule, withdraw the revnet’s funds, or override locked allocations.</p></details>
        </section>
        <details class="create-terms"><summary>What deployment would set up</summary><ol><li><strong>FUND raise.</strong> A fundraising project and its contribution token.</li><li><strong>INCOME network.</strong> Revenue sharing prepared for successful asset purchase.</li><li><strong>FUND rewards.</strong> Ongoing INCOME allocated automatically to FUND holders.</li></ol></details>
        <p class="create-prototype-note">This prototype creates a local project preview and a downloadable setup draft. No wallet signature or transaction is submitted.</p>
        <button type="button" id="download-setup" class="quiet-button">Download setup draft</button>
      </section>
      <p id="create-form-error" class="create-error" role="alert" hidden></p>
      <div class="create-actions"><button type="button" id="create-back" class="quiet-button">← Back</button><button type="submit" id="create-next" class="create-primary">Continue <span aria-hidden="true">→</span></button></div>
    </form>
    <div class="draft-status"><span id="draft-status" role="status"></span><button type="button" id="start-over" class="quiet-button">Start over</button></div>
  </section>
  <aside class="create-aside" aria-label="Your project preview"><div class="draft-preview"><div class="asset-art"><canvas id="asset-sketch" aria-hidden="true"></canvas><img id="draft-photo" alt="Your asset cover photo" hidden></div><h2 id="draft-name">Untitled</h2><p id="draft-location"></p><dl><div><dt>Fundraising goal</dt><dd id="draft-goal">—</dd></div><div><dt>Monthly revenue estimate</dt><dd id="draft-revenue">—</dd></div></dl><div id="draft-ownership" class="draft-ownership"></div></div></aside>
</div><section id="create-success" class="create-success" aria-labelledby="success-title" hidden></section>`;

const form = document.querySelector('#create-form');
const incomePreview = initCreateIncomePreview(document.querySelector('#create-income-ownership'));
function syncInputs() {
  for (const input of form.querySelectorAll('[name]')) {
    if (input.type === 'checkbox') input.checked = Boolean(raw[input.name]);
    else input.value = typeof raw[input.name] === 'number' ? number(raw[input.name]) : String(raw[input.name] ?? '');
  }
}
syncInputs();
function save() {
  try { localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify({raw,step,incomeDefaultsVersion:3})); storageNotice = 'Draft saved in this browser'; }
  catch { storageNotice = 'Unable to save this draft. Keep this tab open while you work.'; }
  document.querySelector('#draft-status').textContent = storageNotice;
}
function showError(key, message) {
  const error = document.querySelector(`#${key}-error`), input = document.querySelector(`#create-${key}`);
  if (error) { error.textContent = message || ''; error.hidden = !message; }
  if (input) input.setAttribute('aria-invalid', String(Boolean(message)));
}
function checkStep(index, focus = true) {
  for (const key of groups[index]) {
    if (typeof raw[key] !== 'string' || raw[key].trim() !== '') continue;
    const fallback = key === 'name' ? 'Untitled' : CREATE_DEFAULTS[key];
    if (fallback === '') continue;
    raw[key] = fallback;
    const input = document.querySelector(`#create-${key}`);
    if (input) input.value = typeof fallback === 'number' ? number(fallback) : fallback;
  }
  const result = normalizeCreateDraft(raw);
  const invalid = groups[index].filter(key => result.errors[key]);
  for (const key of groups[index]) showError(key, result.errors[key]);
  if (invalid.length && focus) document.querySelector(`#create-${invalid[0]}`)?.focus();
  return invalid.length === 0;
}
function showStep(index, focus = true) {
  step = index; furthest = Math.max(furthest, step);
  for (const panel of form.querySelectorAll('[data-step-panel]')) panel.hidden = Number(panel.dataset.stepPanel) !== step;
  for (const button of document.querySelectorAll('[data-create-step]')) {
    const n = Number(button.dataset.createStep);
    button.disabled = n > furthest;
    if (n === step) button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current');
    button.dataset.complete = String(n < step);
  }
  document.querySelector('#create-back').hidden = step === 0;
  document.querySelector('#create-next').textContent = step === 3 ? 'Preview' : 'Continue →';
  document.querySelector('#create-form-error').hidden = true;
  render(); save();
  if (focus) document.querySelector(`#step-title-${step}`).focus();
}
function splitMarkup(values, customer) {
  const parts = [['Operators',values.operatorSplitPercent,'#38694b'],['FUND holders',values.stickySplitPercent,'#aebd8c'],['Customers',customer,'#bd8d62']];
  const active = parts.filter(([,value])=>value>0), zero = parts.filter(([,value])=>value===0);
  return `<div class="create-split-content${active.some(([,value])=>value<8)?' is-narrow':''}"><div class="create-split-bar" aria-hidden="true">${active.map(([,value,color])=>`<span style="flex:${value};background:${color}"></span>`).join('')}</div><ul style="grid-template-columns:${active.map(([,value])=>`${value}fr`).join(' ')}">${active.map(([label,value,color])=>`<li style="--share:${value}%;--split-color:${color}"><strong>${number(value)}%</strong><span>${label}</span></li>`).join('')}</ul>${zero.length?`<p class="zero-shares">${zero.map(([label])=>`0% ${label}`).join(' | ')}</p>`:''}</div>`;
}
function render() {
  for (const button of document.querySelectorAll('[data-environment]')) button.setAttribute('aria-pressed', String(raw.networkEnvironment === button.dataset.environment));
  for (const button of document.querySelectorAll('[data-network]')) {
    const family = NETWORK_FAMILIES.find(item=>item.id === button.dataset.network);
    const chain = family[raw.networkEnvironment] || family.production;
    button.setAttribute('aria-pressed', String(Array.isArray(raw.networks) && raw.networks.includes(family.id)));
    button.setAttribute('aria-label', chain.name); button.title = chain.name;
  }
  const normalized = normalizeCreateDraft(raw);
  const draftName = String(raw.name || '').trim() || 'Untitled';
  document.querySelector('#draft-name').textContent = draftName;
  document.querySelector('#draft-location').textContent = String(raw.location || '');
  const photo = normalized.errors.photo ? '' : normalized.values.photo;
  document.querySelector('#draft-photo').hidden = !photo;
  document.querySelector('#asset-sketch').hidden = Boolean(photo);
  if (photo) document.querySelector('#draft-photo').src = photo;
  document.querySelector('#remove-photo').hidden = !raw.photo;
  if (!photo) drawAssetSketch(document.querySelector('#asset-sketch'), raw.assetType);
  let summary;
  try { summary = creationSummary({...raw, name:draftName}); } catch { /* Incomplete form: suppress totals until corrected. */ }
  document.querySelector('#draft-goal').textContent = summary ? money(summary.raiseGoal) : '—';
  document.querySelector('#draft-revenue').textContent = summary ? money(summary.values.monthlyRent) : '—';
  document.querySelector('#create-raise-goal').textContent = summary ? money(summary.raiseGoal) : '—';
  document.querySelector('#create-fee-note').textContent = summary ? `Includes ${money(summary.values.purchaseBudget)} for the asset, ${money(summary.values.opsReserve)} in reserve, and ${money(Math.round((summary.raiseGoal-summary.values.purchaseBudget-summary.values.opsReserve)*100)/100)} in assumed payout fees.` : 'Complete the asset and funding inputs to calculate the goal.';
  const operatorShare = summary?.values.operatorFundPercent;
  const fundPie = document.querySelector('#create-fund-pie');
  fundPie.style.background = summary ? `conic-gradient(#42674d ${operatorShare}%, #b1bd91 0)` : '#dfe5d5';
  fundPie.setAttribute('aria-label', summary ? `Operators ${number(operatorShare)}%, other FUND holders ${number(summary.investorFundPercent)}%.` : 'Enter valid funding inputs to preview FUND ownership.');
  document.querySelector('#create-fund-share').textContent = summary ? `${number(operatorShare)}%` : '—';
  document.querySelector('#draft-ownership').innerHTML = summary ? `<div class="ownership-mini" aria-hidden="true"><span style="width:${summary.investorFundPercent}%"></span></div><p>${number(summary.investorFundPercent)}% contributor FUND <span aria-hidden="true">|</span> ${number(summary.values.operatorFundPercent)}% operator FUND</p>` : '';
  incomePreview.update(summary?.networkInputs || null);
  const splitValid = !normalized.errors.operatorSplitPercent && !normalized.errors.stickySplitPercent;
  document.querySelector('#create-income-split').innerHTML = splitValid ? splitMarkup(normalized.values,100-normalized.values.operatorSplitPercent-normalized.values.stickySplitPercent) : '<p class="create-error">Operator and FUND-holder allocations must total no more than 100%.</p>';
  document.querySelector('#create-review').innerHTML = summary ? `<section class="review-block"><div><h3>${escape(summary.values.name)}</h3><button type="button" data-edit-step="0">Edit asset</button></div><p>${escape(summary.values.location || 'Location not specified')}</p>${summary.values.description ? `<p>${escape(summary.values.description)}</p>` : ''}</section><section class="review-block"><div><h3>The raise</h3><button type="button" data-edit-step="1">Edit raise</button></div><dl><div><dt>Goal</dt><dd>${money(summary.raiseGoal)}</dd></div><div><dt>FUND ownership after purchase</dt><dd>${number(summary.investorFundPercent)}% contributors / ${number(summary.values.operatorFundPercent)}% operator</dd></div></dl></section><section class="review-block"><div><h3>Income plan</h3><button type="button" data-edit-step="2">Edit income</button></div>${summary.values.revenueDescription ? `<p class="revenue-description">${escape(summary.values.revenueDescription)}</p>` : ''}<dl><div><dt>Monthly revenue / expenses</dt><dd>${money(summary.values.monthlyRent)} / ${money(summary.values.monthlyCosts)}</dd></div><div><dt>Target revenue growth / year</dt><dd>${number(summary.values.rentGrowthPercent)}%</dd></div><div><dt>Target expense growth / year</dt><dd>${number(summary.values.costGrowthPercent)}%</dd></div></dl><div class="create-split">${splitMarkup(summary.values, summary.customerSplitPercent)}</div></section>` : '<p class="create-note">Correct the highlighted settings before creating your preview.</p>';
}
form.addEventListener('input', event => {
  const input = event.target;
  if (!input.name) return;
  raw[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  if (input.getAttribute('aria-invalid') === 'true') showError(input.name, normalizeCreateDraft(raw).errors[input.name]);
  render(); save();
});
document.querySelector('.create-network-settings').addEventListener('click', event => {
  const environment = event.target.closest('[data-environment]');
  const network = event.target.closest('[data-network]');
  if (environment) {
    raw.networkEnvironment = environment.dataset.environment;
    raw.networks = NETWORK_FAMILIES.map(family=>family.id);
  } else if (network) {
    const selected = Array.isArray(raw.networks) ? raw.networks : [];
    raw.networks = selected.includes(network.dataset.network) ? selected.filter(id=>id !== network.dataset.network) : [...selected, network.dataset.network];
  } else return;
  const errors = normalizeCreateDraft(raw).errors;
  showError('networks',errors.networks); showError('networkEnvironment',errors.networkEnvironment);
  render(); save();
});
form.addEventListener('focusout', event => {
  const input = event.target;
  if (input.name === 'revenueDescription' || (!groups[1].includes(input.name) && !groups[2].includes(input.name))) return;
  const result = normalizeCreateDraft(raw);
  if (!result.errors[input.name]) { input.value = number(result.values[input.name]); raw[input.name] = input.value; save(); }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!checkStep(step)) return;
  if (step < 3) { showStep(step+1); return; }
  for (let n=0;n<4;n++) if (!checkStep(n,false)) { showStep(n); checkStep(n); return; }
  try {
    created = saveCreatedProject(raw);
    document.querySelector('#create-workspace').hidden = true;
    const success = document.querySelector('#create-success');
    success.innerHTML = `<div class="success-mark" aria-hidden="true">✓</div><p class="create-eyebrow">Saved in this browser</p><h2 id="success-title" tabindex="-1">${escape(created.values.name)} is ready to preview.</h2><p>Your asset, funding goal, and income terms are set. Explore the project as if you had just launched the raise.</p><div class="success-actions"><a class="create-primary" id="open-created-project" href="/project/?id=${encodeURIComponent(created.id)}">Open project preview ↗</a><button type="button" id="download-deployment" class="quiet-button">Download deployment draft ↓</button></div><p class="create-note">This is a local prototype. Nothing has been deployed on-chain.</p><button type="button" id="create-another" class="quiet-button">Create another Homerun</button>`;
    success.hidden = false; document.querySelector('#success-title').focus();
    try { localStorage.removeItem(CREATE_DRAFT_KEY); } catch { /* Saved project remains available. */ }
    document.querySelector('#download-deployment').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(created.deployment,null,2)],{type:'application/json'}));
      const a = document.createElement('a'); a.href=url; a.download=`homerun-${created.id}-deployment-draft.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    document.querySelector('#create-another').addEventListener('click', reset);
  } catch (error) { const target=document.querySelector('#create-form-error');target.textContent=error.message;target.hidden=false; }
});
document.querySelector('#create-back').addEventListener('click', () => showStep(step-1));
document.querySelector('.create-steps').addEventListener('click', event => {
  const button=event.target.closest('[data-create-step]'); if (!button) return;
  const target=Number(button.dataset.createStep);
  if (target>step && !checkStep(step)) return;
  showStep(target);
});
document.querySelector('#create-review').addEventListener('click', event => {
  const button=event.target.closest('[data-edit-step]'); if(button) showStep(Number(button.dataset.editStep));
});
document.querySelector('#download-setup').addEventListener('click', () => {
  for (let n=0;n<4;n++) if (!checkStep(n,false)) { showStep(n); checkStep(n); return; }
  const url=URL.createObjectURL(new Blob([JSON.stringify(deploymentDraft(raw),null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='homerun-setup-draft.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function reset() {
  photoVersion++;
  raw={...CREATE_DEFAULTS};furthest=0;created=null;
  incomePreview.reset();
  syncInputs();
  document.querySelector('#create-photo').value='';
  for(const group of groups) for(const key of group) showError(key,'');
  document.querySelector('#create-success').hidden=true;document.querySelector('#create-workspace').hidden=false;
  showStep(0);
}
document.querySelector('#start-over').addEventListener('click',reset);
let photoVersion=0;
document.querySelector('#create-photo').addEventListener('change',async event=>{
  const file=event.target.files[0],version=++photoVersion;if(!file)return;
  try {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024) throw new Error('Choose a JPG, PNG or WebP image smaller than 8 MB.');
    const image=await createImageBitmap(file);
    const scale=Math.min(1,1200/image.width,900/image.height),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);image.close();
    const photo=canvas.toDataURL('image/jpeg',.82);
    if(photo.length>1_500_000)throw new Error('Try a smaller photo.');
    if(version!==photoVersion)return;
    raw.photo=photo;showError('photo','');render();save();
  }catch(error){if(version===photoVersion)showError('photo',error.message);}
});
document.querySelector('#remove-photo').addEventListener('click',()=>{photoVersion++;raw.photo='';document.querySelector('#create-photo').value='';showError('photo','');render();save();});
new ResizeObserver(()=>{if(!raw.photo)drawAssetSketch(document.querySelector('#asset-sketch'),raw.assetType);}).observe(document.querySelector('.asset-art'));
showStep(step,false);
