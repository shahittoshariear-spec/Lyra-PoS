// Headless smoke test. Runs the real renderer (src/index.html + src/app.js) in
// an Electron window and drives it by clicking, exactly as a person would: ring
// up a sale, reprint it from the Ledger, part-refund a single line, then refund
// the rest, checking the saved sales, stock levels and totals as it goes.
// Data is served in memory over the same IPC the app uses, so your shop's data
// file is never touched.
//
// Run with:  npm run smoke
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');

// Point SMOKE_APP at another app folder — for example an installed bundle's
// resources/app.asar — to check a built or installed copy instead of the
// working one.
const APP_DIR = process.env.SMOKE_APP || path.join(__dirname, '..');
const ADMIN_KEY = '1234';
const adminKeyHash = crypto.createHash('sha256').update(ADMIN_KEY, 'utf8').digest('hex');

function freshData() {
  return {
    settings: {
      shopName: 'Test Shop', address: '1 Test Road', phone: '555 0100',
      currency: 'R', taxRate: 10, receiptFooter: 'Thank you',
      lowStockThreshold: 5, adminKeyHash, receiptPrinter: '', receiptCutPaper: false
    },
    categories: ['General', 'Pet'],
    products: [
      { id: 'p1', name: 'Widget', sku: 'W1', category: 'General', price: 10, cost: 4, stock: 10, supplier: '' },
      { id: 'p2', name: 'Gadget', sku: 'G1', category: 'General', price: 25, cost: 10, stock: 5, supplier: '' },
      { id: 'p3', name: 'Sprocket', sku: 'S1', category: 'General', price: 5, cost: 1, stock: 0, supplier: '' },
      { id: 'p4', name: 'Puppy Food 2kg', sku: 'PF2', alias: 'mp', category: 'Pet', price: 60, cost: 30, stock: 4, supplier: '' }
    ],
    sales: [], heldSales: [], nextProductId: 5, nextSaleNumber: 1001
  };
}

let DATA = freshData();
let printCalls = 0;
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  [' + detail + ']'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) < 0.005;
const stock = (id) => (DATA.products.find((p) => p.id === id) || {}).stock;
const product = (id) => DATA.products.find((p) => p.id === id);

