'use strict';
/* Web-server hardening: only meaningful against Apache / LiteSpeed (PHP's built-in server ignores .htaccess).
   Usage: BASE=http://127.0.0.1:8080 node tests/apache.test.js */
const { Client } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const get = (p, h = {}) => fetch(BASE + p, { redirect: 'manual', headers: h });

(async () => {
  console.log(`Web-server hardening tests against ${BASE}`);
  const probe = await get('/api/health.php'); if (!/apache|litespeed/i.test(probe.headers.get('server') || '')) { console.log('Not Apache/LiteSpeed (' + probe.headers.get('server') + ') - skipping'); process.exit(0); }
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);

  console.log('\nInternal files');
  await test('PHP include files cannot be requested directly (403) and are never executed', async () => {
    for (const f of ['config', 'lib', 'core', 'mail', 'auth', 'migrate', 'projects', 'setup', 'seed_extended']) { const r = await get(`/api/${f}.php`); eq(r.status, 403, f + '.php'); const t = await r.text(); ok(!/<\?php/.test(t) && !/password|dbpass/i.test(t), f + ' leaked'); }
  });
  await test('the public entry points still work', async () => { for (const [p, st] of [['/api/health.php', 200], ['/api/index.php?r=auth/me', 200], ['/index.html', 200], ['/view.html', 200], ['/manifest.webmanifest', 200], ['/sw.js', 200]]) eq((await get(p)).status, st, p); });
  await test('tests, docs sources, markdown, scripts and VCS folders are not served', async () => {
    for (const p of ['/tests/api.test.js', '/tests/run.sh', '/tests/dbtool.php', '/.git/config', '/README.md', '/docs/MCP.md', '/tests/.htaccess']) { const r = await get(p); ok([403, 404].includes(r.status), `${p} -> ${r.status}`); }
  });
  await test('directory listing is off', async () => { for (const p of ['/assets/', '/api/', '/docs/']) { const r = await get(p); ok(r.status !== 200 || !/Index of/i.test(await r.text()), p); } });

  console.log('\nPrivate data (backups, error log, database folder)');
  await test('backups are listed to admins but cannot be fetched straight from the web', async () => {
    const b = (await admin.api('POST', 'system/backup')).data; const direct = await get(`/api/data/backups/${b.file}`); eq(direct.status, 403, 'direct backup URL');
    const via = await fetch(`${BASE}/api/index.php?r=system/backup/${b.file}`, { headers: { Cookie: admin.cookie } }); eq(via.status, 200, 'download through the app (admin session) works');
    eq((await get(`/api/index.php?r=system/backup/${b.file}`)).status, 401, 'not without a session');
  });
  await test('api/data and everything below it is denied', async () => { for (const p of ['/api/data/', '/api/data/app-errors.log', '/api/data/backups/', '/api/data/.htaccess']) eq((await get(p)).status, 403, p); });

  console.log('\nHeaders');
  await test('security headers are present on pages', async () => {
    const h = (await get('/index.html')).headers; eq(h.get('x-content-type-options'), 'nosniff'); ok(/SAMEORIGIN/i.test(h.get('x-frame-options') || '')); eq(h.get('referrer-policy'), 'same-origin'); ok(/camera=\(\)/.test(h.get('permissions-policy') || ''));
  });
  await test('API responses are never cached', async () => { const r = await admin.api('GET', 'bootstrap'); ok(/no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control')); });
  await test('API responses are not sniffable or frameable either, and the consent page stays DENY (not weakened by .htaccess)', async () => {
    const r = await admin.api('GET', 'bootstrap'); eq(r.headers.get('x-content-type-options'), 'nosniff'); ok(r.headers.get('x-frame-options'));
    const c = await get('/api/oauth.php?r=authorize&client_id=x'); eq(c.headers.get('x-frame-options'), 'DENY');
  });

  console.log('\nRewrites and request handling');
  await test('OAuth discovery addresses resolve through the real .htaccess rewrite rules', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp.php', '/api/.well-known/openid-configuration', '/api/.well-known/oauth-authorization-server']) {
      const r = await get(p); eq(r.status, 200, p); const m = await r.json(); if (p.includes('protected')) eq(m.resource, `${BASE}/api/mcp.php`, p); else { eq(m.issuer, `${BASE}/api`, p); eq(m.authorization_endpoint, `${BASE}/api/oauth.php?r=authorize`, p); }
    }
  });
  await test('the Authorization header reaches PHP (MCP bearer tokens work behind Apache)', async () => {
    const t = (await admin.api('POST', 'tokens', { name: 'apache test', scope: 'read' })).data.token; const r = await fetch(`${BASE}/api/mcp.php`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }); eq(r.status, 200);
  });
  await test('PUT, DELETE and JSON bodies are not blocked by the server', async () => {
    const c = (await admin.api('POST', 'clients', { name: 'Method Test' })).data.id; eq((await admin.api('PUT', `clients/${c}`, { name: 'Method Test 2' })).status, 200); eq((await admin.api('DELETE', `clients/${c}`)).status, 200);
  });
  await test('sessions use secure cookie attributes', async () => {
    const r = await fetch(`${BASE}/api/index.php?r=auth/login`, { method: 'POST', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) }); const sc = r.headers.getSetCookie().join(';'); ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), sc);
  });
  await test('PHP errors are never shown to visitors', async () => { const r = await get('/api/index.php?r=quotes/abc'); const t = await r.text(); ok(!/Fatal error|Warning:|Notice:|Stack trace|\/var\/www/.test(t), t.slice(0, 120)); });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
