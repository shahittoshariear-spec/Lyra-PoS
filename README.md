# Lyra PoS

> ## A note on the name
>
> **Lyra PoS is the same app as *End PoS* (formerly *Immaculate POS*) by
> Shariear's Software (S.S.), rebuilt in Rust.** The rebuild was asked for by its
> author, and the rename from *End PoS* to *Lyra PoS* came with it. Everything
> else is deliberately unchanged:
>
> 1. **The S.S. / “Shariear's Software” credit** still shows on the splash screen
>    and in the app window.
> 2. **The app icon** is the same blue/ocean-cyan wave mark (`icons/`).
> 3. **Versions still move in single `0.01` steps** — this build is `v1.8.2`,
>    the version it was rebuilt from. No jumping to `v1.9` or `v2.0`.
> 4. **Your shop's data carries over.** See "Where the data lives" below.
>
> If you fork it, please leave 1–4 alone. Everything else — shop name, address,
> prices, categories, receipts — is yours to change in **Setup**.

> ## Built on Rust from here on
>
> From this version, Lyra PoS is built in Rust rather than on Electron. Nothing
> in the shop changes — same screens, same data file, same receipts — but it is
> built for **performance**, **consistency** and **security**:
>
> - **Performance.** No browser engine is bundled and no Node.js runs behind the
>   screens. The window is the system's own webview, every machine-facing job
>   (files, backups, printing, spreadsheets) is compiled Rust, and the app is a
>   single ~10 MB executable instead of a folder of hundreds.
> - **Consistency.** One binary that behaves the same on every machine, with the
>   data file written atomically, so an interrupted save can never leave a
>   half-written file behind. It always opens: a file it cannot read is set aside
>   rather than being a reason to fail.
> - **Security.** The screens can reach exactly the eleven commands the app
>   defines, and nothing else. There is no remote content, no network access at
>   all, and no scripting bridge into the operating system.
>
> Your data comes with you — see "Where the data lives" below.

A simple, offline point-of-sale app for a small shop. No internet connection is
needed once it's installed. All data (products, stock, sales) is saved to a file
on the computer it runs on.

