// Small, repeatable pencil drawings for the create flow. The caller owns resize.
export function drawAssetSketch(canvas, type = 'real-estate') {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width || 320;
  const height = bounds.height || 160;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width / 320, height / 160);
  ctx.translate((width - 320 * scale) / 2, (height - 160 * scale) / 2);
  ctx.scale(scale, scale);

  const C = {
    paper: '#f7f5ef', green: '#38694b', ochre: '#dcb66d', rust: '#bd7555',
    ink: '#42604d', pale: '#e9dfbd', sage: '#a8b794', glass: '#86a7a1',
  };
  let seed = 319;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const between = (a, b) => a + rand() * (b - a);
  const polygon = points => {
    const path = new Path2D();
    points.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
    path.closePath();
    return path;
  };
  const oval = (x, y, rx, ry) => {
    const path = new Path2D();
    path.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    return path;
  };
  const line = (points, color = C.ink, weight = .85) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalAlpha = pass ? .24 : .7;
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const jx = between(-.42, .42), jy = between(-.42, .42);
        i ? ctx.lineTo(x + jx, y + jy) : ctx.moveTo(x + jx, y + jy);
      });
      ctx.stroke();
    }
    ctx.restore();
  };
  const shade = (path, color, hatch = C.paper) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.clip(path);
    ctx.lineWidth = .7;
    // Short broken marks retain paper between the coloured-pencil strokes.
    for (let i = 0; i < 660; i++) {
      const x = between(65, 258), y = between(15, 146), len = between(2, 7);
      ctx.strokeStyle = i % 4 ? hatch : C.ink;
      ctx.globalAlpha = i % 4 ? .26 : .12;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y - len * .58);
      ctx.stroke();
    }
    ctx.restore();
  };
  const face = (points, color, outline = true) => {
    shade(polygon(points), color);
    if (outline) line([...points, points[0]], C.ink, .7);
  };
  const windowAt = (x, y, w, h) => {
    face([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], C.glass);
    line([[x + w / 2, y], [x + w / 2, y + h]], C.paper, 1.4);
    line([[x, y + h / 2], [x + w, y + h / 2]], C.paper, 1.2);
    line([[x - 2, y + h + 1], [x + w + 2, y + h + 1]], C.paper, 2);
  };
  const shrub = (x, y, size = 10) => {
    shade(oval(x - size * .4, y, size * .65, size * .65), C.sage);
    shade(oval(x + size * .3, y - size * .3, size * .65, size * .8), C.green);
    line([[x - size, y + size * .55], [x + size, y + size * .55]], C.ink, .7);
  };

  ctx.save();
  for (let i = 0; i < 5; i++) {
    ctx.globalAlpha = .022 + i * .009;
    ctx.fillStyle = C.green;
    ctx.fill(oval(162, 137, 84 - i * 9, 8 - i));
  }
  ctx.restore();
  line([[75, 138], [133, 139], [190, 138], [247, 139]], C.sage, .7);

  if (type === 'business') {
    face([[218, 47], [235, 60], [235, 131], [218, 136]], C.rust);
    face([[99, 47], [218, 47], [218, 136], [99, 136]], C.pale);
    face([[94, 40], [221, 40], [225, 49], [95, 49]], C.green);
    windowAt(110, 56, 36, 18);
    windowAt(169, 56, 36, 18);
    face([[148, 94], [169, 94], [169, 136], [148, 136]], C.green);
    windowAt(152, 99, 13, 22);
    windowAt(106, 98, 33, 27);
    windowAt(177, 98, 33, 27);
    for (let i = 0; i < 8; i++) {
      const x = 95 + i * 16;
      face([[x + 4, 79], [x + 19, 79], [x + 16, 94], [x, 94]], i % 2 ? C.pale : C.ochre, false);
      shade(oval(x + 8, 94, 8, 3.5), i % 2 ? C.pale : C.ochre);
    }
    line([[99, 79], [227, 79]], C.ink);
    shrub(96, 133, 8);
    shrub(224, 133, 7);
  } else if (type === 'equipment') {
    // A compact work tractor, with a cab and generous hand-drawn wheels.
    face([[117, 84], [204, 84], [220, 101], [217, 117], [119, 117]], C.green);
    face([[139, 47], [172, 47], [188, 91], [138, 91]], C.pale);
    face([[145, 53], [168, 53], [177, 80], [145, 80]], C.glass);
    line([[158, 53], [158, 80]], C.pale, 2);
    face([[133, 43], [175, 43], [179, 49], [131, 49]], C.rust);
    face([[199, 86], [199, 65], [204, 65], [204, 86]], C.ink);
    face([[178, 86], [214, 88], [223, 105], [176, 105]], C.ochre);
    line([[214, 94], [218, 102]], C.ink, 1.4);
    line([[182, 94], [197, 94]], C.rust, 1.3);
    line([[108, 111], [88, 111], [85, 121]], C.ink, 3);
    face([[101, 101], [121, 97], [143, 100], [144, 107], [104, 107]], C.green);
    for (const [x, y, r] of [[124, 116, 23], [204, 122, 16]]) {
      shade(oval(x, y, r, r), C.ink);
      shade(oval(x, y, r * .58, r * .58), C.ochre);
      shade(oval(x, y, 3, 3), C.rust);
      for (let a = 0; a < 12; a++) {
        const angle = a / 12 * Math.PI * 2;
        line([[x + Math.cos(angle) * r * .79, y + Math.sin(angle) * r * .79],
          [x + Math.cos(angle + .13) * r * .96, y + Math.sin(angle + .13) * r * .96]], C.sage, 1.3);
      }
    }
  } else if (type === 'energy') {
    face([[205, 134], [211, 48], [214, 48], [219, 134]], C.pale);
    const hub = [212, 48];
    for (let a = 0; a < 3; a++) {
      const angle = a * Math.PI * 2 / 3 - Math.PI / 2;
      const tip = [hub[0] + Math.cos(angle) * 36, hub[1] + Math.sin(angle) * 36];
      const wing = [hub[0] + Math.cos(angle + .22) * 20, hub[1] + Math.sin(angle + .22) * 20];
      face([hub, wing, tip], C.pale);
    }
    shade(oval(...hub, 4, 4), C.ochre);
    for (const x of [97, 146]) {
      line([[x + 6, 116], [x + 6, 135]], C.ink, 2);
      line([[x + 42, 115], [x + 42, 135]], C.ink, 2);
      face([[x + 10, 86], [x + 55, 86], [x + 45, 122], [x, 122]], C.green);
      for (let row = 1; row < 3; row++) line([[x + 10 - row * 10 / 3, 86 + row * 12], [x + 55 - row * 10 / 3, 86 + row * 12]], C.glass, 1);
      for (let col = 1; col < 3; col++) line([[x + 10 + col * 15, 86], [x + col * 15, 122]], C.glass, 1);
    }
    shrub(224, 135, 6);
  } else if (type === 'other') {
    // A roadside coffee saucer, ready to serve this planet's morning commuters.
    for (const [x, y, footX, footY] of [[118, 110, 106, 134], [160, 116, 161, 137], [204, 110, 217, 133]]) {
      line([[x, y], [footX, footY]], C.ink, 3.5);
      face([[footX - 8, footY - 1], [footX + 7, footY - 1], [footX + 10, footY + 3], [footX - 10, footY + 3]], C.green, false);
    }
    shade(oval(161, 98, 69, 22), C.rust);
    shade(oval(161, 87, 76, 22), C.ochre);
    line([[94, 97], [121, 107], [161, 110], [202, 106], [230, 96]], C.pale, 2);
    const dome = new Path2D();
    dome.moveTo(115, 79);
    dome.bezierCurveTo(113, 51, 130, 30, 160, 29);
    dome.bezierCurveTo(189, 29, 208, 52, 206, 79);
    dome.closePath();
    shade(dome, C.glass);
    line([[122, 58], [132, 42], [146, 36]], C.paper, 1.8);
    line([[160, 28], [160, 20]], C.ink, 1.3);
    shade(oval(160, 18, 3, 3), C.rust);
    // The proprietor is visible above the serving hatch.
    shade(oval(161, 61, 12, 14), C.sage);
    face([[151, 72], [171, 72], [177, 86], [145, 86]], C.green, false);
    shade(oval(156, 60, 2.4, 3.6), C.ink);
    shade(oval(166, 60, 2.4, 3.6), C.ink);
    line([[158, 68], [163, 68]], C.ink, .8);
    face([[125, 91], [194, 91], [194, 104], [125, 104]], C.pale);
    for (let n = 0; n < 6; n++) {
      const x = 126 + n * 11;
      face([[x + 3, 76], [x + 14, 76], [x + 11, 88], [x, 88]], n % 2 ? C.paper : C.rust, false);
    }
    line([[127, 88], [127, 99]], C.ink, 1.3);
    line([[192, 88], [192, 99]], C.ink, 1.3);
    line([[122, 100], [197, 100]], C.ink, 2.2);
    face([[177, 91], [185, 91], [184, 97], [178, 97]], C.paper, false);
    line([[185, 92], [189, 92], [188, 95], [185, 95]], C.paper, 1.1);
    line([[180, 88], [179, 86]], C.paper, .8);
    for (const x of [105, 216]) shade(oval(x, 88, 4, 2.5), C.paper);
  } else {
    // The homepage's yellow coastal house, with its planted roof terrace.
    face([[207, 48], [227, 62], [227, 131], [207, 137]], C.rust);
    face([[103, 48], [207, 48], [207, 137], [103, 137]], C.ochre);
    face([[99, 42], [210, 42], [231, 55], [231, 62], [210, 49], [99, 49]], C.paper);
    face([[166, 22], [203, 22], [203, 42], [166, 42]], C.ochre);
    face([[203, 22], [220, 33], [220, 48], [203, 42]], C.rust);
    face([[163, 20], [205, 20], [223, 31], [222, 35], [204, 25], [163, 25]], C.paper, false);
    // Low railings and planters leave the little rooftop room in view.
    shrub(115, 42, 5);
    shrub(147, 43, 5);
    for (let x = 108; x <= 157; x += 8) line([[x, 31], [x, 45]], C.ink, .9);
    line([[106, 31], [158, 31]], C.ink, 1.4);
    line([[106, 37], [158, 37]], C.ink, .75);
    windowAt(116, 62, 29, 24);
    windowAt(165, 62, 29, 24);
    face([[118, 100], [138, 100], [138, 137], [118, 137]], C.green);
    line([[133, 120], [133, 123]], C.ochre, 1.6);
    windowAt(153, 105, 40, 24);
    for (let n = 0; n < 6; n++) {
      const x = 147 + n * 9;
      face([[x + 2, 97], [x + 11, 97], [x + 12, 106], [x, 106]], n % 2 ? C.paper : C.rust, false);
    }
    line([[149, 97], [203, 97]], C.ink, .65);
    face([[111, 136], [144, 136], [150, 142], [106, 142]], C.pale, false);
    shrub(211, 134, 7);
  }
}
