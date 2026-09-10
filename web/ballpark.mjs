// All artwork is drawn in JavaScript: layered pencil strokes, clipped grain,
// imperfect architectural lines, and a repeatable seed for stable resizing.
const canvas = document.querySelector('#ballpark');
let ctx = canvas.getContext('2d');
const C = { paper: '#f7f5ef', ink: '#31553c', green: '#47804e', light: '#a5b572', dark: '#2d6046', yellow: '#d9ad57', red: '#c35a40', cream: '#eee5c9', blue: '#78908a', soil: '#cc9260' };
let seed = 37;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const between = (a, b) => a + random() * (b - a);
const path = points => { const p = new Path2D(); points.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath(); return p; };
const oval = (x, y, rx, ry) => { const p = new Path2D(); p.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); return p; };
let grain;
let players = [];
const still = document.createElement('canvas');
const stillContext = still.getContext('2d');
const shapeSurface = document.createElement('canvas');
const shapeContext = shapeSurface.getContext('2d');
let shapeIndex = 0, shapeGroup = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const FRAME_INTERVAL = 1000 / 24;
const motionToggle = document.querySelector('#toggle-motion');
const intensitySlider = document.querySelector('#color-intensity');
const intensityOutput = document.querySelector('#color-intensity-value');
const paceSlider = document.querySelector('#color-pace');
const paceOutput = document.querySelector('#color-pace-value');
const groupingSlider = document.querySelector('#color-grouping');
const groupingOutput = document.querySelector('#color-grouping-value');
const modeSelect = document.querySelector('#color-mode');
let colorMode = 'shapes';
try { const savedMode = localStorage.getItem('homerun:color-mode'); if (['acid', 'shapes'].includes(savedMode)) colorMode = savedMode; } catch {}
modeSelect.value = colorMode;
let colorIntensity = 100, colorPace = 2.5, colorGrouping = 11;
try {
  const saved = localStorage.getItem('homerun:color-intensity');
  if (saved !== null && saved.trim() !== '' && Number.isFinite(Number(saved))) colorIntensity = Math.max(0, Math.min(100, Number(saved)));
} catch { /* Controls work without storage. */ }
try {
  const pace = localStorage.getItem('homerun:color-pace');
  const grouping = localStorage.getItem('homerun:color-grouping');
  if (pace !== null && pace.trim() && Number.isFinite(Number(pace))) colorPace = Math.max(.25, Math.min(4, Number(pace)));
  if (grouping !== null && grouping.trim() && Number.isFinite(Number(grouping))) colorGrouping = Math.max(0, Math.min(100, Number(grouping)));
} catch { /* Controls work without storage. */ }
paceSlider.value = String(colorPace); paceOutput.textContent = `${colorPace}×`;
groupingSlider.value = String(colorGrouping); groupingOutput.textContent = String(colorGrouping);
intensitySlider.value = String(colorIntensity);
intensityOutput.textContent = String(colorIntensity);
let motionPaused = false, motionRequested = false;
let scene, animationFrame = 0, resizeFrame = 0, lastTick = 0, lastPaint = 0, motionTime = 0;
let inView = true, pageActive = true;

function stopMotion() {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  lastTick = 0;
  lastPaint = 0;
}

function motionAllowed() {
  return scene && !motionPaused && (!reducedMotion.matches || motionRequested) && !document.hidden && inView && pageActive;
}

function syncMotion() {
  const state = reducedMotion.matches && !motionRequested ? 'reduced' : motionAllowed() ? 'running' : 'paused';
  canvas.dataset.motion = state;
  if (motionToggle) {
    motionToggle.hidden = false;
    motionToggle.textContent = state === 'reduced' ? 'Play color drift' : motionPaused ? 'Resume color drift' : 'Pause color drift';
  }
  if (state !== 'running') {
    stopMotion();
    if (state === 'reduced' && scene) paintMotion(0);
  } else if (!animationFrame) {
    animationFrame = requestAnimationFrame(tickMotion);
  }
}

function tickMotion(now) {
  animationFrame = 0;
  if (!motionAllowed()) { syncMotion(); return; }
  if (lastTick) motionTime += Math.min(now - lastTick, 100) / 1000 * colorPace;
  lastTick = now;
  const elapsed = now - lastPaint;
  if (!lastPaint || elapsed >= FRAME_INTERVAL) {
    lastPaint = now - elapsed % FRAME_INTERVAL;
    paintMotion(motionTime);
  }
  animationFrame = requestAnimationFrame(tickMotion);
}

function flutteringFlag(x, y, w, h, color, time, phase) {
  const flutter = Math.sin(time * 2.2 + phase) * 8;
  const p = new Path2D();
  p.moveTo(x, y);
  p.quadraticCurveTo(x + w * .43, y + flutter, x + w, y + h * .4 + flutter * .6);
  p.quadraticCurveTo(x + w * .53, y + h * .68 - flutter * .45, x, y + h);
  p.closePath();
  shade(p, color, false);
  ctx.save();
  ctx.strokeStyle = C.cream; ctx.globalAlpha = .18; ctx.lineWidth = .65;
  ctx.beginPath(); ctx.moveTo(x + 4, y + h * .3);
  ctx.quadraticCurveTo(x + w * .42, y + h * .22 + flutter, x + w * .78, y + h * .4 + flutter * .6);
  ctx.stroke(); ctx.restore();
}

function flyingBird(x, y, size, time, phase) {
  // Text bounds are measured only on resize; birds stay out of the lettering.
  if (scene.textRects.some(r => x + size > r.left && x - size < r.right && y + size > r.top && y - size < r.bottom)) return;
  const wing = 1.4 + Math.sin(time * 3.3 + phase) * 2.2;
  ctx.save(); ctx.strokeStyle = '#8e8e77'; ctx.globalAlpha = .58;
  ctx.lineWidth = .95; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - size, y - wing);
  ctx.quadraticCurveTo(x - size * .4, y - wing * .8, x, y + 1.2);
  ctx.quadraticCurveTo(x + size * .4, y - wing * .8, x + size, y - wing);
  ctx.stroke(); ctx.restore();
}

