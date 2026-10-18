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
    /// What the cash drawer should hold, and when the day started and finished.
    pub drawer: Drawer,
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
    /// Everything done by hand that the day's takings cannot account for —
    /// stock figures typed over, prices set for one sale, held sales thrown
    /// away, products added, changed or deleted. Drawn in red, exactly as the
    /// screens recorded them (see `hand_changes`).
    #[serde(deserialize_with = "list")]
    pub stock_edits: Vec<StockEditRow>,
    /// Products whose stock does not add up against the last report's figures.
    #[serde(deserialize_with = "list")]
    pub stock_check: Vec<StockCheckRow>,
    /// When the last report's stock figures were taken; empty when there is no
    /// earlier report to count against.
    pub stock_check_since: String,
}

/// What the day's cash comes to: the money in, the money back, and what should
/// be in the drawer at the end of it.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Drawer {
    #[serde(deserialize_with = "number")]
    pub cash_sales: f64,
    #[serde(deserialize_with = "number")]
    pub cash_refunds: f64,
    #[serde(deserialize_with = "number")]
    pub expected: f64,
    /// "HH:MM" as the screens read them; empty on a day with no sales.
    pub first_sale: String,
    pub last_sale: String,
}

/// One product whose stock has moved by more than its sales account for, since
/// the figures the last report was built with.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct StockCheckRow {
    pub name: String,
    /// How many went out of the door since the last report (refunds net off).
    #[serde(deserialize_with = "whole")]
    pub sold: i64,
    /// What should be on the shelf: the last report's figure, less what sold.
    #[serde(deserialize_with = "whole")]
    pub expected: i64,
    /// What is on the shelf now.
    #[serde(deserialize_with = "whole")]
    pub actual: i64,
}

/// One change made by hand, as the till wrote it down.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct StockEditRow {
    /// The local time the change was made, "HH:MM" as the screens read it.
    pub time: String,
    pub name: String,
    /// Stock figures, for the change every older till wrote: `detail` is empty
    /// on those, and these two say what happened instead.
    #[serde(deserialize_with = "whole")]
    pub from: i64,
    #[serde(deserialize_with = "whole")]
    pub to: i64,
    /// The change in the shop's own words — "shelf R199.50 -> R99.00, R100.50
    /// short", "deleted, 12 in stock", "3 items, R450.00, held 12 min".
    pub detail: String,
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
    /// How many trips to the till each method was. Money alone does not say
    /// whether a day was one big card sale or thirty small cash ones.
    #[serde(deserialize_with = "count")]
    pub cash_count: i64,
    #[serde(deserialize_with = "count")]
    pub card_count: i64,
    #[serde(deserialize_with = "count")]
    pub other_count: i64,
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

/// The day's sales history as the screens send it: every sale and refund of the
/// day, line by line. It travels as its own PDF beside the day report and
/// answers the question the totals cannot — what went out of the door, when,
/// and for how much.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DayHistory {
    pub shop_name: String,
    pub address: String,
    pub phone: String,
    pub currency: String,
    pub date_label: String,
    pub generated_at: String,
    pub footer_note: String,
    #[serde(deserialize_with = "count")]
    pub sales_count: i64,
    #[serde(deserialize_with = "count")]
    pub refunds_count: i64,
    #[serde(deserialize_with = "count")]
    pub items_sold: i64,
    #[serde(deserialize_with = "number")]
    pub takings: f64,
    /// How much money went back over the counter, as a positive figure.
    #[serde(deserialize_with = "number")]
    pub refunds_value: f64,
    #[serde(deserialize_with = "list")]
    pub sales: Vec<HistorySale>,
}

/// One sale or refund in the history, in the order it was rung up.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HistorySale {
    /// The local time it happened, "HH:MM" as the screens read it.
    pub time: String,
    #[serde(deserialize_with = "whole")]
    pub number: i64,
    /// "sale" or "return", the wording the data file uses.
    pub kind: String,
    /// The sale a refund came from; 0 when it is not a refund.
    #[serde(deserialize_with = "whole")]
    pub refund_of_number: i64,
    pub payment: String,
    #[serde(deserialize_with = "number")]
    pub total: f64,
    #[serde(deserialize_with = "list")]
    pub items: Vec<HistoryItem>,
}

/// One line of one sale: what was sold, how many, at what price, and what the
/// line came to.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryItem {
    pub name: String,
    #[serde(deserialize_with = "count")]
    pub qty: i64,
    #[serde(deserialize_with = "number")]
    pub price: f64,
    /// Negative on a refund's lines: money coming back.
    #[serde(deserialize_with = "number")]
    pub line_total: f64,
}

/// A whole number that survives whatever JSON arrives, the way `number`
/// does for money.
fn whole<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    Ok(match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(0),
        serde_json::Value::Bool(true) => 1,
        _ => 0,
    })
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

/// The ink the stock-edit section is set in. Everything else on the sheet is
/// grey on purpose; this is the one section a shop owner is meant to see
/// before anything else, so it is the one section in colour.
const RED: (f64, f64, f64) = (0.72, 0.05, 0.05);

