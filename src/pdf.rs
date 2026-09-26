//! A very small PDF writer: text, thin rules and filled rectangles, nothing more.
//!
//! The day report is a table of figures on A4 paper — no images, no embedded
//! fonts, no compression — so this writes the file directly rather than carrying
//! a PDF library, its font-shaping engine and its image decoders into a till
//! that only ever draws a column of takings.
//!
//! Three conventions hold throughout, and all of them exist so `report.rs` can
//! be read as the report it draws:
//!
//! - Coordinates are points measured from the *top* left of the page, the way a
//!   page of paper is read. PDF measures from the bottom left; the one place
//!   that conversion happens is [`content`].
//! - Everything is set in Helvetica, one of the fourteen fonts every PDF reader
//!   already has, so nothing has to be embedded. Helvetica's digits are all
//!   556/1000 em wide, which is what makes a column of money line up under
//!   itself.
//! - Text is written in WinAnsiEncoding — one byte per character — so an accent
//!   in a shop's own name still lands on the right glyph.

use unicode_normalization::UnicodeNormalization;

/// A4 portrait in points (1/72 inch), which is what a report that will be read
/// on a phone or on a laptop screen is laid out for.
pub const A4_WIDTH: f64 = 595.28;
pub const A4_HEIGHT: f64 = 841.89;

/// Which of the two fonts a run of text is set in.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Face {
    Regular,
    Bold,
}

/// One thing drawn on a page. Coordinates are from the top left, as above.
enum Mark {
    Text {
        x: f64,
        y: f64,
        size: f64,
        face: Face,
        grey: f64,
        text: String,
    },
    Rule {
        x1: f64,
        x2: f64,
        y: f64,
        grey: f64,
        width: f64,
    },
    Band {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        grey: f64,
    },
}

/// One page's worth of marks.
#[derive(Default)]
pub struct Page {
    marks: Vec<Mark>,
}

impl Page {
    /// Writes `text` with its baseline at `y`, starting at `x`.
    pub fn text(&mut self, x: f64, y: f64, size: f64, face: Face, grey: f64, text: &str) {
        if text.is_empty() {
            return;
        }
        self.marks.push(Mark::Text {
            x,
            y,
            size,
            face,
            grey,
            text: text.to_string(),
        });
    }

    /// A hairline rule, drawn the way a rule between two rows of figures is.
    pub fn rule(&mut self, x1: f64, x2: f64, y: f64, grey: f64, width: f64) {
        self.marks.push(Mark::Rule {
            x1,
            x2,
            y,
            grey,
            width,
        });
    }

    /// A filled rectangle, for the band behind a section heading.
    pub fn band(&mut self, x: f64, y: f64, w: f64, h: f64, grey: f64) {
        self.marks.push(Mark::Band { x, y, w, h, grey });
    }
}

/// A document: as many pages as the content needed.
#[derive(Default)]
pub struct Document {
    width: f64,
    height: f64,
    pages: Vec<Page>,
}

impl Document {
    pub fn new(width: f64, height: f64) -> Self {
        Self {
            width,
            height,
            pages: Vec::new(),
        }
    }

    pub fn add_page(&mut self, page: Page) {
        self.pages.push(page);
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// The page at `index`, for the footer text that can only be written once
    /// the last page's number is known.
    pub fn page_mut(&mut self, index: usize) -> Option<&mut Page> {
        self.pages.get_mut(index)
    }

    /// The file itself: objects, a cross-reference table and a trailer.
    pub fn finish(mut self, title: &str) -> Vec<u8> {
        // An empty document is not a valid PDF, and no caller means to make one.
        if self.pages.is_empty() {
            self.pages.push(Page::default());
        }

        // The first five object numbers are fixed: catalog, page tree and the two
        // fonts. Every page then brings a content stream and a page object.
        let mut objects: Vec<Vec<u8>> = vec![Vec::new(); 5];
        let mut kids = String::new();
        for page in &self.pages {
            let stream = content(page, self.height);
            let content_id = objects.len() + 1;
            let mut body = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
            body.extend_from_slice(&stream);
            body.extend_from_slice(b"endstream");
            objects.push(body);

            let page_id = objects.len() + 1;
            kids.push_str(&format!("{page_id} 0 R "));
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] \
                     /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R >>",
                    self.width, self.height
                )
                .into_bytes(),
            );
        }

        objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
        objects[1] = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.trim_end(),
            self.pages.len()
        )
        .into_bytes();
        objects[2] =
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_vec();
        objects[3] =
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
                .to_vec();
        objects[4] = format!(
            "<< /Producer (Lyra PoS {}) /Title ({}) >>",
            env!("CARGO_PKG_VERSION"),
            escape(title)
        )
        .into_bytes();

        let mut out: Vec<u8> = Vec::with_capacity(4096);
        out.extend_from_slice(b"%PDF-1.4\n");
        // Four bytes above 0x7F, which is the marker that tells anything moving
        // this file around that it is not a text file to be line-ending-mangled.
        out.extend_from_slice(b"%\xe2\xe3\xcf\xd3\n");

        let mut offsets = Vec::with_capacity(objects.len());
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }

        // Every entry in the table is exactly twenty bytes: ten of offset, five
        // of generation, then `n` and two spaces.
        let xref_at = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in &offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }
}

