# Infraura Quotation Builder

A self-hosted quotation app for **Sheet Roofing, Interior, Construction and PMC** work.
PHP 8 + MySQL, no build step — runs on Hostinger Cloud / shared hosting.

## Features
- Quote editor with sections and line items, picked from editable **rate cards** per division
- Discount (% or flat), GST, round-off, payment schedule, terms & conditions, notes
- **PMC fee calculator**: % of project cost, per sq ft, or monthly retainer
- **Branded quotation** (logo, GSTIN, bank details, amount in words, signature block) → *Print / Save as PDF*
- **Revisions** (old versions are locked), duplicate quote, status tracking (draft / sent / accepted / rejected)
- Clients book, dashboard (pipeline, win rate, value by division and month), search and filters
- Rate card CSV import / export, multi-user (admin / staff)

## Deploy on Hostinger
1. **hPanel → Databases → MySQL Databases**: create an empty database and user. Note the host (usually `localhost`), name, user, password.
2. **File Manager** (or Git deploy): upload everything in this repo into `public_html` (or a subfolder).
3. Open `https://your-domain/install.php`, enter the database details, company name and your admin login.
4. **Delete `install.php`** from the server when it says "Installed".
5. Sign in. Go to **Settings** and fill in company details, logo, GSTIN, bank details and signatory.
6. Go to **Rate Cards** and replace the starter rates with your real costs.
7. Once SSL is active, uncomment the HTTPS redirect in `.htaccess`.

PHP 8.0+ with `pdo_mysql` is required (default on Hostinger).

## Notes
- The bundled rates, terms and payment schedules are **indicative starting values** — review them before sending quotes to clients.
- PDF is produced by the browser (Print → Save as PDF). Turn off "Headers and footers" in the print dialog.
- Quote numbers look like `INF/RF/26-27/0001` (prefix / division / financial year Apr–Mar / serial). Division codes: RF, IN, CN, PM.
- Back up the database from hPanel regularly.

## Local testing
```
php install.php --sqlite --email=admin@example.com --password=changeme123
php -S 127.0.0.1:8000
```
Open http://127.0.0.1:8000. (SQLite mode is for local testing only; production uses MySQL.)

## Structure
```
index.html            app shell
assets/app.js         core, dashboard, quotes list, clients, rate cards, settings
assets/editor.js      quote editor, PMC calculator, printable quotation
assets/style.css
api/index.php         JSON API
api/lib.php           helpers, totals, quote numbering
api/setup.php         schema + starter data (used by the installer)
install.php           one-time installer (delete after use)
```
