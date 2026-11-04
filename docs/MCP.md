# Using Infraura with Claude and other AI tools (MCP)

The app includes a built-in **Model Context Protocol (MCP) server**, so AI assistants can look things up and draft quotations for you:

> "Provide a roofing quotation for GI sheet, 60 × 30 ft, A-type." · "Compare GI, UPVC and PUF for a 100 × 40 ft godown." · "Draft a quote for Mr Sharma's 2BHK interior from our rate card." · "Which quotes need a follow-up this week and how much is overdue?"

It speaks standard MCP over HTTPS (Streamable HTTP, JSON-RPC 2.0; protocol versions 2025-06-18, 2025-03-26, 2024-11-05) with **OAuth 2.1** sign-in (what Claude.ai connectors use) and long-lived **access tokens** (Claude Code, Desktop, Cursor, VS Code). Verified against the official MCP TypeScript SDK, including its full OAuth flow.

## What happens when you ask for a roofing quote
You: *"Provide a roofing quotation for GI sheet for 60x30 ft A type roofing."*
Claude calls **`create_roofing_quote`** once. The app calculates the roof (A-type = gable, slope, overhangs, wastage), prices every line from **your rate card** (sheets, steel frame, purlins, flashings, gutters, screws, ventilators) and saves a **draft** quote with scope text, payment schedule and terms from your Settings. Claude then tells you the total, its assumptions (frame included? gutters?), and a link to open the draft. If you did not give a client name the draft sits under "Client to be confirmed" and Claude asks you for it.
For the 60 × 30 ft example with the starter rates that is about **₹9.36 lakh incl. GST** (₹4.1 lakh of it the steel frame; say "sheets only, existing frame" and Claude passes `include_structure=false`). Ask for "GI, UPVC and PUF" and you get **one quote with the three materials as options** the client can choose between.
**A person always reviews and sends the quote** - the AI cannot send, accept or delete anything.

## Safety model
| | |
|---|---|
| **Sign-in** | OAuth: an **admin** must approve each connection on a consent screen (PKCE, CSRF-protected, shows where the browser returns to) and chooses the access level. Or an admin creates a token in **Settings → AI assistants**. |
| **Read-only by default** | Access is *Read only* or *Read + draft*. |
| **Drafts only** | Write tools can create/edit **draft** quotes, add clients and site-log notes. They **cannot** send a quote, accept/reject, delete, record payments, change settings, manage users or download backups. |
| **Costs hidden** | Your cost prices and margins are hidden unless an admin explicitly allows them. |
| **Short-lived access** | OAuth access tokens last 1 hour; refresh tokens rotate on every use and a replayed token closes the whole connection. Tokens are stored as hashes. Admins can disconnect any app instantly (Settings → AI assistants) and switch OAuth off entirely. |
| **Limits & audit** | 120 calls/minute per token; every write is recorded in the audit log as `mcp.<tool>` by `AI: <name>`. |
| **Same rules as the app** | Same validation, GST/rounding maths, quote numbering, locks and limits. |

## Connect a client
**Claude.ai (web) / other connector apps - no token needed**
1. Claude → *Settings → Connectors → Add custom connector*; paste the **server address** from Settings → AI assistants in the app (`https://YOUR-DOMAIN/api/mcp.php`).
2. A sign-in page from your app opens: sign in as an admin, choose *Read only* or *Read + create draft quotes*, press **Allow**.

**Claude Code**
```bash
claude mcp add --transport http infraura https://YOUR-DOMAIN/api/mcp.php --header "Authorization: Bearer qbmcp_xxxxxxxx"
```
**Claude Desktop** (via the `mcp-remote` bridge) - config file:
```json
{ "mcpServers": { "infraura": { "command": "npx", "args": ["-y", "mcp-remote", "https://YOUR-DOMAIN/api/mcp.php", "--header", "Authorization: Bearer qbmcp_xxxxxxxx"] } } }
```
**Cursor / Windsurf** `mcp.json`: `{ "mcpServers": { "infraura": { "url": "https://YOUR-DOMAIN/api/mcp.php", "headers": { "Authorization": "Bearer qbmcp_xxxxxxxx" } } } }`
**VS Code** `.vscode/mcp.json`: `{ "servers": { "infraura": { "type": "http", "url": "https://YOUR-DOMAIN/api/mcp.php", "headers": { "Authorization": "Bearer qbmcp_xxxxxxxx" } } } }`
**curl test:** `curl -s https://YOUR-DOMAIN/api/mcp.php -H "Authorization: Bearer qbmcp_xxxxxxxx" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
Explore with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*).

Always use **HTTPS**. OAuth discovery lives at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (and `/api/.well-known/openid-configuration`); the bundled `.htaccess` files route these. If your app is in a sub-folder, the MCP server still announces its metadata URL in the `WWW-Authenticate` header, so connectors find it.

## Tools
| Tool | Access | What it does |
|---|---|---|
| `create_roofing_quote` | write | **One step**: calculate + price + save a draft roofing quote (A-type/shed/flat, any material, optional several materials as options, optional sheets-only) |
| `calculate_roof` | read | Roof geometry and priced packages for GI / UPVC / PUF / aluminium / polycarbonate… with ready-to-use lines |
| `get_business_overview` | read | Pipeline, recent quotes, follow-ups, receivables, AMC renewals |
| `search_quotes`, `get_quote` | read | Find quotes; full detail incl. options, GST, totals, client activity |
| `calculate_quote_totals` | read | Exact totals (same rounding as the app) |
| `list_clients`, `search_rate_card` | read | Client book; priced catalogue (returns `rate_item_id`) |
| `list_projects`, `get_project` | read | Contract value, milestones, payments, credit notes, variations, AMC date, site log |
| `get_reports_summary` | read | Win rate, trend, salesperson, lead source, aging, receivables |
| `create_client`, `create_quote_draft`, `update_quote_draft`, `add_project_log` | write | Add a client (idempotent); create/edit **draft** quotes from rate-card items or custom lines; add a site note |

**Prompts:** `draft_quote_from_brief`, `compare_roofing_options`, `weekly_sales_review`.

## Operating notes
- **Header pass-through:** `api/.htaccess` forwards `Authorization` to PHP. Getting `401` with a correct token? Check that file is deployed and `mod_rewrite` is on.
- **Upgrades:** the database upgrades itself on the first admin sign-in after uploading new files.
- **Versioning:** the server version is in `initialize` (`serverInfo.version`); new tools are additive and existing names/arguments stay stable.
- **Tests:** `tests/mcp.test.js` (protocol, auth, scopes, drafts-only safety, the roofing flow), `tests/oauth.test.js` (29 checks), `tests/roof_parity.js` (server roof calculator = in-app calculator).