/// How wide `text` is at `size` points, in points.
///
/// Letters in Helvetica-Bold are about a sixteenth wider than in Helvetica, so
/// bold text is measured at the wider figure: anything placed from its right-hand
/// end then lands inside the margin rather than a point or two past it. Nothing
/// right-aligned in this report is bold — the figures are, and they are made of
/// digits, which are 556/1000 em in both faces.
pub fn text_width(text: &str, size: f64, face: Face) -> f64 {
    let weight = match face {
        Face::Regular => 1.0,
        Face::Bold => 1.06,
    };
    let units: u32 = text.nfc().map(char_units).map(u32::from).sum();
    size * units as f64 / 1000.0 * weight
}

/// `text`, cut to fit `max_width` with an ellipsis where it was cut.
///
/// Used so that a long product name gives way to the column of figures beside
/// it rather than printing over the top of it.
pub fn truncate(text: &str, max_width: f64, size: f64, face: Face) -> String {
    if max_width <= 0.0 {
        return String::new();
    }
    if text_width(text, size, face) <= max_width {
        return text.to_string();
    }
    // Room for the ellipsis comes out first, so the cut line is guaranteed to
    // fit rather than being a character too wide.
    let mut budget = max_width - text_width("…", size, face);
    let mut out = String::new();
    for ch in text.chars() {
        let units = f64::from(char_units(ch)) * size / 1000.0;
        if units > budget {
            break;
        }
        budget -= units;
        out.push(ch);
    }
    out.push('…');
    out
}

/// The width of one character, in 1/1000 em.
fn char_units(ch: char) -> u16 {
    let code = ch as u32;
    if (0x20..=0x7e).contains(&code) {
        ASCII_WIDTHS[code as usize - 0x20]
    } else if ch == '\t' || ch == '\n' || ch == '\r' {
        ASCII_WIDTHS[0] // a control character prints as the space it becomes
    } else {
        high_width(ch)
    }
}

/// Helvetica's advance widths for ASCII, in 1/1000 em, in code order from 0x20.
const ASCII_WIDTHS: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, //  !"#$%&'()*+,-./
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
    278, 278, 584, 584, 584, 556, 1015, // :;<=>?@
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
    611, 722, 667, 944, 667, 667, 611, // A-Z
    278, 278, 278, 469, 556, 333, // [\]^_`
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
    278, 556, 500, 722, 500, 500, 500, // a-z
    334, 260, 334, 584, // {|}~
];

/// Helvetica's widths for the high half of WinAnsi, in 1/1000 em. The characters
/// a shop is likely to type are listed; anything else is given the width of an
/// average lower-case letter, which is close enough for the one thing a width is
/// used for here — deciding where a long name has to be cut.
fn high_width(ch: char) -> u16 {
    match ch {
        '\u{a0}' => 278,
        '¡' => 333,
        '¢' | '£' | '¤' | '¥' | '§' => 556,
        '¦' => 260,
        '¨' | '´' | '¸' | 'ˆ' | '˜' => 333,
        '©' | '®' => 737,
        'ª' => 370,
        '«' | '»' => 556,
        '¬' | '±' | '×' | '÷' => 584,
        '\u{ad}' => 333,
        '¯' => 333,
        '°' => 400,
        '²' | '³' | '¹' => 333,
        'µ' | '¶' => 556,
        '·' => 278,
        'º' => 365,
        '¿' => 611,
        'À'..='Å' => 667,
        'Æ' => 1000,
        'Ç' => 722,
        'È'..='Ë' => 667,
        'Ì'..='Ï' => 278,
        'Ð' | 'Ñ' => 722,
        'Ò'..='Ö' => 778,
        'Ø' => 778,
        'Ù'..='Ü' => 722,
        'Ý' | 'Þ' => 667,
        'ß' => 611,
        'à'..='å' => 556,
        'æ' => 889,
        'ç' => 500,
        'è'..='ë' => 556,
        'ì'..='ï' => 278,
        'ð' | 'ñ' => 556,
        'ò'..='ö' => 556,
        'ø' => 556,
        'ù'..='ü' => 556,
        'ý' | 'ÿ' => 500,
        'þ' => 556,
        '€' => 556,
        '‚' | '‘' | '’' => 222,
        'ƒ' => 556,
        '„' | '“' | '”' | '‹' | '›' => 333,
        '…' | 'Œ' | '—' | '‰' | '™' => 1000,
        '†' | '‡' => 556,
        'Š' | 'Ž' | 'Ÿ' => 667,
        'š' | 'ž' => 500,
        '•' => 350,
        '–' => 556,
        'œ' => 944,
        _ => 556,
    }
}

