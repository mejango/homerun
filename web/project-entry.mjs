import { loadCreatedProject } from './create-model.mjs';
const id = new URLSearchParams(location.search).get('id');
if (id && loadCreatedProject(id)) {
  await import('./network-app.mjs');
} else {
  document.querySelector('#reset-example').hidden = true;
  document.querySelector('#main').innerHTML = '<section class="missing-project"><h1>Project preview not found.</h1><p>Created previews are saved in the browser where you made them.</p><a class="button" href="/create/">Create a Homerun</a><a class="quiet-button" href="/founderhause">See Founder Haus demo ↗</a></section>';
}
