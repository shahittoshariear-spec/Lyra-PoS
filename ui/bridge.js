'use strict';

// ---------------------------------------------------------------------------
// The one place the screens talk to the machine.
//
// Each call resolves to a plain object rather than throwing, so the screens can
// go on saying `if (res && res.ok)` exactly as they always have — a printer that
// is switched off is a message on screen, not an unhandled rejection.
// ---------------------------------------------------------------------------

(() => {
  const invoke = window.__TAURI__.core.invoke;

  const call = (command, args) => invoke(command, args);

  // A till in a shop has nobody watching developer tools, so anything the
  // screens cannot recover from goes to the Rust log instead of vanishing.
  // Installed here, before the screens load, so it is already watching by the
  // time app.js runs.
  const report = (what, detail) => {
    call('report_problem', { what, detail: String(detail == null ? '' : detail) }).catch(() => {});
  };
  window.addEventListener('error', (event) => {
    report('uncaught error', event.message + ' at ' + (event.filename || '?') + ':' + (event.lineno || 0));
  });
  window.addEventListener('unhandledrejection', (event) => {
    report('unhandled rejection', (event.reason && (event.reason.stack || event.reason.message)) || event.reason);
  });

  window.pos = {
    loadData: () => call('load_data'),

    saveData: (data) => call('save_data', { data }),

    // The Admin Key is hashed here rather than in the page, so the stored hash
    // is exactly the one the app has always used and a key set in the old
    // version still unlocks this one.
    hashAdminKey: (key) => call('hash_admin_key', { key: String(key == null ? '' : key) }),

    resetAllData: () => call('reset_all_data'),

    resetSalesStock: () => call('reset_sales_stock'),

    // Resolves {ok:false} when the dialog was dismissed without choosing,
    // {ok:false, error} when the file could not be used, and {ok:true, …} when
    // it worked. That is the shape every call site already expected.
    async exportBackup() {
      try {
        const filePath = await call('export_backup');
        return filePath ? { ok: true, filePath } : { ok: false };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async importBackup() {
      try {
        const data = await call('import_backup');
        return data ? { ok: true, data } : { ok: false };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async importProductsFile() {
      try {
        const file = await call('import_products_file');
        return file ? { ok: true, ...file } : { ok: false };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async listPrinters() {
      try {
        return await call('list_printers');
      } catch (err) {
        return [];
      }
    },

    // Straight to a thermal printer as raw ESC/POS bytes. The printer's own
    // Windows driver is never involved, so this works with printers that cannot
    // print through their own driver.
    async printReceiptRaw(text, printerName, options) {
      const name = String(printerName == null ? '' : printerName).trim();
      if (!name) return { ok: false, error: 'No receipt printer selected in Setup.' };
      const opts = options || {};
      try {
        const bytesWritten = await call('print_receipt_raw', {
          printer: name,
          text: String(text == null ? '' : text),
          cut: opts.cut !== false
        });
        return { ok: true, bytesWritten };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    // The fallback: the system's own print dialog, so a receipt can be saved as
    // a PDF or sent to a printer whose driver is the only way to reach it. The
    // receipt is already plain text laid out 32 columns wide, so it is put where
    // the print stylesheet can show it on its own and nothing else of the app
    // goes on the paper.
    //
    // This goes through the page's own window.print() rather than Tauri's
    // WebviewWindow::print(), which is macOS-only on this version.
    async printReceipt(text) {
      const root = document.getElementById('printRoot');
      if (!root || typeof window.print !== 'function') {
        return { ok: false, error: 'This computer will not open a print dialog.' };
      }
      // The receipt is left in place rather than cleared afterwards. The dialog
      // takes its snapshot of the page a moment after being asked to open, so
      // emptying this straight away would print a blank sheet.
      root.textContent = String(text == null ? '' : text);
      try {
        // Two frames, so the receipt is laid out and painted before the dialog
        // opens.
        await new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        window.print();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    // Prints without any dialog at all, through the webview's own printing: the
    // print stylesheet leaves the receipt as the only thing on the page, so what
    // comes out is the receipt and nothing else. Used when no thermal printer is
    // chosen in Setup; the preview above stays as the fallback for a machine
    // with no default printer or an older webview runtime.
    async printPageSilent(printer) {
      const name = String(printer == null ? '' : printer).trim();
      try {
        await call('print_page_silent', { printer: name });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    // The Gmail App Password is held by Windows Credential Manager, never by the
    // shop's data file, and is never handed back to the screens — saving it is a
    // one-way trip. An empty string forgets it.
    async saveMailPassword(password) {
      try {
        await call('save_mail_password', { password: String(password == null ? '' : password) });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async hasMailPassword() {
      try { return !!(await call('has_mail_password')); } catch (err) { return false; }
    },

    async sendDailyReport(request) {
      try {
        await call('send_daily_report', { request });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  };
})();
