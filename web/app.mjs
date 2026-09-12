import { storyPage, bindStory } from './story.mjs';
import { DEFAULT_PROPERTY, quote, depositBacking, redeem, simulateProperty, liquidationRecovery } from './model.mjs';

const main = document.querySelector('#main');
const dialog = document.querySelector('#evidence-dialog');
const money = (value, digits = 0) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
const percent = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const years = months => months === null ? 'Beyond model horizon' : `${(months / 12).toFixed(1)} years`;
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const image = './assets/courtyard-property.png';
const state = { property: { ...DEFAULT_PROPERTY }, holding: 10000, redeemed: 0, tokenAmount: 10000, vacancy: 0, expenses: 0, priceDrop: .2, seniorClaims: 0, accepted: false };
const icons = {
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  home: '<path d="m3 11 9-8 9 8v10H3V11Z"/><path d="M9 21v-8h6v8"/>',
  chart: '<path d="M4 4v16h17M7 15l5-5 4 2 5-7"/>',
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  file: '<path d="M6 3h8l5 5v13H6V3Z M14 3v6h5M9 13h7M9 17h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.home}</svg>`;
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 4200); }
function showDialog(title, body) { document.querySelector('#dialog-content').innerHTML = `<span class="eyebrow">The Rooftop standard</span><h2 id="dialog-title">${title}</h2>${body}`; dialog.showModal(); }
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

