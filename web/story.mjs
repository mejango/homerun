const propertyImage = './assets/courtyard-property.png';
const arrow = '<span aria-hidden="true">→</span>';
const home = '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M10 29 32 10l22 19v27H10V29Z M26 56V35h12v21 M19 29h8 M38 29h8"/></svg>';

const stages = [
  {
    label: 'Invest',
    title: 'Invest in a property.',
    body: 'Your money joins this property’s raise and stays in escrow until closing funds are committed. You receive a subscription receipt.',
    visual: `<div class="story-transfer"><div><span>You invest</span><strong>$10,000</strong></div>${arrow}<div><span>You receive</span><strong>10,000</strong><small>subscription receipts</small></div></div><div class="story-receipt"><span class="receipt-mark">W</span><div><strong>Founder Haus</strong><span>Part of a $2,000,000 property raise</span></div><span class="receipt-status">In escrow</span></div>`,
    caption: 'Illustrative terms: $1 per receipt',
  },
  {
    label: 'Close',
    title: 'The deal closes.',
    body: 'The raise pays the existing lender, closing costs, and operating reserves. Once settlement is confirmed, exchange your receipts for the property’s tokens.',
    visual: `<div class="story-ledger"><div><span>Property financing</span><strong>$2,000,000</strong></div><div><span>Debt & closing costs</span><strong>Paid at closing</strong></div><div><span>Operating reserve</span><strong>Funded separately</strong></div></div><div class="story-result"><span>Your 10,000 receipts become</span><strong>10,000 tokens</strong></div>`,
    caption: 'Cash backing starts at $0. The investment financed the property.',
  },
  {
    label: 'Collect rent',
    title: 'Rent builds your backing.',
    body: 'Rent covers property costs and reserves first. The agreed remainder adds cash behind your existing tokens.',
    visual: `<div class="rent-total"><span>Example monthly rent</span><strong>$14,000</strong></div><div class="rent-bar" role="img" aria-label="$14,000 of monthly rent: $6,000 for property costs and reserves, $1,600 for the owner, and $6,400 for token backing."><i></i><i></i><i></i></div><div class="rent-key"><div><span><i class="cost-dot"></i>Costs & reserves</span><strong>$6,000</strong></div><div><span><i class="owner-dot"></i>Owner’s share</span><strong>$1,600</strong></div><div class="rent-backing"><span><i class="backing-dot"></i>Added to backing</span><strong>$6,400</strong></div></div>`,
    caption: 'Rent adds cash behind your tokens. It is not a monthly dividend.',
  },
  {
    label: 'Use tokens',
    title: 'Choose how to use your tokens.',
    body: 'You can keep holding, cash out at the current backed value, or borrow against your own tokens. Taking an early exit can mean a loss.',
    visual: `<div class="exit-quote"><span>Suppose backing reaches $0.40 per token</span><strong>$4,000</strong><span>Cash-out value of your 10,000 tokens: before fees</span></div><div class="story-choices" role="group" aria-label="Compare ways to use your tokens"><button type="button" data-choice="cashout" aria-pressed="true">Cash out ${arrow}</button><button type="button" data-choice="borrow" aria-pressed="false">Borrow ${arrow}</button></div><p id="choice-note" class="choice-note" aria-live="polite">Receive $4,000 before fees. Your 10,000 tokens are retired, ending their future claims.</p>`,
    caption: 'Original investment: $10,000. Current value is not a promised return.',
  },
  {
    label: 'Release',
    title: 'The property is released.',
    body: 'When backing reaches the agreed floor and legal conditions are met, the property’s income and security obligations can end. The token pool and existing loans continue.',
    visual: `<div class="release-value"><span>Example release floor</span><strong>$1.30 <small>/ token</small></strong></div><div class="release-line"><i></i><span aria-hidden="true">✓</span></div><div class="release-amount"><strong>$13,000</strong><span>Gross backing if you still hold all 10,000 tokens</span></div>`,
    caption: 'Reaching this floor is not guaranteed. It does not cap later token value.',
  },
  {
    label: 'Invest again',
    title: 'Choose your next property.',
    body: 'Repeat the process with another property if you choose. Every investment has its own raise, tokens, and backing. Nothing rolls over automatically.',
    visual: `<div class="next-properties"><div><img src="${propertyImage}" alt="Founder Haus illustration"><span>Your first property</span><strong>Founder Haus</strong></div><div class="next-property">${home}<span>A separate investment</span><strong>The next property</strong></div></div><a href="#underwrite" class="button story-model">Model a property ${arrow}</a>`,
    caption: 'Each property stands on its own.',
  },
];

