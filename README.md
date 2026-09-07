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
  SKU. No setup needed — it just works alongside typing and searching.
- **Client mode & Admin Key** — the app always opens in Client mode: whoever's
  at the till can ring up sales, scan, hold/resume, and take payment, but
  Stock, Ledger, Overview, and Setup are locked. Entering the Admin Key
  unlocks them for that session; tap "Lock" any time to drop back to Client
  mode. Set the key the first time you open the app.
- **Refunds** — open any past sale from the Ledger (while unlocked) and issue
  a full refund; stock is put back automatically and the refund shows as its
  own entry in the Ledger.
- **Stock** — add, edit, and delete products (name, SKU/barcode, category,
  price, cost, quantity on hand).
- **Ledger** — every past sale and refund, filterable by date, with a
  reprintable receipt.
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

When a sale completes, click **Print receipt** to open the normal print
dialog — pick a real receipt/thermal printer if one's connected, or "Save as
PDF" if not. If there's no printer yet, the receipt is still saved in the
Ledger and can be reprinted any time.

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