function propertyPage() {
  return `<div class="container numbers-page">
    <div class="page-head"><span class="eyebrow">The numbers</span><h1>Test the example.</h1><p>Example assumptions for the $2 million raise. This model uses a $1.30 cap and no loans. <a href="#story">The investment story</a> explains the current Revnet design.</p></div>
    <section class="section" id="property-detail">
      <div class="property-panel"><div class="property-panel-header"><div class="property-id"><img src="${image}" alt="" loading="lazy"><div><div class="property-heading"><h3>Founder Haus</h3></div><p class="property-location">Refinance: $2,000,000 raise</p></div></div><span class="pill">Illustration: Month <span id="elapsed-month">29</span></span></div>
      <div class="metric-grid"><div class="metric"><div class="metric-label">Investment needed</div><div class="metric-value">${money(DEFAULT_PROPERTY.tokens * DEFAULT_PROPERTY.issuePrice)}</div><div class="metric-sub">${number(DEFAULT_PROPERTY.tokens)} model tokens at $1</div></div><div class="metric"><div class="metric-label">Protected cash backing</div><div class="metric-value" id="backing-value"></div><div class="metric-sub" id="outstanding-units">Separate from operating reserves</div></div><div class="metric"><div class="metric-label">Cash-out value / token today</div><div class="metric-value positive" id="floor-value"></div><div class="metric-sub">Based only on available cash</div></div><div class="metric"><div class="metric-label">Target cash-out / token</div><div class="metric-value">$1.30</div><div class="metric-sub">30% total return, if fully funded</div></div></div>
      <div class="progress-area"><div class="progress-label"><span id="backing-progress-label"></span><strong id="backing-gap"></strong></div><div class="progress-track" role="progressbar" aria-label="Remaining token target backed by cash" aria-valuemin="0" aria-valuemax="100" id="backing-progress"><span></span></div></div><div class="panel-note">${icon('lock')} Property value is not cash available to redeem.</div></div>
      <div class="dashboard-grid"><div class="card"><div class="card-title"><h3>Time to the target</h3><span class="pill muted">Projection</span></div><p class="caption">Adjust vacancy and costs to test the projection.</p><div id="forecast-chart"></div><div class="chart-legend"><span><i></i> Base assumptions</span><span><i class="stress"></i> Your downside case</span></div><div class="forecast-summary"><div><strong id="forecast-time"></strong><span>Additional time to target: downside</span></div><div><strong id="forecast-return"></strong><span>Annualized return: held from closing</span></div></div><div class="stress-controls"><label><span class="range-label">Rent lost to vacancy <output id="vacancy-output">0%</output></span><input id="vacancy" type="range" min="0" max="60" step="5" value="${state.vacancy * 100}" aria-label="Rent lost to vacancy"></label><label><span class="range-label">Increase in property costs <output id="expense-output">0%</output></span><input id="expenses" type="range" min="0" max="50" step="5" value="${state.expenses * 100}" aria-label="Increase in property costs"></label></div><p class="caption" style="margin:12px 0 0">Assumes steady monthly cash. Timing and returns are uncertain.</p></div>
      <div class="card"><div class="card-title"><h3>Where monthly rent goes</h3><span class="pill muted">Downside case</span></div><p class="caption">Essential costs first. Available income builds backing.</p><div id="waterfall"></div><div class="reserve-box"><div><strong>Operating reserve stays separate</strong><p id="reserve-caption"></p></div>${icon('shield')}</div></div></div>
    </section>

    <section class="cashout-section" id="cashout-lab"><div class="cashout-copy"><span class="eyebrow">Try a cash-out</span><h2>See what you could receive.</h2><p>Choose a token amount. Cashing out pays today’s value and ends those tokens’ future claims.</p></div>
      <div class="cashout-card"><span class="eyebrow">An interactive cash-out quote</span><label class="field-label" for="token-amount">Tokens to redeem: Example holding: <span id="holding-count"></span></label><div class="token-input-wrap"><input id="token-amount" type="number" min="1" step="1" value="${state.tokenAmount}" inputmode="numeric"><span class="token-symbol">COURT</span></div><div class="quote-label">Available for these tokens today</div><div class="quote-big" id="cashout-value"></div><div class="quote-breakdown"><div>Original cost<strong id="quote-principal"></strong></div><div>Target if fully funded<strong id="quote-target"></strong></div><div>Token cash-out price<strong id="quote-price"></strong></div></div><div class="warning" id="cashout-warning"></div><label class="check-line"><input id="accept-exit" type="checkbox"><span>I understand that redeeming retires these tokens and ends their future cash and property claims.</span></label><button class="button" id="redeem-button" disabled>Simulate cash-out <span aria-hidden="true">↗</span></button><div class="cashout-actions"><button class="link-button" id="simulate-income">Add $25,000 of backing</button><button class="link-button" id="reset-example">Reset example</button></div><p class="lab-status" id="lab-status">Simulation only. No wallet or real funds.</p><p class="caption" style="font-size:9px;margin:8px 0 0">Simulation excludes protocol fees, conversion costs, and gas.</p></div></section>

    <section class="section recovery-section"><div class="section-top"><div><span class="eyebrow">If the property is sold</span><h2>Test a lower sale price.</h2></div></div><div class="liquidation-grid"><div><p class="caption">Scenario only: $950,000 sale value, 8% sale costs, and a $1.30 cap. This is not a Founder Haus valuation.</p><label style="margin-top:20px"><span class="range-label">Fall in sale value <output id="sale-drop-output">20%</output></span><input type="range" id="sale-drop" min="0" max="80" step="5" value="${state.priceDrop * 100}"></label><label style="margin-top:18px"><span class="field-label">Other senior claims ($)</span><input type="number" id="senior-claims" min="0" max="1000000000000" step="0.01" value="${state.seniorClaims}"></label><p class="caption" style="margin-top:14px">The original debt is assumed paid at closing.</p></div><div class="card" id="recovery-report"></div></div></section>
    <div class="numbers-evidence"><button class="link-button" data-evidence="rights">Property rights</button><button class="link-button" data-evidence="cash">Contract rules</button><button class="link-button" data-evidence="operations">Operating reports</button></div>
  </div>`;
}

