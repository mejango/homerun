/** Help stays out of the reading flow, but works with a mouse, keyboard or touch. */
export function initFieldHelp(root) {
  let active, pinned = false, dismissed, closeTimer;

  function hide(suppress = false) {
    clearTimeout(closeTimer);
    if (!active) return;
    if (suppress) dismissed = active;
    active.querySelector('.field-tooltip').hidden = true;
    active.querySelector('.field-help').setAttribute('aria-expanded', 'false');
    active = null;
    pinned = false;
  }

  function position() {
    if (!active) return;
    if (!active.getClientRects().length) { hide(); return; }
    const box = active.getBoundingClientRect();
    const tip = active.querySelector('.field-tooltip');
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    if (box.bottom < 0 || box.top > height) { hide(); return; }
    tip.style.width = `${Math.min(288, width - 24)}px`;
    tip.style.maxHeight = `${height - 24}px`;
    const tipBox = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(12, Math.min(box.left, width - tipBox.width - 12))}px`;
    const below = box.bottom + 8;
    const top = below + tipBox.height <= height - 12 ? below : box.top - tipBox.height - 8;
    tip.style.top = `${Math.max(12, Math.min(top, height - tipBox.height - 12))}px`;
  }

  function show(field, pin = false) {
    clearTimeout(closeTimer);
    if (dismissed === field && !pin) return;
    if (active !== field) hide();
    active = field;
    pinned = pinned || pin;
    if (pin) dismissed = null;
    field.querySelector('.field-tooltip').hidden = false;
    field.querySelector('.field-help').setAttribute('aria-expanded', 'true');
    position();
  }

  function leave(field) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (field.contains(document.activeElement) || field.matches(':hover')) return;
      if (dismissed === field) dismissed = null;
      if (active === field && !pinned) hide();
    }, 140);
  }

  for (const field of root.querySelectorAll('.projection-field')) {
    field.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') show(field);
    });
    field.addEventListener('pointerleave', () => {
      if (dismissed === field && !field.contains(document.activeElement)) dismissed = null;
      leave(field);
    });
    field.addEventListener('focusin', () => show(field));
    field.addEventListener('focusout', event => {
      if (dismissed === field && !field.contains(event.relatedTarget)) dismissed = null;
      leave(field);
    });
    field.querySelector('.field-help').addEventListener('click', event => {
      event.preventDefault();
      if (active === field && pinned) hide(true);
      else show(field, true);
    });
  }
  document.addEventListener('pointerdown', event => {
    if (active && !active.contains(event.target)) hide();
    if (dismissed && !dismissed.contains(event.target)) dismissed = null;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { hide(true); event.preventDefault(); }
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  return { hide, refresh: position };
}
