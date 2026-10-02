//! The saved shape of the shop's data, and reading and writing it.
//!
//! Every field is `#[serde(default)]`, so a data file written by an older
//! version — or one a shop has hand-edited — still loads: anything absent falls
//! back to its default rather than failing the whole load. This mirrors the
//! key-by-key merge the original app did in `loadData()`.
//!
//! The keys are exactly the ones the original wrote (`camelCase`), so a data
//! file or a backup file moves between the two apps untouched.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The shop's folder and file inside the machine's standard app-data folder
/// (on Windows, `%APPDATA%\Lyra PoS\lyra-pos-data.json`).
pub const DATA_DIR_NAME: &str = "Lyra PoS";
pub const DATA_FILE_NAME: &str = "lyra-pos-data.json";

/// The folder automatic backups are kept in, beside the data file. Their names
/// carry the date and time, which sort as text, oldest first — which is all the
/// pruning below needs to know.
const BACKUP_DIR_NAME: &str = "backups";
/// Backups this app writes are named `lyra-backup-<date>_<time>.json`. The
/// prefix and extension also keep anything else in the folder, including the
/// half-written `.part` of an interrupted copy, out of the pruning.
const BACKUP_PREFIX: &str = "lyra-backup-";
/// How many automatic backups are kept before the oldest is deleted. Left
/// alone, the folder would grow without bound on a till used every day.
const BACKUPS_KEPT: usize = 12;

/// Earlier names this app shipped under, newest first. Renaming the app moves
/// its data folder, which would otherwise hide an existing shop's data — so on
/// first run, if we have no data file of our own, the first valid one of these
/// is copied across and an upgrade never looks like a fresh install.
const LEGACY_DATA_FILES: &[(&str, &str)] = &[
    ("End PoS", "end-pos-data.json"),
    ("End PoS", "immaculate-pos-data.json"),
    ("Immaculate POS", "end-pos-data.json"),
    ("Immaculate POS", "immaculate-pos-data.json"),
];

fn default_shop_name() -> String {
    "My Shop".to_string()
}
fn default_currency() -> String {
    "R".to_string()
}
fn default_receipt_footer() -> String {
    "Thank you for your business!".to_string()
}
fn default_low_stock_threshold() -> i64 {
    5
}
fn default_next_product_id() -> i64 {
    1
}
fn default_next_sale_number() -> i64 {
    1001
}
fn default_categories() -> Vec<String> {
    vec!["General".to_string()]
}
fn default_mail_port() -> u16 {
    465
}
fn default_report_auto_time() -> String {
    // The end of a working day, which is when a shop wants the figures for it.
    "17:30".to_string()
}
fn default_backup_every() -> String {
    // A copy a day is more than a small shop needs, and the folder has to stay
    // readable; a week is the middle of what Setup offers.
    "week".to_string()
}