function chartSVG(base, stress) {
  const width = 570, height = 207, left = 38, right = 12, top = 19, bottom = 30;
  const maxMonth = state.property.horizonMonths;
  const maxY = state.property.targetPerToken * 1.15;
  const x = m => left + (width - left - right) * m / maxMonth;
  const y = v => height - bottom - (height - top - bottom) * v / maxY;
  const path = rows => rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.month).toFixed(2)},${y(r.cashoutPerToken).toFixed(2)}`).join(' ');
  const points = [0, .5, 1];
  const targetY = y(state.property.targetPerToken);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected cash-out value from ${money(quote(state.property).currentPerToken, 4)} today toward the ${money(state.property.targetPerToken, 2)} target over ${maxMonth} months; ${stress.targetFundedMonth === null ? 'downside target not reached' : `downside target reached in ${stress.targetFundedMonth} additional months`}"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a9c18c" stop-opacity=".28"/><stop offset="100%" stop-color="#a9c18c" stop-opacity="0"/></linearGradient></defs>${points.map(v => `<line class="axis-line" x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v)+3}">$${v.toFixed(2)}</text>`).join('')}<line class="target-line" x1="${left}" x2="${width-right}" y1="${targetY}" y2="${targetY}"/><text x="${width-right}" y="${targetY-8}" text-anchor="end">$1.30 target</text><path d="${path(base.months)} L${x(maxMonth)},${y(0)} L${left},${y(0)} Z" fill="url(#chart-fill)"/><path class="forecast-line" d="${path(base.months)}"/><path class="stress-line" d="${path(stress.months)}"/>${[0,24,48,72,96,120].filter(m=>m<=maxMonth).map(m=>`<text x="${x(m)}" y="${height-7}" text-anchor="middle">${m ? `+${m} mo` : 'Today'}</text>`).join('')}<circle cx="${left}" cy="${y(base.months[0].cashoutPerToken)}" r="4" fill="#426947" stroke="#fffefa" stroke-width="2"/></svg>`;
}

function updateDashboard() {
  if (!document.querySelector('#backing-value')) return;
  const q = quote(state.property);
  const base = simulateProperty(state.property);
  const stress = simulateProperty(state.property, { vacancyRate: state.vacancy, expenseIncrease: state.expenses });
  const next = stress.months[1] || stress.months[0];
  document.querySelector('#backing-value').textContent = money(state.property.backing);
  document.querySelector('#floor-value').textContent = money(q.currentPerToken, 4);
  document.querySelector('#outstanding-units').textContent = `${number(state.property.tokens)} tokens outstanding`;
  document.querySelector('#elapsed-month').textContent = state.property.elapsedMonths;
  document.querySelector('#backing-progress-label').textContent = `${percent(q.targetCoverage)} of remaining token target backed by cash`;
  document.querySelector('#backing-gap').textContent = `${money(q.fundingGap)} to fully fund`;
  const bar = document.querySelector('#backing-progress'); bar.setAttribute('aria-valuenow', (q.targetCoverage*100).toFixed(2)); bar.querySelector('span').style.width = `${Math.min(q.targetCoverage*100,100)}%`;
  document.querySelector('#forecast-chart').innerHTML = chartSVG(base, stress);
  document.querySelector('#forecast-time').textContent = stress.targetFundedMonth === 0 ? 'Target funded' : years(stress.targetFundedMonth);
  document.querySelector('#forecast-return').textContent = stress.singleExitAnnualReturn === null ? 'Target not reached' : percent(stress.singleExitAnnualReturn, 2);
  document.querySelector('#vacancy-output').textContent = percent(state.vacancy,0);
  document.querySelector('#expense-output').textContent = percent(state.expenses,0);
  document.querySelector('#waterfall').innerHTML = `<div class="waterfall-row"><span>Gross rent collected</span><b>${money(next.grossRent)}</b></div><div class="waterfall-row"><span><i class="number-badge">1</i> Operating costs</span><b>−${money(next.operatingCosts)}</b></div><div class="waterfall-row"><span><i class="number-badge">2</i> Recurring capital costs</span><b>−${money(next.capitalCosts)}</b></div><div class="waterfall-row"><span><i class="number-badge">3</i> Restore operating reserve</span><b>${next.reserveTopUp ? '−' : ''}${money(next.reserveTopUp)}</b></div><div class="waterfall-row"><span>Owner’s permitted residual</span><b>${money(next.sponsorResidual)}</b></div><div class="waterfall-row total"><span>Added to token backing</span><b>${money(next.investorDeposit)}</b></div>${next.operatingShortfall>0?`<p class="warning">${money(next.operatingShortfall)} in operating costs remains unfunded after reserve use.</p>`:''}`;
  document.querySelector('#reserve-caption').textContent = `${money(next.reserveBalance)} projected balance / ${money(state.property.reserveTarget)} target. ${next.reserveDraw>0?`${money(next.reserveDraw)} used to cover a shortfall.`:'It cannot fund investor redemptions.'}`;
  updateQuote();
}

