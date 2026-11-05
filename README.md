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
4. The installer checks the server, then **deletes itself** and switches on the HTTPS redirect (if opened over https). A "Finish setting up" checklist on the dashboard covers the rest.
5. Sign in. Go to **Settings** and fill in company details, logo, GSTIN, bank details and signatory.
6. Go to **Rate Cards** and replace the starter rates with your real costs.
7. Once SSL is active, uncomment the HTTPS redirect in `.htaccess`.

PHP 8.0+ with `pdo_mysql` is required (default on Hostinger).

## Selling, billing & operations features
- **Roofing calculator** - roof area, slope, wastage, steel, flashings, gutters, fasteners; compares GI / UPVC / PUF / aluminium and more side by side.
- **Options** - Good / Better / Best packages on one quote; the grand total follows the selected option.
- **Client link** - private link (or e-mail from the app): the client views, picks an option, e-signs and accepts or declines; links expire; accepted quotes lock.
- **Margin tracking**, quote **templates**, CGST/SGST vs IGST, HSN/SAC, **regional-language labels** (Hindi, Tamil, Telugu, Kannada, Malayalam) on printed quotes.
- **Projects** - milestones, payments with numbered **receipts**, numbered **tax invoices**, **credit notes**, **invoice cancellation** (numbers never reused), IRN/e-invoice reference fields, variation orders, site log **with photos**, **AMC / warranty renewals**.
- **Interior** rooms and photos, **Reports** (win rate, margin, salesperson, lead source, aging, receivables), CSV export.
- **Accounts & security** - two-step sign-in (authenticator app + recovery codes), forgot/reset password by e-mail, admin password reset, last-admin protection, sign-in lockout, roles, rate limits, audit log.
- **E-mail** (SMTP) - quotes to clients, reset links, daily summary, optional client reminders.
- **Automation** - one-step **Quick quote** for Roofing, Interior, Construction and PMC (a few inputs in, priced draft out, optionally e-mailed to the client); the app runs its own backups/summaries/reminders (no cron needed), e-mails you when a client opens/accepts/declines, creates the project on acceptance, chases overdue payments (opt-in), and can auto-deploy from GitHub to Hostinger.
- **Commercial controls** - bulk price change, price levels (metro / tier-2 / town) for quick quotes, side-by-side revision compare, and change orders the client approves online.
- **Operations** - daily jobs (backup, summary e-mail, reminders; optional cron), health endpoint for uptime monitors, error log, system-health card, JSON backup, **privacy tools** (export / erase client data), paginated lists tested at 4,000+ quotes, installable PWA.
- **AI assistants** - built-in MCP server with OAuth: see below.
- Database upgrades run automatically on first admin sign-in after uploading new files (`api/migrate.php`).

## Starter rate cards
New installs get ~490 indicative line items across the four divisions (Sheet Roofing: GI, UPVC, PUF / PIR / rockwool panels, aluminium, polycarbonate, FRP and more, plus structure, fasteners, flashings, gutters, ventilation, skylights, insulation, shutters, site charges and repairs).
Already installed? Open **Rate Cards -> Import CSV** and pick `docs/rate-cards-extended.csv` (it appends; delete duplicates you do not want).
All rates are placeholders - replace them with your real costs.

## Use it from Claude / AI tools (MCP)
The app is an **MCP server** (`api/mcp.php`) with OAuth sign-in: *"provide a roofing quotation for GI sheet, 60x30 ft, A-type"* creates a priced **draft** quote in one step. Assistants can search quotes and rate cards, price roofs and draft quotations - never send, accept, delete, record payments or change settings; an admin approves each connection and chooses the access level. Setup for Claude.ai, Claude Code, Claude Desktop, Cursor and VS Code: [docs/MCP.md](docs/MCP.md).

## Deploying and running it
Step-by-step install, e-mail, cron/backups, monitoring, upgrades, privacy requests and troubleshooting: **[docs/DEPLOY.md](docs/DEPLOY.md)**. Short version: upload, run `install.php` (it removes itself), follow the dashboard checklist (Settings, rates and costs, e-mail, 2-step sign-in), have your CA confirm the GST set-up.

## Tests
```
tests/run.sh            # money-math + roof parity, API, MCP, OAuth, accounts, billing, features, cron, automation, scale (SQLite, throw-away install)
tests/run.sh --e2e      # + Playwright browser tests: XSS in every field, mobile layout, real PDF output, 2FA UI, pagination, accessibility (axe)
MYSQL_DB=... MYSQL_USER=... MYSQL_PASS=... tests/run.sh --e2e     # same against MySQL (empty database)
BASE=http://your-apache-host node tests/apache.test.js            # .htaccess behaviour (blocked internals, rewrites, headers) on real Apache
```
Verified on SQLite, MySQL-8-mode MariaDB and real Apache 2.4 (mod_php). GitHub Actions runs the suite on SQLite and MySQL 8, plus the browser tests (`.github/workflows/tests.yml`).

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
api/lib.php           helpers, money maths, rate limiting, quote numbering
api/core.php          shared business logic (quotes, rates, reports, roof calculator)
api/mcp.php           MCP server for AI assistants
api/oauth.php         OAuth 2.1 server for MCP connectors
api/quick.php         one-step quotes for interior / construction / PMC
api/jobs.php          scheduled jobs + background runner (backup, digest, reminders, notifications)
api/cron.php          optional cron entry point for the same jobs
api/health.php        uptime-monitor endpoint
api/mail.php          SMTP / mail() sender
api/auth.php          TOTP 2FA, recovery codes, shared sign-in check
api/public.php        client share-link endpoint (view / accept / decline)
api/projects.php      projects, milestones, payments, invoices
api/migrate.php       automatic database upgrades
tests/                API, MCP, parity and browser tests
api/setup.php         schema + starter data (used by the installer)
install.php           one-time installer (deletes itself)
```
