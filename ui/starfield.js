'use strict';

// ---------------------------------------------------------------------------
// The sky behind the shop: a nebula of flickering stars, or Lyra's figure.
//
// Two layers do the work:
//
//   • #nebulaLayer — a small offscreen-sized canvas (roughly a quarter of the
//     window in each direction) painted once per size and theme with soft,
//     overlapping clouds, then stretched by CSS and given a slow drift. It is
//     a texture, not a render loop: keeping it on screen costs one composite.
//   • #starfield — the flickering stars, painted at 30 frames a second from
//     pre-rendered sprites. No shadows, no per-frame gradients for the stars,
//     and no allocation inside the loop.
//
// The shop chooses what it wants, and all three choices are honest:
//
//   nebula        the new cloud of colour with stars flickering through it
//   constellation the original deep sky with Lyra drawn over it
//   off           no canvas work at all; the CSS night remains
//
// The loop stops when the window is hidden, unfocused or the person asked for
// less motion; with reduced motion one still frame is drawn. The sky never
// takes a pointer event and no screen depends on it.
//
// Public surface:
//   LyraSky.apply({ style, intensity, parallax, motion })
//   LyraSky.refresh()          re-reads the theme and repaints
//   LyraSky.stop()
// ---------------------------------------------------------------------------

(() => {
  const canvas = document.getElementById('starfield');
  const nebulaCanvas = document.getElementById('nebulaLayer');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  const nctx = nebulaCanvas && typeof nebulaCanvas.getContext === 'function'
    ? nebulaCanvas.getContext('2d', { alpha: true })
    : null;

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const wantsStill = () => !!(motionQuery && motionQuery.matches);

  const DPR_CAP = 2;
  const FRAME_MS = 1000 / 30;

  // The original constellation, as fractions of the window. Vega is index 0.
  const LYRA = [
    { x: 0.591, y: 0.105, r: 1.9 },
    { x: 0.651, y: 0.184, r: 1.2 },
    { x: 0.711, y: 0.233, r: 1.3 },
    { x: 0.783, y: 0.211, r: 1.2 },
    { x: 0.738, y: 0.145, r: 1.2 },
    { x: 0.812, y: 0.088, r: 0.9, warm: true }
  ];
  const LYRA_LINES = [[1, 2], [2, 3], [3, 4], [4, 1], [0, 1], [0, 4]];

  // One palette per theme: the same sky seen through a different atmosphere.
  // Every built-in theme has its own clouds as well as its own stars.
  const PALETTES = {
    midnight: {
      cool: '220,233,255', warm: '255,206,150', line: '127,176,255',
      clouds: [[58, 112, 224], [126, 82, 230], [42, 168, 210], [86, 60, 180]]
    },
    galaxy: {
      cool: '232,214,255', warm: '255,188,226', line: '178,140,255',
      clouds: [[116, 62, 238], [246, 92, 210], [74, 42, 158], [160, 110, 255]]
    },
    cosmos: {
      cool: '214,255,234', warm: '255,240,170', line: '96,220,152',
      clouds: [[30, 158, 108], [82, 220, 160], [18, 92, 80], [40, 190, 200]]
    },
    moonlight: {
      cool: '236,242,255', warm: '255,240,214', line: '176,198,255',
      clouds: [[76, 108, 192], [154, 184, 255], [40, 58, 120], [110, 130, 220]]
    },
    rust: {
      cool: '255,226,199', warm: '255,176,104', line: '226,122,48',
      clouds: [[176, 68, 20], [246, 128, 48], [92, 40, 18], [210, 96, 36]]
    },
    solaris: {
      cool: '255,240,205', warm: '255,200,120', line: '240,190,90',
      clouds: [[196, 126, 28], [255, 190, 82], [90, 52, 12], [230, 158, 46]]
    },
    ion: {
      cool: '204,255,248', warm: '176,252,255', line: '60,240,220',
      clouds: [[0, 158, 168], [56, 240, 220], [8, 62, 92], [24, 200, 210]]
    }
  };

  let config = { style: 'nebula', intensity: 'balanced', parallax: true, motion: 'full' };
  let w = 0, h = 0;
  let stars = [];
  let parallaxNow = { x: 0, y: 0 };
  let parallaxTarget = { x: 0, y: 0 };
  let rafId = 0;
  let running = false;
  let lastFrame = 0;
  let meteor = null;
  let nextMeteorAt = 0;
  let nebulaKey = '';
  let nebulaTimer = 0;
  let lastPointer = 0;
  let pointerQueued = false;

  let currentPalette = null;
  let paletteKey = '';
  let sprites = null;

  // ---- Palettes ------------------------------------------------------------

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function rgbString(parts) {
    return parts.join(', ');
  }

  function isCustomTheme() {
    return (document.documentElement.dataset.theme || '').indexOf('custom-') === 0;
  }

  function palette() {
    const id = document.documentElement.dataset.theme || 'midnight';
    if (id === paletteKey && currentPalette) return currentPalette;
    paletteKey = id;

    if (isCustomTheme()) {
      const accentRaw = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
      const accent = (accentRaw || '120, 170, 255').split(',').map(v => parseInt(v, 10) || 0);
      const glow = mix(accent, [255, 255, 255], 0.28);
      const deep = mix(accent, [0, 0, 0], 0.3);
      currentPalette = {
        cool: rgbString(glow),
        warm: rgbString(mix(accent, [255, 214, 150], 0.55)),
        line: rgbString(accent),
        clouds: [accent, glow, deep, mix(accent, [255, 255, 255], 0.5)]
      };
    } else {
      const found = PALETTES[id] || PALETTES.midnight;
      currentPalette = {
        ...found,
        clouds: found.clouds.map(c => c.slice())
      };
    }
    return currentPalette;
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
    grad.addColorStop(0.22, 'rgba(' + rgb + ',0.6)');
    grad.addColorStop(0.55, 'rgba(' + rgb + ',0.12)');
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function makeFlare(rgb) {
    const size = 160;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) return c;
    const mid = size / 2;
    const across = g.createLinearGradient(0, mid, size, mid);
    across.addColorStop(0, 'rgba(' + rgb + ',0)');
    across.addColorStop(0.5, 'rgba(' + rgb + ',0.7)');
    across.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = across;
    g.fillRect(0, mid - 0.5, size, 1);
    const down = g.createLinearGradient(mid, 0, mid, size);
    down.addColorStop(0, 'rgba(' + rgb + ',0)');
    down.addColorStop(0.5, 'rgba(' + rgb + ',0.7)');
    down.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = down;
    g.fillRect(mid - 0.5, 0, 1, size);
    return c;
  }

  function ensureSprites() {
    const p = palette();
    const key = p.cool + '|' + p.warm + '|' + p.line;
    if (sprites && sprites.key === key) return;
    sprites = {
      cool: makeSprite(p.cool),
      warm: makeSprite(p.warm),
      flare: makeFlare(p.cool),
      key
    };
  }

  function stamp(sprite, x, y, size, alpha) {
    if (!sprite || alpha <= 0.002) return;
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  // ---- Nebula --------------------------------------------------------------

  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function themeSeed() {
    const id = document.documentElement.dataset.theme || 'midnight';
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  // The texture is intentionally small: clouds have no detail worth full
  // resolution, and stretching a 480-pixel canvas across the window is what
  // gives them their softness for free.
  function paintNebula() {
    if (!nctx || !nebulaCanvas) return;
    if (config.style !== 'nebula') return;

    const p = palette();
    const key = p.clouds.join('|') + '@' + w + 'x' + h + '#' + config.intensity;
    if (key === nebulaKey) return;
    nebulaKey = key;

    const scale = 0.24;
    const nw = Math.max(2, Math.min(520, Math.round(w * scale)));
    const nh = Math.max(2, Math.min(340, Math.round(h * scale)));
    nebulaCanvas.width = nw;
    nebulaCanvas.height = nh;

    nctx.globalCompositeOperation = 'source-over';
    nctx.clearRect(0, 0, nw, nh);
    nctx.globalCompositeOperation = 'lighter';

    const rand = seeded(themeSeed());
    const strength = config.intensity === 'subtle' ? 0.55 : config.intensity === 'vivid' ? 1.25 : 1;
    const blobs = 26;

    for (let i = 0; i < blobs; i++) {
      const color = p.clouds[i % p.clouds.length];
      const cx = rand() * nw;
      const cy = rand() * nh;
      const radius = (0.11 + rand() * 0.3) * Math.max(nw, nh) * (0.8 + rand() * 0.5);
      const alpha = (0.08 + rand() * 0.2) * strength;
      const grad = nctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, 'rgba(' + color.join(',') + ',' + alpha.toFixed(3) + ')');
      grad.addColorStop(0.42, 'rgba(' + color.join(',') + ',' + (alpha * 0.42).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(' + color.join(',') + ',0)');
      nctx.fillStyle = grad;
      nctx.beginPath();
      nctx.arc(cx, cy, radius, 0, Math.PI * 2);
      nctx.fill();
    }

    // A darker lane through the middle gives the clouds depth rather than a
    // uniform wash of colour.
    nctx.globalCompositeOperation = 'destination-out';
    const lane = nctx.createLinearGradient(0, nh * 0.15, nw, nh * 0.85);
    lane.addColorStop(0, 'rgba(0,0,0,0)');
    lane.addColorStop(0.5, 'rgba(0,0,0,' + (0.22 * strength).toFixed(3) + ')');
    lane.addColorStop(1, 'rgba(0,0,0,0)');
    nctx.fillStyle = lane;
    nctx.fillRect(0, 0, nw, nh);
    nctx.globalCompositeOperation = 'source-over';

    nebulaCanvas.classList.add('lit');
  }

  function clearNebula() {
    if (!nctx || !nebulaCanvas) return;
    clearTimeout(nebulaTimer);
    nebulaTimer = 0;
    nebulaKey = '';
    nctx.clearRect(0, 0, nebulaCanvas.width, nebulaCanvas.height);
    nebulaCanvas.classList.remove('lit');
  }

  // A colour picker fires on every pixel of a drag. The stars follow at once;
  // the cloud texture is rebuilt a beat later, once the hand has paused.
  function paintNebulaSoon() {
    clearTimeout(nebulaTimer);
    nebulaTimer = setTimeout(() => { nebulaTimer = 0; paintNebula(); }, 90);
  }

  // ---- Stars ---------------------------------------------------------------

  function intensity() {
    if (config.intensity === 'subtle') return { count: 0.62, alpha: 0.72, speed: 0.8 };
    if (config.intensity === 'vivid') return { count: 1.5, alpha: 1.18, speed: 1.2 };
    return { count: 1, alpha: 1, speed: 1 };
  }

  function starTarget() {
    const base = Math.round((w * h) / 16000);
    const factor = intensity().count;
    return Math.max(30, Math.min(210, Math.round(base * factor)));
  }

  function makeStar() {
    return {
      x: Math.random(),
      y: Math.random(),
      r: 0.45 + Math.random() * 1.15,
      alpha: 0.16 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: (0.0004 + Math.random() * 0.0013),
      driftX: (Math.random() - 0.5) * 0.004,
      driftY: (Math.random() - 0.5) * 0.0035,
      warm: Math.random() < 0.07
    };
  }

  function seedStars() {
    stars = [];
    const count = starTarget();
    for (let i = 0; i < count; i++) stars.push(makeStar());
  }

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    // A 4K window at device scale 2 would otherwise hold a 33-megapixel canvas
    // for a background of soft dots. The budget keeps the sky crisp enough at
    // any size without letting the bitmap grow without bound.
    const budget = Math.max(0.75, Math.sqrt(8000000 / Math.max(1, w * h)));
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1, budget);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!stars.length) seedStars();
    else {
      const target = starTarget();
      while (stars.length > target) stars.pop();
      while (stars.length < target) stars.push(makeStar());
    }

    nebulaKey = '';
    paintNebula();
    if (wantsStill() || config.motion === 'off') draw(performance.now());
  }

  function drawConstellation(now, p, px, py) {
    ctx.globalAlpha = 1;
    const breathe = 0.06 * Math.sin(now * 0.00035);
    const lx = px * 1.2;
    const ly = py * 1.2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + p.line + ',' + (0.15 + breathe).toFixed(3) + ')';
    ctx.beginPath();
    for (let i = 0; i < LYRA_LINES.length; i++) {
      const a = LYRA[LYRA_LINES[i][0]];
      const b = LYRA[LYRA_LINES[i][1]];
      ctx.moveTo(a.x * w + lx, a.y * h + ly);
      ctx.lineTo(b.x * w + lx, b.y * h + ly);
    }
    ctx.stroke();

    for (let i = 0; i < LYRA.length; i++) {
      const s = LYRA[i];
      const isVega = i === 0;
      const twinkle = 0.78 + 0.22 * Math.sin(now * (isVega ? 0.0011 : 0.0007) + i * 1.7);
      const x = s.x * w + lx;
      const y = s.y * h + ly;

      stamp(s.warm ? sprites.warm : sprites.cool, x, y, s.r * 20, (isVega ? 0.9 : 0.6) * twinkle);
      if (isVega) {
        ctx.globalAlpha = 0.3 * twinkle;
        ctx.drawImage(sprites.flare, x - 26, y - 26, 52, 52);
      }

      ctx.globalAlpha = Math.min(1, twinkle * (isVega ? 1 : 0.72));
      ctx.fillStyle = s.warm ? '#FFE7C9' : '#F4F8FF';
      ctx.beginPath();
      ctx.arc(x, y, s.r * (isVega ? 1.5 : 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(now) {
    ctx.clearRect(0, 0, w, h);
    if (config.style === 'off') return;
    const p = palette();
    ensureSprites();
    const px = config.parallax ? parallaxNow.x : 0;
    const py = config.parallax ? parallaxNow.y : 0;
    const tint = intensity();

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const twinkle = 0.72 + 0.28 * Math.sin(s.phase + now * s.speed * tint.speed);
      let x = s.x * w + s.driftX * now;
      let y = s.y * h + s.driftY * now;
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
      const depth = 0.4 + s.r * 0.5;
      stamp(s.warm ? sprites.warm : sprites.cool, x + px * depth, y + py * depth,
        s.r * 10, s.alpha * twinkle * tint.alpha);
    }

    if (config.style === 'constellation') drawConstellation(now, p, px, py);

    ctx.globalAlpha = 1;
    if (config.motion === 'full' && !wantsStill() && meteor) {
      const life = Math.min(1, (now - meteor.startedAt) / meteor.duration);
      const headX = meteor.x + meteor.vx * life;
      const headY = meteor.y + meteor.vy * life;
      const fade = Math.sin(life * Math.PI);
      const tail = 8;
      ctx.lineCap = 'round';
      for (let i = 0; i < tail; i++) {
        const t0 = i / tail;
        const t1 = (i + 1) / tail;
        const x0 = headX - meteor.vx * 0.12 * t0;
        const y0 = headY - meteor.vy * 0.12 * t0;
        const x1 = headX - meteor.vx * 0.12 * t1;
        const y1 = headY - meteor.vy * 0.12 * t1;
        ctx.strokeStyle = 'rgba(' + p.cool + ',' + (0.55 * fade * (1 - t0)).toFixed(3) + ')';
        ctx.lineWidth = 1.8 * (1 - t0 * 0.7);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      if (life >= 1) meteor = null;
    }

    ctx.globalAlpha = 1;
  }

  function launchMeteor(now) {
    const fromLeft = Math.random() < 0.5;
    meteor = {
      x: fromLeft ? w * (0.05 + Math.random() * 0.2) : w * (0.85 + Math.random() * 0.1),
      y: h * (0.05 + Math.random() * 0.22),
      vx: (fromLeft ? 1 : -1) * (w * (0.22 + Math.random() * 0.12)),
      vy: h * (0.14 + Math.random() * 0.08),
      startedAt: now,
      duration: 900 + Math.random() * 500
    };
    const vivid = config.intensity === 'vivid' ? 0.6 : 1;
    nextMeteorAt = now + (32000 + Math.random() * 46000) * vivid;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    // Gentle motion keeps the sky alive but at two-thirds the frame rate, and
    // no meteors cross a screen that asked to be calmer.
    const interval = config.motion === 'gentle' ? 1000 / 20 : FRAME_MS;
    if (now - lastFrame < interval) return;
    lastFrame = now;

    if (config.parallax && config.motion === 'full') {
      parallaxNow.x += (parallaxTarget.x - parallaxNow.x) * 0.06;
      parallaxNow.y += (parallaxTarget.y - parallaxNow.y) * 0.06;
    }

    if (config.motion === 'full' && !meteor && now >= nextMeteorAt) launchMeteor(now);
    draw(now);
  }

  function shouldRun() {
    if (config.style === 'off') return false;
    if (config.motion === 'off') return false;
    if (wantsStill()) return false;
    if (document.hidden || !document.hasFocus()) return false;
    return true;
  }

  function start() {
    if (running || !shouldRun()) return;
    running = true;
    lastFrame = 0;
    if (!nextMeteorAt) nextMeteorAt = performance.now() + 20000 + Math.random() * 30000;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onVisibility() {
    if (shouldRun()) start();
    else { stop(); draw(performance.now()); }
  }

  function apply(next) {
    const incoming = next || {};
    const previousPalette = paletteKey;
    config = {
      style: ['nebula', 'constellation', 'off'].includes(incoming.style) ? incoming.style : 'nebula',
      intensity: ['subtle', 'balanced', 'vivid'].includes(incoming.intensity) ? incoming.intensity : 'balanced',
      parallax: incoming.parallax !== false,
      motion: ['full', 'gentle', 'off'].includes(incoming.motion) ? incoming.motion : 'full'
    };

    const theme = document.documentElement.dataset.theme || '';
    if (theme !== previousPalette) {
      paletteKey = '';
      currentPalette = null;
      sprites = null;
      nebulaKey = '';
    }

    if (config.style === 'off') {
      stop();
      ctx.clearRect(0, 0, w, h);
      clearNebula();
      canvas.style.display = 'none';
      return;
    }

    canvas.style.display = '';
    if (nebulaCanvas) nebulaCanvas.style.display = config.style === 'nebula' ? '' : 'none';
    if (config.style === 'nebula') paintNebulaSoon();
    else clearNebula();

    // Star count can change when the intensity does.
    if (stars.length) {
      const target = starTarget();
      while (stars.length > target) stars.pop();
      while (stars.length < target) stars.push(makeStar());
    }

    draw(performance.now());
    if (shouldRun()) start();
    else stop();
  }

  function refresh() {
    paletteKey = '';
    currentPalette = null;
    sprites = null;
    nebulaKey = '';
    if (config.style === 'nebula') paintNebula();
    draw(performance.now());
  }

  window.LyraSky = { apply, refresh, stop };

  // ---- Wiring --------------------------------------------------------------

  let resizeQueued = false;
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    // The sky follows the window while it is being dragged, but the nebula
    // texture is repainted once the hand comes off it rather than on every
    // intermediate size.
    if (!resizeQueued) {
      resizeQueued = true;
      requestAnimationFrame(() => { resizeQueued = false; resize(); });
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = 0; resize(); }, 160);
  });

  window.addEventListener('pointermove', (e) => {
    if (!config.parallax || config.motion !== 'full' || wantsStill()) return;
    if (pointerQueued) return;
    pointerQueued = true;
    requestAnimationFrame(() => {
      pointerQueued = false;
      const now = performance.now();
      if (now - lastPointer < 40) return;
      lastPointer = now;
      parallaxTarget.x = (e.clientX / Math.max(1, w) - 0.5) * -14;
      parallaxTarget.y = (e.clientY / Math.max(1, h) - 0.5) * -10;
    });
  }, { passive: true });

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  window.addEventListener('blur', onVisibility);

  if (motionQuery) {
    const onChange = () => {
      if (wantsStill()) { stop(); draw(performance.now()); }
      else if (shouldRun()) start();
    };
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onChange);
    else if (motionQuery.addListener) motionQuery.addListener(onChange);
  }

  function cached() {
    try {
      const raw = localStorage.getItem('lyra.appearance');
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return {
        style: saved.sky || 'nebula',
        intensity: saved.skyIntensity || 'balanced',
        parallax: saved.skyParallax !== false,
        motion: saved.motion || 'full'
      };
    } catch (err) {
      return null;
    }
  }

  resize();
  apply(cached() || config);
})();
