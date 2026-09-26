#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Lyra PoS — an offline point-of-sale app for a small shop.
//!
//! Everything that touches the machine lives here: the data file, backups,
//! spreadsheet imports and printing. The screens are plain HTML, CSS and
//! JavaScript in `ui/`, which is where the layout and the animations live.

mod data;
mod escpos;
mod import;
mod mail;
mod page_print;
mod pdf;
mod printing;
mod report;

use std::sync::Mutex;
use std::time::Duration;

use data::Data;
use import::ParsedFile;
use printing::PrinterInfo;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Serialises writes to the data file, so two saves can never interleave and
/// leave a torn file behind.
#[derive(Default)]
struct DataLock(Mutex<()>);

fn lock(data: &DataLock) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    data.0
        .lock()
        .map_err(|_| "The data file is busy.".to_string())
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_data() -> Data {
    Data::load()
}

#[tauri::command]
fn save_data(data: Data, lock_state: tauri::State<'_, DataLock>) -> Result<(), String> {
    let _guard = lock(&lock_state)?;
    data.save().map_err(|e| e.to_string())
}

/// Full factory reset: back to a blank install, including the Admin Key.
#[tauri::command]
fn reset_all_data(lock_state: tauri::State<'_, DataLock>) -> Result<Data, String> {
    let _guard = lock(&lock_state)?;
    let fresh = Data::default();
    fresh.save().map_err(|e| e.to_string())?;
    Ok(fresh)
}

/// Clears sales, refunds and held sales and zeroes every product's stock, but
/// keeps the catalog, settings, categories and Admin Key.
#[tauri::command]
fn reset_sales_stock(lock_state: tauri::State<'_, DataLock>) -> Result<Data, String> {
    let _guard = lock(&lock_state)?;
    let mut current = Data::load();
    current.reset_sales_and_stock();
    current.save().map_err(|e| e.to_string())?;
    Ok(current)
}

/// Hashes an Admin Key the way the app has always stored it, so a key set in the
/// original still unlocks this one. Hex, lower case, 64 characters — SHA-256.
#[tauri::command]
fn hash_admin_key(key: String) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Lets the screens report something they could not deal with themselves.
///
/// A till in a shop has nobody watching developer tools, so a failure the front
/// end cannot recover from is written to the log rather than vanishing.
#[tauri::command]
fn report_problem(what: String, detail: String) {
    eprintln!("[lyra-pos] {what}: {detail}");
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

#[tauri::command]
async fn export_backup(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let default_name = format!(
        "lyra-pos-backup-{}.json",
        chrono::Local::now().format("%Y-%m-%d")
    );
    let picked = app
        .dialog()
        .file()
        .set_title("Export backup")
        .set_file_name(default_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    let Some(picked) = picked else {
        return Ok(None); // the person changed their mind
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    data::export_backup(&path).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn import_backup(app: tauri::AppHandle) -> Result<Option<Data>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Import backup")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    data::import_backup(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Importing a product list
// ---------------------------------------------------------------------------

#[tauri::command]
async fn import_products_file(app: tauri::AppHandle) -> Result<Option<ParsedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Import products")
        .add_filter("Spreadsheet or CSV", &["xlsx", "xls", "xlsb", "ods", "csv"])
        .blocking_pick_file();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    import::read_products_file(&path).map(Some)
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_printers() -> Vec<PrinterInfo> {
    tauri::async_runtime::spawn_blocking(printing::list_printers)
        .await
        .unwrap_or_default()
}

/// Sends a receipt to a thermal printer as raw ESC/POS.
///
/// Deliberately off the main thread: this waits for the printer to actually take
/// the job, which can take several seconds on a printer that has stopped
/// responding. Freezing the window while that happens would be worse than the
/// error it is trying to report.
#[tauri::command]
async fn print_receipt_raw(printer: String, text: String, cut: bool) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || printing::print_receipt_raw(&printer, &text, cut))
        .await
        .map_err(|e| e.to_string())?
}

/// How long past the webview's own deadline this still waits, for the handover to
/// the window's thread rather than for the printer: the webview's deadline only
/// starts once that thread is free to run the print.
const GRACE: Duration = Duration::from_secs(10);

/// Prints the page the screens have dressed for printing — the receipt — with no
/// dialog at all, on the printer chosen in Setup or on the Windows default one.
///
/// The webview can only be driven from the thread that owns it, so the work is
/// handed to that thread and this waits for it. The wait is bounded on both
/// sides of the handover, so a printer that never answers leaves the till
/// usable rather than stuck.
#[tauri::command]
async fn print_page_silent(
    window: tauri::WebviewWindow,
    printer: Option<String>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = tx.send(page_print::print_page(&webview, printer.as_deref()));
        })
        .map_err(|e| format!("The app could not ask its own window to print: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(page_print::WAIT + GRACE))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| {
            "Printing did not finish. Check the printer is switched on, has paper and is not \
             paused, then print again."
                .to_string()
        })?
}

// ---------------------------------------------------------------------------
// Emailing the day's report
// ---------------------------------------------------------------------------

/// Keeps the Gmail App Password in Windows Credential Manager, where it stays
/// out of the shop's data file and out of every backup of it. An empty password
/// forgets a saved one.
#[tauri::command]
fn save_mail_password(password: String) -> Result<(), String> {
    mail::save_password(&password)
}

/// Whether a password is saved, so Setup can say so without showing it.
#[tauri::command]
fn has_mail_password() -> bool {
    mail::has_password()
}

/// Builds the day's report as a PDF and emails it as an attachment.
///
/// Off the main thread, and off the webview's: this waits on a socket, and a
/// shop with no internet must get a message about it rather than a window that
/// has stopped answering.
#[tauri::command]
async fn send_daily_report(request: mail::MailRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mail::send_daily_report(request))
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DataLock::default())
        .setup(|app| {
            // The window is created from `tauri.conf.json`; give it the app icon
            // as well, so the taskbar and the window itself agree.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Lyra PoS");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            reset_all_data,
            reset_sales_stock,
            hash_admin_key,
            report_problem,
            export_backup,
            import_backup,
            import_products_file,
            list_printers,
            print_receipt_raw,
            print_page_silent,
            save_mail_password,
            has_mail_password,
            send_daily_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lyra PoS");
}
