'use strict';

// ---------------------------------------------------------------------------
// The two charts: takings over time, and where the money came from.
//
// They are decoration on a till, and that decides everything below:
//
//   1. SVG, not canvas. A chart is a handful of shapes, so it stays crisp when
//      the window is dragged narrow, scales with its viewBox instead of
//      overflowing, and gives every point a native <title> tooltip for free.
//   2. Colour is always the theme's. Every stroke, fill, gradient stop and
//      label is a `var(--token, fallback)` in the stylesheet injected once
//      below — never a hex value in the geometry — so a chart matches the rest
//      of the screen, and a renamed token can only ever make it plain, never
//      black on black.
//   3. The entrance is CSS. Each element animates *from* its hidden state to
//      its own resting style, staggered by an inline `--lyra-delay`. Nothing
//      here polls, holds a timer or keeps a reference after the call returns,
//      so a chart replaced mid-animation is simply collected. With "reduce
//      motion" set the animations never run and the finished chart is on
//      screen at once — no script needs to know that happened.
//   4. It cannot break the till. Every public call is wrapped, every number is
//      coerced, a missing or nonsensical model draws a quiet message, and no
//      path can produce NaN geometry: a chart that failed is a blank panel,
//      never a broken screen.
//
// Public surface, installed on window when this file loads:
//
//   LyraCharts.area(el, model)    takings and profit over time
//   LyraCharts.donut(el, model)   where the money came from
//   LyraCharts.clear(el)          empty a chart host when its view goes away
//
// `el` is an element or a selector. Both renderers replace whatever is inside
// it and replay the entrance on every call, because the screens re-render
// whenever the period tabs change. The host carries data-lyra-chart while a
// chart is in it, and the markup inside is all `lyra-` classes, so the app can
// style around anything it likes.
// ---------------------------------------------------------------------------