It is built in two halves: the screens are plain HTML, CSS and JavaScript, and
everything that touches the machine — the data file, backups, spreadsheet
imports, and printing — is Rust, behind [Tauri](https://tauri.app). On Windows
the window is rendered by the WebView2 runtime that ships with Windows 10 and 11,
so there is no browser to install and no Node.js to install.

## What it does

- **Till** — search, tap, or scan a barcode to build a sale; hold a sale to
  serve another customer and resume it later; take cash or card payment
  with automatic change calculation; print or save a receipt. In the payment
  dialog, Enter completes the sale — type what the customer handed over and
  press Enter, and the change is worked out for you. Pressing Enter twice in a
  hurry still records the sale once.
- **Barcode scanning** — plug in any USB or Bluetooth barcode scanner (the
  cheap kind that "types" like a keyboard). Scan a product at the till to add
  it straight to the cart; scan while adding/editing a product to fill in its
  SKU. No setup needed — it just works alongside typing and searching. A scan
  ends with Enter, and the box empties itself as soon as the item goes into the
  sale, ready for the next one. Pressing Enter in that box also adds whatever
  you typed (a search name, say), so you never have to reach for the mouse.
- **Search names** — the product form used to offer a **Search name or code**
  field: a short code of your own, like "mp" for Puppy Food, that the Till and
  Stock match alongside the product's name and SKU. The form no longer asks for
  one, so nothing sets one now, but a product that already carries a search name
  still matches on it.
- **Categories** — add them in Setup → Categories and remove one with the ✕.
  Deleting a category that products are filed under asks which category those
  products should move to, so nothing is ever left pointing at a category that
  no longer exists. The last remaining category can't be deleted, and a
  duplicate name is refused.
- **Client mode & Admin Key** — the app always opens in Client mode: whoever's
  at the till can ring up sales, scan, hold/resume, take payment, work the
  Stock list (including adding, editing and deleting products), and use the
  Ledger — looking sales up, reprinting receipts, and issuing full or partial
  refunds. Overview, Reports and Setup are locked outright. Entering the Admin
  Key unlocks everything for that session; tap "Lock" any time to drop back to
  Client mode. Set the key the first time you open the app.
- **Refunds** — open any past sale from the Ledger and refund
  the whole sale or just some items, choosing how many of each go back. Stock
  returns to the shelf automatically, and the refund is stored as its own
  record, so the Ledger, the day's totals and every report net it off. Part of
  a sale can be refunded now and the rest later, until nothing is left on it,
  and the refund receipt is shown ready to print.
- **Stock** — add, edit, and delete products (name, SKU/barcode, category,
  price, cost, quantity on hand). Opening Stock puts the caret straight into the
  filter box, so a product can be typed or scanned without clicking first, and a
  left arrow with the cursor already at the start of that box clears the filter.
  The keyboard comes back to that box when a product is added, edited or
  deleted, so the next search can be typed straight away.
- **Ledger** — every past sale and refund, filterable by date, with a
  reprintable receipt. Each row has **Reprint** to print a copy without opening
  anything, and **View** to see the receipt — reprint it, or refund items from
  it. Refund rows name the sale they came from ("Refund #1002 of #1001").
- **Built for a long catalogue** — the Till stays quick with thousands of
  products: it draws the first 120 matches, and typing in the search box
  narrows the list instantly. Stock and Ledger tables are drawn in one pass.
- **Overview** — Day / Week / Month / Year tabs, each showing sales, profit,
  transactions, items sold, top sellers, a cash/card payment split, and a
  matching sales history table (previous days, weeks, months, or years) that
  splits each line's sales into cash and card the same way, so trends are easy
  to spot at any zoom level. Low-stock warnings, and the two inventory value
  figures — what the shelf is worth at cost and at sell — are always current
  regardless of the tab selected, and carry a comma every three digits, so a
  big number can be counted at a glance.
- **Clearing out stock** — the Overview's low-stock list deletes as well as
  reports: **Delete** on a line removes that product, or tick several and use
  **Delete selected**. Both ask before anything goes, and neither touches sales
  already recorded. Each line also shows the product's barcode beside Delete,
  ready to read out or copy when reordering.
- **Profit** is sales minus cost of goods sold, using each product's Cost
  field at the time of sale. If Profit ever looks identical to Sales for a
  period, it means the products sold in that period have no Cost set —
  Stock flags any product with a R0.00 cost so it's easy to spot and fix.
- **Today's totals on the Till screen** — a summary bar (total sale, cash,
  card) sits at the top of the Till screen itself, visible even in Client
  mode. A cashier without the Admin Key can screenshot it and send it over
  without needing access to Overview.
- **Setup** — shop name/address/phone (shown on receipts), currency symbol,
  tax rate, low-stock threshold, categories, Admin Key management, backup
  export/import, and bulk product import.
- **Import products from POS Maid (or any spreadsheet)** — bring in a
  product list exported from POS Maid's Excel/CSV export, or any spreadsheet
  with name/SKU/price/stock columns. Lyra PoS guesses which column is which
  and lets you fix the mapping before importing; existing products are
  matched and updated by SKU, everything else is added new. See "Importing a
  product list" below.
- **Reset data** — in Setup's Danger Zone, reset just sales & stock (clears
  the Ledger, Overview history, and held sales, and zeroes every product's
  stock, but keeps products/prices/categories/settings) or reset everything
  back to a blank install. Both require the Admin Key again to confirm, even
  if you're already unlocked — see "Resetting data" below.

There are no discounts in this build — just straightforward pricing plus tax.
Everything else runs locally: there's no login over a network, no cloud sync,
and no network calls — it works with wifi off.

## Importing a product list

If the shop has been using POS Maid, it has a built-in **Import/Export Data
to Excel** feature for inventory — that's the easiest way to bring hundreds
of products across without re-scanning them all:

