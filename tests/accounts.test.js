'use strict';
/* Accounts, 2FA, password reset, e-mail. Usage: BASE=http://127.0.0.1:8766 node tests/accounts.test.js */
const { startSmtp, parseMail, totp, Client } = require('./helpers');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Accounts & e-mail tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  const stamp = Date.now();

  console.log('\nE-mail not configured yet');
  await test('quote e-mail is refused with a helpful message when e-mail is not set up', async () => {
    const q = (await admin.api('POST', 'quotes', { division: 'roofing', client: { name: 'Mail Co', email: 'client@example.com' }, title: 't', data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 1, rate: 100 }] }], tax_rate: 18 } })).data;
    const r = await admin.api('POST', `quotes/${q.id}/email`, {}); eq(r.status, 400); ok(/not set up/i.test(r.data.error), r.data.error);
  });
  await test('forgot-password answers identically for known and unknown addresses', async () => {
    const a = await new Client(BASE).api('POST', 'auth/forgot', { email: ADMIN.email }), b = await new Client(BASE).api('POST', 'auth/forgot', { email: 'nobody@example.com' });
    eq(a.status, 200); eq(b.status, 200); eq(a.data, b.data);
  });

  console.log('\nSMTP settings & secrets');
  const smtp = await startSmtp({ password: 'smtp-secret-pw' });
  await test('admin can save SMTP settings; the password is masked when read back', async () => {
    const r = await admin.api('PUT', 'settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_enc: 'none', smtp_user: 'mailer@example.com', smtp_pass: 'smtp-secret-pw', mail_from: 'quotes@example.com', mail_from_name: 'Infraura Quotes' });
    eq(r.status, 200); eq(r.data.smtp_pass, '********'); eq(r.data.smtp_user, 'mailer@example.com');
    const again = await admin.api('PUT', 'settings', { smtp_pass: '********', company_tagline: 'Roofing' }); eq(again.status, 200);   // masked value must not overwrite the real one
  });
  await test('invalid SMTP port / encryption / from address are rejected', async () => {
    eq((await admin.api('PUT', 'settings', { smtp_port: '99999' })).status, 400); eq((await admin.api('PUT', 'settings', { smtp_enc: 'rot13' })).status, 400); eq((await admin.api('PUT', 'settings', { mail_from: 'not-an-email' })).status, 400);
  });
  const staffEmail = `acct-staff-${stamp}@example.com`; const staff = new Client(BASE);
  await test('staff never receive SMTP credentials or the cron key', async () => {
    await admin.api('POST', 'users', { name: 'Staff A', email: staffEmail, password: 'staffpass1', role: 'staff' }); eq((await staff.api('POST', 'auth/login', { email: staffEmail, password: 'staffpass1' })).status, 200);
    const b = (await staff.api('GET', 'bootstrap')).data.settings; for (const k of ['smtp_pass', 'smtp_user', 'smtp_host', 'cron_key']) ok(!(k in b), k + ' leaked to staff');
    const s = (await staff.api('GET', 'settings')).data; ok(!('smtp_pass' in s) && !('cron_key' in s), 'settings GET leaks');
    const adm = (await admin.api('GET', 'bootstrap')).data.settings; ok(!JSON.stringify(adm).includes('smtp-secret-pw'), 'real password reached the browser');
  });
  await test('the test e-mail is delivered with authentication, correct headers and branded HTML', async () => {
    const r = await admin.api('POST', 'mail/test', { to: 'owner@example.com' }); eq(r.data.ok, true, r.data.error); await wait(100);
    const m = parseMail(smtp.messages.at(-1).raw); eq(smtp.messages.at(-1).to, ['owner@example.com']); eq(smtp.messages.at(-1).from, 'quotes@example.com');
    ok(/Test e-mail/.test(m.subject), m.subject); ok(/Infraura Quotes/.test(Buffer.from(/=\?UTF-8\?B\?([^?]+)/.exec(m.headers.from)[1], 'base64').toString()), 'from name'); ok(/test message/i.test(m.text) && /<h2/.test(m.html), 'text + html parts');
    eq(smtp.auth.seen.slice(0, 2), ['mailer@example.com', 'smtp-secret-pw'], 'AUTH LOGIN used');
  });
  await test('wrong SMTP password gives a readable error and never echoes the password', async () => {
    await admin.api('PUT', 'settings', { smtp_pass: 'wrong-password' }); const r = await admin.api('POST', 'mail/test', { to: 'owner@example.com' });
    eq(r.data.ok, false); ok(/535|Authentication/i.test(r.data.error), r.data.error); ok(!r.data.error.includes('wrong-password'), 'password leaked in error');
    await admin.api('PUT', 'settings', { smtp_pass: 'smtp-secret-pw' });
    const log = (await admin.api('GET', 'mail/log')).data; ok(log.some(l => l.status === 'failed') && log.some(l => l.status === 'sent'), 'e-mail log has both');
  });

  console.log('\nE-mailing a quote');
  let qid, before;
  await test('"e-mail to client" sends the link, marks the quote sent and logs it', async () => {
    const q = (await admin.api('POST', 'quotes', { division: 'interior', client: { name: 'Mail Co', contact_person: 'Meera', email: 'meera@example.com' }, title: 'Flat interior', data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 2, rate: 500 }] }], tax_rate: 18 } })).data; qid = q.id; before = smtp.messages.length;
    const r = await admin.api('POST', `quotes/${qid}/email`, { message: 'Dear Meera, here is the quote we discussed.' }); eq(r.status, 200, JSON.stringify(r.data)); eq(r.data.to, 'meera@example.com'); await wait(100);
    const m = parseMail(smtp.messages.at(-1).raw); ok(/Quotation INF\/IN/.test(m.subject), m.subject); ok(/here is the quote we discussed/.test(m.text), 'custom message'); const link = /view\.html\?t=([a-f0-9]{32})/.exec(m.html); ok(link, 'public link in mail');
    const pub = await fetch(`${BASE}/api/public.php?r=quote&t=${link[1]}`); eq(pub.status, 200);
    const g = (await admin.api('GET', `quotes/${qid}`)).data; eq(g.quote.status, 'sent'); ok(g.events.some(e => e.type === 'emailed'), 'emailed event');
  });
  await test('header-injection attempts in the recipient are refused', async () => {
    const n = smtp.messages.length; const r = await admin.api('POST', `quotes/${qid}/email`, { to: 'a@example.com\r\nBcc: evil@example.com' }); eq(r.status, 400); eq(smtp.messages.length, n, 'nothing sent');
  });
  await test('a mail-server rejection is reported to the user', async () => {
    const bad = await startSmtp({ rejectData: true }); await admin.api('PUT', 'settings', { smtp_port: String(bad.port), smtp_user: '', smtp_pass: '' });
    const r = await admin.api('POST', `quotes/${qid}/email`, { to: 'x@example.com' }); eq(r.status, 400); ok(/could not be sent/i.test(r.data.error), r.data.error);
    await admin.api('PUT', 'settings', { smtp_port: String(smtp.port) }); bad.close();
  });

  console.log('\nForgot / reset password');
  let resetUrlToken;
  await test('forgot-password e-mails a one-hour link to a real user only', async () => {
    const n = smtp.messages.length; const c = new Client(BASE);
    await c.api('POST', 'auth/forgot', { email: 'ghost@example.com' }); await wait(100); eq(smtp.messages.length, n, 'no mail for unknown address');
    await c.api('POST', 'auth/forgot', { email: staffEmail }); await wait(150); eq(smtp.messages.length, n + 1, 'one mail for the real address'); eq(smtp.messages.at(-1).to, [staffEmail]);
    const m = parseMail(smtp.messages.at(-1).raw); const t = /#\/reset\/([a-f0-9]{48})/.exec(m.html); ok(t, 'reset token link'); resetUrlToken = t[1];
  });
  await test('forgot-password is rate-limited per address', async () => {
    const c = new Client(BASE); let last = 0; for (let i = 0; i < 6; i++) last = (await c.api('POST', 'auth/forgot', { email: staffEmail })).status; eq(last, 429);
  });
  await test('the reset link sets a new password once; the old password and a reused link fail', async () => {
    const c = new Client(BASE); eq((await c.api('POST', 'auth/reset', { token: 'f'.repeat(48), password: 'whatever123' })).status, 400, 'bad token'); eq((await c.api('POST', 'auth/reset', { token: resetUrlToken, password: 'short' })).status, 400, 'short password');
    eq((await c.api('POST', 'auth/reset', { token: resetUrlToken, password: 'brand-new-pass-1' })).status, 200);
    eq((await c.api('POST', 'auth/reset', { token: resetUrlToken, password: 'another-pass-22' })).status, 400, 'reuse'); eq((await new Client(BASE).api('POST', 'auth/login', { email: staffEmail, password: 'staffpass1' })).status, 401, 'old password');
    eq((await new Client(BASE).api('POST', 'auth/login', { email: staffEmail, password: 'brand-new-pass-1' })).status, 200);
  });

  console.log('\nAdmin password reset & forced change');
  await test('admin reset gives a temporary password; the user must change it before doing anything else', async () => {
    const list = (await admin.api('GET', 'users')).data; const uid = list.find(u => u.email === staffEmail).id;
    const r = await admin.api('POST', `users/${uid}/reset-password`, {}); eq(r.status, 200); ok(r.data.temp_password.length >= 10);
    const s = new Client(BASE); const login = await s.api('POST', 'auth/login', { email: staffEmail, password: r.data.temp_password }); eq(login.status, 200); eq(login.data.must_change, true);
    eq((await s.api('GET', 'bootstrap')).status, 428, 'blocked until password changed'); eq((await s.api('POST', 'auth/password', { current: r.data.temp_password, new: r.data.temp_password })).status, 400, 'same password refused');
    eq((await s.api('POST', 'auth/password', { current: r.data.temp_password, new: 'my-own-secret-9' })).status, 200); eq((await s.api('GET', 'bootstrap')).status, 200, 'unblocked');
  });
  await test('staff cannot reset other people\'s passwords', async () => {
    const s = new Client(BASE); await s.api('POST', 'auth/login', { email: staffEmail, password: 'my-own-secret-9' }); const uid = (await admin.api('GET', 'users')).data[0].id; eq((await s.api('POST', `users/${uid}/reset-password`, {})).status, 403);
  });

  console.log('\nLast-admin protection & roles');
  await test('the only admin cannot be demoted or deleted; a second admin makes it possible', async () => {
    const admins = (await admin.api('GET', 'users')).data.filter(u => u.role === 'admin'); ok(admins.length >= 1);
    if (admins.length === 1) { eq((await admin.api('PUT', `users/${admins[0].id}`, { role: 'staff' })).status, 409); eq((await admin.api('DELETE', `users/${admins[0].id}`)).status, 400, 'cannot delete yourself'); }
    const two = `acct-admin2-${stamp}@example.com`; await admin.api('POST', 'users', { name: 'Admin Two', email: two, password: 'adminpass22', role: 'admin' });
    const a2 = new Client(BASE); await a2.api('POST', 'auth/login', { email: two, password: 'adminpass22' }); const me = (await admin.api('GET', 'users')).data.find(u => u.email === two);
    eq((await a2.api('PUT', `users/${me.id}`, { role: 'staff' })).status, 200, 'demote self allowed when another admin exists');
    const others = (await admin.api('GET', 'users')).data.filter(u => u.role === 'admin'); eq(others.length, 1); eq((await admin.api('PUT', `users/${others[0].id}`, { role: 'staff' })).status, 409, 'back to one admin');
    eq((await admin.api('DELETE', `users/${me.id}`)).status, 200);
  });

  console.log('\nTwo-step sign-in (TOTP)');
  const tEmail = `acct-2fa-${stamp}@example.com`; let secret, recovery; const me2 = new Client(BASE);
  await test('a user can set up 2FA with an authenticator secret and gets 8 recovery codes', async () => {
    await admin.api('POST', 'users', { name: 'Two Factor', email: tEmail, password: 'twofactor-pw1', role: 'staff' }); await me2.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1' });
    const s = await me2.api('POST', 'auth/2fa/setup'); eq(s.status, 200); ok(/^[A-Z2-7]{32}$/.test(s.data.secret), 'secret'); ok(s.data.uri.startsWith('otpauth://totp/'), 'uri'); secret = s.data.secret;
    eq((await me2.api('POST', 'auth/2fa/enable', { code: '000000' })).status, 400, 'wrong code'); const e = await me2.api('POST', 'auth/2fa/enable', { code: totp(secret) }); eq(e.status, 200); eq(e.data.recovery_codes.length, 8); recovery = e.data.recovery_codes;
  });
  await test('sign-in now needs a code: none -> asks for it, wrong -> 401, right -> OK', async () => {
    const c = new Client(BASE); const a = await c.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1' }); eq(a.data.need_2fa, true); eq((await c.api('GET', 'bootstrap')).status, 401, 'no session yet');
    eq((await c.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code: '123456' })).status, 401);
    await wait(30); const ok1 = await c.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code: totp(secret, Date.now(), 0) }); ok([200, 401].includes(ok1.status));
  });
  await test('a code cannot be replayed, and codes from the neighbouring 30-second window work', async () => {
    const c = new Client(BASE); const fresh = totp(secret, Date.now(), 1);
    const r1 = await c.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code: fresh }); eq(r1.status, 200, 'next-window code accepted');
    const r2 = await new Client(BASE).api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code: fresh }); eq(r2.status, 401, 'replay refused');
  });
  await test('a recovery code works exactly once', async () => {
    const code = recovery[0]; eq((await new Client(BASE).api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code })).status, 200);
    eq((await new Client(BASE).api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code })).status, 401, 'second use');
  });
  await test('repeated wrong codes lock sign-in (brute-force protection)', async () => {
    const c = new Client(BASE); let last = 0; for (let i = 0; i < 8; i++) last = (await c.api('POST', 'auth/login', { email: tEmail, password: 'twofactor-pw1', code: String(100000 + i) })).status; eq(last, 429);
  });
  await test('an admin can switch 2FA off for someone who lost their phone', async () => {
    const uid = (await admin.api('GET', 'users')).data.find(u => u.email === tEmail); eq(uid.totp_enabled, 1);
    eq((await admin.api('POST', `users/${uid.id}/disable-2fa`, {})).status, 200); eq((await admin.api('GET', 'users')).data.find(u => u.email === tEmail).totp_enabled, 0);
  });

  smtp.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
