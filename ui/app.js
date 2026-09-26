(() => {
  'use strict';

  let DATA = null;
  let cart = [];                  // [{productId, name, price, qty}]
  let activeCategory = 'All';
  let currentSaleForReceipt = null;
  let currentReceiptIsHistorical = false;
  let editingProductId = null;
  let unlocked = false;           // session-only; app always boots locked (Client mode)
  let pendingUnlockView = null;
  let pendingConfirmAction = null;
  let importParsed = null;        // {fileName, headers, rows}

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const PROTECTED_VIEWS = ['dashboard', 'reports', 'settings'];

  function money(n) {
    const v = Number(n || 0);
    return DATA.settings.currency + v.toFixed(2);
  }

  // The same as money(), with a comma every three digits — "R1,234,567.00"
  // rather than "R1234567.00" — for figures that are read rather than rung up.
  function moneyGrouped(n) {
    const v = Number(n || 0);
    const parts = Math.abs(v).toFixed(2).split('.');
    return DATA.settings.currency + (v < 0 ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }
  function fmt(n) { return Number(n || 0).toFixed(2); }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nextProductId() { return 'p' + (DATA.nextProductId++); }

  async function persist() { await window.pos.saveData(DATA); }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function debounce(fn, wait) {
    let h;
    return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), wait); };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // What counts as a search hit: the product's name, its SKU/barcode, or the
  // shop's own short name for it — so typing "mp" can bring up Puppy Food.
  // One helper, so the Till, Stock and the bulk selector can never disagree.
  function matchesQuery(p, q) {
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.alias || '').toLowerCase().includes(q);
  }

  const MODAL_CLOSE_MS = 200;
  function openModal(el) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    // Invalidate any pending close from a previous open, so a fast
    // close-then-reopen (e.g. reset flows) can't have this new open
    // clobbered by a stale timeout finishing later.
    el.dataset.openToken = String(Number(el.dataset.openToken || 0) + 1);
    el.classList.remove('closing');
    el.classList.add('active');
  }
  function closeModal(el) {
    if (typeof el === 'string') el = $(el);
    if (!el || !el.classList.contains('active')) return;
    const token = el.dataset.openToken;
    el.classList.add('closing');
    setTimeout(() => {
      if (el.dataset.openToken !== token) return; // a newer open superseded this close
      el.classList.remove('active');
      el.classList.remove('closing');
      // Whatever the modal was for (a finished sale, an edit), the next thing
      // that usually happens is a scan — so hand the keyboard back to the
      // barcode box rather than leaving it wherever the modal left it. This is
      // what stopped scans landing in the tendered-amount field after a sale.
      // Stock has the same problem and the same answer: after adding, editing or
      // deleting a product the next thing is usually a search, and without this
      // the caret was left on a button inside a dialog that had just been hidden,
      // so typing went nowhere at all.
      if ($('#view-till').classList.contains('active')) focusScanTarget();
      if ($('#view-stock').classList.contains('active')) focusStockFilter();
    }, MODAL_CLOSE_MS);
  }

  // In-app replacement for window.confirm(). Native confirm() blocks the
  // whole renderer and can appear behind the window or lose focus on some
  // Windows setups, which makes the app look frozen/unresponsive. Returns
  // a Promise<boolean> resolved when the person picks Confirm or Cancel.
  function confirmDialog(title, body, confirmLabel) {
    return new Promise((resolve) => {
      $('#confirmModalTitle').textContent = title;
      $('#confirmModalBody').textContent = body;
      $('#confirmModalOkBtn').textContent = confirmLabel || 'Confirm';
      const overlay = $('#confirmModalOverlay');
      const okBtn = $('#confirmModalOkBtn');
      const cancelBtn = $('#confirmModalCancelBtn');

      const cleanup = () => {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onBackdrop);
      };
      const onOk = () => { cleanup(); closeModal(overlay); resolve(true); };
      const onCancel = () => { cleanup(); closeModal(overlay); resolve(false); };
      const onBackdrop = (e) => { if (e.target === overlay) onCancel(); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      openModal(overlay);
      setTimeout(() => okBtn.focus(), 50);
    });
  }

  // The Admin Key is hashed on the Rust side, so the stored hash is exactly the
  // one this app has always written and a key set in an earlier build still
  // unlocks the till here.
  function hashAdminKey(text) { return window.pos.hashAdminKey(text); }

  // ---------------- Navigation ----------------

  // Tucking the product list away gives the receipt the whole window, which is
  // what a shop wants when the customer is watching the tape rather than the
  // catalogue. The running total then sits in the same place on the screen.
  function initCatalogToggle() {
    const btn = $('#hideItemsBtn');
    const grid = document.querySelector('.till-grid');
    if (!btn || !grid) return;
    btn.addEventListener('click', () => {
      const hidden = grid.classList.toggle('catalog-hidden');
      btn.textContent = hidden ? 'Show items' : 'Hide items';
      btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      if (!hidden) { renderCatalog(); focusScanTarget(); }
    });
  }

  function initNav() {
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => attemptSwitchView(btn.dataset.view));
    });
    window.addEventListener('resize', debounce(updateNavPill, 100));
  }

  function attemptSwitchView(view) {
    if (PROTECTED_VIEWS.includes(view) && !unlocked) {
      openAdminModal('unlock', view);
      return;
    }
    switchView(view);
  }

  const VIEW_ORDER = ['till', 'stock', 'ledger', 'dashboard', 'reports', 'settings'];
  let currentViewIndex = 0;

  function switchView(view) {
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    updateNavPill();

    const newIndex = VIEW_ORDER.indexOf(view);
    const dir = newIndex === currentViewIndex ? 'none' : (newIndex > currentViewIndex ? 'forward' : 'back');
    currentViewIndex = newIndex;

    $$('.view').forEach(v => { v.classList.remove('active', 'dir-forward', 'dir-back', 'dir-none'); });
    const target = $('#view-' + view);
    target.classList.add('active', 'dir-' + dir);

    if (view === 'stock') { renderStock(); focusStockFilter(); }
    if (view === 'ledger') renderLedger();
    if (view === 'dashboard') renderDashboard();
    if (view === 'reports') renderReports();
    if (view === 'settings') renderSettings();
    if (view === 'till') { renderCatalog(); renderDaySummary(); focusScanTarget(); }
  }

  // The pill's geometry only changes when the window is resized, but this used to
  // read offsetTop/offsetHeight on every single view switch — a forced layout of
  // the whole document, which got slower the more rows the tables were holding.
  const navPillMetrics = new Map();
  window.addEventListener('resize', () => navPillMetrics.clear());

  function updateNavPill() {
    const activeBtn = document.querySelector('.nav-btn.active');
    const pill = $('#navPill');
    if (!activeBtn || !pill) return;
    let metrics = navPillMetrics.get(activeBtn);
    if (!metrics) {
      metrics = { top: activeBtn.offsetTop, height: activeBtn.offsetHeight };
      navPillMetrics.set(activeBtn, metrics);
    }
    pill.style.transform = `translateY(${metrics.top}px)`;
    pill.style.height = metrics.height + 'px';
  }

  function initClock() {
    const tick = () => {
      const d = new Date();
      $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 15000);
  }

  // ---------------- Admin lock / Client mode ----------------

  function applyLockUI() {
    $$('.nav-protected').forEach(b => b.classList.toggle('locked', !unlocked));
    const btn = $('#lockToggleBtn');
    const icon = $('#lockToggleIcon');
    const label = $('#lockToggleLabel');
    btn.classList.toggle('is-locked', !unlocked);
    icon.textContent = unlocked ? '🔓' : '🔒';
    label.textContent = unlocked ? 'Admin unlocked' : 'Client mode';
  }

  function lockApp() {
    unlocked = false;
    applyLockUI();
    switchView('till');
    toast('Locked to Client mode.');
  }

  function openAdminModal(mode, targetView, opts) {
    pendingUnlockView = targetView || null;
    const overlay = $('#adminModalOverlay');
    const isCreate = mode === 'create';
    $('#adminModalTitle').textContent = (opts && opts.title) || (isCreate ? 'Create an Admin Key' : 'Enter Admin Key');
    $('#adminModalNote').textContent = (opts && opts.note) || (isCreate
      ? 'Set an Admin Key now — whoever manages the shop will need this to leave Client mode.'
      : 'Leaving Client mode requires the Admin Key.');
    $('#adminUnlockFields').style.display = isCreate ? 'none' : 'block';
    $('#adminCreateFields').style.display = isCreate ? 'block' : 'none';
    $('#adminCancelBtn').style.display = isCreate ? 'none' : 'inline-flex';
    $('#adminConfirmBtn').textContent = (opts && opts.confirmLabel) || (isCreate ? 'Save Admin Key' : 'Unlock');
    $('#adminKeyInput').value = '';
    $('#adminKeyCreateInput').value = '';
    $('#adminKeyConfirmInput').value = '';
    overlay.dataset.mode = mode;
    openModal(overlay);
    setTimeout(() => (isCreate ? $('#adminKeyCreateInput') : $('#adminKeyInput')).focus(), 50);
  }

  // Re-asks for the Admin Key even if already unlocked, then runs `action`.
  // Used as a step-up confirmation gate in front of destructive operations.
  function requireAdminConfirmation(action, opts) {
    pendingConfirmAction = action;
    openAdminModal('unlock', null, opts);
  }

  // Stock and the Ledger are wide open in Client mode: whoever is on the till can
  // check what's left, add or change a product, look a sale up, reprint it, or
  // hand money back. Only Overview, Reports and Setup are held back, and the
  // two Danger Zone resets still ask for the key again on top of that (see
  // requireAdminConfirmation above).

  function initAdminModal() {
    $('#adminCancelBtn').addEventListener('click', () => {
      pendingConfirmAction = null;
      closeModal('#adminModalOverlay');
    });

    $('#adminConfirmBtn').addEventListener('click', async () => {
      const overlay = $('#adminModalOverlay');
      const mode = overlay.dataset.mode;

      if (mode === 'create') {
        const key = $('#adminKeyCreateInput').value;
        const confirm = $('#adminKeyConfirmInput').value;
        if (!key || key.length < 4) { toast('Admin Key should be at least 4 characters.'); return; }
        if (key !== confirm) { toast("Those don't match. Try again."); return; }
        DATA.settings.adminKeyHash = await hashAdminKey(key);
        await persist();
        closeModal(overlay);
        unlocked = true;
        applyLockUI();
        toast('Admin Key saved. You are unlocked for this session.');
      } else {
        const key = $('#adminKeyInput').value;
        const hash = await hashAdminKey(key || '');
        if (hash !== DATA.settings.adminKeyHash) { toast('Incorrect Admin Key.'); return; }
        closeModal(overlay);
        unlocked = true;
        applyLockUI();
        if (pendingConfirmAction) {
          const action = pendingConfirmAction;
          pendingConfirmAction = null;
          action();
        } else if (pendingUnlockView) {
          switchView(pendingUnlockView);
        }
        pendingUnlockView = null;
      }
    });

    // Enter key submits whichever field is focused
    ['adminKeyInput', 'adminKeyConfirmInput'].forEach(id => {
      $('#' + id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#adminConfirmBtn').click(); });
    });

    $('#lockToggleBtn').addEventListener('click', () => {
      if (unlocked) lockApp();
      else openAdminModal('unlock', null);
    });
  }

  // ---------------- Barcode scanning ----------------
  // Most scanners act as a fast keyboard: they type the code, then press Enter.
  // Keystrokes are buffered document-wide, so a scan still registers when the
  // barcode box isn't focused (straight after a sale, or after clicking
  // anywhere); the box's own contents are considered as well, because that is
  // where a scanner's characters land when it *is* focused. On Enter the
  // candidate that actually resolves to a product wins, so a slow scanner — or
  // a stale code left in the box — can't make a scan quietly disappear.

  function initBarcodeScanning() {
    let buffer = '';
    let lastTime = 0;
    // Deliberately generous. A cheap scanner is near-instant, but a wireless one
    // can be well over 100ms per character, and a busy till adds jitter of its
    // own — so a tight threshold is exactly what made scans intermittent.
    const FAST_GAP_MS = 150;
    const ENTER_GAP_MS = 500;  // last character to Enter
    const MIN_LEN = 2;         // shop codes can be as short as "A1"

    document.addEventListener('keydown', (e) => {
      const now = Date.now();
      const gap = now - lastTime;
      lastTime = now;

      // Ignore navigation/modifier keys, but let printable characters and Enter through.
      if (e.key === 'Enter') {
        const burst = (buffer.length >= MIN_LEN && gap < ENTER_GAP_MS) ? buffer : '';
        buffer = '';
        handleScanEnter(burst, e);
        return;
      }
      if (e.key.length !== 1) return; // ignore Shift, Tab, arrows, etc.

      if (gap > FAST_GAP_MS) buffer = ''; // too slow to be a scanner burst; restart
      buffer += e.key;

      // Safety cap
      if (buffer.length > 40) buffer = buffer.slice(-40);
    }, true);
  }

  // True when the keystrokes belong to some other field — the product editor's
  // SKU box, a modal's inputs, the stock filter — which must never be hijacked.
  function isForeignTypingField(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    const isTypingField = tag === 'input' || tag === 'select' || tag === 'textarea';
    return isTypingField && el.id !== 'productSearch';
  }

  // Resolves scanned/typed text to a product, with no side effects — no toasts,
  // no cart, no DOM — so several candidates for the same scan can be tried
  // before committing to one. An exact SKU/barcode wins; otherwise the text is
  // treated as a search and only counts once it has narrowed to a single
  // product, so a half-typed word can never add the wrong thing.
  function resolveScanText(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { product: null, matches: null, text: '' };
    const lower = t.toLowerCase();
    const bySku = DATA.products.find(p => (p.sku || '').toLowerCase() === lower);
    if (bySku) return { product: bySku, matches: null, text: t };
    const matches = DATA.products.filter(p => matchesQuery(p, lower));
    return { product: matches.length === 1 ? matches[0] : null, matches, text: t };
  }

  // What one Enter press should be taken to mean. Both places a scan can land
  // are considered; the one that resolves to a product wins, and if neither does
  // the barcode box is used, which is what a person typed.
  function bestScanText(burst) {
    const input = $('#productSearch');
    const candidates = [];
    [input ? input.value : '', burst].forEach(t => {
      const trimmed = String(t == null ? '' : t).trim();
      if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
    });
    return candidates.find(t => resolveScanText(t).product) || candidates[0] || '';
  }

  function handleScanEnter(burst, evt) {
    // Taking payment: Enter completes the sale, and is never read as a scan here,
    // so a code left in the barcode box cannot add an item to a sale that is
    // being paid for. Nothing happens while the dialog is animating shut either,
    // so an Enter right after Cancel cannot complete it by accident.
    const chargeOverlay = $('#chargeModalOverlay');
    if (chargeOverlay.classList.contains('active') && !chargeOverlay.classList.contains('closing')) {
      evt.preventDefault();
      completeSale();
      return;
    }
    // Somewhere else entirely is being typed into; leave it alone.
    if (isForeignTypingField(document.activeElement)) return;
    commitScan(bestScanText(burst));
    evt.preventDefault();
  }

  // Adds what was scanned, or what was typed into the barcode/search box, and
  // clears that box so the next scan starts clean. Returns true when something
  // went into the sale.
  function commitScan(typed) {
    const text = String(typed == null ? '' : typed).trim();
    const input = $('#productSearch');
    if (!text) return false;
    if (!$('#view-till').classList.contains('active')) return false;

    const { product, matches } = resolveScanText(text);

    if (!product) {
      toast(matches && matches.length > 1
        ? matches.length + ' products match "' + text + '" — narrow it down.'
        : 'No product matches "' + text + '"');
      // An unrecognised code is left on screen so it can be read and re-typed —
      // selected, so the next scan replaces it instead of being glued onto it.
      if (input) {
        input.value = text;
        renderCatalog();
        shakeSearchBox(input);
        focusScanTarget();
        input.select();
      }
      return false;
    }

    // The box is emptied before the add is attempted. Leaving the code behind
    // when the item couldn't go in (nothing left in stock) used to mean the next
    // scan was appended to it, which then matched nothing at all.
    const boxHadText = !!input && input.value !== '';
    if (input) input.value = '';
    pulseTapeBody();
    const added = addToCart(product);
    if (boxHadText) renderCatalog();
    focusScanTarget();
    if (!added) return false;
    toast('Added: ' + product.name);
    return true;
  }

  function shakeSearchBox(input) {
    if (!input) return;
    input.classList.remove('shake-error');
    void input.offsetWidth;
    input.classList.add('shake-error');
  }


  function focusScanTarget() {
    const el = $('#productSearch');
    if (el && document.activeElement !== el) {
      // Don't steal focus from a modal that might be open.
      if (!$$('.modal-overlay.active').length) el.focus({ preventScroll: true });
    }
  }

  // ---------------- Till / catalog ----------------

  // How many product cards the Till draws at once. Shops can carry thousands of
  // products; drawing them all on every keystroke is what makes a till feel
  // slow, so the list is capped once it gets long (searching narrows it).
  const MAX_CATALOG_CARDS = 120;

  function renderCategoryChips() {
    const row = $('#categoryChips');
    const cats = ['All', ...DATA.categories];
    row.innerHTML = '';
    cats.forEach(c => {
      const chip = document.createElement('button');
      chip.className = 'chip' + (activeCategory === c ? ' active' : '');
      chip.textContent = c;
      chip.addEventListener('click', () => { activeCategory = c; renderCatalog(); });
      row.appendChild(chip);
    });
  }

  // Which products the grid drew last time, so the cards only animate in when
  // the list itself changes. Without this the pop-in ran again on every redraw
  // — adding one item to the sale was enough — and a screenful of cards
  // restarting their animation is exactly what makes a till feel jittery.
  let catalogueSignature = null;

  function renderCatalog() {
    renderCategoryChips();
    const q = ($('#productSearch').value || '').trim().toLowerCase();
    const grid = $('#productGrid');
    // If the category on screen has just been deleted, fall back to everything.
    if (activeCategory !== 'All' && !DATA.categories.includes(activeCategory)) activeCategory = 'All';

    const items = DATA.products.filter(p =>
      (activeCategory === 'All' || p.category === activeCategory) && matchesQuery(p, q)
    ).sort((a, b) => a.name.localeCompare(b.name));

    if (!items.length) {
      catalogueSignature = null;
      grid.innerHTML = '<div class="tape-empty" style="grid-column:1/-1;">No products match. Add stock from the Stock tab, or scan a barcode.</div>';
      return;
    }

    // A shop can hold thousands of products, and drawing every one of them on
    // every keystroke is what makes the Till feel slow. Only the first screenful
    // is drawn once the list gets long — typing in the search box narrows it.
    const shown = items.slice(0, MAX_CATALOG_CARDS);
    const signature = shown.map(p => p.id).join(',');
    grid.classList.toggle('grid-settled', signature === catalogueSignature);
    catalogueSignature = signature;
    let html = '';
    shown.forEach(p => {
      const outOfStock = p.stock <= 0;
      const low = p.stock > 0 && p.stock <= DATA.settings.lowStockThreshold;
      html += `<button class="product-card${outOfStock ? ' out-of-stock' : ''}" data-id="${p.id}"${outOfStock ? ' disabled' : ''}>
        <div class="product-card-name">${escapeHtml(p.name)}${p.alias ? ' <span class="row-sub">' + escapeHtml(p.alias) + '</span>' : ''}</div>
        <div class="product-card-meta">
          <span class="product-card-price">${money(p.price)}</span>
          <span class="product-card-stock ${low ? 'low' : ''}">${outOfStock ? 'Out of stock' : p.stock + ' left'}</span>
        </div>
      </button>`;
    });
    if (items.length > shown.length) {
      html += `<div class="tape-empty" style="grid-column:1/-1;">Showing ${shown.length} of ${items.length} products — type to narrow the list.</div>`;
    }
    grid.innerHTML = html;
  }

  function flyToCart(sourceEl) {
    const target = $('.receipt-tape');
    if (!sourceEl || !target) return;
    const sRect = sourceEl.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const startX = sRect.left + sRect.width / 2;
    const startY = sRect.top + sRect.height / 2;
    const endX = tRect.left + tRect.width / 2;
    const endY = tRect.top + 46;

    const ghost = document.createElement('div');
    ghost.className = 'fly-ghost';
    ghost.style.left = (startX - 7) + 'px';
    ghost.style.top = (startY - 7) + 'px';
    ghost.style.opacity = '1';
    document.body.appendChild(ghost);

    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${endX - startX}px, ${endY - startY}px) scale(0.25)`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 480);

    sourceEl.classList.add('card-tapped');
    setTimeout(() => sourceEl.classList.remove('card-tapped'), 200);
  }

  function pulseTapeBody() {
    const body = $('.tape-body');
    if (!body) return;
    body.classList.remove('receiving');
    void body.offsetWidth;
    body.classList.add('receiving');
    setTimeout(() => body.classList.remove('receiving'), 450);
  }

  function addToCart(product) {
    const existing = cart.find(i => i.productId === product.id);
    const inCart = existing ? existing.qty : 0;
    if (inCart + 1 > product.stock) {
      toast('Not enough stock left for ' + product.name);
      return false;
    }
    if (existing) existing.qty += 1;
    else cart.push({ productId: product.id, name: product.name, price: product.price, qty: 1 });
    renderCart(existing ? product.id : null);
    return true;
  }

  function changeQty(productId, delta) {
    const item = cart.find(i => i.productId === productId);
    if (!item) return;
    const product = DATA.products.find(p => p.id === productId);
    const newQty = item.qty + delta;
    if (newQty <= 0) {
      cart = cart.filter(i => i.productId !== productId);
    } else if (product && newQty > product.stock) {
      toast('Only ' + product.stock + ' in stock.');
      return;
    } else {
      item.qty = newQty;
    }
    renderCart(newQty > 0 ? productId : null);
  }

  function removeFromCart(productId) {
    cart = cart.filter(i => i.productId !== productId);
    renderCart();
  }

  function cartTotals() {
    const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
    const tax = subtotal * (DATA.settings.taxRate / 100);
    const total = subtotal + tax;
    return { subtotal, tax, total };
  }

  function buildCartRow(item) {
    const row = document.createElement('div');
    row.className = 'tape-line line-enter';
    row.dataset.pid = item.productId;
    row.innerHTML = `
      <span class="tape-line-name">${escapeHtml(item.name)}</span>
      <span class="tape-line-qty">
        <button class="qty-btn" data-act="dec">−</button>
        <span class="tape-line-qty-num">${item.qty}</span>
        <button class="qty-btn" data-act="inc">+</button>
      </span>
      <span class="tape-line-total">${fmt(item.price * item.qty)}</span>
      <span class="tape-line-remove" data-act="rm">✕</span>
    `;
    row.querySelector('[data-act=inc]').addEventListener('click', () => changeQty(item.productId, 1));
    row.querySelector('[data-act=dec]').addEventListener('click', () => changeQty(item.productId, -1));
    row.querySelector('[data-act=rm]').addEventListener('click', () => {
      row.classList.add('line-exit');
      setTimeout(() => removeFromCart(item.productId), 200);
    });
    row.addEventListener('animationend', (e) => { if (e.animationName === 'lineEnter') row.classList.remove('line-enter'); });
    return row;
  }

  let prevTotalDisplay = '0.00';

  function renderCart(pulseProductId) {
    const wrap = $('#tapeItems');
    $('#tapeMeta').textContent = cart.length ? cart.reduce((s, i) => s + i.qty, 0) + ' item(s)' : 'New sale';

    if (!cart.length) {
      wrap.innerHTML = '<div class="tape-empty">Cart is empty. Tap a product, or scan a barcode.</div>';
    } else {
      const emptyEl = wrap.querySelector('.tape-empty');
      if (emptyEl) wrap.innerHTML = '';

      const existingRows = {};
      wrap.querySelectorAll('.tape-line').forEach(el => { existingRows[el.dataset.pid] = el; });

      const seen = new Set();
      cart.forEach((item, idx) => {
        seen.add(item.productId);
        let row = existingRows[item.productId];
        if (!row) {
          row = buildCartRow(item);
          const ref = wrap.children[idx] || null;
          wrap.insertBefore(row, ref);
        } else {
          row.querySelector('.tape-line-qty-num').textContent = item.qty;
          row.querySelector('.tape-line-total').textContent = fmt(item.price * item.qty);
          if (pulseProductId === item.productId) {
            row.classList.remove('pulse');
            void row.offsetWidth;
            row.classList.add('pulse');
          }
        }
      });

      Object.keys(existingRows).forEach(pid => {
        if (!seen.has(pid)) {
          const row = existingRows[pid];
          if (!row.classList.contains('line-exit')) {
            row.classList.add('line-exit');
            setTimeout(() => row.remove(), 220);
          }
        }
      });
    }

    const t = cartTotals();
    $('#tapeSubtotal').textContent = fmt(t.subtotal);
    $('#tapeTax').textContent = fmt(t.tax);
    const newTotalDisplay = fmt(t.total);
    const totalEl = $('#tapeTotal');
    totalEl.textContent = newTotalDisplay;
    if (newTotalDisplay !== prevTotalDisplay) {
      totalEl.classList.remove('flash');
      void totalEl.offsetWidth;
      totalEl.classList.add('flash');
      prevTotalDisplay = newTotalDisplay;
    }
    $('#chargeBtn').disabled = cart.length === 0;
    $('#holdBtn').disabled = cart.length === 0;
  }

  // ---------------- Held sales ----------------

  function refreshHeldButton() {
    const n = DATA.heldSales.length;
    $('#heldSalesBtn').style.display = n > 0 ? 'inline-flex' : 'none';
    $('#heldCount').textContent = n;
  }

  function initHeldSales() {
    $('#holdBtn').addEventListener('click', async () => {
      if (!cart.length) return;
      DATA.heldSales.push({ id: uid('h'), cart: JSON.parse(JSON.stringify(cart)), createdAt: new Date().toISOString() });
      await persist();
      cart = [];
      renderCart();
      refreshHeldButton();
      toast('Sale held. Resume it any time from "Held".');
    });

    $('#heldSalesBtn').addEventListener('click', () => {
      renderHeldList();
      openModal('#heldModalOverlay');
    });
    $('#heldCloseBtn').addEventListener('click', () => closeModal('#heldModalOverlay'));
  }

  function renderHeldList() {
    const wrap = $('#heldList');
    if (!DATA.heldSales.length) {
      wrap.innerHTML = '<div class="held-empty">No held sales.</div>';
      return;
    }
    wrap.innerHTML = '';
    DATA.heldSales.slice().reverse().forEach(h => {
      const itemCount = h.cart.reduce((s, i) => s + i.qty, 0);
      const total = h.cart.reduce((s, i) => s + i.price * i.qty, 0);
      const row = document.createElement('div');
      row.className = 'held-item';
      row.innerHTML = `
        <div class="held-item-info">
          <div>${itemCount} item(s) — ${money(total)}</div>
          <div class="held-note">Held ${new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-ghost btn-sm" data-act="discard">Discard</button>
          <button class="btn btn-primary btn-sm" data-act="resume">Resume</button>
        </div>
      `;
      row.querySelector('[data-act=resume]').addEventListener('click', async () => {
        if (cart.length) {
          const ok = await confirmDialog(
            'Replace current sale?',
            'This will replace the sale currently in progress. Continue?',
            'Replace sale'
          );
          if (!ok) return;
        }
        cart = h.cart;
        DATA.heldSales = DATA.heldSales.filter(x => x.id !== h.id);
        await persist();
        renderCart();
        refreshHeldButton();
        closeModal('#heldModalOverlay');
      });
      row.querySelector('[data-act=discard]').addEventListener('click', async () => {
        DATA.heldSales = DATA.heldSales.filter(x => x.id !== h.id);
        await persist();
        renderHeldList();
        refreshHeldButton();
      });
      wrap.appendChild(row);
    });
  }

  // ---------------- Charge modal ----------------

  function initChargeModal() {
    $('#chargeBtn').addEventListener('click', () => openChargeModal());
    $('#chargeCancelBtn').addEventListener('click', () => closeModal('#chargeModalOverlay'));
    $$('#paymentMethodSeg .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#paymentMethodSeg .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const method = btn.dataset.method;
        $('#tenderedField').style.display = method === 'Cash' ? 'flex' : 'none';
        $('#changeDisplay').style.display = 'none';
        updateChange();
      });
    });
    $('#tenderedInput').addEventListener('input', updateChange);
    $('#chargeConfirmBtn').addEventListener('click', completeSale);
  }

  function openChargeModal() {
    const t = cartTotals();
    $('#chargeTotalDisplay').textContent = fmt(t.total);
    $('#tenderedInput').value = '';
    $('#changeDisplay').style.display = 'none';
    $$('#paymentMethodSeg .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    $('#tenderedField').style.display = 'flex';
    openModal('#chargeModalOverlay');
    setTimeout(() => $('#tenderedInput').focus(), 50);
  }

  function currentPaymentMethod() {
    const active = $('#paymentMethodSeg .seg-btn.active');
    return active ? active.dataset.method : 'Cash';
  }

  function updateChange() {
    const method = currentPaymentMethod();
    if (method !== 'Cash') { $('#changeDisplay').style.display = 'none'; return; }
    const t = cartTotals();
    const tendered = parseFloat($('#tenderedInput').value) || 0;
    const change = tendered - t.total;
    if (tendered > 0) {
      $('#changeDisplay').style.display = 'flex';
      $('#changeAmount').textContent = fmt(Math.max(change, 0));
      $('#changeAmount').style.color = change < 0 ? 'var(--stamp-red)' : '';
    } else {
      $('#changeDisplay').style.display = 'none';
    }
  }

  // True while a sale is being written. The payment dialog stays open while it
  // animates shut and Enter arrives in pairs, so without this a second press
  // writes the same sale into the Ledger twice and takes the stock off the shelf
  // twice. Cleared in a finally, so a failed save cannot leave the till unable to
  // take money.
  let completingSale = false;

  async function completeSale() {
    if (completingSale) return;
    // Nothing to sell: never write a zero-value sale into the Ledger.
    if (!cart.length) return;
    const t = cartTotals();
    const method = currentPaymentMethod();
    let tendered = t.total, change = 0;
    if (method === 'Cash') {
      tendered = parseFloat($('#tenderedInput').value) || 0;
      if (tendered < t.total) { toast('Amount tendered is less than the total.'); return; }
      change = tendered - t.total;
    }

    const sale = {
      id: uid('s'),
      number: DATA.nextSaleNumber++,
      date: new Date().toISOString(),
      type: 'sale',
      items: cart.map(i => {
        const p = DATA.products.find(pp => pp.id === i.productId);
        return { productId: i.productId, name: i.name, price: i.price, qty: i.qty, lineTotal: i.price * i.qty, cost: p ? p.cost : 0 };
      }),
      subtotal: t.subtotal,
      tax: t.tax,
      total: t.total,
      paymentMethod: method,
      tendered: tendered,
      change: change
    };

    // Everything below waits on the save, so the flag goes up first — a second
    // Enter arriving during that await is refused at the top of the function.
    completingSale = true;
    try {
      sale.items.forEach(li => {
        const p = DATA.products.find(pp => pp.id === li.productId);
        if (p) p.stock = Math.max(0, p.stock - li.qty);
      });

      DATA.sales.push(sale);
      await persist();

      cart = [];
      renderCart();
      renderCatalog();
      renderDaySummary();
      closeModal('#chargeModalOverlay');

      currentSaleForReceipt = sale;
      currentReceiptIsHistorical = false;
      showReceiptModal(sale);
    } finally {
      completingSale = false;
    }
  }

  // ---------------- Refunds ----------------

  function findSaleById(id) { return DATA.sales.find(s => s.id === id) || null; }

  // How many of each product have already been handed back for this sale.
  // Refunds are stored as their own records (type 'return') linked back by
  // refundOf, so what is left to refund is the sold quantity minus the sum of
  // every refund already recorded against it.
  function refundedByProduct(sale) {
    const refunded = new Map();
    DATA.sales.forEach(r => {
      if (r.type !== 'return' || r.refundOf !== sale.id) return;
      (r.items || []).forEach(li => refunded.set(li.productId, (refunded.get(li.productId) || 0) + li.qty));
    });
    return refunded;
  }

  // The lines of a sale that can still go back, with how many are left on each.
  function refundableLines(sale) {
    if (!sale || sale.type === 'return' || !Array.isArray(sale.items)) return [];
    const refunded = refundedByProduct(sale);
    return sale.items
      .map(item => ({ item, remaining: item.qty - (refunded.get(item.productId) || 0) }))
      .filter(line => line.remaining > 0);
  }

  // Offered on any past sale with something left to hand back. No Admin Key is
  // wanted: a refund is a normal part of a day on the till.
  function canRefundSale(sale) {
    return !!sale && sale.type !== 'return' && refundableLines(sale).length > 0;
  }

  let refundTarget = null;
  let refundQty = new Map();   // productId -> quantity to hand back

  function openRefundModal(sale) {
    const lines = refundableLines(sale);
    if (!lines.length) { toast('There is nothing left to refund on this sale.'); return; }
    refundTarget = sale;
    // Start with everything selected — the common case is a full refund.
    refundQty = new Map(lines.map(l => [l.item.productId, l.remaining]));
    $('#refundModalTitle').textContent = 'Refund sale #' + sale.number;
    renderRefundLines();
    openModal('#refundModalOverlay');
  }

  // Tax is apportioned from the original sale rather than recalculated from the
  // current tax rate, so a refund can never drift from the tax actually charged.
  function refundSelectionTotals() {
    let subtotal = 0;
    refundTarget.items.forEach(li => {
      const q = refundQty.get(li.productId) || 0;
      if (q > 0) subtotal += li.price * q;
    });
    const ratio = refundTarget.subtotal ? subtotal / refundTarget.subtotal : 0;
    const tax = refundTarget.tax * ratio;
    return { subtotal, tax, total: subtotal + tax };
  }

  function renderRefundLines() {
    const wrap = $('#refundLines');
    const refunded = refundedByProduct(refundTarget);
    wrap.innerHTML = '';

    refundTarget.items.forEach(li => {
      const already = refunded.get(li.productId) || 0;
      const max = li.qty - already;
      const q = refundQty.get(li.productId) || 0;

      const row = document.createElement('div');
      row.className = 'refund-line' + (max <= 0 ? ' refund-line-done' : '');
      row.innerHTML = `
        <div class="refund-line-info">
          <div class="refund-line-name">${escapeHtml(li.name)}</div>
          <div class="refund-line-meta">${money(li.price)} each · ${max > 0 ? max + ' of ' + li.qty + ' refundable' : 'already refunded'}</div>
        </div>
        <div class="refund-line-qty">
          <button class="qty-btn" data-step="-1"${q <= 0 ? ' disabled' : ''}>−</button>
          <span class="refund-line-qty-num">${q}</span>
          <button class="qty-btn" data-step="1"${q >= max ? ' disabled' : ''}>+</button>
        </div>
        <div class="refund-line-total">${money(li.price * q)}</div>
      `;
      row.querySelectorAll('.qty-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const next = (refundQty.get(li.productId) || 0) + Number(btn.dataset.step);
          refundQty.set(li.productId, Math.max(0, Math.min(max, next)));
          renderRefundLines();
        });
      });
      wrap.appendChild(row);
    });

    const totals = refundSelectionTotals();
    $('#refundTotalValue').textContent = money(totals.total);
    $('#refundConfirmBtn').disabled = totals.subtotal <= 0;
  }

  async function submitRefund() {
    if (!refundTarget) return;
    const sale = refundTarget;
    const selected = sale.items
      .map(li => ({ ...li, qty: refundQty.get(li.productId) || 0 }))
      .filter(li => li.qty > 0);
    if (!selected.length) { toast('Choose at least one item to refund.'); return; }

    const totals = refundSelectionTotals();
    const wholeSale = refundableLines(sale).every(l => (refundQty.get(l.item.productId) || 0) >= l.remaining);

    const ok = await confirmDialog(
      wholeSale ? 'Refund sale #' + sale.number + '?' : 'Refund part of sale #' + sale.number + '?',
      'Hand back ' + (wholeSale ? 'the whole sale' : selected.length + ' item' + (selected.length > 1 ? 's' : '')) +
      ' for ' + money(totals.total) + '? Stock goes back on the shelf.',
      wholeSale ? 'Refund sale' : 'Refund items'
    );
    if (!ok) return;

    closeModal('#refundModalOverlay');
    await refundSale(sale, selected, totals);
  }

  // Records a refund against a sale. `refundItems` may be the whole sale or just
  // part of it. The refund is stored as its own 'return' record with negative
  // totals, which is what makes it count correctly in the Ledger, the day
  // summary and every report, and it carries refundOf so the original sale can
  // always be found again.
  async function refundSale(sale, refundItems, totals) {
    const items = refundItems.map(li => ({ ...li, lineTotal: li.price * li.qty }));

    const refund = {
      id: uid('r'),
      number: DATA.nextSaleNumber++,
      date: new Date().toISOString(),
      type: 'return',
      refundOf: sale.id,
      refundOfNumber: sale.number,
      items,
      subtotal: -totals.subtotal,
      tax: -totals.tax,
      total: -totals.total,
      paymentMethod: sale.paymentMethod,
      tendered: -totals.total,
      change: 0
    };

    items.forEach(li => {
      const p = DATA.products.find(pp => pp.id === li.productId);
      if (p) p.stock += li.qty;
    });

    DATA.sales.push(refund);
    await persist();
    renderCatalog();
    if ($('#view-stock').classList.contains('active')) renderStock();
    renderDaySummary();
    closeModal('#receiptModalOverlay');

    const wholeSale = refundableLines(sale).length === 0;
    toast(wholeSale ? 'Sale #' + sale.number + ' refunded.' : 'Part of sale #' + sale.number + ' refunded.');
    if ($('#view-ledger').classList.contains('active')) renderLedger();
    if ($('#view-dashboard').classList.contains('active')) renderDashboard();

    // Put the refund's own receipt on screen so it can be printed (or handed
    // over) straight away.
    currentSaleForReceipt = refund;
    currentReceiptIsHistorical = false;
    showReceiptModal(refund);
  }

  function initRefundModal() {
    $('#refundCancelBtn').addEventListener('click', () => closeModal('#refundModalOverlay'));
    $('#refundAllBtn').addEventListener('click', () => {
      if (!refundTarget) return;
      refundableLines(refundTarget).forEach(l => refundQty.set(l.item.productId, l.remaining));
      renderRefundLines();
    });
    $('#refundConfirmBtn').addEventListener('click', submitRefund);
  }

  // ---------------- Receipt ----------------

  function receiptText(sale) {
    const s = DATA.settings;
    const isReturn = sale.type === 'return';
    const lines = [];
    lines.push(center(s.shopName, 32));
    if (s.address) lines.push(center(s.address, 32));
    if (s.phone) lines.push(center(s.phone, 32));
    lines.push('-'.repeat(32));
    const original = isReturn ? findSaleById(sale.refundOf) : null;
    const originalNumber = isReturn ? (sale.refundOfNumber || (original && original.number) || sale.number) : sale.number;
    if (isReturn) {
      lines.push('REFUND of Sale #' + originalNumber);
      lines.push('Refund #' + sale.number);
      if (original && Math.abs(sale.total) < Math.abs(original.total) - 0.005) lines.push('(part of the sale above)');
    } else {
      lines.push('Sale #' + sale.number);
    }
    lines.push(new Date(sale.date).toLocaleString());
    lines.push('-'.repeat(32));
    sale.items.forEach(li => {
      lines.push(li.name);
      lines.push(padRow(`  ${li.qty} x ${fmt(li.price)}`, fmt(li.lineTotal)));
    });
    lines.push('-'.repeat(32));
    lines.push(padRow('Subtotal', fmt(sale.subtotal)));
    lines.push(padRow('Tax', fmt(sale.tax)));
    lines.push(padRow('TOTAL', fmt(sale.total)));
    lines.push('');
    lines.push(padRow((isReturn ? 'Refunded (' : 'Paid (') + sale.paymentMethod + ')', fmt(sale.tendered)));
    if (!isReturn && sale.paymentMethod === 'Cash') lines.push(padRow('Change', fmt(sale.change)));
    lines.push('-'.repeat(32));
    if (s.receiptFooter) lines.push(center(s.receiptFooter, 32));
    return lines.join('\n');
  }

  function padRow(left, right) {
    const width = 32;
    const space = Math.max(1, width - left.length - right.length);
    return left + ' '.repeat(space) + right;
  }
  function center(text, width) {
    text = String(text);
    if (text.length >= width) return text;
    const pad = Math.floor((width - text.length) / 2);
    return ' '.repeat(pad) + text;
  }

  // A short receipt for Setup's "Test print" button. Built the same way as a
  // real one, so it also proves the shop's own details fit the paper.
  function sampleReceiptText() {
    const s = DATA.settings;
    const cur = s.currency || '';
    const lines = [];
    lines.push(center(s.shopName || 'My Shop', 32));
    if (s.address) lines.push(center(s.address, 32));
    if (s.phone) lines.push(center(s.phone, 32));
    lines.push('-'.repeat(32));
    lines.push('Test receipt');
    lines.push(new Date().toLocaleString());
    lines.push('-'.repeat(32));
    lines.push('Sample item');
    lines.push(padRow('  1 x ' + cur + '10.00', cur + '10.00'));
    lines.push('-'.repeat(32));
    lines.push(padRow('TOTAL', cur + '10.00'));
    lines.push('');
    lines.push(center('Printer set up correctly.', 32));
    return lines.join('\n');
  }

  // Sends a receipt straight to a thermal printer as raw ESC/POS. The printer's
  // Windows driver is not used at all, so this works with printers that cannot
  // print through their own driver.
  async function printReceiptToPrinter(sale, printer) {
    const res = await window.pos.printReceiptRaw(
      receiptText(sale),
      printer,
      { cut: DATA.settings.receiptCutPaper !== false }
    );
    if (res && res.ok) {
      toast('Receipt printed.');
    } else {
      toast('Could not print: ' + ((res && res.error) || 'unknown error'));
    }
    return res;
  }

  // Prints without opening the preview first, for a customer who comes back for
  // a copy. Uses the receipt printer from Setup when one is chosen, and the
  // normal print dialog otherwise.
  async function reprintReceipt(sale) {
    const printer = (DATA.settings.receiptPrinter || '').trim();
    if (printer) { await printReceiptToPrinter(sale, printer); return; }
    // No thermal printer chosen: print the receipt page through the webview, with
    // no preview to dismiss. The old preview stays as the fallback, for a machine
    // with no default printer or an older webview runtime.
    const silent = await window.pos.printPageSilent('');
    if (silent && silent.ok) { toast('Sent to printer.'); return; }
    const res = await window.pos.printReceipt(receiptText(sale));
    if (res && res.ok) toast('Sent to printer.');
    else if (res && res.error) toast('Could not print: ' + res.error);
  }

  function showReceiptModal(sale) {
    $('#receiptPreview').textContent = receiptText(sale);
    const isReturn = sale.type === 'return';
    $('#receiptModalTitle').textContent = isReturn
      ? 'Refund #' + sale.number
      : (currentReceiptIsHistorical ? 'Sale #' + sale.number : 'Sale complete');
    const canRefund = currentReceiptIsHistorical && canRefundSale(sale);
    $('#receiptRefundBtn').style.display = canRefund ? 'inline-flex' : 'none';
    $('#receiptPrintBtn').textContent = currentReceiptIsHistorical ? 'Reprint receipt' : 'Print receipt';
    openModal('#receiptModalOverlay');
  }

  function initReceiptModal() {
    $('#receiptCloseBtn').addEventListener('click', () => closeModal('#receiptModalOverlay'));
    $('#receiptPrintBtn').addEventListener('click', async () => {
      if (!currentSaleForReceipt) return;
      const printer = (DATA.settings.receiptPrinter || '').trim();
      if (printer) {
        await printReceiptToPrinter(currentSaleForReceipt, printer);
        return;
      }
      const silent = await window.pos.printPageSilent('');
      if (silent && silent.ok) { toast('Sent to printer.'); return; }
      const res = await window.pos.printReceipt(receiptText(currentSaleForReceipt));
      if (res && res.ok) toast('Sent to printer.');
      else if (res && res.error) toast('Could not print: ' + res.error);
    });
    $('#receiptRefundBtn').addEventListener('click', () => {
      if (currentSaleForReceipt) openRefundModal(currentSaleForReceipt);
    });
  }

  // ---------------- Stock ----------------

  let selectedStockIds = new Set();
  let visibleStockCount = 0;

  // Long tables are what make the app feel heavy: every extra row is another row
  // the browser has to lay out on each view change, and a shop can hold thousands
  // of products. Only the first page of rows is drawn, and "Show more" reveals
  // the next page, so nothing is ever out of reach. Searching, picking a
  // category, or "Select all" still covers every matching product.
  const MAX_STOCK_ROWS = 500;
  const MAX_LEDGER_ROWS = 500;

  // How many rows are currently revealed, and which filter that page size
  // belongs to. Changing the search or the category starts a fresh first page;
  // clicking "Show more" (or saving an edit) keeps the rows already revealed.
  let stockRowLimit = MAX_STOCK_ROWS;
  let stockRenderKey = null;
  let ledgerRowLimit = MAX_LEDGER_ROWS;
  let ledgerRenderKey = null;

  // Switching to Stock puts the caret in the filter, so a product can be typed
  // or scanned straight away. Same guard as the till's search box: never take
  // the keyboard away from a modal.
  function focusStockFilter() {
    const el = $('#stockSearch');
    if (el && document.activeElement !== el) {
      if (!$$('.modal-overlay.active').length) el.focus({ preventScroll: true });
    }
  }

  function renderStock() {
    const filterSel = $('#stockCategoryFilter');
    const prevVal = filterSel.value || 'All';
    filterSel.innerHTML = '<option value="All">All categories</option>' +
      DATA.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    filterSel.value = prevVal;

    const q = ($('#stockSearch').value || '').toLowerCase();
    const cat = filterSel.value || 'All';
    const body = $('#stockTableBody');

    const renderKey = cat + '\u0000' + q;
    if (renderKey !== stockRenderKey) {
      stockRenderKey = renderKey;
      stockRowLimit = MAX_STOCK_ROWS;
    }

    const items = DATA.products
      .filter(p => (cat === 'All' || p.category === cat) && matchesQuery(p, q))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Drop selections for products no longer in view (filtered out or deleted).
    const visibleIds = new Set(items.map(p => p.id));
    selectedStockIds.forEach(id => { if (!visibleIds.has(id)) selectedStockIds.delete(id); });
    visibleStockCount = items.length;

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:26px;">No products yet. Click "Add product", scan a barcode, or import a list.</td></tr>';
      updateStockBulkBar();
      return;
    }

    // One HTML string instead of a node with two listeners per row. A shop can
    // hold thousands of products, and clicks are handled by a single listener on
    // the table body (see initStockView).
    const shownRows = items.slice(0, stockRowLimit);
    let rowsHtml = shownRows.map(p => {
      const low = p.stock <= DATA.settings.lowStockThreshold;
      const checked = selectedStockIds.has(p.id);
      return `
        <tr data-id="${p.id}"${checked ? ' class="stock-row-selected"' : ''}>
          <td class="checkbox-col"><input type="checkbox" class="stock-row-check"${checked ? ' checked' : ''} /></td>
          <td>${escapeHtml(p.name)}${p.alias ? ' <span class="row-sub">' + escapeHtml(p.alias) + '</span>' : ''}</td>
          <td>${escapeHtml(p.sku || '—')}</td>
          <td>${escapeHtml(p.category)}</td>
          <td>${escapeHtml(p.supplier || '—')}</td>
          <td class="num">${money(p.price)}</td>
          <td class="num">${p.cost > 0 ? money(p.cost) : '<span class="cost-missing" title="No cost set — profit reporting will treat this as R0 cost">' + money(p.cost) + ' ⚠</span>'}</td>
          <td class="num"><span class="stock-badge ${low ? 'low' : ''}">${p.stock}</span></td>
          <td><span class="row-link">Edit</span></td>
        </tr>`;
    }).join('');
    if (items.length > shownRows.length) {
      rowsHtml += stockMoreRow(shownRows.length, items.length);
    }
    body.innerHTML = rowsHtml;
    updateStockBulkBar();
  }

  function stockMoreRow(shown, total) {
    const hidden = total - shown;
    const next = Math.min(MAX_STOCK_ROWS, hidden);
    return `<tr class="table-more"><td colspan="9">
      Showing the first ${shown} of ${total} products.
      <button type="button" class="table-more-btn" data-more="stock">Show ${next} more</button>
      <span class="table-more-hint">or search, or pick a category, to narrow the list.</span>
    </td></tr>`;
  }

  function updateStockBulkBar() {
    const bar = $('#stockBulkBar');
    const n = selectedStockIds.size;
    if (n > 0) {
      bar.style.display = 'flex';
      $('#stockBulkCount').textContent = `${n} selected`;
    } else {
      bar.style.display = 'none';
    }
    // Worked out from the selection and the row count, rather than by walking
    // every checkbox in the table after each render.
    const selectAll = $('#stockSelectAll');
    selectAll.checked = visibleStockCount > 0 && n >= visibleStockCount;
    selectAll.indeterminate = n > 0 && !selectAll.checked;
  }

  function initStockView() {
    $('#addProductBtn').addEventListener('click', () => openProductModal(null));
    $('#stockSearch').addEventListener('input', debounce(renderStock, 120));

    // With the caret already at the start of the box there is nowhere further
    // left to go, so a left arrow clears the filter instead of doing nothing.
    // Anywhere else in the box it still just moves the caret, so a half-typed
    // filter can be edited as usual.
    $('#stockSearch').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft') return;
      const box = e.currentTarget;
      if (!box.value) return;
      if (box.selectionStart !== 0 || box.selectionEnd !== 0) return;
      e.preventDefault();
      box.value = '';
      renderStock();
    });
    $('#stockCategoryFilter').addEventListener('change', renderStock);

    // One listener for the whole table: the checkbox toggles selection, anything
    // else on the row opens that product.
    $('#stockTableBody').addEventListener('click', (e) => {
      if (e.target.closest('[data-more="stock"]')) {
        stockRowLimit += MAX_STOCK_ROWS;
        renderStock();
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const id = tr.dataset.id;
      const checkbox = e.target.closest('.stock-row-check');
      if (checkbox) {
        if (checkbox.checked) selectedStockIds.add(id);
        else selectedStockIds.delete(id);
        tr.classList.toggle('stock-row-selected', checkbox.checked);
        updateStockBulkBar();
        return;
      }
      openProductModal(id);
    });

    $('#stockSelectAll').addEventListener('change', (e) => {
      const checked = e.target.checked;
      const q = ($('#stockSearch').value || '').toLowerCase();
      const cat = $('#stockCategoryFilter').value || 'All';
      const items = DATA.products.filter(p => (cat === 'All' || p.category === cat) && matchesQuery(p, q));

      if (checked) items.forEach(p => selectedStockIds.add(p.id));
      else selectedStockIds.clear();
      renderStock();
    });

    $('#stockBulkClearBtn').addEventListener('click', () => {
      selectedStockIds.clear();
      renderStock();
    });

    $('#stockBulkDeleteBtn').addEventListener('click', async () => {
      const n = await deleteProductsByIds(selectedStockIds);
      if (!n) return;
      selectedStockIds.clear();
      renderStock();
    });
  }

  // Deleting products is the same job from either screen — the Stock table or
  // the Overview's low-stock list — so the confirmation, the removal, the save
  // and the toast live in one place. Callers clear their own selection and
  // redraw what they own. Returns how many went, or 0 if it was called off.
  async function deleteProductsByIds(ids) {
    const list = Array.from(ids || []).filter(Boolean);
    if (!list.length) return 0;
    const n = list.length;
    const plural = n > 1 ? 's' : '';
    const ok = await confirmDialog(
      `Delete ${n} product${plural}?`,
      `This removes ${n} product${plural} from Stock permanently. Past sales already recorded are not affected. This can't be undone.`,
      n > 1 ? 'Delete selected' : 'Delete'
    );
    if (!ok) return 0;
    const doomed = new Set(list);
    DATA.products = DATA.products.filter(p => !doomed.has(p.id));
    await persist();
    toast(`${n} product${plural} deleted.`);
    return n;
  }

  function populateCategorySelect(sel) {
    sel.innerHTML = DATA.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  function openProductModal(productId) {
    editingProductId = productId;
    const isEdit = !!productId;
    $('#productModalTitle').textContent = isEdit ? 'Edit product' : 'Add product';
    populateCategorySelect($('#pmCategory'));
    $('#pmDeleteBtn').style.display = isEdit ? 'inline-flex' : 'none';

    if (isEdit) {
      const p = DATA.products.find(pp => pp.id === productId);
      $('#pmName').value = p.name;
      $('#pmSku').value = p.sku || '';
      $('#pmCategory').value = p.category;
      $('#pmPrice').value = p.price;
      $('#pmCost').value = p.cost;
      $('#pmStock').value = p.stock;
      $('#pmSupplier').value = p.supplier || '';
    } else {
      $('#pmName').value = '';
      $('#pmSku').value = '';
      $('#pmPrice').value = '';
      $('#pmCost').value = '';
      $('#pmStock').value = '';
      $('#pmSupplier').value = '';
    }
    // An existing product opens showing the percentage it is actually on; a new
    // one starts clean.
    refreshMarkupField();
    openModal('#productModalOverlay');
    setTimeout(() => (isEdit ? $('#pmName') : $('#pmSku')).focus(), 50);
  }

  function initProductModal() {
    $('#pmCancelBtn').addEventListener('click', () => closeModal('#productModalOverlay'));
    $('#pmSaveBtn').addEventListener('click', async () => {
      const name = $('#pmName').value.trim();
      if (!name) { toast('Product needs a name.'); return; }
      const price = parseFloat($('#pmPrice').value) || 0;
      const cost = parseFloat($('#pmCost').value) || 0;
      const stock = parseInt($('#pmStock').value, 10) || 0;
      const sku = $('#pmSku').value.trim();
      // The form no longer offers a search name. One the product already carries
      // is kept — an edit must not quietly wipe it — and a new product starts
      // without one.
      const alias = editingProductId
        ? (DATA.products.find(pp => pp.id === editingProductId) || {}).alias || ''
        : '';
      const supplier = $('#pmSupplier').value.trim();
      const category = $('#pmCategory').value || DATA.categories[0] || 'General';

      if (editingProductId) {
        const p = DATA.products.find(pp => pp.id === editingProductId);
        Object.assign(p, { name, sku, alias, category, price, cost, stock, supplier });
      } else {
        DATA.products.push({ id: nextProductId(), name, sku, alias, category, price, cost, stock, supplier });
      }
      await persist();
      closeModal('#productModalOverlay');
      renderStock();
      toast('Product saved.');
    });
    $('#pmDeleteBtn').addEventListener('click', async () => {
      if (!editingProductId) return;
      DATA.products = DATA.products.filter(p => p.id !== editingProductId);
      await persist();
      closeModal('#productModalOverlay');
      renderStock();
      toast('Product deleted.');
    });
    initMarkupField();
  }

  // ---------------- Profit percentage on the product form ----------------

  // One field that works both ways: type a percentage and the price is worked
  // out from the cost, or type a price and the percentage the shop has ended up
  // on is shown. The price box is still the one that gets saved, so the shop can
  // always overrule the maths by typing a price.
  function refreshMarkupField() {
    const markup = $('#pmMarkup');
    if (!markup) return;
    const cost = parseFloat($('#pmCost').value) || 0;
    const price = parseFloat($('#pmPrice').value) || 0;
    if (!(cost > 0)) { markup.value = ''; return; }
    markup.value = (Math.round(((price - cost) / cost) * 1000) / 10).toString();
  }

  function initMarkupField() {
    const markup = $('#pmMarkup');
    if (!markup) return;

    markup.addEventListener('input', () => {
      const cost = parseFloat($('#pmCost').value) || 0;
      const pct = parseFloat(markup.value);
      // Nothing to work from until a cost is in: the percentage sits there until
      // it can mean something, rather than inventing a price of its own.
      if (!(cost > 0) || isNaN(pct)) return;
      $('#pmPrice').value = (Math.round(cost * (1 + pct / 100) * 100) / 100).toFixed(2);
    });

    // Typing a cost or a price reports what that works out to; it never changes
    // the price on its own.
    ['#pmCost', '#pmPrice'].forEach(sel => $(sel).addEventListener('input', refreshMarkupField));
  }

  // ---------------- Session warmth ----------------

  // The interface picks up a little of the shop's own colour as a shift goes on:
  // nothing when the app opens, a hint within the first hour, a few warm accents
  // by the end of a long day. It is one CSS variable read by a handful of
  // decorative layers — no figure, label or button colour depends on it, so a
  // till left running overnight still reads exactly the same.
  const WARMTH_FULL_MS = 6 * 60 * 60 * 1000;   // fully warm after six hours

  function startWarmth() {
    const openedAt = Date.now();
    const paint = () => {
      const v = Math.min(1, Math.max(0, (Date.now() - openedAt) / WARMTH_FULL_MS));
      document.documentElement.style.setProperty('--warmth', v.toFixed(3));
    };
    paint();
    setInterval(paint, 30000);
  }

  // ---------------- The day's report, by email ----------------

  // What the owner receives is a PDF laid out in Rust from this snapshot, built
  // here at the moment the till asks for it — so the email can only ever say what
  // the Overview would have said at that second.
  function reportSettings() {
    const s = DATA.settings;
    const to = (s.reportEmail || '').trim();
    return {
      recipient: to,
      username: (s.mailFrom || '').trim() || to,
      senderName: (s.shopName || 'Lyra PoS').trim(),
      smtpHost: (s.mailHost || '').trim() || 'smtp.gmail.com',
      smtpPort: parseInt(s.mailPort, 10) || 465
    };
  }

  function dayKeyAgo(days) {
    return new Date(Date.now() - (days || 0) * 86400000).toISOString().slice(0, 10);
  }

  function buildDayReport() {
    const todayKey = dayKeyAgo(0);
    const t = computePeriodTotals(todayKey, 'day');
    const month = computePeriodTotals(periodKeyFromDayKey(todayKey, 'month'), 'month');

    const records = DATA.sales.filter(s => s.date.slice(0, 10) === todayKey);
    const refunded = records
      .filter(s => s.type === 'return')
      .reduce((sum, s) => sum + Math.abs(s.total), 0);
    const costOfGoods = records.reduce(
      (sum, s) => sum + s.items.reduce((a, li) => a + (li.cost || 0) * li.qty, 0), 0);

    const tally = {};
    records
      .filter(s => s.type !== 'return')
      .forEach(sale => sale.items.forEach(li => {
        const row = tally[li.name] || (tally[li.name] = { name: li.name, qty: 0, revenue: 0, profit: 0 });
        row.qty += li.qty;
        row.revenue += li.lineTotal;
        row.profit += li.lineTotal - (li.cost || 0) * li.qty;
      }));
    const topSellers = Object.values(tally).sort((a, b) => b.qty - a.qty).slice(0, 8);

    const recentDays = [];
    for (let d = 6; d >= 0; d--) {
      const key = dayKeyAgo(d);
      const dt = computePeriodTotals(key, 'day');
      recentDays.push({ label: periodLabel(key, 'day'), sales: dt.total, profit: dt.profit, transactions: dt.transactions });
    }

    const threshold = DATA.settings.lowStockThreshold || 0;
    const low = lowStockProducts();

    return {
      shopName: DATA.settings.shopName || '',
      address: DATA.settings.address || '',
      phone: DATA.settings.phone || '',
      currency: DATA.settings.currency || '',
      dateLabel: periodHeaderLabel(todayKey, 'day'),
      generatedAt: new Date().toLocaleString(),
      footerNote: DATA.settings.receiptFooter || '',
      totals: {
        sales: t.total,
        cash: t.cash,
        card: t.card,
        other: t.other,
        refundsValue: refunded,
        refundCount: t.refunds,
        transactions: t.transactions,
        itemsSold: t.itemsSold,
        averageSale: t.transactions ? t.total / t.transactions : 0,
        costOfGoods,
        profit: t.profit,
        marginPct: t.total !== 0 ? (t.profit / t.total) * 100 : 0
      },
      topSellers,
      recentDays,
      monthToDate: {
        sales: month.total,
        profit: month.profit,
        transactions: month.transactions,
        itemsSold: month.itemsSold
      },
      // Out of stock is listed separately from low: it is the half of the list an
      // owner can act on without thinking, and a shop that has run out of
      // something is losing sales right now.
      lowStock: low.filter(p => p.stock > 0).map(p => ({ name: p.name, sku: p.sku || '', stock: p.stock, threshold })),
      outOfStock: low.filter(p => p.stock <= 0).map(p => ({ name: p.name, sku: p.sku || '' })),
      heldSales: (DATA.heldSales || []).map(h => ({
        label: new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        items: h.cart.reduce((s, i) => s + i.qty, 0),
        total: h.cart.reduce((s, i) => s + i.price * i.qty, 0)
      }))
    };
  }

  function reportEmailBody(entry) {
    const cfg = reportSettings();
    const t = entry.report.totals;
    const money = (v) => (entry.report.currency || '') + Number(v || 0).toFixed(2);
    return [
      entry.report.shopName,
      'Day report - ' + entry.dateLabel,
      '',
      'Takings        ' + money(t.sales),
      'Paid in cash   ' + money(t.cash),
      'Paid by card   ' + money(t.card),
      (t.other ? 'Other payment  ' + money(t.other) + '\n' : '') +
      'Sales          ' + t.transactions + '     Items sold ' + t.itemsSold,
      'Profit         ' + money(t.profit) + '  (' + t.marginPct.toFixed(1) + '% margin)',
      '',
      'The full report is attached as a PDF.',
      '',
      entry.report.footerNote || '',
      'Sent by Lyra PoS' + (cfg.senderName ? ' — ' + cfg.senderName : '')
    ].filter(line => line !== '').join('\n');
  }

  function reportQueue() {
    if (!Array.isArray(DATA.reportQueue)) DATA.reportQueue = [];
    return DATA.reportQueue;
  }

  async function sendReport(entry) {
    const cfg = reportSettings();
    if (!cfg.recipient) return { ok: false, error: 'no report address is set — add one in Setup, Day report by email' };
    if (!cfg.username) return { ok: false, error: 'no Gmail address is set to send from — add one in Setup' };
    return window.pos.sendDailyReport({
      ...cfg,
      subject: 'Day report — ' + entry.dateLabel + ' — ' + (DATA.settings.shopName || 'Lyra PoS'),
      bodyText: reportEmailBody(entry),
      report: entry.report
    });
  }

  // The button carries the state, so a cashier can always see whether the day's
  // figures actually left the shop.
  function refreshReportButton() {
    const btn = $('#emailReportBtn');
    if (!btn || btn.dataset.busy === '1') return;
    const queue = reportQueue();
    const todayKey = dayKeyAgo(0);
    const waiting = queue.length;
    btn.classList.toggle('btn-warn', waiting > 0);
    if (!waiting) btn.textContent = "Email today's report";
    else if (queue.some(e => e.dateKey === todayKey)) btn.textContent = 'Report waiting — retrying';
    else btn.textContent = 'Send ' + waiting + ' waiting report' + (waiting > 1 ? 's' : '');
  }

  async function emailDayReport() {
    const btn = $('#emailReportBtn');
    if (!btn || btn.dataset.busy === '1') return;
    const todayKey = dayKeyAgo(0);
    const queue = reportQueue();

    // One entry per day: asking twice replaces today's rather than sending the
    // same day's figures twice.
    let entry = queue.find(e => e.dateKey === todayKey);
    if (!entry) {
      entry = { dateKey: todayKey, attempts: 0 };
      queue.push(entry);
      if (queue.length > 14) queue.splice(0, queue.length - 14);
    }
    entry.dateLabel = periodHeaderLabel(todayKey, 'day');
    entry.generatedAt = new Date().toISOString();
    entry.report = buildDayReport();
    await persist();

    btn.dataset.busy = '1';
    btn.classList.remove('btn-warn');
    btn.textContent = 'Sending…';
    const res = await sendReport(entry);
    delete btn.dataset.busy;

    if (res && res.ok) {
      DATA.reportQueue = queue.filter(e => e !== entry);
      await persist();
      refreshReportButton();
      toast('Day report emailed to ' + reportSettings().recipient + '.');
      return;
    }

    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastError = (res && res.error) || 'unknown error';
    await persist();
    refreshReportButton();
    toast('Could not send the report: ' + entry.lastError);
  }

  // Anything unsent is kept with the day it belongs to and tried again while the
  // app is open, so a shop with no internet at closing time still gets its
  // figures out in the morning. A retried report is the day as it closed: the
  // snapshot is what was taken, not what the till looks like now.
  const REPORT_RETRY_MS = 5 * 60 * 1000;

  function startReportRetries() {
    const attempt = async () => {
      const queue = reportQueue();
      if (!queue.length) { refreshReportButton(); return; }
      const btn = $('#emailReportBtn');
      if (btn) btn.dataset.busy = '1';
      const entry = queue[0];
      const res = await sendReport(entry);
      if (btn) delete btn.dataset.busy;
      if (res && res.ok) {
        DATA.reportQueue = queue.filter(e => e !== entry);
        await persist();
        toast('Waiting day report for ' + entry.dateLabel + ' sent.');
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastError = (res && res.error) || 'unknown error';
        await persist();
      }
      refreshReportButton();
    };
    // One quiet attempt shortly after opening, in case yesterday's report is
    // still waiting, then every few minutes while the shop is open.
    setTimeout(attempt, 20000);
    setInterval(attempt, REPORT_RETRY_MS);
  }

  function initReportButton() {
    const btn = $('#emailReportBtn');
    if (!btn) return;
    btn.addEventListener('click', emailDayReport);
    refreshReportButton();
  }

  // ---------------- Ledger ----------------

  function renderLedger() {
    const dateVal = $('#ledgerDateFilter').value;
    const body = $('#ledgerTableBody');

    let sales = [...DATA.sales].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (dateVal) sales = sales.filter(s => s.date.slice(0, 10) === dateVal);

    if (!sales.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:26px;">No sales recorded yet.</td></tr>';
      return;
    }

    // Built as one HTML string rather than a node per row with its own click
    // listener: the Ledger grows forever, and this keeps it quick to open on a
    // till with years of history. Clicks are handled by one listener (initLedger).
    const renderKey = dateVal || '';
    if (renderKey !== ledgerRenderKey) {
      ledgerRenderKey = renderKey;
      ledgerRowLimit = MAX_LEDGER_ROWS;
    }
    const shownSales = sales.slice(0, ledgerRowLimit);
    let rowsHtml = shownSales.map(sale => {
      const itemCount = sale.items.reduce((n, i) => n + i.qty, 0);
      const isReturn = sale.type === 'return';
      const original = isReturn ? findSaleById(sale.refundOf) : null;
      const originalNumber = isReturn ? (sale.refundOfNumber || (original && original.number)) : null;
      const label = isReturn
        ? 'Refund #' + sale.number + (originalNumber ? ' <span class="row-sub">of #' + originalNumber + '</span>' : '')
        : '#' + sale.number;
      return `
        <tr data-id="${sale.id}">
          <td>${label}</td>
          <td>${new Date(sale.date).toLocaleString()}</td>
          <td>${itemCount}</td>
          <td class="num" style="${isReturn ? 'color:var(--stamp-red);' : ''}">${money(sale.total)}</td>
          <td>${escapeHtml(sale.paymentMethod)}</td>
          <td><span class="row-link" data-action="print">Reprint</span> <span class="row-link" data-action="view">View</span></td>
        </tr>`;
    }).join('');
    if (sales.length > shownSales.length) {
      const next = Math.min(MAX_LEDGER_ROWS, sales.length - shownSales.length);
      rowsHtml += `<tr class="table-more"><td colspan="6">
        Showing the newest ${shownSales.length} of ${sales.length} entries.
        <button type="button" class="table-more-btn" data-more="ledger">Show ${next} more</button>
        <span class="table-more-hint">or filter by date to narrow the list.</span>
      </td></tr>`;
    }
    body.innerHTML = rowsHtml;
  }

  function initLedger() {
    $('#ledgerDateFilter').addEventListener('change', renderLedger);
    $('#ledgerClearFilter').addEventListener('click', () => {
      $('#ledgerDateFilter').value = '';
      renderLedger();
    });

    // One listener for the whole table: "Reprint" prints straight away, clicking
    // anywhere else on a row opens the receipt (which can refund it).
    $('#ledgerTableBody').addEventListener('click', (e) => {
      if (e.target.closest('[data-more="ledger"]')) {
        ledgerRowLimit += MAX_LEDGER_ROWS;
        renderLedger();
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const sale = findSaleById(tr.dataset.id);
      if (!sale) return;
      const link = e.target.closest('.row-link');
      if (link && link.dataset.action === 'print') { reprintReceipt(sale); return; }
      currentSaleForReceipt = sale;
      currentReceiptIsHistorical = true;
      showReceiptModal(sale);
    });
  }

  // ---------------- Reporting helpers (profit, period totals) ----------------

  function saleProfit(sale) {
    const cogs = sale.items.reduce((s, li) => s + (li.cost || 0) * li.qty, 0);
    return sale.type === 'return' ? (sale.subtotal + cogs) : (sale.subtotal - cogs);
  }

  // All grouping is derived from the sale's UTC calendar day-key (dateStr.slice(0,10)),
  // so day/week/month/year buckets all stay consistent with each other.
  function periodKeyFromDayKey(dayKey, period) {
    const [y, m, d] = dayKey.split('-').map(Number);
    if (period === 'day') return dayKey;
    if (period === 'month') return `${y}-${String(m).padStart(2, '0')}`;
    if (period === 'year') return String(y);
    // week: key = the Monday (UTC) of that week
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay();
    const diff = (dow === 0 ? -6 : 1 - dow);
    dt.setUTCDate(dt.getUTCDate() + diff);
    return dt.toISOString().slice(0, 10);
  }

  function periodLabel(key, period) {
    if (period === 'day') {
      return new Date(key + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    if (period === 'month') {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    if (period === 'year') return key;
    const [y, m, d] = key.split('-').map(Number);
    const mon = new Date(Date.UTC(y, m - 1, d));
    const sun = new Date(Date.UTC(y, m - 1, d + 6));
    const fmt = (dt) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${fmt(mon)} – ${fmt(sun)}`;
  }

  function periodHeaderLabel(key, period) {
    if (period === 'day') return new Date(key + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    if (period === 'month') { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    if (period === 'year') return key;
    return periodLabel(key, 'week');
  }

  function periodPhrase(period) {
    return period === 'day' ? 'today' : period === 'week' ? 'this week' : period === 'month' ? 'this month' : 'this year';
  }

  function computePeriodTotals(key, period) {
    const records = DATA.sales.filter(s => periodKeyFromDayKey(s.date.slice(0, 10), period) === key);
    const saleRecords = records.filter(s => s.type !== 'return');
    const returnRecords = records.filter(s => s.type === 'return');
    const total = records.reduce((s, r) => s + r.total, 0);
    const profit = records.reduce((s, r) => s + saleProfit(r), 0);
    const itemsSold = saleRecords.reduce((s, r) => s + r.items.reduce((a, i) => a + i.qty, 0), 0) -
      returnRecords.reduce((s, r) => s + r.items.reduce((a, i) => a + i.qty, 0), 0);
    const byMethod = (method) => records.filter(r => r.paymentMethod === method).reduce((s, r) => s + r.total, 0);
    return {
      key, period, total, profit, itemsSold,
      transactions: saleRecords.length,
      refunds: returnRecords.length,
      cash: byMethod('Cash'),
      card: byMethod('Card'),
      other: byMethod('Other')
    };
  }

  function animateStatNumber(selector, targetValue, formatter) {
    const el = $(selector);
    if (!el) return;
    const prevRaw = parseFloat(el.dataset.raw);
    const prev = isNaN(prevRaw) ? 0 : prevRaw;
    if (prev === targetValue) { el.textContent = formatter(targetValue); el.dataset.raw = targetValue; return; }
    const duration = 480;
    const start = performance.now();
    function tick(now) {
      // Held inside 0…1 on purpose. The frame clock and performance.now() are
      // the same clock on every machine this runs on, so the clamp should never
      // bite — but a figure that has counted past its own total (or below zero)
      // would be read out loud to a customer, and it costs nothing to be sure.
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      const val = prev + (targetValue - prev) * eased;
      el.textContent = formatter(val);
      if (p < 1) requestAnimationFrame(tick);
      else { el.textContent = formatter(targetValue); el.dataset.raw = targetValue; }
    }
    requestAnimationFrame(tick);
  }

  function renderPaymentSplit(selector, t, emptyLabel) {
    const wrap = $(selector);
    if (!wrap) return;
    const entries = [
      { label: 'Cash', value: t.cash, cls: 'bar-cash' },
      { label: 'Card', value: t.card, cls: 'bar-card' }
    ];
    if (t.other) entries.push({ label: 'Other', value: t.other, cls: 'bar-other' });
    if (!entries.some(e => e.value !== 0)) {
      wrap.innerHTML = `<div class="plain-empty">${emptyLabel || 'No sales in this period.'}</div>`;
      return;
    }
    const max = Math.max(1, ...entries.map(e => Math.abs(e.value)));
    wrap.innerHTML = entries.map(e => `
      <div class="bar-row">
        <span class="bar-label">${e.label}</span>
        <div class="bar-track"><div class="bar-fill ${e.cls}" style="--target-width:${Math.min(100, Math.abs(e.value) / max * 100)}%"></div></div>
        <span class="bar-value">${money(e.value)}</span>
      </div>
    `).join('');
  }

  // ---------------- Till day summary (visible in Client mode, screenshot-friendly) ----------------

  function renderDaySummary() {
    if (!DATA) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    const t = computePeriodTotals(todayKey, 'day');
    const totalEl = $('#dsTotal');
    if (!totalEl) return;
    totalEl.textContent = money(t.total);
    $('#dsCash').textContent = money(t.cash);
    $('#dsCard').textContent = money(t.card);
    const otherWrap = $('#dsOtherWrap');
    if (t.other) { otherWrap.style.display = 'flex'; $('#dsOther').textContent = money(t.other); }
    else { otherWrap.style.display = 'none'; }
  }

  // ---------------- Dashboard ----------------

  let dashboardPeriod = 'day';
  // Low-stock rows ticked in the Overview, waiting on "Delete selected".
  let selectedLowStockIds = new Set();

  function initPeriodTabs() {
    $$('#periodTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#periodTabs .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        dashboardPeriod = btn.dataset.period;
        renderDashboard();
      });
    });
  }

  function lowStockProducts() {
    return DATA.products.filter(p => p.stock <= DATA.settings.lowStockThreshold);
  }

  // The low-stock list is a place to act on stock, not only read it: a row can
  // be deleted on its own, or ticked and deleted with the others. Rows are drawn
  // as one string with a single listener on the list (see initLowStockPanel),
  // the same way the Stock table stays quick with thousands of products.
  function renderLowStockList(lowStockItems) {
    const list = $('#lowStockList');
    // The same pruning the Stock table does: a tick left on a product that is no
    // longer low on stock must not linger.
    const stillLow = new Set(lowStockItems.map(p => p.id));
    selectedLowStockIds.forEach(id => { if (!stillLow.has(id)) selectedLowStockIds.delete(id); });

    list.innerHTML = lowStockItems.length
      ? lowStockItems.map(p => {
        const checked = selectedLowStockIds.has(p.id);
        return `<li data-id="${p.id}">
          <span class="low-stock-name"><input type="checkbox" class="low-stock-check" data-id="${p.id}"${checked ? ' checked' : ''} />${escapeHtml(p.name)}</span>
          <span class="low-stock-side"><span class="stock-badge low">${p.stock} left</span><span class="low-stock-code">${escapeHtml(p.sku || '—')}</span><span class="row-link" data-del="${p.id}">Delete</span></span>
        </li>`;
      }).join('')
      : '<li class="plain-empty">Everything is well stocked.</li>';

    updateLowStockBulkBar();
  }

  function updateLowStockBulkBar() {
    const bar = $('#lowStockBulkBar');
    const n = selectedLowStockIds.size;
    if (n > 0) {
      bar.style.display = 'flex';
      $('#lowStockBulkCount').textContent = `${n} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  // Deleting from here has to redraw both screens: the Stock table holds the same
  // products, and every figure that counts them — the low-stock number, the
  // inventory values — is drawn on this one.
  async function deleteFromLowStock(ids) {
    const n = await deleteProductsByIds(ids);
    if (!n) return;
    selectedLowStockIds.clear();
    renderStock();
    renderDashboard();
  }

  function initLowStockPanel() {
    $('#lowStockList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteFromLowStock([del.dataset.del]); return; }
      const check = e.target.closest('.low-stock-check');
      if (check) {
        if (check.checked) selectedLowStockIds.add(check.dataset.id);
        else selectedLowStockIds.delete(check.dataset.id);
        updateLowStockBulkBar();
      }
    });

    $('#lowStockBulkClearBtn').addEventListener('click', () => {
      selectedLowStockIds.clear();
      $$('#lowStockList .low-stock-check').forEach(c => { c.checked = false; });
      updateLowStockBulkBar();
    });

    $('#lowStockBulkDeleteBtn').addEventListener('click', () => {
      deleteFromLowStock(Array.from(selectedLowStockIds));
    });
  }

  function renderDashboard() {
    const period = dashboardPeriod;
    const todayKey = new Date().toISOString().slice(0, 10);
    const currentKey = periodKeyFromDayKey(todayKey, period);
    const phrase = periodPhrase(period);

    $('#dashDateLabel').textContent = periodHeaderLabel(currentKey, period);
    $('#statSalesLabel').textContent = 'Sales ' + phrase;
    $('#statProfitLabel').textContent = 'Profit ' + phrase;
    $('#statMarginLabel').textContent = 'Margin ' + phrase;
    $('#paymentSplitTitle').textContent = 'Payment split ' + phrase;
    $('#topSellersTitle').textContent = 'Top sellers ' + phrase;
    $('#historyDateHeader').textContent = period === 'day' ? 'Date' : period === 'week' ? 'Week' : period === 'month' ? 'Month' : 'Year';

    const t = computePeriodTotals(currentKey, period);
    // Sales and profit are read rather than rung up, and a month or a year of
    // takings runs to six figures: both are grouped with a comma every three
    // digits, the way Inventory at cost and Inventory at sell beside them are.
    animateStatNumber('#statTodaySales', t.total, moneyGrouped);
    animateStatNumber('#statTodayProfit', t.profit, moneyGrouped);
    const marginPct = t.total !== 0 ? (t.profit / t.total) * 100 : 0;
    animateStatNumber('#statTodayMargin', marginPct, (v) => v.toFixed(1) + '%');
    animateStatNumber('#statTodayCount', t.transactions, (v) => Math.round(v).toString());
    animateStatNumber('#statTodayItems', t.itemsSold, (v) => Math.round(v).toString());

    const lowStockItems = lowStockProducts();
    $('#statLowStock').textContent = lowStockItems.length;

    // What the shelf is worth: every product's stock at its cost, and at its
    // price. Both are a snapshot of right now rather than of the chosen period,
    // so like the low-stock count they do not move with the tabs. A negative
    // count is a data-entry accident rather than stock owed back to someone, so
    // it is worth nothing here.
    let stockValueAtCost = 0;
    let stockValueAtSell = 0;
    DATA.products.forEach(p => {
      const qty = Math.max(0, p.stock || 0);
      stockValueAtCost += qty * (p.cost || 0);
      stockValueAtSell += qty * (p.price || 0);
    });
    $('#statStockValueCost').textContent = moneyGrouped(stockValueAtCost);
    $('#statStockValueSell').textContent = moneyGrouped(stockValueAtSell);

    renderPaymentSplit('#paymentSplitToday', t, 'No sales in this period yet.');

    const periodSales = DATA.sales.filter(s => s.type !== 'return' && periodKeyFromDayKey(s.date.slice(0, 10), period) === currentKey);
    const tally = {};
    periodSales.forEach(sale => sale.items.forEach(li => { tally[li.name] = (tally[li.name] || 0) + li.qty; }));
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const rankList = $('#topSellersList');
    rankList.innerHTML = ranked.length
      ? ranked.map(([name, qty], i) => `<li><span class="rank-num">${i + 1}.</span>${escapeHtml(name)} — ${qty} sold</li>`).join('')
      : `<li class="plain-empty">No sales ${phrase} yet.</li>`;

    renderLowStockList(lowStockItems);

    renderHistory(period, currentKey);
  }

  const HISTORY_LIMITS = { day: 30, week: 16, month: 24, year: 10 };

  function renderHistory(period, currentKey) {
    const body = $('#historyTableBody');
    if (!body) return;

    const keys = new Set(DATA.sales.map(s => periodKeyFromDayKey(s.date.slice(0, 10), period)));
    keys.delete(currentKey);
    const sorted = Array.from(keys).sort((a, b) => b.localeCompare(a)).slice(0, HISTORY_LIMITS[period] || 30);
    const rows = sorted.map(key => ({ key, totals: computePeriodTotals(key, period) }));

    // Sales split into cash and card — the two payments this build records.
    // Data restored from an older build can still hold an "Other" payment, so
    // the split grows a third column when one turns up rather than leaving that
    // money out of the two.
    const splitOther = rows.some(r => r.totals.other !== 0);
    const columns = splitOther ? 8 : 7;
    $('#historyOtherHeader').style.display = splitOther ? '' : 'none';

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="${columns}" style="text-align:center;color:var(--text-muted);padding:22px;">No previous ${period === 'day' ? 'days' : period === 'week' ? 'weeks' : period === 'month' ? 'months' : 'years'} yet — history builds up as sales come in.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach(({ key, totals: dt }) => {
      const label = periodLabel(key, period);
      const margin = dt.total !== 0 ? (dt.profit / dt.total) * 100 : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${label}</td>
        <td class="num">${money(dt.total)}</td>
        <td class="num">${money(dt.cash)}</td>
        <td class="num">${money(dt.card)}</td>${splitOther ? `
        <td class="num">${money(dt.other)}</td>` : ''}
        <td class="num" style="${dt.profit < 0 ? 'color:var(--stamp-red);' : ''}">${money(dt.profit)}</td>
        <td class="num" style="${margin < 0 ? 'color:var(--stamp-red);' : ''}">${margin.toFixed(1)}%</td>
        <td class="num">${dt.transactions}${dt.refunds ? ` <span class="text-muted-inline">(${dt.refunds} refund${dt.refunds > 1 ? 's' : ''})</span>` : ''}</td>
      `;
      fragment.appendChild(tr);
    });
    body.innerHTML = '';
    body.appendChild(fragment);
  }

  // ---------------- Reports (items sold breakdown) ----------------

  let reportsPeriod = 'day';

  function initReportsView() {
    $$('#reportsPeriodTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#reportsPeriodTabs .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        reportsPeriod = btn.dataset.period;
        renderReports();
      });
    });
    $('#reportsSearch').addEventListener('input', debounce(renderReports, 120));
  }

  function computeItemsSoldForPeriod(currentKey, period) {
    const records = DATA.sales.filter(s => periodKeyFromDayKey(s.date.slice(0, 10), period) === currentKey);
    const map = {};
    records.forEach(sale => {
      const sign = sale.type === 'return' ? -1 : 1;
      sale.items.forEach(li => {
        if (!map[li.name]) map[li.name] = { name: li.name, qty: 0, revenue: 0, cost: 0 };
        map[li.name].qty += sign * li.qty;
        map[li.name].revenue += sign * li.lineTotal;
        map[li.name].cost += sign * (li.cost || 0) * li.qty;
      });
    });
    return Object.values(map).filter(row => row.qty !== 0 || row.revenue !== 0);
  }

  function renderReports() {
    const period = reportsPeriod;
    const todayKey = new Date().toISOString().slice(0, 10);
    const currentKey = periodKeyFromDayKey(todayKey, period);
    const phrase = periodPhrase(period);

    $('#reportsDateLabel').textContent = periodHeaderLabel(currentKey, period) + ' — how much of what sold ' + phrase + '.';

    const q = ($('#reportsSearch').value || '').trim().toLowerCase();
    let rows = computeItemsSoldForPeriod(currentKey, period);
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
    rows.sort((a, b) => b.qty - a.qty);

    const body = $('#reportsTableBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:26px;">No items sold ${phrase} yet.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach(r => {
      const profit = r.revenue - r.cost;
      const margin = r.revenue !== 0 ? (profit / r.revenue) * 100 : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.qty}</td>
        <td class="num">${money(r.revenue)}</td>
        <td class="num">${money(r.cost)}</td>
        <td class="num" style="${profit < 0 ? 'color:var(--stamp-red);' : ''}">${money(profit)}</td>
        <td class="num" style="${margin < 0 ? 'color:var(--stamp-red);' : ''}">${margin.toFixed(1)}%</td>
      `;
      fragment.appendChild(tr);
    });
    body.innerHTML = '';
    body.appendChild(fragment);
  }

  // ---------------- Settings ----------------

  function renderSettings() {
    const s = DATA.settings;
    $('#setShopName').value = s.shopName;
    $('#setAddress').value = s.address;
    $('#setPhone').value = s.phone;
    $('#setFooter').value = s.receiptFooter;
    $('#setCurrency').value = s.currency;
    $('#setTaxRate').value = s.taxRate;
    $('#setLowStock').value = s.lowStockThreshold;
    $('#setCurrentKey').value = '';
    $('#setNewKey').value = '';
    $('#setConfirmKey').value = '';
    $('#setReportEmail').value = s.reportEmail || '';
    $('#setMailFrom').value = s.mailFrom || '';
    // The App Password is never sent back to the screen; the line underneath
    // says whether one is saved.
    $('#setMailPassword').value = '';
    refreshMailStatus();
    renderSettingsCategoryChips();
    renderPrinterSetting();
  }

  // What Setup can say about the email settings without ever handling the
  // password: where reports go, and whether a password is stored.
  async function refreshMailStatus() {
    const el = $('#mailStatus');
    if (!el) return;
    const cfg = reportSettings();
    const has = await window.pos.hasMailPassword();
    const queue = reportQueue();
    const parts = [];
    parts.push(cfg.recipient ? 'Reports go to ' + cfg.recipient + '.' : 'No report address set yet.');
    parts.push(has ? 'A Gmail App Password is saved.' : 'No App Password saved yet.');
    if (queue.length) parts.push(queue.length + ' report' + (queue.length > 1 ? 's' : '') + ' still waiting to send.');
    el.textContent = parts.join(' ');
  }

  // Fills Setup's receipt-printer dropdown from the printers Windows knows about.
  async function renderPrinterSetting() {
    const s = DATA.settings;
    const saved = (s.receiptPrinter || '').trim();
    $('#setCutPaper').checked = s.receiptCutPaper !== false;

    let printers = [];
    try { printers = await window.pos.listPrinters(); } catch (err) { printers = []; }

    const options = ['<option value="">Ask me each time (print dialog)</option>'].concat(
      printers.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.displayName || p.name)}</option>`)
    );
    // If the saved printer is no longer installed, still list it so it is clear
    // what the app is set to and that it needs changing.
    if (saved && !printers.some(p => p.name === saved)) {
      options.push(`<option value="${escapeHtml(saved)}">${escapeHtml(saved)} (not installed)</option>`);
    }

    const sel = $('#setPrinter');
    sel.innerHTML = options.join('');
    sel.value = saved;
  }

  function renderSettingsCategoryChips() {
    const row = $('#settingsCategoryChips');
    row.innerHTML = '';
    if (!DATA.categories.length) DATA.categories.push('General');

    DATA.categories.forEach(c => {
      const inUse = DATA.products.filter(p => p.category === c).length;
      // The last category can't be removed: every product has to be filed somewhere.
      const removable = DATA.categories.length > 1;

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.cursor = 'default';
      chip.innerHTML = `${escapeHtml(c)}` +
        (inUse ? ` <span class="row-sub">${inUse} product${inUse > 1 ? 's' : ''}</span>` : '') +
        (removable ? ' <span class="chip-remove" title="Remove">✕</span>' : '');

      if (removable) {
        chip.querySelector('.chip-remove').addEventListener('click', () => removeCategory(c, inUse));
      }
      row.appendChild(chip);
    });
  }

  // Deleting a category that products are filed under would leave them pointing
  // at a category that no longer exists, so they are moved to another one first.
  async function removeCategory(name, inUse) {
    if (DATA.categories.length <= 1) { toast('At least one category is needed.'); return; }
    const fallback = DATA.categories.find(c => c !== name);

    if (inUse) {
      const ok = await confirmDialog(
        'Delete the "' + name + '" category?',
        inUse + ' product' + (inUse > 1 ? 's are' : ' is') + ' filed under it. ' +
        (inUse > 1 ? 'They' : 'It') + ' will be moved to "' + fallback + '".',
        'Delete category'
      );
      if (!ok) return;
      DATA.products.forEach(p => { if (p.category === name) p.category = fallback; });
    }

    DATA.categories = DATA.categories.filter(c => c !== name);
    await persist();
    renderSettingsCategoryChips();
    if ($('#view-stock').classList.contains('active')) renderStock();
    renderCatalog();
    toast(inUse ? 'Category deleted, products moved to ' + fallback + '.' : 'Category deleted.');
  }

  function initSettingsView() {
    async function saveAllSettings() {
      DATA.settings.shopName = $('#setShopName').value.trim() || 'My Shop';
      DATA.settings.address = $('#setAddress').value.trim();
      DATA.settings.phone = $('#setPhone').value.trim();
      DATA.settings.receiptFooter = $('#setFooter').value.trim();
      DATA.settings.currency = $('#setCurrency').value.trim() || '$';
      DATA.settings.taxRate = parseFloat($('#setTaxRate').value) || 0;
      DATA.settings.lowStockThreshold = parseInt($('#setLowStock').value, 10) || 0;
      await persist();
      applyShopIdentity();
    }

    $('#saveShopDetailsBtn').addEventListener('click', async () => {
      await saveAllSettings();
      toast('Shop details saved.');
    });

    $('#saveSettingsBtn').addEventListener('click', async () => {
      await saveAllSettings();
      toast('Till settings saved.');
    });

    $('#savePrinterBtn').addEventListener('click', async () => {
      DATA.settings.receiptPrinter = $('#setPrinter').value;
      DATA.settings.receiptCutPaper = $('#setCutPaper').checked;
      await persist();
      toast('Receipt printer saved.');
    });

    $('#saveMailBtn').addEventListener('click', async () => {
      DATA.settings.reportEmail = $('#setReportEmail').value.trim();
      DATA.settings.mailFrom = $('#setMailFrom').value.trim();
      if (!DATA.settings.mailHost) DATA.settings.mailHost = 'smtp.gmail.com';
      if (!DATA.settings.mailPort) DATA.settings.mailPort = 465;
      const password = $('#setMailPassword').value;
      if (password) {
        // A Gmail App Password is 16 lowercase letters and nothing else. Anything
        // else is almost always the shop's ordinary Google password, which Gmail
        // will never accept over email — say so before it fails at sending time.
        // It is still saved, so a change at Google's end cannot lock anyone out
        // of an app that used to work.
        const bare = password.replace(/\s+/g, '');
        const looksLikeAppPassword = /^[a-z]{16}$/.test(bare);
        const res = await window.pos.saveMailPassword(password);
        if (!res || !res.ok) { toast('Could not save the App Password: ' + ((res && res.error) || 'unknown error')); return; }
        if (!looksLikeAppPassword) {
          const el = $('#mailStatus');
          if (el) el.textContent = 'That does not look like a Google App Password — those are 16 letters, no numbers or capitals. If it is your ordinary Google password, Gmail will refuse it: make an App Password at myaccount.google.com/apppasswords.';
        }
      }
      await persist();
      $('#setMailPassword').value = '';
      await refreshMailStatus();
      refreshReportButton();
      toast(password ? 'Email settings saved, with a new App Password.' : 'Email settings saved.');
    });

    $('#sendTestMailBtn').addEventListener('click', async () => {
      const btn = $('#sendTestMailBtn');
      // The password box is read straight from the form, so a report can be tried
      // before anything is saved — that is the point of a test.
      const typed = $('#setMailPassword').value;
      if (typed) await window.pos.saveMailPassword(typed);
      DATA.settings.reportEmail = $('#setReportEmail').value.trim();
      DATA.settings.mailFrom = $('#setMailFrom').value.trim();
      const cfg = reportSettings();
      if (!cfg.recipient || !cfg.username) { toast('Fill in the report address first.'); return; }
      const todayKey = dayKeyAgo(0);
      const entry = { dateKey: todayKey, dateLabel: periodHeaderLabel(todayKey, 'day'), report: buildDayReport() };
      btn.disabled = true;
      const res = await sendReport(entry);
      btn.disabled = false;
      if (res && res.ok) { $('#setMailPassword').value = ''; await refreshMailStatus(); toast('Test report sent to ' + cfg.recipient + '.'); }
      else {
        // The reason stays on screen rather than in a toast that disappears: the
        // usual one is the password, and it has a fix that takes a minute.
        const why = (res && res.error) || 'unknown error';
        const el = $('#mailStatus');
        if (el) el.textContent = 'Could not send: ' + why;
        toast('Could not send: ' + why);
      }
    });

    $('#testPrintBtn').addEventListener('click', async () => {
      const printer = $('#setPrinter').value;
      if (!printer) { toast('Pick a printer above first.'); return; }
      const res = await window.pos.printReceiptRaw(
        sampleReceiptText(),
        printer,
        { cut: $('#setCutPaper').checked }
      );
      if (res && res.ok) toast('Test receipt sent to ' + printer + '.');
      else toast('Could not print: ' + ((res && res.error) || 'unknown error'));
    });

    $('#changeAdminKeyBtn').addEventListener('click', async () => {
      const current = $('#setCurrentKey').value;
      const next = $('#setNewKey').value;
      const confirmVal = $('#setConfirmKey').value;
      const currentHash = await hashAdminKey(current || '');
      if (currentHash !== DATA.settings.adminKeyHash) { toast('Current Admin Key is incorrect.'); return; }
      if (!next || next.length < 4) { toast('New Admin Key should be at least 4 characters.'); return; }
      if (next !== confirmVal) { toast("New keys don't match."); return; }
      DATA.settings.adminKeyHash = await hashAdminKey(next);
      await persist();
      $('#setCurrentKey').value = ''; $('#setNewKey').value = ''; $('#setConfirmKey').value = '';
      toast('Admin Key updated.');
    });

    $('#addCategoryBtn').addEventListener('click', async () => {
      const name = $('#newCategoryInput').value.trim();
      if (!name) return;
      if (DATA.categories.some(c => c.toLowerCase() === name.toLowerCase())) {
        toast('That category already exists.');
        return;
      }
      DATA.categories.push(name);
      $('#newCategoryInput').value = '';
      await persist();
      renderSettingsCategoryChips();
      if ($('#view-stock').classList.contains('active')) renderStock();
      renderCatalog();
      toast('Category added.');
    });

    $('#exportBackupBtn').addEventListener('click', async () => {
      const res = await window.pos.exportBackup();
      if (res.ok) toast('Backup saved to ' + res.filePath);
      else if (res.error) toast('Could not save the backup: ' + res.error);
    });

    $('#importBackupBtn').addEventListener('click', async () => {
      const res = await window.pos.importBackup();
      // Dismissing the dialog is not a failure; a file we could not read is.
      if (!res.ok) {
        if (res.error) toast('That file could not be read as a backup.');
        return;
      }
      DATA = res.data;
      if (!DATA.heldSales) DATA.heldSales = [];
      applyShopIdentity();
      refreshHeldButton();
      switchView('dashboard');
      toast('Backup imported.');
    });

    $('#importProductsBtn').addEventListener('click', startProductImport);

    $('#resetSalesStockBtn').addEventListener('click', async () => {
      const ok = await confirmDialog(
        'Reset sales & stock?',
        "This clears the Ledger, Overview history, and held sales, and sets every product's stock to 0. " +
        "Products, prices, categories, and settings are kept. This can't be undone.",
        'Reset sales & stock'
      );
      if (!ok) return;
      requireAdminConfirmation(performResetSalesStock, {
        title: 'Confirm reset',
        note: 'Enter your Admin Key to reset sales & stock.',
        confirmLabel: 'Reset sales & stock'
      });
    });

    $('#resetAllBtn').addEventListener('click', async () => {
      const ok = await confirmDialog(
        'Reset ALL data?',
        "This wipes products, sales, categories, settings, and the Admin Key itself back to a blank install. " +
        "This can't be undone.",
        'Reset all data'
      );
      if (!ok) return;
      requireAdminConfirmation(performResetAll, {
        title: 'Confirm full reset',
        note: 'Enter your Admin Key to reset everything back to a blank install.',
        confirmLabel: 'Reset all data'
      });
    });
  }

  async function performResetSalesStock() {
    const fresh = await window.pos.resetSalesStock();
    DATA = fresh;
    cart = [];
    renderCart();
    renderCatalog();
    renderDaySummary();
    refreshHeldButton();
    renderSettings();
    toast('Sales & stock have been reset.');
  }

  async function performResetAll() {
    const fresh = await window.pos.resetAllData();
    DATA = fresh;
    cart = [];
    unlocked = false;
    applyLockUI();
    applyShopIdentity();
    refreshHeldButton();
    switchView('till');
    toast('All data has been reset.');
    openAdminModal('create', null);
  }

  function applyShopIdentity() {
    $('#shopNameMini').textContent = DATA.settings.shopName;
    $('#tapeShopName').textContent = DATA.settings.shopName;
  }

  // ---------------- Product import (POS Maid / Excel / CSV) ----------------

  // The fields the column-mapping dialog offers, in the order it shows them.
  // Which column each one starts on is guessed on the Rust side, where the
  // rules can be tested against a real POS Maid export.
  const IMPORT_FIELDS = [
    { key: 'mapName', label: 'name' },
    { key: 'mapSku', label: 'sku' },
    { key: 'mapCategory', label: 'category' },
    { key: 'mapPrice', label: 'price' },
    { key: 'mapCost', label: 'cost' },
    { key: 'mapStock', label: 'stock' },
    { key: 'mapSupplier', label: 'supplier' }
  ];

  async function startProductImport() {
    const res = await window.pos.importProductsFile();
    if (!res) return;
    if (!res.ok) { if (res.error) toast(res.error); return; }
    importParsed = res;

    $('#importFileLabel').textContent = `From "${res.fileName}" — ${res.rows.length} row(s) found. Match the columns below, then import.`;

    const headerOptions = '<option value="">— Not in file —</option>' +
      res.headers.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');

    const guessed = res.suggested || {};
    IMPORT_FIELDS.forEach(f => {
      const sel = $('#' + f.key);
      sel.innerHTML = headerOptions;
      if (guessed[f.key]) sel.value = guessed[f.key];
    });

    renderImportPreview();
    IMPORT_FIELDS.forEach(f => $('#' + f.key).addEventListener('change', renderImportPreview));

    openModal('#importModalOverlay');
  }

  function renderImportPreview() {
    if (!importParsed) return;
    const table = $('#importPreviewTable');
    const cols = ['Name', 'SKU', 'Category', 'Price', 'Cost', 'Stock', 'Supplier'];
    const mapSel = {
      Name: $('#mapName').value, SKU: $('#mapSku').value, Category: $('#mapCategory').value,
      Price: $('#mapPrice').value, Cost: $('#mapCost').value, Stock: $('#mapStock').value,
      Supplier: $('#mapSupplier').value
    };
    let html = '<thead><tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    importParsed.rows.slice(0, 6).forEach(row => {
      html += '<tr>' + cols.map(c => `<td>${escapeHtml(mapSel[c] ? row[mapSel[c]] : '')}</td>`).join('') + '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
    $('#importSummary').textContent = importParsed.rows.length > 6 ? `Showing first 6 of ${importParsed.rows.length} rows.` : '';
  }

  function initImportModal() {
    $('#importCancelBtn').addEventListener('click', () => { closeModal('#importModalOverlay'); importParsed = null; });

    $('#importConfirmBtn').addEventListener('click', async () => {
      if (!importParsed) return;
      const nameCol = $('#mapName').value, skuCol = $('#mapSku').value, catCol = $('#mapCategory').value,
            priceCol = $('#mapPrice').value, costCol = $('#mapCost').value, stockCol = $('#mapStock').value,
            supplierCol = $('#mapSupplier').value;

      if (!nameCol || !priceCol) { toast('Name and Price must be mapped to a column.'); return; }

      let added = 0, updated = 0, skipped = 0;
      importParsed.rows.forEach(row => {
        const name = String(row[nameCol] || '').trim();
        const price = parseFloat(row[priceCol]);
        if (!name || isNaN(price)) { skipped++; return; }

        const sku = skuCol ? String(row[skuCol] || '').trim() : '';
        let category = catCol ? String(row[catCol] || '').trim() : '';
        if (!category) category = DATA.categories[0] || 'General';
        if (!DATA.categories.includes(category)) DATA.categories.push(category);
        const cost = costCol ? (parseFloat(row[costCol]) || 0) : 0;
        const stock = stockCol ? (parseInt(row[stockCol], 10) || 0) : 0;
        const supplier = supplierCol ? String(row[supplierCol] || '').trim() : '';

        const existing = sku ? DATA.products.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase()) : null;
        if (existing) {
          Object.assign(existing, { name, category, price, cost, stock, supplier });
          updated++;
        } else {
          DATA.products.push({ id: nextProductId(), name, sku, category, price, cost, stock, supplier });
          added++;
        }
      });

      await persist();
      closeModal('#importModalOverlay');
      importParsed = null;
      renderStock();
      renderCatalog();
      toast(`Import complete: ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}.`);
    });
  }

  // ---------------- Boot ----------------

  async function boot() {
    DATA = await window.pos.loadData();
    if (!DATA.heldSales) DATA.heldSales = [];
    if (!Array.isArray(DATA.reportQueue)) DATA.reportQueue = [];
    if (!DATA.settings.adminKeyHash) DATA.settings.adminKeyHash = '';
    applyShopIdentity();

    initNav();
    updateNavPill();
    initClock();
    initAdminModal();
    initBarcodeScanning();
    initCatalogToggle();
    initHeldSales();
    initChargeModal();
    initReceiptModal();
    initRefundModal();
    initStockView();
    initProductModal();
    initLedger();
    initSettingsView();
    initImportModal();
    initPeriodTabs();
    initLowStockPanel();
    initReportsView();
    initReportButton();
    startWarmth();
    startReportRetries();

    $('#productSearch').addEventListener('input', debounce(renderCatalog, 80));
    // Enter is handled document-wide by initBarcodeScanning, which reads the box
    // as well as the keystroke buffer — so there is exactly one place that
    // decides what an Enter press means and a scan can't be committed twice.
    // One listener for the product grid, rather than one per card: a shop can
    // hold thousands of products and re-binding every card on each keystroke is
    // what makes the Till feel slow.
    $('#productGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.product-card');
      if (!card || card.disabled) return;
      const product = DATA.products.find(p => p.id === card.dataset.id);
      if (!product) return;
      flyToCart(card);
      pulseTapeBody();
      const added = addToCart(product);
      // Clear the search once the item is in the sale, so the next one can be
      // typed straight away and the full list comes back.
      const search = $('#productSearch');
      if (added && search.value) { search.value = ''; renderCatalog(); }
    });
    $('#clearCartBtn').addEventListener('click', () => { cart = []; renderCart(); });

    applyLockUI();
    refreshHeldButton();
    renderCatalog();
    renderCart();
    renderDaySummary();
    focusScanTarget();

    $$('.modal-overlay').forEach(ov => {
      ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(ov); });
    });

    if (!DATA.settings.adminKeyHash) {
      openAdminModal('create', null);
    }

    hideSplash();
  }

  function hideSplash() {
    const el = $('#splashScreen');
    if (!el) return;
    // Minimum show time so it reads as a real splash, not a flash.
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 550);
    }, 950);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