1. In POS Maid, export the product/inventory list to Excel (or save it as
   CSV if that's offered).
2. In Lyra PoS, go to **Setup → Import products → Import from Excel /
   CSV…** and pick that file.
3. Lyra PoS shows you the columns it found and its best guess at matching
   them to Name, SKU/barcode, Category, Price, Cost, and Stock — check the
   preview table and fix any dropdown that guessed wrong.
4. Click **Import products**. Anything with a SKU that already exists gets
   updated; everything else is added as new. Categories from the file are
   created automatically.

This also works for a plain CSV/Excel export from almost any other POS or
even a hand-built spreadsheet — it doesn't have to come from POS Maid
specifically, as long as it has columns for at least a name and a price.

The `.xlsx`, `.xls`, `.xlsb`, `.ods` and `.csv` formats are all read.

## Resetting data

Setup → Danger Zone has two options, both permanent and both requiring the
Admin Key to be entered again as a confirmation step — even in the same
session where you're already unlocked, so a stray click can't wipe anything
by accident:

- **Reset sales & stock** — clears the Ledger, every Overview history entry,
  and any held sales, and sets every product's stock count to 0. Product
  names, prices, costs, categories, and shop settings are all kept, so this
  is meant for "we're doing a fresh physical stock count" or "wipe our test
  data before going live" without having to re-enter the whole catalog.
- **Reset all data** — wipes everything back to a blank install: products,
  sales, categories, settings, and the Admin Key itself. Immediately after,
  the app will ask you to set a new Admin Key, exactly like a first run.

Neither of these touches backup files you've already exported, so exporting
a backup first (Setup → Backup → Export backup…) is a good habit before
using either.

## Running it

You'll need [Rust](https://rustup.rs) (the stable toolchain). Then, from this
folder:

```bash
cargo run
```

The first run compiles everything, which takes a few minutes; after that it is
quick. That opens the app in its own window.

On Windows you also need the **WebView2 runtime**, which is preinstalled on
Windows 10 and 11. On a machine that hasn't got it, the installer below will
offer to fetch it.

## Building an installer (a double-click app icon instead of the command line)

```bash
cargo install tauri-cli --version "^2"
cargo tauri build
```

This creates an installer in `target/release/bundle/`:

- Windows → an `.exe` installer (NSIS) and an `.msi`
- macOS → a `.dmg`
- Linux → a `.deb` and an `.AppImage`

Build it on the same type of computer it will run on (build the Windows
installer on Windows, etc.) unless you set up cross-building separately. The
app's icon (`icons/icon.ico` / `.icns` / `.png`) is already wired up in
`tauri.conf.json`, so the installer and the installed app carry it
automatically — nothing extra to configure.

## Where the data lives

The app stores everything in a single `lyra-pos-data.json` file in the
computer's standard app-data folder (on Windows,
`%APPDATA%\Lyra PoS\lyra-pos-data.json`). Use **Setup → Backup →
Export backup…** regularly, especially before reinstalling Windows or moving
to a new computer — copy the exported file somewhere safe (a USB drive or
cloud folder). **Import backup…** restores from that file. The Admin Key is
stored as a one-way hash in that same file — nobody, including you, can look
it up from the file itself, so if it's forgotten there's no built-in
recovery short of restoring an older backup, using Setup → Danger Zone →
Reset all data, or editing the data file by hand.

**Upgrading keeps your data.** Renaming the app moves its data folder, which
would otherwise hide an existing shop's data, so the first time it runs without
finding a data file of its own it looks for one left by an earlier name — first
`%APPDATA%\End PoS\end-pos-data.json`, then the `Immaculate POS` folders — and
copies the first valid one into place. An existing data file is never
overwritten by this, and an unreadable old file is skipped rather than guessed
at.

Two details worth knowing if you go looking at that file:

- It is written to a temporary file and then moved into place, so a crash or a
  full disk part-way through a save can never leave a half-written data file
  behind — the previous good one survives until the new one is whole.
- If the file is ever unreadable, it is renamed to
  `lyra-pos-data.json.bak-<timestamp>` and a fresh one is started, rather than
  the app refusing to open. Nothing is silently deleted, so a damaged file can
  still be repaired by hand.

The Admin Key hash is computed by the same SHA-256 the app has always used, so a
key set in *End PoS* or *Immaculate POS* unlocks *Lyra PoS* unchanged.

