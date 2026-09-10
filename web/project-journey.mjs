const stages = [
  { phase: 'raising', title: 'Fundraise' },
  { phase: 'earning', title: 'Income' },
  { phase: 'liquidated', title: 'Asset sale' },
];
const views = {
  raising: { selected: 0, states: ['current', 'upcoming', 'upcoming'], labels: ['Raising', 'Upcoming', 'Eventually'], description: 'Contributions collect before the asset is purchased.' },
  funded: { selected: 0, states: ['complete', 'upcoming', 'upcoming'], labels: ['Raise closed', 'Upcoming', 'Eventually'], description: 'Raise closed. Funds are held until the asset is purchased.' },
  earning: { selected: 1, states: ['complete', 'current', 'upcoming'], labels: ['Complete', 'Earning', 'Eventually'], description: 'The asset is earning income before an eventual sale.' },
  liquidated: { selected: 2, states: ['complete', 'complete', 'complete'], labels: ['Complete', 'Complete', 'Sold'], description: 'The asset has sold. Net sale proceeds belong to FUND holders.' },
  refunding: { selected: 0, states: ['refunding', 'skipped', 'skipped'], labels: ['Refunding', 'Skipped', 'Skipped'], description: 'The asset was not purchased. Remaining funds can be refunded.' },
  refunded: { selected: 0, states: ['refunded', 'skipped', 'skipped'], labels: ['Refunded', 'Skipped', 'Skipped'], description: 'Refunds are complete. The asset was not purchased.' },
};
const invalidView = { selected: -1, states: ['upcoming', 'upcoming', 'upcoming'], labels: ['Not projected', 'Not projected', 'Not projected'], description: 'Check the assumptions to preview this journey.' };
const mounted = new WeakMap();

/** Mount this once inside #project-journey, then initialize the component. */
export function journeyMarkup() {
  return `<section class="pj-journey" aria-label="Three bases of the investment">
    <div class="pj-scene"><canvas class="pj-canvas" aria-hidden="true"></canvas>
      <div class="pj-stages" role="list" aria-label="Project stages">
        ${stages.map((stage, index) => `<div class="pj-stage" role="listitem" data-journey-phase="${stage.phase}" data-journey-status="${index === 0 ? 'current' : 'upcoming'}" ${index === 0 ? 'aria-current="step"' : ''}><span class="pj-base" aria-hidden="true"><span class="pj-base-number">${index + 1}</span></span><span class="pj-stage-copy"><strong>${stage.title}</strong><span data-journey-label>${index === 0 ? 'Raising' : index === 2 ? 'Eventually' : 'Upcoming'}</span></span></div>`).join('')}
      </div>
    </div>
    <p class="pj-description" role="status" aria-live="polite" aria-atomic="true">${views.raising.description}</p>
  </section>`;
}

function drawField(canvas, view) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const style = getComputedStyle(canvas.parentElement);
  const fraction = name => parseFloat(style.getPropertyValue(name)) / 100;
  const bases = [
    [width * fraction('--pj-first'), height * fraction('--pj-side-y')],
    [width / 2, height * fraction('--pj-top-y')],
    [width * fraction('--pj-third'), height * fraction('--pj-side-y')],
  ];
  const home = [width / 2, height * .92];
  const route = [home, ...bases, home];
  // Just a lightly retraced pencil path. The bases are display-only stage indicators.
  for (let i = 0; i < 4; i++) {
    const state = view.states[i];
    const completed = state === 'complete' || (i === 3 && view.states.every(item => item === 'complete'));
    const current = i === view.selected && state === 'current';
    const refund = i === 0 && ['refunding', 'refunded'].includes(state);
    ctx.strokeStyle = refund ? '#ab705a' : completed || current ? '#55764f' : '#cbd0c1';
    ctx.lineWidth = completed || current || refund ? 1.6 : 1;
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      const offset = pass ? 1.4 : 0;
      ctx.globalAlpha = pass ? .24 : .9;
      ctx.beginPath();
      ctx.moveTo(route[i][0] + offset, route[i][1]);
      ctx.lineTo((route[i][0] + route[i + 1][0]) / 2, (route[i][1] + route[i + 1][1]) / 2 + offset);
      ctx.lineTo(route[i + 1][0], route[i + 1][1] + offset);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(home[0] - 5, home[1] - 4);
  ctx.lineTo(home[0] + 5, home[1] - 4);
  ctx.lineTo(home[0] + 5, home[1] + 1);
  ctx.lineTo(home[0], home[1] + 5);
  ctx.lineTo(home[0] - 5, home[1] + 1);
  ctx.closePath();
  ctx.fillStyle = '#f7f5ef'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = '#a3ae96'; ctx.stroke();
}

/** Render the selected preview without adding navigation to the diagram. */
export function initProjectJourney() {
  const root = document.querySelector('#project-journey');
  if (!root?.querySelector('.pj-canvas')) throw new Error('Mount journeyMarkup() inside #project-journey before initializing.');
  const existing = mounted.get(root);
  if (existing) return existing.api;
  if (!document.querySelector('#project-journey-styles')) {
    const link = document.createElement('link'); link.id = 'project-journey-styles'; link.rel = 'stylesheet'; link.href = new URL('./project-journey.css', import.meta.url).href; document.head.append(link);
  }
  const canvas = root.querySelector('.pj-canvas'), indicators = [...root.querySelectorAll('.pj-stage[data-journey-phase]')];
  const instance = {};
  let view = views.raising, frame;
  const repaint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => drawField(canvas, view)); };
  const render = ({ phase = 'raising', valid = true } = {}) => {
    view = valid && views[phase] ? views[phase] : invalidView;
    root.dataset.journeyPhase = phase; root.dataset.journeyValid = String(Boolean(valid && views[phase]));
    indicators.forEach((indicator, index) => {
      const selected = view.selected === index;
      indicator.dataset.journeyStatus = view.states[index];
      if (selected) indicator.setAttribute('aria-current', 'step'); else indicator.removeAttribute('aria-current');
      indicator.setAttribute('aria-label', `${index + 1}. ${stages[index].title}: ${view.labels[index]}.`);
      indicator.querySelector('[data-journey-label]').textContent = view.labels[index];
      indicator.querySelector('.pj-base-number').textContent = view.states[index] === 'complete' ? '✓' : ['refunding', 'refunded'].includes(view.states[index]) ? '×' : String(index + 1);
    });
    root.querySelector('.pj-description').textContent = view.description;
    repaint();
  };
  const resize = new ResizeObserver(repaint); resize.observe(canvas);
  instance.api = { render }; mounted.set(root, instance); render();
  return instance.api;
}