function updateQuote() {
  const amount = Number(document.querySelector('#token-amount').value);
  document.querySelector('#holding-count').textContent = number(state.holding);
  document.querySelector('#token-amount').max = state.holding;
  if(state.holding===0){
    document.querySelector('#cashout-value').textContent=money(0,2);
    document.querySelector('#quote-principal').textContent=money(0);
    document.querySelector('#quote-target').textContent=money(0);
    document.querySelector('#quote-price').textContent=money(quote(state.property).currentPerToken,4);
    document.querySelector('#cashout-warning').textContent='All your example tokens have been retired. They have no future claim. Reset the example to explore another outcome.';
    document.querySelector('#redeem-button').disabled=true;
    return;
  }
  let q;
  try { if (amount > state.holding || amount <= 0) throw new Error('Choose between 1 and your remaining whole-token balance.'); q = quote(state.property, amount); }
  catch(error) { document.querySelector('#cashout-value').textContent='—'; for(const id of ['quote-principal','quote-target','quote-price'])document.querySelector(`#${id}`).textContent='—'; document.querySelector('#cashout-warning').textContent=error.message; document.querySelector('#redeem-button').disabled=true; return; }
  state.tokenAmount=amount;
  document.querySelector('#cashout-value').textContent = money(q.cashOutValue,2);
  document.querySelector('#quote-principal').textContent = money(q.principalValue);
  document.querySelector('#quote-target').textContent = money(q.targetValue);
  document.querySelector('#quote-price').textContent = money(q.currentPerToken,4);
  document.querySelector('#cashout-warning').textContent = q.principalHaircutAmount>0 ? `An exit today realizes a ${money(q.principalHaircutAmount,2)} loss against the original cost of these tokens. Their remaining ${money(q.targetHaircutAmount,2)} to target is permanently given up.` : q.targetHaircutAmount>0 ? `This exit recovers the original token cost, but gives up ${money(q.targetHaircutAmount,2)} of potential future value to the target.` : 'These tokens are fully backed at their agreed target. Redemption exchanges them for the reserved cash.';
  document.querySelector('#redeem-button').disabled=!state.accepted||q.cashOutValue<=0;
}

