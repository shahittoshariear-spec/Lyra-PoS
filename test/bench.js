// Performance benchmark for the app's hot paths, run against a dataset the size
// of a real shop's. Prints a table of timings; run before and after a change to
// see what actually moved.
//
//   npm run bench                       (2448 products / 62 sales, the real size)
//   BENCH_PRODUCTS=12000 BENCH_SALES=5000 npm run bench
//
// Like the smoke test it serves its data in memory, so nothing touches your
// shop's data file.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = process.env.SMOKE_APP || path.join(__dirname, '..');
const PRODUCTS = parseInt(process.env.BENCH_PRODUCTS, 10) || 2448;
const SALES = parseInt(process.env.BENCH_SALES, 10) || 62;
const CATEGORIES = 12;

const ADJ = ['Puppy', 'Adult', 'Senior', 'Premium', 'Budget', 'Organic', 'Grain Free', 'Large Breed', 'Small Breed', 'Dental', 'Joint', 'Skin & Coat'];
const NOUN = ['Food', 'Kibble', 'Treats', 'Chews', 'Biscuits', 'Biltong', 'Pellets', 'Mix', 'Nuggets', 'Cubes'];

function makeData() {
  const categories = [];
  for (let i = 0; i < CATEGORIES; i++) categories.push('Cat ' + (i + 1));

  const products = [];
  for (let i = 0; i < PRODUCTS; i++) {
    const adj = ADJ[i % ADJ.length];
    const noun = NOUN[Math.floor(i / ADJ.length) % NOUN.length];
    products.push({
      id: 'p' + (i + 1),
      name: adj + ' ' + noun + ' ' + ((i % 40) + 1) + 'kg',
      sku: 'SKU' + String(100000 + i),
      alias: i % 7 === 0 ? 'x' + i : '',
      category: categories[i % categories.length],
      price: 5 + (i % 90) + 0.99,
      cost: 2 + (i % 40),
      stock: (i % 30),
      supplier: i % 3 === 0 ? 'Supplier ' + (i % 5) : ''
    });
  }

  const sales = [];
  let number = 1001;
  for (let i = 0; i < SALES; i++) {
    const items = [];
    let subtotal = 0;
    const lines = 1 + (i % 5);
    for (let j = 0; j < lines; j++) {
      const p = products[(i * 7 + j * 13) % products.length];
      const qty = 1 + (j % 3);
      const lineTotal = p.price * qty;
      subtotal += lineTotal;
      items.push({ productId: p.id, name: p.name, price: p.price, cost: p.cost, qty, lineTotal });
    }
    const tax = subtotal * 0.1;
    sales.push({
      id: 's' + i, number: number++, date: new Date(Date.now() - i * 3600000 * 8).toISOString(),
      type: 'sale', items, subtotal, tax, total: subtotal + tax,
      paymentMethod: i % 3 === 0 ? 'Card' : 'Cash', tendered: subtotal + tax, change: 0
    });
  }

  return {
    settings: {
      shopName: 'Bench Shop', address: '1 Bench Road', phone: '555 0100', currency: 'R',
      taxRate: 10, receiptFooter: 'Thank you', lowStockThreshold: 5,
      adminKeyHash: crypto.createHash('sha256').update('1234', 'utf8').digest('hex'),
      receiptPrinter: '', receiptCutPaper: false
    },
    categories, products, sales, heldSales: [], nextProductId: PRODUCTS + 1, nextSaleNumber: number
  };
}

let DATA = makeData();
const rows = [];
function row(label, ms, extra) {
  rows.push({ label, ms, extra });
  console.log(label.padEnd(42) + String(ms.toFixed(1)).padStart(9) + ' ms' + (extra ? '   ' + extra : ''));
}