/// One key the shop has bound in Setup, as the screens wrote it. The shape is
/// theirs; this end only has to keep it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutBinding {
    /// The combination, like "Ctrl+2" or "F9". Empty means unbound.
    pub key: String,
    /// "press" fires at once, "hold" only after the key is kept down. Empty
    /// falls back to whatever the action's own default is.
    pub mode: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub shop_name: String,
    pub address: String,
    pub phone: String,
    pub currency: String,
    pub tax_rate: f64,
    pub receipt_footer: String,
    pub low_stock_threshold: i64,
    /// One-way SHA-256 hash of the Admin Key. Empty means "no key set yet", and
    /// the app asks for one on the next launch.
    pub admin_key_hash: String,
    /// The receipt printer chosen in Setup, by its system name. Empty means
    /// "ask me each time" — the normal print dialog rather than a direct print.
    pub receipt_printer: String,
    /// Off by default. Cutting is the one step we cannot verify from the app, and
    /// a printer that errors on a cut refuses every later receipt, so it waits
    /// until Setup has shown a cut working on this printer.
    pub receipt_cut_paper: bool,
    /// Where the day's report is emailed to, and the Gmail account it is sent
    /// from. The password itself is not here — it lives in Windows Credential
    /// Manager — but these are ordinary settings and belong in the data file.
    pub report_email: String,
    pub mail_from: String,
    /// Left blank for Gmail's own server; Setup fills it in when saved.
    pub mail_host: String,
    pub mail_port: u16,
    /// The day report going by itself is on by default, waiting for an address;
    /// a shop with nothing set up hears nothing either way.
    pub report_auto: bool,
    pub report_auto_time: String,
    /// A copy of the data file kept beside it, weekly by default.
    pub backup_auto: bool,
    pub backup_every: String,
    /// The shop's own keyboard shortcuts, by action id, exactly as Setup wrote
    /// them. Opaque here: only the screens know what an action does.
    pub shortcuts: BTreeMap<String, ShortcutBinding>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shop_name: default_shop_name(),
            address: String::new(),
            phone: String::new(),
            currency: default_currency(),
            tax_rate: 0.0,
            receipt_footer: default_receipt_footer(),
            low_stock_threshold: default_low_stock_threshold(),
            admin_key_hash: String::new(),
            receipt_printer: String::new(),
            receipt_cut_paper: false,
            report_email: String::new(),
            mail_from: String::new(),
            mail_host: String::new(),
            mail_port: default_mail_port(),
            report_auto: true,
            report_auto_time: default_report_auto_time(),
            backup_auto: true,
            backup_every: default_backup_every(),
            shortcuts: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub sku: String,
    /// A short code of the shop's own, like "mp" for Puppy Food. The product
    /// form no longer offers one, so nothing sets it now, but a product that
    /// already carries one still matches on it when searching and scanning.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub alias: String,
    pub category: String,
    pub price: f64,
    pub cost: f64,
    pub stock: i64,
    pub supplier: String,
}

/// One line of the sale being built at the till — and also the shape a held
/// sale's cart is stored in.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CartLine {
    pub product_id: String,
    pub name: String,
    pub price: f64,
    pub qty: i64,
}

/// One line of a sale already recorded in the Ledger. Carries the cost the
/// product had at the moment of sale, so profit reporting never drifts when a
/// cost is edited afterwards.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SaleItem {
    pub product_id: String,
    pub name: String,
    pub price: f64,
    pub qty: i64,
    pub line_total: f64,
    pub cost: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SaleKind {
    #[default]
    #[serde(rename = "sale")]
    Sale,
    #[serde(rename = "return")]
    Return,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sale {
    pub id: String,
    pub number: i64,
    /// RFC 3339 in UTC, exactly as the original's `toISOString()` wrote it.
    /// Grouping into days, weeks, months and years is all derived from the first
    /// ten characters of this string, so the buckets never disagree.
    pub date: String,
    #[serde(rename = "type")]
    pub kind: SaleKind,
    /// Set on a refund: the id of the sale it came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_of: Option<String>,
    /// Set on a refund: the number of the sale it came from, kept so the link
    /// survives even if the original sale is ever removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_of_number: Option<i64>,
    pub items: Vec<SaleItem>,
    pub subtotal: f64,
    pub tax: f64,
    pub total: f64,
    pub payment_method: String,
    pub tendered: f64,
    pub change: f64,
    /// A sale paid partly in cash and partly by card carries what each side
    /// took. Simple sales leave both out and stand by `payment_method`, so
    /// their records read exactly as the old app wrote them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cash_paid: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_paid: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HeldSale {
    pub id: String,
    pub cart: Vec<CartLine>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub settings: Settings,
    pub categories: Vec<String>,
    pub products: Vec<Product>,
    pub sales: Vec<Sale>,
    pub held_sales: Vec<HeldSale>,
    pub next_product_id: i64,
    pub next_sale_number: i64,
    /// Day reports that could not be sent yet, kept exactly as the screens
    /// wrote them — the day, the snapshot and the last error. Opaque here.
    pub report_queue: Vec<serde_json::Value>,
    /// When the last automatic backup was written, as the screens' clock read
    /// it (milliseconds since the epoch). Absent until the first one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_backup_at: Option<f64>,
    /// The local day key ("YYYY-MM-DD") the automatic report last went out on,
    /// or empty. A restart on the same day must not send it twice.
    pub last_auto_report: String,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            categories: default_categories(),
            products: Vec::new(),
            sales: Vec::new(),
            held_sales: Vec::new(),
            next_product_id: default_next_product_id(),
            next_sale_number: default_next_sale_number(),
            report_queue: Vec::new(),
            last_backup_at: None,
            last_auto_report: String::new(),
        }
    }
}