export function storyPage() {
  return `<div class="container story-page">
    <section class="story-intro">
      <div><span class="eyebrow">Property investing with Rooftop</span><h1>Finance a property.<br>Get paid from its rent.</h1><p>Your investment closes the deal.<br>Rent builds the cash backing your tokens.</p></div>
      <figure class="story-property"><img src="${propertyImage}" alt="Illustration of Founder Haus, an apartment building around a garden" fetchpriority="high"><figcaption><div><strong>Founder Haus</strong><span>Refinance: $2,000,000 raise</span></div><span class="example-tag">Illustration</span></figcaption></figure>
    </section>

    <section class="investment-story" aria-labelledby="life-title">
      <div class="story-section-heading"><div><span class="eyebrow">Life of an investment</span><h2 id="life-title">Follow a $10,000 investment.</h2></div><span class="story-example">One property. Six steps.</span></div>
      <div class="story-layout">
        <ol class="story-stages" aria-label="Investment stages">${stages.map((stage, i) => `<li><button type="button" data-stage="${i}" aria-controls="story-panel" ${i === 0 ? 'aria-current="step"' : ''}><span class="stage-number">0${i + 1}</span><span>${stage.label}</span><span class="stage-arrow" aria-hidden="true">→</span></button></li>`).join('')}</ol>
        <div class="story-content">
          <div id="story-panel" role="region" aria-labelledby="story-title" aria-live="polite"></div>
          <div class="story-controls"><button type="button" id="previous-stage" class="story-back" disabled>← <span>Previous</span></button><span id="stage-count">1 of 6</span><button type="button" id="next-stage" class="button">Next step ${arrow}</button></div>
        </div>
      </div>
    </section>

    <section class="story-questions" aria-label="Investment questions">
      <details><summary>Can I lose money?</summary><p>Yes. Rent may fall short, an early cash-out can be below your investment, and a property sale can leave losses. Fees also affect what you receive.</p></details>
      <details><summary>What if the deal does not close?</summary><p>A failed raise opens refunds under the stated fee policy. Once money has reached the closing agent, it must be returned before refunds can be paid.</p></details>
      <details><summary>Where is the money held?</summary><p>A Juicebox project holds the raise. A separate Revnet holds income backing and handles token cash-outs and holder loans. Property expenses and reserves stay outside that backing.</p></details>
    </section>
    <a class="story-numbers-link" href="#numbers">Explore the example’s numbers ${arrow}</a>
  </div>`;
}

export function bindStory() {
  let selected = 0;
  const panel = document.querySelector('#story-panel');
  const stageButtons = [...document.querySelectorAll('[data-stage]')];
  const previous = document.querySelector('#previous-stage');
  const next = document.querySelector('#next-stage');

  function select(index) {
    selected = Math.max(0, Math.min(stages.length - 1, index));
    const stage = stages[selected];
    panel.innerHTML = `<div class="story-copy"><h2 id="story-title">${stage.title}</h2><p>${stage.body}</p></div><figure class="stage-visual stage-${selected}"><div class="stage-drawing">${stage.visual}</div><figcaption>${stage.caption}</figcaption></figure>`;
    stageButtons.forEach((button, i) => {
      if (i === selected) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
      button.classList.toggle('completed', i < selected);
    });
    previous.disabled = selected === 0;
    next.disabled = selected === stages.length - 1;
    document.querySelector('#stage-count').textContent = `${selected + 1} of ${stages.length}`;

    panel.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => {
      panel.querySelectorAll('[data-choice]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
      document.querySelector('#choice-note').textContent = button.dataset.choice === 'borrow'
        ? 'Your tokens secure the loan and cannot also cash out. Repay the loan and fees to recover them; expiry can forfeit them.'
        : 'Receive $4,000 before fees. Your 10,000 tokens are retired, ending their future claims.';
    }));
  }

  stageButtons.forEach(button => button.addEventListener('click', () => select(Number(button.dataset.stage))));
  previous.addEventListener('click', () => select(selected - 1));
  next.addEventListener('click', () => select(selected + 1));
  select(0);
}
