# Deploying and running Infraura Quotation Builder

Works on shared hosting (Hostinger Cloud / Premium / Business) with PHP 8.0+ and MySQL. No build step.

## 1. First install
1. hPanel → **Databases → MySQL Databases**: create an empty database + user. Note host (usually `localhost`), name, user, password.
2. Upload everything in this repo into `public_html` (or a sub-folder). Keep the `.htaccess` files - they protect private files.
3. Open `https://YOUR-DOMAIN/install.php`, enter the database details, company name and your admin login.
4. **Delete `install.php`** when it says "Installed".
5. Turn on HTTPS (hPanel → SSL) and uncomment the redirect in the root `.htaccess`.
6. Sign in → **Settings** and fill in company details, GSTIN, bank details, terms, payment schedules and HSN/SAC codes. Replace the starter rates **and costs** in **Rate Cards**.

## 2. Security set-up (10 minutes - do this before real use)
- **Turn on two-step sign-in** for every admin: Settings → My account & security. Save the recovery codes somewhere safe.
- Add staff with the **Staff** role (they cannot edit rates, settings, tokens or see the audit log, and cannot cancel invoices or issue credit notes).
- Keep AI tokens read-only unless a person reviews every draft (see [MCP.md](MCP.md)); leave "show costs" off for anything that may talk to clients.
- If your host runs **nginx** (not Apache/LiteSpeed), `.htaccess` is ignored: block `/api/data/`, `/tests/` and `/docs/` in the server config. Hostinger uses LiteSpeed, which honours `.htaccess`.

## 3. E-mail (quotes to clients, password resets, reminders)
Settings → **E-mail**. For a Hostinger mailbox: server `smtp.hostinger.com`, port `465`, encryption `SSL`, user = the full mailbox address, password = its password, "From" = the same address. Click **Send test e-mail**. Without SMTP the app falls back to PHP `mail()`, which often lands in spam.

## 4. Scheduled jobs and backups (cron)
Settings → **System health, backups & scheduled jobs** shows the exact command for your server. In hPanel → **Advanced → Cron Jobs** add it to run **once a day**, e.g.:

```
/usr/bin/php /home/USER/domains/YOUR-DOMAIN/public_html/api/cron.php
```
It: saves a compressed backup (keeps the newest 14; Settings → backups to download), e-mails admins a daily summary (stale quotes, overdue payments, AMC renewals, quotes about to expire, errors), optionally e-mails clients polite reminders after 3 and 7 days (off by default - Settings → E-mail), and cleans up old data. Backups live in `api/data/backups` (private). **Also download one occasionally and keep it off the server**, and enable Hostinger's own automatic backups.

## 5. Monitoring
Point a free uptime monitor (UptimeRobot, Better Stack…) at `https://YOUR-DOMAIN/api/health.php` (200 = app and database healthy). Settings shows the last cron run and recent errors; admins also get errors in the daily e-mail.

## 6. Connect AI assistants
Settings → **AI assistants (MCP)**. Claude.ai: *Settings → Connectors → Add custom connector →* paste the server address, then sign in here and press Allow. Claude Code / Desktop / Cursor / VS Code: create a token and use the ready-made snippet. Details: [MCP.md](MCP.md).

## 7. Upgrading
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
