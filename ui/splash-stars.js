'use strict';

// ---------------------------------------------------------------------------
// The opening: a sky of flickering stars that gathers into the app's name.
//
// The name is not a picture drawn on top of the stars — it is where the stars
// land. The word "Lyra PoS" is laid out on an offscreen canvas, its lit pixels
// are sampled, and every sample becomes a star's destination. The stars start
// scattered across the window, twinkle in place for a beat, then travel along
// soft arcs into the letters, where they keep flickering.
//
// Three rules, the same ones the sky behind the till follows:
//
//   1. It is cheap. Stars are pre-rendered sprites stamped with drawImage;
//      nothing allocates inside the frame loop, and the loop stops the moment
//      the splash is skipped, finished or the window is hidden.
//   2. It is short. Three seconds at most. Any key, click or touch ends it at
//      once, and reduced motion gets a still, already-assembled word for less
//      than a second.
//   3. It is optional. Setup offers Star assembly, Classic or Off. Off never
//      starts a frame; the splash stays in the page only so Preview can use it.
//
// Public surface, installed on window when this file loads:
//
//   LyraSplash.applyStyle('stars' | 'classic' | 'off' | 'preview')
//   LyraSplash.preview()
//   LyraSplash.finish()
// ---------------------------------------------------------------------------

