//! Reading a product list out of a spreadsheet or CSV, and guessing which
//! column is which.
//!
//! The shop's existing till is POS Maid, whose inventory screen exports to
//! Excel. The file is read here and handed to the frontend as plain rows keyed
//! by their column headings, so the mapping can be checked on screen before
//! anything is imported.

use std::collections::BTreeMap;
use std::path::Path;

use calamine::{Data, DataType, Reader, open_workbook_auto};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFile {
    pub file_name: String,
    pub headers: Vec<String>,
    pub rows: Vec<BTreeMap<String, String>>,
    /// Our best guess at the column mapping, keyed by the field's id in the
    /// mapping dialog, e.g. `mapName` -> `"Item Description"`.
    pub suggested: BTreeMap<String, String>,
}

/// Each field's keyword list, most specific first. Matching is resolved
/// globally (see [`guess_column_mapping`]) rather than by greedily claiming
/// columns field by field, so a generic word like "price" inside "SupplyPrice"
/// can't steal a column that is really a much better match for Cost.
const IMPORT_FIELDS: &[(&str, &[&str])] = &[
    (
        "mapName",
        &[
            "itemdescription",
            "productname",
            "itemname",
            "description",
            "name",
            "product",
            "item",
        ],
    ),
    (
        "mapSku",
        &[
            "sku",
            "barcode",
            "upc",
            "ean",
            "itemid",
            "itemcode",
            "productcode",
            "plu",
            "code",
        ],
    ),
    (
        "mapCategory",
        &["category", "department", "class", "group", "dept"],
    ),
    (
        "mapPrice",
        &[
            "saleprice",
            "retailprice",
            "sellprice",
            "unitprice",
            "price",
            "retail",
        ],
    ),
    (
        "mapCost",
        &[
            "supplyprice",
            "unitcost",
            "wholesale",
            "buyprice",
            "costprice",
            "cost",
        ],
    ),
    (
        "mapStock",
        &[
            "qtyonhand",
            "stockqty",
            "onhand",
            "quantity",
            "inventory",
            "stock",
            "qty",
        ],
    ),
    (
        "mapSupplier",
        &[
            "suppliername",
            "supplierid",
            "supplier",
            "vendor",
            "distributor",
        ],
    ),
];

/// Lower-cases a heading and drops everything that isn't a letter or a digit,
/// so "Item Description", "item_description" and "ITEM-DESCRIPTION" all match
/// the same keyword.
fn norm_header(h: &str) -> String {
    h.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Scores every (heading, field, keyword) combination that matches at all, then
/// greedily assigns the highest-scoring pairs first. An exact match always
/// outranks a substring match, and longer, more specific keywords outrank
/// shorter generic ones — so a "SupplyPrice" heading exact-matching Cost's
/// `supplyprice` keyword (score 111) wins over it merely containing Price's
/// generic `price` (score 15).
pub fn guess_column_mapping(headers: &[String]) -> BTreeMap<String, String> {
    struct Candidate {
        header: String,
        field: &'static str,
        score: usize,
    }

    let mut candidates: Vec<Candidate> = Vec::new();
    for header in headers {
        let norm = norm_header(header);
        for (field, guesses) in IMPORT_FIELDS {
            for guess in *guesses {
                if norm == *guess {
                    candidates.push(Candidate {
                        header: header.clone(),
                        field,
                        score: 100 + guess.len(),
                    });
                } else if norm.contains(guess) {
                    candidates.push(Candidate {
                        header: header.clone(),
                        field,
                        score: 10 + guess.len(),
                    });
                }
            }
        }
    }

    // A stable sort, so equal scores keep the order they were found in.
    candidates.sort_by(|a, b| b.score.cmp(&a.score));

    let mut result = BTreeMap::new();
    let mut claimed_headers: Vec<&str> = Vec::new();
    let mut claimed_fields: Vec<&str> = Vec::new();
    for c in &candidates {
        if claimed_headers.contains(&c.header.as_str()) || claimed_fields.contains(&c.field) {
            continue;
        }
        result.insert(c.field.to_string(), c.header.clone());
        claimed_headers.push(&c.header);
        claimed_fields.push(c.field);
    }
    result
}

/// Reads a product list, picking the reader by file extension.
pub fn read_products_file(path: &Path) -> Result<ParsedFile, String> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let is_csv = path
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_ascii_lowercase();
            e == "csv" || e == "tsv" || e == "txt"
        })
        .unwrap_or(false);

    let raw = if is_csv {
        read_csv(path)?
    } else {
        read_spreadsheet(path)?
    };

    let (headers, rows) = raw;
    if rows.is_empty() {
        return Err("That file has no rows to import.".to_string());
    }

    let suggested = guess_column_mapping(&headers);
    Ok(ParsedFile {
        file_name,
        headers,
        rows,
        suggested,
    })
}