ipcMain.handle('data:load', () => DATA);
ipcMain.handle('data:save', (e, d) => { DATA = d; return true; });
ipcMain.handle('data:resetAll', () => DATA);
ipcMain.handle('data:resetSalesStock', () => DATA);
ipcMain.handle('printer:list', () => []);
ipcMain.handle('receipt:print', () => ({ ok: true }));
ipcMain.handle('receipt:printRaw', () => ({ ok: true, bytesWritten: 1 }));

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click(); true`);

  // Time a view switch from the click to the layout being done, taking the best
  // of a few clicks so one busy moment can't decide the number. The renders are
  // synchronous, but the browser lays out lazily — so the measurement has to
  // force that layout itself, otherwise it only ever counts the JS and the
  // layout lands outside the window (and lands on a later row's number).
  const switchMs = async (view) => {
    return js(`(() => {
      const btn = document.querySelector('.nav-btn[data-view="${view}"]');
      let best = Infinity;
      for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        btn.click();
        void document.body.offsetHeight;
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    })()`);
  };

  // Type into a search box and wait for the list to actually change, so the
  // number is what a person waits for (including the debounce).
  const searchMs = async (box, grid, text) => {
    return js(`new Promise((resolve) => {
      const el = document.querySelector('${box}');
      const target = document.querySelector('${grid}');
      const t0 = performance.now();
      const obs = new MutationObserver(() => { obs.disconnect(); resolve(performance.now() - t0); });
      obs.observe(target, { childList: true, subtree: true });
      el.value = '${text}';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => { obs.disconnect(); resolve(-1); }, 5000);
    })`);
  };

  // Time an action to the point its result is on screen.
  const untilMs = async (action, condition) => {
    return js(`new Promise((resolve) => {
      const t0 = performance.now();
      ${action}
      const done = () => {
        if (${condition}) { resolve(performance.now() - t0); return true; }
        return false;
      };
      if (done()) return;
      const obs = new MutationObserver(() => { if (done()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      const iv = setInterval(() => { if (done()) { clearInterval(iv); obs.disconnect(); } }, 10);
      setTimeout(() => { clearInterval(iv); obs.disconnect(); resolve(-1); }, 8000);
    })`);
  };

  console.log('\ndataset: ' + PRODUCTS + ' products, ' + SALES + ' sales, ' + CATEGORIES + ' categories\n');

  row('data load over IPC', await js(`(async () => { const t0 = performance.now(); await window.tally.loadData(); return performance.now() - t0; })()`));
  // The app's own DATA lives inside its IIFE, so fetch a full-size payload the
  // same way and send it back — the same work persist() does on every sale.
  row('data save over IPC (persist)', await js(`(async () => { const d = await window.tally.loadData(); const t0 = performance.now(); await window.tally.saveData(d); return performance.now() - t0; })()`));

  row('unlock (admin key check)', await untilMs(
    `document.querySelector('.nav-btn[data-view="dashboard"]').click();`,
    `document.querySelector('#adminModalOverlay').classList.contains('active')`
  ));
  await js(`(() => { document.querySelector('#adminKeyInput').value = '1234'; return true; })()`);
  row('unlock (accept admin key)', await untilMs(`document.querySelector('#adminModalOverlay .btn-primary').click();`, `document.querySelector('#view-dashboard').classList.contains('active')`));

  row('view: ledger (' + SALES + ' rows)', await switchMs('ledger'));
  row('view: dashboard', await switchMs('dashboard'));
  row('view: reports', await switchMs('reports'));
  row('view: stock (' + PRODUCTS + ' products)', await switchMs('stock'));
  console.log(''.padEnd(42) + String(await js(`document.querySelectorAll('#stockTableBody tr').length`)).padStart(9) + ' rows drawn   capped: ' + (await js(`!!document.querySelector('#stockTableBody .table-more')`)));

  row('stock search (typed, incl. debounce)', await searchMs('#stockSearch', '#stockTableBody', 'Puppy'));
  row('stock search cleared (full table)', await searchMs('#stockSearch', '#stockTableBody', ''));

  // "Show more" has to actually reveal the next page of rows, not just claim to.
  const rowsBefore = await js(`document.querySelectorAll('#stockTableBody tr[data-id]').length`);
  row('stock "Show more" (next page)', await untilMs(
    `(() => { const b = document.querySelector('#stockTableBody [data-more="stock"]'); if (b) b.click(); })();`,
    `document.querySelectorAll('#stockTableBody tr[data-id]').length > ${rowsBefore}`
  ));
  const rowsAfter = await js(`document.querySelectorAll('#stockTableBody tr[data-id]').length`);
  console.log(''.padEnd(42) + String(rowsBefore).padStart(9) + ' -> ' + rowsAfter + ' rows revealed');
  const cappedAfterMore = await js(`!!document.querySelector('#stockTableBody .table-more')`);
  console.log(''.padEnd(42) + String(cappedAfterMore).padStart(9) + ' still more to show');

  row('view: till', await switchMs('till'));
  row('till search (typed, incl. debounce)', await searchMs('#productSearch', '#productGrid', 'Puppy'));
  row('till search cleared', await searchMs('#productSearch', '#productGrid', ''));

  row('scan a barcode (add + clear box)', await untilMs(
    `(() => { const el = document.querySelector('#productSearch'); el.value = 'SKU100005'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })();`,
    `document.querySelector('.tape-items').textContent.includes('SKU') || document.querySelectorAll('.tape-line').length > 0`
  ));

  row('complete a sale (incl. saving)', await untilMs(
    `document.querySelector('.tape-actions .btn-charge').click(); setTimeout(() => { document.querySelector('#tenderedInput').value = '500'; document.querySelector('#chargeConfirmBtn').click(); }, 120);`,
    `document.querySelector('#receiptModalOverlay').classList.contains('active')`
  ));

  row('open a past sale + refund modal', await untilMs(
    `(() => { document.querySelector('#receiptCloseBtn').click(); document.querySelector('.nav-btn[data-view="ledger"]').click(); const tr = document.querySelector('#ledgerTableBody tr[data-id]'); tr.querySelector('.row-link[data-action="view"]').click(); document.querySelector('#receiptRefundBtn').click(); })();`,
    `document.querySelector('#refundModalOverlay').classList.contains('active')`
  ));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1360, height: 860,
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const t0 = Date.now();
  try {
    await win.loadFile(path.join(APP_DIR, 'src', 'index.html'));
    const poll = async (condition, budgetMs) => {
      const started = Date.now();
      while (Date.now() - started < budgetMs) {
        if (await win.webContents.executeJavaScript(condition, true)) return Date.now() - started;
        await new Promise((r) => setTimeout(r, 5));
      }
      return -1;
    };
    const splash = await poll(`(() => { const s = document.querySelector('.splash-screen'); return !s || s.classList.contains('hide'); })()`, 8000);
    const drawn = await poll(`document.querySelectorAll('#productGrid .product-card').length > 0`, 8000);
    console.log('');
    console.log('splash cleared'.padEnd(42) + String(splash).padStart(9) + ' ms');
    console.log('Till drawn (from load)'.padEnd(42) + String(drawn).padStart(9) + ' ms    (includes splash + ~5ms polling)');
    await run(win);
  } catch (err) {
    console.log('BENCH ERROR: ' + err.message);
  }
  console.log('');
  app.exit(0);
});
