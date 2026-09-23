'use strict';

// ---------------------------------------------------------------------------
// The sky behind the till.
//
// A canvas of slowly drifting particles with the Lyra figure over them, drawn
// behind every screen. Three rules keep it out of the way of the shop:
//
//   1. It is cheap. Stars are pre-rendered sprites stamped with drawImage at
//      30 frames a second, never blurred shadows, and the whole layer stops
//      when the window is hidden or unfocused — a till left on a counter
//      overnight should not be running a render loop.
//   2. It is quiet. Everything is low-alpha and spread out, and the figure is
//      placed over the receipt rather than over the product list, so no figure
//      on screen is ever sitting on a moving light.
//   3. It is optional. With "reduce motion" set at the operating system, one
//      still frame is drawn and no loop starts at all.
//
// Nothing here is functional: no screen depends on this file, and if it were
// deleted the app would look exactly the same apart from the background.
// ---------------------------------------------------------------------------

(() => {
  const canvas = document.getElementById('starfield');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const wantsStill = () => !!(motionQuery && motionQuery.matches);

  // Where the figure sits, as fractions of the window: up and to the right,
  // over the receipt. Vega is index 0 and is the bright one.
  const LYRA = [
    { x: 0.591, y: 0.105, r: 1.9 },   // Vega
    { x: 0.651, y: 0.184, r: 1.2 },   // ζ
    { x: 0.711, y: 0.233, r: 1.3 },   // δ²
    { x: 0.783, y: 0.211, r: 1.2 },   // β
    { x: 0.738, y: 0.145, r: 1.2 },   // γ
    { x: 0.812, y: 0.088, r: 0.9, warm: true }
  ];
  const LYRA_LINES = [[1, 2], [2, 3], [3, 4], [4, 1], [0, 1], [0, 4]];

  const COOL = '220,233,255';
  const WARM = '255,206,150';
  const LINE = '127,176,255';

  const DPR_CAP = 2;
  const FRAME_MS = 1000 / 30;

  let w = 0, h = 0;
  let stars = [];
  let coolSprite = null, warmSprite = null;
  let parallax = { x: 0, y: 0 };          // smoothed
  let parallaxTarget = { x: 0, y: 0 };    // where the pointer is
  let rafId = 0;
  let running = false;
  let lastFrame = 0;
  let meteor = null;
  let nextMeteorAt = 0;

  // One star = a soft dot. Drawn once into a small offscreen canvas and then
  // stamped, which is what makes a hundred of them free.
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

  function stamp(sprite, x, y, r, alpha) {
    if (!sprite || alpha <= 0) return;
    const size = r * 4;
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  // The four-point sparkle on Vega: two hairlines fading out from the centre.
  function flare(x, y, len, alpha) {
    const fade = alpha.toFixed(3);
    const across = ctx.createLinearGradient(x - len, y, x + len, y);
    across.addColorStop(0, 'rgba(' + COOL + ',0)');
    across.addColorStop(0.5, 'rgba(' + COOL + ',' + fade + ')');
    across.addColorStop(1, 'rgba(' + COOL + ',0)');
    ctx.fillStyle = across;
    ctx.fillRect(x - len, y - 0.5, len * 2, 1);

    const down = ctx.createLinearGradient(x, y - len, x, y + len);
    down.addColorStop(0, 'rgba(' + COOL + ',0)');
    down.addColorStop(0.5, 'rgba(' + COOL + ',' + fade + ')');
    down.addColorStop(1, 'rgba(' + COOL + ',0)');
    ctx.fillStyle = down;
    ctx.fillRect(x - 0.5, y - len, 1, len * 2);
  }

  // Roughly one star per 16,000 square pixels, kept between a floor and a
  // ceiling: a small window still has a sky, and a large one does not turn into
  // a snowstorm.
  function starTarget() {
    return Math.max(46, Math.min(130, Math.round((w * h) / 16000)));
  }

  function seedStars() {
    stars = [];
    const count = starTarget();
    for (let i = 0; i < count; i++) stars.push(makeStar());
  }

  function makeStar() {
    return {
      x: Math.random(),
      y: Math.random(),
      r: 0.5 + Math.random() * 1.1,
      alpha: 0.18 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.0004 + Math.random() * 0.0012,   // radians per ms
      driftX: (Math.random() - 0.5) * 0.003,    // px per ms, so a slow crawl
      driftY: (Math.random() - 0.5) * 0.003,
      warm: Math.random() < 0.06
    };
  }

  function resize() {
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // A resize should not reshuffle the sky, so the list is grown or trimmed
    // rather than rebuilt.
    if (!stars.length) seedStars();
    else {
      const target = starTarget();
      while (stars.length > target) stars.pop();
      while (stars.length < target) stars.push(makeStar());
    }

    if (wantsStill()) draw(performance.now());
  }

  function draw(now) {
    ctx.clearRect(0, 0, w, h);

    // The whole sky leans a few pixels against the pointer. Tiny on purpose:
    // enough to feel like depth, not enough to be noticed moving.
    const px = parallax.x;
    const py = parallax.y;

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const twinkle = 0.72 + 0.28 * Math.sin(s.phase + now * s.speed);
      // Drift is measured from the running clock rather than accumulated, so a
      // dropped frame can never nudge the sky sideways.
      let x = s.x * w + s.driftX * now;
      let y = s.y * h + s.driftY * now;
      // Keep drifting stars inside the window without ever jumping.
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
      const depth = 0.4 + s.r * 0.5;
      stamp(s.warm ? warmSprite : coolSprite, x + px * depth, y + py * depth, s.r * 2.6, s.alpha * twinkle);
    }

    // ---- Lyra ----
    const breathe = wantsStill() ? 0 : 0.06 * Math.sin(now * 0.00035);
    const lx = px * 1.2;
    const ly = py * 1.2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + LINE + ',' + (0.15 + breathe).toFixed(3) + ')';
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

      // Halo, flare on the bright one, then a hard core: without the core the
      // stars read as smudges, and without the flare they read as dust.
      stamp(s.warm ? warmSprite : coolSprite, x, y, s.r * 5, (isVega ? 0.9 : 0.6) * twinkle);
      if (isVega) flare(x, y, 13, 0.3 * twinkle);

      ctx.globalAlpha = Math.min(1, twinkle * (isVega ? 1 : 0.72));
      ctx.fillStyle = s.warm ? '#FFE7C9' : '#F4F8FF';
      ctx.beginPath();
      ctx.arc(x, y, s.r * (isVega ? 1.5 : 1), 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- The occasional meteor ----
    // A shop's screen is looked at in glances; something crossing it once a
    // minute, quietly, is what makes the sky feel alive.
    if (!wantsStill() && meteor) {
      const life = Math.min(1, (now - meteor.startedAt) / meteor.duration);
      const headX = meteor.x + meteor.vx * life;
      const headY = meteor.y + meteor.vy * life;
      const tailX = headX - meteor.vx * 0.12;
      const tailY = headY - meteor.vy * 0.12;
      const fade = Math.sin(life * Math.PI);
      const grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
      grad.addColorStop(0, 'rgba(' + COOL + ',0)');
      grad.addColorStop(1, 'rgba(' + COOL + ',' + (0.5 * fade).toFixed(3) + ')');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(headX, headY);
      ctx.stroke();
      if (life >= 1) meteor = null;
    }

    ctx.globalAlpha = 1;
  }

  function launchMeteor(now) {
    const fromLeft = Math.random() < 0.5;
    meteor = {
      x: fromLeft ? w * (0.05 + Math.random() * 0.2) : w * (0.85 + Math.random() * 0.1),
      y: h * (0.05 + Math.random() * 0.2),
      vx: (fromLeft ? 1 : -1) * (w * (0.22 + Math.random() * 0.12)),
      vy: h * (0.14 + Math.random() * 0.08),
      startedAt: now,
      duration: 900 + Math.random() * 500
    };
    nextMeteorAt = now + 35000 + Math.random() * 45000;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    // Ease the parallax rather than snapping it to the pointer.
    parallax.x += (parallaxTarget.x - parallax.x) * 0.06;
    parallax.y += (parallaxTarget.y - parallax.y) * 0.06;

    if (!meteor && now >= nextMeteorAt) launchMeteor(now);

    draw(now);
  }

  function start() {
    if (running || wantsStill()) return;
    running = true;
    lastFrame = 0;
    nextMeteorAt = performance.now() + 20000 + Math.random() * 30000;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onVisibility() {
    if (document.hidden || !document.hasFocus()) stop();
    else start();
  }

  window.addEventListener('resize', () => {
    if (resize._queued) return;
    resize._queued = true;
    requestAnimationFrame(() => { resize._queued = false; resize(); });
  });

  window.addEventListener('pointermove', (e) => {
    if (wantsStill()) return;
    parallaxTarget.x = (e.clientX / w - 0.5) * -14;
    parallaxTarget.y = (e.clientY / h - 0.5) * -10;
  }, { passive: true });

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  window.addEventListener('blur', onVisibility);

  if (motionQuery) {
    const onChange = () => {
      if (wantsStill()) { stop(); resize(); }
      else start();
    };
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onChange);
    else if (motionQuery.addListener) motionQuery.addListener(onChange);
  }

  coolSprite = makeSprite(COOL);
  warmSprite = makeSprite(WARM);
  resize();
  start();
})();