## Printing receipts

Choose **Setup → Receipt printer** and pick your thermal printer, then click
**Test print** to check it. From then on, **Print receipt** goes straight to
that printer when the sale completes — no dialog. Cutting the paper is off by
default; tick **Cut the paper after each receipt** once you have seen a cut
work on your printer, because a printer that errors on a cut refuses every
receipt after it. Receipts are laid out 32 columns wide, which suits 80 mm
paper.

The receipt text is sent to the printer directly as ESC/POS rather than being
rendered by the printer's Windows driver. That is deliberate: it is faster and
sharper than printing a rendered page, and it means the app still works with
printers whose Windows driver cannot actually drive them. The usual culprit is
a USB-to-parallel adapter cable, where Epson's Advanced Printer Driver accepts
the job and then prints nothing at all. Because the text goes straight to the
printer, all that matters is that the printer exists as a Windows printer
queue — which driver is attached to it makes no difference.

Leave the dropdown on **Ask me each time** to keep the normal print dialog —
handy for saving a receipt as a PDF, or when no thermal printer is connected.
That dialog is the system's own, so it also offers **Microsoft Print to PDF**.
Either way every receipt is saved in the Ledger and can be reprinted later.

### If receipts don't print

- Check the printer shows up as ready — not paused or offline — under Windows
  → Settings → Bluetooth & devices → Printers & scanners.
- Use **Setup → Test print**. If the printer does not take the receipt, the
  app says so rather than reporting a receipt that never came out, and it
  clears the stuck job so the next attempt is not queued behind it.
- The printer must be switched on and have paper; a job sent to a printer that
  is not responding is reported as such rather than failing silently.
- Only plain text and the accented characters listed at the top of
  `src/escpos.rs` can be printed. Anything else prints as `?` — extend that
  table if your shop name needs more.

## What's not in this build

POS Maid is a large, decades-old program with features built up over years
(time clock/payroll, layaway, gift/credit card processing, appointments and
scheduling, mailing lists, barcode label printing, multi-currency). This app
focuses on the core a small shop actually uses day to day: fast checkout,
barcode scanning, stock, sales history, refunds, and an Admin Key to keep
Setup and reports away from whoever's on the till. If a bigger feature turns
out to be needed later, it's worth asking for it specifically so it can be
built to match how the shop actually works.

## Customizing for the shop

Open **Setup** first and fill in the shop name, address, phone, currency
symbol, and tax rate — these appear on every receipt. Then go to **Stock**
and add the products the shop actually sells (categories can be added from
Setup → Categories before or as you go).

## Who can see what in Client mode

Locking the app keeps the shop's paperwork to yourself without stopping whoever
is on the till from doing their job.

| | Client mode | Unlocked |
|---|---|---|
| Till — ring up, scan, hold, take payment | yes | yes |
| Today's totals bar on the Till screen | yes | yes |
| Stock — look up, filter, check what's left | yes | yes |
| Stock — add, edit or delete a product | yes | yes |
| Ledger — look up a sale, reprint a receipt | yes | yes |
| Ledger — refund a sale, whole or partial | yes | yes |
| Overview, Reports, Setup | asks for the key | yes |
| Reset sales & stock / Reset all data | asks for the key twice | asks for the key twice |

So the key keeps your takings reports and your shop settings away from the till,
not the day-to-day work: staff can still serve, correct stock, and put a refund
through. The padlock icons next to Overview, Reports and Setup show what's shut.

The two Danger Zone resets in Setup are the exception — they ask for the key
again even when you're already unlocked, so a stray click can't wipe anything.

If you would rather staff could *not* change stock or issue refunds without you,
say so: refunds are gated in `canRefundSale` and stock changes would be gated by
re-adding the check at the Stock entry points, both in `ui/app.js`.

Choosing a locked view raises the Admin Key prompt and then opens the view you
asked for, so nothing is more than one password away. The list of locked views
is `PROTECTED_VIEWS` in `ui/app.js`.

## Scanning barcodes

