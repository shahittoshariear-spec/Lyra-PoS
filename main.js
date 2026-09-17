const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { buildReceipt } = require('./escpos');
const { sendRawToPrinter } = require('./rawprint');

const DATA_FILE = path.join(app.getPath('userData'), 'immaculate-pos-data.json');

const DEFAULT_DATA = {
  settings: {
    shopName: "My Shop",
    address: "",
    phone: "",
    currency: "R",
    taxRate: 0,
    receiptFooter: "Thank you for your business!",
    lowStockThreshold: 5,
    adminKeyHash: "",
    receiptPrinter: "",
    // Off by default. Cutting is the one step we cannot verify from the app, and
    // a printer that errors on a cut refuses every later receipt, so it waits
    // until Setup has shown a cut working on this printer.
    receiptCutPaper: false
  },
  categories: ["General"],
  products: [],
  sales: [],
  heldSales: [],
  nextProductId: 1,
  nextSaleNumber: 1001
};

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Backfill any missing top-level keys for forward-compatibility. Settings are
    // merged key by key so that settings added in later versions (the receipt
    // printer, for instance) appear for shops that already have a data file.
    const merged = { ...JSON.parse(JSON.stringify(DEFAULT_DATA)), ...parsed };
    merged.settings = { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) };
    return merged;
  } catch (err) {
    console.error('Failed to load data, backing up corrupt file and starting fresh.', err);
    try {
      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak-' + Date.now());
      }
    } catch (e) { /* ignore */ }
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  return true;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#16241F',
    autoHideMenuBar: true,
    title: 'Immaculate POS',
    icon: path.join(__dirname, 'src', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: data ----
ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (evt, data) => saveData(data));

// Full factory reset: wipes everything back to defaults, including the Admin Key.
ipcMain.handle('data:resetAll', () => {
  const fresh = JSON.parse(JSON.stringify(DEFAULT_DATA));
  saveData(fresh);
  return fresh;
});

// Clears sales/refund history and held sales, and zeroes every product's stock,
// but keeps the product catalog, settings, categories, and Admin Key intact.
ipcMain.handle('data:resetSalesStock', () => {
  const data = loadData();
  data.sales = [];
  data.heldSales = [];
  data.nextSaleNumber = 1001;
  data.products.forEach((p) => { p.stock = 0; });
  saveData(data);
  return data;
});

ipcMain.handle('data:exportBackup', async () => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export backup',
    defaultPath: `immaculate-pos-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.copyFileSync(DATA_FILE, filePath);
  return { ok: true, filePath };
});

ipcMain.handle('data:importBackup', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths.length) return { ok: false };
  const raw = fs.readFileSync(filePaths[0], 'utf-8');
  const parsed = JSON.parse(raw); // throws if invalid, caught by renderer
  saveData(parsed);
  return { ok: true, data: parsed };
});

// ---- IPC: importing a product list (from POS Maid's Excel export, or any spreadsheet/CSV) ----
ipcMain.handle('data:importProductsFile', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import products',
    filters: [{ name: 'Spreadsheet or CSV', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths.length) return { ok: false };

  try {
    const workbook = XLSX.readFile(filePaths[0]);
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rows.length) return { ok: false, error: 'That file has no rows to import.' };
    const headers = Object.keys(rows[0]);
    return { ok: true, fileName: path.basename(filePaths[0]), headers, rows };
  } catch (err) {
    return { ok: false, error: 'Could not read that file: ' + err.message };
  }
});

// ---- IPC: printing a receipt ----
// Renders the given HTML in a hidden window and prints it. If a specific
// printer name is provided (e.g. an Epson TM-T88III configured in Setup),
// prints silently straight to it — no dialog, ready for a real till. With
// no printer selected, falls back to the normal print dialog so the person
// can pick a printer or "Save as PDF" themselves.
ipcMain.handle('receipt:print', async (evt, html, deviceName) => {
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true }
  });
  const encoded = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  await printWin.loadURL(encoded);
  const options = { silent: !!deviceName, printBackground: true };
  if (deviceName) options.deviceName = deviceName;
  return new Promise((resolve) => {
    printWin.webContents.print(options, (success, failureReason) => {
      printWin.close();
      resolve({ ok: success, error: success ? null : failureReason });
    });
  });
});

// ---- IPC: printing a receipt straight to a thermal printer ----
// Sends the receipt text to the chosen printer as raw ESC/POS bytes. Because
// the spooler's RAW data type is used, the printer's Windows driver is never
// involved: this works for a printer that Windows can see but cannot print
// through, which is what happens with USB-to-parallel cables and Epson's APD.
// Setup stores the chosen printer in settings.receiptPrinter; when that is
// empty the dialog path above is used instead.
ipcMain.handle('receipt:printRaw', async (evt, text, printerName, options) => {
  const name = String(printerName || '').trim();
  if (!name) return { ok: false, error: 'No receipt printer selected in Setup.' };
  const opts = options || {};
  const data = buildReceipt(text, { cut: opts.cut !== false });
  return sendRawToPrinter(name, data);
});

// ---- IPC: listing installed printers, so Setup can offer a dropdown ----
ipcMain.handle('printer:list', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
    }));
  } catch (err) {
    return [];
  }
});