(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var STYLE_ID = 'lyra-charts-styles';
  var TWO_PI = Math.PI * 2;
  var DEG = Math.PI / 180;

  // The area chart lives in a fixed 640x230 box and is scaled by the browser.
  // One geometry for every window size; the padding keeps the axis type clear
  // of the edges at the widths the panels actually run at.
  var AREA_W = 640;
  var AREA_H = 230;
  var PAD = { l: 52, r: 14, t: 14, b: 26 };

  // A month of days is the widest the app sends; these caps are only a
  // seatbelt against a runaway model, not a design limit.
  var MAX_BUCKETS = 260;
  var MAX_SLICES = 40;

  // The donut in its own 220x220 box.
  var DONUT_BOX = 220;
  var DONUT_C = 110;
  var DONUT_R = 82;
  var DONUT_GAP = 1.4 * DEG;   // air between neighbouring slices
  var DONUT_STUB = 0.7 * DEG;  // the smallest a very small slice is drawn

  // Mirrors --dur-slower, the stylesheet's unit of timing. The stagger is
  // arithmetic — which point pops when — so the number has to exist here as
  // well; the stylesheet derives its own durations from the same token.
  var UNIT_MS = 400;
  var DRAW_MS = UNIT_MS * 2.2;   // a line draws itself in ~0.9s
  var SWEEP_MS = UNIT_MS * 1.6;  // the ring follows in ~0.65s
  var ROW_MS = 70;               // stagger between legend rows
  var X_LABEL_CAP = 8;           // more than this and the labels collide

  // A tidy axis maximum: 0.87 -> 1, 42 -> 50, 1234 -> 1500, 7310 -> 8000.
  var NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

  // ---------------------------------------------------------------------------
  // The stylesheet, injected once. Scoped to .lyra-chart so nothing here can
  // reach the till's own markup, and every colour is a theme token with a
  // fallback borrowed from the theme itself.
  // ---------------------------------------------------------------------------

  var CSS = [
    ".lyra-chart {",
    "  display: block;",
    "  max-width: 100%;",
    "  min-width: 0;",
    "  color: var(--text-muted, #9AA9C7);",
    "  font-family: var(--font-mono, 'Cascadia Mono', 'Cascadia Code', Consolas, ui-monospace, monospace);",
    "}",
    ".lyra-title {",
    "  margin: 0 0 var(--space-5, 12px);",
    "  font-family: var(--font-display, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif);",
    "  font-size: var(--text-md, 16px);",
    "  font-weight: 600;",
    "  line-height: var(--leading-tight, 1.2);",
    "  color: var(--text-ink, #E8EEFA);",
    "}",
    ".lyra-svg { display: block; width: 100%; height: auto; overflow: hidden; }",
    ".lyra-empty {",
    "  margin: 8px 0;",
    "  color: var(--text-muted, #9AA9C7);",
    "  font-size: var(--text-sm, 13.5px);",
    "}",
    "",
    "/* The entrance. Each keyframe states only where the element starts; the",
    "   resting style is the finished chart, so a browser with animations off",
    "   (reduce motion, or the print stylesheet) paints the end state itself. */",
    "@keyframes lyra-draw { from { stroke-dashoffset: 1; } }",
    "@keyframes lyra-rise { from { opacity: 0; transform: translateY(7px); } }",
    "@keyframes lyra-pop { from { opacity: 0; transform: scale(0.2); } }",
    "@keyframes lyra-side { from { opacity: 0; transform: translateX(-7px); } }",
    "@keyframes lyra-soft-in { from { opacity: 0; } }",
    "",
    "/* ---- area ----",
    "   Paths carrying .lyra-line or .lyra-slice are given pathLength=\"1\" by",
    "   the script, so dash units are fractions of the path: 1 hides it, 0 is",
    "   the finished shape, and the draw is one dashoffset animation. */",
    ".lyra-line, .lyra-slice { stroke-dasharray: 1; }",
    ".lyra-line {",
    "  fill: none;",
    "  stroke-linecap: round;",
    "  stroke-linejoin: round;",
    "  pointer-events: none;",
    "  animation: lyra-draw calc(var(--dur-slower, 0.4s) * 2.2) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) backwards;",
    "}",
    ".lyra-line-sales { stroke: var(--blue-bright, #7FB0FF); stroke-width: 2.6; }",
    ".lyra-line-profit {",
    "  stroke: var(--mint, #5FE0B0);",
    "  stroke-width: 1.6;",
    "  opacity: 0.92;",
    "  animation-delay: calc(var(--dur-slower, 0.4s) * 0.5);",
    "}",
    ".lyra-fill {",
    "  pointer-events: none;",
    "  animation: lyra-rise calc(var(--dur-slower, 0.4s) * 1.5) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) calc(var(--dur-slower, 0.4s) * 0.45) backwards;",
    "}",
    ".lyra-stop-sales-up { stop-color: var(--blue, #2F6AE4); stop-opacity: 0.38; }",
    ".lyra-stop-sales-down { stop-color: var(--blue, #2F6AE4); stop-opacity: 0; }",
    ".lyra-stop-profit-up { stop-color: var(--mint, #5FE0B0); stop-opacity: 0.2; }",
    ".lyra-stop-profit-down { stop-color: var(--mint, #5FE0B0); stop-opacity: 0; }",
    ".lyra-gridline {",
    "  stroke: var(--line, rgba(255, 255, 255, 0.075));",
    "  stroke-width: 1;",
    "  shape-rendering: crispEdges;",
    "  animation: lyra-soft-in var(--dur-slow, 0.3s) ease-out backwards;",
    "}",
    ".lyra-gridline-zero { stroke: var(--line-strong, rgba(255, 255, 255, 0.15)); }",
    ".lyra-tick {",
    "  fill: var(--text-dim, #7C8DB0);",
    "  font-size: 13px;",
    "  font-variant-numeric: tabular-nums;",
    "  animation: lyra-soft-in calc(var(--dur-slower, 0.4s) * 1.5) ease-out backwards;",
    "}",
    "/* The halo under a hovered point: a cyan disc that fades in, so the only",
    "   thing that ever moves on hover is opacity. */",
    ".lyra-hit {",
    "  fill: var(--cyan, #6FE0E2);",
    "  fill-opacity: 0;",
    "  pointer-events: all;",
    "  transition: fill-opacity var(--dur-base, 0.2s) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));",
    "}",
    ".lyra-point:hover .lyra-hit { fill-opacity: 0.16; }",
    ".lyra-dot {",
    "  fill: var(--blue-bright, #7FB0FF);",
    "  stroke: var(--bg-2, #101A31);",
    "  stroke-width: 1.4;",
    "  stroke-opacity: 0.9;",
    "  pointer-events: none;",
    "  transition: transform var(--dur-base, 0.2s) var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1));",
    "  animation: lyra-pop calc(var(--dur-slower, 0.4s) * 1.05) var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1)) var(--lyra-delay, 0s) backwards;",
    "}",
    ".lyra-point:hover .lyra-dot { transform: scale(1.5); }",
    "",
    "/* ---- donut ---- */",
    ".lyra-donut-body { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 18px; }",
    ".lyra-donut-plot { flex: 0 1 200px; min-width: 0; max-width: 220px; margin: 0 auto; }",
    ".lyra-ring-track {",
    "  fill: none;",
    "  stroke: var(--line-strong, rgba(255, 255, 255, 0.15));",
    "  stroke-width: 26;",
    "  opacity: 0.55;",
    "}",
    ".lyra-slice {",
    "  fill: none;",
    "  stroke: var(--lyra-tone, var(--blue, #2F6AE4));",
    "  stroke-width: 26;",
    "  stroke-linecap: butt;",
    "  transition: stroke-width var(--dur-base, 0.2s) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1));",
    "  animation: lyra-draw var(--lyra-dur, calc(var(--dur-slower, 0.4s) * 1.6)) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) var(--lyra-delay, 0s) backwards;",
    "}",
    ".lyra-slice:hover { stroke-width: 30; }",
    ".lyra-centre-label {",
    "  fill: var(--text-muted, #9AA9C7);",
    "  font-size: 13px;",
    "  text-anchor: middle;",
    "  animation: lyra-soft-in var(--dur-slower, 0.4s) ease-out calc(var(--dur-slower, 0.4s) * 0.6) backwards;",
    "}",
    ".lyra-centre-value {",
    "  fill: var(--text-ink, #E8EEFA);",
    "  font-family: var(--font-mono, 'Cascadia Mono', 'Cascadia Code', Consolas, ui-monospace, monospace);",
    "  font-size: 25px;",
    "  font-weight: 700;",
    "  text-anchor: middle;",
    "  font-variant-numeric: tabular-nums;",
    "  animation: lyra-soft-in var(--dur-slower, 0.4s) ease-out calc(var(--dur-slower, 0.4s) * 0.6) backwards;",
    "}",
    ".lyra-legend {",
    "  list-style: none;",
    "  margin: 0;",
    "  padding: 0;",
    "  display: flex;",
    "  flex-direction: column;",
    "  gap: 2px;",
    "  flex: 1 1 200px;",
    "  min-width: 0;",
    "}",
    ".lyra-legend-item {",
    "  display: grid;",
    "  grid-template-columns: 10px minmax(0, 1fr) auto auto;",
    "  align-items: center;",
    "  gap: 8px 10px;",
    "  padding: 4px 6px;",
    "  border-radius: var(--radius-xs, 5px);",
    "  animation: lyra-side var(--dur-slower, 0.4s) var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) var(--lyra-delay, 0s) backwards;",
    "}",
    ".lyra-legend-item:hover { background: var(--bg-2, #101A31); }",
    ".lyra-swatch {",
    "  width: 10px;",
    "  height: 10px;",
    "  border-radius: 3px;",
    "  background: var(--lyra-tone, #9AA9C7);",
    "  box-shadow: 0 0 9px -2px var(--lyra-tone, transparent);",
    "}",
    ".lyra-legend-refund .lyra-swatch { box-shadow: 0 0 0 1px var(--rust, #F97316); }",
    ".lyra-legend-label {",
    "  min-width: 0;",
    "  overflow-wrap: anywhere;",
    "  color: var(--text-muted, #9AA9C7);",
    "  font-size: var(--text-xs, 12.5px);",
    "}",
    ".lyra-legend-amount {",
    "  text-align: right;",
    "  white-space: nowrap;",
    "  font-size: var(--text-sm, 13.5px);",
    "  font-weight: 600;",
    "  color: var(--text-ink, #E8EEFA);",
    "  font-variant-numeric: tabular-nums;",
    "}",
    ".lyra-legend-pct {",
    "  text-align: right;",
    "  white-space: nowrap;",
    "  min-width: 42px;",
    "  font-size: var(--text-2xs, 12px);",
    "  color: var(--text-dim, #7C8DB0);",
    "  font-variant-numeric: tabular-nums;",
    "}",
    ".lyra-legend-refund .lyra-legend-amount { color: var(--rust, #F97316); }",
    ".lyra-legend-note { color: var(--rust-soft, #FBA968); }",
    ".lyra-legend-message {",
    "  animation: lyra-soft-in var(--dur-slower, 0.4s) ease-out var(--lyra-delay, 0s) backwards;",
    "}",
    ".lyra-tone-cash { --lyra-tone: var(--mint, #5FE0B0); }",
    ".lyra-tone-card { --lyra-tone: var(--blue-bright, #7FB0FF); }",
    ".lyra-tone-other { --lyra-tone: var(--violet, #9D8CFF); }",
    ".lyra-tone-neutral { --lyra-tone: var(--blue, #2F6AE4); }",
    "",
    "/* Motion off: no animation runs anywhere in a chart, so the resting styles",
    "   — the finished chart — are what is painted. */",
    "@media (prefers-reduced-motion: reduce) {",
    "  .lyra-chart, .lyra-chart * {",
    "    animation: none !important;",
    "    transition: none !important;",
    "  }",
    "}"
  ].join("\n");

  function injectStyles() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.appendChild(document.createTextNode(CSS));
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      // A chart still renders without its styling; it is never worth throwing.
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers. Everything that touches the document or a model goes
  // through one of these, which is why the renderers have no try/catch of
  // their own beyond the wrapper the public API installs.
  // ---------------------------------------------------------------------------

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    return node;
  }

  function svgEl(tag, cls) {
    var node = document.createElementNS(NS, tag);
    if (cls) node.setAttribute('class', cls);
    return node;
  }

  function setText(node, value) {
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  function resolve(target) {
    try {
      if (!target) return null;
      if (typeof target === 'string') return document.querySelector(target);
      if (target.nodeType === 1) return target;
    } catch (e) {
      // A bad selector is a missing chart, not an error.
    }
    return null;
  }

  function num(v) {
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : 0;
  }

  function r2(v) { return Math.round(v * 100) / 100; }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function isList(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function listOf(v, max) {
    if (!isList(v)) return [];
    return v.length > max ? v.slice(0, max) : v;
  }

  function obj(v) { return v && typeof v === 'object' ? v : {}; }

  // "R1,234.50", with the minus in front of the digits — the same shape
  // app.js prints, so a chart and the table beside it never disagree.
  function money(v, cur) {
    var n = num(v);
    var parts = Math.abs(n).toFixed(2).split('.');
    var lead = cur == null ? '' : String(cur);
    if (Number(parts[0]) === 0 && Number(parts[1]) === 0) return lead + '0.00';
    return lead + (n < 0 ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }

  // The axis is narrow, so it is allowed to say "R1.5k" where a tooltip says
  // "R1,500.00".
  function axisMoney(v, cur) {
    var n = num(v);
    var a = Math.abs(n);
    var lead = (cur == null ? '' : String(cur)) + (n < 0 ? '-' : '');
    if (a >= 1000000) return lead + trim1(a / 1000000) + 'M';
    if (a >= 1000) return lead + trim1(a / 1000) + 'k';
    if (a >= 10) return lead + trim1(a);
    if (a > 0) return lead + (a < 1 ? a.toFixed(2) : a.toFixed(1));
    return lead + '0';
  }

  function trim1(x) { return String(Math.round(x * 10) / 10); }

  function pctText(p) {
    var s = (Math.round(num(p) * 10) / 10).toFixed(1);
    return s.replace(/\.0$/, '') + '%';
  }

  function niceCeil(v) {
    if (!(v > 0) || !isFinite(v)) return 0;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = v / mag;
    for (var i = 0; i < NICE.length; i++) {
      if (n <= NICE[i] + 1e-9) return NICE[i] * mag;
    }
    return 10 * mag;
  }

  function titleEl(value) { return setText(el('div', 'lyra-title'), value); }
  function emptyEl(value) { return setText(el('div', 'lyra-empty'), value); }
  function tipEl(value) { return setText(svgEl('title'), value); }

  // Replace the host's contents in one go. Building the card off-document
  // first means a model that somehow blows up half way through leaves the old
  // chart in place rather than a half-painted one.
  function paint(host, node, kind) {
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(node);
    host.setAttribute('data-lyra-chart', kind);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  // Catmull-Rom through the points, with the control points pinned inside each
  // segment's own two values. That stops a spike or a refund day from
  // overshooting into money the shop never made, and guarantees the curve
  // stays inside the plot — so nothing here ever needs clipping.
  function smoothPath(pts) {
    var last = pts.length - 1;
    var d = 'M' + pts[0].x + ' ' + pts[0].y;
    var i, p0, p1, p2, p3, c1x, c1y, c2x, c2y, lo, hi;
    for (i = 0; i < last; i++) {
      p0 = pts[i === 0 ? 0 : i - 1];
      p1 = pts[i];
      p2 = pts[i + 1];
      p3 = pts[i + 2 > last ? last : i + 2];
      c1x = r2(p1.x + (p2.x - p0.x) / 6);
      c1y = p1.y + (p2.y - p0.y) / 6;
      c2x = r2(p2.x - (p3.x - p1.x) / 6);
      c2y = p2.y - (p3.y - p1.y) / 6;
      lo = Math.min(p1.y, p2.y);
      hi = Math.max(p1.y, p2.y);
      d += 'C' + c1x + ' ' + r2(clamp(c1y, lo, hi)) + ' ' + c2x + ' ' +
        r2(clamp(c2y, lo, hi)) + ' ' + p2.x + ' ' + p2.y;
    }
    return d;
  }

  // A clockwise arc from angle a0 to a1, both measured from twelve o'clock and
  // growing clockwise, which is the direction a ring is read in.
  function arcPath(cx, cy, r, a0, a1) {
    var x0 = r2(cx + r * Math.sin(a0));
    var y0 = r2(cy - r * Math.cos(a0));
    var x1 = r2(cx + r * Math.sin(a1));
    var y1 = r2(cy - r * Math.cos(a1));
    return 'M' + x0 + ' ' + y0 + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) +
      ' 1 ' + x1 + ' ' + y1;
  }

  // ---------------------------------------------------------------------------
  // The area chart
  // ---------------------------------------------------------------------------

  function renderArea(target, model) {
    var host = resolve(target);
    if (!host) return false;

    var m = obj(model);
    var cur = typeof m.currency === 'string' ? m.currency : '';
    var buckets = listOf(m.buckets, MAX_BUCKETS);

    var card = el('div', 'lyra-chart lyra-chart-area');
    if (m.title != null && String(m.title) !== '') card.appendChild(titleEl(m.title));

    // No buckets is not an error: the shop simply has not sold anything in
    // this period yet, so the panel says so and keeps its height.
    if (!buckets.length) {
      card.appendChild(emptyEl('Nothing to plot yet.'));
      return paint(host, card, 'area');
    }

    var i, n = buckets.length;
    var labels = [];
    var sales = [];
    var profit = [];
    for (i = 0; i < n; i++) {
      var b = obj(buckets[i]);
      labels.push(b.label == null ? '' : String(b.label));
      sales.push(num(b.sales));
      profit.push(num(b.profit));
    }

    // The data's own extremes, before zero is folded in: they decide whether
    // the period has any shape at all.
    var dataHi = -Infinity;
    var dataLo = Infinity;
    for (i = 0; i < n; i++) {
      if (sales[i] > dataHi) dataHi = sales[i];
      if (profit[i] > dataHi) dataHi = profit[i];
      if (sales[i] < dataLo) dataLo = sales[i];
      if (profit[i] < dataLo) dataLo = profit[i];
    }
    if (!isFinite(dataHi)) { dataHi = 0; dataLo = 0; }

    // A run that never varies should sit in the middle of the plot rather than
    // be pinned to the top edge pretending it nearly broke a record.
    if (dataHi === dataLo) {
      if (dataHi > 0) dataHi = dataHi * 1.5;
      else if (dataLo < 0) dataLo = dataLo * 1.5;
    }

    var hi = dataHi > 0 ? dataHi : 0;
    var lo = dataLo < 0 ? dataLo : 0;
    var yMax = niceCeil(hi);
    var yMin = lo < 0 ? -niceCeil(-lo) : 0;
    var flat = yMax === 0 && yMin === 0;   // every figure was zero or missing
    var span = yMax - yMin;

    var plotW = AREA_W - PAD.l - PAD.r;
    var plotH = AREA_H - PAD.t - PAD.b;
    var step = plotW / n;

    function yOf(v) {
      return flat ? PAD.t + plotH : PAD.t + ((yMax - v) / span) * plotH;
    }
    function xOf(ix) { return PAD.l + step * (ix + 0.5); }

    var zeroY = r2(yOf(0));
    var salesPts = [];
    var profitPts = [];
    for (i = 0; i < n; i++) {
      salesPts.push({ x: r2(xOf(i)), y: r2(yOf(sales[i])) });
      profitPts.push({ x: r2(xOf(i)), y: r2(yOf(profit[i])) });
    }

    // One bucket has no direction to draw in, so it is a short tick through
    // the point rather than a line of no length.
    function linePath(pts) {
      if (pts.length === 1) {
        var half = Math.min(plotW * 0.12, 26);
        return 'M' + r2(pts[0].x - half) + ' ' + pts[0].y + 'H' + r2(pts[0].x + half);
      }
      return smoothPath(pts);
    }

    // The area is the space between the line and the zero line, which is what
    // makes a refund day read as a dip below the gridline rather than as a
    // shape floating in space.
    function fillPath(pts) {
      if (pts.length < 2) return '';
      return smoothPath(pts) +
        'L' + pts[pts.length - 1].x + ' ' + zeroY +
        'L' + pts[0].x + ' ' + zeroY + 'Z';
    }

    var uid = 'lyra' + (renderArea.seq = (renderArea.seq || 0) + 1);
    var svg = svgEl('svg', 'lyra-svg lyra-area-svg');
    svg.setAttribute('viewBox', '0 0 ' + AREA_W + ' ' + AREA_H);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-label', m.title == null ? 'Takings and profit' : String(m.title));

    // Gradient ids are per-render so two charts of the same kind on one screen
    // cannot fight over them.
    if (n > 1) {
      var defs = svgEl('defs');
      defs.appendChild(gradientEl(uid + '-sales', 'lyra-stop-sales-up', 'lyra-stop-sales-down'));
      defs.appendChild(gradientEl(uid + '-profit', 'lyra-stop-profit-up', 'lyra-stop-profit-down'));
      svg.appendChild(defs);
    }

    // Grid and axis. A positive period gets the zero line and the top of the
    // scale; a period with refunds gets the zero line in its right place with
    // the scale running past it on both sides.
    var ticks = flat ? [0] : (yMin < 0 ? [yMin, 0, yMax] : [0, yMax]);
    var grid = svgEl('g');
    var axis = svgEl('g');
    for (i = 0; i < ticks.length; i++) {
      var ty = r2(Math.round(yOf(ticks[i])) + 0.5);   // +0.5 keeps a hairline a hairline
      var line = svgEl('line', ticks[i] === 0 ? 'lyra-gridline lyra-gridline-zero' : 'lyra-gridline');
      line.setAttribute('x1', PAD.l);
      line.setAttribute('x2', AREA_W - PAD.r);
      line.setAttribute('y1', ty);
      line.setAttribute('y2', ty);
      grid.appendChild(line);

      var yText = svgEl('text', 'lyra-tick');
      yText.setAttribute('x', PAD.l - 10);
      yText.setAttribute('y', r2(yOf(ticks[i]) + 4.5));
      yText.setAttribute('text-anchor', 'end');
      setText(yText, axisMoney(ticks[i], cur));
      axis.appendChild(yText);
    }

    if (n > 1) {
      var salesFill = svgEl('path', 'lyra-fill lyra-fill-sales');
      salesFill.setAttribute('d', fillPath(salesPts));
      salesFill.setAttribute('fill', 'url(#' + uid + '-sales)');
      svg.appendChild(salesFill);

      var profitFill = svgEl('path', 'lyra-fill lyra-fill-profit');
      profitFill.setAttribute('d', fillPath(profitPts));
      profitFill.setAttribute('fill', 'url(#' + uid + '-profit)');
      svg.appendChild(profitFill);
    }

    svg.appendChild(grid);

    var salesLine = svgEl('path', 'lyra-line lyra-line-sales');
    salesLine.setAttribute('d', linePath(salesPts));
    salesLine.setAttribute('pathLength', '1');
    svg.appendChild(salesLine);

    var profitLine = svgEl('path', 'lyra-line lyra-line-profit');
    profitLine.setAttribute('d', linePath(profitPts));
    profitLine.setAttribute('pathLength', '1');
    svg.appendChild(profitLine);

    // Points pop as the line reaches them: the delay is the fraction of the
    // line still to draw, so the two animations read as one gesture.
    var dots = svgEl('g');
    var hitR = r2(Math.max(7, Math.min(11, step * 0.45)));
    for (i = 0; i < n; i++) {
      var g = svgEl('g', 'lyra-point');
      g.style.setProperty('--lyra-delay', Math.round(120 + (DRAW_MS - 300) * ((i + 0.5) / n)) + 'ms');

      var hit = svgEl('circle', 'lyra-hit');
      hit.setAttribute('cx', salesPts[i].x);
      hit.setAttribute('cy', salesPts[i].y);
      hit.setAttribute('r', hitR);
      hit.appendChild(tipEl((labels[i] ? labels[i] + ' — ' : '') +
        'Takings ' + money(sales[i], cur) + ' · Profit ' + money(profit[i], cur)));

      var dot = svgEl('circle', 'lyra-dot');
      dot.setAttribute('cx', salesPts[i].x);
      dot.setAttribute('cy', salesPts[i].y);
      dot.setAttribute('r', 3.4);
      // Scaled about its own centre. The origin is given in view-box units
      // rather than left to transform-box so the pop works on any engine that
      // can transform an SVG shape at all.
      dot.style.setProperty('transform-origin', salesPts[i].x + 'px ' + salesPts[i].y + 'px');

      g.appendChild(hit);
      g.appendChild(dot);
      dots.appendChild(g);
    }
    svg.appendChild(dots);

    // X labels run backwards from the newest bucket so "today" is always
    // named, and only every stride-th one is drawn — the labels can then never
    // collide, however long the period is.
    var stride = Math.max(1, Math.ceil(n / X_LABEL_CAP));
    for (i = n - 1; i >= 0; i -= stride) {
      var anchor = n === 1 ? 'middle' : (i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'));
      var xText = svgEl('text', 'lyra-tick');
      xText.setAttribute('x', r2(clamp(xOf(i), PAD.l, AREA_W - PAD.r)));
      xText.setAttribute('y', AREA_H - 8);
      xText.setAttribute('text-anchor', anchor);
      setText(xText, labels[i]);
      axis.appendChild(xText);
    }
    svg.appendChild(axis);

    card.appendChild(svg);
    return paint(host, card, 'area');
  }

  function gradientEl(id, topClass, bottomClass) {
    var grad = svgEl('linearGradient');
    grad.setAttribute('id', id);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    grad.setAttribute('gradientUnits', 'objectBoundingBox');

    var top = svgEl('stop', topClass);
    top.setAttribute('offset', '0');
    grad.appendChild(top);

    var bottom = svgEl('stop', bottomClass);
    bottom.setAttribute('offset', '1');
    grad.appendChild(bottom);
    return grad;
  }

  // ---------------------------------------------------------------------------
  // The donut
  // ---------------------------------------------------------------------------

  function donutItems(raw) {
    var list = isList(raw) ? raw : [];
    var items = [];
    var i, s, v;
    for (i = 0; i < list.length && i < MAX_SLICES; i++) {
      s = obj(list[i]);
      v = num(s.value);
      items.push({
        label: s.label == null ? '' : String(s.label),
        value: v,
        tone: s.tone === 'cash' || s.tone === 'card' || s.tone === 'other' ? s.tone : 'neutral',
        pct: null
      });
    }
    // Anything past the cap is folded into one slice rather than dropped, so
    // the ring still adds up to the money that came in.
    if (list.length > MAX_SLICES) {
      var rest = 0;
      for (i = MAX_SLICES; i < list.length; i++) {
        v = num(obj(list[i]).value);
        if (v > 0) rest += v;
      }
      if (rest > 0) items.push({ label: 'Other', value: rest, tone: 'other', pct: null });
    }
    return items;
  }

  function renderDonut(target, model) {
    var host = resolve(target);
    if (!host) return false;

    var m = obj(model);
    var cur = typeof m.currency === 'string' ? m.currency : '';
    var items = donutItems(m.slices);

    var positiveSum = 0;
    var positives = 0;
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i].value > 0) {
        positiveSum += items[i].value;
        positives++;
      }
    }
    // Percentages are of the money actually in the ring: refunds are money
    // going the other way, and dividing by a total that includes them would
    // make every slice on a refund day wrong.
    for (i = 0; i < items.length; i++) {
      if (items[i].value > 0 && positiveSum > 0) items[i].pct = (items[i].value / positiveSum) * 100;
    }

    var card = el('div', 'lyra-chart lyra-chart-donut');
    if (m.title != null && String(m.title) !== '') card.appendChild(titleEl(m.title));

    var svg = svgEl('svg', 'lyra-svg lyra-donut-svg');
    svg.setAttribute('viewBox', '0 0 ' + DONUT_BOX + ' ' + DONUT_BOX);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-label', m.title == null ? 'Where the money came from' : String(m.title));

    // The track is the empty ring: it shows through the gaps between slices,
    // and on a day with nothing to show it is the whole picture.
    var track = svgEl('circle', 'lyra-ring-track');
    track.setAttribute('cx', DONUT_C);
    track.setAttribute('cy', DONUT_C);
    track.setAttribute('r', DONUT_R);
    svg.appendChild(track);

    // Slices sweep clockwise from twelve o'clock, each drawn from its own
    // start angle, staggered so the ring reads as one movement.
    var angle = 0;
    for (i = 0; i < items.length && positiveSum > 0; i++) {
      var item = items[i];
      if (item.value <= 0) continue;   // refunds stay in the legend, out of the ring

      var frac = item.value / positiveSum;
      var a0 = angle;
      var a1 = angle + frac * TWO_PI;
      angle = a1;

      var arc;
      if (frac > 0.9999) {
        // An arc from a point back to itself draws nothing, so a single slice
        // that took everything is a circle, turned to begin at the top.
        arc = svgEl('circle', 'lyra-slice lyra-tone-' + item.tone);
        arc.setAttribute('cx', DONUT_C);
        arc.setAttribute('cy', DONUT_C);
        arc.setAttribute('r', DONUT_R);
        arc.setAttribute('transform', 'rotate(-90 ' + DONUT_C + ' ' + DONUT_C + ')');
      } else {
        // Leave an even gap between neighbours, but never shrink a small
        // slice out of existence.
        var half = positives > 1 ? DONUT_GAP / 2 : 0;
        var b0 = a0 + half;
        var b1 = a1 - half;
        if (b1 - b0 < DONUT_STUB) {
          var mid = (a0 + a1) / 2;
          b0 = mid - DONUT_STUB / 2;
          b1 = mid + DONUT_STUB / 2;
        }
        arc = svgEl('path', 'lyra-slice lyra-tone-' + item.tone);
        arc.setAttribute('d', arcPath(DONUT_C, DONUT_C, DONUT_R, b0, b1));
      }
      arc.setAttribute('pathLength', '1');
      arc.style.setProperty('--lyra-dur', Math.round(clamp(frac * SWEEP_MS, 220, SWEEP_MS)) + 'ms');
      arc.style.setProperty('--lyra-delay', Math.round(80 + SWEEP_MS * (a0 / TWO_PI)) + 'ms');
      arc.appendChild(tipEl((item.label ? item.label + ' — ' : '') + money(item.value, cur) +
        (item.pct == null ? '' : ' (' + pctText(item.pct) + ')')));
      svg.appendChild(arc);
    }

    var label = m.centreLabel == null ? '' : String(m.centreLabel);
    if (label) {
      var labelText = svgEl('text', 'lyra-centre-label');
      labelText.setAttribute('x', DONUT_C);
      labelText.setAttribute('y', DONUT_C - 7);
      setText(labelText, label);
      svg.appendChild(labelText);
    }
    if (m.centreValue != null && m.centreValue !== '') {
      var valueText = svgEl('text', 'lyra-centre-value');
      valueText.setAttribute('x', DONUT_C);
      valueText.setAttribute('y', DONUT_C + 17);
      setText(valueText, typeof m.centreValue === 'number' ? money(m.centreValue, cur) : String(m.centreValue));
      svg.appendChild(valueText);
    }

    var plot = el('div', 'lyra-donut-plot');
    plot.appendChild(svg);

    var body = el('div', 'lyra-donut-body');
    body.appendChild(plot);

    if (!items.length) {
      body.appendChild(setText(el('div', 'lyra-empty lyra-donut-empty'), 'Nothing to show yet.'));
    } else {
      var legend = el('ul', 'lyra-legend');
      if (positiveSum <= 0) {
        // All zero, or refunds only: the ring is empty and the legend says
        // why rather than dividing by nothing.
        legend.appendChild(setText(el('li', 'lyra-legend-message lyra-empty'), 'Nothing to show yet.'));
      }
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        var row = el('li', 'lyra-legend-item lyra-tone-' + it.tone + (it.value < 0 ? ' lyra-legend-refund' : ''));
        row.style.setProperty('--lyra-delay', Math.round(120 + i * ROW_MS) + 'ms');
        row.appendChild(el('span', 'lyra-swatch'));
        row.appendChild(setText(el('span', 'lyra-legend-label'), it.label === '' ? '—' : it.label));
        row.appendChild(setText(el('span', 'lyra-legend-amount'), money(it.value, cur)));
        row.appendChild(setText(
          el('span', it.value < 0 ? 'lyra-legend-pct lyra-legend-note' : 'lyra-legend-pct'),
          it.pct != null ? pctText(it.pct) : (it.value < 0 ? 'not in ring' : '—')
        ));
        legend.appendChild(row);
      }
      body.appendChild(legend);
    }

    card.appendChild(body);
    return paint(host, card, 'donut');
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  function clearHost(target) {
    var host = resolve(target);
    if (!host) return false;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.removeAttribute('data-lyra-chart');
    return true;
  }

  // A chart is decoration. Whatever a model contains, the till keeps ringing
  // up: an unexpected failure is logged once and reported as a false return.
  function guarded(fn) {
    return function (target, model) {
      try {
        return fn(target, model);
      } catch (err) {
        try {
          if (window.console && console.warn) {
            console.warn('LyraCharts:', err && err.message ? err.message : err);
          }
        } catch (e) { /* even the report is optional */ }
        return false;
      }
    };
  }

  injectStyles();

  window.LyraCharts = {
    area: guarded(renderArea),
    donut: guarded(renderDonut),
    clear: guarded(clearHost)
  };
})();