/// The character each byte from 0x80 to 0xFF stands for in WinAnsiEncoding, in
/// order. The gaps (`\u{81}` and its neighbours) are the codes CP1252 leaves
/// undefined, so no character a shop can type maps onto them.
///
/// The upper half is written as codepoints rather than as characters: they are
/// punctuation that is hard to tell one from another by eye when reading the
/// source, and a table this one is not worth a mis-typed glyph in.
const WIN_ANSI_HIGH: &str = concat!(
    // 0x80 — what CP1252 puts above ASCII.
    "\u{20ac}\u{81}\u{201a}\u{192}\u{201e}\u{2026}\u{2020}\u{2021}\u{2c6}\u{2030}",
    "\u{160}\u{2039}\u{152}\u{8d}\u{17d}\u{8f}\u{90}\u{2018}\u{2019}\u{201c}",
    "\u{201d}\u{2022}\u{2013}\u{2014}\u{2dc}\u{2122}\u{161}\u{203a}\u{153}\u{9d}",
    "\u{17e}\u{178}",
    // 0xA0 — Latin-1 itself.
    "\u{a0}¡¢£¤¥¦§¨©ª«¬\u{ad}®¯°±²³´µ¶·¸¹º»¼½¾¿",
    "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß",
    "àáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ",
);

/// Text as WinAnsi bytes. Anything with no character in that encoding becomes
/// `?` — the same bargain the receipt printer makes, and the only honest option
/// for a file that carries one byte per character.
fn encode(text: &str) -> Vec<u8> {
    text.nfc()
        .map(|ch| {
            let code = ch as u32;
            if (0x20..=0x7e).contains(&code) {
                code as u8
            } else if ch == '\t' || ch == '\n' || ch == '\r' {
                b' '
            } else if let Some(index) = WIN_ANSI_HIGH.chars().position(|c| c == ch) {
                0x80 + index as u8
            } else {
                b'?'
            }
        })
        .collect()
}

/// A PDF string literal, which needs `\`, `(` and `)` escaped.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' | '(' | ')' => {
                out.push('\\');
                out.push(ch);
            }
            // A document's information dictionary has no encoding to declare, so
            // anything outside ASCII is left out of it rather than written as a
            // byte the reader would guess at. It is only ever a title.
            ch if ch.is_ascii() => out.push(ch),
            _ => out.push('?'),
        }
    }
    out
}