function bindProperty() {
  for(const [id,key] of [['vacancy','vacancy'],['expenses','expenses']]) document.querySelector(`#${id}`).addEventListener('input',e=>{state[key]=Number(e.target.value)/100;updateDashboard();});
  document.querySelector('#token-amount').addEventListener('input',()=>{state.accepted=false;document.querySelector('#accept-exit').checked=false;updateQuote();});
  document.querySelector('#accept-exit').addEventListener('change',e=>{state.accepted=e.target.checked;updateQuote();});
  document.querySelector('#redeem-button').addEventListener('click',()=>{
    if(!state.accepted)return;
    try { const result=redeem(state.property,state.tokenAmount);state.property=result.state;state.holding-=result.burnedTokens;state.redeemed+=result.payout;state.accepted=false;document.querySelector('#accept-exit').checked=false;document.querySelector('#token-amount').value=Math.min(state.tokenAmount,state.holding);updateDashboard();document.querySelector('#lab-status').textContent=`${money(state.redeemed,2)} received in this simulation. ${number(state.holding)} example tokens remain. Redeemed tokens have no future claim.`;toast(`Simulated: ${number(result.burnedTokens)} tokens retired for ${money(result.payout,2)}.`); }
    catch(error){toast(error.message);}
  });
  document.querySelector('#simulate-income').addEventListener('click',()=>{const result=depositBacking(state.property,25000);state.property=result.state;state.accepted=false;document.querySelector('#accept-exit').checked=false;updateDashboard();toast(`${money(result.investorDeposit)} added to protected backing${result.sponsorResidual?`; ${money(result.sponsorResidual)} exceeds the target`:''}.`);});
  document.querySelector('#reset-example').addEventListener('click',()=>{Object.assign(state,{property:{...DEFAULT_PROPERTY},holding:10000,redeemed:0,tokenAmount:10000,vacancy:0,expenses:0,accepted:false});const y=window.scrollY;main.innerHTML=propertyPage();bindNumbers();window.scrollTo(0,y);toast('Example reset. No real funds were used.');});
  document.querySelectorAll('[data-evidence]').forEach(button=>button.addEventListener('click',()=>evidenceDialog(button.dataset.evidence)));
  updateDashboard();
}

function evidenceDialog(type) {
  const content = {
    rights: ['The property & your rights', '<p>A live property needs legally effective security or ownership rights held for its investors. The documents must name who can enforce them, what takes priority, and how a cash-out ends those token claims and how the funded release floor changes property rights. Revnet tokens and holder loans continue after property release.</p><div class="evidence-list"><div><span>Title / property entity register</span><b>Not supplied</b></div><div><span>Liens and priority review</span><b>Not supplied</b></div><div><span>Investor and security agreements</span><b>Not supplied</b></div><div><span>Independent valuation: date and method</span><b>Not supplied</b></div></div><p>This fictional example has no verified property rights. A token alone cannot transfer title or force a property sale.</p>'],
    cash: ['The cash & the rules', '<p>The proposed launcher coordinates a Juicebox fundraising escrow and a stock Revnet. Receipts convert at a fixed rate into the full supply already held by an immutable distributor. Net rent adds backing; holders may cash out or borrow against their own tokens. Operating reserves stay separate. The local reference contract and numerical lab still illustrate the earlier capped model without loans.</p><div class="evidence-list"><div><span>Interactive economics</span><b>Illustrative simulation</b></div><div><span>Reference contract</span><b>Local prototype</b></div><div><span>Rooftop launcher integration</span><b>Proposed: not deployed</b></div><div><span>Deployed backing address</span><b>Not deployed</b></div><div><span>Independent security review</span><b>Not completed</b></div></div><p>Before launch, publish the project pair, immutable allocation, settlement asset, permissions, fee and refund policy, loan terms, release conditions, reconciliation method, and security review. Cash received and outstanding loan principal must be shown separately. Contracts cannot prove rent was never diverted.</p>'],
    operations: ['The operator & the updates', '<p>Confidence needs a reporting habit: collected rents reconciled to the bank, operating expenses against budget, reserve balances, and funds actually added to backing.</p><div class="evidence-list"><div><span>Named operator and servicer</span><b>Not appointed</b></div><div><span>Rent roll and collections</span><b>Illustrative only</b></div><div><span>Expense / reserve reports</span><b>Illustrative only</b></div><div><span>Insurance, taxes, covenant report</span><b>Not supplied</b></div></div><p>Every real report should identify its period, preparer, reviewer, evidence location, and next due date. Missing or stale reports stay visible and can trigger the agreed cure process.</p>'],
  };
  showDialog(...content[type]);
}