impl Data {
    /// Where the data file lives, creating the folder if it isn't there yet.
    pub fn file_path() -> Option<PathBuf> {
        let dir = dirs::data_dir()?.join(DATA_DIR_NAME);
        Some(dir.join(DATA_FILE_NAME))
    }

    /// Reads the shop's data from its usual place, adopting an earlier install's
    /// file first if there isn't one of our own.
    pub fn load() -> Data {
        let Some(path) = Self::file_path() else {
            return Data::default();
        };
        if !path.exists() {
            adopt_legacy_data_file(&path);
        }
        Self::load_from(&path)
    }

    /// Reads the shop's data from a given file. A missing file creates one; an
    /// unreadable one is backed up beside itself and replaced, rather than
    /// taking the app down.
    pub fn load_from(path: &Path) -> Data {
        if !path.exists() {
            let data = Data::default();
            let _ = data.save_to(path);
            return data;
        }

        let Ok(raw) = fs::read_to_string(path) else {
            return Self::recover(path);
        };
        match serde_json::from_str::<Data>(&raw) {
            Ok(data) => data.normalised(),
            Err(_) => Self::recover(path),
        }
    }

    /// Keeps the unreadable file so nothing is silently lost, then starts fresh.
    fn recover(path: &Path) -> Data {
        let stamp = chrono::Local::now().format("%Y%m%d%H%M%S%3f");
        let backup = path.with_extension(format!("json.bak-{stamp}"));
        let _ = fs::rename(path, &backup);
        let data = Data::default();
        let _ = data.save_to(path);
        data
    }

    /// Backfills anything a hand-edited or older file could be missing.
    fn normalised(mut self) -> Data {
        if self.categories.is_empty() {
            self.categories = default_categories();
        }
        if self.next_sale_number == 0 {
            self.next_sale_number = default_next_sale_number();
        }
        if self.next_product_id == 0 {
            self.next_product_id = default_next_product_id();
        }
        self
    }

    /// Writes the shop's data to its usual place.
    pub fn save(&self) -> std::io::Result<()> {
        let path = Self::file_path()
            .ok_or_else(|| std::io::Error::other("no app data directory available"))?;
        self.save_to(&path)
    }

    /// Writes the shop's data to a given file.
    ///
    /// Written to a temporary file and then moved into place, so a crash or a
    /// full disk part-way through a write can never leave a half-written data
    /// file behind: the previous good file survives until the new one is whole.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        // A rename over an existing file fails on Windows, so clear the way
        // first. The gap is one syscall wide and the temp file is already whole.
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        fs::rename(&tmp, path)
    }

    /// Clears sales, refunds and held sales, and zeroes every product's stock,
    /// keeping the catalog, settings, categories and Admin Key.
    pub fn reset_sales_and_stock(&mut self) {
        self.sales.clear();
        self.held_sales.clear();
        self.next_sale_number = default_next_sale_number();
        for p in &mut self.products {
            p.stock = 0;
        }
    }
}

/// Copies an earlier install's data file into place, once, if we have none of
/// our own. Only a file that parses is ever copied, so an unusable one is
/// skipped rather than adopted, and an existing file is never overwritten.
fn adopt_legacy_data_file(target: &Path) {
    let Some(app_data) = dirs::data_dir() else {
        return;
    };
    for (dir, file) in LEGACY_DATA_FILES {
        let candidate = app_data.join(dir).join(file);
        if !candidate.is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&candidate) else {
            continue;
        };
        if serde_json::from_str::<serde_json::Value>(&raw).is_err() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&candidate, target).is_ok() {
            return;
        }
    }
}