ipcMain.handle('data:load', () => DATA);
ipcMain.handle('data:save', (e, d) => { DATA = d; return true; });
ipcMain.handle('data:resetAll', () => { DATA = freshData(); return DATA; });
ipcMain.handle('data:resetSalesStock', () => DATA);
ipcMain.handle('printer:list', () => [{ name: 'Fake Printer', displayName: 'Fake Printer', isDefault: true }]);
ipcMain.handle('receipt:print', () => { printCalls++; return { ok: true }; });
ipcMain.handle('receipt:printRaw', () => { printCalls++; return { ok: true, bytesWritten: 1 }; });

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click(); true`);

  // ---- 1. ring up a sale: 2 x Widget + 1 x Gadget (subtotal 45, 10% tax) ----
  await click('.product-card[data-id="p1"]');
  await click('.product-card[data-id="p1"]');
  await click('.product-card[data-id="p2"]');
  check('out-of-stock product is offered but disabled',
    await js(`document.querySelector('.product-card[data-id="p3"]').disabled === true`));

  await click('.tape-actions .btn-charge');
  await sleep(150);
  await js(`document.querySelector('#tenderedInput').value = '50'; true`);
  await click('#chargeConfirmBtn');
  await sleep(250);

  const sale = DATA.sales[0];
  check('sale recorded', !!sale && sale.number === 1001, sale && sale.total);
  check('sale total with tax', !!sale && near(sale.total, 49.5), sale && sale.total);
  check('stock taken off the shelf', stock('p1') === 8 && stock('p2') === 4,
    'p1=' + stock('p1') + ' p2=' + stock('p2'));
  check('receipt modal shown after sale',
    await js(`document.querySelector('#receiptModalOverlay').classList.contains('active')`));
  check('receipt modal titled for a new sale',
    (await js(`document.querySelector('#receiptModalTitle').textContent`)) === 'Sale complete');
  await click('#receiptCloseBtn');
  await sleep(250);
  check('the barcode box has the keyboard back after a sale',
    (await js(`document.activeElement.id`)) === 'productSearch',
    await js(`document.activeElement.id || document.activeElement.tagName`));

  // ---- 2. in Client mode, Stock and the Ledger can be used; Setup can't ----
  await click('.nav-btn[data-view="stock"]');
  await sleep(300);
  check('Client mode opens Stock without the Admin Key',
    await js(`document.querySelector('#view-stock').classList.contains('active')`));
  check('Client mode sees the stock list',
    (await js(`document.querySelectorAll('#stockTableBody tr[data-id]').length`)) > 0);

  // Switching to Stock hands the keyboard to the filter box, and a left arrow at
  // the start of that box clears it — while a left arrow anywhere else still
  // moves the caret, so editing a half-typed filter is unaffected.
  check('switching to Stock puts the caret in the stock filter',
    (await js(`document.activeElement.id`)) === 'stockSearch',
    await js(`document.activeElement.id || document.activeElement.tagName`));

  await js(`(() => { const el = document.querySelector('#stockSearch'); el.value = 'Widget'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const leftAway = await js(`(() => { const b = document.querySelector('#stockSearch');
    b.focus(); b.setSelectionRange(3, 3);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return b.value; })()`);
  check('a left arrow away from the start of the filter still moves the caret',
    leftAway === 'Widget', JSON.stringify(leftAway));

  const leftAtStart = await js(`(() => { const b = document.querySelector('#stockSearch');
    b.setSelectionRange(0, 0);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return [b.value, document.querySelectorAll('#stockTableBody tr[data-id]').length]; })()`);
  check('a left arrow with the caret at the start clears the stock filter',
    leftAtStart[0] === '', JSON.stringify(leftAtStart[0]));
  check('the whole list is back once the filter is cleared',
    leftAtStart[1] === 4, leftAtStart[1]);

  await click('#addProductBtn');
  await sleep(300);
  check('adding a product in Client mode needs no Admin Key',
    await js(`document.querySelector('#productModalOverlay').classList.contains('active')`));
  check('no Admin Key prompt appeared for it',
    !(await js(`document.querySelector('#adminModalOverlay').classList.contains('active')`)));
  check('the add form has no search name field',
    (await js(`document.querySelector('#pmAlias') === null`)) === true);
  await click('#pmCancelBtn');
  await sleep(350);

  // Editing an existing product, and the bulk delete, are open in Client mode too.
  await click('#stockTableBody tr[data-id="p2"]');
  await sleep(300);
  check('editing a product in Client mode needs no Admin Key',
    await js(`document.querySelector('#productModalOverlay').classList.contains('active')`));
  check('the editor opened on the product that was clicked',
    (await js(`document.querySelector('#pmSku').value`)) === 'G1',
    await js(`document.querySelector('#pmSku').value`));
  const deleteOffered = await js(`getComputedStyle(document.querySelector('#pmDeleteBtn')).display`);
  check('deleting a product is offered too', deleteOffered !== 'none', deleteOffered);
  check('the edit form has no search name field either',
    (await js(`document.querySelector('#pmAlias') === null`)) === true);
  await click('#pmCancelBtn');
  await sleep(350);
  check('closing the product editor hands the keyboard back to the filter',
    (await js(`document.activeElement.id`)) === 'stockSearch',
    await js(`document.activeElement.id || document.activeElement.tagName`));

  await click('.nav-btn[data-view="ledger"]');
  await sleep(300);
  const ledgerText = await js(`document.querySelector('#ledgerTableBody').textContent`);
  check('Client mode opens the Ledger without the Admin Key',
    await js(`document.querySelector('#view-ledger').classList.contains('active')`));
  check('ledger lists the sale', ledgerText.includes('#1001'), ledgerText.replace(/\s+/g, ' ').trim().slice(0, 40));
  check('ledger row has a Reprint link',
    await js(`!!document.querySelector('#ledgerTableBody .row-link[data-action="print"]')`));

  // ... and it can hand money back without being unlocked.
  await click('#ledgerTableBody tr[data-id="' + sale.id + '"] .row-link[data-action="view"]');
  await sleep(300);
  check('Client mode can refund without the Admin Key',
    (await js(`getComputedStyle(document.querySelector('#receiptRefundBtn')).display`)) !== 'none');
  await click('#receiptCloseBtn');
  await sleep(300);

  // ---- 2b. Setup still needs the key, and unlocking lands on the view asked for ----
  await click('.nav-btn[data-view="settings"]');
  await sleep(250);
  check('Setup still asks for the Admin Key',
    await js(`document.querySelector('#adminModalOverlay').classList.contains('active')`));
  await js(`document.querySelector('#adminKeyInput').value = ${JSON.stringify(ADMIN_KEY)}; true`);
  await click('#adminModalOverlay .btn-primary');
  await sleep(400);
  check('the Admin Key unlocks and opens the view it was asked for',
    await js(`document.querySelector('#view-settings').classList.contains('active')`));

  // Back to the Ledger, which is where the next steps carry on from.
  await click('.nav-btn[data-view="ledger"]');
  await sleep(300);

  // ---- 3. reprint straight from the ledger ----
  await click('#ledgerTableBody .row-link[data-action="print"]');
  await sleep(300);
  check('Reprint prints without opening the preview', printCalls === 1, 'printCalls=' + printCalls);
  check('Reprint did not open the receipt modal',
    !(await js(`document.querySelector('#receiptModalOverlay').classList.contains('active')`)));

  // ---- 4. part-refund: one of the two Widgets ----
  await click('#ledgerTableBody tr[data-id="' + sale.id + '"] .row-link[data-action="view"]');
  await sleep(300);
  check('past sale receipt is labelled a reprint',
    (await js(`document.querySelector('#receiptPrintBtn').textContent`)) === 'Reprint receipt');
  check('refund offered on a past sale',
    (await js(`getComputedStyle(document.querySelector('#receiptRefundBtn')).display`)) !== 'none');

  await click('#receiptRefundBtn');
  await sleep(300);
  check('refund modal opened',
    await js(`document.querySelector('#refundModalOverlay').classList.contains('active')`));
  const defaultsToAll = await js(`document.querySelector('#refundTotalValue').textContent`);
  check('refund defaults to everything', defaultsToAll === 'R49.50', defaultsToAll);
  check('full quantity is offered on each line',
    (await js(`document.querySelectorAll('#refundLines .refund-line-qty-num')[0].textContent`)) === '2');

  // Take one Widget off, and the Gadget right down to nothing, so this refunds
  // only one line of a multi-line sale.
  await js(`document.querySelectorAll('#refundLines .refund-line')[0].querySelector('[data-step="-1"]').click(); true`);
  await sleep(150);
  const oneSelected = await js(`document.querySelector('#refundTotalValue').textContent`);
  check('refunding one of two items of a two-item sale is 35.00 + 3.50', oneSelected === 'R38.50', oneSelected);

  await js(`document.querySelectorAll('#refundLines .refund-line')[1].querySelector('[data-step="-1"]').click(); true`);
  await sleep(200);
  const partialTotal = await js(`document.querySelector('#refundTotalValue').textContent`);
  check('one Widget refunds 10.00 plus 1.00 tax', partialTotal === 'R11.00', partialTotal);
  check('confirm enabled once something is selected',
    !(await js(`document.querySelector('#refundConfirmBtn').disabled`)));

  await click('#refundConfirmBtn');
  await sleep(250);
  check('refund asks for confirmation',
    await js(`document.querySelector('#confirmModalOverlay').classList.contains('active')`));
  await click('#confirmModalOkBtn');
  await sleep(450);

  const refund = DATA.sales[1];
  check('refund stored as its own record', !!refund && refund.type === 'return' && refund.refundOf === sale.id);
  check('refund total is negative', !!refund && near(refund.total, -11), refund && refund.total);
  check('refund tax apportioned from the sale', !!refund && near(refund.tax, -1), refund && refund.tax);
  check('refund holds only the handed-back item',
    !!refund && refund.items.length === 1 && refund.items[0].qty === 1, refund && refund.items.length);
  check('stock returned for that item', stock('p1') === 9, 'p1=' + stock('p1'));
  check('untouched item keeps its stock', stock('p2') === 4, 'p2=' + stock('p2'));

  const refundReceipt = await js(`document.querySelector('#receiptPreview').textContent`);
  check('refund receipt names the original sale',
    refundReceipt.includes('REFUND of Sale #1001'), JSON.stringify(refundReceipt.split('\n')[4]));
  check('refund receipt marked as part of the sale', refundReceipt.includes('part of the sale above'));
  check('refund receipt titled with the refund number',
    (await js(`document.querySelector('#receiptModalTitle').textContent`)) === 'Refund #1002');
  check('no refund button on a refund receipt',
    (await js(`getComputedStyle(document.querySelector('#receiptRefundBtn')).display`)) === 'none');
  await click('#receiptCloseBtn');
  await sleep(300);

  const ledgerAfter = await js(`document.querySelector('#ledgerTableBody').textContent`);
  check('ledger shows the refund against its sale',
    ledgerAfter.includes('Refund #1002') && ledgerAfter.includes('of #1001'),
    ledgerAfter.replace(/\s+/g, ' ').trim().slice(0, 60));

  // ---- 5. refund the rest of the sale ----
  await click('#ledgerTableBody tr[data-id="' + sale.id + '"] .row-link[data-action="view"]');
  await sleep(300);
  check('partly refunded sale can still be refunded',
    (await js(`getComputedStyle(document.querySelector('#receiptRefundBtn')).display`)) !== 'none');
  await click('#receiptRefundBtn');
  await sleep(300);
  const remainder = await js(`document.querySelector('#refundTotalValue').textContent`);
  check('only the remainder is refundable (38.50)', remainder === 'R38.50', remainder);
  check('already refunded line shows 1 of 2 refundable',
    (await js(`document.querySelectorAll('#refundLines .refund-line-meta')[0].textContent`)).includes('1 of 2'));
  await click('#refundConfirmBtn');
  await sleep(250);
  await click('#confirmModalOkBtn');
  await sleep(450);

  check('all stock is back', stock('p1') === 10 && stock('p2') === 5,
    'p1=' + stock('p1') + ' p2=' + stock('p2'));
  check('final record closes the sale off',
    DATA.sales.length === 3 && near(DATA.sales[2].total, -38.5),
    DATA.sales.length + ' records, last ' + (DATA.sales[2] && DATA.sales[2].total));
  await click('#receiptCloseBtn');
  await sleep(300);

  await click('#ledgerTableBody tr[data-id="' + sale.id + '"] .row-link[data-action="view"]');
  await sleep(300);
  check('fully refunded sale offers no more refunds',
    (await js(`getComputedStyle(document.querySelector('#receiptRefundBtn')).display`)) === 'none');
  await click('#receiptCloseBtn');
  await sleep(300);

  // ---- 6. the till reflects it ----
  await click('.nav-btn[data-view="till"]');
  await sleep(400);
  const dsTotal = await js(`document.querySelector('#dsTotal').textContent`);
  check('day summary nets the refunds back to zero', dsTotal === 'R0.00', dsTotal);
  check('product cost untouched by refunds', near(product('p1').cost, 4));

  // ---- 6b. Enter completes a sale, from the payment dialog ----
  const toastMsg = () => js(`document.querySelector('#toast').textContent`);
  const salesBefore = DATA.sales.length;
  await click('.product-card[data-id="p1"]');
  await sleep(250);
  await click('.tape-actions .btn-charge');
  await sleep(350);

  // Too little cash is refused, exactly as the button refuses it.
  await js(`(() => { const el = document.querySelector('#tenderedInput'); el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  await js(`document.querySelector('#tenderedInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(400);
  check('Enter with too little cash does not complete the sale',
    DATA.sales.length === salesBefore && (await toastMsg()).includes('less than the total'),
    DATA.sales.length + ' sales | toast: ' + (await toastMsg()));

  await js(`(() => { const el = document.querySelector('#tenderedInput'); el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(250);
  check('the change due is shown before Enter completes',
    (await js(`document.querySelector('#changeAmount').textContent`)) === '9.00',
    await js(`document.querySelector('#changeAmount').textContent`));

  await js(`document.querySelector('#tenderedInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(500);
  check('Enter completes the sale', DATA.sales.length === salesBefore + 1, DATA.sales.length);
  const enteredSale = DATA.sales[DATA.sales.length - 1];
  check('the sale keeps what was tendered and the change',
    !!enteredSale && near(enteredSale.tendered, 20) && near(enteredSale.change, 9),
    enteredSale && (enteredSale.tendered + ' tendered, ' + enteredSale.change + ' change'));
  check('stock comes off the shelf for it', stock('p1') === 9, 'p1=' + stock('p1'));
  await click('#receiptCloseBtn');
  await sleep(300);

  // Enter arrives in pairs when a cashier is in a hurry: one sale, not two.
  const salesBeforeDouble = DATA.sales.length;
  await click('.product-card[data-id="p1"]');
  await sleep(250);
  await click('.tape-actions .btn-charge');
  await sleep(350);
  await js(`(() => { const el = document.querySelector('#tenderedInput'); el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const send = () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    send(); send(); return true; })()`);
  await sleep(800);
  check('pressing Enter twice records one sale, not two',
    DATA.sales.length === salesBeforeDouble + 1, DATA.sales.length + ' sales');
  check('and takes the stock off once', stock('p1') === 8, 'p1=' + stock('p1'));
  await click('#receiptCloseBtn');
  await sleep(300);

  // ---- 6c. payment is cash or card, nothing else ----
  const salesBeforeCard = DATA.sales.length;
  await click('.product-card[data-id="p1"]');
  await sleep(250);
  await click('.tape-actions .btn-charge');
  await sleep(350);
  const methods = await js(`Array.from(document.querySelectorAll('#paymentMethodSeg .seg-btn')).map(b => b.dataset.method).join()`);
  check('the payment dialog offers only cash and card', methods === 'Cash,Card', methods);

  await click('#paymentMethodSeg .seg-btn[data-method="Card"]');
  await sleep(250);
  check('choosing card hides the amount tendered',
    (await js(`getComputedStyle(document.querySelector('#tenderedField')).display`)) === 'none',
    await js(`getComputedStyle(document.querySelector('#tenderedField')).display`));

  // Enter from anywhere in the dialog: card needs no amount typed.
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(700);
  const cardSale = DATA.sales[DATA.sales.length - 1];
  check('Enter completes a card sale with no amount typed',
    DATA.sales.length === salesBeforeCard + 1 && !!cardSale && cardSale.paymentMethod === 'Card'
      && near(cardSale.tendered, cardSale.total) && near(cardSale.change, 0),
    cardSale && (cardSale.paymentMethod + ', ' + cardSale.tendered + ' tendered, ' + cardSale.change + ' change'));
  await click('#receiptCloseBtn');
  await sleep(300);

  // ---- 7. search names: typing "mp" should find Puppy Food ----
  // Each executeJavaScript runs in the page's global scope, so anything declared
  // here has to be scoped to an IIFE or the second call collides with the first.
  const typeSearch = (box, text) => js(`(() => { const el = document.querySelector('${box}'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const gridIds = () => js(`Array.from(document.querySelectorAll('#productGrid .product-card')).map(c => c.dataset.id).join()`);

  await typeSearch('#productSearch', 'mp');
  await sleep(300);
  check('an alias finds its product', (await gridIds()) === 'p4', await gridIds());

  await typeSearch('#productSearch', 'm');
  await sleep(300);
  check('part of an alias is enough', (await gridIds()) === 'p4', await gridIds());

  await typeSearch('#productSearch', 'PF2');
  await sleep(300);
  check('the SKU still finds it', (await gridIds()) === 'p4', await gridIds());

  await typeSearch('#productSearch', 'mp');
  await sleep(300);
  await click('.product-card[data-id="p4"]');
  await sleep(300);
  check('the search box empties once the item is added',
    (await js(`document.querySelector('#productSearch').value`)) === '');
  check('the whole list comes back after adding',
    (await js(`document.querySelectorAll('#productGrid .product-card').length`)) === 4,
    await js(`document.querySelectorAll('#productGrid .product-card').length`));
  check('the item went into the sale',
    (await js(`document.querySelector('.tape-items').textContent`)).includes('Puppy Food'));

  // ---- 8. a product that already carries a search name keeps it through an edit ----
  await click('.nav-btn[data-view="stock"]');
  await sleep(400);
  await typeSearch('#stockSearch', 'Puppy');
  await sleep(300);
  await click('#stockTableBody tr[data-id="p4"]');
  await sleep(350);
  check('the editor opens without a search name field',
    (await js(`document.querySelector('#pmAlias') === null`)) === true);
  // Renamed as well as saved, so a save that quietly did nothing cannot pass the
  // next check by leaving the search name untouched.
  await js(`document.querySelector('#pmName').value = 'Puppy Food 2kg (edited)'; true`);
  await click('#pmSaveBtn');
  await sleep(450);
  check('editing a product keeps its search name',
    (product('p4') || {}).alias === 'mp' && (product('p4') || {}).name === 'Puppy Food 2kg (edited)',
    (product('p4') || {}).alias + ' / ' + (product('p4') || {}).name);
  const searchNameBadge = await js(`(() => { const b = document.querySelector('#stockTableBody tr[data-id="p4"] .row-sub'); return b ? b.textContent.trim() : ''; })()`);
  check('the search name is still shown in the stock list', searchNameBadge === 'mp', searchNameBadge);

  // ---- 9. categories: delete one that is in use, then add one ----
  await click('.nav-btn[data-view="settings"]');
  await sleep(450);
  check('settings lists the categories',
    (await js(`document.querySelector('#settingsCategoryChips').textContent`)).includes('Pet'));
  await js(`Array.from(document.querySelectorAll('#settingsCategoryChips .chip')).find(c => c.textContent.includes('Pet')).querySelector('.chip-remove').click(); true`);
  await sleep(300);
  check('deleting a category in use asks first',
    await js(`document.querySelector('#confirmModalOverlay').classList.contains('active')`));
  await click('#confirmModalOkBtn');
  await sleep(450);
  check('category deleted', DATA.categories.indexOf('Pet') === -1 && DATA.categories.includes('General'),
    DATA.categories.join());
  check('its products moved to another category',
    (product('p4') || {}).category === 'General', (product('p4') || {}).category);
  check('moved products kept the rest of their details',
    (product('p4') || {}).alias === 'mp' && near((product('p4') || {}).price, 60));
  check('the deleted category is gone from settings',
    !(await js(`document.querySelector('#settingsCategoryChips').textContent`)).includes('Pet'));

  await js(`document.querySelector('#newCategoryInput').value = 'Hardware'; true`);
  await click('#addCategoryBtn');
  await sleep(450);
  check('a category can be added', DATA.categories.includes('Hardware'), DATA.categories.join());
  await js(`document.querySelector('#newCategoryInput').value = 'hardware'; true`);
  await click('#addCategoryBtn');
  await sleep(300);
  check('a duplicate category is refused',
    DATA.categories.filter(c => c.toLowerCase() === 'hardware').length === 1, DATA.categories.join());
  check('both categories can be removed while there are two',
    (await js(`document.querySelectorAll('#settingsCategoryChips .chip-remove').length`)) === 2,
    DATA.categories.join());

  await js(`Array.from(document.querySelectorAll('#settingsCategoryChips .chip')).find(c => c.textContent.includes('Hardware')).querySelector('.chip-remove').click(); true`);
  await sleep(400);
  check('an unused category deletes without asking', DATA.categories.join() === 'General', DATA.categories.join());
  check('the last category offers no remove button',
    (await js(`document.querySelectorAll('#settingsCategoryChips .chip-remove').length`)) === 0);

  // ---- 10. scanning into the barcode box ----
  await click('.nav-btn[data-view="till"]');
  await sleep(400);

  const boxValue = () => js(`document.querySelector('#productSearch').value`);
  const tapeText = () => js(`document.querySelector('.tape-items').textContent`);
  const toastText = () => js(`document.querySelector('#toast').textContent`);
  const pressEnter = () => js(`document.querySelector('#productSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);

  // Types a code into the box the way a scanner would, with a delay between
  // keystrokes if asked for, then sends the Enter a scanner always sends.
  const scanType = async (text, gapMs) => {
    await js(`(() => { const el = document.querySelector('#productSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(150);
    for (const ch of text) {
      await js(`(() => { const el = document.querySelector('#productSearch'); el.value += ${JSON.stringify(ch)}; el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(ch)}, bubbles: true })); return true; })()`);
      if (gapMs) await sleep(gapMs);
    }
    await pressEnter();
  };

  // Like scanType, but the characters never reach the barcode box — which is what
  // actually happens when the box has lost focus (straight after a sale, or after
  // clicking anywhere). The app has to go by the keystrokes alone. They are sent
  // inside one call so the timing is a scanner's, not the test's.
  const scanUnfocused = async (text, enterGapMs) => {
    await js(`(() => { const el = document.querySelector('#productSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); return true; })()`);
    await sleep(150);
    await js(`(() => {
      const send = (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      ${text.split('').map(ch => `send(${JSON.stringify(ch)});`).join(' ')}
      return true;
    })()`);
    if (enterGapMs) await sleep(enterGapMs);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  };

  await scanType('PF2', 0);
  await sleep(400);
  check('a scanned barcode is added to the sale', (await tapeText()).includes('Puppy Food'));
  check('the barcode box is left empty after a scan', (await boxValue()) === '', JSON.stringify(await boxValue()));

  // Slower than the burst detector allows, which is what a scanner on a busy
  // till can look like: it must still add the item and still clear the box.
  await scanType('G1', 120);
  await sleep(400);
  check('a slow scan still adds the item', (await tapeText()).includes('Gadget'));
  check('the box is empty after a slow scan too', (await boxValue()) === '', JSON.stringify(await boxValue()));

  // The box is not always focused: after a sale, or after clicking a product,
  // the scanner's characters never reach it. This used to drop scans outright.
  await scanUnfocused('PF2');
  await sleep(400);
  check('a scan with the box unfocused still adds the item',
    (await tapeText()).includes('Puppy Food'), await tapeText());
  check('the box is empty after an unfocused scan', (await boxValue()) === '', JSON.stringify(await boxValue()));

  // A slow scanner's Enter can land a moment after its last character.
  await scanUnfocused('G1', 250);
  await sleep(400);
  check('a slow Enter still adds the item', (await tapeText()).includes('Gadget'), await tapeText());

  // Scanning something with nothing left must not leave its code sitting in the
  // box, waiting to be glued onto the front of the next scan.
  await scanType('S1', 0);
  await sleep(400);
  check('an out-of-stock scan says why', (await toastText()).includes('Not enough stock'), await toastText());
  check('an out-of-stock scan leaves the box empty', (await boxValue()) === '', JSON.stringify(await boxValue()));
  await scanType('W1', 0);
  await sleep(400);
  check('the very next scan still lands', (await tapeText()).includes('Widget'), await tapeText());

  await js(`(() => { const el = document.querySelector('#productSearch'); el.value = 'puppy'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(250);
  await pressEnter();
  await sleep(300);
  check('a search name can be committed with Enter', (await toastText()).includes('Added: Puppy Food'), await toastText());
  check('the box is empty after committing a search name', (await boxValue()) === '');

  await scanType('NOPE-999', 0);
  await sleep(400);
  check('an unknown code stays on screen so it can be read',
    (await boxValue()) === 'NOPE-999', JSON.stringify(await boxValue()));
  check('an unknown code says so', (await toastText()).includes('No product matches'), await toastText());
  check('an unknown code is left selected, so the next scan replaces it',
    (await js(`(() => { const el = document.querySelector('#productSearch'); return el.value === 'NOPE-999' && el.selectionStart === 0 && el.selectionEnd === 8; })()`)) === true,
    await js(`(() => { const el = document.querySelector('#productSearch'); return el.value + ' sel ' + el.selectionStart + '-' + el.selectionEnd; })()`));

  // The next scan types over that selection, the way a focused box does, so the
  // old code is replaced rather than glued onto the front of the new one.
  await js(`(() => {
    const el = document.querySelector('#productSearch');
    const start = el.selectionStart, end = el.selectionEnd;
    el.value = el.value.slice(0, start) + 'W1' + el.value.slice(end);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    return true;
  })()`);
  await pressEnter();
  await sleep(400);
  check('the scan after an unknown code replaces it and lands',
    (await tapeText()).includes('Widget'), JSON.stringify(await boxValue()));

  // ---- 11. overview: what the stock on the shelf is worth ----
  await click('.nav-btn[data-view="dashboard"]');
  await sleep(450);
  const worthAtCost = DATA.products.reduce((s, p) => s + Math.max(0, p.stock || 0) * (p.cost || 0), 0);
  const worthAtSell = DATA.products.reduce((s, p) => s + Math.max(0, p.stock || 0) * (p.price || 0), 0);
  const shownAtCost = await js(`document.querySelector('#statStockValueCost').textContent`);
  const shownAtSell = await js(`document.querySelector('#statStockValueSell').textContent`);
  check('overview values the stock at cost',
    shownAtCost === DATA.settings.currency + worthAtCost.toFixed(2),
    shownAtCost + ' vs ' + DATA.settings.currency + worthAtCost.toFixed(2));
  check('overview values the stock at sell',
    shownAtSell === DATA.settings.currency + worthAtSell.toFixed(2),
    shownAtSell + ' vs ' + DATA.settings.currency + worthAtSell.toFixed(2));

  // ---- 12. a product added from the add form carries no search name with it ----
  await click('.nav-btn[data-view="stock"]');
  await sleep(400);
  await click('#addProductBtn');
  await sleep(400);
  await js(`(() => { document.querySelector('#pmName').value = 'Added Test';
    document.querySelector('#pmPrice').value = '5';
    document.querySelector('#pmCost').value = '2';
    document.querySelector('#pmStock').value = '3';
    return true; })()`);
  await click('#pmSaveBtn');
  await sleep(500);
  const addedProduct = DATA.products.find(p => p.name === 'Added Test');
  check('a product can be added with the search name left off the form', !!addedProduct);
  check('the added product carries no search name over from a previous edit',
    !!addedProduct && (addedProduct.alias || '') === '', addedProduct && JSON.stringify(addedProduct.alias));

  // ---- 13. the low-stock list deletes: one row, or several at once ----
  await click('.nav-btn[data-view="dashboard"]');
  await sleep(450);
  const lowRowIds = async () => (await js(`Array.from(document.querySelectorAll('#lowStockList li[data-id]')).map(li => li.dataset.id).join()`)).split(',').filter(Boolean);
  const catalogueBefore = DATA.products.length;
  const lowRowsBefore = await lowRowIds();
  check('the low-stock list offers a delete on every row',
    (await js(`document.querySelectorAll('#lowStockList li[data-id] .row-link[data-del]').length`)) === lowRowsBefore.length,
    lowRowsBefore.length + ' rows');
  check('a low-stock row shows the product barcode beside Delete',
    (await js(`document.querySelector('#lowStockList li[data-id="${lowRowsBefore[0]}"] .low-stock-code').textContent`)) === (product(lowRowsBefore[0]) || {}).sku,
    await js(`document.querySelector('#lowStockList li[data-id="${lowRowsBefore[0]}"] .low-stock-code').textContent`));

  const singleId = lowRowsBefore[0];
  await click(`#lowStockList li[data-id="${singleId}"] .row-link[data-del]`);
  await sleep(300);
  check('deleting a low-stock row asks first',
    await js(`document.querySelector('#confirmModalOverlay').classList.contains('active')`));
  await click('#confirmModalOkBtn');
  await sleep(500);
  check('the row is deleted from the catalogue',
    DATA.products.length === catalogueBefore - 1 && !product(singleId), singleId);
  check('it leaves the low-stock list',
    !(await lowRowIds()).includes(singleId));

  const twoIds = (await lowRowIds()).slice(0, 2);
  check('there are rows left to multi-select', twoIds.length === 2, twoIds.join());
  await js(`Array.from(document.querySelectorAll('#lowStockList .low-stock-check')).slice(0, 2).forEach(c => c.click()); true`);
  await sleep(250);
  check('ticking rows brings up the delete bar',
    (await js(`getComputedStyle(document.querySelector('#lowStockBulkBar')).display`)) !== 'none');
  check('the bar counts what is ticked',
    (await js(`document.querySelector('#lowStockBulkCount').textContent`)) === '2 selected',
    await js(`document.querySelector('#lowStockBulkCount').textContent`));

  await click('#lowStockBulkDeleteBtn');
  await sleep(300);
  await click('#confirmModalOkBtn');
  await sleep(500);
  check('deleting several at once removes them all',
    twoIds.every(id => !product(id)) && DATA.products.length === catalogueBefore - 3,
    twoIds.join() + ' -> ' + DATA.products.length + ' left');
  check('the delete bar goes away once nothing is ticked',
    (await js(`getComputedStyle(document.querySelector('#lowStockBulkBar')).display`)) === 'none');

  // ---- 14. the Stock table's own bulk delete, which shares that code path ----
  await click('.nav-btn[data-view="stock"]');
  await sleep(450);
  // The filter is still holding "Puppy" from section 8, and that product was
  // deleted in section 13 — so clear it first, or there are no rows to tick.
  await js(`(() => { const el = document.querySelector('#stockSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const stockBefore = DATA.products.length;
  check('the stock table has a row for every product left',
    (await js(`document.querySelectorAll('#stockTableBody .stock-row-check').length`)) === stockBefore,
    stockBefore + ' products');
  await js(`Array.from(document.querySelectorAll('#stockTableBody .stock-row-check')).slice(0, 2).forEach(c => c.click()); true`);
  await sleep(250);
  check('ticking stock rows brings up the bulk bar',
    (await js(`getComputedStyle(document.querySelector('#stockBulkBar')).display`)) !== 'none');
  await click('#stockBulkDeleteBtn');
  await sleep(300);
  check('the stock bulk delete asks first',
    await js(`document.querySelector('#confirmModalOverlay').classList.contains('active')`));
  await click('#confirmModalOkBtn');
  await sleep(500);
  check('the stock bulk delete removes the ticked products',
    DATA.products.length === stockBefore - 2, stockBefore + ' -> ' + DATA.products.length);

  // ---- 15. a big number is grouped, so it can be counted ----
  await click('.nav-btn[data-view="stock"]');
  await sleep(400);
  await click('#addProductBtn');
  await sleep(400);
  await js(`(() => { document.querySelector('#pmName').value = 'Bulk Dog Food 40kg';
    document.querySelector('#pmPrice').value = '12345.67';
    document.querySelector('#pmCost').value = '1000';
    document.querySelector('#pmStock').value = '100';
    return true; })()`);
  await click('#pmSaveBtn');
  await sleep(500);
  await click('.nav-btn[data-view="dashboard"]');
  await sleep(500);

  // Grouped here independently, so the check is not simply the app agreeing with
  // itself: 100 x 1000 = 100,000 and 100 x 12345.67 = 1,234,567.
  const group = (n) => {
    const parts = n.toFixed(2).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  };
  const bulk = DATA.products.find(p => p.name === 'Bulk Dog Food 40kg');
  const wantCost = DATA.settings.currency + group(bulk ? Math.max(0, bulk.stock) * bulk.cost : 0);
  const wantSell = DATA.settings.currency + group(bulk ? Math.max(0, bulk.stock) * bulk.price : 0);
  const gotCost = await js(`document.querySelector('#statStockValueCost').textContent`);
  const gotSell = await js(`document.querySelector('#statStockValueSell').textContent`);
  check('inventory at cost is grouped every three digits', gotCost === wantCost, gotCost + ' vs ' + wantCost);
  check('inventory at sell is grouped every three digits', gotSell === wantSell, gotSell + ' vs ' + wantSell);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1360,
    height: 860,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  try {
    await win.loadFile(path.join(APP_DIR, 'src', 'index.html'));
    await sleep(2200);
    const cards = await win.webContents.executeJavaScript(`document.querySelectorAll('.product-card').length`, true);
    console.log('booted with ' + cards + ' product cards\n');
    await run(win);
  } catch (err) {
    console.log('HARNESS ERROR: ' + err.message);
    results.push({ name: 'harness', pass: false });
  }
  if (errors.length) {
    console.log('\nrenderer console errors:');
    errors.slice(0, 10).forEach((m) => console.log('  ' + m));
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  app.exit(failed ? 1 : 0);
});