(() => {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;

  const canvas = document.getElementById('splashStars');
  let classic = document.getElementById('splashClassic');
  const sub = document.getElementById('splashNewSub');
  const hint = document.getElementById('splashHint');
  if (!canvas || !classic) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  const STYLES = ['stars', 'classic', 'off'];
  const NAME = 'Lyra PoS';
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let motionOff = false;
  const wantsStill = () => motionOff || !!(motionQuery && motionQuery.matches);

  const TIMING = {
    ambient: 240,       // scattered stars flicker on their own for this long
    travel: 1250,       // the slowest star's flight, from its own first frame
    stagger: 220,       // the spread of departure times across the word
    settle: 1600,       // when the word is complete and the subtitle arrives
    leaveAt: 2900,      // the whole layer starts fading
    removeAt: 3350
  };

  let style = 'stars';
  let running = false;
  let rafId = 0;
  let startedAt = 0;
  let lastFrame = 0;
  let leaveTimer = 0;
  let removeTimer = 0;
  let finishTimer = 0;
  let keyHandler = null;
  let pointerHandler = null;
  let particles = [];
  let links = [];
  let sprites = null;
  let layout = null;
  let accent = null;

  const FRAME_MS = 1000 / 60;
  const DPR_CAP = 1.75;

  // ---------------------------------------------------------------------------
  // Colour: the word takes its light from the app's own accent, read from the
  // theme tokens the stylesheet already provides. The fallbacks are Lyra's cyan
  // and violet, so the sequence looks right on a first run too.
  // ---------------------------------------------------------------------------
  function toRgbString(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
      const hex = raw.length === 4
        ? raw.slice(1).split('').map(c => c + c).join('')
        : raw.slice(1);
      return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    }
    const rgb = raw.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (rgb) return rgb.slice(1, 4).join(', ');
    return fallback;
  }

  function readAccent() {
    const read = (name, fallback) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };
    const cool = toRgbString(read('--blue-bright-rgb', '127, 176, 255'), '127, 176, 255');
    const warm = toRgbString(read('--cyan', '#6FE0E2'), '111, 224, 226');
    const violet = toRgbString(read('--violet', '#9D8CFF'), '157, 140, 255');
    return { cool, warm, violet };
  }

  function makeSprite(rgb) {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(' + rgb + ',1)');
    grad.addColorStop(0.24, 'rgba(' + rgb + ',0.66)');
    grad.addColorStop(0.58, 'rgba(' + rgb + ',0.14)');
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function ensureSprites() {
    const a = readAccent();
    if (sprites && accent && accent.cool === a.cool && accent.warm === a.warm && accent.violet === a.violet) return;
    accent = a;
    sprites = {
      cool: makeSprite(a.cool),
      warm: makeSprite(a.warm),
      violet: makeSprite(a.violet)
    };
  }

  // ---------------------------------------------------------------------------
  // The word, sampled into destinations.
  // ---------------------------------------------------------------------------
  function buildLayout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Same budget as the sky: the opening lasts three seconds, but a 4K window
    // at scale 2 should never ask for a 33-megapixel canvas even for that.
    const budget = Math.max(0.75, Math.sqrt(8000000 / Math.max(1, w * h)));
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1, budget);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const size = Math.max(48, Math.min(148, Math.floor(Math.min(w * 0.121, h * 0.202))));
    const font = '600 ' + size + 'px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
    const probe = document.createElement('canvas');
    const pg = probe.getContext('2d');
    if (!pg) return null;

    pg.font = font;
    if ('letterSpacing' in pg) pg.letterSpacing = Math.round(size * 0.035) + 'px';
    const measured = pg.measureText(NAME);
    const padding = Math.ceil(size * 0.45);
    const width = Math.ceil(measured.width + padding * 2);
    const height = Math.ceil(size * 1.55);
    probe.width = Math.max(1, width);
    probe.height = Math.max(1, height);
    const g = probe.getContext('2d');
    if (!g) return null;
    g.font = font;
    if ('letterSpacing' in g) g.letterSpacing = Math.round(size * 0.035) + 'px';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#FFFFFF';
    g.fillText(NAME, width / 2, height / 2);

    const data = g.getImageData(0, 0, width, height).data;
    const step = Math.max(4, Math.round(size / 22));
    const points = [];
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 140) points.push({ x: x - width / 2, y: y - height / 2 });
      }
    }
    // The sampled pixels are copied; the canvas behind them can go now rather
    // than waiting for the collector.
    probe.width = 1;
    probe.height = 1;

    // A word is ~35% of its bounding box, so this stays in the hundreds rather
    // than the thousands. On a very large window the sampling step grows with
    // the type and the count stays bounded.
    const maxParticles = w * h > 1200000 ? 900 : 700;
    if (points.length > maxParticles) {
      for (let i = points.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = points[i]; points[i] = points[j]; points[j] = t;
      }
      points.length = maxParticles;
    }

    // Anchor a few pairs of neighbours into hairlines, so the assembled word
    // reads as a constellation rather than a swarm. The pairs are found once,
    // here, never in the frame loop.
    const anchors = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const candidateLinks = [];
    for (let i = 0; i < anchors.length; i += 3) {
      for (let j = i + 1; j < Math.min(anchors.length, i + 5); j++) {
        const dx = anchors[j].x - anchors[i].x;
        const dy = anchors[j].y - anchors[i].y;
        if (dx * dx + dy * dy < (step * 3.2) * (step * 3.2)) candidateLinks.push([i, j]);
      }
    }
    const chosenLinks = [];
    const stride = Math.max(1, Math.floor(candidateLinks.length / 90));
    for (let i = 0; i < candidateLinks.length && chosenLinks.length < 110; i += stride) {
      chosenLinks.push(candidateLinks[i]);
    }

    const centerX = w / 2;
    const centerY = h * 0.415;

    return {
      w, h, size, width, height, step,
      centerX, centerY,
      points: points.map(p => ({ x: centerX + p.x, y: centerY + p.y })),
      links: chosenLinks.map(([i, j]) => {
        const a = anchors[i];
        const b = anchors[j];
        return {
          ax: centerX + a.x, ay: centerY + a.y,
          bx: centerX + b.x, by: centerY + b.y
        };
      })
    };
  }

  // ---------------------------------------------------------------------------
  // The particles: scattered, twinkling, then each one bound for its pixel.
  // ---------------------------------------------------------------------------
  function buildParticles(layout) {
    const w = layout.w;
    const h = layout.h;
    const points = layout.points;
    const total = points.length;
    const now = performance.now();
    particles = new Array(total);

    for (let i = 0; i < total; i++) {
      const p = points[i];
      // Start spread across the whole window, biased a little away from the
      // middle so the arrival has somewhere to travel from.
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.max(w, h) * (0.34 + Math.random() * 0.62);
      let sx = w / 2 + Math.cos(angle) * radius;
      let sy = h * 0.46 + Math.sin(angle) * radius * 0.72;
      if (sx < -20) sx = w + 20 - Math.random() * 80;
      if (sx > w + 20) sx = -20 + Math.random() * 80;
      if (sy < -20) sy = h + 20 - Math.random() * 80;
      if (sy > h + 20) sy = -20 + Math.random() * 80;

      const leftness = Math.min(1, Math.max(0, (p.x - layout.centerX + layout.width / 2) / Math.max(1, layout.width)));
      const delay = TIMING.ambient + leftness * TIMING.stagger + Math.random() * 160;
      const duration = 640 + Math.random() * 430;

      particles[i] = {
        begin: { x: sx, y: sy },
        end: { x: p.x, y: p.y },
        startAt: now + delay,
        duration,
        // A gentle sideways arc rather than a straight line: the stars look
        // like they are being drawn in, not pulled by a magnet.
        bend: (Math.random() - 0.5) * (0.1 + Math.random() * 0.18),
        phase: Math.random() * Math.PI * 2,
        speed: 0.0009 + Math.random() * 0.0018,
        r: 0.62 + Math.random() * 1.35,
        warm: Math.random() < 0.12,
        violet: Math.random() < 0.1,
        alpha: 0.5 + Math.random() * 0.5,
        arrived: 0
      };
    }
  }

  function reset() {
    clearTimeout(leaveTimer);
    clearTimeout(removeTimer);
    clearTimeout(finishTimer);
    cancelAnimationFrame(rafId);
    rafId = 0;
    running = false;
    if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
    if (pointerHandler) window.removeEventListener('pointerdown', pointerHandler, true);
    keyHandler = null;
    pointerHandler = null;
    particles = [];
    links = [];
    layout = null;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function stamp(sprite, x, y, r, alpha) {
    if (!sprite || alpha <= 0.002) return;
    const size = r * 4;
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  function drawWordLinks(now, settle) {
    if (!layout || !layout.links.length || settle <= 0) return;
    const breathe = 0.5 + 0.5 * Math.sin(now * 0.0012);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(' + accent.cool + ',' + (0.12 * settle * (0.55 + breathe * 0.45)).toFixed(3) + ')';
    ctx.beginPath();
    for (let i = 0; i < layout.links.length; i++) {
      const l = layout.links[i];
      // Lines appear once their two ends are likely to have arrived.
      ctx.moveTo(l.ax, l.ay);
      ctx.lineTo(l.bx, l.by);
    }
    ctx.stroke();
  }

  function draw(now) {
    if (!layout || !sprites) return;
    ctx.clearRect(0, 0, layout.w, layout.h);

    const settleAt = startedAt + TIMING.settle;
    const settle = Math.min(1, Math.max(0, (now - settleAt) / 520));

    drawWordLinks(now, settle);

    let arrived = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const t = (now - p.startAt) / p.duration;
      let x, y, alpha, r;

      if (t <= 0) {
        // Waiting its turn: still a star in the sky, twinkling.
        x = p.begin.x;
        y = p.begin.y;
        const tw = 0.55 + 0.45 * Math.sin(p.phase + now * p.speed);
        alpha = p.alpha * 0.72 * tw;
        r = p.r * (0.85 + 0.15 * tw);
      } else if (t < 1) {
        const e = easeOutCubic(t);
        const dx = p.end.x - p.begin.x;
        const dy = p.end.y - p.begin.y;
        const nx = -dy;
        const ny = dx;
        const arc = Math.sin(Math.PI * e) * p.bend * 90;
        x = p.begin.x + dx * e + nx * arc * 0.03;
        y = p.begin.y + dy * e + ny * arc * 0.03;
        // Bright while travelling, with a short fading trail behind it.
        alpha = p.alpha * (0.72 + 0.28 * Math.sin(Math.PI * t));
        r = p.r * (1 + 0.35 * Math.sin(Math.PI * t));
        const tail = Math.min(1, 0.35 + e);
        stamp(p.warm ? sprites.warm : p.violet ? sprites.violet : sprites.cool,
          x, y, r * 4.6, alpha * 0.16 * tail);
      } else {
        arrived++;
        const tw = 0.62 + 0.38 * Math.sin(p.phase + now * p.speed * 1.4);
        x = p.end.x;
        y = p.end.y;
        alpha = p.alpha * (0.78 + 0.22 * tw);
        r = p.r * (0.9 + 0.1 * tw);
      }

      stamp(p.warm ? sprites.warm : p.violet ? sprites.violet : sprites.cool, x, y, r * 3.6, alpha);

      // A hard core on the brightest few: without it the stars read as dust.
      if (i % 3 === 0) {
        ctx.globalAlpha = Math.min(1, alpha * 0.9);
        ctx.fillStyle = p.warm ? '#FFE7C9' : '#F4F8FF';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.55, p.r * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // A band of light crosses the finished word once, then leaves it alone.
    if (settle > 0) {
      const band = Math.max(0, Math.min(1, (now - settleAt - 260) / 620));
      if (band > 0 && band < 1) {
        const x = layout.centerX - layout.width / 2 + layout.width * band;
        const grad = ctx.createLinearGradient(x - 90, 0, x + 90, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, 'rgba(255,255,255,' + (0.16 * Math.sin(Math.PI * band)).toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.fillRect(x - 90, layout.centerY - layout.size * 0.8, 180, layout.size * 1.6);
      }

      // The underline, drawn out from the middle.
      const line = Math.min(1, Math.max(0, (now - settleAt - 180) / 760));
      if (line > 0) {
        const half = (layout.width * 0.31) * easeOutCubic(line);
        const y = layout.centerY + layout.size * 0.72;
        const grad = ctx.createLinearGradient(layout.centerX - half, y, layout.centerX + half, y);
        grad.addColorStop(0, 'rgba(' + accent.cool + ',0)');
        grad.addColorStop(0.5, 'rgba(' + accent.cool + ',' + (0.72 * line).toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(' + accent.cool + ',0)');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(layout.centerX - half, y);
        ctx.lineTo(layout.centerX + half, y);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    draw(now);
  }

  function showSubtitle() {
    if (sub) sub.classList.add('in');
    if (hint) hint.classList.add('dim');
  }

  function armSkip() {
    keyHandler = (e) => {
      // Modifier keys alone should not skip, but any real keystroke should.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      finish();
    };
    pointerHandler = () => finish();
    window.addEventListener('keydown', keyHandler, true);
    window.addEventListener('pointerdown', pointerHandler, true);
  }

  function hideLayer() {
    splash.classList.add('hide');
    splash.dataset.state = 'done';
    if (hint) hint.classList.remove('dim');
    if (sub) sub.classList.remove('in');
    classic.setAttribute('hidden', '');
    canvas.style.display = 'none';
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1, 1); } catch (err) { /* nothing to clear */ }
    canvas.width = 1;
    canvas.height = 1;
  }

  function finish() {
    if (!running && splash.dataset.state === 'done') return;
    reset();
    running = false;
    hideLayer();
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  function startStars() {
    reset();
    style = 'stars';
    splash.dataset.state = 'running';
    splash.dataset.style = 'stars';
    splash.classList.remove('hide');
    classic.setAttribute('hidden', '');
    canvas.style.display = '';
    if (sub) sub.classList.remove('in');
    if (hint) {
      hint.classList.remove('dim');
      hint.textContent = wantsStill() ? '' : 'Press any key';
    }

    ensureSprites();
    const built = buildLayout();
    if (!built || !built.points.length) { finish(); return; }
    layout = built;
    links = built.links;
    buildParticles(built);

    startedAt = performance.now();
    lastFrame = 0;
    running = true;

    if (wantsStill()) {
      // One still, fully assembled frame. No loop, no flicker, no travel.
      draw(startedAt + TIMING.settle + 900);
      showSubtitle();
      finishTimer = setTimeout(finish, 1100);
      return;
    }

    armSkip();
    rafId = requestAnimationFrame(frame);

    finishTimer = setTimeout(showSubtitle, TIMING.settle);
    leaveTimer = setTimeout(() => splash.classList.add('leaving'), TIMING.leaveAt);
    removeTimer = setTimeout(finish, TIMING.removeAt);
  }

  function startClassic() {
    reset();
    style = 'classic';
    splash.dataset.state = 'running';
    splash.dataset.style = 'classic';
    splash.classList.remove('hide', 'leaving');
    canvas.style.display = 'none';
    if (sub) sub.classList.remove('in');
    if (hint) {
      hint.textContent = 'Press any key';
      hint.classList.remove('dim');
    }

    // A clone restarts every CSS animation inside the classic sequence, which
    // is exactly what Preview needs.
    const fresh = classic.cloneNode(true);
    classic.replaceWith(fresh);
    fresh.removeAttribute('hidden');
    classic = fresh;

    running = true;
    armSkip();
    const duration = wantsStill() ? 500 : 2450;
    removeTimer = setTimeout(finish, duration + 250);
  }

  function applyStyle(next, options) {
    const opts = options || {};
    const wanted = STYLES.includes(next) ? next : 'stars';
    if (wanted === 'off') {
      reset();
      hideLayer();
      style = 'off';
      return;
    }
    // A live change in Setup records the choice without replaying the opening;
    // only Preview, or the next launch, actually runs it.
    if (opts.silent) {
      style = wanted;
      return;
    }
    // Already running, or already shown in this launch: the boot call must not
    // restart a sequence the person is watching or has just finished.
    if (style === wanted && (running || splash.dataset.state === 'done')) return;
    style = wanted;
    if (wanted === 'classic') startClassic();
    else startStars();
  }

  function preview() {
    reset();
    // Preview shows the chosen opening, or — when the shop has chosen Off —
    // the star assembly, since otherwise the button would visibly do nothing.
    if (style === 'classic') startClassic();
    else startStars();
  }

  // ---------------------------------------------------------------------------
  // Boot: use the cached appearance so the very first frame is already styled,
  // then let app.js apply the saved setting once the data file is loaded.
  // ---------------------------------------------------------------------------
  function cachedStyle() {
    try {
      const raw = localStorage.getItem('lyra.appearance');
      if (!raw) return 'stars';
      const saved = JSON.parse(raw);
      motionOff = saved.motion === 'off';
      return STYLES.includes(saved.splash) ? saved.splash : 'stars';
    } catch (err) {
      return 'stars';
    }
  }

  window.LyraSplash = { applyStyle, preview, finish, setMotion: (level) => { motionOff = level === 'off'; } };

  window.addEventListener('resize', () => {
    if (!running || style !== 'stars') return;
    // A window that changes size mid-sequence simply gets a new word; the
    // sequence is short enough that restarting is cleaner than reflowing it.
    startStars();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) finish();
  });

  applyStyle(cachedStyle());
})();