/// Copies the data file to `dest`, for Setup's "Export backup".
pub fn export_backup(dest: &Path) -> std::io::Result<()> {
    let path = Data::file_path()
        .ok_or_else(|| std::io::Error::other("no app data directory available"))?;
    if !path.exists() {
        // Make sure there is something to copy even before the first save.
        Data::load().save()?;
    }
    fs::copy(&path, dest).map(|_| ())
}

/// Reads a backup file chosen in Setup and writes it over the live data file,
/// returning what was imported. A file that isn't valid JSON is refused rather
/// than written.
pub fn import_backup(src: &Path) -> Result<Data, String> {
    let raw = fs::read_to_string(src).map_err(|e| e.to_string())?;
    let data: Data = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let data = data.normalised();
    data.save().map_err(|e| e.to_string())?;
    Ok(data)
}

/// What Setup is told after a backup: where it went, where backups live, how
/// many are kept now, and when this one was taken.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// The file just written. Empty when there was no data file to copy yet.
    pub path: String,
    pub folder: String,
    pub count: usize,
    /// Local time, written the way a person reads it.
    pub taken_at: String,
}

/// The folder automatic backups are written to, for Setup to show. Created here
/// if it isn't there yet, so the answer is a real folder even on a till that
/// has not backed anything up.
pub fn backup_folder() -> String {
    let Some(data_file) = Data::file_path() else {
        return String::new();
    };
    let folder = backup_folder_for(&data_file);
    let _ = fs::create_dir_all(&folder);
    folder.to_string_lossy().into_owned()
}

/// Copies the data file into the backups folder beside it, then prunes the
/// oldest backups beyond the newest twelve.
pub fn write_data_backup() -> Result<BackupInfo, String> {
    let data_file = Data::file_path().ok_or_else(|| {
        "The app could not find its data folder, so no backup was made. Restart the app and try \
         again."
            .to_string()
    })?;
    write_backup(&data_file)
}

/// The folder backups live in: `backups` beside the data file.
fn backup_folder_for(data_file: &Path) -> PathBuf {
    data_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(BACKUP_DIR_NAME)
}

/// Writes one backup of `data_file` and prunes the folder. A data file that
/// does not exist yet is answered with an empty `path` rather than an error, so
/// a shop that has never saved is not told something went wrong.
fn write_backup(data_file: &Path) -> Result<BackupInfo, String> {
    let folder = backup_folder_for(data_file);
    let taken_at = chrono::Local::now();
    let taken_at_text = taken_at.format("%Y-%m-%d %H:%M:%S").to_string();
    let folder_text = folder.to_string_lossy().into_owned();

    if !data_file.is_file() {
        let _ = fs::create_dir_all(&folder);
        return Ok(BackupInfo {
            path: String::new(),
            folder: folder_text,
            count: backup_files(&folder).len(),
            taken_at: taken_at_text,
        });
    }

    fs::create_dir_all(&folder).map_err(|e| {
        format!(
            "The backups folder could not be made at {folder_text}. Check the disk has space, \
             then try again: {e}"
        )
    })?;

    let name = format!("{BACKUP_PREFIX}{}.json", taken_at.format("%Y-%m-%d_%H%M"));
    let dest = folder.join(&name);
    // Copied under a temporary name and moved into place afterwards, so a
    // backup interrupted part-way through is never left looking complete.
    let part = folder.join(format!("{name}.part"));
    fs::copy(data_file, &part).map_err(|e| {
        let _ = fs::remove_file(&part);
        format!("The backup could not be copied. Check the disk has space, then try again: {e}")
    })?;
    if dest.exists() {
        // A rename over an existing file fails on Windows, and two backups
        // taken in the same minute share a name; the newest one wins.
        let _ = fs::remove_file(&dest);
    }
    fs::rename(&part, &dest).map_err(|e| {
        let _ = fs::remove_file(&part);
        format!(
            "The backup could not be put in place. Check the disk has space, then try again: {e}"
        )
    })?;

    Ok(BackupInfo {
        path: dest.to_string_lossy().into_owned(),
        folder: folder_text,
        count: prune_backups(&folder),
        taken_at: taken_at_text,
    })
}

