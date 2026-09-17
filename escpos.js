'use strict';

// ---------------------------------------------------------------------------
// ESC/POS receipt builder
//
// Receipts in this app are plain 32-column text (see receiptText() in
// src/app.js), which is exactly what a thermal printer wants. Sending that text
// as ESC/POS needs no printer driver at all: the bytes go to the printer
// untouched (see rawprint.js). Compared with rendering the receipt as an image
// it is sharper, far quicker, and it works with printers whose Windows driver
// cannot actually drive them.
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const GS = 0x1d;

// Characters the printer's default PC437 table has that ASCII does not. Index 0
// is code 0x80, so 'é' prints as é (0x82) rather than '?'. Anything below that
// is not listed — and is not plain ASCII — is sent as '?'.
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»';

// A few useful characters that live outside that block.
const CP437_EXTRA = { 'ß': 0xe1, '°': 0xf8, '±': 0xf1 };

function textToBytes(text) {
  const bytes = [];
  // Normalise first, so an accent typed as a separate combining character
  // ("Cafe" + U+0301) prints as é rather than '?'.
  const str = String(text == null ? '' : text).normalize('NFC');
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d) { bytes.push(code); continue; }
    if (code >= 0x20 && code <= 0x7e) { bytes.push(code); continue; }
    const high = CP437_HIGH.indexOf(ch);
    if (high >= 0) { bytes.push(0x80 + high); continue; }
    if (CP437_EXTRA[ch] !== undefined) { bytes.push(CP437_EXTRA[ch]); continue; }
    bytes.push(0x3f); // '?'
  }
  return bytes;
}

// Builds one complete receipt: reset, receipt text, a little feed, then cut.
function buildReceipt(text, options) {
  const opts = options || {};
  const cut = opts.cut !== false;
  const feedLines = Number.isFinite(opts.feedLines) ? opts.feedLines : 4;

  const normalized = String(text == null ? '' : text).replace(/\r\n|\r|\n/g, '\r\n');
  const body = normalized.endsWith('\r\n') ? normalized : normalized + '\r\n';

  const parts = [
    Buffer.from([ESC, 0x40]),                 // ESC @    initialise, so each receipt starts clean
    Buffer.from([ESC, 0x74, 0x00]),           // ESC t 0  character table = PC437
    Buffer.from([ESC, 0x21, 0x00]),           // ESC ! 0  font A, normal width and height
    Buffer.from(textToBytes(body)),           // the receipt itself
    Buffer.from([ESC, 0x64, feedLines])       // ESC d n  feed clear of the tear bar
  ];
  if (cut) parts.push(Buffer.from([GS, 0x56, 0x42, 0x03])); // GS V B n  feed then partial cut

  return Buffer.concat(parts);
}

module.exports = { buildReceipt, textToBytes };