type Rows = Vec<BTreeMap<String, String>>;

/// Turns a grid of cells into headings plus rows keyed by those headings.
/// Duplicate headings get a suffix, the way the original spreadsheet reader
/// named them, so two columns called "Price" don't overwrite each other.
fn build_table(grid: Vec<Vec<String>>) -> (Vec<String>, Rows) {
    let mut iter = grid.into_iter();
    let Some(first) = iter.next() else {
        return (Vec::new(), Vec::new());
    };

    let mut headers: Vec<String> = Vec::with_capacity(first.len());
    for raw in first {
        let mut name = raw.trim().to_string();
        if name.is_empty() {
            name = format!("Column {}", headers.len() + 1);
        }
        // Keep every heading distinct, so no column is silently swallowed.
        if headers.contains(&name) {
            let base = name.clone();
            let mut n = 1;
            while headers.contains(&name) {
                name = format!("{base}_{n}");
                n += 1;
            }
        }
        headers.push(name);
    }

    let mut rows: Rows = Vec::new();
    for cells in iter {
        // A blank row is spacing in the spreadsheet, not a product.
        if cells.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let mut row = BTreeMap::new();
        for (i, header) in headers.iter().enumerate() {
            let value = cells.get(i).cloned().unwrap_or_default();
            row.insert(header.clone(), value);
        }
        rows.push(row);
    }

    (headers, rows)
}

fn read_csv(path: &Path) -> Result<(Vec<String>, Rows), String> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(false)
        .from_path(path)
        .map_err(|e| format!("Could not read that file: {e}"))?;

    let mut grid: Vec<Vec<String>> = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| format!("Could not read that file: {e}"))?;
        grid.push(record.iter().map(|f| f.to_string()).collect());
    }
    if grid.is_empty() {
        return Err("That file has no rows to import.".to_string());
    }
    Ok(build_table(grid))
}

fn read_spreadsheet(path: &Path) -> Result<(Vec<String>, Rows), String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|e| format!("Could not read that file: {e}"))?;
    let Some(sheet_name) = workbook.sheet_names().first().cloned() else {
        return Err("That file has no sheets.".to_string());
    };
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("Could not read that file: {e}"))?;

    let grid: Vec<Vec<String>> = range
        .rows()
        .map(|row| row.iter().map(cell_to_string).collect())
        .collect();

    if grid.is_empty() {
        return Err("That file has no rows to import.".to_string());
    }
    Ok(build_table(grid))
}

/// How a cell reads once the spreadsheet's own formatting is applied, which is
/// what matters for a heading or a price.
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => format_number(*f),
        Data::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        // A date shows as a date, not as Excel's internal day number.
        Data::DateTime(_) | Data::DateTimeIso(_) => match cell.as_datetime() {
            Some(dt) => {
                if dt.time() == chrono::NaiveTime::MIN {
                    dt.format("%Y-%m-%d").to_string()
                } else {
                    dt.format("%Y-%m-%d %H:%M:%S").to_string()
                }
            }
            None => String::new(),
        },
        Data::DurationIso(s) => s.clone(),
        Data::Error(_) => String::new(),
    }
}

