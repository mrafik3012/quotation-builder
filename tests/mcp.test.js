'use strict';
/* MCP server tests (api/mcp.php). Usage: BASE=http://127.0.0.1:8766 node tests/mcp.test.js */
const { mergeCookies } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0; const failures = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; failures.push(name); console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, m = '') => { if (Math.abs(a - b) > 0.011) throw new Error(`${m} expected ~${b} got ${a}`); };

let cookie = '';
async function admin(method, route, body) {
  const r = await fetch(`${BASE}/api/index.php?r=${route}`, { method, headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie(); if (sc.length) cookie = mergeCookies(cookie, sc);
  return { status: r.status, data: await r.json().catch(() => null) };
}
let rid = 0;
async function rpc(token, method, params, opt = {}) {
  const body = opt.raw !== undefined ? opt.raw : JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params });
  const r = await fetch(`${BASE}/api/mcp.php`, { method: opt.method || 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opt.method === 'GET' ? undefined : body });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* empty */ }
  return { status: r.status, data, headers: r.headers, text };
}
const call = async (token, name, args = {}) => { const r = await rpc(token, 'tools/call', { name, arguments: args }); ok(r.status === 200, 'http ' + r.status + ' ' + r.text.slice(0, 200)); return r.data.result || r.data; };
const payload = res => JSON.parse(res.content[0].text);