/// The most rows any one list draws, so that a shop with a thousand products in
/// stock trouble gets a report rather than a ream of paper. What is left out is
/// counted in a line of its own.
const MAX_TOP_SELLERS: usize = 20;
const MAX_LOW_STOCK: usize = 30;
const MAX_OUT_OF_STOCK: usize = 20;
const MAX_HELD: usize = 20;
const MAX_DAYS: usize = 14;
/// The most hand-edited stock lines one report draws; the rest are counted.
const MAX_STOCK_EDITS: usize = 40;
/// The most products one unaccounted-stock list draws; the rest are counted.
const MAX_STOCK_CHECK: usize = 40;
/// The most sales one day's history draws; the rest are counted. A shop with
/// more sales than this in a day is past the point where a PDF is the way to
/// read them, and the screens still hold every one.
const MAX_HISTORY_SALES: usize = 500;
/// The most lines one paragraph of prose may take.
const MAX_PROSE_LINES: usize = 40;
/// How far a sale's items are set in under the sale line they belong to.
const INDENT: f64 = 14.0;

/// Lays out a day report and returns the finished PDF.
pub fn render_pdf(report: &DailyReport) -> Vec<u8> {
    let mut sheet = Sheet::new(&report.date_label, "Day report");
    sheet.header(report);
    sheet.takings(report);
    sheet.drawer(report);
    sheet.trade(report);
    sheet.profit(report);
    sheet.hand_changes(report);
    sheet.stock_check(report);
    sheet.top_sellers(report);
    sheet.recent_days(report);
    sheet.month_to_date(report);
    sheet.reordering(report);
    sheet.held_sales(report);
    sheet.note(&report.footer_note);
    sheet.finish()
}

/// Lays out a day's sales history and returns the finished PDF.
///
/// It is emailed as its own attachment beside the day report, so the two files
/// can be kept, read or forwarded apart from each other.
pub fn render_history_pdf(history: &DayHistory) -> Vec<u8> {
    let mut sheet = Sheet::new(&history.date_label, "Sales history");
    sheet.history_header(history);
    sheet.history_lines(history);
    sheet.note(&history.footer_note);
    sheet.finish()
}

/// One page being laid out, and the room left on it.
struct Sheet {
    doc: Document,
    page: Page,
    /// Distance from the top of the current page to the next thing drawn.
    y: f64,
    date_label: String,
    /// What the sheet calls itself — "Day report", "Sales history" — wherever
    /// it names itself: the continuation head, the foot of every page, and the
    /// title the reader's PDF program shows.
    title: String,
}