/// `12.5` not `12.500000`, and `12` not `12.0` — the shortest form that reads
/// back as the same number.
fn format_number(f: f64) -> String {
    if !f.is_finite() {
        return String::new();
    }
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    let s = format!("{f}");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn headings_are_normalised_before_matching() {
        assert_eq!(norm_header("Item Description"), "itemdescription");
        assert_eq!(norm_header("item_description"), "itemdescription");
        assert_eq!(norm_header("ITEM-DESCRIPTION"), "itemdescription");
        assert_eq!(norm_header("  Price  "), "price");
    }

    #[test]
    fn a_pos_maid_export_maps_its_columns() {
        let suggested = guess_column_mapping(&headers(&[
            "Item Description",
            "Item Code",
            "Department",
            "Sale Price",
            "Supply Price",
            "Qty On Hand",
            "Supplier Name",
        ]));
        assert_eq!(suggested["mapName"], "Item Description");
        assert_eq!(suggested["mapSku"], "Item Code");
        assert_eq!(suggested["mapCategory"], "Department");
        assert_eq!(suggested["mapPrice"], "Sale Price");
        assert_eq!(suggested["mapCost"], "Supply Price");
        assert_eq!(suggested["mapStock"], "Qty On Hand");
        assert_eq!(suggested["mapSupplier"], "Supplier Name");
    }

    #[test]
    fn supply_price_becomes_cost_rather_than_price() {
        // "SupplyPrice" contains "price", but it exactly matches Cost's own
        // keyword, and that has to win.
        let suggested = guess_column_mapping(&headers(&["SupplyPrice", "Cost"]));
        assert_eq!(suggested["mapCost"], "SupplyPrice");
        assert!(!suggested.contains_key("mapPrice"));
    }

    #[test]
    fn no_column_is_claimed_by_two_fields() {
        let suggested = guess_column_mapping(&headers(&["Name", "Price"]));
        assert_eq!(suggested.len(), 2);
        assert_eq!(suggested["mapName"], "Name");
        assert_eq!(suggested["mapPrice"], "Price");
    }

    #[test]
    fn unrecognisable_headings_are_simply_left_unmapped() {
        let suggested = guess_column_mapping(&headers(&["Zzz", "Qqq"]));
        assert!(suggested.is_empty());
    }

    #[test]
    fn a_blank_first_column_still_gets_a_heading() {
        let (headers, rows) = build_table(vec![
            vec!["".into(), "Price".into()],
            vec!["Coke".into(), "12.50".into()],
        ]);
        assert_eq!(headers, vec!["Column 1".to_string(), "Price".to_string()]);
        assert_eq!(rows[0]["Column 1"], "Coke");
        assert_eq!(rows[0]["Price"], "12.50");
    }

    #[test]
    fn duplicate_headings_do_not_overwrite_each_other() {
        let (headers, rows) = build_table(vec![
            vec!["Price".into(), "Price".into()],
            vec!["10".into(), "20".into()],
        ]);
        assert_eq!(headers, vec!["Price".to_string(), "Price_1".to_string()]);
        assert_eq!(rows[0]["Price"], "10");
        assert_eq!(rows[0]["Price_1"], "20");
    }

    #[test]
    fn blank_rows_are_spacing_not_products() {
        let (_, rows) = build_table(vec![
            vec!["Name".into()],
            vec!["Coke".into()],
            vec!["".into()],
            vec!["  ".into()],
            vec!["Bread".into()],
        ]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["Name"], "Bread");
    }

    #[test]
    fn short_rows_are_filled_in_rather_than_dropped() {
        let (headers, rows) = build_table(vec![
            vec!["Name".into(), "Price".into(), "Stock".into()],
            vec!["Coke".into(), "12.50".into()],
        ]);
        assert_eq!(headers.len(), 3);
        assert_eq!(rows[0]["Stock"], "");
        assert_eq!(rows[0]["Price"], "12.50");
    }

    #[test]
    fn numbers_read_the_way_a_person_wrote_them() {
        assert_eq!(format_number(12.0), "12");
        assert_eq!(format_number(12.5), "12.5");
        assert_eq!(format_number(0.0), "0");
        assert_eq!(format_number(129.99), "129.99");
        assert_eq!(format_number(f64::NAN), "");
    }
}