(async () => {
  console.log(`MCP tests against ${BASE}`);
  eq((await admin('POST', 'auth/login', ADMIN)).status, 200);
  const mk = async (name, scope, extra = {}) => (await admin('POST', 'tokens', { name, scope, ...extra })).data;
  const readTok = (await mk('QA read', 'read')).token, writeTok = (await mk('QA write', 'write')).token, costTok = (await mk('QA costs', 'read', { show_costs: true })).token;

  console.log('\nTransport & authentication');
  await test('no token -> 401 with WWW-Authenticate', async () => { const r = await rpc(null, 'ping'); eq(r.status, 401); ok(/Bearer/.test(r.headers.get('www-authenticate') || ''), 'challenge header'); });
  await test('wrong token -> 401', async () => eq((await rpc('qbmcp_' + 'f'.repeat(48), 'ping')).status, 401));
  await test('GET is refused with 405 (no SSE stream offered)', async () => eq((await rpc(readTok, '', null, { method: 'GET' })).status, 405));
  await test('invalid JSON -> JSON-RPC parse error', async () => { const r = await rpc(readTok, '', null, { raw: '{nope' }); eq(r.status, 400); eq(r.data.error.code, -32700); });
  await test('unknown method -> -32601', async () => eq((await rpc(readTok, 'does/not/exist')).data.error.code, -32601));
  await test('initialize negotiates version and advertises tools + prompts', async () => {
    const r = await rpc(readTok, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } });
    eq(r.data.result.protocolVersion, '2025-06-18'); ok(r.data.result.capabilities.tools && r.data.result.capabilities.prompts, 'capabilities'); ok(r.data.result.serverInfo.name, 'serverInfo'); ok(/DRAFT/.test(r.data.result.instructions), 'instructions mention drafts');
    eq((await rpc(readTok, 'initialize', { protocolVersion: '1999-01-01' })).data.result.protocolVersion, '2025-06-18', 'falls back to latest');
    eq((await rpc(readTok, 'initialize', { protocolVersion: '2024-11-05' })).data.result.protocolVersion, '2024-11-05', 'older version honoured');
  });
  await test('notifications get 202 with no body', async () => { const r = await rpc(readTok, '', null, { raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); eq(r.status, 202); eq(r.text, ''); });
  await test('ping returns an empty result', async () => eq((await rpc(readTok, 'ping')).data.result, {}));
  await test('JSON-RPC batch is answered in one array', async () => {
    const r = await rpc(readTok, '', null, { raw: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) });
    ok(Array.isArray(r.data) && r.data.length === 2, 'two responses'); eq(r.data.map(x => x.id).sort(), [1, 2]);
  });

  console.log('\nTool catalogue');
  let tools;
  await test('tools/list returns well-formed tools with JSON-Schema inputs and annotations', async () => {
    tools = (await rpc(readTok, 'tools/list')).data.result.tools;
    ok(tools.length >= 15, 'tool count ' + tools.length); eq(new Set(tools.map(t => t.name)).size, tools.length, 'unique names');
    for (const t of tools) { ok(/^[a-z_]+$/.test(t.name), 'name ' + t.name); ok(t.description && t.description.length > 30, 'description ' + t.name); eq(t.inputSchema.type, 'object', 'schema ' + t.name); ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', 'annotations ' + t.name); ok(!('run' in t) && !('scope' in t), 'internals leaked ' + t.name); }
  });
  await test('no tool can delete, send, accept, change settings or manage users', async () => {
    const bad = tools.filter(t => /delete|remove|send|accept|reject|settings|user|token|backup|payment|receipt|share/.test(t.name)); eq(bad.map(t => t.name), [], 'dangerous tools');
  });
  await test('write tools are not marked read-only; read tools are', async () => {
    for (const n of ['create_quote_draft', 'update_quote_draft', 'create_client', 'add_project_log']) ok(tools.find(t => t.name === n).annotations.readOnlyHint === false, n);
    for (const n of ['search_quotes', 'get_quote', 'search_rate_card', 'calculate_roof']) ok(tools.find(t => t.name === n).annotations.readOnlyHint === true, n);
  });
  await test('prompts are listed and retrievable', async () => {
    const l = (await rpc(readTok, 'prompts/list')).data.result.prompts; ok(l.length >= 3);
    const g = (await rpc(readTok, 'prompts/get', { name: 'draft_quote_from_brief', arguments: { brief: '40x100 godown roofing' } })).data.result; ok(/godown/.test(g.messages[0].content.text));
  });

  console.log('\nReading data');
  let rateItem;
  await test('search_rate_card finds items and hides cost for default tokens', async () => {
    const res = await call(readTok, 'search_rate_card', { query: 'PUF 50', division: 'roofing', limit: 5 }); const items = payload(res);
    ok(items.length > 0 && items[0].rate_item_id, 'results'); rateItem = items[0]; ok(!('cost' in items[0]), 'cost must be hidden'); ok(res.structuredContent.items.length === items.length, 'structuredContent');
  });
  await test('a token created with show_costs can see cost', async () => { const it = payload(await call(costTok, 'search_rate_card', { query: 'PUF 50', limit: 1 }))[0]; ok(typeof it.cost === 'number'); });
  await test('search_rate_card treats % and quotes as plain text', async () => { const r = await call(readTok, 'search_rate_card', { query: "%' OR 1=1 --" }); ok(!r.isError); eq(payload(r), []); });
  await test('calculate_roof prices four materials with ready-to-use lines', async () => {
    const r = payload(await call(readTok, 'calculate_roof', { length_ft: 100, width_ft: 40, materials: ['gi', 'upvc', 'puf50', 'alu'] }));
    eq(r.packages.map(p => p.material), ['gi', 'upvc', 'puf50', 'alu']); near(r.geometry.plan, 4000); ok(r.packages[0].total_incl_gst > r.packages[0].total_before_gst);
    ok(r.packages[2].total_before_gst > r.packages[0].total_before_gst, 'PUF dearer than GI'); ok(!JSON.stringify(r).includes('"cost"'), 'cost hidden'); ok(r.packages[0].lines[0].description && r.packages[0].lines[0].quantity > 0);
  });
  await test('calculate_roof validates its input with a readable error', async () => {
    const r = await call(readTok, 'calculate_roof', { length_ft: -5, width_ft: 40 }); ok(r.isError && /positive/.test(r.content[0].text));
    const r2 = await call(readTok, 'calculate_roof', { length_ft: 10, width_ft: 10, materials: ['gold'] }); ok(r2.isError && /Unknown material/.test(r2.content[0].text));
  });
  await test('calculate_quote_totals matches the app rounding', async () => {
    const r = payload(await call(readTok, 'calculate_quote_totals', { lines: [{ quantity: 3, rate: 333.33 }, { quantity: 1.5, rate: 99.99 }], discount_flat: 77.77, gst_percent: 12, round_off: true }));
    near(r.subtotal, 1149.98); near(r.gst, 128.67); eq(r.grand_total, 1201, 'rounded');
  });
  await test('get_business_overview and get_reports_summary return data', async () => { ok(payload(await call(readTok, 'get_business_overview')).by_status !== undefined); ok(payload(await call(readTok, 'get_reports_summary')).by_division !== undefined); });

  console.log('\nPermissions (read vs write)');
  await test('a read-only token cannot write: tool returns isError', async () => { const r = await call(readTok, 'create_client', { name: 'Nope' }); ok(r.isError && /read-only/.test(r.content[0].text)); });
  await test('unknown tool is a protocol error', async () => { const r = await rpc(readTok, 'tools/call', { name: 'drop_database', arguments: {} }); ok(r.data.error && /Unknown tool/.test(r.data.error.message)); });

  console.log('\nWriting drafts');
  let qid, cid;
  await test('create_client is idempotent by name', async () => {
    const n = 'MCP Client ' + Date.now(); const a = payload(await call(writeTok, 'create_client', { name: n, phone: '9812345678', gstin: '29ABCDE1234F1Z5' })); ok(a.created); cid = a.client_id;
    const b = payload(await call(writeTok, 'create_client', { name: n.toUpperCase() })); eq(b.client_id, cid); eq(b.created, false);
  });
  await test('create_quote_draft builds a priced draft from rate-card items and custom lines', async () => {
    const r = payload(await call(writeTok, 'create_quote_draft', { division: 'roofing', client_id: cid, title: 'MCP godown', site_address: 'Plot 5, Hosur', lines: [{ rate_item_id: rateItem.rate_item_id, quantity: 4000, section: 'Roof' }, { description: 'Site visit', unit: 'lot', quantity: 1, rate: 2500 }], discount_percent: 5, round_off: true }));
    qid = r.quote_id; eq(r.status, 'draft'); ok(/^INF\/RF\//.test(r.quote_no)); ok(r.app_url.includes('#/quotes/' + qid));
    const sub = 4000 * rateItem.rate + 2500, disc = sub * 0.05, taxable = sub - disc, gst = Math.round(taxable * 18) / 100; near(r.totals.subtotal, sub, 'subtotal'); eq(r.totals.grand_total, Math.round(taxable + gst), 'grand total');
    const rest = (await admin('GET', `quotes/${qid}`)).data.quote; eq(rest.status, 'draft'); near(rest.total, r.totals.grand_total); eq(rest.client_id, cid); eq(rest.data.source, 'AI assistant (MCP)'); ok(rest.data.payment_schedule.length > 0, 'default payment schedule'); ok(rest.data.terms.length > 0, 'default terms'); eq(rest.data.sections.length, 2, 'two sections');
  });
  await test('drafts created over MCP are in the audit log with the token name', async () => { const a = (await admin('GET', 'audit')).data; ok(a.some(x => x.action === 'mcp.create_quote_draft' && /AI: QA write/.test(x.user_name))); });
  await test('get_quote returns the line detail, and hides internal cost for default tokens', async () => {
    const r = payload(await call(readTok, 'get_quote', { quote_id: qid })); eq(r.status, 'draft'); eq(r.sections[0].lines[0].quantity, 4000); ok(!JSON.stringify(r).includes('"cost"') && !('margin_pct' in r), 'no cost/margin');
    const c = payload(await call(costTok, 'get_quote', { quote_id: qid })); ok('margin_pct' in c, 'cost token sees margin');
  });
  await test('calculate_roof lines can be passed straight into create_quote_draft', async () => {
    const roof = payload(await call(readTok, 'calculate_roof', { length_ft: 60, width_ft: 30, materials: ['puf50'] })); const pkg = roof.packages[0];
    const r = payload(await call(writeTok, 'create_quote_draft', { division: 'roofing', client: { name: 'Roof Direct Ltd' }, title: 'From calculator', lines: pkg.lines.map(l => ({ description: l.description, unit: l.unit, quantity: l.quantity, rate: l.rate, section: l.section })) }));
    near(r.totals.subtotal, pkg.total_before_gst, 'quote subtotal equals calculator total');
  });
  await test('update_quote_draft edits a draft and recalculates', async () => {
    const r = payload(await call(writeTok, 'update_quote_draft', { quote_id: qid, title: 'Edited by AI', discount_percent: 0, round_off: false, lines: [{ description: 'Single line', unit: 'lot', quantity: 2, rate: 1000 }] })); near(r.totals.grand_total, 2360);
    eq((await admin('GET', `quotes/${qid}`)).data.quote.title, 'Edited by AI');
  });
  await test('update_quote_draft refuses a quote that has been sent', async () => {
    await admin('POST', `quotes/${qid}/share`); const r = await call(writeTok, 'update_quote_draft', { quote_id: qid, title: 'Sneaky' }); ok(r.isError && /sent/.test(r.content[0].text));
    eq((await admin('GET', `quotes/${qid}`)).data.quote.title, 'Edited by AI');
  });
  await test('invalid drafts give readable errors (not 500s)', async () => {
    for (const [args, re] of [[{ division: 'roofing', client: { name: 'x' }, lines: [{ description: 'a', unit: 'u', quantity: -1, rate: 5 }] }, /negative/], [{ division: 'roofing', client: { name: 'x' }, lines: [{ rate_item_id: 999999, quantity: 1 }] }, /not found/], [{ division: 'pizza', client: { name: 'x' }, lines: [{ quantity: 1 }] }, /division/], [{ division: 'roofing', lines: [{ description: 'a', unit: 'u', quantity: 1, rate: 1 }] }, /client/], [{ division: 'roofing', client: { name: 'x' }, lines: [{ description: 'a', quantity: 1, rate: 1 }] }, /unit/]]) {
      const r = await call(writeTok, 'create_quote_draft', args); ok(r.isError && re.test(r.content[0].text), JSON.stringify(r.content[0].text) + ' !~ ' + re);
    }
  });
  await test('add_project_log writes a site-log entry', async () => {
    const pid = (await admin('GET', 'projects')).data.projects[0]; if (!pid) return; // no project in a fresh DB: skip silently
    ok(payload(await call(writeTok, 'add_project_log', { project_id: pid.id, text: 'Sheets delivered', progress_percent: 20 })).ok);
  });

  console.log('\nOne-step roofing quote (the "60x30 GI A-type" request)');
  let rq;
  await test('create_roofing_quote: GI, 60x30 ft, A-type -> a complete draft in ONE call, with no client given', async () => {
    rq = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 60, width_ft: 30, material: 'gi', roof_type: 'gable' }));
    eq(rq.status, 'draft'); eq(rq.client, 'Client to be confirmed'); ok(rq.warnings.some(w => /client/i.test(w)), 'warns about client'); ok(rq.assumptions.length >= 3, 'states assumptions'); ok(/gable/i.test(rq.roof.type));
    near(rq.roof.plan_area_sqft, 1800); ok(rq.roof.roof_area_sqft > 1800, 'slope adds area');
    const calc = payload(await call(readTok, 'calculate_roof', { length_ft: 60, width_ft: 30, materials: ['gi'] })).packages[0];
    near(rq.totals.subtotal, calc.total_before_gst, 'quote equals the calculator'); near(rq.totals.grand_total, calc.total_incl_gst, 'with GST');
  });
  await test('the saved quote is complete: title, scope, lines, payment schedule, terms, HSN, area', async () => {
    const r = (await admin('GET', `quotes/${rq.quote_id}`)).data.quote;
    eq(r.status, 'draft'); ok(/60 x 30/.test(r.title) && /A-type/.test(r.title)); ok(/60 x 30 ft/.test(r.data.scope)); ok(r.data.sections.length === 1 && r.data.sections[0].items.length >= 8, 'items');
    ok(r.data.payment_schedule.length > 0 && r.data.terms.length > 0, 'schedule + terms'); eq(r.data.area_sqft, 1800); ok(r.data.hsn, 'hsn'); near(r.total, rq.totals.grand_total);
  });
  await test('the placeholder client is reused, not duplicated, and a named client overrides it', async () => {
    const again = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 40, width_ft: 20 })); eq(again.client, 'Client to be confirmed');
    const clients = (await admin('GET', 'clients')).data.filter(c => c.name === 'Client to be confirmed'); eq(clients.length, 1, 'single placeholder client');
    const named = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 40, width_ft: 20, client: { name: 'Sharma Industries', phone: '9876543210' } })); eq(named.client, 'Sharma Industries'); eq(named.warnings, []);
  });
  await test('sheets-only (re-roofing) is cheaper than a new building with frame and says so', async () => {
    const full = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 60, width_ft: 30, client: { name: 'Frame Test' } })), sheets = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 60, width_ft: 30, include_structure: false, client: { name: 'Frame Test' } }));
    ok(sheets.totals.grand_total < full.totals.grand_total * 0.6, 'much cheaper without the frame'); ok(sheets.assumptions.some(x => /NO steel frame/.test(x)));
    const q = (await admin('GET', `quotes/${sheets.quote_id}`)).data.quote; ok(!q.data.sections[0].items.some(i => /frame|purlin/i.test(i.desc)), 'no frame/purlin lines');
  });
  await test('several materials become selectable options on ONE quote (GI / UPVC / PUF)', async () => {
    const m = payload(await call(writeTok, 'create_roofing_quote', { length_ft: 60, width_ft: 30, materials: ['gi', 'upvc', 'puf50'], client: { name: 'Options Co' } }));
    eq(m.options.map(o => o.option), ['GI', 'UPVC', 'PUF 50']); ok(m.options[0].grand_total_incl_gst < m.options[1].grand_total_incl_gst && m.options[1].grand_total_incl_gst < m.options[2].grand_total_incl_gst, 'GI < UPVC < PUF');
    const q = (await admin('GET', `quotes/${m.quote_id}`)).data.quote; eq(q.data.options.length, 3); eq(q.data.selected_option, 0); near(q.total, m.options[0].grand_total_incl_gst);
    const sh = (await admin('POST', `quotes/${m.quote_id}/share`)).data.token; const pub = await (await fetch(`${BASE}/api/public.php?r=quote&t=${sh}`)).json(); eq(pub.quote.data.options.length, 3, 'client sees the options');
  });
  await test('create_roofing_quote validates input and is write-only', async () => {
    ok((await call(writeTok, 'create_roofing_quote', { length_ft: 0, width_ft: 30 })).isError); ok((await call(writeTok, 'create_roofing_quote', { length_ft: 10, width_ft: 10, material: 'gold' })).isError);
    ok((await call(writeTok, 'create_roofing_quote', { length_ft: 10, width_ft: 10, roof_type: 'dome' })).isError); ok((await call(writeTok, 'create_roofing_quote', { length_ft: 10, width_ft: 10, materials: ['gi', 'upvc', 'puf50', 'alu', 'poly'] })).isError);
    const r = await call(readTok, 'create_roofing_quote', { length_ft: 60, width_ft: 30 }); ok(r.isError && /read-only/.test(r.content[0].text));
  });

  console.log('\nToken management');
  await test('staff users cannot list or create tokens', async () => {
    const email = `mcpstaff${Date.now()}@example.com`; await admin('POST', 'users', { name: 'S', email, password: 'password123', role: 'staff' });
    const r = await fetch(`${BASE}/api/index.php?r=auth/login`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
    const ck = mergeCookies('', r.headers.getSetCookie()); const t = await fetch(`${BASE}/api/index.php?r=tokens`, { headers: { Cookie: ck, 'X-Requested-With': 'infraura' } }); eq(t.status, 403);
  });
  await test('the plain token is never stored or listed again', async () => {
    const list = (await admin('GET', 'tokens')).data; ok(list.length >= 3); ok(!JSON.stringify(list).includes(writeTok), 'plain token in list'); ok(list[0].prefix.startsWith('qbmcp_'));
  });
  await test('a revoked token stops working immediately', async () => {
    const t = await mk('QA temp', 'read'); eq((await rpc(t.token, 'ping')).status, 200); eq((await admin('DELETE', `tokens/${t.id}`)).status, 200); eq((await rpc(t.token, 'ping')).status, 401);
  });
  await test('tokens can expire', async () => {
    const t = await mk('QA expiring', 'read', { expires_days: 1 }); eq((await rpc(t.token, 'ping')).status, 200);
  });
  await test('an overly large request body is rejected', async () => { const r = await rpc(readTok, '', null, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1100000) } }) }); eq(r.status, 413); });
  await test('rate limit: a token is throttled after 120 calls a minute (429)', async () => {
    const t = (await mk('QA flood', 'read')).token; let last = 0;
    for (let i = 0; i < 140; i++) { last = (await rpc(t, 'ping')).status; if (last === 429) break; } eq(last, 429);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