/// Deletes the oldest backups beyond the newest `BACKUPS_KEPT`, oldest first,
/// and answers how many backups are in the folder now. A backup that cannot be
/// deleted is left in place rather than failing the backup just taken.
fn prune_backups(folder: &Path) -> usize {
    let mut backups = backup_files(folder);
    backups.sort();
    let excess = backups.len().saturating_sub(BACKUPS_KEPT);
    for oldest in &backups[..excess] {
        let _ = fs::remove_file(oldest);
    }
    // Counted afresh: a backup that could not be deleted is still a backup the
    // shop has.
    backup_files(folder).len()
}

/// The automatic backups in `folder`, however many there are.
fn backup_files(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(BACKUP_PREFIX) && name.ends_with(".json"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_keys_fall_back_to_defaults() {
        // A data file written before the receipt printer existed must still load.
        let raw = r#"{"settings":{"shopName":"Corner Shop"},"products":[]}"#;
        let data: Data = serde_json::from_str(raw).unwrap();
        assert_eq!(data.settings.shop_name, "Corner Shop");
        assert_eq!(data.settings.currency, "R");
        assert_eq!(data.settings.low_stock_threshold, 5);
        assert!(!data.settings.receipt_cut_paper);
        assert_eq!(data.categories, vec!["General".to_string()]);
        assert_eq!(data.next_sale_number, 1001);
    }

    #[test]
    fn a_return_round_trips_as_the_original_wording() {
        let sale = Sale {
            kind: SaleKind::Return,
            refund_of: Some("s1".into()),
            refund_of_number: Some(1001),
            ..Default::default()
        };
        let json = serde_json::to_string(&sale).unwrap();
        assert!(json.contains(r#""type":"return""#));
        assert!(json.contains(r#""refundOf":"s1""#));
        assert!(json.contains(r#""refundOfNumber":1001"#));
        let back: Sale = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, SaleKind::Return);
        assert_eq!(back.refund_of.as_deref(), Some("s1"));
    }

    #[test]
    fn a_plain_sale_leaves_the_refund_keys_out_entirely() {
        let sale = Sale {
            id: "s1".into(),
            number: 1001,
            ..Default::default()
        };
        let json = serde_json::to_string(&sale).unwrap();
        assert!(
            !json.contains("refundOf"),
            "plain sales carry no refund keys"
        );
    }

    #[test]
    fn a_sale_split_across_cash_and_card_keeps_both_halves() {
        let sale = Sale {
            id: "s1".into(),
            total: 100.0,
            payment_method: "Cash + Card".into(),
            cash_paid: Some(40.0),
            card_paid: Some(60.0),
            ..Default::default()
        };
        let json = serde_json::to_string(&sale).unwrap();
        assert!(json.contains(r#""cashPaid":40.0"#));
        assert!(json.contains(r#""cardPaid":60.0"#));
        let back: Sale = serde_json::from_str(&json).unwrap();
        assert_eq!(back.cash_paid, Some(40.0));
        assert_eq!(back.card_paid, Some(60.0));

        // A simple sale carries neither key, so its record stays exactly what
        // the old app wrote and the two versions keep reading each other's files.
        let plain = Sale {
            id: "s2".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&plain).unwrap();
        assert!(!json.contains("cashPaid"));
        assert!(!json.contains("cardPaid"));
    }

    #[test]
    fn an_unknown_setting_is_ignored_rather_than_fatal() {
        let raw = r#"{"settings":{"shopName":"Shop","somethingNew":42}}"#;
        let data: Data = serde_json::from_str(raw).unwrap();
        assert_eq!(data.settings.shop_name, "Shop");
    }

    #[test]
    fn reports_and_backups_start_on_and_can_be_turned_off() {
        // A shop that has never touched these settings gets them the way Setup
        // shows them: the report at 17:30, a backup every week.
        let data: Data = serde_json::from_str(r#"{"settings":{}}"#).unwrap();
        assert!(data.settings.report_auto);
        assert_eq!(data.settings.report_auto_time, "17:30");
        assert!(data.settings.backup_auto);
        assert_eq!(data.settings.backup_every, "week");
        assert_eq!(data.settings.mail_port, 465);
        assert!(data.settings.shortcuts.is_empty());
        assert!(data.last_backup_at.is_none());
        assert_eq!(data.last_auto_report, "");
        assert!(data.report_queue.is_empty());
    }

    #[test]
    fn every_setting_the_screens_write_survives_a_save() {
        // The screens keep their settings in the data file through this struct,
        // so a key with no field here would be dropped on the next save — the
        // email setup, the shortcuts and the timers all have to come back out
        // exactly as they went in.
        let raw = r#"{
            "settings": {
                "reportEmail": "owner@example.com",
                "mailFrom": "shop@example.com",
                "mailHost": "smtp.gmail.com",
                "mailPort": 465,
                "reportAuto": false,
                "reportAutoTime": "17:45",
                "backupAuto": true,
                "backupEvery": "day",
                "shortcuts": {
                    "tillCharge": { "key": "F9", "mode": "press" },
                    "stockDelete": { "key": "", "mode": "hold" }
                }
            },
            "lastBackupAt": 1759100000000,
            "lastAutoReport": "2026-09-28",
            "reportQueue": [{ "dateKey": "2026-09-28", "attempts": 2, "report": { "totals": { "sales": 12.5 } } }]
        }"#;
        let data: Data = serde_json::from_str(raw).unwrap();

        let back: Data = serde_json::from_str(&serde_json::to_string(&data).unwrap()).unwrap();
        assert_eq!(back, data, "a save must not drop any of it");
        assert_eq!(back.settings.report_email, "owner@example.com");
        assert!(!back.settings.report_auto);
        assert_eq!(back.settings.report_auto_time, "17:45");
        assert_eq!(back.settings.backup_every, "day");
        assert_eq!(back.settings.shortcuts["tillCharge"].key, "F9");
        assert_eq!(back.settings.shortcuts["tillCharge"].mode, "press");
        assert_eq!(back.settings.shortcuts["stockDelete"].key, "");
        assert_eq!(back.last_backup_at, Some(1759100000000.0));
        assert_eq!(back.last_auto_report, "2026-09-28");
        assert_eq!(back.report_queue.len(), 1);
        assert_eq!(back.report_queue[0]["dateKey"], "2026-09-28");
    }

    #[test]
    fn resetting_sales_and_stock_keeps_the_catalog() {
        let mut data = Data {
            categories: vec!["General".into(), "Pet".into()],
            products: vec![Product {
                id: "p1".into(),
                name: "Coke".into(),
                price: 10.0,
                stock: 7,
                ..Default::default()
            }],
            sales: vec![Sale {
                id: "s1".into(),
                ..Default::default()
            }],
            held_sales: vec![HeldSale {
                id: "h1".into(),
                ..Default::default()
            }],
            next_sale_number: 1009,
            ..Default::default()
        };
        data.reset_sales_and_stock();
        assert!(data.sales.is_empty());
        assert!(data.held_sales.is_empty());
        assert_eq!(data.next_sale_number, 1001);
        assert_eq!(data.products[0].stock, 0);
        assert_eq!(data.products[0].name, "Coke");
        assert_eq!(
            data.categories,
            vec!["General".to_string(), "Pet".to_string()]
        );
    }

    /// A scratch folder that tidies up after itself, so these tests never go
    /// anywhere near the shop's real data file.
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("lyra-pos-test-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn file(&self) -> PathBuf {
            self.dir.join(DATA_FILE_NAME)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn a_shop() -> Data {
        Data {
            settings: Settings {
                shop_name: "Marltons".into(),
                tax_rate: 15.0,
                receipt_printer: "EPSON TM-T88III".into(),
                ..Default::default()
            },
            categories: vec!["General".into(), "Pet".into()],
            products: vec![Product {
                id: "p1".into(),
                name: "Puppy Food".into(),
                sku: "PF-10".into(),
                category: "Pet".into(),
                price: 129.99,
                cost: 80.0,
                stock: 12,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn a_new_shop_gets_a_file_it_can_read_back() {
        let scratch = Scratch::new();
        let file = scratch.file();
        assert!(!file.exists());

        // With nothing there, a fresh shop's defaults are written out and
        // returned, so the very first launch has something to work from.
        let first = Data::load_from(&file);
        assert_eq!(first, Data::default());
        assert!(file.exists(), "a data file is created on first load");

        assert_eq!(Data::load_from(&file), first);
    }

    #[test]
    fn what_is_saved_is_what_comes_back() {
        let scratch = Scratch::new();
        let file = scratch.file();
        let shop = a_shop();
        shop.save_to(&file).unwrap();
        assert_eq!(Data::load_from(&file), shop);
    }

    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let scratch = Scratch::new();
        let file = scratch.file();
        a_shop().save_to(&file).unwrap();
        a_shop().save_to(&file).unwrap(); // a second save over the top

        let leftovers: Vec<String> = fs::read_dir(&scratch.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name != DATA_FILE_NAME)
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }

    #[test]
    fn a_damaged_file_is_kept_aside_rather_than_lost() {
        let scratch = Scratch::new();
        let file = scratch.file();
        fs::write(&file, "{ this is not json").unwrap();

        // The app still opens, on a fresh shop.
        assert_eq!(Data::load_from(&file), Data::default());

        // And nothing was deleted: the damaged file is still on disk under a
        // name that says what happened.
        let mut backups: Vec<String> = fs::read_dir(&scratch.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".bak-"))
            .collect();
        backups.sort();
        assert_eq!(backups.len(), 1, "expected one backup, got {backups:?}");
        assert_eq!(
            fs::read_to_string(scratch.dir.join(&backups[0])).unwrap(),
            "{ this is not json"
        );
    }

    #[test]
    fn a_shop_data_file_survives_a_round_trip_through_the_writer() {
        let original = a_shop();
        let json = serde_json::to_string_pretty(&original).unwrap();
        let back: Data = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn automatic_backups_keep_the_newest_twelve_and_forget_the_rest() {
        let scratch = Scratch::new();
        let file = scratch.file();
        a_shop().save_to(&file).unwrap();

        // Fourteen backups from previous days, named the way the app names
        // them. Long past, so the backup written below is the newest.
        let folder = backup_folder_for(&file);
        fs::create_dir_all(&folder).unwrap();
        let older: Vec<String> = (1..=14)
            .map(|day| format!("lyra-backup-2020-01-{day:02}_0900.json"))
            .collect();
        for name in &older {
            fs::write(folder.join(name), "{}").unwrap();
        }

        let info = write_backup(&file).unwrap();

        // Fifteen backups became twelve: the one just taken plus the eleven
        // newest old ones. The three oldest went first.
        assert_eq!(info.count, 12);
        let mut remaining: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(remaining.len(), 12, "kept: {remaining:?}");
        let new_name = Path::new(&info.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(remaining.contains(&new_name), "the new backup is kept");
        assert_eq!(&remaining[..11], &older[3..], "the oldest three went");

        // What was written is a whole copy of the live file, nothing partial.
        assert_eq!(
            fs::read_to_string(&info.path).unwrap(),
            fs::read_to_string(&file).unwrap()
        );
        assert_eq!(info.folder, folder.to_string_lossy());
        assert!(!info.taken_at.is_empty());
    }

    #[test]
    fn a_backup_before_the_first_save_is_an_answer_not_an_error() {
        let scratch = Scratch::new();
        let file = scratch.file(); // never written: a brand-new till

        let info = write_backup(&file).unwrap();

        assert!(info.path.is_empty(), "nothing was there to copy");
        assert_eq!(info.count, 0);
        assert_eq!(info.folder, backup_folder_for(&file).to_string_lossy());
        assert!(
            backup_folder_for(&file).is_dir(),
            "Setup is still given a real folder to show"
        );
        assert!(!info.taken_at.is_empty());
    }
}
