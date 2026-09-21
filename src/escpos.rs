//! ESC/POS receipt builder.
//!
//! Receipts in this app are plain 32-column text, which is exactly what a
//! thermal printer wants. Sending that text as ESC/POS needs no printer driver
//! at all: the bytes go to the printer untouched (see `printing.rs`). Compared
//! with rendering the receipt as an image it is sharper, far quicker, and it
//! works with printers whose Windows driver cannot actually drive them.

use unicode_normalization::UnicodeNormalization;

const ESC: u8 = 0x1b;
const GS: u8 = 0x1d;

/// Characters the printer's default PC437 table has that ASCII does not. Index 0
/// is code `0x80`, so `é` prints as `é` (`0x82`) rather than `?`. Anything that
/// is neither below this nor plain ASCII is sent as `?`.
const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»";

/// A few useful characters that live outside that block.
fn cp437_extra(ch: char) -> Option<u8> {
    match ch {
        'ß' => Some(0xe1),
        '°' => Some(0xf8),
        '±' => Some(0xf1),
        _ => None,
    }
}

/// Converts receipt text to the bytes a thermal printer expects.
///
/// The text is normalised to NFC first, so an accent typed as a separate
/// combining character ("Cafe" + U+0301) prints as `é` rather than `?`.
pub fn text_to_bytes(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.nfc() {
        let code = ch as u32;
        if code == 0x0a || code == 0x0d {
            bytes.push(code as u8);
            continue;
        }
        if (0x20..=0x7e).contains(&code) {
            bytes.push(code as u8);
            continue;
        }
        if let Some(i) = CP437_HIGH.chars().position(|c| c == ch) {
            bytes.push(0x80 + i as u8);
            continue;
        }
        if let Some(b) = cp437_extra(ch) {
            bytes.push(b);
            continue;
        }
        bytes.push(b'?');
    }
    bytes
}

/// Builds one complete receipt: reset, the receipt text, a little feed, then the
/// cut. The cut is the last thing sent and is opt-in (see
/// `Settings::receipt_cut_paper`), because a printer that errors on a cut
/// refuses every receipt after it.
pub fn build_receipt(text: &str, cut: bool) -> Vec<u8> {
    build_receipt_with_feed(text, cut, 4)
}

/// As [`build_receipt`], with the number of feed lines before the cut made
/// explicit — enough to clear the tear bar, but not so many that a receipt
/// wastes paper.
pub fn build_receipt_with_feed(text: &str, cut: bool, feed_lines: u8) -> Vec<u8> {
    // One newline convention, and always a trailing one, so the printer is never
    // left mid-line before the feed.
    let mut normalised = String::with_capacity(text.len() + 2);
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalised.push_str("\r\n");
        } else if ch == '\n' {
            normalised.push_str("\r\n");
        } else {
            normalised.push(ch);
        }
    }
    if !normalised.ends_with("\r\n") {
        normalised.push_str("\r\n");
    }

    let mut out = Vec::with_capacity(normalised.len() + 16);
    out.extend_from_slice(&[ESC, 0x40]); // ESC @    initialise, so each receipt starts clean
    out.extend_from_slice(&[ESC, 0x74, 0x00]); // ESC t 0  character table = PC437
    out.extend_from_slice(&[ESC, 0x21, 0x00]); // ESC ! 0  font A, normal width and height
    out.extend_from_slice(&text_to_bytes(&normalised)); // the receipt itself
    out.extend_from_slice(&[ESC, 0x64, feed_lines]); // ESC d n  feed clear of the tear bar
    if cut {
        out.extend_from_slice(&[GS, 0x56, 0x42, 0x03]); // GS V B n  feed then partial cut
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passes_straight_through() {
        assert_eq!(text_to_bytes("Sale #1001"), b"Sale #1001");
    }

    #[test]
    fn newlines_are_kept_as_they_arrive() {
        assert_eq!(text_to_bytes("a\nb\rc"), b"a\nb\rc");
    }

    #[test]
    fn accents_use_the_printers_own_table() {
        // é is the third entry in the high block, so it is 0x80 + 2.
        assert_eq!(text_to_bytes("é"), vec![0x82]);
        assert_eq!(text_to_bytes("ü"), vec![0x81]);
        // and the extras that live outside it
        assert_eq!(text_to_bytes("°"), vec![0xf8]);
        assert_eq!(text_to_bytes("ß"), vec![0xe1]);
    }

    #[test]
    fn a_combining_accent_is_normalised_before_printing() {
        // "e" followed by U+0301 must print as é, not '?'.
        let decomposed = "Cafe\u{0301}";
        assert_eq!(text_to_bytes(decomposed), b"Caf\x82");
    }

    #[test]
    fn anything_unknown_prints_as_a_question_mark() {
        assert_eq!(text_to_bytes("→"), b"?");
        assert_eq!(text_to_bytes("😀"), b"?");
    }

    #[test]
    fn a_receipt_starts_clean_and_ends_with_a_feed() {
        let bytes = build_receipt("Hello", false);
        assert_eq!(&bytes[0..2], &[ESC, 0x40]);
        assert_eq!(&bytes[2..5], &[ESC, 0x74, 0x00]);
        assert_eq!(&bytes[5..8], &[ESC, 0x21, 0x00]);
        assert_eq!(&bytes[bytes.len() - 3..], &[ESC, 0x64, 4]);
        assert!(!bytes.windows(4).any(|w| w == [GS, 0x56, 0x42, 0x03]));
    }

    #[test]
    fn a_cut_is_only_sent_when_asked_for() {
        let bytes = build_receipt("Hello", true);
        assert_eq!(&bytes[bytes.len() - 4..], &[GS, 0x56, 0x42, 0x03]);
    }

    #[test]
    fn line_endings_are_normalised_and_terminated() {
        let bytes = build_receipt("a\r\nb\rc\nd", false);
        let body_start = 8;
        let body_end = bytes.len() - 3;
        assert_eq!(&bytes[body_start..body_end], b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn an_empty_receipt_is_still_a_well_formed_one() {
        let bytes = build_receipt("", false);
        assert_eq!(&bytes[8..bytes.len() - 3], b"\r\n");
    }
}