function updateRecovery(){
  const senior=Number(document.querySelector('#senior-claims').value);
  if(document.querySelector('#senior-claims').value.trim()===''||!Number.isFinite(senior)||senior<0||senior>1e12||Math.abs(senior*100-Math.round(senior*100))>1e-6){document.querySelector('#recovery-report').innerHTML='<p class="error-text">Enter a nonnegative amount up to $1 trillion with at most two decimal places.</p>';return;}
  state.seniorClaims=senior;
  let result;
  try { result=liquidationRecovery({...DEFAULT_PROPERTY,propertyValue:Math.round(DEFAULT_PROPERTY.propertyValue*(1-state.priceDrop)*100)/100,seniorClaims:senior}); }
  catch(error) { document.querySelector('#recovery-report').innerHTML=`<p class="error-text">Check the recovery inputs: ${escape(error.message)}</p>`; return; }
  document.querySelector('#sale-drop-output').textContent=percent(state.priceDrop,0);
  document.querySelector('#recovery-report').innerHTML=`<span class="eyebrow">Capped reference sale: no loans</span><h3>Cash recovered per token</h3><div class="recovery-number">${money(result.recoveryPerToken,4)}</div><p class="caption">Includes ${money(DEFAULT_PROPERTY.backing)} already in protected backing.</p><div class="waterfall-row"><span>Realized sale price assumption</span><b>${money(result.grossSaleProceeds)}</b></div><div class="waterfall-row"><span>Sale / enforcement costs</span><b>−${money(result.saleCosts)}</b></div><div class="waterfall-row"><span>Senior claims paid from sale</span><b>−${money(result.seniorClaimsPaid)}</b></div><div class="waterfall-row total"><span>Available to token holders, capped</span><b>${money(result.totalInvestorRecovery)}</b></div><p class="warning">${result.principalShortfall>0?`${money(result.principalShortfall)} short of original investor principal. Sale does not make investors whole in this case.`:result.targetShortfall>0?`Original principal is covered in this scenario, but ${money(result.targetShortfall)} of the target remains unfunded.`:'The modeled cash covers the normal payoff target. This is a scenario, not a guaranteed recovery or verified valuation.'}</p>`;
}

const initialDraft={name:'Founder Haus',mode:'refinance',jurisdiction:'Not yet specified',useOfFunds:1850000,costs:100000,reserves:50000,equity:0,propertyValue:950000,rent:14000,opex:5000,capex:1000,sweep:80,target:1.3,term:120};
let draft={...initialDraft};
const field=(key,label,options={})=>`<label class="${options.full?'full':''}" for="draft-${key}">${label}<input id="draft-${key}" name="${key}" type="${options.text?'text':'number'}" ${options.text?'maxlength="100"':`min="${options.min??0}" step="${options.step??1}" ${options.max!==undefined?`max="${options.max}"`:''}`} value="${escape(draft[key])}" required></label>`;
function underwritePage(){return `<div class="container reveal"><div class="page-head"><span class="eyebrow">Model a property</span><h1>Start with the numbers.</h1><p>Start with Founder Haus’s $2 million raise. Edit the example costs and rent; this draft uses the capped model without loans.</p></div><div class="underwrite-grid"><form id="underwrite-form"><div class="form-section"><h3>01: The property</h3><div class="form-grid">${field('name','Property name',{text:true,full:true})}<label for="draft-mode">Financing purpose<select id="draft-mode" name="mode"><option value="refinance" ${draft.mode==='refinance'?'selected':''}>Refinance existing debt</option><option value="acquire" ${draft.mode==='acquire'?'selected':''}>Acquire a property</option></select></label>${field('jurisdiction','Property jurisdiction',{text:true})}</div></div><div class="form-section"><h3>02: Capital required: USD</h3><div class="form-grid">${field('useOfFunds',draft.mode==='refinance'?'Creditor closing payoff ($)':'Property purchase price ($)')}${field('costs','Closing, servicing & fee provision ($)')}${field('reserves','Initial operating reserve ($)')}${field('equity','Sponsor cash contribution ($)')}${field('propertyValue','Conservative sale value ($)',{full:true})}</div></div><div class="form-section"><h3>03: Monthly operations & investor terms</h3><div class="form-grid">${field('rent','Gross monthly rent ($)')}${field('opex','Monthly operating expenses ($)')}${field('capex','Recurring monthly capital costs ($)')}${field('sweep','Available cash to backing (%)',{max:100,min:1})}${field('target','Target per $1 token ($)',{min:1,step:.01,max:5})}${field('term','Maximum term (months)',{min:1,max:600})}</div><p class="form-help">Sale stress: 30% lower value, 8% costs, no remaining senior debt.</p></div><div class="form-actions"><button type="submit" class="button">Download draft model ↗</button><button type="button" class="button outline" id="reset-draft">Reset inputs</button></div><p id="draft-error" class="error-text" role="status"></p></form><aside class="draft-report" id="draft-report" aria-live="polite"></aside></div></div>`;}