The barcode box at the top of the Till screen takes the scanner's keystrokes,
by scan. You do not have to click it first: the app listens for the keystrokes
as a scanner sends them, and hands the keyboard back to the box after a sale,
after closing any pop-up, and after each scan. So a scan straight after taking
payment lands in the box rather than in the amount-tendered field.

A scan is any short burst of characters ending in Enter, in the box or not. The
code is matched against SKU/barcode first, then against name and search name —
and only adds the item when the match is a single one, so a half-typed word can
never put the wrong thing in the sale. The box empties itself after every scan,
including one that fails, so the next scan never gets stuck onto the front of
the last one.

While the payment dialog is open, Enter completes the sale instead — it is never
read as a scan there, so a code left in the box cannot add an item to a sale that
is being paid for.

A code that matches nothing stays on screen, selected, so you can read it — and
the next scan replaces it rather than adding to it.

If scanning is unreliable, the usual culprit is the scanner's own settings, not
the app: it has to send **Enter** (sometimes labelled CR, or "suffix: Enter") at
the end of each code. A scanner set to send **Tab** instead will never trigger a
scan. Most scanners ship with Enter as the default, but if yours doesn't, the
manual's barcode for "CR suffix" or "Enter suffix" fixes it. You can also slow a
scanner down if it's typing too fast for the till; the app copes with gaps up to
150ms between characters.

## What's where

| Path | What's in it |
|---|---|
| `ui/` | The screens: `index.html`, `styles.css`, `app.js`, `bridge.js` |
| `src/main.rs` | The commands the screens can call, and the window setup |
| `src/data.rs` | The shape of the saved data, and reading/writing it |
| `src/escpos.rs` | Turning a receipt's text into the bytes a thermal printer wants |
| `src/printing.rs` | Listing printers, and sending a receipt to one |
| `src/import.rs` | Reading a product list, and guessing which column is which |
| `src/bridge.js` | The one place the screens talk to the machine |

Everything a shop actually sees is in `ui/`. The Rust half deliberately holds no
prices, no totals and no receipt layout — it moves bytes and files, and the
arithmetic stays where it can be read alongside the screen that shows it.

## Checking your changes

```bash
cargo test
```

This runs the tests for the Rust half — the data file (including that a file
written by an older version still loads, and that a return round-trips as
`"type":"return"`), the ESC/POS builder (accents, line endings, the cut, and
that a combining accent prints as `é` rather than `?`), and the column-matching
for spreadsheet imports (including that a "SupplyPrice" column becomes Cost
rather than Price). It exits non-zero if anything fails, so it is safe to use as
a build gate.

The shop's own arithmetic — totals, tax, refund apportioning, period buckets and
the receipt layout — lives in `ui/app.js`, and the earlier build drove that with
a scripted smoke test (`npm run smoke`, 123 checks) that clicked through the real
screens in a hidden window. That harness was built on Electron and does not carry
over as it stands. Two ways to get it back, if you want one of them:

- **Run the real screens in a headless browser.** Serve `ui/` over HTTP, stub
  `window.pos` with an in-memory data object, and drive the screens with
  Playwright. This is closest to the old smoke test and would keep checking the
  DOM, the animations and the click paths as well as the arithmetic.
- **Move the arithmetic into its own file.** Lift the pure functions — `money`,
  `cartTotals`, `receiptText`, `computePeriodTotals`, `refundSelectionTotals` —
  into something like `ui/core.js` and test them directly with Node. Cheaper,
  and it covers the numbers, but not the screens.

## Long lists

A shop can hold thousands of products and years of sales, so the Till draws only
the first 120 matching products (typing narrows them), and the Stock and Ledger
tables draw a page of 500 rows at a time with a **Show more** button. Searching,
picking a category, or **Select all** still covers every matching record, not
just the rows on screen.

Two things the rebuild tightened up here:

- Product cards only play their entrance animation when the list of products
  actually changes. Before, every redraw restarted the animation on all 120
  cards, so adding an item to a sale made the whole grid flicker.
- The Till's search box and the Stock filter each keep their own debounce, so
  typing stays responsive while the list is redrawn behind it.
