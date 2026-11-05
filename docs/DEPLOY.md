# Deploying and running Infraura Quotation Builder

Works on shared hosting (Hostinger Cloud / Premium / Business) with PHP 8.0+ and MySQL. No build step.

## 1. First install
1. hPanel → **Databases → MySQL Databases**: create an empty database + user. Note host (usually `localhost`), name, user, password.
2. Upload everything in this repo into `public_html` (or a sub-folder). Keep the `.htaccess` files - they protect private files.
3. Open `https://YOUR-DOMAIN/install.php`. It first checks the server (PHP version, extensions, writable folders) and tells you what to fix; then enter the database details, company name and your admin login.
4. That is all: the installer **deletes itself**, and switches the HTTPS redirect on automatically if you opened it over `https://` (turn on SSL in hPanel first, then open the installer over https).
5. Sign in. The dashboard shows a **"Finish setting up" checklist** (company details, rates, e-mail, 2-step sign-in, HTTPS, backups) that ticks itself off as you go. Fill in Settings (GSTIN, bank details, terms, payment schedules, HSN/SAC) and replace the starter rates **and costs** in **Rate Cards**.

## 2. Security set-up (10 minutes - do this before real use)
- **Turn on two-step sign-in** for every admin: Settings → My account & security. Save the recovery codes somewhere safe.
- Add staff with the **Staff** role (they cannot edit rates, settings, tokens or see the audit log, and cannot cancel invoices or issue credit notes).
- Keep AI tokens read-only unless a person reviews every draft (see [MCP.md](MCP.md)); leave "show costs" off for anything that may talk to clients.
- If your host runs **nginx** (not Apache/LiteSpeed), `.htaccess` is ignored: block `/api/data/`, `/tests/` and `/docs/` in the server config. Hostinger uses LiteSpeed, which honours `.htaccess`.

## 3. E-mail (quotes to clients, password resets, reminders)
Settings → **E-mail**. For a Hostinger mailbox: server `smtp.hostinger.com`, port `465`, encryption `SSL`, user = the full mailbox address, password = its password, "From" = the same address. Click **Send test e-mail**. Without SMTP the app falls back to PHP `mail()`, which often lands in spam.

## 4. Scheduled jobs and backups (automatic; cron optional)
The app **runs its own jobs** (daily backup, daily summary e-mail, client reminders, clean-up) in the background whenever someone is signed in - no set-up needed. A cron job is optional but recommended, so they also run on days nobody opens the app. Settings → **System health, backups & scheduled jobs** shows the exact command. In hPanel → **Advanced → Cron Jobs** add it to run **once a day**, e.g.:

```
/usr/bin/php /home/USER/domains/YOUR-DOMAIN/public_html/api/cron.php
```
It: saves a compressed backup (keeps the newest 14; Settings → backups to download), e-mails admins a daily summary (stale quotes, overdue payments, AMC renewals, quotes about to expire, errors), optionally e-mails clients polite reminders after 3 and 7 days (off by default - Settings → E-mail), and cleans up old data. Backups live in `api/data/backups` (private). **Also download one occasionally and keep it off the server**, and enable Hostinger's own automatic backups.

## 5. Monitoring
Point a free uptime monitor (UptimeRobot, Better Stack…) at `https://YOUR-DOMAIN/api/health.php` (200 = app and database healthy). Settings shows the last cron run and recent errors; admins also get errors in the daily e-mail.