let draftResult=null;
function updateDraft(){
  const form=document.querySelector('#underwrite-form');
  const data=Object.fromEntries(new FormData(form));
  draft=Object.fromEntries(Object.entries(data).map(([key,value])=>[key,['name','mode','jurisdiction'].includes(key)?value:Number(value)]));
  const report=document.querySelector('#draft-report');
  if(!form.checkValidity()){report.innerHTML='<h2>Complete the inputs.</h2><p>Use nonnegative amounts, a cash sweep from 1–100%, and a target from $1–$5. All inputs are required.</p>';draftResult=null;return;}
  const uses=draft.useOfFunds+draft.costs+draft.reserves;
  const raise=uses-draft.equity;
  if(raise<=0||!Number.isSafeInteger(raise)){report.innerHTML='<h2>Check the capital plan.</h2><p>The investor raise must be a positive whole-dollar amount after the sponsor contribution.</p>';draftResult=null;return;}
  try{
    const config={...DEFAULT_PROPERTY,tokens:raise,backing:0,issuePrice:1,targetPerToken:draft.target,reserveBalance:draft.reserves,reserveTarget:draft.reserves,monthlyGrossRent:draft.rent,monthlyOperatingCosts:draft.opex,monthlyCapitalCosts:draft.capex,investorSweep:draft.sweep/100,elapsedMonths:0,horizonMonths:draft.term,propertyValue:draft.propertyValue};
    const base=simulateProperty(config);
    const downside=simulateProperty(config,{vacancyRate:.2,expenseIncrease:.15});
    const recovery=liquidationRecovery({...config,propertyValue:Math.round(draft.propertyValue*.7*100)/100});
    const funded=base.targetFundedMonth!==null;
    draftResult={product:'Rooftop',kind:'Illustrative property underwriting draft',createdAt:new Date().toISOString(),inputs:draft,assumptions:{issuePrice:1,initialRedemptionBacking:0,saleCostRate:.08,salePriceStress:.3,remainingSeniorClaims:0,downsideVacancy:.2,downsideCostIncrease:.15,liveOffering:false},results:{capitalUses:uses,investorRaise:raise,targetBacking:raise*draft.target,baseTargetMonths:base.targetFundedMonth,baseSingleExitAnnualReturn:base.singleExitAnnualReturn,downsideTargetMonths:downside.targetFundedMonth,downsideEndBacking:downside.finalState.backing,recoveryPerToken:recovery.recoveryPerToken,principalShortfall:recovery.principalShortfall},requiredEvidence:['Title and property entity','Lien and priority review','Signed investor/security documents','Rent roll and collections','Operating budget and reserve policy','Servicer and enforcement authority','Contract deployment and independent review']};
    report.innerHTML=`<span class="eyebrow">Your first pass</span><h2>${escape(draft.name)}</h2><p>${draft.mode==='refinance'?'Refinance':'Acquisition'}: USD model: ${escape(draft.jurisdiction)}</p><div class="report-row"><span>Total closing uses</span><b>${money(uses)}</b></div><div class="report-row"><span>Sponsor contribution</span><b>${money(draft.equity)}</b></div><div class="report-row"><span>Investor capital required</span><b>${money(raise)}</b></div><div class="report-row"><span>Full token backing target</span><b>${money(raise*draft.target)}</b></div><div class="report-row"><span>Cash backing at closing</span><b>$0: proceeds deployed</b></div><div class="report-row"><span>Base target / annualized return</span><b>${funded?`${years(base.targetFundedMonth)} / ${percent(base.singleExitAnnualReturn,2)}`:'Not reached within term'}</b></div><div class="report-row"><span>20% vacancy + 15% higher costs</span><b>${downside.targetFundedMonth===null?'Not funded within term':years(downside.targetFundedMonth)}</b></div><div class="report-row"><span>Stressed sale recovery / token</span><b>${money(recovery.recoveryPerToken,4)}</b></div><div class="report-status ${!funded||recovery.principalShortfall>0?'warn':''}"><strong>${!funded?'The base plan needs work.':recovery.principalShortfall>0?'The sale case has a principal shortfall.':'A starting point for underwriting.'}</strong><p>${!funded?`${money(Math.max(0,raise*draft.target-base.finalState.backing))} of target remains at month ${draft.term}. Longer terms, different pricing, more sponsor equity, or a documented sale/refinance plan are needed.`:recovery.principalShortfall>0?`${money(recovery.principalShortfall)} of investor principal is uncovered in the modeled sale at closing.`:'Arithmetic alone does not establish investment suitability. Verify the cash flow, legal rights, costs, and recovery assumptions.'}</p></div><p style="font-size:10px">Illustrative draft. Property evidence is unverified.</p>`;
  }catch(error){report.innerHTML=`<h2>Check the inputs.</h2><p>${escape(error.message)}</p>`;draftResult=null;}
}
function bindDraft(){
  document.querySelector('#underwrite-form').addEventListener('input',updateDraft);
  document.querySelector('#draft-mode').addEventListener('change',()=>{draft.mode=document.querySelector('#draft-mode').value;const label=document.querySelector('label[for="draft-useOfFunds"]');label.firstChild.textContent=draft.mode==='refinance'?'Creditor closing payoff ($)':'Property purchase price ($)';updateDraft();});
  document.querySelector('#reset-draft').addEventListener('click',()=>{draft={...initialDraft};main.innerHTML=underwritePage();bindDraft();toast('Property inputs reset.');});
  document.querySelector('#underwrite-form').addEventListener('submit',event=>{event.preventDefault();updateDraft();if(!draftResult){document.querySelector('#draft-error').textContent='Resolve the inputs before downloading a model.';return;}const url=URL.createObjectURL(new Blob([JSON.stringify(draftResult,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`rooftop-${draft.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'property'}-draft.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Downloaded your draft, including assumptions and required evidence.');});
  updateDraft();
}

function bindNumbers() {
  bindProperty();
  document.querySelector('#sale-drop').addEventListener('input', event => {
    state.priceDrop = Number(event.target.value) / 100;
    updateRecovery();
  });
  document.querySelector('#senior-claims').addEventListener('input', updateRecovery);
  updateRecovery();
}

function render() {
  const hash = location.hash.slice(1) || 'story';
  const isNumbers = ['numbers', 'property-detail', 'cashout-lab'].includes(hash);
  const page = isNumbers ? 'numbers' : hash === 'underwrite' ? 'underwrite' : 'story';
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === page);
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (page === 'numbers') {
    main.innerHTML = propertyPage();
    state.accepted = false;
    bindNumbers();
  } else if (page === 'underwrite') {
    main.innerHTML = underwritePage();
    bindDraft();
  } else {
    main.innerHTML = storyPage();
    bindStory();
  }
  document.title = `Rooftop — ${page === 'numbers' ? 'The numbers' : page === 'underwrite' ? 'Model a property' : 'Life of an investment'}`;
  if (['property-detail', 'cashout-lab'].includes(hash)) requestAnimationFrame(() => document.querySelector(`#${hash}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  else window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
render();
