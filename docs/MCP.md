# Using Infraura with Claude and other AI tools (MCP)

The app includes a built-in **Model Context Protocol (MCP) server**, so AI assistants can look things up and draft quotations for you:

> "Price a 100 × 40 ft godown roof in GI, UPVC and PUF and compare." · "Draft a quote for Mr Sharma's 2BHK interior using our rate card." · "Which quotes need a follow-up this week and how much is overdue?"

It speaks standard MCP over HTTPS (Streamable HTTP, JSON-RPC 2.0; protocol versions 2025-06-18, 2025-03-26, 2024-11-05), so it works with any MCP client. It is verified against the official MCP TypeScript SDK.

## Safety model (read this first)

| | |
|---|---|
| **Authentication** | Bearer tokens created by an admin in **Settings → AI assistants**. Only a SHA-256 hash is stored; the token is shown once. |
| **Read-only by default** | A token is *Read only* or *Read + draft*. |
| **Drafts only** | Write tools can create/edit **draft** quotes, add clients and site-log notes. They **cannot** send a quote to a client, accept/reject, delete anything, record payments, change settings, manage users or download backups. A person reviews every AI draft in the app. |
| **Costs hidden** | Your cost prices and margins are hidden from the AI unless you tick *show costs* when creating the token. Keep this off for any assistant that might talk to clients. |
| **Expiry & revoke** | Tokens can expire (30/90/365 days) and be revoked instantly. |
| **Rate limits** | 120 calls/minute per token; repeated bad tokens are throttled. |
| **Audit** | Every write call is recorded in Settings → Activity log as `mcp.<tool>` by `AI: <token name>`. |
| **Same rules as the app** | Same validation, same GST and rounding maths, same quote numbering, locks and limits. |

## Connect a client

1. Sign in as admin → **Settings → AI assistants (MCP)** → create a token. Copy the ready-made snippet shown (it already contains your server address and token).
2. Use the snippet for your tool:

**Claude Code**
```bash
claude mcp add --transport http infraura https://YOUR-DOMAIN/api/mcp.php --header "Authorization: Bearer qbmcp_xxxxxxxx"
```

**Claude Desktop** (and other apps that only run local servers) via the `mcp-remote` bridge — add to the config file:
```json
{ "mcpServers": { "infraura": { "command": "npx", "args": ["-y", "mcp-remote", "https://YOUR-DOMAIN/api/mcp.php", "--header", "Authorization: Bearer qbmcp_xxxxxxxx"] } } }
```

**Cursor / Windsurf** (`mcp.json`)
```json
{ "mcpServers": { "infraura": { "url": "https://YOUR-DOMAIN/api/mcp.php", "headers": { "Authorization": "Bearer qbmcp_xxxxxxxx" } } } }
```

**VS Code** (`.vscode/mcp.json`)
```json
{ "servers": { "infraura": { "type": "http", "url": "https://YOUR-DOMAIN/api/mcp.php", "headers": { "Authorization": "Bearer qbmcp_xxxxxxxx" } } } }
```

**Test with curl**
```bash
curl -s https://YOUR-DOMAIN/api/mcp.php -H "Authorization: Bearer qbmcp_xxxxxxxx" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You can also explore it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, add the `Authorization` header).

> **Claude.ai web "custom connectors"** currently expect OAuth sign-in. This server uses bearer tokens, so use Claude Code / Claude Desktop (above) for now. OAuth 2.1 with dynamic client registration is the planned next step - the tool layer is protocol-independent, so adding it does not change any tool.

Always use **HTTPS** in production.

## Tools

| Tool | Access | What it does |
|---|---|---|
| `get_business_overview` | read | Pipeline by status/division, recent quotes, follow-ups due, receivables |
| `search_quotes` | read | Find quotes by text / status / division |
| `get_quote` | read | Full quote: lines, options, GST, totals, payment schedule, client activity, project link |
| `calculate_quote_totals` | read | Exact totals (same rounding as the app) for qty × rate lines, discount, GST |
| `list_clients` | read | Search the client book |
| `search_rate_card` | read | Find real priced items (returns `rate_item_id`) |
| `calculate_roof` | read | Roof area/slope/wastage, steel, flashings, gutters, fasteners; priced packages for GI / UPVC / PUF / aluminium / polycarbonate… with ready-to-use lines |
| `list_projects`, `get_project` | read | Contract value, milestones, payments, variations, site log |
| `get_reports_summary` | read | Win rate, monthly trend, salesperson, lead source, aging, receivables |
| `create_client` | write | Add a client (idempotent by name) |
| `create_quote_draft` | write | Create a **draft** from rate-card items or custom lines; defaults GST, payment schedule and terms from Settings |
| `update_quote_draft` | write | Edit a **draft** (latest revision) only |
| `add_project_log` | write | Add a site update to a project |

**Prompts** (ready-made workflows): `draft_quote_from_brief`, `compare_roofing_options`, `weekly_sales_review`.

## Operating notes

- **Apache/LiteSpeed header pass-through:** `api/.htaccess` already forwards the `Authorization` header to PHP. If you get `401 Authentication required` with a correct token, check that file is deployed and `mod_rewrite` is enabled.
- **Upgrades:** the database upgrades itself the first time an admin signs in after uploading new files (`api/migrate.php`).
- **Versioning:** server version is reported in `initialize` (`serverInfo.version`). New tools are additive; existing tool names and argument names are kept stable.
- **Tests:** `node tests/mcp.test.js` (protocol, auth, scopes, drafts-only safety) and `node tests/roof_parity.js` (the server roof calculator matches the in-app one).
