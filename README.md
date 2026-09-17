# Immaculate POS

A simple, offline point-of-sale app for a small shop — built with Electron.
No internet connection needed once it's installed. All data (products, stock,
sales) is saved to a file on the computer it runs on.

## What it does

- **Till** — search, tap, or scan a barcode to build a sale; hold a sale to
  serve another customer and resume it later; take cash/card/other payment
  with automatic change calculation; print or save a receipt.
- **Barcode scanning** — plug in any USB or Bluetooth barcode scanner (the
  cheap kind that "types" like a keyboard). Scan a product at the till to add
  it straight to the cart; scan while adding/editing a product to fill in its
  SKU. No setup needed — it just works alongside typing and searching. A scan
  ends with Enter, and the box empties itself as soon as the item goes into the
  sale, ready for the next one. Pressing Enter in that box also adds whatever
  you typed (a search name, say), so you never have to reach for the mouse.
- **Search names** — give a product a short name of your own and typing that
  brings it up: "mp" for Puppy Food, "bre1" for Breeders 1kg. Set it in the
  product editor (Stock → open the product → **Search name or code**). The Till
  and Stock both match it alongside the product's name and SKU, and adding an
  item to a sale clears the search box, ready for the next one.
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
  price, cost, quantity on hand).
- **Ledger** — every past sale and refund, filterable by date, with a
  reprintable receipt. Each row has **Reprint** to print a copy without opening
  anything, and **View** to see the receipt — reprint it, or refund items from
  it. Refund rows name the sale they came from ("Refund #1002 of #1001").
- **Built for a long catalogue** — the Till stays quick with thousands of
  products: it draws the first 120 matches, and typing in the search box
  narrows the list instantly. Stock and Ledger tables are drawn in one pass.
- **Overview** — Day / Week / Month / Year tabs, each showing sales, profit,
  transactions, items sold, top sellers, a cash/card payment split, and a
  matching sales history table (previous days, weeks, months, or years) so
  trends are easy to spot at any zoom level. Low-stock warnings are always
  current regardless of the tab selected.
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
  with name/SKU/price/stock columns. Immaculate guesses which column is which
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
2. In Immaculate POS, go to **Setup → Import products → Import from Excel /
   CSV…** and pick that file.
3. Immaculate shows you the columns it found and its best guess at matching
   them to Name, SKU/barcode, Category, Price, Cost, and Stock — check the
   preview table and fix any dropdown that guessed wrong.
4. Click **Import products**. Anything with a SKU that already exists gets
   updated; everything else is added as new. Categories from the file are
   created automatically.

This also works for a plain CSV/Excel export from almost any other POS or
even a hand-built spreadsheet — it doesn't have to come from POS Maid
specifically, as long as it has columns for at least a name and a price.

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

You'll need [Node.js](https://nodejs.org) installed (the free "LTS" version
is fine). Then, from this folder:

```bash
npm install
npm start
```

That opens the app in its own window.

## Building an installer (a double-click app icon instead of the command line)

```bash
npm install
npm run dist
```

This creates an installer in the `release/` folder:
- Windows → an `.exe` installer
- macOS → a `.dmg`
- Linux → an `.AppImage`

Build it on the same type of computer it will run on (build the Windows
installer on Windows, etc.) unless you set up cross-building separately. The
app's icon (`build/icon.ico` / `.icns` / `.png`) is already wired up in
`package.json`, so the installer and the installed app will carry it
automatically — nothing extra to configure.

## Where the data lives

The app stores everything in a single `immaculate-pos-data.json` file in the
computer's standard app-data folder (e.g. on Windows,
`%APPDATA%\Immaculate POS\immaculate-pos-data.json`). Use **Setup → Backup →
Export backup…** regularly, especially before reinstalling Windows or moving
to a new computer — copy the exported file somewhere safe (a USB drive or
cloud folder). **Import backup…** restores from that file. The Admin Key is
stored as a one-way hash in that same file — nobody, including you, can look
it up from the file itself, so if it's forgotten there's no built-in
recovery short of restoring an older backup, using Setup → Danger Zone →
Reset all data, or editing the data file by hand.

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
  `escpos.js` can be printed. Anything else prints as `?` — extend that table
  if your shop name needs more.

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
re-adding the check at the Stock entry points, both in `src/app.js`.

Choosing a locked view raises the Admin Key prompt and then opens the view you
asked for, so nothing is more than one password away. The list of locked views
is `PROTECTED_VIEWS` in `src/app.js`.

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

A code that matches nothing stays on screen, selected, so you can read it — and
the next scan replaces it rather than adding to it.

If scanning is unreliable, the usual culprit is the scanner's own settings, not
the app: it has to send **Enter** (sometimes labelled CR, or "suffix: Enter") at
the end of each code. A scanner set to send **Tab** instead will never trigger a
scan. Most scanners ship with Enter as the default, but if yours doesn't, the
manual's barcode for "CR suffix" or "Enter suffix" fixes it. You can also slow a
scanner down if it's typing too fast for the till; the app copes with gaps up to
150ms between characters.

## Checking your changes

`npm run smoke` opens the app's own screens in a hidden window and drives them
by clicking: ring up a sale, reprint it from the Ledger, refund a single line of
it, then refund the rest. It checks the saved sales, stock levels, till totals
and receipt text as it goes, printing a pass/fail line for each — 86 checks at
the time of writing. It runs against its own throwaway data held in memory, so
your shop's data file is never touched.

Run it before building an installer, or after changing anything to do with the
Till, the Ledger, refunds or receipts. It exits non-zero if anything fails, so
it is safe to use as a build gate.

`npm run bench` measures how long the slow parts take on the machine it runs on,
using a made-up shop of 2448 products and 62 sales (set `BENCH_PRODUCTS` and
`BENCH_SALES` to try other sizes). Run it before and after a performance change
so the numbers are comparable, and only compare runs made one after the other —
a busy machine can double every number in the list.

Two things worth knowing when reading the results. A view switch is timed from
the click until the browser has laid the new screen out, because the app's
renders are synchronous but the browser lays out lazily; a measurement that
skips the forced layout counts only the JavaScript and quietly charges the
layout to whatever runs next. And each switch is measured four times, keeping
the best, so one slow moment can't decide the number.

## Long lists

A shop can hold thousands of products, and every row in the page is another row
the browser has to lay out. So the Stock table and the Ledger draw the first 500
rows and put a **Show more** button at the bottom of the list, rather than
drawing everything at once. Nothing is out of reach: "Show more" reveals the
next 500, searching filters the whole list, and *Select all* still means every
matching product. The cap is `MAX_STOCK_ROWS` / `MAX_LEDGER_ROWS` in
`src/app.js` if the numbers ever need changing.
