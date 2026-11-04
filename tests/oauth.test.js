'use strict';
/* OAuth 2.1 for the MCP endpoint. Usage: BASE=http://127.0.0.1:8766 node tests/oauth.test.js
   (needs the router in tests/router.php when run with PHP's built-in server so the /.well-known addresses resolve) */
const crypto = require('crypto');
const { Client } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkce = () => { const verifier = b64u(crypto.randomBytes(48)); return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) }; };
const OA = `${BASE}/api/oauth.php`;

/** A browser-ish session: keeps cookies, never follows redirects (we read Location ourselves). */
class Browser {
  constructor() { this.cookie = ''; }
  async req(method, url, form) {
    const r = await fetch(url, { method, redirect: 'manual', headers: { ...(this.cookie ? { Cookie: this.cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    return { status: r.status, location: r.headers.get('location'), text: await r.text(), headers: r.headers };
  }
}
const post = (url, obj, json) => fetch(url, { method: 'POST', headers: json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(obj) : new URLSearchParams(obj).toString() }).then(async r => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));
const mcp = (token, method, params) => fetch(`${BASE}/api/mcp.php`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(async r => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

(async () => {
  console.log(`OAuth tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);

  console.log('\nDiscovery');
  await test('protected-resource metadata points at this MCP endpoint and our authorization server (RFC 9728)', async () => {
    const m = await (await fetch(`${OA}?r=resource-metadata`)).json(); eq(m.resource, `${BASE}/api/mcp.php`); eq(m.authorization_servers, [`${BASE}/api`]); ok(m.scopes_supported.includes('mcp:write'));
  });
  await test('authorization-server metadata advertises PKCE S256 only, public clients, DCR and revocation (RFC 8414)', async () => {
    const m = await (await fetch(`${OA}?r=as-metadata`)).json(); eq(m.issuer, `${BASE}/api`); eq(m.code_challenge_methods_supported, ['S256']); eq(m.token_endpoint_auth_methods_supported, ['none']); eq(m.response_types_supported, ['code']); ok(m.grant_types_supported.includes('refresh_token'));
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) ok(m[k].startsWith(`${BASE}/api/oauth.php?r=`), k);
  });
  await test('the well-known addresses clients look up resolve too', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp.php', '/api/.well-known/openid-configuration']) {
      const r = await fetch(BASE + p); eq(r.status, 200, p); const m = await r.json();
      // regression: URLs must be built from where the app lives, not from the rewritten request path
      if (p.includes('protected')) eq(m.resource, `${BASE}/api/mcp.php`, p); else { eq(m.issuer, `${BASE}/api`, p); eq(m.registration_endpoint, `${BASE}/api/oauth.php?r=register`, p); eq(m.token_endpoint, `${BASE}/api/oauth.php?r=token`, p); }
    }
  });
  await test('an unauthenticated MCP call tells the client where to start OAuth (WWW-Authenticate resource_metadata)', async () => {
    const r = await fetch(`${BASE}/api/mcp.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }); eq(r.status, 401);
    ok(new RegExp(`resource_metadata="${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/oauth\\.php\\?r=resource-metadata"`).test(r.headers.get('www-authenticate') || ''), r.headers.get('www-authenticate'));
  });

  console.log('\nDynamic client registration');
  let clientId;
  await test('a client can register with https and app-scheme redirect URIs and gets a public client id', async () => {
    const r = await post(`${OA}?r=register`, { client_name: 'Claude', redirect_uris: [REDIRECT, 'http://localhost:33418/callback', 'cursor://anysphere.cursor-retrieval/oauth/callback'], token_endpoint_auth_method: 'client_secret_post' }, true);
    eq(r.status, 201); ok(/^qbc_[a-f0-9]{24}$/.test(r.data.client_id)); eq(r.data.token_endpoint_auth_method, 'none', 'we only do public clients with PKCE'); ok(!('client_secret' in r.data)); clientId = r.data.client_id;
  });
  await test('dangerous or sloppy redirect URIs are refused', async () => {
    for (const bad of ['javascript:alert(1)', 'http://evil.example.com/cb', 'https://x.example.com/cb#frag', 'data:text/html,hi', 'file:///etc/passwd', 'https://x.example.com/ cb', '//evil.example.com', 'notaurl']) {
      const r = await post(`${OA}?r=register`, { client_name: 'x', redirect_uris: [bad] }, true); eq(r.status, 400, bad); eq(r.data.error, 'invalid_redirect_uri', bad);
    }
    eq((await post(`${OA}?r=register`, { client_name: 'x' }, true)).status, 400, 'missing uris'); eq((await post(`${OA}?r=register`, { client_name: 'x', redirect_uris: Array(6).fill(REDIRECT) }, true)).status, 400, 'too many');
  });

  console.log('\nConsent screen security');
  const q = pkce(); const params = (o = {}) => ({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: q.challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'mcp:read mcp:write', ...o });
  const authUrl = p => `${OA}?r=authorize&${new URLSearchParams(p)}`;
  await test('unknown client or unregistered redirect_uri shows an error page and NEVER redirects (no open redirect)', async () => {
    const b = new Browser(); for (const p of [params({ client_id: 'qbc_nope' }), params({ redirect_uri: 'https://evil.example.com/cb' }), params({ redirect_uri: REDIRECT + '/' })]) { const r = await b.req('GET', authUrl(p)); eq(r.status, 400); ok(!r.location, 'must not redirect: ' + r.location); ok(/Cannot connect/.test(r.text)); }
  });
  await test('missing / weak PKCE and wrong response_type are rejected via redirect error', async () => {
    const b = new Browser();
    for (const [p, err] of [[params({ code_challenge: undefined }), 'invalid_request'], [params({ code_challenge_method: 'plain' }), 'invalid_request'], [params({ code_challenge: 'short' }), 'invalid_request'], [params({ response_type: 'token' }), 'unsupported_response_type']]) {
      const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)); const r = await b.req('GET', authUrl(clean)); eq(r.status, 302); ok(r.location.startsWith(REDIRECT + '?') && r.location.includes('error=' + err) && r.location.includes('state=st-123'), r.location);
    }
  });
  await test('the consent page is not embeddable (clickjacking) and carries a strict CSP', async () => {
    const b = new Browser(); const r = await b.req('GET', authUrl(params())); eq(r.status, 200); eq(r.headers.get('x-frame-options'), 'DENY'); ok(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy')));
  });
  await test('signed out: a login form is shown; a wrong password fails; the sign-in lockout applies', async () => {
    const b = new Browser(); const r = await b.req('GET', authUrl(params())); ok(/type="password"/.test(r.text) && /Sign in to continue/.test(r.text)); const bad = await b.req('POST', authUrl(params()), { ...params(), do: 'login', email: ADMIN.email, password: 'wrong-password' }); eq(bad.status, 401); ok(/Incorrect email or password/.test(bad.text));
  });
  const staffEmail = `oauth-staff-${Date.now()}@example.com`; await admin.api('POST', 'users', { name: 'Staff', email: staffEmail, password: 'staffpass1', role: 'staff' });
  await test('a non-admin cannot approve a connection', async () => {
    const b = new Browser(); const r = await b.req('POST', authUrl(params()), { ...params(), do: 'login', email: staffEmail, password: 'staffpass1' }); eq(r.status, 403); ok(/Administrator needed/.test(r.text)); ok(!/name="do" value="approve"/.test(r.text), 'no approve button');
  });
  const login = async () => { const b = new Browser(); const r = await b.req('POST', authUrl(params()), { ...params(), do: 'login', email: ADMIN.email, password: ADMIN.password }); eq(r.status, 200); ok(/Connect Claude\?/.test(r.text), 'consent page'); return { b, page: r.text }; };
  const csrfOf = html => (/name="csrf" value="([a-f0-9]{32})"/.exec(html) || [])[1];
  const decide = async (b, page, extra, p = params()) => b.req('POST', authUrl(p), { ...p, csrf: csrfOf(page), ...extra });
  await test('admin sees what is being requested, where they will be sent back to, and the access choices', async () => {
    const { page } = await login(); ok(/claude\.ai/.test(page), 'redirect host shown'); ok(/Read only/.test(page) && /Read \+ create draft quotes/.test(page) && /costs and margins/.test(page)); ok(/never send quotes/i.test(page));
  });
  await test('the decision needs the page\'s CSRF token', async () => {
    const { b, page } = await login(); eq((await b.req('POST', authUrl(params()), { ...params(), do: 'approve', access: 'write' })).status, 400, 'no token'); eq((await b.req('POST', authUrl(params()), { ...params(), do: 'approve', csrf: 'f'.repeat(32) })).status, 400, 'wrong token');
    const ok2 = await decide(b, page, { do: 'approve', access: 'read' }); eq(ok2.status, 302, 'right token works once');
  });
  await test('"Cancel" returns access_denied with the state and issues nothing', async () => {
    const { b, page } = await login(); const r = await decide(b, page, { do: 'deny' }); eq(r.status, 302); ok(r.location.startsWith(REDIRECT + '?') && r.location.includes('error=access_denied') && r.location.includes('state=st-123') && !r.location.includes('code='), r.location);
  });

  console.log('\nAuthorization code -> tokens');
  const getCode = async (extra = {}, p = params()) => { const { b, page } = await login(); const r = await decide(b, page, { do: 'approve', ...extra }, p); eq(r.status, 302); const u = new URL(r.location); eq(u.origin + u.pathname, REDIRECT); eq(u.searchParams.get('state'), 'st-123'); eq(u.searchParams.get('iss'), `${BASE}/api`); return u.searchParams.get('code'); };
  const exchange = (code, o = {}) => post(`${OA}?r=token`, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: q.verifier, ...o });
  await test('a wrong PKCE verifier, redirect_uri or client is refused', async () => {
    const c1 = await getCode(); const r1 = await exchange(c1, { code_verifier: pkce().verifier }); eq(r1.status, 400); eq(r1.data.error, 'invalid_grant');
    const c2 = await getCode(); eq((await exchange(c2, { redirect_uri: 'https://evil.example.com/cb' })).data.error, 'invalid_grant'); eq((await exchange(c2, { client_id: 'qbc_other' })).status, 401);
    eq((await exchange('0'.repeat(64))).data.error, 'invalid_grant'); eq((await exchange(c2, { code_verifier: 'short' })).data.error, 'invalid_grant');
  });
  let tok;
  await test('the right verifier returns an access token (1 h) and a refresh token; responses are not cacheable', async () => {
    const code = await getCode({ access: 'read' }); const r = await exchange(code); eq(r.status, 200); tok = r.data;
    ok(/^qbo_[a-f0-9]{48}$/.test(tok.access_token) && /^qbr_[a-f0-9]{48}$/.test(tok.refresh_token)); eq(tok.token_type, 'Bearer'); eq(tok.expires_in, 3600); eq(tok.scope, 'mcp:read'); ok(/no-store/.test(r.headers.get('cache-control')));
  });
  await test('the access token works on the MCP endpoint, read-only, with costs hidden by default', async () => {
    eq((await mcp(tok.access_token, 'tools/list')).status, 200); const w = await mcp(tok.access_token, 'tools/call', { name: 'create_client', arguments: { name: 'Should Fail' } }); ok(w.data.result.isError && /read-only/.test(w.data.result.content[0].text));
    const rc = await mcp(tok.access_token, 'tools/call', { name: 'search_rate_card', arguments: { query: 'PUF', limit: 1 } }); ok(!JSON.stringify(rc.data).includes('"cost'), 'cost hidden');
  });
  await test('the code can be used only once; replaying it closes the whole connection', async () => {
    const code = await getCode({ access: 'read' }); const first = await exchange(code); eq(first.status, 200); eq((await mcp(first.data.access_token, 'tools/list')).status, 200);
    const replay = await exchange(code); eq(replay.data.error, 'invalid_grant'); eq((await mcp(first.data.access_token, 'tools/list')).status, 401, 'tokens from the replayed code are revoked'); eq((await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: first.data.refresh_token, client_id: clientId })).data.error, 'invalid_grant');
  });
  await test('an admin can grant draft-writing and cost visibility; the scope is enforced', async () => {
    const code = await getCode({ access: 'write', show_costs: '1' }); const r = await exchange(code); eq(r.data.scope, 'mcp:read mcp:write');
    const w = await mcp(r.data.access_token, 'tools/call', { name: 'create_client', arguments: { name: 'OAuth Client ' + Date.now() } }); ok(!w.data.result.isError, JSON.stringify(w.data.result)); const rc = await mcp(r.data.access_token, 'tools/call', { name: 'search_rate_card', arguments: { query: 'PUF', limit: 1 } }); ok(JSON.stringify(rc.data).includes('cost'), 'cost visible when allowed');
  });
  await test('a client that only asked for mcp:read cannot be given write access', async () => {
    const p = params({ scope: 'mcp:read' }); const { b, page } = await login(); const consent = await b.req('GET', authUrl(p)); ok(!/Read \+ create draft quotes/.test(consent.text), 'no write option offered');
    const r = await b.req('POST', authUrl(p), { ...p, csrf: csrfOf(consent.text), do: 'approve', access: 'write' }); const code = new URL(r.location).searchParams.get('code'); eq((await exchange(code)).data.scope, 'mcp:read');
  });