## 5b. What runs by itself
| Event | What happens automatically |
|---|---|
| Client opens a quote link for the first time | You (all admins + the quote's creator) get an e-mail |
| Client accepts | You get an e-mail, the client gets a thank-you confirmation, and a **project with the payment-schedule milestones is created** |
| Client declines | You get an e-mail |
| Every day | Backup, daily summary, polite client reminders (if on) |
| A payment is overdue | Optional: up to 3 polite e-mails to the client, a week apart (Settings → E-mail → *Chase overdue payments*) |

Each of these can be switched off in **Settings → E-mail** (they need working e-mail to send messages; the project is created either way).

### Quoting in one step
Dashboard → **⚡ Quick quote**: choose the service, pick (or type) the client, give a few details and press *Create quote*. Tick *E-mail it to the client right away* to send it too. The draft is fully priced from your rate cards, with scope, payment schedule and terms from Settings; open it afterwards to tweak anything.

| Service | You enter | The app adds |
|---|---|---|
| Roofing | length × width, roof type, material(s), frame/gutters yes-no | roof geometry, sheets, frame, purlins, flashings, gutters, screws, ventilators |
| Interior | BHK (and carpet area if known), Standard and/or Premium | kitchen, wardrobes, TV unit, false ceiling, paint, electrical points |
| Construction | built-up area, floors, Grey / Standard / Premium finish | turnkey cost, waterproofing, design, approvals, testing, insurance |
| PMC | project cost (or area), months, Full or Part scope | fee by cost band (3% / 2.5% / 2%), site engineer & QS, quality and safety audits, handover |

**More accurate options.** *Interior → "Measure room by room"*: list each room (living, bedroom, kitchen, bathroom, dining, study, pooja, balcony, utility) with length × width; the quote then has one section per room, with wardrobes sized from the room, ceiling and paint areas from the dimensions (walls = perimeter × height minus door/window openings), kitchen run from the two walls, bathroom waterproofing and fittings, and electrical points by area. *Construction → "Detailed bill of quantities"*: itemised earthwork, footings, columns, beams and slabs (concrete), steel (about 4 kg/sq ft), shuttering, masonry, plaster, flooring, doors and windows, electrical and plumbing, painting, plus overhead (12%) and contingency (5%). Quantities come from standard thumb rules for RCC-framed buildings (about 0.045 m³ concrete per sq ft, footprint = area ÷ floors) and the quote says they are estimates to be confirmed against drawings or site measurement.

Pick several finishes/materials/scopes and the client gets **one quote with options** to choose from. Because prices are read from the rate cards, updating a rate changes every future quick quote. The same engine serves AI assistants (`create_quick_quote`, see [MCP.md](MCP.md)).

## 6. Connect AI assistants
Settings → **AI assistants (MCP)**. Claude.ai: *Settings → Connectors → Add custom connector →* paste the server address, then sign in here and press Allow. Claude Code / Desktop / Cursor / VS Code: create a token and use the ready-made snippet. Details: [MCP.md](MCP.md).

## 6b. Automatic deploys from GitHub (optional)
`.github/workflows/deploy.yml` uploads the app to Hostinger **every time the tests pass on `main`**, runs the database upgrade, and smoke-tests the live site (it fails loudly if the health check or file protection is wrong). It never uploads or overwrites `api/config.php`, `api/data/` (your database and backups), or `install.php`. Set it up once:
1. hPanel → **Files → FTP Accounts**: create an FTP account whose folder is your site folder (e.g. `public_html`). Note the host (e.g. `ftp.yourdomain.com`), user and password.
2. GitHub → repository **Settings → Secrets and variables → Actions → New repository secret**: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `SITE_URL` (e.g. `https://yourdomain.com`). Optional: `CRON_KEY` (Settings → System health in the app; lets the deploy run upgrades immediately), `FTP_DIR` (default `./`), `FTP_PROTOCOL` (`ftps` default; `ftp` if your host needs it).
3. First install only: GitHub → **Actions → deploy → Run workflow** with *include install.php* ticked, then open `https://YOUR-DOMAIN/install.php` as in section 1. From then on, every merge to `main` deploys itself.
Until the secrets exist the workflow does nothing (it only prints a notice).

## 7. Upgrading
With automatic deploys (6b) just merge to `main`. By hand:
1. Settings → **Back up now**, and download the backup.
2. Upload the new files over the old ones (do not delete `api/config.php` or `api/data/`).
3. Sign in once as admin. The database upgrades itself (`api/migrate.php`); check Settings → System health.

## 8. Privacy requests
Clients page → **Export data** (everything held about the client, as JSON) and **Erase data**. Erasing removes contact details; if the client has accepted quotes or invoices their name, address and GSTIN are kept because tax law requires invoices to be retained. Every export and erasure is in the audit log.

## 9. Troubleshooting
| Symptom | Fix |
|---|---|
| Site shows a **500** error right after upload | A `.htaccess` line is not supported by the host. Rename `.htaccess` (root, then `api/.htaccess`) to find the culprit and ask support to enable `mod_rewrite` / `mod_headers`; keep `api/.htaccess` working - it protects internals. |
| AI client gets **401** with a correct token | The `Authorization` header is stripped. `api/.htaccess` forwards it; check the file was uploaded and `mod_rewrite` is on. |
| "Daily summary" never arrives | Settings → System health: is the cron job running? Is e-mail configured (send a test)? |
| "Too many attempts" when signing in | Lockout after 5 wrong passwords; it clears after 15 minutes. An admin can reset a password in Settings → Team. |
| Admin locked out (lost phone + codes) | Another admin: Settings → Team → *Turn off 2-step*. If you are the only admin, edit the `users` table: `UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE email='you@…';`. |
| Page looks old after an upgrade | Hard-refresh (Ctrl+F5). Assets are versioned (`?v=`) so this is rare. |

## 10. What this app does not do
It does not file GST returns, generate e-invoice IRNs (paste them from the portal; they print on the invoice), or give a legally certified e-signature (the client's typed name, drawn signature, time and IP address are recorded as evidence of acceptance). Have your CA confirm the GST/HSN setup and invoice format.