/// Draws one page as a content stream.
fn content(page: &Page, height: f64) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(1024);
    for mark in &page.marks {
        match mark {
            Mark::Text {
                x,
                y,
                size,
                face,
                grey,
                text,
            } => {
                let font = match face {
                    Face::Regular => "F1",
                    Face::Bold => "F2",
                };
                // PDF's origin is the bottom left, so y counts upwards from it.
                out.extend_from_slice(
                    format!(
                        "BT\n/{font} {size:.2} Tf\n{grey:.3} g\n1 0 0 1 {x:.2} {:.2} Tm\n(",
                        height - y
                    )
                    .as_bytes(),
                );
                for byte in encode(text) {
                    match byte {
                        b'\\' | b'(' | b')' => out.push(b'\\'),
                        _ => {}
                    }
                    out.push(byte);
                }
                out.extend_from_slice(b") Tj\nET\n");
            }
            Mark::Rule {
                x1,
                x2,
                y,
                grey,
                width,
            } => out.extend_from_slice(
                format!(
                    "{width:.2} w\n{grey:.3} G\n{x1:.2} {:.2} m\n{x2:.2} {:.2} l\nS\n",
                    height - y,
                    height - y
                )
                .as_bytes(),
            ),
            Mark::Band { x, y, w, h, grey } => out.extend_from_slice(
                format!(
                    "{grey:.3} g\n{x:.2} {:.2} {w:.2} {h:.2} re\nf\n",
                    height - y - h
                )
                .as_bytes(),
            ),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoding_table_has_one_entry_per_byte() {
        let chars: Vec<char> = WIN_ANSI_HIGH.chars().collect();
        assert_eq!(chars.len(), 128);
        // From 0xA0 on the table is Latin-1 itself, so half of it can be checked
        // against the codepoints rather than against how a character was typed.
        for (index, ch) in chars.iter().enumerate().skip(0x20) {
            assert_eq!(
                *ch as u32,
                0xA0 + (index - 0x20) as u32,
                "byte {:#04x} maps to the wrong character",
                0x80 + index
            );
        }
    }

    #[test]
    fn accents_use_the_readers_own_table() {
        assert_eq!(encode("é"), vec![0xe9]);
        assert_eq!(encode("£"), vec![0xa3]);
        assert_eq!(encode("€"), vec![0x80]);
        assert_eq!(encode("—"), vec![0x97]);
        assert_eq!(encode("’"), vec![0x92]);
        // and a combining accent is normalised before it is encoded
        assert_eq!(encode("Cafe\u{0301}"), b"Caf\xe9");
    }

    #[test]
    fn anything_the_encoding_has_no_character_for_becomes_a_question_mark() {
        assert_eq!(encode("→"), b"?");
        assert_eq!(encode("😀"), b"?");
        assert_eq!(encode("a\tb"), b"a b");
    }

    #[test]
    fn digits_are_all_the_same_width() {
        // This is the whole reason a column of money lines up under itself.
        assert_eq!(
            text_width("1", 10.0, Face::Regular),
            text_width("8", 10.0, Face::Regular)
        );
        // Bold is measured a shade wide on purpose, never narrow.
        assert!(text_width("1", 10.0, Face::Bold) >= text_width("1", 10.0, Face::Regular));
        assert!((text_width("0000", 10.0, Face::Regular) - 22.24).abs() < 0.01);
        assert!((text_width("", 10.0, Face::Regular)).abs() < f64::EPSILON);
    }

    #[test]
    fn truncation_keeps_the_line_within_its_column() {
        let long = "A product name that will not fit";
        let cut = truncate(long, 40.0, 10.0, Face::Regular);
        assert!(cut.ends_with('…'));
        assert!(text_width(&cut, 10.0, Face::Regular) <= 40.0);
        // something that already fits is left exactly as it is
        assert_eq!(truncate("Short", 400.0, 10.0, Face::Regular), "Short");
        assert!(text_width(&truncate("Short", 40.0, 10.0, Face::Bold), 10.0, Face::Bold) <= 40.0);
    }

    #[test]
    fn a_document_with_no_pages_is_still_a_pdf() {
        let bytes = Document::new(A4_WIDTH, A4_HEIGHT).finish("Empty");
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        assert_eq!(xref_offsets_are_right(&bytes), 1);
    }
}

/// Walks a finished file's own cross-reference table and returns the number of
/// pages. A wrong byte offset is the one mistake a hand-written PDF cannot show
/// in a text editor, so it is checked here rather than by whatever reader the
/// shop happens to open the file with.
#[cfg(test)]
pub(crate) fn xref_offsets_are_right(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    let start = text.rfind("startxref\n").expect("no startxref") + "startxref\n".len();
    let xref_at: usize = text[start..]
        .lines()
        .next()
        .expect("no startxref value")
        .trim()
        .parse()
        .expect("startxref was not a number");
    assert!(
        bytes[xref_at..].starts_with(b"xref"),
        "startxref points at {:?}",
        String::from_utf8_lossy(&bytes[xref_at..xref_at + 8])
    );

    let objects = text.split(" 0 obj").count() - 1;
    let head = format!("xref\n0 {}\n", 1 + objects);
    assert!(
        bytes[xref_at..].starts_with(head.as_bytes()),
        "the cross-reference table header is wrong"
    );
    let table = &bytes[xref_at + head.len()..];
    for index in 0..objects {
        let entry = &table[index * 20..index * 20 + 20];
        let entry = std::str::from_utf8(entry).expect("a table entry is not text");
        assert_eq!(entry.len(), 20);
        if index == 0 {
            // The free entry that heads every table.
            assert_eq!(&entry[..10], "0000000000");
            continue;
        }
        // The table's nth record belongs to the nth object.
        let offset: usize = entry[..10].parse().expect("an offset is not a number");
        let expect = format!("{index} 0 obj");
        assert!(
            bytes[offset..].starts_with(expect.as_bytes()),
            "object {index} is not at its own offset"
        );
    }

    text.split("/Count ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .expect("no page count")
        .parse()
        .expect("the page count is not a number")
}