  console.log('\nRefresh tokens');
  await test('refreshing returns a new pair, kills the old access token and the old refresh token', async () => {
    const r1 = (await exchange(await getCode({ access: 'read' }))).data; const r2 = await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: clientId }); eq(r2.status, 200); ok(r2.data.access_token !== r1.access_token && r2.data.refresh_token !== r1.refresh_token);
    eq((await mcp(r1.access_token, 'tools/list')).status, 401, 'old access token dies on rotation'); eq((await mcp(r2.data.access_token, 'tools/list')).status, 200, 'new one works');
    // reuse of the OLD refresh token = theft signal: the whole family is closed
    const reuse = await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: clientId }); eq(reuse.data.error, 'invalid_grant'); eq((await mcp(r2.data.access_token, 'tools/list')).status, 401, 'family revoked'); eq((await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: r2.data.refresh_token, client_id: clientId })).data.error, 'invalid_grant');
  });
  await test('a refresh token cannot be used by a different client', async () => {
    const other = (await post(`${OA}?r=register`, { client_name: 'Other', redirect_uris: [REDIRECT] }, true)).data.client_id; const t = (await exchange(await getCode())).data;
    eq((await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other })).data.error, 'invalid_grant');
  });
  await test('unsupported grant types are refused', async () => { eq((await post(`${OA}?r=token`, { grant_type: 'password', username: 'a', password: 'b', client_id: clientId })).data.error, 'unsupported_grant_type'); eq((await post(`${OA}?r=token`, { grant_type: 'client_credentials', client_id: clientId })).data.error, 'unsupported_grant_type'); });

  console.log('\nRevocation and management');
  await test('RFC 7009 revoke closes the connection and always answers 200', async () => {
    const t = (await exchange(await getCode())).data; eq((await post(`${OA}?r=revoke`, { token: t.refresh_token })).status, 200); eq((await mcp(t.access_token, 'tools/list')).status, 401); eq((await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).data.error, 'invalid_grant');
    eq((await post(`${OA}?r=revoke`, { token: 'does-not-exist' })).status, 200);
  });
  await test('admins see each connection once and "Disconnect" closes it fully', async () => {
    const t = (await exchange(await getCode({ access: 'write' }))).data; await post(`${OA}?r=token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });   // creates a 2nd access token for the same grant
    const list = (await admin.api('GET', 'tokens')).data; const oauthRows = list.filter(x => x.oauth && !x.revoked && x.name === 'OAuth: Claude'); ok(oauthRows.length >= 1);
    const grantIds = new Set(); eq(list.filter(x => x.oauth).every(x => !('grant_id' in x)), true, 'grant ids are not exposed');
    const mine = oauthRows[0]; eq(mine.scope === 'write' || mine.scope === 'read', true); eq((await admin.api('DELETE', `tokens/${mine.id}`)).status, 200);
  });
  await test('staff cannot manage tokens', async () => { const s = new Client(BASE); await s.api('POST', 'auth/login', { email: staffEmail, password: 'staffpass1' }); eq((await s.api('GET', 'tokens')).status, 403); });
  await test('every approval and denial is in the audit log', async () => { const a = (await admin.api('GET', 'audit')).data; ok(a.some(x => x.action === 'oauth.approve' && /Claude/.test(x.detail)) && a.some(x => x.action === 'oauth.deny')); });

  console.log('\nOn / off switch');
  await test('switching OAuth off disables every endpoint and the MCP challenge; switching it on restores them', async () => {
    eq((await admin.api('PUT', 'settings', { oauth_enabled: '0' })).status, 200);
    eq((await fetch(`${OA}?r=as-metadata`)).status, 404); eq((await post(`${OA}?r=register`, { client_name: 'x', redirect_uris: [REDIRECT] }, true)).status, 403); eq((await new Browser().req('GET', authUrl(params()))).status, 403);
    const r = await fetch(`${BASE}/api/mcp.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }); ok(!/resource_metadata/.test(r.headers.get('www-authenticate') || ''), 'no OAuth hint when off');
    eq((await admin.api('PUT', 'settings', { oauth_enabled: 'maybe' })).status, 400); eq((await admin.api('PUT', 'settings', { oauth_enabled: '1' })).status, 200); eq((await fetch(`${OA}?r=as-metadata`)).status, 200);
  });
  await test('registration is rate-limited', async () => { let last = 0; for (let i = 0; i < 25; i++) { last = (await post(`${OA}?r=register`, { client_name: 'flood', redirect_uris: [REDIRECT] }, true)).status; if (last === 429) break; } eq(last, 429); });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