impl Sheet {
    fn new(date_label: &str, title: &str) -> Self {
        let date_label = match date_label.trim() {
            "" => "today".to_string(),
            label => label.to_string(),
        };
        Self {
            doc: Document::new(A4_WIDTH, A4_HEIGHT),
            page: Page::default(),
            y: MARGIN,
            date_label,
            title: title.to_string(),
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
                &format!("{} — {} (continued)", self.title, self.date_label),
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

    /// Text in the ink a section asked for: red where it did, grey everywhere
    /// else. Kept in one place so a coloured line is always a deliberate call.
    fn written(
        &mut self,
        ink: Option<(f64, f64, f64)>,
        x: f64,
        y: f64,
        size: f64,
        face: Face,
        grey: f64,
        text: &str,
    ) {
        match ink {
            Some(rgb) => self.page.text_colour(x, y, size, face, rgb, text),
            None => self.page.text(x, y, size, face, grey, text),
        }
    }

    /// The shop's own name, its contact details and the rule under them: the
    /// top of every sheet this module writes.
    fn letterhead(&mut self, shop_name: &str, address: &str, phone: &str) {
        self.y = MARGIN + 12.0;

        let shop = match shop_name.trim() {
            "" => "My Shop",
            name => name,
        };
        self.page.text(MARGIN, self.y, 19.0, Face::Bold, 0.05, shop);
        self.y += 15.0;

        let contact: Vec<&str> = [address.trim(), phone.trim()]
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
    }

    // ----- the report, in the order an owner reads it -----

    fn header(&mut self, report: &DailyReport) {
        self.letterhead(&report.shop_name, &report.address, &report.phone);

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
        self.row(
            "Paid in cash",
            &with_count(&money(&report.currency, totals.cash), totals.cash_count),
        );
        self.row(
            "Paid by card",
            &with_count(&money(&report.currency, totals.card), totals.card_count),
        );
        self.row(
            "Other payment",
            &with_count(&money(&report.currency, totals.other), totals.other_count),
        );
        if totals.refund_count > 0 || totals.refunds_value != 0.0 {
            let label = match totals.refund_count {
                1 => "Refunded (1)".to_string(),
                n => format!("Refunded ({n})"),
            };
            self.row(&label, &money(&report.currency, totals.refunds_value));
        }
    }

    /// What the cash drawer should hold at the end of the day. The owner counts
    /// the till against this rather than against a feeling.
    fn drawer(&mut self, report: &DailyReport) {
        let drawer = &report.drawer;
        if drawer.cash_sales == 0.0 && drawer.cash_refunds == 0.0 && drawer.expected == 0.0 {
            // An older payload, or a day with no cash in it at all: nothing to say.
            return;
        }
        self.heading("Cash in the till");
        self.row(
            "Cash taken today",
            &money(&report.currency, drawer.cash_sales),
        );
        self.row(
            "Cash refunded",
            &money(&report.currency, -drawer.cash_refunds.abs()),
        );
        self.row(
            "Should be in the drawer",
            &money(&report.currency, drawer.expected),
        );
        self.nothing("Count the drawer against this, less whatever float was in it at opening.");
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
        // The shape of the day: a report that was all over by nine in the
        // morning reads differently from one that ran into the evening.
        if !report.drawer.first_sale.trim().is_empty() {
            self.row("First sale", report.drawer.first_sale.trim());
            self.row(
                "Last sale",
                match report.drawer.last_sale.trim() {
                    "" => "—",
                    last => last,
                },
            );
        }
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

    /// Everything done by hand that the day's takings cannot account for, in
    /// red and bold: stock figures typed over, prices set for one sale, held
    /// sales thrown away, products added, changed or deleted. These are the
    /// changes at a till that can hide money, so the section is drawn to be
    /// noticed — and the till records them without any screen saying so at the
    /// time.
    fn hand_changes(&mut self, report: &DailyReport) {
        self.heading("Changes the takings cannot account for");
        if report.stock_edits.is_empty() {
            self.nothing("Nothing was changed by hand on this day.");
            return;
        }
        let shown = report.stock_edits.len().min(MAX_STOCK_EDITS);
        for edit in report.stock_edits.iter().take(shown) {
            // Every newer change arrives with its own wording; a change from an
            // older till is a stock figure, and says so in from -> to.
            let detail = match edit.detail.trim() {
                "" => {
                    let delta = edit.to - edit.from;
                    // An ASCII arrow on purpose: the report's font is WinAnsi, and
                    // the real thing would come out as a question mark.
                    format!(
                        "{} -> {}  ({}{})",
                        figure(edit.from),
                        figure(edit.to),
                        if delta > 0 { "+" } else { "" },
                        figure(delta)
                    )
                }
                detail => detail.to_string(),
            };
            let right = pdf::truncate(&detail, FIGURE_COLUMN, SMALL, Face::Bold);
            let right_width = pdf::text_width(&right, SMALL, Face::Bold);
            // The name takes whatever the change does not need, and wraps onto a
            // second line rather than being cut: which product was changed is the
            // whole point of this section.
            let room = (CONTENT - right_width - 14.0).max(140.0);
            let lines = wrap_face(
                &format!("{}  {}", edit.time, edit.name),
                room,
                SMALL,
                Face::Bold,
                2,
            );
            self.needs(LEAD + 4.0 + LEAD * (lines.len().saturating_sub(1)) as f64);
            self.page
                .text_colour(MARGIN, self.y, SMALL, Face::Bold, RED, &lines[0]);
            self.page
                .text_colour(RIGHT - right_width, self.y, SMALL, Face::Bold, RED, &right);
            if lines.len() > 1 {
                // The second line goes under the first, the way it reads: `y`
                // counts down the page, so the wrap moves it forward rather
                // than back over the row above.
                self.y += LEAD;
                self.page
                    .text_colour(MARGIN, self.y, SMALL, Face::Bold, RED, &lines[1]);
            }
            self.y += 4.0;
            self.page.rule(MARGIN, RIGHT, self.y, 0.78, 0.4);
            self.y += LEAD - 4.0;
        }
        self.cut_short(shown, report.stock_edits.len());
    }

    /// What has walked, compared with the stock the last report was built with.
    /// A hand edit is written down as it happens; this catches everything else —
    /// a spreadsheet imported, a product deleted and re-added, an old backup
    /// restored, a data file edited by hand.
    fn stock_check(&mut self, report: &DailyReport) {
        if report.stock_check.is_empty() && report.stock_check_since.trim().is_empty() {
            // Nothing to compare against yet, or nothing out of place.
            return;
        }
        self.heading("Unaccounted stock");
        if report.stock_check.is_empty() {
            self.nothing("Every product's stock adds up against the last report.");
            if !report.stock_check_since.trim().is_empty() {
                self.nothing(&format!(
                    "Counted against the figures of {}.",
                    report.stock_check_since.trim()
                ));
            }
            return;
        }
        for row in report.stock_check.iter().take(MAX_STOCK_CHECK) {
            let delta = row.actual - row.expected;
            let detail = format!(
                "{} expected, {} found  ({}{})",
                figure(row.expected),
                figure(row.actual),
                if delta > 0 { "+" } else { "" },
                figure(delta)
            );
            let right = pdf::truncate(&detail, FIGURE_COLUMN, SMALL, Face::Bold);
            let right_width = pdf::text_width(&right, SMALL, Face::Bold);
            let room = (CONTENT - right_width - 14.0).max(140.0);
            let lines = wrap_face(&row.name, room, SMALL, Face::Bold, 2);
            self.needs(LEAD + 4.0 + LEAD * (lines.len().saturating_sub(1)) as f64);
            self.page
                .text_colour(MARGIN, self.y, SMALL, Face::Bold, RED, &lines[0]);
            self.page
                .text_colour(RIGHT - right_width, self.y, SMALL, Face::Bold, RED, &right);
            if lines.len() > 1 {
                self.y += LEAD;
                self.page
                    .text_colour(MARGIN, self.y, SMALL, Face::Bold, RED, &lines[1]);
            }
            self.y += 4.0;
            self.page.rule(MARGIN, RIGHT, self.y, 0.78, 0.4);
            self.y += LEAD - 4.0;
        }
        self.cut_short(MAX_STOCK_CHECK, report.stock_check.len());
        let note = match report.stock_check_since.trim() {
            "" => "Counted against the stock the last report was built with.".to_string(),
            since => format!("Counted against the figures of {since}."),
        };
        self.nothing(&note);
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

    /// The shop's own words at the foot of the sheet, read by both documents.
    fn note(&mut self, text: &str) {
        let note = text.trim();
        if note.is_empty() {
            return;
        }
        self.needs(LEAD * 2.0);
        self.y += 10.0;
        self.paragraph(note, 0.4);
    }

    // ----- the sales history -----

    fn history_header(&mut self, history: &DayHistory) {
        self.letterhead(&history.shop_name, &history.address, &history.phone);

        self.page.text(
            MARGIN,
            self.y,
            TITLE,
            Face::Bold,
            0.05,
            &format!("Sales history — {}", self.date_label),
        );
        self.y += 15.0;

        // The day in one line, the way the report's Takings section reads it, so
        // the two attachments can be checked against each other at a glance.
        let sales = match history.sales_count {
            1 => "1 sale".to_string(),
            n => format!("{} sales", figure(n)),
        };
        let items = match history.items_sold {
            1 => "1 item sold".to_string(),
            n => format!("{} items sold", figure(n)),
        };
        let mut parts = vec![sales];
        if history.refunds_count > 0 {
            let refunds = match history.refunds_count {
                1 => "1 refund".to_string(),
                n => format!("{} refunds", figure(n)),
            };
            parts.push(format!(
                "{refunds} ({})",
                money(&history.currency, -history.refunds_value.abs())
            ));
        }
        parts.push(items);
        parts.push(format!(
            "takings {}",
            money(&history.currency, history.takings)
        ));
        self.page.text(
            MARGIN,
            self.y,
            SMALL,
            Face::Regular,
            0.45,
            &parts.join("  ·  "),
        );
        self.y += 12.0;

        if !history.generated_at.trim().is_empty() {
            self.page.text(
                MARGIN,
                self.y,
                SMALL,
                Face::Regular,
                0.45,
                &format!("Generated {}", history.generated_at.trim()),
            );
            self.y += 12.0;
        }
        self.y += 6.0;
    }

    /// Every sale of the day, oldest first, each with its lines under it. This
    /// is the section an owner reads when the shelf and the takings do not
    /// agree, so nothing here is summarised away.
    fn history_lines(&mut self, history: &DayHistory) {
        self.heading("Every sale, line by line");
        if history.sales.is_empty() {
            self.nothing("No sales were rung up on this day.");
            return;
        }
        let shown = history.sales.len().min(MAX_HISTORY_SALES);
        for sale in history.sales.iter().take(shown) {
            self.history_sale(sale, &history.currency);
        }
        self.cut_short(shown, history.sales.len());
    }

    /// One sale as a block: when and what it was on its own line, its items
    /// under it. A refund is drawn in red — money going back over the counter
    /// is the entry an owner should be able to find without reading every line.
    fn history_sale(&mut self, sale: &HistorySale, currency: &str) {
        let is_return = sale.kind.trim().eq_ignore_ascii_case("return");
        let ink = if is_return { Some(RED) } else { None };

        // A sale keeps its lines together on one page wherever they fit there
        // at all: which items went out together is the thing the sheet is for.
        let want = (LEAD * (1 + sale.items.len()) as f64 + 10.0).min(self.bottom() - MARGIN);
        self.needs(want);

        let label = match (is_return, sale.refund_of_number) {
            (true, 0) => format!("Refund #{}", figure(sale.number)),
            (true, n) => format!("Refund #{} of #{}", figure(sale.number), figure(n)),
            (false, _) => format!("Sale #{}", figure(sale.number)),
        };
        let left = [sale.time.trim(), label.as_str(), sale.payment.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("  ·  ");
        let right = money(currency, sale.total);
        let right_width = pdf::text_width(&right, BODY, Face::Bold);
        let left = pdf::truncate(
            &left,
            (CONTENT - right_width - 14.0).max(120.0),
            BODY,
            Face::Bold,
        );

        self.y += 5.0;
        self.written(ink, MARGIN, self.y, BODY, Face::Bold, 0.05, &left);
        self.written(
            ink,
            RIGHT - right_width,
            self.y,
            BODY,
            Face::Bold,
            0.05,
            &right,
        );
        self.y += 4.0;
        self.page.rule(MARGIN, RIGHT, self.y, 0.85, 0.4);
        self.y += LEAD - 4.0;

        for item in &sale.items {
            self.history_item(item, currency, ink);
        }
    }

    /// One line of a sale: how many, of what, at what price each, and what the
    /// line came to. A long name wraps onto a second line rather than being
    /// cut: which item sold is the whole point of the sheet.
    fn history_item(&mut self, item: &HistoryItem, currency: &str, ink: Option<(f64, f64, f64)>) {
        let qty = figure(item.qty);
        let name = item.name.trim();
        let label = if item.qty != 1 && item.price != 0.0 {
            format!("{} x {}  @ {}", qty, name, money(currency, item.price))
        } else {
            format!("{} x {}", qty, name)
        };
        let right = money(currency, item.line_total);
        let right_width = pdf::text_width(&right, SMALL, Face::Regular);
        let room = (CONTENT - INDENT - right_width - 14.0).max(140.0);
        let lines = wrap_face(&label, room, SMALL, Face::Regular, 2);
        self.needs(LEAD * lines.len() as f64);
        self.written(
            ink,
            MARGIN + INDENT,
            self.y,
            SMALL,
            Face::Regular,
            0.05,
            &lines[0],
        );
        self.written(
            ink,
            RIGHT - right_width,
            self.y,
            SMALL,
            Face::Regular,
            0.05,
            &right,
        );
        if lines.len() > 1 {
            self.y += LEAD;
            self.written(
                ink,
                MARGIN + INDENT,
                self.y,
                SMALL,
                Face::Regular,
                0.05,
                &lines[1],
            );
        }
        self.y += LEAD;
    }

    /// Footers first — they carry the page count, which is only known once the
    /// last page is laid out — and then the file itself.
    fn finish(mut self) -> Vec<u8> {
        self.doc.add_page(self.page);
        let pages = self.doc.page_count();
        for index in 0..pages {
            let left = format!(
                "Lyra PoS {}  ·  {} — {}",
                env!("CARGO_PKG_VERSION"),
                self.title,
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
            .finish(&format!("{} - {}", self.title, self.date_label))
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

/// "R1,234.50  (12 sales)" — the count that belongs beside a payment figure,
/// because one big card sale and thirty small cash ones read the same without
/// it. A day with none of that payment says nothing extra rather than "(0)".
fn with_count(amount: &str, count: i64) -> String {
    match count {
        n if n <= 0 => amount.to_string(),
        1 => format!("{amount}  (1 sale)"),
        n => format!("{amount}  ({} sales)", figure(n)),
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

/// The same wrapping, in a given face, cut to the number of lines a row is
/// allowed: text that needs more than that is truncated on the last line, so
/// nothing ever runs off the page.
fn wrap_face(text: &str, width: f64, size: f64, face: Face, most: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let candidate = if line.is_empty() {
            word.to_string()
        } else {
            format!("{line} {word}")
        };
        if pdf::text_width(&candidate, size, face) <= width {
            line = candidate;
            continue;
        }
        if !line.is_empty() {
            lines.push(std::mem::take(&mut line));
            if lines.len() == most {
                let last = lines.pop().unwrap_or_default();
                let joined = format!("{last} {word}");
                lines.push(pdf::truncate(&joined, width, size, face));
                return lines;
            }
        }
        line = pdf::truncate(word, width, size, face);
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
                cash_count: 71,
                card_count: 22,
                other_count: 3,
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
            stock_edits: vec![
                StockEditRow {
                    time: "14:32".to_string(),
                    name: "Sunflower oil 750 ml".to_string(),
                    from: 24,
                    to: 18,
                    detail: String::new(),
                },
                StockEditRow {
                    time: "14:36".to_string(),
                    name: "Dog Food 10 kg (sale #1041)".to_string(),
                    from: 0,
                    to: 0,
                    detail: "shelf R199.50 -> R99.00, R100.50 short".to_string(),
                },
                StockEditRow {
                    time: "15:02".to_string(),
                    name: "Held sale discarded".to_string(),
                    from: 0,
                    to: 0,
                    detail: "3 items, R450.00, held 12 min".to_string(),
                },
                StockEditRow {
                    time: "09:05".to_string(),
                    name: "Cold drink 2 ℓ".to_string(),
                    from: 60,
                    to: 66,
                    detail: String::new(),
                },
            ],
            drawer: Drawer {
                cash_sales: 7_310.00,
                cash_refunds: 420.00,
                expected: 6_890.00,
                first_sale: "07:58".to_string(),
                last_sale: "18:10".to_string(),
            },
            stock_check: vec![StockCheckRow {
                name: "Dog Food 10 kg".to_string(),
                sold: 3,
                expected: 9,
                actual: 5,
            }],
            stock_check_since: "Monday, 22 September 2026, 18:42".to_string(),
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

    /// One sale in a history, with its total worked out from its lines.
    fn history_sale(
        time: &str,
        number: i64,
        payment: &str,
        items: Vec<HistoryItem>,
    ) -> HistorySale {
        let total = items.iter().map(|item| item.line_total).sum();
        HistorySale {
            time: time.to_string(),
            number,
            kind: "sale".to_string(),
            refund_of_number: 0,
            payment: payment.to_string(),
            total,
            items,
        }
    }

    fn item(name: &str, qty: i64, price: f64) -> HistoryItem {
        HistoryItem {
            name: name.to_string(),
            qty,
            price,
            line_total: price * qty as f64,
        }
    }

    /// A day of trade, item by item, with one refund in it.
    fn busy_history() -> DayHistory {
        let mut sales: Vec<HistorySale> = (0..40)
            .map(|n| {
                history_sale(
                    &format!("{:02}:{:02}", 8 + n % 10, (n * 7) % 60),
                    100 + n,
                    if n % 3 == 0 { "Card" } else { "Cash" },
                    vec![
                        item("Puppy Food 2 kg", 1 + n % 3, 89.99),
                        item("Dog Food 10 kg", 2, 199.50),
                    ],
                )
            })
            .collect();
        sales.push(HistorySale {
            time: "14:32".to_string(),
            number: 140,
            kind: "return".to_string(),
            refund_of_number: 104,
            payment: "Cash".to_string(),
            total: -199.50,
            items: vec![HistoryItem {
                name: "Dog Food 10 kg".to_string(),
                qty: 1,
                price: 199.50,
                line_total: -199.50,
            }],
        });
        DayHistory {
            shop_name: "Lyra Trading Store".to_string(),
            address: "12 Long Street, Greytown, 3250".to_string(),
            phone: "033 417 2189".to_string(),
            currency: "R".to_string(),
            date_label: "Tuesday, 23 September 2026".to_string(),
            generated_at: "23 Sep 2026, 18:42".to_string(),
            footer_note: "Takings are the shop's own record and not a tax invoice.".to_string(),
            sales_count: 40,
            refunds_count: 1,
            items_sold: 121,
            takings: 12_480.50,
            refunds_value: 199.50,
            sales,
        }
    }

    fn write_history(history: &DayHistory, name: &str) -> (Vec<u8>, PathBuf) {
        let bytes = render_history_pdf(history);
        let path = sample(name);
        std::fs::write(&path, &bytes).expect("the sample history could not be written");
        let on_disk = std::fs::read(&path).expect("the sample history could not be read back");
        (on_disk, path)
    }

    /// Where a piece of text sits on the page, read from the content stream: the
    /// `Tm` line before its `Tj`. PDF's y counts up from the foot of the page,
    /// so a smaller figure is further down.
    fn text_y(bytes: &[u8], needle: &str) -> f64 {
        let text = String::from_utf8_lossy(bytes);
        let lines: Vec<&str> = text.lines().collect();
        let index = lines
            .iter()
            .position(|line| line.contains("Tj") && line.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} is not on the sheet"));
        for line in lines[..index].iter().rev() {
            if let Some(matrix) = line.strip_suffix(" Tm") {
                return matrix
                    .rsplit(' ')
                    .next()
                    .expect("a y coordinate")
                    .parse()
                    .expect("a Tm coordinate");
            }
        }
        panic!("no text position before {needle:?}");
    }

    #[test]
    fn a_hand_edited_stock_figure_is_called_out_in_red() {
        let mut report = quiet_day();
        report.stock_edits = vec![StockEditRow {
            time: "14:32".to_string(),
            name: "Puppy Food 2kg".to_string(),
            from: 12,
            to: 5,
            detail: String::new(),
        }];
        let (bytes, path) = write(&report, "daily-report-stock-edit.pdf");
        assert!(bytes.starts_with(b"%PDF-"), "{path:?} is not a PDF");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("CHANGES THE TAKINGS CANNOT ACCOUNT FOR"),
            "the section is missing: {path:?}"
        );
        assert!(
            text.contains("Puppy Food 2kg"),
            "the product is missing: {path:?}"
        );
        assert!(text.contains("12 -> 5"), "the change is missing: {path:?}");
        // Braces round a figure are escaped in the content stream, so the
        // bytes on disk carry backslashes before them.
        assert!(
            text.contains("\\(-7\\)"),
            "the difference is missing: {path:?}"
        );
        // The one section set in colour; 0.720 0.050 0.050 rg is the red.
        assert!(
            text.contains("0.720 0.050 0.050 rg"),
            "the line is not red: {path:?}"
        );
    }

    #[test]
    fn the_drawer_and_the_hours_the_day_ran_are_written_out() {
        let (bytes, path) = write(&busy_day(), "daily-report-sample.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("CASH IN THE TILL"),
            "the drawer section is missing: {path:?}"
        );
        assert!(
            text.contains("R6,890.00"),
            "cash in less cash back is missing: {path:?}"
        );
        assert!(
            text.contains("07:58"),
            "the first sale is missing: {path:?}"
        );
        assert!(text.contains("18:10"), "the last sale is missing: {path:?}");
    }

    #[test]
    fn an_unaccounted_stock_line_is_called_out_in_red() {
        let mut report = quiet_day();
        report.stock_check = vec![StockCheckRow {
            name: "Dog Food 10 kg".to_string(),
            sold: 3,
            expected: 9,
            actual: 5,
        }];
        report.stock_check_since = "Monday, 22 September 2026, 18:42".to_string();
        let (bytes, path) = write(&report, "daily-report-unaccounted.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("UNACCOUNTED STOCK"),
            "the section is missing: {path:?}"
        );
        assert!(
            text.contains("Dog Food 10 kg"),
            "the product is missing: {path:?}"
        );
        assert!(
            text.contains("9 expected, 5 found"),
            "the figures are missing: {path:?}"
        );
        assert!(
            text.contains("\\(-4\\)"),
            "the difference is missing: {path:?}"
        );
        assert!(
            text.contains("Counted against the figures of Monday, 22 September 2026, 18:42."),
            "what it was counted against is missing: {path:?}"
        );
        assert!(
            text.contains("0.720 0.050 0.050 rg"),
            "the line is not red: {path:?}"
        );
    }

    #[test]
    fn nothing_moving_between_reports_says_so() {
        let mut report = quiet_day();
        report.stock_check_since = "Monday, 22 September 2026, 18:42".to_string();
        let (bytes, path) = write(&report, "daily-report-stock-checked.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("UNACCOUNTED STOCK"),
            "the section heads the all-clear too: {path:?}"
        );
        assert!(
            text.contains("Every product's stock adds up against the last report."),
            "the all-clear is missing: {path:?}"
        );
        assert!(
            text.contains("Counted against the figures of Monday, 22 September 2026, 18:42."),
            "what it was counted against is missing: {path:?}"
        );

        // And a report from an older till, with no check in it at all: it must
        // render exactly as it always did.
        let (bytes, path) = write(&quiet_day(), "daily-report-older-payload.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains("UNACCOUNTED STOCK"),
            "an older payload must not grow a section it never had: {path:?}"
        );
    }

    #[test]
    fn a_change_with_its_own_wording_reads_the_way_the_shop_wrote_it() {
        let mut report = quiet_day();
        report.stock_edits = vec![StockEditRow {
            time: "14:36".to_string(),
            name: "Dog Food 10 kg (sale #1041)".to_string(),
            from: 0,
            to: 0,
            detail: "shelf R199.50 -> R99.00, R100.50 short".to_string(),
        }];
        let (bytes, path) = write(&report, "daily-report-price-change.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("Dog Food 10 kg \\(sale #1041\\)"),
            "the product and its sale are missing: {path:?}"
        );
        assert!(
            text.contains("shelf R199.50 -> R99.00, R100.50 short"),
            "the change in the shop's own words is missing: {path:?}"
        );
    }

    #[test]
    fn a_long_product_name_is_wrapped_rather_than_cut_out_of_the_stock_list() {
        let long = "Heavy-duty galvanised garden rake, 12 tine, with an ash handle and a \
                    replacement head";
        let mut report = quiet_day();
        report.stock_edits = (0..2)
            .map(|i| StockEditRow {
                time: format!("1{}:05", i),
                name: long.to_string(),
                from: 40 - i,
                to: 12 - i,
                detail: String::new(),
            })
            .collect();
        let (bytes, path) = write(&report, "daily-report-long-edit.pdf");
        let text = String::from_utf8_lossy(&bytes);
        // The whole name makes it onto the page — the second half on a second
        // line rather than being cut away.
        assert!(
            text.contains("Heavy-duty galvanised garden rake, 12 tine"),
            "the head of the name is missing: {path:?}"
        );
        assert!(
            text.contains("replacement head"),
            "the tail of the name was cut off: {path:?}"
        );
        assert!(
            text.contains("40 -> 12"),
            "the change itself is missing: {path:?}"
        );
    }

    #[test]
    fn a_long_list_of_edits_keeps_going_rather_than_stopping_at_a_page() {
        let mut report = quiet_day();
        report.stock_edits = (0..30)
            .map(|i| StockEditRow {
                time: format!("{:02}:15", 8 + i % 10),
                name: format!("Product number {i}"),
                from: 50,
                to: 50 - i,
                detail: String::new(),
            })
            .collect();
        let (bytes, path) = write(&report, "daily-report-many-edits.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("Product number 0"),
            "the first edit is missing: {path:?}"
        );
        assert!(
            text.contains("Product number 29"),
            "the last edit was cut off: {path:?}"
        );
        assert!(
            !text.contains("and 1 more"),
            "thirty edits should all be listed: {path:?}"
        );
        let pages = xref_offsets_are_right(&bytes);
        assert!(pages >= 2, "thirty edits need more than one page");
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

    #[test]
    fn a_wrapped_stock_edit_reads_down_the_page_rather_than_over_the_row_above() {
        // Long enough to need the second line, short enough not to need a third.
        let name = "Heavy-duty galvanised garden rake, 12 tine, with an ash handle and a \
                    replacement head for the workshop, with a spare shaft and ZZ-TAIL";
        let mut report = quiet_day();
        report.stock_edits = vec![StockEditRow {
            time: "14:32".to_string(),
            name: name.to_string(),
            from: 50,
            to: 12,
            detail: String::new(),
        }];
        let (bytes, path) = write(&report, "daily-report-wrapped-edit.pdf");
        let first = text_y(&bytes, "Heavy-duty galvanised garden");
        let second = text_y(&bytes, "ZZ-TAIL");
        assert!(
            second < first,
            "the second line of a wrapped name must sit below the first: {path:?}"
        );
        assert!(
            (first - second - LEAD).abs() < 0.5,
            "the second line sits one row under the first: {path:?}"
        );
    }

    #[test]
    fn a_busy_day_of_sales_writes_a_history_that_reads_across_pages() {
        let (bytes, path) = write_history(&busy_history(), "sales-history-sample.pdf");
        assert!(bytes.starts_with(b"%PDF-"), "{path:?} is not a PDF");
        assert!(bytes.ends_with(b"%%EOF\n"));
        let pages = xref_offsets_are_right(&bytes);
        assert!(
            pages >= 2,
            "a busy day's history should not fit on one page"
        );
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("EVERY SALE, LINE BY LINE"),
            "the section is missing: {path:?}"
        );
        assert!(
            text.contains("Sale #100"),
            "the first sale is missing: {path:?}"
        );
        assert!(
            text.contains("Sale #139"),
            "the last sale is missing: {path:?}"
        );
        assert!(
            text.contains("Puppy Food 2 kg"),
            "an item is missing: {path:?}"
        );
        assert!(
            text.contains("\\(continued\\)"),
            "a continuation page is not headed: {path:?}"
        );
    }

    #[test]
    fn a_refund_is_drawn_in_red_beside_the_sale_it_came_from() {
        let (bytes, path) = write_history(&busy_history(), "sales-history-refund.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("Refund #140 of #104"),
            "the refund is missing: {path:?}"
        );
        assert!(
            text.contains("R-199.50"),
            "the money going back is missing: {path:?}"
        );
        assert!(
            text.contains("1 refund \\(R-199.50\\)"),
            "the day's refund is not counted in the summary line: {path:?}"
        );
        // The same red the stock-edit lines use: money going back over the
        // counter is the one thing worth finding without reading every line.
        assert!(
            text.contains("0.720 0.050 0.050 rg"),
            "the refund is not red: {path:?}"
        );
    }

    #[test]
    fn a_quiet_day_still_writes_a_history() {
        let quiet = DayHistory {
            shop_name: "Lyra Trading Store".to_string(),
            currency: "R".to_string(),
            date_label: "Sunday, 21 September 2026".to_string(),
            ..DayHistory::default()
        };
        let (bytes, path) = write_history(&quiet, "sales-history-quiet.pdf");
        assert!(bytes.starts_with(b"%PDF-"), "{path:?} is not a PDF");
        assert_eq!(
            xref_offsets_are_right(&bytes),
            1,
            "a day with nothing on it is one page"
        );
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("No sales were rung up on this day."),
            "the empty note is missing: {path:?}"
        );
    }

    #[test]
    fn a_history_payload_with_holes_in_it_still_renders() {
        let history: DayHistory = serde_json::from_str(
            r#"{"takings": null, "salesCount": "12.7", "refundsValue": "nonsense",
                "sales": [{"items": null, "total": "12.50"}, {}]}"#,
        )
        .expect("a payload with holes in it should deserialize");
        assert_eq!(history.takings, 0.0);
        assert_eq!(history.refunds_value, 0.0);
        assert_eq!(history.sales_count, 13);
        assert_eq!(history.sales.len(), 2);
        assert!(history.sales[0].items.is_empty());
        assert_eq!(history.sales[0].total, 12.50);
        assert!(render_history_pdf(&history).starts_with(b"%PDF-"));
    }

    #[test]
    fn a_long_item_name_wraps_onto_a_second_line_rather_than_being_cut() {
        // Long enough to need the second line, short enough not to need a third
        // — which is where a row is cut short.
        let name = "Heavy-duty galvanised garden rake, 12 tine, with an ash handle and a \
                    replacement head for the workshop, with a spare shaft and ZZ-TAIL";
        let history = DayHistory {
            shop_name: "Lyra Trading Store".to_string(),
            currency: "R".to_string(),
            date_label: "Tuesday, 23 September 2026".to_string(),
            sales: vec![history_sale(
                "09:15",
                100,
                "Cash",
                vec![item(name, 2, 540.00)],
            )],
            ..DayHistory::default()
        };
        let (bytes, path) = write_history(&history, "sales-history-long-item.pdf");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("Heavy-duty galvanised garden rake, 12 tine"),
            "the head of the name is missing: {path:?}"
        );
        assert!(
            text.contains("ZZ-TAIL"),
            "the tail of the name was cut off: {path:?}"
        );
        let first = text_y(&bytes, "Heavy-duty galvanised garden rake");
        let second = text_y(&bytes, "ZZ-TAIL");
        assert!(
            second < first,
            "the second line of a long item must sit below the first: {path:?}"
        );
    }
}
