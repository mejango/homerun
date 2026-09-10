// Venue facts and photographs sourced from https://founderhaus.club/.
// Provenance and the distinction from the financial model are recorded in
// docs/FOUNDER_HAUS_SOURCES.md. Photos are bundled locally, without hotlinking.
const photos = [
  { src: '/assets/founder-haus/exterior.jpg', label: 'House & pool', alt: 'Founder Haus exterior with a pool, garden, palm trees and a covered terrace.' },
  { src: '/assets/founder-haus/rooftop.jpg', label: 'Rooftop', alt: 'A shaded gazebo and seating on the Founder Haus rooftop, overlooking the ocean.' },
  { src: '/assets/founder-haus/community.jpg', label: 'Inside the clubhouse', alt: 'An indoor event at Founder Haus, with people seated for a presentation.' },
];

export function initFounderHaus() {
  const opener = document.querySelector('#open-house-gallery');
  if (!opener || document.querySelector('#house-gallery')) return;
  document.body.insertAdjacentHTML('beforeend', `<dialog id="house-gallery" class="house-gallery" aria-labelledby="house-gallery-title" aria-describedby="house-gallery-description">
    <div class="house-gallery-heading"><div><h2 id="house-gallery-title">Founder Haus</h2><p>Jurerê Internacional, Florianópolis, Brazil</p></div><button type="button" id="close-house-gallery" class="quiet-button" aria-label="Close Founder Haus photos" autofocus>Close ×</button></div>
    <figure class="house-gallery-photo"><img id="house-gallery-image" src="${photos[0].src}" alt="${photos[0].alt}" width="1440" height="1080"><figcaption id="house-gallery-caption" aria-live="polite">1 of 3 | House & pool</figcaption></figure>
    <div class="house-photo-picker" role="group" aria-label="Choose a Founder Haus photo">${photos.map((photo, i) => `<button type="button" data-house-photo="${i}" aria-pressed="${i === 0}"><img src="${photo.src}" alt="" loading="lazy" width="144" height="108"><span>${photo.label}</span></button>`).join('')}</div>
    <p id="house-gallery-description">A founders’ clubhouse with workspaces, events, a pool and wellness activities.</p>
    <p class="house-source">Photos and venue details from <a href="https://founderhaus.club/" target="_blank" rel="noopener noreferrer">Founder Haus <span aria-hidden="true">↗</span></a>.</p>
  </dialog>`);
  const dialog = document.querySelector('#house-gallery');
  const image = document.querySelector('#house-gallery-image');
  const caption = document.querySelector('#house-gallery-caption');
  const buttons = [...dialog.querySelectorAll('[data-house-photo]')];
  opener.addEventListener('click', () => dialog.showModal());
  document.querySelector('#close-house-gallery').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => opener.focus({ preventScroll: true }));
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-house-photo]');
    if (!button) return;
    const index = Number(button.dataset.housePhoto), photo = photos[index];
    image.src = photo.src; image.alt = photo.alt;
    caption.textContent = `${index + 1} of ${photos.length} | ${photo.label}`;
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  });
  dialog.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const current = buttons.findIndex(button => button.getAttribute('aria-pressed') === 'true');
    const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + photos.length) % photos.length;
    event.preventDefault(); buttons[next].click(); buttons[next].focus({ preventScroll: true });
  });
}
