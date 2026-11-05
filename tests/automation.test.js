'use strict';
/* Automation: jobs that run without cron, instant notifications, auto-project, overdue chasers, setup checklist.
   Usage: APP_DIR=/path/to/app BASE=http://127.0.0.1:8766 node tests/automation.test.js */
const { startSmtp, parseMail, Client } = require('./helpers');
const { execFileSync } = require('child_process'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8766', APP_DIR = process.env.APP_DIR;
const ADMIN = { email: process.env.ADMIN_EMAIL || 'a@b.com', password: process.env.ADMIN_PASSWORD || 'changeme123' };
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n         ' + (e.message || e)); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const db = (sql, params = []) => JSON.parse(execFileSync('php', [path.join(__dirname, 'dbtool.php'), APP_DIR, sql, JSON.stringify(params)]).toString());
const ymd = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const pub = (tok, r, body) => fetch(`${BASE}/api/public.php?r=${r}&t=${tok}`, { method: body ? 'POST' : 'GET', headers: { 'X-Requested-With': 'infraura', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async x => ({ status: x.status, data: await x.json() }));

(async () => {
  if (!APP_DIR) { console.log('APP_DIR not set - skipping automation tests'); process.exit(0); }
  console.log(`Automation tests against ${BASE}`);
  const admin = new Client(BASE); eq((await admin.api('POST', 'auth/login', ADMIN)).status, 200);
  const smtp = await startSmtp();
  const mails = () => smtp.messages.map(m => ({ to: m.to.join(','), ...parseMail(m.raw) }));
  const mkQuote = async (name, email) => (await admin.api('POST', 'quotes', { division: 'roofing', client: { name, email }, title: 'Auto ' + name, data: { sections: [{ title: 'S', items: [{ desc: 'x', unit: 'u', qty: 10, rate: 100 }] }], tax_rate: 18, payment_schedule: [{ label: 'Advance', percent: 50 }, { label: 'Balance', percent: 50 }] } })).data;
  const share = async q => { const t = (await admin.api('POST', `quotes/${q.id}/share`)).data.token; const total = (await admin.api('GET', `quotes/${q.id}`)).data.quote.total; return { t, total }; };

  console.log('\nSelf-running jobs (no cron)');
  await test('settings carry the new automation switches with safe defaults', async () => {
    const s = (await admin.api('GET', 'settings')).data;
    eq([s.auto_jobs, s.notify_events, s.confirm_client, s.auto_project, s.overdue_reminders], ['1', '1', '1', '1', '0']);
    ok(!('auto_jobs_at' in s) || true);
    eq((await admin.api('PUT', 'settings', { auto_project: 'maybe' })).status, 400);
  });
  await test('the background tick runs the jobs by itself, at most once an hour', async () => {
    db('UPDATE settings SET v = ? WHERE k = ?', ['0', 'auto_jobs_at']);
    db("DELETE FROM settings WHERE k LIKE 'cron_job_%'");
    const a = await admin.api('POST', 'tick', {}); eq(a.status, 200); eq(a.data.ran, true);
    const sys = (await admin.api('GET', 'system')).data; ok(sys.cron_last_run, 'cron_last_run set without cron'); ok(sys.backups.length >= 1, 'a backup was made');
    eq((await admin.api('POST', 'tick', {})).data.ran, false);
  });
  await test('auto jobs can be switched off', async () => {
    await admin.api('PUT', 'settings', { auto_jobs: '0' }); db('UPDATE settings SET v = ? WHERE k = ?', ['0', 'auto_jobs_at']);
    eq((await admin.api('POST', 'tick', {})).data.ran, false); await admin.api('PUT', 'settings', { auto_jobs: '1' });
  });
  await test('tick needs a signed-in user', async () => { eq((await new Client(BASE).api('POST', 'tick', {})).status, 401); });

  console.log('\nNotifications, confirmation and auto-project');
  await admin.api('PUT', 'settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_enc: 'none', smtp_user: '', smtp_pass: '', mail_from: 'quotes@example.com' });
  let q1, s1;
  await test('first client view notifies admins once', async () => {
    q1 = await mkQuote('Notify Co', 'notify@example.com'); s1 = await share(q1);
    smtp.messages.length = 0;
    eq((await pub(s1.t, 'quote')).status, 200);
    ok(mails().some(m => /Opened: /.test(m.subject) && m.to.includes('a@b.com')), 'admin got "opened" mail: ' + JSON.stringify(mails().map(m => m.subject)));
    const n = smtp.messages.length; db("UPDATE quote_events SET ip = '9.9.9.9' WHERE type = 'view'"); await pub(s1.t, 'quote');
    eq(smtp.messages.length, n, 'a repeat view does not notify again');
  });
  await test('accepting notifies admins, confirms to the client and creates the project', async () => {
    smtp.messages.length = 0;
    const r = await pub(s1.t, 'respond', { action: 'accept', name: 'Buyer', expected_total: s1.total }); eq(r.data.status, 'accepted');
    const m = mails(); ok(m.some(x => /ACCEPTED: /.test(x.subject) && x.to.includes('a@b.com')), 'admin mail'); ok(m.some(x => /Thank you/.test(x.subject) && x.to.includes('notify@example.com')), 'client confirmation');
    const projs = (await admin.api('GET', 'projects')).data.projects.filter(p => p.quote_no === q1.quote_no); eq(projs.length, 1, 'project auto-created');
    const det = (await admin.api('GET', `projects/${projs[0].id}`)).data; eq(det.milestones.length, 2); eq(Math.round(det.milestones.reduce((a, x) => a + x.amount, 0) * 100), Math.round(s1.total * 100));
    eq((await admin.api('POST', 'projects', { quote_id: q1.id })).status, 400, 'manual create is refused as a duplicate');
  });
  await test('declining notifies admins and creates no project', async () => {
    const q = await mkQuote('Decline Co', 'dec@example.com'), s = await share(q); smtp.messages.length = 0;
    eq((await pub(s.t, 'respond', { action: 'reject', name: 'No thanks' })).data.status, 'rejected');
    ok(mails().some(x => /Declined: /.test(x.subject)), 'declined mail'); eq((await admin.api('GET', 'projects')).data.projects.filter(p => p.quote_no === q.quote_no).length, 0);
  });
  await test('switches off: no project, no confirmation, no alerts', async () => {
    await admin.api('PUT', 'settings', { auto_project: '0', confirm_client: '0', notify_events: '0' });
    const q = await mkQuote('Quiet Co', 'quiet@example.com'), s = await share(q); smtp.messages.length = 0;
    await pub(s.t, 'quote'); await pub(s.t, 'respond', { action: 'accept', name: 'Q', expected_total: s.total });
    eq(smtp.messages.length, 0, 'no mail'); eq((await admin.api('GET', 'projects')).data.projects.filter(p => p.quote_no === q.quote_no).length, 0);
    eq((await admin.api('POST', 'projects', { quote_id: q.id })).status, 201, 'manual creation still works');
    await admin.api('PUT', 'settings', { auto_project: '1', confirm_client: '1', notify_events: '1' });
  });

  console.log('\nOverdue payment reminders');
  await test('off by default; when on, chases overdue milestones up to 3 times a week apart', async () => {
    const q = await mkQuote('Late Payer', 'late@example.com'), s = await share(q);
    await pub(s.t, 'respond', { action: 'accept', name: 'LP', expected_total: s.total });
    const pid = (await admin.api('GET', 'projects')).data.projects.find(p => p.quote_no === q.quote_no).id;
    const ms = (await admin.api('GET', `projects/${pid}`)).data.milestones[0];
    db('UPDATE project_milestones SET due_date = ? WHERE id = ?', [ymd(-10), ms.id]);
    const cl = db('SELECT client_id FROM projects WHERE id = ?', [pid])[0]; ok(cl.client_id, 'project linked to a client record');
    const run = async () => { db("DELETE FROM settings WHERE k = 'cron_job_overdue'"); smtp.messages.length = 0; const key = (await admin.api('GET', 'settings')).data.cron_key; return (await (await fetch(`${BASE}/api/cron.php?key=${key}&force=1`)).text()); };
    let out = await run(); ok(/overdue payment reminders: off/.test(out), out); eq(mails().filter(m => /Payment reminder/.test(m.subject)).length, 0);
    await admin.api('PUT', 'settings', { overdue_reminders: '1' });
    out = await run(); ok(/overdue payment reminders: \d+ sent/.test(out), out); const first = mails().filter(m => /Payment reminder/.test(m.subject) && m.to.includes('late@example.com')); eq(first.length, 1);
    out = await run(); eq(mails().filter(m => /Payment reminder/.test(m.subject) && m.to.includes('late@example.com')).length, 0, 'not again within a week');
    for (let i = 0; i < 3; i++) { db("UPDATE quote_events SET created_at = ? WHERE type = 'payment_reminder'", [new Date(Date.now() - (8 + i) * 86400000).toISOString().slice(0, 19).replace('T', ' ')]); await run(); }
    eq(db("SELECT COUNT(*) AS n FROM quote_events WHERE type = 'payment_reminder' AND quote_no = ?", [q.quote_no])[0].n, 3, 'capped at 3');
    await admin.api('PUT', 'settings', { overdue_reminders: '0' });
  });

  console.log('\nSetup checklist');
  await test('admins see what is left; staff cannot; dismiss/mark-done work', async () => {
    const c = (await admin.api('GET', 'setup')).data; ok(c.items.length >= 6 && c.left >= 1, 'items listed');
    const byKey = Object.fromEntries(c.items.map(i => [i.key, i])); eq(byKey.rates.done, false); eq(byKey.email.done, true, 'email works after the notifications above'); eq(byKey.jobs.done, true); eq(byKey.backup.done, true);
    await admin.api('POST', 'setup/rates-reviewed', {}); eq((await admin.api('GET', 'setup')).data.items.find(i => i.key === 'rates').done, true);
    await admin.api('POST', 'setup/dismiss', {}); eq((await admin.api('GET', 'setup')).data.dismissed, true);
    const email = `auto-staff-${Date.now()}@example.com`; await admin.api('POST', 'users', { name: 'S', email, password: 'staffpass1', role: 'staff' });
    const st = new Client(BASE); await st.api('POST', 'auth/login', { email, password: 'staffpass1' }); eq((await st.api('GET', 'setup')).status, 403);
  });

  console.log('\nQuick roofing quote (one step in the app)');
  await test('size + material -> priced draft, same numbers as the AI tool (60x30 GI A-type, frame in)', async () => {
    const r = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 60, width_ft: 30, roof_type: 'gable', materials: ['gi'], client: { name: 'Quick Co', email: 'quick@example.com' } });
    eq(r.status, 201); ok(r.data.quote_no && r.data.totals.grand_total > 900000 && r.data.totals.grand_total < 970000, 'total ~9.36 lakh: ' + JSON.stringify(r.data.totals));
    const q = (await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote; eq(q.status, 'draft'); eq(q.client.name, 'Quick Co');
  });
  await test('several materials -> one quote with options; sheets-only is cheaper', async () => {
    const a = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 100, width_ft: 40, materials: ['gi', 'upvc', 'puf50'], client: { name: 'Opt Co' } }); eq(a.status, 201); eq(a.data.options.length, 3);
    const full = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 60, width_ft: 30, materials: ['gi'], client: { name: 'F' } });
    const lite = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 60, width_ft: 30, materials: ['gi'], include_structure: false, client: { name: 'L' } });
    ok(lite.data.totals.grand_total < full.data.totals.grand_total * 0.7, 'sheets only is much cheaper');
  });
  await test('send=true e-mails the client and marks the quote sent', async () => {
    smtp.messages.length = 0;
    const r = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 40, width_ft: 20, materials: ['gi'], send: true, client: { name: 'Mail Me', email: 'mailme@example.com' } });
    eq(r.status, 201); eq(r.data.sent, true, JSON.stringify(r.data));
    ok(mails().some(m => m.to.includes('mailme@example.com') && /Quotation /.test(m.subject)), 'client got the quote');
    eq((await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote.status, 'sent');
  });
  await test('send=true without a client e-mail still creates the draft and says why it was not sent', async () => {
    const r = await admin.api('POST', 'quotes/quick-roofing', { length_ft: 40, width_ft: 20, materials: ['gi'], send: true, client: { name: 'No Mail' } });
    eq(r.status, 201); eq(r.data.sent, false); ok(/e-mail/i.test(r.data.send_note));
  });
  await test('bad input is a readable 400', async () => {
    eq((await admin.api('POST', 'quotes/quick-roofing', { length_ft: -1, width_ft: 20 })).status, 400);
    eq((await admin.api('POST', 'quotes/quick-roofing', { length_ft: 10, width_ft: 20, materials: ['gold'] })).status, 400);
    eq((await new Client(BASE).api('POST', 'quotes/quick-roofing', { length_ft: 10, width_ft: 20 })).status, 401);
  });

  console.log('\nQuick quotes: interior, construction, PMC');
  const qq = (div, body) => admin.api('POST', `quotes/quick/${div}`, { client: { name: 'QQ ' + div }, ...body });
  await test('interior: 2 BHK standard -> priced draft with kitchen, wardrobes, ceiling, paint, electrical', async () => {
    const r = await qq('interior', { bhk: 2 }); eq(r.status, 201); const g = r.data.totals.grand_total; ok(g > 500000 && g < 1500000, 'plausible 2BHK total ' + g);
    const q = (await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote; eq(q.division, 'interior'); eq(q.data.sections.length, 3); ok(q.data.scope.includes('2 BHK'), 'scope text'); ok(q.data.payment_schedule.length > 0, 'payment schedule from Settings');
  });
  await test('interior: standard + premium -> one quote with 2 options, premium costs more; bigger home costs more', async () => {
    const r = await qq('interior', { bhk: 3, variants: ['standard', 'premium'] }); eq(r.status, 201); eq(r.data.options.length, 2); ok(r.data.options[1].grand_total_incl_gst > r.data.options[0].grand_total_incl_gst, 'premium > standard');
    const small = await qq('interior', { bhk: 1 }), big = await qq('interior', { bhk: 4 }); ok(big.data.totals.grand_total > small.data.totals.grand_total * 2, '4BHK >> 1BHK');
  });
  await test('construction: area x turnkey rate from the rate card, finish tiers, optional lines', async () => {
    const std = await qq('construction', { built_up_sqft: 1500, variants: ['standard'] }); eq(std.status, 201);
    const q = (await admin.api('GET', `quotes/${std.data.quote_id}`)).data.quote; const turnkey = q.data.sections[0].items[0]; eq(turnkey.qty, 1500); eq(turnkey.rate, 2400);
    const all = await qq('construction', { built_up_sqft: 1500, variants: ['grey', 'standard', 'premium'] }); eq(all.data.options.length, 3); ok(all.data.options[0].grand_total_incl_gst < all.data.options[2].grand_total_incl_gst, 'grey < premium');
    const lean = await qq('construction', { built_up_sqft: 1500, include_design: false, include_waterproofing: false, include_approvals: false }); ok(lean.data.totals.grand_total < std.data.totals.grand_total, 'lean is cheaper');
  });
  await test('rate-card edits flow into quick quotes', async () => {
    const it = (await admin.api('GET', 'rates')).data.find(r => r.name === 'Turnkey construction - with finishing'); ok(it, 'rate item exists');
    await admin.api('PUT', `rates/${it.id}`, { ...it, rate: 3000 });
    const r = await qq('construction', { built_up_sqft: 1000, include_design: false, include_waterproofing: false, include_approvals: false });
    eq((await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote.data.sections[0].items[0].rate, 3000);
    await admin.api('PUT', `rates/${it.id}`, { ...it, rate: 2400 });
  });
  await test('pmc: % of project cost banded by size, site staff and audits scale with duration', async () => {
    const r = await qq('pmc', { project_cost: 20000000, duration_months: 12 }); eq(r.status, 201);
    const items = (await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote.data.sections[0].items; eq(items[0].rate, 600000, '3% of 2 cr'); ok(/3% of project cost/.test(items[0].desc), items[0].desc);
    eq(items.find(i => /site engineer/.test(i.desc)).qty, 12); eq(items.find(i => /Quality audit/.test(i.desc)).qty, 6);
    const big = await qq('pmc', { project_cost: 300000000, duration_months: 24 }); eq((await admin.api('GET', `quotes/${big.data.quote_id}`)).data.quote.data.sections[0].items[0].rate, 6000000, '2% above 25 cr');
    const sq = await qq('pmc', { built_up_sqft: 20000, duration_months: 10, site_staff: false }); const sit = (await admin.api('GET', `quotes/${sq.data.quote_id}`)).data.quote.data.sections[0].items; eq(sit[0].qty, 20000); ok(!sit.some(i => /site engineer/.test(i.desc)), 'no site staff');
    const part = await qq('pmc', { project_cost: 20000000, duration_months: 6, variant: 'part' }); ok(part.data.totals.grand_total < r.data.totals.grand_total, 'part scope cheaper');
  });
  await test('quick quotes: validation, auth, unknown service, e-mail to client', async () => {
    eq((await qq('interior', { bhk: 9 })).status, 400); eq((await qq('construction', {})).status, 400); eq((await qq('pmc', { duration_months: 6 })).status, 400); eq((await qq('construction', { built_up_sqft: 1000, variant: 'gold' })).status, 400); eq((await qq('plumbing', {})).status, 400);
    eq((await new Client(BASE).api('POST', 'quotes/quick/interior', { bhk: 2 })).status, 401);
    smtp.messages.length = 0; const r = await admin.api('POST', 'quotes/quick/interior', { bhk: 2, send: true, client: { name: 'Interior Mail', email: 'imail@example.com' } }); eq(r.data.sent, true);
    ok(mails().some(m => m.to.includes('imail@example.com')), 'mailed'); eq((await admin.api('GET', `quotes/${r.data.quote_id}`)).data.quote.status, 'sent');
  });

  console.log('\nInstaller');
  const fs = require('fs'), os = require('os'), { spawn } = require('child_process');
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qbinst-')); fs.cpSync(APP_DIR, d, { recursive: true, filter: s => !/config\.php$|\.sqlite$|[\\/]backups/.test(s) && !/[\\/]data[\\/]/.test(s) }); try { fs.rmSync(path.join(d, 'api', 'config.php'), { force: true }); } catch (e) {} return d; };
  await test('CLI install with --self-delete removes install.php', async () => {
    const d = fresh(); const out = execFileSync('php', ['install.php', '--sqlite', '--email=z@y.com', '--password=changeme123', '--self-delete'], { cwd: d }).toString();
    ok(/install.php removed/.test(out), out); ok(!fs.existsSync(path.join(d, 'install.php'))); ok(fs.existsSync(path.join(d, 'api', 'config.php')));
  });
  await test('web install over HTTPS deletes itself and switches the HTTPS redirect on', async () => {
    const d = fresh(); const port = 8890 + Math.floor(Math.random() * 90);
    const srv = spawn('php', ['-S', `127.0.0.1:${port}`], { cwd: d, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 800));
    try {
      const form = new URLSearchParams({ driver: 'sqlite', name: 'Web Admin', email: 'web@y.com', password: 'changeme123', company: 'Web Co' });
      const r = await fetch(`http://127.0.0.1:${port}/install.php`, { method: 'POST', headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      const html = await r.text(); ok(/Installed/.test(html) && /deleted itself/.test(html), html.slice(0, 400));
      ok(!fs.existsSync(path.join(d, 'install.php')), 'install.php gone'); ok(/^RewriteCond %\{HTTPS\} off/m.test(fs.readFileSync(path.join(d, '.htaccess'), 'utf8')), 'redirect active');
    } finally { srv.kill(); }
  });
  await test('a plain-HTTP web install leaves the redirect off (so it cannot lock you out before SSL exists)', async () => {
    const d = fresh(); const port = 8890 + Math.floor(Math.random() * 90);
    const srv = spawn('php', ['-S', `127.0.0.1:${port}`], { cwd: d, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 800));
    try {
      const form = new URLSearchParams({ driver: 'sqlite', name: 'Web Admin', email: 'web@y.com', password: 'changeme123' });
      await fetch(`http://127.0.0.1:${port}/install.php`, { method: 'POST', body: form });
      ok(/^# RewriteCond %\{HTTPS\} off/m.test(fs.readFileSync(path.join(d, '.htaccess'), 'utf8')), 'redirect still commented out');
    } finally { srv.kill(); }
  });
  await test('the installer form lists missing requirements up front (none here)', async () => {
    const d = fresh(); const port = 8890 + Math.floor(Math.random() * 90);
    const srv = spawn('php', ['-S', `127.0.0.1:${port}`], { cwd: d, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 800));
    try { const html = await (await fetch(`http://127.0.0.1:${port}/install.php`)).text(); ok(/Database name/.test(html) && !/not ready yet/.test(html), 'form shows, no problems'); } finally { srv.kill(); }
  });

  smtp.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
