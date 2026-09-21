//! The saved shape of the shop's data, and reading and writing it.
//!
//! Every field is `#[serde(default)]`, so a data file written by an older
//! version — or one a shop has hand-edited — still loads: anything absent falls
//! back to its default rather than failing the whole load. This mirrors the
//! key-by-key merge the original app did in `loadData()`.
//!
//! The keys are exactly the ones the original wrote (`camelCase`), so a data
//! file or a backup file moves between the two apps untouched.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The shop's folder and file inside the machine's standard app-data folder
/// (on Windows, `%APPDATA%\Lyra PoS\lyra-pos-data.json`).
pub const DATA_DIR_NAME: &str = "Lyra PoS";
pub const DATA_FILE_NAME: &str = "lyra-pos-data.json";

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
    fn an_unknown_setting_is_ignored_rather_than_fatal() {
        let raw = r#"{"settings":{"shopName":"Shop","somethingNew":42}}"#;
        let data: Data = serde_json::from_str(raw).unwrap();
        assert_eq!(data.settings.shop_name, "Shop");
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
}
