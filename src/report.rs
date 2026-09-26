//! The day report: what the screens send, laid out as an A4 PDF.
//!
//! The shop's arithmetic lives in `ui/app.js`, where it can be read alongside the
//! screen that shows it; this module only lays out the figures it is given. Every
//! field is defaultable and every number survives whatever JSON arrives, because
//! a report that refuses to render — on a quiet day, or on a figure typed into
//! the data file by hand — is worse than a report with a 0.00 in it.

use serde::{Deserialize, Deserializer};

use crate::pdf::{self, A4_HEIGHT, A4_WIDTH, Document, Face, Page};

// ---------------------------------------------------------------------------
// What the screens send
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DailyReport {
    pub shop_name: String,
    pub address: String,
    pub phone: String,
    pub currency: String,
    pub date_label: String,
    pub generated_at: String,
    pub footer_note: String,
    pub totals: Totals,
    #[serde(deserialize_with = "list")]
    pub top_sellers: Vec<TopSeller>,
    /// The last seven days, oldest first.
    #[serde(deserialize_with = "list")]
    pub recent_days: Vec<DayRow>,
    pub month_to_date: MonthToDate,
    #[serde(deserialize_with = "list")]
    pub low_stock: Vec<StockRow>,
    #[serde(deserialize_with = "list")]
    pub out_of_stock: Vec<StockRow>,
    /// Sales left open at the till when the report was asked for.
    #[serde(deserialize_with = "list")]
    pub held_sales: Vec<HeldSale>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Totals {
    #[serde(deserialize_with = "number")]
    pub sales: f64,
    #[serde(deserialize_with = "number")]
    pub cash: f64,
    #[serde(deserialize_with = "number")]
    pub card: f64,
    #[serde(deserialize_with = "number")]
    pub other: f64,
    #[serde(deserialize_with = "number")]
    pub refunds_value: f64,
    #[serde(deserialize_with = "count")]
    pub refund_count: i64,
    #[serde(deserialize_with = "count")]
    pub transactions: i64,
    #[serde(deserialize_with = "count")]
    pub items_sold: i64,
    #[serde(deserialize_with = "number")]
    pub average_sale: f64,
    #[serde(deserialize_with = "number")]
    pub cost_of_goods: f64,
    #[serde(deserialize_with = "number")]
    pub profit: f64,
    #[serde(deserialize_with = "number")]
    pub margin_pct: f64,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TopSeller {
    pub name: String,
    #[serde(deserialize_with = "count")]
    pub qty: i64,
    #[serde(deserialize_with = "number")]
    pub revenue: f64,
    #[serde(deserialize_with = "number")]
    pub profit: f64,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DayRow {
    pub label: String,
    #[serde(deserialize_with = "number")]
    pub sales: f64,
    #[serde(deserialize_with = "number")]
    pub profit: f64,
    #[serde(deserialize_with = "count")]
    pub transactions: i64,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MonthToDate {
    #[serde(deserialize_with = "number")]
    pub sales: f64,
    #[serde(deserialize_with = "number")]
    pub profit: f64,
    #[serde(deserialize_with = "count")]
    pub transactions: i64,
    #[serde(deserialize_with = "count")]
    pub items_sold: i64,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct StockRow {
    pub name: String,
    pub sku: String,
    #[serde(deserialize_with = "count")]
    pub stock: i64,
    #[serde(deserialize_with = "count")]
    pub threshold: i64,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HeldSale {
    pub label: String,
    #[serde(deserialize_with = "count")]
    pub items: i64,
    #[serde(deserialize_with = "number")]
    pub total: f64,
}

/// A list that takes `null` for an empty one. A quiet day, or a section the
/// screens chose not to send, is a normal day rather than a failed render.
fn list<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

/// A number that survives whatever JSON arrives — `null`, a string, a figure no
/// `f64` can hold — so that one bad field cannot stop the report rendering.
fn number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(0.0),
        serde_json::Value::Bool(true) => 1.0, // `true` as a count of one, `false` as none
        _ => 0.0,
    })
}

/// As [`number`], for the fields that count things. The cast saturates rather
/// than wrapping, so a figure far outside what a till could ever ring up turns
/// into the largest count there is instead of a negative one.
fn count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = number(deserializer)?;
    Ok(if value.is_finite() {
        value.round() as i64
    } else {
        0
    })
}

// ---------------------------------------------------------------------------
// The page the report is set on
// ---------------------------------------------------------------------------

/// How far the whole report is set in from the paper's edge.
const MARGIN: f64 = 46.0;
/// The right-hand edge every column of figures lines up on.
const RIGHT: f64 = A4_WIDTH - MARGIN;
const CONTENT: f64 = RIGHT - MARGIN;
/// Space kept clear at the foot of every page for the footer.
const FOOTER_BAND: f64 = 52.0;
/// How much of a row the figures on its right may take before the label beside
/// them is cut short instead.
const FIGURE_COLUMN: f64 = 176.0;

const TITLE: f64 = 15.0;
const BODY: f64 = 9.5;
const SMALL: f64 = 8.5;
const TEENY: f64 = 8.0;
/// The height of one row, baseline to baseline, before its rule.
const LEAD: f64 = 14.5;

/// The most rows any one list draws, so that a shop with a thousand products in
/// stock trouble gets a report rather than a ream of paper. What is left out is
/// counted in a line of its own.
const MAX_TOP_SELLERS: usize = 20;
const MAX_LOW_STOCK: usize = 30;
const MAX_OUT_OF_STOCK: usize = 20;
const MAX_HELD: usize = 20;
const MAX_DAYS: usize = 14;
/// The most lines one paragraph of prose may take.
const MAX_PROSE_LINES: usize = 40;

/// Lays out a day report and returns the finished PDF.
pub fn render_pdf(report: &DailyReport) -> Vec<u8> {
    let mut sheet = Sheet::new(report);
    sheet.header(report);
    sheet.takings(report);
    sheet.trade(report);
    sheet.profit(report);
    sheet.top_sellers(report);
    sheet.recent_days(report);
    sheet.month_to_date(report);
    sheet.reordering(report);
    sheet.held_sales(report);
    sheet.sign_off(report);
    sheet.finish()
}

/// One page being laid out, and the room left on it.
struct Sheet {
    doc: Document,
    page: Page,
    /// Distance from the top of the current page to the next thing drawn.
    y: f64,
    date_label: String,
}

impl Sheet {
    fn new(report: &DailyReport) -> Self {
        let date_label = match report.date_label.trim() {
            "" => "today".to_string(),
            label => label.to_string(),
        };
        Self {
            doc: Document::new(A4_WIDTH, A4_HEIGHT),
            page: Page::default(),
            y: MARGIN,
            date_label,
        }
    }

    /// The lowest a piece of content may start, above the footer band.
    fn bottom(&self) -> f64 {
        A4_HEIGHT - FOOTER_BAND
    }

    /// Starts a new page if `height` would not fit on this one.
    fn needs(&mut self, height: f64) {
        if self.y + height > self.bottom() {
            self.new_page();
        }
    }

    fn new_page(&mut self) {
        self.doc.add_page(std::mem::take(&mut self.page));
        self.y = MARGIN + 4.0;
        // A page that comes off the printer on its own still has to say what it
        // is, so every continuation page is titled.
        if self.doc.page_count() > 0 {
            self.page.text(
                MARGIN,
                self.y,
                TEENY,
                Face::Regular,
                0.5,
                &format!("Day report — {} (continued)", self.date_label),
            );
            self.y += 8.0;
            self.page.rule(MARGIN, RIGHT, self.y, 0.8, 0.4);
            self.y += 16.0;
        }
    }

    // ----- pieces a section is built from -----

    /// The name of a section, in small capitals on a light band so that a reader
    /// scrolling the report on a phone can find their way down it.
    fn heading(&mut self, title: &str) {
        self.needs(42.0);
        self.y += 12.0;
        self.page
            .band(MARGIN - 3.0, self.y - 10.5, CONTENT + 6.0, 15.0, 0.92);
        self.page
            .text(MARGIN, self.y, 10.0, Face::Bold, 0.2, &title.to_uppercase());
        self.y += 15.0;
    }

    /// One line of a section: a label on the left, a figure on the right.
    fn row(&mut self, label: &str, value: &str) {
        self.row_in(label, value, Face::Regular);
    }

    fn row_in(&mut self, label: &str, value: &str, face: Face) {
        self.needs(LEAD + 6.0);
        let label = pdf::truncate(label, CONTENT - FIGURE_COLUMN - 10.0, BODY, face);
        let value = pdf::truncate(value, FIGURE_COLUMN, BODY, face);
        self.page.text(MARGIN, self.y, BODY, face, 0.05, &label);
        let width = pdf::text_width(&value, BODY, face);
        self.page
            .text(RIGHT - width, self.y, BODY, face, 0.05, &value);
        self.y += 4.5;
        self.page.rule(MARGIN, RIGHT, self.y, 0.85, 0.4);
        self.y += LEAD - 4.5;
    }

    /// A row of a table: the first cell from the left margin, the rest each
    /// right-aligned on its own edge.
    fn grid(
        &mut self,
        cells: &[(String, f64)],
        size: f64,
        face: Face,
        grey: f64,
        rule: Option<f64>,
    ) {
        self.needs(LEAD + 5.0);
        let first_edge = cells
            .iter()
            .skip(1)
            .map(|(_, edge)| *edge)
            .fold(RIGHT, f64::min);
        if let Some((label, _)) = cells.first() {
            let room = (first_edge - MARGIN - 12.0).max(24.0);
            let label = pdf::truncate(label, room, size, face);
            self.page.text(MARGIN, self.y, size, face, grey, &label);
        }
        for (text, edge) in cells.iter().skip(1) {
            let text = pdf::truncate(text, (edge - MARGIN - 12.0).max(24.0), size, face);
            let width = pdf::text_width(&text, size, face);
            self.page
                .text(edge - width, self.y, size, face, grey, &text);
        }
        self.y += 4.5;
        if let Some(grey) = rule {
            self.page.rule(MARGIN, RIGHT, self.y, grey, 0.4);
        }
        self.y += LEAD - 4.5;
    }

    fn grid_header(&mut self, cells: &[(&str, f64)]) {
        let cells: Vec<(String, f64)> = cells
            .iter()
            .map(|(text, edge)| (text.to_string(), *edge))
            .collect();
        self.grid(&cells, SMALL, Face::Bold, 0.45, Some(0.6));
    }

    /// A sentence where a section has nothing to show.
    fn nothing(&mut self, text: &str) {
        self.needs(LEAD + 6.0);
        self.page
            .text(MARGIN, self.y, BODY, Face::Regular, 0.5, text);
        self.y += LEAD + 3.0;
    }

    /// A line under a list, saying how much of it was left out.
    fn cut_short(&mut self, shown: usize, total: usize) {
        if total > shown {
            self.nothing(&format!("…and {} more.", figure((total - shown) as i64)));
        }
    }

    /// Prose, wrapped to the page's width.
    fn paragraph(&mut self, text: &str, grey: f64) {
        let lines = wrap(text, CONTENT, BODY);
        for line in lines.iter().take(MAX_PROSE_LINES) {
            self.needs(LEAD);
            self.page
                .text(MARGIN, self.y, BODY, Face::Regular, grey, line);
            self.y += LEAD;
        }
    }

    // ----- the report, in the order an owner reads it -----

    fn header(&mut self, report: &DailyReport) {
        self.y = MARGIN + 12.0;

        let shop = match report.shop_name.trim() {
            "" => "My Shop",
            name => name,
        };
        self.page.text(MARGIN, self.y, 19.0, Face::Bold, 0.05, shop);
        self.y += 15.0;

        let contact: Vec<&str> = [report.address.trim(), report.phone.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
        if !contact.is_empty() {
            self.page.text(
                MARGIN,
                self.y,
                SMALL,
                Face::Regular,
                0.45,
                &contact.join("  ·  "),
            );
            self.y += 12.0;
        }
        self.y += 5.0;
        self.page.rule(MARGIN, RIGHT, self.y, 0.25, 1.0);
        self.y += 27.0;

        self.page.text(
            MARGIN,
            self.y,
            TITLE,
            Face::Bold,
            0.05,
            &format!("Day report — {}", self.date_label),
        );
        self.y += 15.0;
        if !report.generated_at.trim().is_empty() {
            self.page.text(
                MARGIN,
                self.y,
                SMALL,
                Face::Regular,
                0.45,
                &format!("Generated {}", report.generated_at.trim()),
            );
            self.y += 12.0;
        }
        self.y += 6.0;
    }

    fn takings(&mut self, report: &DailyReport) {
        self.heading("Takings");
        let totals = &report.totals;
        if totals.transactions == 0
            && totals.sales == 0.0
            && totals.refund_count == 0
            && totals.refunds_value == 0.0
        {
            self.nothing("No sales were rung up on this day.");
            return;
        }
        self.row("Takings", &money(&report.currency, totals.sales));
        self.row("Paid in cash", &money(&report.currency, totals.cash));
        self.row("Paid by card", &money(&report.currency, totals.card));
        self.row("Other payment", &money(&report.currency, totals.other));
        if totals.refund_count > 0 || totals.refunds_value != 0.0 {
            let label = match totals.refund_count {
                1 => "Refunded (1)".to_string(),
                n => format!("Refunded ({n})"),
            };
            self.row(&label, &money(&report.currency, totals.refunds_value));
        }
    }

    fn trade(&mut self, report: &DailyReport) {
        self.heading("Trade");
        let totals = &report.totals;
        if totals.transactions == 0 && totals.items_sold == 0 {
            self.nothing("Nobody bought anything on this day.");
            return;
        }
        self.row("Sales", &figure(totals.transactions));
        self.row("Items sold", &figure(totals.items_sold));
        self.row(
            "Average sale",
            &money(&report.currency, totals.average_sale),
        );
    }

    fn profit(&mut self, report: &DailyReport) {
        self.heading("Profit");
        let totals = &report.totals;
        if totals.cost_of_goods == 0.0 && totals.profit == 0.0 {
            self.nothing("There is no profit to show for this day.");
            return;
        }
        self.row(
            "Cost of goods",
            &money(&report.currency, totals.cost_of_goods),
        );
        self.row("Profit", &money(&report.currency, totals.profit));
        self.row("Margin", &percent(totals.margin_pct));
    }

    fn top_sellers(&mut self, report: &DailyReport) {
        self.heading("Top sellers");
        if report.top_sellers.is_empty() {
            self.nothing("Nothing sold on this day.");
            return;
        }
        self.grid_header(&[
            ("Item", 0.0),
            ("Sold", RIGHT - 160.0),
            ("Revenue", RIGHT - 50.0),
            ("Profit", RIGHT),
        ]);
        for seller in report.top_sellers.iter().take(MAX_TOP_SELLERS) {
            self.grid(
                &[
                    (seller.name.clone(), 0.0),
                    (figure(seller.qty), RIGHT - 160.0),
                    (money(&report.currency, seller.revenue), RIGHT - 50.0),
                    (money(&report.currency, seller.profit), RIGHT),
                ],
                BODY,
                Face::Regular,
                0.05,
                Some(0.85),
            );
        }
        self.cut_short(MAX_TOP_SELLERS, report.top_sellers.len());
    }

    fn recent_days(&mut self, report: &DailyReport) {
        self.heading("The last seven days");
        if report.recent_days.is_empty() {
            self.nothing("There is no earlier trading to compare against yet.");
            return;
        }
        self.grid_header(&[
            ("Day", 0.0),
            ("Sales", RIGHT - 160.0),
            ("Takings", RIGHT - 50.0),
            ("Profit", RIGHT),
        ]);
        for day in report.recent_days.iter().take(MAX_DAYS) {
            self.grid(
                &[
                    (day.label.clone(), 0.0),
                    (figure(day.transactions), RIGHT - 160.0),
                    (money(&report.currency, day.sales), RIGHT - 50.0),
                    (money(&report.currency, day.profit), RIGHT),
                ],
                BODY,
                Face::Regular,
                0.05,
                Some(0.85),
            );
        }
        self.cut_short(MAX_DAYS, report.recent_days.len());
    }

    fn month_to_date(&mut self, report: &DailyReport) {
        self.heading("Month to date");
        let month = &report.month_to_date;
        if month.transactions == 0 && month.sales == 0.0 && month.profit == 0.0 {
            self.nothing("Nothing has been sold so far this month.");
            return;
        }
        self.row("Takings", &money(&report.currency, month.sales));
        self.row("Profit", &money(&report.currency, month.profit));
        self.row("Sales", &figure(month.transactions));
        self.row("Items sold", &figure(month.items_sold));
    }

    fn reordering(&mut self, report: &DailyReport) {
        self.heading("Needs reordering");
        let low = &report.low_stock;
        let out = &report.out_of_stock;
        if low.is_empty() && out.is_empty() {
            self.nothing("Every item is in stock above the level the shop reorders at.");
            return;
        }

        if !out.is_empty() {
            self.grid_header(&[
                (format!("Out of stock ({})", out.len()).as_str(), 0.0),
                ("SKU", RIGHT - 190.0),
                ("Left", RIGHT),
            ]);
            for item in out.iter().take(MAX_OUT_OF_STOCK) {
                self.stock_line(item, "none left");
            }
            self.cut_short(MAX_OUT_OF_STOCK, out.len());
        }

        if !low.is_empty() {
            self.grid_header(&[
                (format!("Running low ({})", low.len()).as_str(), 0.0),
                ("SKU", RIGHT - 190.0),
                ("Left", RIGHT),
            ]);
            for item in low.iter().take(MAX_LOW_STOCK) {
                let left = match item.threshold {
                    threshold if threshold > 0 => {
                        format!("{} of {}", figure(item.stock), figure(threshold))
                    }
                    _ => figure(item.stock),
                };
                self.stock_line(item, &left);
            }
            self.cut_short(MAX_LOW_STOCK, low.len());
            self.nothing(
                "The figure on the right is how many are left of the level the shop reorders at.",
            );
        }
    }

    /// One line of a stock list: what the item is, its SKU, and what is left.
    fn stock_line(&mut self, item: &StockRow, left: &str) {
        self.grid(
            &[
                (item.name.clone(), 0.0),
                (sku_of(item), RIGHT - 190.0),
                (left.to_string(), RIGHT),
            ],
            BODY,
            Face::Regular,
            0.05,
            Some(0.85),
        );
    }

    fn held_sales(&mut self, report: &DailyReport) {
        self.heading("Still held at the till");
        if report.held_sales.is_empty() {
            self.nothing("No sales are waiting to be finished.");
            return;
        }
        self.grid_header(&[("Sale", 0.0), ("Items", RIGHT - 130.0), ("Total", RIGHT)]);
        for held in report.held_sales.iter().take(MAX_HELD) {
            self.grid(
                &[
                    (held.label.clone(), 0.0),
                    (figure(held.items), RIGHT - 130.0),
                    (money(&report.currency, held.total), RIGHT),
                ],
                BODY,
                Face::Regular,
                0.05,
                Some(0.85),
            );
        }
        self.cut_short(MAX_HELD, report.held_sales.len());
        self.nothing("Held sales count towards the day's takings once they are paid for.");
    }

    fn sign_off(&mut self, report: &DailyReport) {
        let note = report.footer_note.trim();
        if note.is_empty() {
            return;
        }
        self.needs(LEAD * 2.0);
        self.y += 10.0;
        self.paragraph(note, 0.4);
    }

    /// Footers first — they carry the page count, which is only known once the
    /// last page is laid out — and then the file itself.
    fn finish(mut self) -> Vec<u8> {
        self.doc.add_page(self.page);
        let pages = self.doc.page_count();
        for index in 0..pages {
            let left = format!(
                "Lyra PoS {}  ·  Day report — {}",
                env!("CARGO_PKG_VERSION"),
                self.date_label
            );
            let right = format!("Page {} of {}", index + 1, pages);
            if let Some(page) = self.doc.page_mut(index) {
                let rule_at = A4_HEIGHT - 44.0;
                page.rule(MARGIN, RIGHT, rule_at, 0.8, 0.4);
                let left = pdf::truncate(&left, CONTENT - 120.0, TEENY, Face::Regular);
                page.text(MARGIN, rule_at + 13.0, TEENY, Face::Regular, 0.45, &left);
                let width = pdf::text_width(&right, TEENY, Face::Regular);
                page.text(
                    RIGHT - width,
                    rule_at + 13.0,
                    TEENY,
                    Face::Regular,
                    0.45,
                    &right,
                );
            }
        }
        self.doc
            .finish(&format!("Day report - {}", self.date_label))
    }
}

/// A stock row's SKU, or a dash where the shop has not given the item one.
fn sku_of(item: &StockRow) -> String {
    match item.sku.trim() {
        "" => "—".to_string(),
        sku => sku.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/// Money written the way the screens write it: the shop's currency, a comma
/// every three digits, and two decimals.
fn money(currency: &str, value: f64) -> String {
    let value = if value.is_finite() { value } else { 0.0 };
    if !(value.abs() < 1e15) {
        // A figure this size is a mistake somewhere, not a day's takings. It is
        // shown as the number it is rather than dressed up with separators, and
        // the row cuts it to fit like any other long value.
        return format!("{currency}{value:e}");
    }
    let negative = value < -0.005;
    let cents = (value.abs() * 100.0).round();
    let whole = (cents / 100.0).floor();
    let fraction = cents - whole * 100.0;
    format!(
        "{currency}{}{}.{fraction:02.0}",
        if negative { "-" } else { "" },
        grouped(&format!("{whole:.0}"))
    )
}

/// A whole number of things, with a comma every three digits.
fn figure(value: i64) -> String {
    grouped(&value.to_string())
}

fn percent(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.1}%")
    } else {
        "0.0%".to_string()
    }
}

/// `digits` with a comma every three digits. The sign comes off first, so the
/// commas still count in threes from the right of the figure itself.
fn grouped(digits: &str) -> String {
    let (sign, digits) = match digits.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", digits),
    };
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    out.push_str(sign);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// `text` broken into lines that fit `width`, so that a long footer note runs
/// down the page rather than off the side of it.
fn wrap(text: &str, width: f64, size: f64) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let candidate = if line.is_empty() {
            word.to_string()
        } else {
            format!("{line} {word}")
        };
        if pdf::text_width(&candidate, size, Face::Regular) <= width {
            line = candidate;
            continue;
        }
        if !line.is_empty() {
            lines.push(std::mem::take(&mut line));
        }
        // A word too long for a line of its own has to be cut like any other.
        line = pdf::truncate(word, width, size, Face::Regular);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::pdf::xref_offsets_are_right;

    /// Where the sample files are written. `target/` rather than a temporary
    /// folder, because the point of them is to be opened and looked at.
    fn sample(name: &str) -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(name);
        std::fs::create_dir_all(path.parent().expect("target has a parent"))
            .expect("target folder");
        path
    }

    /// A busy day: sales, refunds, a full week of history and everything that
    /// needs attention in the stock room.
    fn busy_day() -> DailyReport {
        DailyReport {
            shop_name: "Lyra Trading Store".to_string(),
            address: "12 Long Street, Greytown, 3250".to_string(),
            phone: "033 417 2189".to_string(),
            currency: "R".to_string(),
            date_label: "Tuesday, 23 September 2026".to_string(),
            generated_at: "23 Sep 2026, 18:42".to_string(),
            footer_note: "Takings are the shop's own record and not a tax invoice. \
                          Please check the figures against your slips and phone the shop \
                          if anything looks wrong."
                .to_string(),
            totals: Totals {
                sales: 12_480.50,
                cash: 7_310.00,
                card: 4_900.50,
                other: 270.00,
                refunds_value: 420.00,
                refund_count: 3,
                transactions: 96,
                items_sold: 412,
                average_sale: 130.01,
                cost_of_goods: 8_940.25,
                profit: 3_540.25,
                margin_pct: 28.4,
            },
            top_sellers: vec![
                top_seller("Café Mocha 250 g", 48, 1_920.00, 640.00),
                top_seller("Maize meal 10 kg", 37, 1_295.00, 259.00),
                top_seller(
                    "Heavy-duty galvanised garden rake, 12 tine",
                    12,
                    1_080.00,
                    312.00,
                ),
                top_seller("Sunflower oil 750 ml", 26, 780.00, 182.00),
                top_seller("Washing powder 2 kg", 19, 665.00, 152.00),
                top_seller("Bread rolls, six", 54, 540.00, 108.00),
                top_seller("Paraffin 5 ℓ", 21, 483.00, 84.00),
                top_seller("Cold drink 2 ℓ", 44, 440.00, 132.00),
            ],
            recent_days: vec![
                day("Wed 17 Sep", 9_140.00, 2_540.00, 71),
                day("Thu 18 Sep", 8_620.50, 2_310.00, 66),
                day("Fri 19 Sep", 15_980.00, 4_760.00, 118),
                day("Sat 20 Sep", 19_450.00, 5_910.00, 142),
                day("Sun 21 Sep", 6_310.00, 1_680.00, 48),
                day("Mon 22 Sep", 11_205.00, 3_180.00, 88),
                day("Tue 23 Sep", 12_480.50, 3_540.25, 96),
            ],
            month_to_date: MonthToDate {
                sales: 214_310.00,
                profit: 61_540.00,
                transactions: 1_684,
                items_sold: 7_420,
            },
            low_stock: vec![
                stock("Sunflower oil 750 ml", "SOL-750", 3, 6),
                stock("Washing powder 2 kg", "WP-2KG", 1, 4),
                stock("Paraffin 5 ℓ", "PAR-5L", 2, 6),
                stock("Bread rolls, six", "BR-6", 4, 10),
            ],
            out_of_stock: vec![
                stock("Maize meal 10 kg", "MM-10", 0, 5),
                stock("Candles, packet of six", "CD-6", 0, 6),
            ],
            held_sales: vec![
                HeldSale {
                    label: "Held 09:14 — Mrs Dlamini".to_string(),
                    items: 4,
                    total: 186.50,
                },
                HeldSale {
                    label: "Held 15:02 — counter".to_string(),
                    items: 11,
                    total: 640.00,
                },
            ],
        }
    }

    fn top_seller(name: &str, qty: i64, revenue: f64, profit: f64) -> TopSeller {
        TopSeller {
            name: name.to_string(),
            qty,
            revenue,
            profit,
        }
    }

    fn day(label: &str, sales: f64, profit: f64, transactions: i64) -> DayRow {
        DayRow {
            label: label.to_string(),
            sales,
            profit,
            transactions,
        }
    }

    fn stock(name: &str, sku: &str, stock: i64, threshold: i64) -> StockRow {
        StockRow {
            name: name.to_string(),
            sku: sku.to_string(),
            stock,
            threshold,
        }
    }

    /// A day on which nothing happened at all.
    fn quiet_day() -> DailyReport {
        DailyReport {
            shop_name: "Lyra Trading Store".to_string(),
            address: "12 Long Street, Greytown, 3250".to_string(),
            phone: "033 417 2189".to_string(),
            currency: "R".to_string(),
            date_label: "Sunday, 21 September 2026".to_string(),
            generated_at: "21 Sep 2026, 07:05".to_string(),
            footer_note: "Closed on Sundays.".to_string(),
            ..DailyReport::default()
        }
    }

    fn write(report: &DailyReport, name: &str) -> (Vec<u8>, PathBuf) {
        let bytes = render_pdf(report);
        let path = sample(name);
        std::fs::write(&path, &bytes).expect("the sample report could not be written");
        // What is checked is what landed on disk: the file is the thing the shop
        // opens, so it is the thing that has to be a PDF.
        let on_disk = std::fs::read(&path).expect("the sample report could not be read back");
        (on_disk, path)
    }

    #[test]
    fn a_busy_day_writes_a_report_that_reads_across_pages() {
        let (bytes, path) = write(&busy_day(), "daily-report-sample.pdf");
        assert!(bytes.starts_with(b"%PDF-"), "{path:?} is not a PDF");
        assert!(bytes.ends_with(b"%%EOF\n"));
        let pages = xref_offsets_are_right(&bytes);
        assert!(pages >= 2, "a busy day should not fit on one page");
        assert!(bytes.len() > 4_000, "the sample is suspiciously small");
    }

    #[test]
    fn a_quiet_day_still_writes_a_report() {
        let (bytes, path) = write(&quiet_day(), "daily-report-quiet.pdf");
        assert!(bytes.starts_with(b"%PDF-"), "{path:?} is not a PDF");
        let pages = xref_offsets_are_right(&bytes);
        assert_eq!(pages, 1, "a day with nothing on it is one page");
    }

    #[test]
    fn absurd_figures_do_not_stop_the_report() {
        let mut report = busy_day();
        report.currency = String::new();
        report.shop_name = String::new();
        report.totals.sales = f64::NAN;
        report.totals.profit = f64::INFINITY;
        report.totals.cost_of_goods = -1e300;
        report.totals.margin_pct = f64::NEG_INFINITY;
        report.totals.items_sold = i64::MIN;
        report.low_stock = (0..10_000)
            .map(|n| stock(&format!("Item {n}"), "", -n, 5))
            .collect();
        report.held_sales = (0..2_000)
            .map(|_| HeldSale {
                label: String::new(),
                items: i64::MAX,
                total: 1e308,
            })
            .collect();
        report.recent_days = Vec::new();

        let bytes = render_pdf(&report);
        assert!(bytes.starts_with(b"%PDF-"));
        // The long lists are counted rather than printed in full.
        assert!(xref_offsets_are_right(&bytes) < 8);
    }

    #[test]
    fn a_payload_with_holes_in_it_still_renders() {
        // What a half-finished Setup, or a hand-edited payload, looks like.
        let report: DailyReport = serde_json::from_str(
            r#"{"totals": {"sales": null, "cash": "1 234.50", "transactions": "12.7"},
                "topSellers": [{}], "lowStock": null}"#,
        )
        .expect("a payload with holes in it should deserialize");
        assert_eq!(report.totals.sales, 0.0);
        assert_eq!(report.totals.cash, 0.0); // a figure with a space in it is not a number
        assert_eq!(report.totals.transactions, 13);
        assert_eq!(report.top_sellers.len(), 1);
        assert!(report.low_stock.is_empty());
        assert!(render_pdf(&report).starts_with(b"%PDF-"));
    }

    #[test]
    fn money_is_written_the_way_the_screens_write_it() {
        assert_eq!(money("R", 1_234.5), "R1,234.50");
        assert_eq!(money("R", 0.0), "R0.00");
        assert_eq!(money("R", -1_234.567), "R-1,234.57");
        assert_eq!(money("R", 1_000_000.0), "R1,000,000.00");
        assert_eq!(money("£", 12.0), "£12.00");
        // A figure no arithmetic should have produced is shown, not panicked over
        assert_eq!(money("R", f64::NAN), "R0.00");
        assert_eq!(money("R", f64::NEG_INFINITY), "R0.00");
        assert!(money("R", 1e300).starts_with("R1e300"));
    }

    #[test]
    fn counts_and_percentages_read_the_way_an_owner_reads_them() {
        assert_eq!(figure(0), "0");
        assert_eq!(figure(412), "412");
        assert_eq!(figure(1_684), "1,684");
        assert_eq!(figure(-20), "-20");
        assert_eq!(percent(28.4), "28.4%");
        assert_eq!(percent(f64::NAN), "0.0%");
    }

    #[test]
    fn prose_wraps_rather_than_running_off_the_side() {
        let lines = wrap(
            "Takings are the shop's own record and not a tax invoice, so keep them with the \
             day's slips. Please check the figures against your slips and phone the shop if \
             anything looks wrong, or bring the report in on Monday morning.",
            CONTENT,
            BODY,
        );
        assert!(lines.len() > 1);
        for line in &lines {
            assert!(pdf::text_width(line, BODY, Face::Regular) <= CONTENT);
        }
    }
}
