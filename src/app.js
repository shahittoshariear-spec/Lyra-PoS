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
  const PROTECTED_VIEWS = ['stock', 'ledger', 'dashboard', 'reports', 'settings'];

  function money(n) {
    const v = Number(n || 0);
    return DATA.settings.currency + v.toFixed(2);
  }
  function fmt(n) { return Number(n || 0).toFixed(2); }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nextProductId() { return 'p' + (DATA.nextProductId++); }

  async function persist() { await window.tally.saveData(DATA); }

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

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------------- Navigation ----------------

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

    if (view === 'stock') renderStock();
    if (view === 'ledger') renderLedger();
    if (view === 'dashboard') renderDashboard();
    if (view === 'reports') renderReports();
    if (view === 'settings') renderSettings();
    if (view === 'till') { renderCatalog(); renderDaySummary(); focusScanTarget(); }
  }

  function updateNavPill() {
    const activeBtn = document.querySelector('.nav-btn.active');
    const pill = $('#navPill');
    if (!activeBtn || !pill) return;
    pill.style.transform = `translateY(${activeBtn.offsetTop}px)`;
    pill.style.height = activeBtn.offsetHeight + 'px';
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
        DATA.settings.adminKeyHash = await sha256Hex(key);
        await persist();
        closeModal(overlay);
        unlocked = true;
        applyLockUI();
        toast('Admin Key saved. You are unlocked for this session.');
      } else {
        const key = $('#adminKeyInput').value;
        const hash = await sha256Hex(key || '');
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
  // Most barcode scanners act as a fast keyboard: they "type" the code, then send Enter.
  // We buffer keystrokes and treat a fast burst ending in Enter as a scan.

  function initBarcodeScanning() {
    let buffer = '';
    let lastTime = 0;
    const FAST_GAP_MS = 40;   // scanners type far faster than a human
    const MIN_LEN = 3;

    document.addEventListener('keydown', (e) => {
      const now = Date.now();
      const gap = now - lastTime;
      lastTime = now;

      // Ignore navigation/modifier keys, but let printable characters and Enter through.
      if (e.key === 'Enter') {
        if (buffer.length >= MIN_LEN && gap < 300) {
          const code = buffer;
          buffer = '';
          handleScan(code, e);
        } else {
          buffer = '';
        }
        return;
      }
      if (e.key.length !== 1) return; // ignore Shift, Tab, arrows, etc.

      if (gap > FAST_GAP_MS) buffer = ''; // too slow to be a scanner burst; restart
      buffer += e.key;

      // Safety cap
      if (buffer.length > 40) buffer = buffer.slice(-40);
    }, true);
  }

  function handleScan(code, evt) {
    const active = document.activeElement;

    // If the SKU field in the product editor is focused, fill it instead of adding to cart.
    if (active && active.id === 'pmSku') {
      return; // let it type normally, the field already received the characters
    }
    // If typing in any other text input/select that isn't the till search box, don't intercept.
    const tag = active ? active.tagName.toLowerCase() : '';
    const isTypingField = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (isTypingField && active.id !== 'productSearch') return;

    // Only auto-add on the Till screen.
    if (!$('#view-till').classList.contains('active')) return;

    const product = DATA.products.find(p => (p.sku || '').toLowerCase() === code.toLowerCase());
    if (product) {
      pulseTapeBody();
      addToCart(product);
      toast('Scanned: ' + product.name);
      $('#productSearch').value = '';
      renderCatalog();
    } else {
      toast('No product with barcode "' + code + '"');
      $('#productSearch').value = code;
      renderCatalog();
      const input = $('#productSearch');
      input.classList.remove('shake-error');
      void input.offsetWidth;
      input.classList.add('shake-error');
    }
    evt.preventDefault();
  }

  function focusScanTarget() {
    const el = $('#productSearch');
    if (el && document.activeElement !== el) {
      // Don't steal focus from a modal that might be open.
      if (!$$('.modal-overlay.active').length) el.focus({ preventScroll: true });
    }
  }

  // ---------------- Till / catalog ----------------

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

  function renderCatalog() {
    renderCategoryChips();
    const q = ($('#productSearch').value || '').trim().toLowerCase();
    const grid = $('#productGrid');
    grid.innerHTML = '';

    const items = DATA.products.filter(p => {
      const matchCat = activeCategory === 'All' || p.category === activeCategory;
      const matchQ = !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q);
      return matchCat && matchQ;
    }).sort((a, b) => a.name.localeCompare(b.name));

    if (!items.length) {
      grid.innerHTML = '<div class="tape-empty" style="grid-column:1/-1;">No products match. Add stock from the Stock tab, or scan a barcode.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(p => {
      const card = document.createElement('button');
      const outOfStock = p.stock <= 0;
      card.className = 'product-card' + (outOfStock ? ' out-of-stock' : '');
      card.disabled = outOfStock;
      const low = p.stock > 0 && p.stock <= DATA.settings.lowStockThreshold;
      card.innerHTML = `
        <div class="product-card-name">${escapeHtml(p.name)}</div>
        <div class="product-card-meta">
          <span class="product-card-price">${money(p.price)}</span>
          <span class="product-card-stock ${low ? 'low' : ''}">${outOfStock ? 'Out of stock' : p.stock + ' left'}</span>
        </div>
      `;
      card.addEventListener('click', (e) => {
        if (card.disabled) return;
        flyToCart(card);
        pulseTapeBody();
        addToCart(p);
      });
      fragment.appendChild(card);
    });
    grid.appendChild(fragment);
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
      return;
    }
    if (existing) existing.qty += 1;
    else cart.push({ productId: product.id, name: product.name, price: product.price, qty: 1 });
    renderCart(existing ? product.id : null);
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

  async function completeSale() {
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
  }

  // ---------------- Refunds ----------------

  async function refundSale(sale) {
    if (sale.type === 'return') { toast('This is already a refund record.'); return; }
    const already = DATA.sales.some(s => s.refundOf === sale.id);
    if (already) { toast('This sale has already been refunded.'); return; }
    const ok = await confirmDialog(
      'Refund this sale?',
      'Refund sale #' + sale.number + ' for ' + money(sale.total) + '? Stock will be restored.',
      'Refund sale'
    );
    if (!ok) return;

    const refund = {
      id: uid('r'),
      number: DATA.nextSaleNumber++,
      date: new Date().toISOString(),
      type: 'return',
      refundOf: sale.id,
      items: sale.items,
      subtotal: -sale.subtotal,
      tax: -sale.tax,
      total: -sale.total,
      paymentMethod: sale.paymentMethod,
      tendered: -sale.total,
      change: 0
    };

    sale.items.forEach(li => {
      const p = DATA.products.find(pp => pp.id === li.productId);
      if (p) p.stock += li.qty;
    });

    DATA.sales.push(refund);
    await persist();
    renderCatalog();
    renderDaySummary();
    closeModal('#receiptModalOverlay');
    toast('Sale #' + sale.number + ' refunded.');
    if ($('#view-ledger').classList.contains('active')) renderLedger();
    if ($('#view-dashboard').classList.contains('active')) renderDashboard();
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
    lines.push((isReturn ? 'REFUND for Sale #' : 'Sale #') + sale.number);
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

  function receiptHtml(sale) {
    const text = receiptText(sale);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: 'Courier New', monospace; font-size: 12px; width: 280px; margin: 0 auto; padding: 12px 0; white-space: pre-wrap; }
      @media print { @page { margin: 6mm; } }
    </style></head><body>${escapeHtml(text)}</body></html>`;
  }

  function showReceiptModal(sale) {
    $('#receiptPreview').textContent = receiptText(sale);
    const canRefund = currentReceiptIsHistorical && sale.type !== 'return' && unlocked && !DATA.sales.some(s => s.refundOf === sale.id);
    $('#receiptRefundBtn').style.display = canRefund ? 'inline-flex' : 'none';
    openModal('#receiptModalOverlay');
  }

  function initReceiptModal() {
    $('#receiptCloseBtn').addEventListener('click', () => closeModal('#receiptModalOverlay'));
    $('#receiptPrintBtn').addEventListener('click', async () => {
      if (!currentSaleForReceipt) return;
      const res = await window.tally.printReceipt(receiptHtml(currentSaleForReceipt));
      if (res && res.ok) toast('Sent to printer.');
    });
    $('#receiptRefundBtn').addEventListener('click', () => {
      if (currentSaleForReceipt) refundSale(currentSaleForReceipt);
    });
  }

  // ---------------- Stock ----------------

  let selectedStockIds = new Set();

  function renderStock() {
    const filterSel = $('#stockCategoryFilter');
    const prevVal = filterSel.value || 'All';
    filterSel.innerHTML = '<option value="All">All categories</option>' +
      DATA.categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    filterSel.value = prevVal;

    const q = ($('#stockSearch').value || '').toLowerCase();
    const cat = filterSel.value || 'All';
    const body = $('#stockTableBody');

    const items = DATA.products
      .filter(p => (cat === 'All' || p.category === cat))
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Drop selections for products no longer in view (filtered out or deleted).
    const visibleIds = new Set(items.map(p => p.id));
    selectedStockIds.forEach(id => { if (!visibleIds.has(id)) selectedStockIds.delete(id); });

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:26px;">No products yet. Click "Add product", scan a barcode, or import a list.</td></tr>';
      updateStockBulkBar();
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(p => {
      const low = p.stock <= DATA.settings.lowStockThreshold;
      const checked = selectedStockIds.has(p.id);
      const tr = document.createElement('tr');
      if (checked) tr.classList.add('stock-row-selected');
      tr.innerHTML = `
        <td class="checkbox-col"><input type="checkbox" class="stock-row-check" ${checked ? 'checked' : ''} /></td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.sku || '—')}</td>
        <td>${escapeHtml(p.category)}</td>
        <td>${escapeHtml(p.supplier || '—')}</td>
        <td class="num">${money(p.price)}</td>
        <td class="num">${p.cost > 0 ? money(p.cost) : '<span class="cost-missing" title="No cost set — profit reporting will treat this as R0 cost">' + money(p.cost) + ' ⚠</span>'}</td>
        <td class="num"><span class="stock-badge ${low ? 'low' : ''}">${p.stock}</span></td>
        <td><span class="row-link">Edit</span></td>
      `;
      const checkbox = tr.querySelector('.stock-row-check');
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        if (checkbox.checked) selectedStockIds.add(p.id);
        else selectedStockIds.delete(p.id);
        tr.classList.toggle('stock-row-selected', checkbox.checked);
        updateStockBulkBar();
      });
      tr.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        openProductModal(p.id);
      });
      fragment.appendChild(tr);
    });
    body.innerHTML = '';
    body.appendChild(fragment);
    updateStockBulkBar();
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
    const selectAll = $('#stockSelectAll');
    const rowChecks = $$('.stock-row-check');
    selectAll.checked = rowChecks.length > 0 && rowChecks.every(cb => cb.checked);
    selectAll.indeterminate = n > 0 && !selectAll.checked;
  }

  function initStockView() {
    $('#addProductBtn').addEventListener('click', () => openProductModal(null));
    $('#stockSearch').addEventListener('input', debounce(renderStock, 120));
    $('#stockCategoryFilter').addEventListener('change', renderStock);

    $('#stockSelectAll').addEventListener('change', (e) => {
      const checked = e.target.checked;
      const q = ($('#stockSearch').value || '').toLowerCase();
      const cat = $('#stockCategoryFilter').value || 'All';
      const items = DATA.products
        .filter(p => (cat === 'All' || p.category === cat))
        .filter(p => !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q));

      if (checked) items.forEach(p => selectedStockIds.add(p.id));
      else selectedStockIds.clear();
      renderStock();
    });

    $('#stockBulkClearBtn').addEventListener('click', () => {
      selectedStockIds.clear();
      renderStock();
    });

    $('#stockBulkDeleteBtn').addEventListener('click', async () => {
      const n = selectedStockIds.size;
      if (!n) return;
      const ok = await confirmDialog(
        `Delete ${n} product${n > 1 ? 's' : ''}?`,
        `This removes ${n} product${n > 1 ? 's' : ''} from Stock permanently. Past sales already recorded are not affected. This can't be undone.`,
        'Delete selected'
      );
      if (!ok) return;
      DATA.products = DATA.products.filter(p => !selectedStockIds.has(p.id));
      selectedStockIds.clear();
      await persist();
      renderStock();
      toast(`${n} product${n > 1 ? 's' : ''} deleted.`);
    });
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
      const supplier = $('#pmSupplier').value.trim();
      const category = $('#pmCategory').value || DATA.categories[0] || 'General';

      if (editingProductId) {
        const p = DATA.products.find(pp => pp.id === editingProductId);
        Object.assign(p, { name, sku, category, price, cost, stock, supplier });
      } else {
        DATA.products.push({ id: nextProductId(), name, sku, category, price, cost, stock, supplier });
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

    const fragment = document.createDocumentFragment();
    sales.forEach(sale => {
      const tr = document.createElement('tr');
      const itemCount = sale.items.reduce((s, i) => s + i.qty, 0);
      const isReturn = sale.type === 'return';
      tr.innerHTML = `
        <td>${isReturn ? 'Refund ' : ''}#${sale.number}</td>
        <td>${new Date(sale.date).toLocaleString()}</td>
        <td>${itemCount}</td>
        <td class="num" style="${isReturn ? 'color:var(--stamp-red);' : ''}">${money(sale.total)}</td>
        <td>${escapeHtml(sale.paymentMethod)}</td>
        <td><span class="row-link">View</span></td>
      `;
      tr.addEventListener('click', () => {
        currentSaleForReceipt = sale;
        currentReceiptIsHistorical = true;
        showReceiptModal(sale);
      });
      fragment.appendChild(tr);
    });
    body.innerHTML = '';
    body.appendChild(fragment);
  }

  function initLedger() {
    $('#ledgerDateFilter').addEventListener('change', renderLedger);
    $('#ledgerClearFilter').addEventListener('click', () => {
      $('#ledgerDateFilter').value = '';
      renderLedger();
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
    const itemsSold = saleRecords.reduce((s, r) => s + r.items.reduce((a, i) => a + i.qty, 0), 0);
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
      const p = Math.min(1, (now - start) / duration);
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
    animateStatNumber('#statTodaySales', t.total, money);
    animateStatNumber('#statTodayProfit', t.profit, money);
    const marginPct = t.total !== 0 ? (t.profit / t.total) * 100 : 0;
    animateStatNumber('#statTodayMargin', marginPct, (v) => v.toFixed(1) + '%');
    animateStatNumber('#statTodayCount', t.transactions, (v) => Math.round(v).toString());
    animateStatNumber('#statTodayItems', t.itemsSold, (v) => Math.round(v).toString());

    const lowStockItems = DATA.products.filter(p => p.stock <= DATA.settings.lowStockThreshold);
    $('#statLowStock').textContent = lowStockItems.length;

    renderPaymentSplit('#paymentSplitToday', t, 'No sales in this period yet.');

    const periodSales = DATA.sales.filter(s => s.type !== 'return' && periodKeyFromDayKey(s.date.slice(0, 10), period) === currentKey);
    const tally = {};
    periodSales.forEach(sale => sale.items.forEach(li => { tally[li.name] = (tally[li.name] || 0) + li.qty; }));
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const rankList = $('#topSellersList');
    rankList.innerHTML = ranked.length
      ? ranked.map(([name, qty], i) => `<li><span class="rank-num">${i + 1}.</span>${escapeHtml(name)} — ${qty} sold</li>`).join('')
      : `<li class="plain-empty">No sales ${phrase} yet.</li>`;

    const lowList = $('#lowStockList');
    lowList.innerHTML = lowStockItems.length
      ? lowStockItems.map(p => `<li><span>${escapeHtml(p.name)}</span><span class="stock-badge low">${p.stock} left</span></li>`).join('')
      : '<li class="plain-empty">Everything is well stocked.</li>';

    renderHistory(period, currentKey);
  }

  const HISTORY_LIMITS = { day: 30, week: 16, month: 24, year: 10 };

  function renderHistory(period, currentKey) {
    const body = $('#historyTableBody');
    if (!body) return;

    const keys = new Set(DATA.sales.map(s => periodKeyFromDayKey(s.date.slice(0, 10), period)));
    keys.delete(currentKey);
    const sorted = Array.from(keys).sort((a, b) => b.localeCompare(a)).slice(0, HISTORY_LIMITS[period] || 30);

    if (!sorted.length) {
      body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:22px;">No previous ${period === 'day' ? 'days' : period === 'week' ? 'weeks' : period === 'month' ? 'months' : 'years'} yet — history builds up as sales come in.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    sorted.forEach(key => {
      const dt = computePeriodTotals(key, period);
      const label = periodLabel(key, period);
      const margin = dt.total !== 0 ? (dt.profit / dt.total) * 100 : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${label}</td>
        <td class="num">${money(dt.total)}</td>
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
    renderSettingsCategoryChips();
  }

  function renderSettingsCategoryChips() {
    const row = $('#settingsCategoryChips');
    row.innerHTML = '';
    DATA.categories.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.cursor = 'default';
      const inUse = DATA.products.some(p => p.category === c);
      chip.innerHTML = `${escapeHtml(c)} ${!inUse && DATA.categories.length > 1 ? '<span class="chip-remove" title="Remove">✕</span>' : ''}`;
      if (!inUse && DATA.categories.length > 1) {
        chip.querySelector('.chip-remove').addEventListener('click', async () => {
          DATA.categories = DATA.categories.filter(cat => cat !== c);
          await persist();
          renderSettingsCategoryChips();
        });
      }
      row.appendChild(chip);
    });
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

    $('#changeAdminKeyBtn').addEventListener('click', async () => {
      const current = $('#setCurrentKey').value;
      const next = $('#setNewKey').value;
      const confirmVal = $('#setConfirmKey').value;
      const currentHash = await sha256Hex(current || '');
      if (currentHash !== DATA.settings.adminKeyHash) { toast('Current Admin Key is incorrect.'); return; }
      if (!next || next.length < 4) { toast('New Admin Key should be at least 4 characters.'); return; }
      if (next !== confirmVal) { toast("New keys don't match."); return; }
      DATA.settings.adminKeyHash = await sha256Hex(next);
      await persist();
      $('#setCurrentKey').value = ''; $('#setNewKey').value = ''; $('#setConfirmKey').value = '';
      toast('Admin Key updated.');
    });

    $('#addCategoryBtn').addEventListener('click', async () => {
      const name = $('#newCategoryInput').value.trim();
      if (!name) return;
      if (DATA.categories.includes(name)) { toast('That category already exists.'); return; }
      DATA.categories.push(name);
      $('#newCategoryInput').value = '';
      await persist();
      renderSettingsCategoryChips();
    });

    $('#exportBackupBtn').addEventListener('click', async () => {
      const res = await window.tally.exportBackup();
      if (res.ok) toast('Backup saved to ' + res.filePath);
    });

    $('#importBackupBtn').addEventListener('click', async () => {
      try {
        const res = await window.tally.importBackup();
        if (res.ok) {
          DATA = res.data;
          if (!DATA.heldSales) DATA.heldSales = [];
          applyShopIdentity();
          refreshHeldButton();
          switchView('dashboard');
          toast('Backup imported.');
        }
      } catch (e) {
        toast('That file could not be read as a backup.');
      }
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
    const fresh = await window.tally.resetSalesStock();
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
    const fresh = await window.tally.resetAllData();
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

  // Each field's keyword list, most-specific-first. Matching is resolved
  // globally (see guessColumnMapping) rather than by greedily claiming
  // columns field-by-field, so a generic word like "price" inside
  // "SupplyPrice" can't steal a column that's actually a much better match
  // for Cost.
  const IMPORT_FIELDS = [
    { key: 'mapName', label: 'name', guesses: ['itemdescription', 'productname', 'itemname', 'description', 'name', 'product', 'item'] },
    { key: 'mapSku', label: 'sku', guesses: ['sku', 'barcode', 'upc', 'ean', 'itemid', 'itemcode', 'productcode', 'plu', 'code'] },
    { key: 'mapCategory', label: 'category', guesses: ['category', 'department', 'class', 'group', 'dept'] },
    { key: 'mapPrice', label: 'price', guesses: ['saleprice', 'retailprice', 'sellprice', 'unitprice', 'price', 'retail'] },
    { key: 'mapCost', label: 'cost', guesses: ['supplyprice', 'unitcost', 'wholesale', 'buyprice', 'costprice', 'cost'] },
    { key: 'mapStock', label: 'stock', guesses: ['qtyonhand', 'stockqty', 'onhand', 'quantity', 'inventory', 'stock', 'qty'] },
    { key: 'mapSupplier', label: 'supplier', guesses: ['suppliername', 'supplierid', 'supplier', 'vendor', 'distributor'] }
  ];

  function normHeader(h) { return h.toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Score every (header, field, keyword) combination that matches at all,
  // then greedily assign the highest-scoring pairs first. Exact matches
  // always outrank substring matches, and longer/more specific keywords
  // outrank shorter generic ones — so "SupplyPrice" exact-matching Cost's
  // "supplyprice" keyword (score ~111) wins over it merely containing
  // Price's generic "price" substring (score ~15).
  function guessColumnMapping(headers) {
    const candidates = [];
    headers.forEach(h => {
      const norm = normHeader(h);
      IMPORT_FIELDS.forEach(f => {
        f.guesses.forEach(g => {
          if (norm === g) candidates.push({ header: h, field: f.key, score: 100 + g.length });
          else if (norm.includes(g)) candidates.push({ header: h, field: f.key, score: 10 + g.length });
        });
      });
    });
    candidates.sort((a, b) => b.score - a.score);

    const result = {};
    const claimedHeaders = new Set();
    const claimedFields = new Set();
    candidates.forEach(c => {
      if (claimedHeaders.has(c.header) || claimedFields.has(c.field)) return;
      result[c.field] = c.header;
      claimedHeaders.add(c.header);
      claimedFields.add(c.field);
    });
    return result;
  }

  async function startProductImport() {
    const res = await window.tally.importProductsFile();
    if (!res) return;
    if (!res.ok) { if (res.error) toast(res.error); return; }
    importParsed = res;

    $('#importFileLabel').textContent = `From "${res.fileName}" — ${res.rows.length} row(s) found. Match the columns below, then import.`;

    const headerOptions = '<option value="">— Not in file —</option>' +
      res.headers.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');

    const guessed = guessColumnMapping(res.headers);
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
    DATA = await window.tally.loadData();
    if (!DATA.heldSales) DATA.heldSales = [];
    if (!DATA.settings.adminKeyHash) DATA.settings.adminKeyHash = '';
    applyShopIdentity();

    initNav();
    updateNavPill();
    initClock();
    initAdminModal();
    initBarcodeScanning();
    initHeldSales();
    initChargeModal();
    initReceiptModal();
    initStockView();
    initProductModal();
    initLedger();
    initSettingsView();
    initImportModal();
    initPeriodTabs();
    initReportsView();

    $('#productSearch').addEventListener('input', debounce(renderCatalog, 80));
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