function coffeeSteam(time) {
  const { saucer } = scene;
  ctx.save(); ctx.translate(saucer.x, saucer.y); ctx.scale(saucer.scale, saucer.scale);
  ctx.strokeStyle = C.cream; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const progress = (time * .23 + i * .47 + .18) % 1;
    const y = 70 - progress * 13, drift = Math.sin(time * .8 + i) * 2;
    ctx.globalAlpha = Math.sin(progress * Math.PI) * .48;
    ctx.beginPath(); ctx.moveTo(97 + drift, y);
    ctx.bezierCurveTo(91 + drift, y - 5, 102 + drift, y - 10, 97 + drift, y - 17);
    ctx.stroke();
  }
  // The little antenna's warm light breathes slowly, without flashing.
  ctx.globalAlpha = .09 + (Math.sin(time * .9) + 1) * .04;
  ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(75, 3, 5.5 + Math.sin(time * .9) * .7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Layered frequencies keep the breeze and idle gestures from moving in lockstep.
function livingField(time) {
  for (const { sprite, x, y, phase } of players) {
    const sway = Math.sin(time * 1.05 + phase) * .055 + Math.sin(time * .39 + phase * 2) * .018;
    ctx.save(); ctx.translate(x + Math.sin(time * .8 + phase) * 1.5, y); ctx.rotate(sway);
    ctx.drawImage(sprite, -24, -64, 64, 80); ctx.restore();
  }
  // A visible warm-up toss starts promptly, with a short rest between throws.
  const cycle = Math.floor(time / 5.5);
  const progress = (time % 5.5 - .6) / 2.6;
  if (progress > 0 && progress < 1) {
    const reverse = cycle % 2 === 1;
    const t = reverse ? 1 - progress : progress;
    const x = 800 - 22 * t, y = 659 + 145 * t - Math.sin(t * Math.PI) * 46;
    ctx.save(); ctx.globalAlpha = Math.min(1, progress * 12, (1 - progress) * 12);
    ctx.fillStyle = C.paper; ctx.strokeStyle = '#87916d'; ctx.lineWidth = .6;
    ctx.beginPath(); ctx.ellipse(x, y, 4.2, 3.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  // Sparse leaves follow separate, slowly varying paths across the grass.
  for (let i = 0; i < 7; i++) {
    const duration = 12 + i * 2.17;
    const t = (time / duration + i * .173) % 1;
    const x = 360 + i * 142 + t * 115 + Math.sin(time * .7 + i) * 10;
    const y = 495 + (i % 3) * 90 + t * 65;
    ctx.save(); ctx.translate(x, y); ctx.rotate(time * .48 + i);
    ctx.globalAlpha = Math.sin(t * Math.PI) ** 2 * .65;
    ctx.fillStyle = i % 2 ? C.yellow : C.cream;
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 1.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

function paintScene(time) {
  if (!scene) return;
  // The thousands of pencil marks are copied from one cached resize render.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(still, 0, 0);
  const { dpr, scale, offset, visibleWidth, compact } = scene;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offset, dpr * 76);
  if (compact) {
    const right = 800 + visibleWidth / 2;
    flyingBird(right - 31 + Math.sin(time * .28) * 25, 237 + Math.sin(time * .23) * 5, 5, time, .7);
  } else {
    flyingBird(382 + Math.sin(time * .25) * 65, 175 + Math.sin(time * .19) * 7, 6, time, .2);
    flyingBird(1208 + Math.sin(time * .22 + 1) * 55, 85 + Math.sin(time * .17) * 6, 5, time, 1.8);
  }
  ctx.save(); ctx.translate(0, 45); ctx.scale(1, .95);
  flutteringFlag(257, 323, 50, 21, C.red, time, 0);
  flutteringFlag(1321, 328, 42, 20, C.yellow, time, 1.1);
  livingField(time);
  coffeeSteam(time);
  ctx.restore();
}

// A fixed image feeds a fragment shader: pixel positions never change, only color.
// Grouping follows masks captured from the actual drawing paths: individual
// pixels, painted shapes, then whole trees and houses.
const colorSurface = document.createElement('canvas');
const colorGL = colorSurface.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
let colorProgram, colorTexture, colorTime, colorAmplitude, colorGroupingUniform, colorModeUniform, shapeTexture;
function prepareColorDrift() {
  if (!colorGL) return;
  const gl = colorGL;
  if (!colorProgram) {
    const shader = (type, source) => {
      const item = gl.createShader(type); gl.shaderSource(item, source); gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) return null;
      return item;
    };
    const vertex = shader(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
      void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float;
      varying vec2 uv; uniform sampler2D artwork; uniform sampler2D shapes; uniform float time; uniform float amplitude; uniform float grouping; uniform float shapeMode;
      void main() {
        vec3 base = texture2D(artwork, uv).rgb;
        float grainPhase = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898,78.233))) * 43758.5453);
        vec2 shapePhase = texture2D(shapes, uv).rg * 6.2831853;
        float groupedPhase = mix(shapePhase.r, shapePhase.g, smoothstep(.4, 1.0, grouping));
        float shapeDrift = mix(grainPhase * 6.2831853, groupedPhase, smoothstep(0.0, .4, grouping));
        vec2 blob = uv * mix(180.0, 5.0, sqrt(grouping));
        float blobPhase = (sin(blob.x + sin(blob.y * .73)) + sin(blob.y * 1.17 + cos(blob.x * .61))) * 3.14159265;
        float acidDrift = mix(grainPhase * 6.2831853, blobPhase, smoothstep(0.0, .15, grouping));
        float phase = mix(acidDrift, shapeDrift, shapeMode);
        vec3 drift = sin(vec3(phase) + vec3(0., .7, 1.4) + time * .78539816) * (amplitude / 255.0);
        gl_FragColor = vec4(clamp(base + drift, 0., 1.), 1.);
      }`);
    if (!vertex || !fragment) return;
    colorProgram = gl.createProgram(); gl.attachShader(colorProgram, vertex); gl.attachShader(colorProgram, fragment); gl.linkProgram(colorProgram);
    if (!gl.getProgramParameter(colorProgram, gl.LINK_STATUS)) { colorProgram = null; return; }
    gl.useProgram(colorProgram);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(colorProgram, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    colorTime = gl.getUniformLocation(colorProgram, 'time');
    colorAmplitude = gl.getUniformLocation(colorProgram, 'amplitude');
    colorGroupingUniform = gl.getUniformLocation(colorProgram, 'grouping');
    colorModeUniform = gl.getUniformLocation(colorProgram, 'shapeMode');
    gl.uniform1i(gl.getUniformLocation(colorProgram, 'shapes'), 1);
    colorTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  colorSurface.width = canvas.width; colorSurface.height = canvas.height;
  gl.viewport(0, 0, colorSurface.width, colorSurface.height);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.bindTexture(gl.TEXTURE_2D, colorTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, still);
  gl.activeTexture(gl.TEXTURE1);
  if (!shapeTexture) shapeTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shapeTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shapeSurface);
  gl.activeTexture(gl.TEXTURE0);
}
function paintMotion(time) {
  if (!scene) return;
  ctx.setTransform(1,0,0,1,0,0);
  if (reducedMotion.matches && !motionRequested) { ctx.drawImage(still,0,0); return; }
  if (colorProgram && !colorGL.isContextLost()) {
    colorGL.useProgram(colorProgram); colorGL.uniform1f(colorTime, time); colorGL.uniform1f(colorAmplitude, colorIntensity * .4); colorGL.uniform1f(colorGroupingUniform, colorGrouping / 100); colorGL.uniform1f(colorModeUniform, colorMode === 'shapes' ? 1 : 0);
    colorGL.drawArrays(colorGL.TRIANGLES, 0, 6);
    ctx.drawImage(colorSurface,0,0);
  } else {
    ctx.save(); ctx.filter = `brightness(${1 + Math.sin(time * Math.PI / 4) * .12 * colorIntensity / 100})`;
    ctx.drawImage(still,0,0); ctx.restore();
  }
}

function protectedTextRects(bounds, scale, offset) {
  const copy = document.querySelector('.home-copy');
  if (!copy) return [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const rects = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(walker.currentNode);
    for (const r of range.getClientRects()) rects.push({
      left: (r.left - bounds.left - offset) / scale - 12,
      right: (r.right - bounds.left - offset) / scale + 12,
      top: (r.top - bounds.top) / scale - 10,
      bottom: (r.bottom - bounds.top) / scale + 10,
    });
  }
  return rects;
}

function pencilLine(points, color = C.ink, width = 1, passes = 2) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let pass = 0; pass < passes; pass++) {
    ctx.globalAlpha = pass ? .35 : .72; ctx.beginPath();
    points.forEach(([x, y], i) => {
      const j = width * .65;
      if (!i) ctx.moveTo(x + between(-j, j), y + between(-j, j));
      else ctx.lineTo(x + between(-j, j), y + between(-j, j));
    }); ctx.stroke();
  } ctx.restore();
}

function shade(p, color, outline = true) {
  if (ctx.canvas === canvas) {
    const phase = (++shapeIndex * 97) % 256;
    shapeContext.setTransform(ctx.getTransform());
    shapeContext.fillStyle = `rgb(${phase},${shapeGroup ?? phase},0)`;
    shapeContext.fill(p);
  }
  ctx.save(); ctx.fillStyle = color; ctx.fill(p);
  ctx.clip(p); ctx.fillStyle = grain; ctx.fillRect(0, 0, 1600, 1000); ctx.restore();
  if (outline) { ctx.save(); ctx.strokeStyle = C.ink; ctx.globalAlpha = .5; ctx.lineWidth = 1.2; ctx.stroke(p); ctx.restore(); }
}

function hatching(p, bounds, color, count = 70, direction = 1) {
  ctx.save(); ctx.clip(p); ctx.globalAlpha = .22; ctx.strokeStyle = color; ctx.lineWidth = .8;
  const [x, y, w, h] = bounds;
  for (let i = 0; i < count; i++) {
    const px = between(x, x + w), py = between(y, y + h), len = between(5, 28);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + len * direction, py - len * .65); ctx.stroke();
  } ctx.restore();
}

function shrub(x, y, w, h, color = C.green) {
  const p = new Path2D(); p.moveTo(x - w, y);
  for (let a = Math.PI; a < Math.PI * 2; a += .17) {
    const n = between(.85, 1.09); p.lineTo(x + Math.cos(a) * w * n, y + Math.sin(a) * h * n);
  }
  p.lineTo(x + w, y); p.closePath();
  shade(p, color, false); hatching(p, [x - w, y - h, w * 2, h], C.dark, w * 1.5);
}

function tree(...args) {
  const previous = shapeGroup;
  shapeGroup = Math.abs(Math.round(args[0] * 17 + args[1] * 31)) % 256;
  drawTree(...args);
  shapeGroup = previous;
}

function drawTree(x, ground, size, color = C.green) {
  const top = ground - size;
  shade(path([[x - 5, ground], [x - 3, top + size * .38], [x + 3, top + size * .35], [x + 7, ground]]), '#90764d');
  for (let n = 0; n < 9; n++) {
    const a = between(-Math.PI, 0), r = between(.03, .24) * size;
    const cx = x + Math.cos(a) * r, cy = top + size * .32 + Math.sin(a) * r;
    const p = oval(cx, cy, size * between(.14, .24), size * between(.18, .3));
    shade(p, n % 4 === 0 ? C.light : color, false);
    hatching(p, [cx - size * .25, cy - size * .3, size * .5, size * .6], C.dark, 65);
  }
  pencilLine([[x, ground - 4], [x + 1, top + size * .48], [x - size * .12, top + size * .28]], C.ink, 1.7);
  pencilLine([[x + 1, top + size * .62], [x + size * .17, top + size * .39]], C.ink, 1.3);
  for (let i = 0; i < size * 1.3; i++) {
    const a = between(0, Math.PI * 2), r = Math.sqrt(random());
    const px = x + Math.cos(a) * r * size * .3, py = top + size * .27 + Math.sin(a) * r * size * .31;
    pencilLine([[px, py], [px + between(2, 7), py - between(1, 5)]], i % 3 ? color : C.dark, .9, 1);
  }
}

function windowAt(x, y, w, h, shutters = false) {
  shade(path([[x, y], [x + w, y + .5], [x + w, y + h], [x, y + h]]), C.blue);
  pencilLine([[x + w * .5, y], [x + w * .5, y + h]], C.cream, 1.9);
  pencilLine([[x, y + h * .48], [x + w, y + h * .48]], C.cream, 1.9);
  pencilLine([[x - 2, y + h + 2], [x + w + 3, y + h + 2]], C.cream, 3);
  if (shutters) {
    shade(path([[x - 6, y], [x - 2, y], [x - 2, y + h], [x - 6, y + h]]), C.dark, false);
    shade(path([[x + w + 2, y], [x + w + 6, y], [x + w + 6, y + h], [x + w + 2, y + h]]), C.dark, false);
  }
}

function archedWindowAt(x, y, w, h, shutters = false) {
  const p = new Path2D();
  p.moveTo(x, y + h); p.lineTo(x, y + w / 2);
  p.arc(x + w / 2, y + w / 2, w / 2, Math.PI, Math.PI * 2);
  p.lineTo(x + w, y + h); p.closePath(); shade(p, C.blue);
  pencilLine([[x + w / 2, y + 2], [x + w / 2, y + h]], C.cream, 1.6);
  pencilLine([[x, y + h * .58], [x + w, y + h * .58]], C.cream, 1.4);
  pencilLine([[x - 2, y + h + 2], [x + w + 2, y + h + 2]], C.cream, 3);
  if (shutters) {
    pencilLine([[x - 4, y + 5], [x - 4, y + h]], C.dark, 3.3);
    pencilLine([[x + w + 4, y + 5], [x + w + 4, y + h]], C.dark, 3.3);
  }
}

function balcony(x, y, w, color = C.cream) {
  shade(path([[x - 2, y + 13], [x + w + 4, y + 13], [x + w + 1, y + 18], [x, y + 18]]), color);
  pencilLine([[x, y], [x, y + 13], [x + w, y + 13], [x + w, y]], C.dark, .9);
  pencilLine([[x - 2, y], [x + w + 2, y]], C.dark, 1.2);
  for (let bx = x + 5; bx < x + w; bx += 6) pencilLine([[bx, y], [bx, y + 13]], C.dark, .65);
}

function house(...args) {
  const previous = shapeGroup;
  shapeGroup = Math.abs(Math.round(args[0] * 17 + args[1] * 31)) % 256;
  drawHouse(...args);
  shapeGroup = previous;
}

function drawHouse(x, base, w, h, color, roofColor = C.red, style = 'cottage') {
  const y = base - h, side = w * .18, roof = h * .32;
  const poly = (points, fill) => shade(path(points), fill);
  const line = (points, fill = C.ink, weight = 1) => pencilLine(points, fill, weight);
  const door = (dx, dy, dw, dh, fill = C.dark) => {
    poly([[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]], fill);
    line([[dx + dw * .78, dy + dh * .56], [dx + dw * .78, dy + dh * .61]], C.yellow, 1.8);
  };
  const chimney = (cx, cy, ch = 20) => {
    poly([[cx, cy], [cx, cy - ch], [cx + 8, cy - ch], [cx + 8, cy + 4]], C.red);
    line([[cx - 1, cy - ch], [cx + 9, cy - ch]], C.cream, 1.6);
  };
  const porch = (px, py, pw, posts = 3, fill = C.cream) => {
    poly([[px + 5, py], [px + pw - 6, py], [px + pw + 1, py + 9], [px - 2, py + 9]], fill);
    for (let n = 0; n < posts; n++) {
      const sx = px + 3 + n * (pw - 7) / (posts - 1);
      line([[sx, py + 9], [sx, base + 2]], C.cream, 3);
    }
    line([[px - 1, base + 2], [px + pw, base + 2]], '#958e70', 2.3);
  };
  const gable = (gx, gy, gw, gh, fill) => {
    poly([[gx - 7, gy + 2], [gx + gw * .49, gy - gh], [gx + gw + 6, gy + 2]], fill);
    line([[gx - 7, gy + 3], [gx + gw + 6, gy + 3]], C.cream, 1.8);
  };
  poly([[x + w, y + 2], [x + w + side, y + 16], [x + w + side, base - 3], [x + w, base]], color === C.cream ? '#cecbae' : C.soil);
  poly([[x, y], [x + w, y], [x + w, base], [x, base]], color);
  if (['cottage', 'bungalow', 'studio'].includes(style)) {
    for (let sy = y + 7; sy < base; sy += 8) line([[x + 1, sy], [x + w - 1, sy + .5]], '#ac9f7c', .55);
  }
  if (style === 'cottage') {
    // The oldest house: a steep red gable, green shutters and a deep front porch.
    gable(x, y, w, roof, roofColor);
    poly([[x + w * .49, y - roof], [x + w * .49 + side, y - roof + 8], [x + w + side + 7, y + 17], [x + w + 6, y + 3]], C.soil);
    chimney(x + w * .76, y - roof * .28, 24);
    windowAt(x + w * .44, y - roof * .35, w * .12, roof * .25);
    windowAt(x + w * .15, y + h * .16, w * .18, h * .23, true);
    windowAt(x + w * .66, y + h * .16, w * .18, h * .23, true);
    door(x + w * .43, base - h * .38, w * .17, h * .38);
    windowAt(x + w * .12, base - h * .34, w * .17, h * .22);
    windowAt(x + w * .72, base - h * .34, w * .16, h * .22);
    porch(x - 4, base - h * .26, w + 8, 4);
  } else if (style === 'balcony') {
    // A narrow ochre house with a clipped hip roof and an upstairs balcony.
    poly([[x - 7, y + 3], [x + 19, y - roof * .72], [x + w - 19, y - roof * .72], [x + w + 7, y + 3]], roofColor);
    poly([[x + w - 19, y - roof * .72], [x + w + side - 14, y - roof * .52], [x + w + side + 5, y + 16], [x + w + 7, y + 3]], C.green);
    chimney(x + w - 11, y - 7, 24);
    windowAt(x + w * .15, y + 17, w * .22, h * .24, true);
    windowAt(x + w * .61, y + 17, w * .22, h * .24, true);
    balcony(x + w * .07, y + h * .33, w * .86);
    door(x + w * .37, base - h * .37, w * .26, h * .37, C.red);
    windowAt(x + w * .1, base - h * .29, w * .17, h * .2);
    windowAt(x + w * .75, base - h * .29, w * .15, h * .2);
    poly([[x + w * .26, base - h * .4], [x + w * .71, base - h * .4], [x + w * .79, base - h * .32], [x + w * .2, base - h * .32]], C.cream);
  } else if (style === 'bungalow') {
    // A low, wide bungalow: generous eaves and a long veranda face the field.
    poly([[x - 13, y + 6], [x + w * .33, y - roof], [x + w * .73, y - roof], [x + w + 13, y + 6]], roofColor);
    poly([[x + w * .73, y - roof], [x + w + side + 8, y - 4], [x + w + side + 12, y + 18], [x + w + 13, y + 6]], C.dark);
    line([[x - 12, y + 7], [x + w + 12, y + 7]], C.cream, 3);
    chimney(x + w * .18, y - 5, 24);
    windowAt(x + w * .12, y + 18, w * .22, h * .3, true);
    windowAt(x + w * .69, y + 18, w * .2, h * .3, true);
    door(x + w * .44, base - h * .64, w * .16, h * .64, C.red);
    porch(x - 7, base - h * .33, w + 17, 5, C.cream);
    balcony(x + 3, base - 14, w * .32);
    balcony(x + w * .69, base - 14, w * .31);
  } else if (style === 'townhouse') {
    // A taller brick townhouse with a mansard roof and arched upper windows.
    for (let sy = y + 5, row = 0; sy < base; sy += 8, row++) {
      line([[x + 1, sy], [x + w - 1, sy]], '#e5ad87', .65);
      for (let sx = x + (row % 2 ? 7 : 16); sx < x + w - 1; sx += 21) line([[sx, sy], [sx, sy + 7]], '#e5ad87', .55);
    }
    poly([[x - 6, y + 3], [x + 16, y - roof * .7], [x + w - 14, y - roof * .7], [x + w + 6, y + 3]], roofColor);
    poly([[x + w - 14, y - roof * .7], [x + w + side - 4, y - roof * .46], [x + w + side + 7, y + 17], [x + w + 6, y + 3]], C.green);
    const dormerX = x + w * .4;
    poly([[dormerX, y - roof * .45], [dormerX + 23, y - roof * .45], [dormerX + 23, y + 1], [dormerX, y + 1]], C.cream);
    gable(dormerX, y - roof * .45, 23, 8, C.dark);
    windowAt(dormerX + 5, y - roof * .36, 13, roof * .29);
    archedWindowAt(x + w * .12, y + 14, w * .19, h * .23);
    archedWindowAt(x + w * .4, y + 14, w * .19, h * .23);
    archedWindowAt(x + w * .7, y + 14, w * .19, h * .23);
    line([[x - 3, y + h * .42], [x + w + 3, y + h * .42]], C.cream, 3);
    windowAt(x + w * .12, y + h * .51, w * .2, h * .2);
    windowAt(x + w * .69, y + h * .51, w * .2, h * .2);
    door(x + w * .42, base - h * .42, w * .17, h * .42);
    porch(x + w * .32, base - h * .24, w * .39, 2);
  } else if (style === 'terrace') {
    // A little modern coastal home with a roof terrace and a striped awning.
    poly([[x - 4, y - 6], [x + w + 3, y - 6], [x + w + side + 5, y + 7], [x + w + side + 5, y + 14], [x + w + 3, y + 1], [x - 4, y + 1]], C.cream);
    poly([[x + w * .58, y - 7], [x + w * .58, y - 27], [x + w * .93, y - 27], [x + w * .93, y - 7]], C.yellow);
    line([[x + w * .56, y - 28], [x + w * .96, y - 28]], C.cream, 3);
    balcony(x + 3, y - 16, w * .48);
    shrub(x + 11, y - 5, 6, 8); shrub(x + 39, y - 5, 5, 6, C.dark);
    windowAt(x + w * .12, y + 16, w * .28, h * .24);
    windowAt(x + w * .59, y + 16, w * .28, h * .24);
    door(x + w * .14, base - h * .39, w * .19, h * .39);
    windowAt(x + w * .48, base - h * .36, w * .37, h * .24);
    const awningX = x + w * .42, awningW = w * .49, awningY = base - h * .4;
    for (let n = 0; n < 6; n++) {
      const ax = awningX + n * awningW / 6;
      poly([[ax + 2, awningY], [ax + awningW / 6 + 2, awningY], [ax + awningW / 6 + 4, awningY + 9], [ax, awningY + 9]], n % 2 ? C.cream : C.red);
    }
  } else if (style === 'villa') {
    // A pale villa with two different gables, a bay and an arched porch.
    poly([[x - 8, y + 4], [x + w * .37, y - roof * .69], [x + w * .8, y - roof * .69], [x + w + 9, y + 4]], roofColor);
    poly([[x + w * .8, y - roof * .69], [x + w + side + 7, y + 4], [x + w + side + 7, y + 19], [x + w + 9, y + 4]], C.soil);
    const wingX = x + w * .07, wingW = w * .49;
    poly([[wingX, y + 4], [wingX + wingW, y + 4], [wingX + wingW, y - roof * .13], [wingX + wingW * .5, y - roof], [wingX, y - roof * .13]], C.cream);
    line([[wingX - 5, y - roof * .1], [wingX + wingW * .5, y - roof - 3], [wingX + wingW + 5, y - roof * .1]], C.red, 5);
    chimney(x + w * .91, y - 3, 26);
    archedWindowAt(wingX + wingW * .37, y - roof * .5, wingW * .25, roof * .32);
    windowAt(x + w * .13, y + 16, w * .16, h * .22, true);
    windowAt(x + w * .38, y + 16, w * .16, h * .22, true);
    windowAt(x + w * .71, y + 16, w * .18, h * .22, true);
    balcony(x + w * .66, y + h * .37, w * .3);
    const bayY = base - h * .37;
    poly([[x + 6, bayY + 7], [x + 15, bayY], [x + w * .5, bayY], [x + w * .56, bayY + 7], [x + w * .56, base], [x + 6, base]], '#dedbc0');
    windowAt(x + 14, bayY + 5, w * .16, h * .22);
    windowAt(x + w * .32, bayY + 5, w * .16, h * .22);
    poly([[x + 3, bayY + 5], [x + 14, bayY - 4], [x + w * .51, bayY - 4], [x + w * .59, bayY + 5]], C.red);
    archedWindowAt(x + w * .7, base - h * .37, w * .18, h * .37);
  } else if (style === 'studio') {
    // An artist's cottage: asymmetric roof, tall glazing and a timber pergola.
    poly([[x - 7, y + 4], [x + w * .29, y - roof * 1.07], [x + w + 8, y + 4]], roofColor);
    poly([[x + w * .29, y - roof * 1.07], [x + w * .29 + side, y - roof * .8], [x + w + side + 7, y + 18], [x + w + 8, y + 4]], C.green);
    chimney(x + w * .78, y - 2, 23);
    windowAt(x + w * .19, y - roof * .25, w * .14, roof * .23);
    windowAt(x + w * .12, y + 19, w * .54, h * .3);
    line([[x + w * .3, y + 19], [x + w * .3, y + 19 + h * .3]], C.cream, 1.8);
    door(x + w * .76, base - h * .59, w * .16, h * .59, C.red);
    windowAt(x + w * .16, base - h * .27, w * .39, h * .2);
    const py = base - h * .31;
    for (let n = 0; n < 6; n++) line([[x - 4 + n * w * .13, py], [x + 4 + n * w * .13, py + 9]], C.cream, 2.4);
    line([[x - 5, py + 9], [x + w * .69, py + 9]], C.cream, 3);
    line([[x + 1, py + 9], [x + 1, base + 2]], C.cream, 2.6);
    line([[x + w * .65, py + 9], [x + w * .65, base + 2]], C.cream, 2.6);
  }
  line([[x - 3, base + 3], [x + w + 3, base + 3]], '#958e70', 2);
  shrub(x + 5, base + 4, style === 'bungalow' ? 13 : 17, 11);
  shrub(x + w - 1, base + 4, 12, 9, C.dark);
}

function storefront(x, base, w) {
  // A bakery below the townhouse keeps commerce part of the neighborhood.
  const y = base - 70;
  shade(path([[x, y], [x + w, y], [x + w, base], [x, base]]), C.red, false);
  for (let sy = y + 5; sy < base; sy += 8) pencilLine([[x + 1, sy], [x + w - 1, sy]], '#e5ad87', .6);
  windowAt(x + 10, y + 19, w * .49, 42);
  shade(path([[x + w * .71, y + 16], [x + w * .92, y + 16], [x + w * .92, base], [x + w * .71, base]]), C.dark);
  windowAt(x + w * .74, y + 21, w * .15, 26);
  pencilLine([[x + w * .87, base - 17], [x + w * .87, base - 14]], C.yellow, 1.7);
  for (let n = 0; n < 8; n++) {
    const sx = x - 3 + n * (w + 6) / 8;
    shade(path([[sx + 3, y + 3], [sx + (w + 6) / 8 + 3, y + 3], [sx + (w + 6) / 8 + 1, y + 17], [sx - 1, y + 17]]), n % 2 ? C.cream : C.dark, false);
  }
  pencilLine([[x - 3, y + 17], [x + w + 4, y + 17]], C.cream, 1.5);
  for (let n = 0; n < 3; n++) {
    shade(oval(x + 20 + n * 16, base - 16, 6.5, 4), C.yellow, false);
    pencilLine([[x + 18 + n * 16, base - 17], [x + 21 + n * 16, base - 19]], C.cream, .8, 1);
  }
  pencilLine([[x + 9, base - 11], [x + w * .62, base - 11]], C.cream, 2.1);
}

function rooftopSolar() {
  // The low bungalow supplies a little power to the shared block.
  const tl = [586, 345], tr = [644, 345], br = [668, 365], bl = [564, 365];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  shade(path([tl, tr, br, bl]), '#3f6868');
  for (let column = 0; column <= 4; column++) pencilLine([lerp(tl, tr, column / 4), lerp(bl, br, column / 4)], '#c7d7c7', .85);
  for (let row = 0; row <= 2; row++) pencilLine([lerp(tl, bl, row / 2), lerp(tr, br, row / 2)], '#c7d7c7', .85);
  pencilLine([[563, 367], [669, 367]], C.cream, 1.5);
}

function tractor(x, y, scale = 1) {
  // Parked in foul territory, the neighborhood's mower is between shifts.
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  shade(oval(72, 108, 70, 7), '#829761', false);
  shade(path([[38, 65], [111, 65], [132, 82], [129, 96], [37, 96]]), C.dark);
  shade(path([[51, 22], [86, 22], [100, 69], [49, 69]]), C.cream);
  shade(path([[57, 28], [82, 28], [90, 59], [57, 59]]), C.blue);
  pencilLine([[69, 28], [69, 60]], C.cream, 1.7);
  shade(path([[45, 18], [89, 18], [94, 25], [43, 25]]), C.red);
  shade(path([[92, 65], [125, 69], [139, 85], [91, 85]]), C.yellow);
  pencilLine([[105, 66], [105, 42]], C.dark, 4.5);
  pencilLine([[126, 72], [131, 80]], C.ink, 1.4);
  pencilLine([[100, 75], [115, 75]], C.soil, 1.3);
  pencilLine([[38, 86], [9, 86], [5, 98]], C.dark, 3.5);
  shade(path([[31, 77], [51, 71], [72, 76], [73, 84], [32, 84]]), C.dark);
  for (const [wx, wy, r] of [[50, 91, 23], [118, 98, 15]]) {
    shade(oval(wx, wy, r, r), C.ink);
    shade(oval(wx, wy, r * .58, r * .58), C.yellow);
    shade(oval(wx, wy, 3, 3), C.soil, false);
    for (let n = 0; n < 10; n++) {
      const a = n * Math.PI / 5;
      pencilLine([[wx + Math.cos(a) * r * .78, wy + Math.sin(a) * r * .78], [wx + Math.cos(a + .14) * r * .96, wy + Math.sin(a + .14) * r * .96]], C.light, 1.4, 1);
    }
  }
  ctx.restore();
}

function coffeeSaucer(x, y, scale = 1) {
  // An unusual concession stand has landed beside the game.
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  shade(oval(76, 113, 69, 6), '#829761', false);
  for (const [sx, sy, fx] of [[35, 88, 22], [74, 93, 76], [116, 88, 130]]) {
    pencilLine([[sx, sy], [fx, 109]], C.dark, 3.4);
    shade(path([[fx - 8, 108], [fx + 7, 108], [fx + 10, 113], [fx - 10, 113]]), C.dark, false);
  }
  shade(oval(76, 78, 66, 22), C.red, false);
  shade(oval(76, 68, 72, 21), C.yellow);
  pencilLine([[13, 78], [38, 87], [76, 90], [115, 87], [139, 78]], C.cream, 2);
  const dome = new Path2D('M32 62 C30 35 46 12 75 12 C104 12 122 35 120 62 Z');
  shade(dome, C.blue, false);
  pencilLine([[39, 43], [49, 26], [62, 20]], C.cream, 1.8);
  pencilLine([[75, 11], [75, 4]], C.dark, 1.3);
  shade(oval(75, 3, 3, 3), C.red, false);
  shade(oval(76, 43, 11, 13), C.light, false);
  shade(oval(72, 42, 2.3, 3.2), C.dark, false);
  shade(oval(81, 42, 2.3, 3.2), C.dark, false);
  pencilLine([[74, 50], [79, 50]], C.dark, .7, 1);
  shade(path([[42, 72], [109, 72], [109, 85], [42, 85]]), C.cream);
  for (let n = 0; n < 6; n++) {
    const sx = 42 + n * 11;
    shade(path([[sx + 3, 57], [sx + 14, 57], [sx + 11, 69], [sx, 69]]), n % 2 ? C.cream : C.red, false);
  }
  pencilLine([[42, 69], [42, 80]], C.dark, 1.3);
  pencilLine([[108, 69], [108, 80]], C.dark, 1.3);
  pencilLine([[39, 82], [112, 82]], C.dark, 2);
  shade(path([[93, 73], [101, 73], [100, 80], [94, 80]]), C.paper, false);
  pencilLine([[101, 74], [105, 74], [104, 78], [101, 78]], C.paper, 1.1);
  for (const sx of [23, 129]) shade(oval(sx, 70, 4, 2.5), C.cream, false);
  ctx.restore();
}

function fence() {
  const points = [[56, 568], [263, 517], [492, 487], [710, 475], [905, 476], [1110, 491], [1320, 522], [1552, 579]];
  shade(path([...points.map(([x, y]) => [x, y - 48]), ...[...points].reverse()]), '#88a17a', false);
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    for (let x = x1; x < x2; x += 7) {
      const y = y1 + (y2 - y1) * (x - x1) / (x2 - x1);
      pencilLine([[x, y - 47], [x + 1, y - 2]], C.dark, .75, 1);
    }
    pencilLine([[x1, y1 - 49], [x2, y2 - 49]], C.cream, 3);
    pencilLine([[x1, y1 - 30], [x2, y2 - 30]], C.dark, 1.4);
    pencilLine([[x1, y1 - 52], [x1, y1 + 2]], C.dark, 3);
  }
}

function bench(x, y, scale = 1, teamColor = C.cream, facing = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  shade(path([[0, 0], [83, 0], [83, 15], [0, 15]]), C.yellow);
  shade(path([[-2, 20], [85, 20], [92, 27], [4, 27]]), C.soil);
  pencilLine([[11, 12], [11, 42]], C.dark, 3); pencilLine([[73, 12], [78, 40]], C.dark, 3);
  pencilLine([[0, 7], [83, 7]], C.ink, .8);
  const fieldSeed = seed;
  seatedPlayer(18, 24, teamColor, .88, facing, 0);
  seatedPlayer(44, 24, teamColor, .95, facing, 1);
  seatedPlayer(69, 24, teamColor, .88, facing, 2);
  seed = fieldSeed;
  ctx.restore();
}

function seatedPlayer(x, y, color, scale, facing, pose) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale * facing, scale);
  shade(oval(1, 17, 11, 2.5), '#829761', false);
  // Bent knees and dangling cleats place each teammate on the seat.
  pencilLine([[-3, -1], [-8, 5], [-6, 15], [-2, 15]], C.dark, 3);
  pencilLine([[3, -1], [8, 4], [9, 15], [13, 15]], C.dark, 3);
  const lean = pose === 2 ? 3 : -1;
  shade(path([[-5 + lean, -17], [5 + lean, -17], [6, 0], [-5, 0]]), color, false);
  pencilLine([[-5 + lean, -14], [-8, -5], [-3, 2]], color, 3.3);
  if (pose === 1) {
    pencilLine([[5 + lean, -14], [12, -20], [11, -28]], color, 3.3);
    shade(oval(11, -29, 2.1, 2.5), '#cba173', false);
  } else {
    pencilLine([[5 + lean, -14], [10, -6], [7, 3]], color, 3.3);
    shade(oval(7, 3, 2, 2), '#cba173', false);
  }
  shade(oval(-3, 2, 2, 2), '#cba173', false);
  shade(oval(lean, -23, 4.7, 5.2), '#cba173', false);
  shade(path([[-5 + lean, -25], [-3 + lean, -29], [3 + lean, -29], [6 + lean, -24], [10 + lean, -24]]), C.dark, false);
  ctx.restore();
}

function player(x, y, color = C.red, s = 1, pose = 0) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  shade(oval(0, 2, 12, 3), '#829761', false);
  pencilLine([[-3, -13], [-5, 0], [-11, 0]], C.dark, 3);
  pencilLine([[2, -13], [6, -1], [12, 0]], C.dark, 3);
  shade(path([[-5, -28], [5, -28], [6, -12], [-5, -12]]), color, false);
  pencilLine([[-5, -25], [-11, pose ? -34 : -16]], color, 3.3);
  pencilLine([[5, -25], [12, pose ? -31 : -19]], color, 3.3);
  shade(oval(0, -34, 4.7, 5.2), '#cba173', false);
  shade(path([[-5, -36], [-3, -40], [3, -40], [6, -35], [10, -35]]), C.dark, false);
  if (pose) pencilLine([[10, -32], [21, -54]], C.yellow, 3);
  ctx.restore();
}

function coastline(visibleWidth) {
  const compact = visibleWidth < 900;
  const left = (1600 - visibleWidth) / 2, right = 1600 - left;
  const horizon = 278;
  const sunset = ctx.createLinearGradient(0, 0, 0, 510);
  sunset.addColorStop(0, C.paper);
  sunset.addColorStop(.24, '#f6ebd9');
  sunset.addColorStop(.53, '#f2d6b9');
  sunset.addColorStop(.76, '#e8b99e');
  sunset.addColorStop(1, '#f4d8a6');
  ctx.fillStyle = sunset; ctx.fillRect(0, -200, 1600, 745);
  ctx.save(); ctx.globalAlpha = .28; ctx.fillStyle = grain; ctx.fillRect(0, -200, 1600, 745); ctx.restore();

  // An oversized, banded sun makes the familiar neighborhood feel a little
  // dreamlike. Bring it toward the edge of the phone crop, rather than lose it.
  const sunX = compact ? right - 28 : 1270, sunY = compact ? 183 : 140, radius = compact ? 97 : 112;
  const sun = oval(sunX, sunY, radius, radius);
  ctx.save(); ctx.clip(sun);
  const sunColor = ctx.createLinearGradient(0, sunY - radius, 0, sunY + radius);
  sunColor.addColorStop(0, '#f3cf79'); sunColor.addColorStop(.54, '#ebaa69'); sunColor.addColorStop(1, '#d97e61');
  ctx.fillStyle = sunColor; ctx.fillRect(sunX - radius, sunY - radius, radius * 2, radius * 2);
  ctx.fillStyle = grain; ctx.fillRect(sunX - radius, sunY - radius, radius * 2, radius * 2);
  for (let y = sunY - radius; y < sunY + radius; y += 6) pencilLine([[sunX - radius, y], [sunX + radius, y - 1]], '#efc08b', .8, 1);
  ctx.restore();
  ctx.save(); ctx.strokeStyle = '#e5a677'; ctx.lineWidth = .9; ctx.globalAlpha = .4;
  ctx.stroke(oval(sunX - 1, sunY + 1, radius + 9, radius + 10)); ctx.restore();

  // Long pencil clouds and receding ridges share the limited terracotta palette.
  for (const [x, y, w, h] of [[180, 116, 147, 11], [compact ? sunX : 1280, 192, 162, 10], [1440, 75, 94, 6], [425, 241, 98, 7]]) {
    const cloud = new Path2D(`M${x - w} ${y} Q${x - w * .5} ${y - h} ${x} ${y - h * .45} Q${x + w * .65} ${y - h * 1.1} ${x + w} ${y + 1} Q${x + w * .2} ${y + h} ${x - w} ${y} Z`);
    shade(cloud, '#edd5bb', false);
    pencilLine([[x - w * .7, y + 2], [x + w * .8, y + 1]], '#e0bd9b', .7, 1);
  }
  const farRidge = path([[0, 312], [0, 203], [91, 172], [156, 206], [242, 143], [305, 172], [389, 226], [460, 209], [541, 278], [681, 293], [874, 292], [1007, 270], [1086, 223], [1150, 241], [1233, 181], [1300, 196], [1390, 140], [1471, 164], [1600, 211], [1600, 326]]);
  shade(farRidge, '#c5b7b0', false); hatching(farRidge, [0, 138, 1600, 190], '#968a8a', 850);

  const sea = new Path2D(`M-20 ${horizon + 5} Q500 ${horizon - 6} 820 ${horizon + 2} T1620 ${horizon + 1} L1620 555 L-20 555 Z`);
  const water = ctx.createLinearGradient(0, horizon, 0, 525);
  water.addColorStop(0, '#b5cfbf'); water.addColorStop(.3, '#8db7af'); water.addColorStop(1, '#568f89');
  ctx.save(); ctx.clip(sea); ctx.fillStyle = water; ctx.fillRect(0, horizon - 8, 1600, 300);
  ctx.globalAlpha = .8; ctx.fillStyle = grain; ctx.fillRect(0, horizon - 8, 1600, 300); ctx.restore();
  for (let i = 0; i < 800; i++) {
    const x = between(0, 1600), y = between(horizon + 7, 538), length = between(8, 47);
    pencilLine([[x, y], [x + length * .5, y - between(0, 1.5)], [x + length, y]], i % 3 ? '#d6ddc0' : '#5b918e', between(.5, 1.2), 1);
  }
  // Broken golden reflections drift down from the low sun.
  for (let i = 0; i < 85; i++) {
    const y = between(horizon + 2, 496), spread = 15 + (y - horizon) * .32;
    const x = sunX + between(-spread, spread);
    pencilLine([[x - between(4, 16), y], [x + between(5, 29), y]], i % 3 ? '#ebce94' : '#f5e3b4', between(.9, 2), 1);
  }

  // Impossibly tall coastal cliffs frame the lettering. Their light facets and
  // little green ledges keep them part of the same colored-pencil world.
  const cliffLeft = compact ? left - 40 : -70;
  const cliffWidth = compact ? 270 : 487;
  const cliffTop = compact ? 220 : 105;
  const lx = f => cliffLeft + cliffWidth * f;
  const west = path([[lx(0), 414], [lx(0), cliffTop + 48], [lx(.15), cliffTop + 39], [lx(.28), cliffTop - 6], [lx(.43), cliffTop], [lx(.51), cliffTop + 105], [lx(.64), cliffTop + 98], [lx(.75), cliffTop + 166], [lx(.83), cliffTop + 170], [lx(1), 399], [lx(.85), 431]]);
  shade(west, '#c99072', false); hatching(west, [cliffLeft, cliffTop - 8, cliffWidth, 340], '#a87262', 690);
  shade(path([[lx(.28), cliffTop - 6], [lx(.43), cliffTop], [lx(.51), cliffTop + 105], [lx(.64), cliffTop + 98], [lx(.55), 367], [lx(.3), 419], [lx(.34), cliffTop + 127]]), '#e3bf93', false);
  shade(path([[lx(.15), cliffTop + 39], [lx(.28), cliffTop - 6], [lx(.43), cliffTop], [lx(.36), cliffTop + 13], [lx(.26), cliffTop + 12]]), '#849977', false);
  for (let i = 0; i < 12; i++) {
    const x = lx(between(.05, .84));
    ctx.save(); ctx.clip(west);
    pencilLine([[x, cliffTop + between(35, 90)], [x - 7, cliffTop + 164], [x + between(-17, 5), 421]], '#b28067', .9, 1); ctx.restore();
  }
  const eastX = compact ? right - 50 : 1250, eastWidth = compact ? 230 : 420;
  const ex = f => eastX + eastWidth * f;
  const eastTop = compact ? 225 : 216;
  const east = new Path2D();
  east.moveTo(ex(-.18), 447); east.lineTo(ex(.04), eastTop + 82); east.lineTo(ex(.1), eastTop + 12);
  east.lineTo(ex(.28), eastTop - 4); east.lineTo(ex(.44), eastTop + 19); east.lineTo(ex(.59), eastTop - 65);
  east.lineTo(ex(.77), eastTop - 70); east.lineTo(ex(.86), eastTop - 10); east.lineTo(ex(1.1), eastTop + 15); east.lineTo(ex(1.1), 470); east.closePath();
  // A sea arch: the water remains visible through the rock.
  east.moveTo(ex(.12), 450); east.lineTo(ex(.14), eastTop + 148);
  east.bezierCurveTo(ex(.15), eastTop + 91, ex(.38), eastTop + 91, ex(.41), eastTop + 147);
  east.lineTo(ex(.48), 452); east.closePath();
  ctx.save(); ctx.fillStyle = '#bbad92'; ctx.fill(east, 'evenodd'); ctx.clip(east, 'evenodd');
  ctx.fillStyle = grain; ctx.fillRect(0, 0, 1600, 550);
  for (let i = 0; i < 45; i++) {
    const x = ex(between(0, 1));
    pencilLine([[x, eastTop - 60], [x - 10, eastTop + 80], [x - 24, 468]], '#908f7d', .9, 1);
  } ctx.restore();
  shade(path([[ex(.44), eastTop + 19], [ex(.59), eastTop - 65], [ex(.77), eastTop - 70], [ex(.67), eastTop - 51], [ex(.56), eastTop - 44]]), '#759580', false);

  // A few tiny distant details let the sea read at the scale of the houses.
  for (const [x, y, s] of [[compact ? left + 127 : 457, 337, .75], [1080, 349, .6]]) {
    shade(path([[x - 12 * s, y], [x + 13 * s, y], [x + 7 * s, y + 4 * s], [x - 7 * s, y + 4 * s]]), C.red, false);
    pencilLine([[x, y], [x, y - 26 * s]], '#6c8175', .8, 1);
    shade(path([[x - 2 * s, y - 24 * s], [x - 2 * s, y - 4 * s], [x - 15 * s, y - 4 * s]]), '#f6ecd3', false);
  }
  for (const [x, y, s] of [[413, 134, 7], [438, 122, 5], [1169, 92, 6], [1187, 108, 4]]) {
    pencilLine([[x - s, y], [x - s * .35, y - 2], [x, y + 2], [x + s * .4, y - 2], [x + s, y]], '#8e8e77', .9, 1);
  }

  // Air and haze behind the real HTML text, rather than a hard-edged text box.
  const haze = ctx.createRadialGradient(800, 113, 125, 800, 138, compact ? 355 : 466);
  haze.addColorStop(0, 'rgba(247,245,239,.98)');
  haze.addColorStop(.48, 'rgba(247,245,239,.79)');
  haze.addColorStop(1, 'rgba(247,245,239,0)');
  ctx.fillStyle = haze; ctx.fillRect(0, 0, 1600, 550);
}

function draw() {
  stopMotion();
  seed = 37;
  const bounds = canvas.getBoundingClientRect();
  const { width, height } = bounds;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  shapeSurface.width = canvas.width; shapeSurface.height = canvas.height;
  shapeIndex = 0; shapeGroup = null;
  shapeContext.fillStyle = "rgb(64,64,0)"; shapeContext.fillRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, width, height);
  const skyPadding = 76;
  const scale = Math.max(width / 1600, (height - skyPadding) / 1000);
  ctx.translate((width - 1600 * scale) / 2, skyPadding); ctx.scale(scale, scale);
  const texture = document.createElement('canvas'); texture.width = 160; texture.height = 160;
  const t = texture.getContext('2d');
  for (let i = 0; i < 2700; i++) {
    const x = between(0, 160), y = between(0, 160);
    t.strokeStyle = i % 5 ? `rgba(247,245,239,${between(.12,.45)})` : 'rgba(49,65,40,.12)';
    t.lineWidth = between(.4,1.1); t.beginPath(); t.moveTo(x,y); t.lineTo(x+between(1,5),y-between(1,3)); t.stroke();
  }
  grain = ctx.createPattern(texture, 'repeat');
  // Give the backdrop its own random sequence so adding detail never changes
  // the approved houses, trees, players, or their pencil marks.
  const foregroundSeed = seed;
  coastline(width / scale);
  seed = foregroundSeed;
  // Leave a clear pocket of sky between the demo link and the rooftops.
  ctx.save(); ctx.translate(0, 45); ctx.scale(1, .95);
  const land = new Path2D('M-80 532 Q200 415 442 450 Q820 376 1170 453 Q1370 454 1680 544 L1680 1000 L-80 1000 Z');
  shade(land, '#c7cba1', false);
  // Houses are tucked among trees, on the far side of the ballpark.
  for (const [x,g,s] of [[56,510,220],[188,468,180],[331,466,260],[486,444,179],[650,439,165],[946,447,172],[1145,461,250],[1286,494,196],[1470,537,274]]) tree(x,g,s);
  house(119, 485, 114, 108, C.cream, C.red, 'cottage');
  house(368, 458, 93, 125, C.yellow, C.dark, 'balcony');
  house(548, 446, 132, 81, C.cream, C.dark, 'bungalow');
  house(724, 439, 111, 138, C.red, C.dark, 'townhouse');
  house(911, 450, 101, 99, C.yellow, C.red, 'terrace');
  house(1052, 462, 130, 114, C.cream, C.red, 'villa');
  house(1298, 500, 121, 100, C.yellow, C.dark, 'studio');
  const neighborhoodSeed = seed;
  storefront(724, 439, 111);
  rooftopSolar();
  seed = neighborhoodSeed;
  tree(272, 502, 196, C.dark); tree(506, 467, 119); tree(875, 455, 153, C.dark); tree(1225, 490, 162);
  for (let x = 70; x < 1550; x += between(29,55)) shrub(x, 476 + Math.pow((x-800)/800,2)*83, between(21,38), between(14,29));
  // The outfield is broad, green, and ringed by a wooden fence.
  const outfield = new Path2D('M50 571 Q802 361 1555 579 L1505 858 Q826 1012 95 860 Z');
  shade(outfield, '#7f9e60', false);
  ctx.save(); ctx.clip(outfield);
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = .12; ctx.fillStyle = i % 2 ? C.dark : C.yellow;
    ctx.beginPath(); ctx.moveTo(805, 905); ctx.lineTo(-150 + i * 310, 398); ctx.lineTo(160 + i * 310, 398); ctx.closePath(); ctx.fill();
  } ctx.restore();
  hatching(outfield, [30,450,1530,510], C.dark, 3400); fence();
  pencilLine([[256, 511],[256,322]], C.ink, 2.4);
  pencilLine([[1320, 522],[1320,327]], C.ink, 2.4);
  shade(path([[1155, 435],[1240, 446],[1240, 486],[1155, 476]]), C.dark);
  pencilLine([[1164,456],[1230,465]], C.cream, .8);
  for (let i = 0; i < 5; i++) pencilLine([[1168+i*13,449+i*1.5],[1168+i*13,470+i*1.5]], C.cream, .65);
  // Team benches sit in foul territory, clear of the chalk and live play.
  bench(230, 720, 1, C.cream, 1); bench(1260, 740, 1, C.red, -1);
  // Infield and chalk: a diamond in perspective, with a small neighborhood game.
  const dirt = new Path2D('M796 896 C659 835 483 755 425 679 Q492 545 801 532 Q1080 543 1176 687 C1101 782 921 854 796 896 Z');
  shade(dirt, '#d4a068', false); hatching(dirt,[420,530,760,370],'#966c47',1700);
  const diamond = path([[797, 819],[558, 686],[800, 569],[1048, 693]]);
  shade(diamond, '#86a269', false); hatching(diamond,[540,566,520,270],C.dark,680);
  const bases = [[797,837],[537,687],[800,554],[1068,695]];
  pencilLine([[-80,505],bases[0],[1660,501]], C.cream, 3.5, 3);
  pencilLine([bases[0],bases[1],bases[2],bases[3],bases[0]], C.cream, 2.1, 2);
  shade(oval(800,695,35,16), '#d4a068', false); hatching(oval(800,695,35,16),[765,679,70,32],'#966c47',100);
  pencilLine([[792,693],[810,694]], C.cream, 4);
  for (const [x,y] of bases.slice(1)) shade(path([[x-8,y],[x,y-4],[x+8,y],[x,y+4]]), C.paper, false);
  shade(path([[790,833],[805,833],[805,840],[797,845],[790,840]]), C.paper, false);
  pencilLine([[769,827],[756,827],[756,849],[769,849]], C.cream, 1.9);
  pencilLine([[826,829],[839,829],[839,851],[826,851]], C.cream, 1.9);
  players = [[800,687,C.red,.85,0], [770,841,C.cream,1.02,1],
    [1083,691,C.red,.78,0], [572,661,C.red,.72,0], [794,552,C.cream,.63,0],
    [523,554,C.red,.64,0], [1120,578,C.red,.64,0]].map(([x,y,color,size,pose], index) => {
      // Cache each pencil drawing once; motion never regenerates its texture.
      const sprite = document.createElement('canvas');
      sprite.width = Math.ceil(64 * dpr * scale); sprite.height = Math.ceil(80 * dpr * scale);
      const mainContext = ctx;
      ctx = sprite.getContext('2d');
      ctx.scale(dpr * scale, dpr * scale);
      player(24,64,color,size,pose);
      ctx = mainContext;
      return { sprite, x, y, phase: index * 2.37 };
    });
  // Keep the two little shared assets beyond the foul lines. Bring them into
  // the narrow crop on phones without shifting the game or its benches.
  const visibleWidth = width / scale, compact = visibleWidth < 900;
  const left = (1600 - visibleWidth) / 2, right = 1600 - left;
  const assetSeed = seed;
  tractor(compact ? left + 14 : 366, compact ? 810 : 743, compact ? .76 : .84);
  coffeeSaucer(compact ? right - 117 : 1161, compact ? 817 : 755, compact ? .74 : .84);
  seed = assetSeed;
  // Foreground foliage frames the field. Its edges fade into warm paper.
  tree(35,849,356,C.dark); tree(1528,889,392,C.dark);
  shrub(90,930,186,83,C.green); shrub(1450,940,180,87,C.green);
  hatching(land,[0,880,1600,110],C.green,800);
  ctx.restore();
  const fade = ctx.createLinearGradient(0,909,0,983);
  fade.addColorStop(0,'rgba(247,245,239,0)'); fade.addColorStop(1,C.paper);
  ctx.fillStyle = fade; ctx.fillRect(0,909,1600,91);
  still.width = canvas.width; still.height = canvas.height;
  stillContext.drawImage(canvas, 0, 0);
  const offset = (width - 1600 * scale) / 2;
  scene = {
    dpr, scale, offset, visibleWidth, compact,
    textRects: protectedTextRects(bounds, scale, offset),
    saucer: { x: compact ? right - 117 : 1161, y: compact ? 817 : 755, scale: compact ? .74 : .84 },
  };
  paintScene(0);
  stillContext.setTransform(1,0,0,1,0,0);
  stillContext.drawImage(canvas,0,0);
  prepareColorDrift();
  paintMotion(motionTime);
  canvas.dataset.ready = 'true';
  syncMotion();
}

function scheduleDraw() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(draw);
}
const resize = new ResizeObserver(scheduleDraw);
resize.observe(canvas);
window.addEventListener('resize', scheduleDraw);
document.addEventListener('visibilitychange', syncMotion);
reducedMotion.addEventListener('change', syncMotion);
paceSlider.addEventListener('input', () => {
  colorPace = Number(paceSlider.value); paceOutput.textContent = `${colorPace}×`;
  try { localStorage.setItem('homerun:color-pace', String(colorPace)); } catch {}
});
modeSelect.addEventListener('change', () => {
  colorMode = modeSelect.value;
  try { localStorage.setItem('homerun:color-mode', colorMode); } catch {}
  paintMotion(motionTime);
});
groupingSlider.addEventListener('input', () => {
  colorGrouping = Number(groupingSlider.value); groupingOutput.textContent = String(colorGrouping);
  try { localStorage.setItem('homerun:color-grouping', String(colorGrouping)); } catch {}
  paintMotion(motionTime);
});
intensitySlider.addEventListener('input', () => {
  colorIntensity = Number(intensitySlider.value);
  intensityOutput.textContent = String(colorIntensity);
  try { localStorage.setItem('homerun:color-intensity', String(colorIntensity)); } catch { /* Optional persistence. */ }
  paintMotion(motionTime);
});
motionToggle?.addEventListener('click', () => {
  if (reducedMotion.matches && !motionRequested) { motionRequested = true; motionPaused = false; }
  else motionPaused = !motionPaused;
  syncMotion();
});
window.addEventListener('pagehide', () => { pageActive = false; syncMotion(); });
window.addEventListener('pageshow', () => { pageActive = true; syncMotion(); });
const visibility = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; syncMotion(); });
visibility.observe(canvas);
let resolution;
function watchResolution() {
  resolution?.removeEventListener('change', resolutionChanged);
  resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  resolution.addEventListener('change', resolutionChanged, { once: true });
}
function resolutionChanged() { watchResolution(); scheduleDraw(); }
watchResolution();
draw();
document.fonts?.ready.then(() => {
  if (!scene) return;
  scene.textRects = protectedTextRects(canvas.getBoundingClientRect(), scene.scale, scene.offset);
  if (reducedMotion.matches && !motionRequested) paintMotion(0);
});
