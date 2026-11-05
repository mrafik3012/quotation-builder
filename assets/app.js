'use strict';
/* Infraura Quotation Builder — core: helpers, auth, router, dashboard, quotes list, clients, rate cards, settings */

const API = 'api/index.php?r=';
const DIVS = { roofing: 'Sheet Roofing', interior: 'Interior', construction: 'Construction', pmc: 'PMC' };
const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Superseded' };
const UNITS = ['sq ft', 'rft', 'nos', 'kg', 'cum', 'sq m', 'rmt', 'lot', 'set', 'month', 'visit', '%'];
const S = { user: null, settings: {}, clients: [], rates: [] };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
// Money rounding: half away from zero on the exact decimal value (floating-point noise removed first).
// api/lib.php money() is the identical algorithm - totals must match to the paisa on screen, in print and in the database.
const r2 = x => { const y = Math.abs(x) * 100; return (x < 0 ? -1 : 1) * Math.floor(Math.round(y * 1e4) / 1e4 + 0.5) / 100; };
const fmt = x => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x || 0);
const inr = x => '₹ ' + fmt(x);
const inr0 = x => '₹ ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(x || 0);
const fdate = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${dd}-${m}-${y}`; };
const today = () => new Date().toLocaleDateString('en-CA');
const addDays = (iso, days) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toLocaleDateString('en-CA'); };
const monthLabel = ym => { const [y, m] = ym.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + ' ' + y.slice(2); };
const divChip = d => `<span class="chip div">${esc(DIVS[d] || d)}</span>`;
const statusChip = s => `<span class="chip ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const divOptions = (sel, all) => (all ? `<option value="">All divisions</option>` : '') + Object.entries(DIVS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');

/* ---------- numbers to words (Indian system) ---------- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = x => x < 20 ? ONES[x] : TENS[Math.floor(x / 10)] + (x % 10 ? ' ' + ONES[x % 10] : '');
const three = x => (x >= 100 ? ONES[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
function intWords(x) {
  if (x === 0) return 'Zero';
  const parts = [];
  const cr = Math.floor(x / 1e7); x %= 1e7;
  const lk = Math.floor(x / 1e5); x %= 1e5;
  const th = Math.floor(x / 1e3); x %= 1e3;
  if (cr) parts.push(three(cr) + ' Crore');
  if (lk) parts.push(two(lk) + ' Lakh');
  if (th) parts.push(two(th) + ' Thousand');
  if (x) parts.push(three(x));
  return parts.join(' ');
}
function amountWords(v) {
  v = Math.round((v || 0) * 100) / 100;
  const rs = Math.floor(v), ps = Math.round((v - rs) * 100);
  return 'Rupees ' + intWords(rs) + (ps ? ' and ' + two(ps) + ' Paise' : '') + ' Only';
}

/* ---------- UI helpers ---------- */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 2800);
}
function openModal(html, wide) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  o.addEventListener('mousedown', e => { if (e.target === o) close(); });
  return { el: o.firstElementChild, close };
}
function confirmBox(msg) { return window.confirm(msg); }
async function api(path, method = 'GET', body) {
  const opt = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'infraura' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(API + path, opt); } catch (e) { throw new Error('Network error — check your connection'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (res.status === 401 && path !== 'auth/login' && path !== 'auth/me') { S.user = null; showLogin(); throw new Error('Session expired'); }
  if (res.status === 428 && S.user) { showMustChange(); throw new Error('Session expired'); }
  if (res.status === 503 && data && data.error === 'not_installed') throw new Error('Not installed yet — open install.php on your server first');
  if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
  return data;
}
async function guard(fn) { try { return await fn(); } catch (e) { if (e.message !== 'Session expired') toast(e.message, 'err'); } }
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- auth / boot ---------- */
/** Scrollable areas must be reachable by keyboard (WCAG 2.1.1): give them focus + a name. Runs whenever the page changes. */
function a11yScrollables() {
  $$('.scroll, [style*="overflow:auto"], [style*="overflow-x:auto"]').forEach(el => { if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; el.setAttribute('role', 'region'); el.setAttribute('aria-label', el.getAttribute('aria-label') || 'Scrollable content'); } });
}
async function init() {
  let tm; new MutationObserver(() => { clearTimeout(tm); tm = setTimeout(a11yScrollables, 60); }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', e => { if (window.__dirty) { e.preventDefault(); e.returnValue = ''; } });
  const rm = /^#\/reset\/([a-f0-9]{48})$/.exec(location.hash);
  if (rm) return showReset(rm[1]);
  try {
    const me = await api('auth/me');
    if (!me.user) return showLogin();
    S.user = me.user;
    if (me.must_change) return showMustChange();
    await loadBootstrap();
    route();
    tick();
    setInterval(() => { if (S.user) { api('auth/me').catch(() => {}); tick(); } }, 8 * 60 * 1000); // keep the session alive while a long quote is being edited
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><img class="logo" src="assets/logo.png" alt="Infraura"><h1>Quotation Builder</h1><p class="muted">${esc(e.message)}</p></div>`;
  }
}
async function refreshClients() { const r = await api('clients&per=300&recent=1'); S.clients = r.rows.reverse(); }
async function loadBootstrap() {
  const b = await api('bootstrap');
  S.user = b.user; S.settings = b.settings; S.clients = b.clients; S.rates = b.rates; S.templates = b.templates || [];
}
function authShell(inner) {
  document.body.classList.remove('printmode');
  $('#app').innerHTML = `<main class="login"><img class="logo" src="assets/logo.png" alt="Infraura"><h1>Quotation Builder</h1>${inner}</main>`;
}
function showLogin(prefill = {}) {
  authShell(`<form id="lf"><p class="muted" style="margin:0 0 16px">Sign in to continue</p>
  <label class="f"><span>Email</span><input type="email" name="email" required autofocus autocomplete="username" value="${esc(prefill.email || '')}"></label>
  <label class="f"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
  <label class="f" id="codebox" style="display:${prefill.need2fa ? 'block' : 'none'}"><span>6-digit code from your authenticator app (or a recovery code)</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></label>
  <button class="btn pri" style="width:100%;justify-content:center">Sign in</button>
  <p class="small" style="text-align:center;margin:14px 0 0"><a href="#" id="forgot">Forgot password?</a></p></form>`);
  $('#forgot').onclick = e => { e.preventDefault(); showForgot($('#lf').email.value); };
  if (prefill.need2fa) $('#lf').code.focus();
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f); btn.disabled = true;
    try {
      const r = await api('auth/login', 'POST', { email: f.email.value, password: f.password.value, code: f.code.value });
      if (r.need_2fa) { $('#codebox').style.display = 'block'; f.code.focus(); toast('Enter the code from your authenticator app', ''); btn.disabled = false; return; }
      S.user = r.user;
      if (r.must_change) return showMustChange();
      await loadBootstrap(); location.hash = '#/dashboard'; route();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  };
}
function showForgot(email = '') {
  authShell(`<form id="ff"><p class="muted" style="margin:0 0 16px">Enter your e-mail and we will send a link to choose a new password.</p>
  <label class="f"><span>Email</span><input type="email" name="email" required autofocus value="${esc(email)}"></label>
  <button class="btn pri" style="width:100%;justify-content:center">Send reset link</button><p class="small" style="text-align:center;margin:14px 0 0"><a href="#" id="back">Back to sign in</a></p></form>`);
  $('#back').onclick = e => { e.preventDefault(); showLogin(); };
  $('#ff').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try { const r = await api('auth/forgot', 'POST', { email: f.email.value });
      $('#ff').innerHTML = `<p>${r.mail_configured ? 'If that address belongs to an account, a reset link is on its way. It works for one hour.' : 'E-mail has not been set up for this site yet. Please ask your administrator to reset your password (Settings → Team).'}</p><p class="small"><a href="#" id="back2">Back to sign in</a></p>`;
      $('#back2').onclick = ev => { ev.preventDefault(); showLogin(); };
    } catch (err) { toast(err.message, 'err'); }
  };
}
function showReset(token) {
  authShell(`<form id="rf"><p class="muted" style="margin:0 0 16px">Choose a new password</p>
  <label class="f"><span>New password (min 8 characters)</span><input type="password" name="pw" minlength="8" required autofocus autocomplete="new-password"></label>
  <label class="f"><span>Repeat it</span><input type="password" name="pw2" minlength="8" required autocomplete="new-password"></label>
  <button class="btn pri" style="width:100%;justify-content:center">Save new password</button></form>`);
  $('#rf').onsubmit = async e => {
    e.preventDefault(); const f = e.target; if (f.pw.value !== f.pw2.value) return toast('The two passwords do not match', 'err');
    try { await api('auth/reset', 'POST', { token, password: f.pw.value }); toast('Password changed - please sign in', 'ok'); history.replaceState(null, '', location.pathname); showLogin(); } catch (err) { toast(err.message, 'err'); }
  };
}
function showMustChange() {
  authShell(`<form id="mc"><div class="banner" style="margin:0 0 14px">An administrator reset your password. Choose your own before continuing.</div>
  <label class="f"><span>Temporary password</span><input type="password" name="cur" required autocomplete="current-password"></label>
  <label class="f"><span>New password (min 8 characters)</span><input type="password" name="pw" minlength="8" required autocomplete="new-password"></label>
  <button class="btn pri" style="width:100%;justify-content:center">Change password</button></form>`);
  $('#mc').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try { await api('auth/password', 'POST', { current: f.cur.value, new: f.pw.value }); toast('Password changed', 'ok'); await loadBootstrap(); location.hash = '#/dashboard'; route(); } catch (err) { toast(err.message, 'err'); }
  };
}
async function logout() { await guard(() => api('auth/logout', 'POST')); S.user = null; window.__dirty = false; showLogin(); }

/* ---------- layout & router ---------- */
let lastHash = '';
function layout() {
  const s = S.settings, logo = s.company_logo ? `<img src="${esc(s.company_logo)}" alt="">` : '<img class="logo" src="assets/logo.png" alt="Infraura">';
  $('#app').innerHTML = `<div class="shell"><aside class="side noprint"><div class="brand">${logo}<b>${esc(s.company_name || 'Infraura')}</b><small>Quotation Builder</small></div>
  <nav><a href="#/dashboard" data-n="dashboard">Dashboard</a><a href="#/quotes" data-n="quotes">Quotes</a><a href="#/projects" data-n="projects">Projects</a><a href="#/reports" data-n="reports">Reports</a><a href="#/clients" data-n="clients">Clients</a><a href="#/rates" data-n="rates">Rate Cards</a><a href="#/settings" data-n="settings">Settings</a></nav>
  <div class="userbox">${esc(S.user.name)}<br>${esc(S.user.email)}<button id="lo">Sign out</button></div></aside><main class="main"><div id="view"></div></main></div>`;
  $('#lo').onclick = logout;
}
function onHash() {
  if (window.__dirty && !confirmBox('You have unsaved changes. Leave this page?')) {
    history.replaceState(null, '', lastHash || '#/quotes'); return;
  }
  window.__dirty = false; route();
}
async function route() {
  if (!S.user) return;
  lastHash = location.hash;
  const p = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  document.body.classList.toggle('printmode', (p[0] === 'quotes' && p[2] === 'print') || (p[0] === 'projects' && ['invoice', 'receipt', 'credit'].includes(p[2])));
  if (!$('#view')) layout();
  $$('.side nav a').forEach(a => a.classList.toggle('on', a.dataset.n === p[0]));
  const v = $('#view'); v.onclick = v.oninput = v.onchange = null;
  window.scrollTo(0, 0);
  try {
    if (p[0] === 'dashboard') await pageDashboard();
    else if (p[0] === 'quotes') {
      if (!p[1]) await pageQuotes();
      else if (p[1] === 'new') await pageEditor(null, p[2]);
      else if (p[2] === 'print') await pagePrint(+p[1]);
      else await pageEditor(+p[1]);
    } else if (p[0] === 'projects') {
      if (!p[1]) await pageProjects();
      else if (p[2] === 'invoice') await pageInvoice(+p[1], +p[3]);
      else if (p[2] === 'receipt') await pageReceipt(+p[1], +p[3]);
      else if (p[2] === 'credit') await pageCredit(+p[1], +p[3]);
      else await pageProject(+p[1]);
    } else if (p[0] === 'reports') await pageReports();
    else if (p[0] === 'clients') await pageClients();
    else if (p[0] === 'rates') await pageRates();
    else if (p[0] === 'settings') await pageSettings();
    else { location.hash = '#/dashboard'; }
  } catch (e) {
    if (e.message !== 'Session expired') $('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

/* ---------- self-running jobs + setup checklist ---------- */
function tick() { if (S.user) api('tick', 'POST', {}).catch(() => {}); }   // lets the server run backups/summaries/reminders without any cron setup
async function setupCard() {
  if (!S.user || S.user.role !== 'admin') return '';
  let c; try { c = await api('setup'); } catch (e) { return ''; }
  if (c.dismissed) return '';
  const row = i => `<li class="${i.done ? 'ok' : ''}">${i.done ? '✓' : '○'} ${i.link ? `<a href="${i.link}">${esc(i.label)}</a>` : esc(i.label)}${!i.done && i.action ? ` <button class="btn sm" data-sact="${i.action}" type="button">Mark done</button>` : ''}</li>`;
  return `<div class="card" id="setupcard"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Finish setting up · ${c.left} left</h3><button class="btn sm" id="sdismiss" type="button">Hide</button></div><ul class="checklist">${c.items.map(row).join('')}</ul></div>`;
}
function wireSetupCard() {
  const dis = $('#sdismiss');
  if (dis) dis.onclick = async () => { await api('setup/dismiss', 'POST', {}); const c = $('#setupcard'); if (c) c.style.display = 'none'; };
  $$('[data-sact]').forEach(b => { b.onclick = async () => { await api('setup/' + b.dataset.sact, 'POST', {}); route(); }; });
}

/* ---------- dashboard ---------- */
async function pageDashboard() {
  const d = await api('dashboard');
  const setup = await setupCard();
  const st = Object.fromEntries(d.by_status.map(x => [x.status, x]));
  const g = k => st[k] || { n: 0, value: 0 };
  const total = d.by_status.reduce((a, x) => a + x.n, 0);
  const open = g('draft').value + g('sent').value, openN = g('draft').n + g('sent').n;
  const decided = g('accepted').n + g('rejected').n;
  const win = decided ? Math.round(g('accepted').n * 100 / decided) + '% win rate' : 'no decisions yet';
  const maxM = Math.max(1, ...d.monthly.map(m => m.value));
  const maxD = Math.max(1, ...d.by_division.map(m => m.value));
  const dv = Object.fromEntries(d.by_division.map(x => [x.division, x]));
  $('#view').innerHTML = `
  <div class="page-head"><h1>Dashboard</h1><span><button class="btn pri" id="quickroof" type="button">⚡ Quick quote</button> <a class="btn" href="#/quotes">All quotes</a></span></div>
  ${setup}
  <div class="tiles">
   <div class="tile"><div class="l">Quotes</div><div class="v">${total}</div><div class="s">latest revisions</div></div>
   <div class="tile"><div class="l">Open pipeline</div><div class="v">${inr0(open)}</div><div class="s">${openN} draft / sent</div></div>
   <div class="tile"><div class="l">Accepted</div><div class="v">${inr0(g('accepted').value)}</div><div class="s">${g('accepted').n} quotes · ${win}</div></div>
   <div class="tile"><div class="l">Receivables</div><div class="v ${d.receivables && d.receivables.overdue ? 'bad' : ''}">${inr0(d.receivables ? d.receivables.outstanding : 0)}</div><div class="s"><a href="#/projects">${d.receivables ? d.receivables.active : 0} active projects${d.receivables && d.receivables.overdue ? ' · ' + d.receivables.overdue + ' overdue' : ''}</a></div></div>
   <div class="tile"><div class="l">Clients</div><div class="v">${d.clients}</div><div class="s">in your book</div></div>
  </div>
  <div class="divcards">${Object.entries(DIVS).map(([k, label]) => {
    const x = dv[k] || { n: 0, value: 0 };
    return `<div class="divcard"><h2>${label}</h2><div class="v">${inr0(x.value)}</div><div class="muted small">${x.n} quote${x.n === 1 ? '' : 's'}</div>
    <div class="hbar"><i style="width:${Math.round(x.value * 100 / maxD)}%"></i></div>
    <a class="btn sm" style="margin-top:10px" href="#/quotes/new/${k}">+ New ${label} quote</a></div>`;
  }).join('')}</div>
  <div class="grid2"><div class="card"><h2>Quote value — last 6 months</h2>${d.monthly.length ? `<div class="bars">${d.monthly.map(m => `<div class="b" title="${m.n} quotes"><span>${inr0(m.value).replace('₹ ', '')}</span><i style="height:${Math.max(3, Math.round(m.value * 90 / maxM))}%"></i><span>${esc(monthLabel(m.month))}</span></div>`).join('')}</div>` : '<p class="muted">No quotes yet.</p>'}</div>
  <div class="card"><h2>By status</h2>${['draft', 'sent', 'accepted', 'rejected'].map(k => `<div class="row" style="margin-bottom:6px">${statusChip(k)}<span class="sp"></span><span class="muted small">${g(k).n} quotes</span><b>${inr0(g(k).value)}</b></div>`).join('')}</div></div>
  ${d.amc_due && d.amc_due.length ? `<div class="card"><h2>AMC / warranty renewals due</h2>${d.amc_due.map(a => { const days = Math.round((new Date(a.amc_end + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5); return `<div class="row" style="margin-bottom:8px"><div style="flex:1;min-width:200px"><a href="#/projects/${a.id}"><b>${esc(a.name)}</b></a> · ${esc(a.client_name || '')}<div class="muted small">${days >= 0 ? 'ends in ' + days + ' day(s)' : '<span class="bad">ended ' + (-days) + ' day(s) ago</span>'} (${esc(fdate(a.amc_end))})${a.amc_note ? ' · ' + esc(a.amc_note) : ''}</div></div><a class="btn sm" target="_blank" rel="noopener" href="${waLink(a.client_phone, `Hello ${a.client_name || ''}, the AMC / warranty for ${a.name} ${days >= 0 ? 'ends on ' + fdate(a.amc_end) : 'ended on ' + fdate(a.amc_end)}. Shall we renew or schedule a maintenance visit? - ${S.settings.company_name}`)}">WhatsApp renewal</a></div>`; }).join('')}</div>` : ''}
  ${d.follow_up && d.follow_up.length ? `<div class="card"><h2>Follow-ups due — sent 3+ days ago, no reply</h2>${d.follow_up.map(f => { const c = f.client || {}, days = Math.max(3, Math.floor((Date.now() - new Date(f.updated_at.replace(' ', 'T'))) / 864e5)); return `<div class="row" style="margin-bottom:8px"><div style="flex:1;min-width:200px"><a href="#/quotes/${f.id}"><b>${esc(f.quote_no)}</b></a> · ${esc(c.name || '')}<div class="muted small">${days} days ago · ${f.views ? 'viewed ' + f.views + '×' : 'not opened yet'}</div></div><b>${inr0(f.total)}</b><a class="btn sm" target="_blank" rel="noopener" href="${waLink(c.phone, `Hello ${c.contact_person || c.name || ''}, a gentle reminder about our quotation ${f.quote_no} (${inr0(f.total)}). Happy to clarify anything or revise it - ${S.settings.company_name}`)}">WhatsApp reminder</a></div>`; }).join('')}</div>` : ''}
  <div class="card"><h2>Recent quotes</h2>${quoteTable(d.recent)}</div>`;
  wireSetupCard();
  const qr = $('#quickroof'); if (qr) qr.onclick = () => quickRoofDialog();
}

/* ---------- quotes list ---------- */
const QF = { q: '', status: '', division: '', all: false, client_id: '' };
function quoteTable(rows) {
  if (!rows.length) return '<p class="muted">Nothing here yet.</p>';
  return `<div class="scroll"><table class="tbl"><thead><tr><th>Quote no.</th><th>Client / Project</th><th>Division</th><th>Date</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>${rows.map(r => `
  <tr class="click" onclick="location.hash='#/quotes/${r.id}'"><td class="nw"><a href="#/quotes/${r.id}">${esc(r.quote_no)}</a>${r.rev ? ` <span class="muted small">Rev ${r.rev}</span>` : ''}</td>
  <td><b>${esc(r.client.name || '—')}</b><div class="muted small">${esc(r.title)}</div></td><td>${divChip(r.division)}</td><td class="nw">${fdate(r.quote_date)}</td><td class="r nw"><b>${inr0(r.total)}</b></td><td>${statusChip(r.status)}</td></tr>`).join('')}</tbody></table></div>`;
}
async function pageQuotes() {
  const v = $('#view');
  const clientName = QF.client_id ? (S.clients.find(c => c.id == QF.client_id) || {}).name : '';
  v.innerHTML = `<div class="page-head"><h1>Quotes</h1><span class="sp"></span>
  <button class="btn" id="qx">Export CSV</button>${Object.entries(DIVS).map(([k, l]) => `<a class="btn ${k === 'roofing' ? 'pri' : ''}" href="#/quotes/new/${k}">+ ${l}</a>`).join('')}</div>
  <div class="card"><div class="row" style="margin-bottom:12px">
   <input id="qs" aria-label="Search quotes" placeholder="Search quote no., client, project…" value="${esc(QF.q)}" style="max-width:300px">
   <select id="qd" aria-label="Filter by division" style="max-width:170px">${divOptions(QF.division, true)}</select>
   <select id="qst" aria-label="Filter by status" style="max-width:150px"><option value="">All statuses</option>${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${QF.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <label class="row small" style="gap:5px"><input type="checkbox" id="qa" ${QF.all ? 'checked' : ''}> Show all revisions</label>
   ${clientName ? `<span class="chip div">Client: ${esc(clientName)} <a href="#" id="cc">✕</a></span>` : ''}</div>
   <div id="ql"><p class="muted">Loading…</p></div></div>`;
  const params = () => { const qs = new URLSearchParams();
    if (QF.q) qs.set('q', QF.q); if (QF.status) qs.set('status', QF.status);
    if (QF.division) qs.set('division', QF.division); if (QF.all) qs.set('all', '1'); if (QF.client_id) qs.set('client_id', QF.client_id); return qs; };
  let page = 1, shown = [], total = 0;
  const paint = () => {
    $('#ql').innerHTML = quoteTable(shown) + (shown.length ? `<p class="muted small" style="margin:10px 0 0">Showing ${shown.length} of ${total} quote${total === 1 ? '' : 's'} · total of those shown ${inr0(shown.filter(r => r.status !== 'superseded').reduce((a, r) => a + r.total, 0))}</p>${shown.length < total ? '<div class="row" style="margin-top:8px"><button class="btn" id="qmore" type="button">Load more</button></div>' : ''}` : '');
    const mb = $('#qmore'); if (mb) mb.onclick = () => guard(async () => { page++; await load(true); });
  };
  const load = async (more) => {
    if (!more) { page = 1; shown = []; }
    const qs = params(); qs.set('per', '50'); qs.set('page', String(page));
    const r = await api('quotes&' + qs); total = r.total; shown = shown.concat(r.rows); QF.rows = shown; paint();
  };
  let tm; const reload = () => { clearTimeout(tm); tm = setTimeout(() => guard(load), 200); };
  $('#qs').oninput = e => { QF.q = e.target.value; reload(); };
  $('#qd').onchange = e => { QF.division = e.target.value; reload(); };
  $('#qst').onchange = e => { QF.status = e.target.value; reload(); };
  $('#qa').onchange = e => { QF.all = e.target.checked; reload(); };
  $('#qx').onclick = () => guard(async () => {
    let rows = [], pg = 1, tot = 1; const qs = params(); qs.set('per', '200');
    while (rows.length < tot && pg <= 100) { qs.set('page', String(pg++)); const r = await api('quotes&' + qs); tot = r.total; rows = rows.concat(r.rows); if (!r.rows.length) break; }
    const head = ['quote_no', 'rev', 'division', 'client', 'title', 'status', 'quote_date', 'valid_until', 'subtotal', 'discount', 'gst', 'total'];
    download('quotes.csv', [head.join(',')].concat(rows.map(r => [r.quote_no, r.rev, DIVS[r.division], (r.client || {}).name, r.title, r.status, r.quote_date, r.valid_until, r.subtotal, r.discount, r.tax, r.total].map(csvCell).join(','))).join('\n'));
  });
  const cc = $('#cc'); if (cc) cc.onclick = e => { e.preventDefault(); QF.client_id = ''; pageQuotes(); };
  await load();
}

/* ---------- clients ---------- */
async function pageClients() {
  const v = $('#view'), admin = S.user.role === 'admin';
  v.innerHTML = `<div class="page-head"><h1>Clients</h1><button class="btn pri" data-act="new">+ New client</button></div>
  <div class="card"><input id="cs" aria-label="Search clients" placeholder="Search name, phone, e-mail, GSTIN…" style="max-width:320px;margin-bottom:12px"><div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>GSTIN</th><th class="r">Quotes</th><th><span class="sr">Actions</span></th></tr></thead><tbody id="cb"></tbody></table></div><div id="cm" class="row" style="margin-top:10px"></div></div>`;
  let rows = [], page = 1, total = 0, term = '';
  const draw = () => {
    $('#cb').innerHTML = rows.map(c => `<tr><td><b>${esc(c.name)}</b>${c.anonymized ? ' <span class="chip draft">data erased</span>' : ''}<div class="muted small">${esc(c.address)}</div></td><td>${esc(c.contact_person)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.gstin)}</td>
      <td class="r"><a href="#/quotes" data-act="q" data-id="${c.id}">${c.quote_count}</a></td>
      <td class="nw r"><button class="btn sm" data-act="edit" data-id="${c.id}">Edit</button> ${admin ? `<button class="btn sm" data-act="export" data-id="${c.id}" title="Download everything held about this client">Export data</button> <button class="btn sm" data-act="erase" data-id="${c.id}" title="Erase personal details (privacy request)">Erase data</button> ` : ''}<button class="btn sm dng" data-act="del" data-id="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No clients found.</td></tr>';
    $('#cm').innerHTML = `<span class="muted small">Showing ${rows.length} of ${total}</span>${rows.length < total ? '<button class="btn" id="cmore" type="button">Load more</button>' : ''}`;
    const mb = $('#cmore'); if (mb) mb.onclick = () => guard(async () => { page++; await load(true); });
  };
  const load = async more => {
    if (!more) { page = 1; rows = []; }
    const r = await api(`clients&per=50&page=${page}${term ? '&q=' + encodeURIComponent(term) : ''}`); total = r.total; rows = rows.concat(r.rows);
    rows.forEach(c => { if (!S.clients.find(x => x.id === c.id)) S.clients.push(c); });
    draw();
  };
  let tm; $('#cs').oninput = e => { term = e.target.value.trim(); clearTimeout(tm); tm = setTimeout(() => guard(load), 250); };
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const c = rows.find(x => x.id == t.dataset.id);
    if (t.dataset.act === 'new') clientModal(null);
    if (t.dataset.act === 'edit') clientModal(c);
    if (t.dataset.act === 'q') { QF.client_id = c.id; QF.all = false; QF.q = QF.status = QF.division = ''; }
    if (t.dataset.act === 'export') window.location.href = `api/index.php?r=clients/${c.id}/export`;
    if (t.dataset.act === 'erase' && confirmBox(`Erase personal details of "${c.name}"?\n\nPhone, e-mail and contact person are removed. If the client has accepted quotes or invoices, their name, address and GSTIN are kept because tax law requires it. This cannot be undone.`)) guard(async () => { const r = await api(`clients/${c.id}/anonymize`, 'POST', { confirm: true }); alert(r.note); load(); });
    if (t.dataset.act === 'del' && confirmBox(`Delete client "${c.name}"?`)) guard(async () => { await api('clients/' + c.id, 'DELETE'); toast('Client deleted', 'ok'); load(); });
  };
  await load();
}
function clientModal(c, onSaved) {
  c = c || {};
  const m = openModal(`<h2>${c.id ? 'Edit' : 'New'} client</h2><form id="cf">
  <label class="f"><span>Client / company name *</span><input name="name" required value="${esc(c.name)}"></label>
  <div class="grid2"><label class="f"><span>Contact person</span><input name="contact_person" value="${esc(c.contact_person)}"></label><label class="f"><span>Phone</span><input name="phone" value="${esc(c.phone)}"></label></div>
  <div class="grid2"><label class="f"><span>Email</span><input name="email" type="email" value="${esc(c.email)}"></label><label class="f"><span>GSTIN</span><input name="gstin" value="${esc(c.gstin)}"></label></div>
  <label class="f"><span>Address</span><textarea name="address">${esc(c.address)}</textarea></label>
  <div class="row end"><button type="button" class="btn" id="x">Cancel</button><button class="btn pri">Save</button></div></form>`);
  $('#x', m.el).onclick = m.close;
  $('#cf', m.el).onsubmit = e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    guard(async () => {
      let id = c.id;
      if (c.id) await api('clients/' + c.id, 'PUT', body); else id = (await api('clients', 'POST', body)).id;
      await refreshClients(); m.close(); toast('Client saved', 'ok');
      if (onSaved) onSaved(id); else pageClients();
    });
  };
}

/* ---------- rate cards ---------- */
const RF = { div: 'roofing', q: '' };
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const csvCell = s => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
async function pageRates() {
  S.rates = await api('rates');
  const v = $('#view');
  v.innerHTML = `<div class="page-head"><h1>Rate Cards</h1><button class="btn" data-act="exp">Export CSV</button>${S.user.role === 'admin' ? '<button class="btn" data-act="imp">Import CSV</button><button class="btn pri" data-act="new">+ New item</button>' : ''}<input type="file" id="fi" accept=".csv,text/csv" hidden></div>
  <div class="card"><div class="tabs">${Object.entries(DIVS).map(([k, l]) => `<button data-act="tab" data-d="${k}" class="${k === RF.div ? 'on' : ''}">${l} <span class="muted small">${S.rates.filter(r => r.division === k).length}</span></button>`).join('')}</div>
  <input id="rs" aria-label="Search rate card items" placeholder="Search items…" value="${esc(RF.q)}" style="max-width:280px;margin-bottom:12px">
  <p class="muted small" style="margin:0 0 10px">Rates shown are indicative starting values — edit them to your actual costs. Items you mark inactive stay saved but are hidden from the quote picker.</p>
  <div class="scroll"><table class="tbl"><thead><tr><th>Category</th><th>Item</th><th>Unit</th><th class="r">Rate (₹)</th><th class="r">Cost (₹)</th><th class="r">Margin</th><th><span class="sr">Actions</span></th></tr></thead><tbody id="rb"></tbody></table></div></div>`;
  const draw = () => {
    const f = RF.q.toLowerCase();
    const rows = S.rates.filter(r => r.division === RF.div && (!f || (r.name + r.category).toLowerCase().includes(f)));
    $('#rb').innerHTML = rows.map(r => `<tr style="${r.active ? '' : 'opacity:.5'}"><td class="muted nw">${esc(r.category)}</td><td>${esc(r.name)}${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td>${esc(r.unit)}</td><td class="r nw"><b>${fmt(r.rate)}</b></td><td class="r nw muted">${r.cost ? fmt(r.cost) : '—'}</td><td class="r nw">${r.cost && r.rate ? `<span class="${(r.rate - r.cost) / r.rate * 100 < n(S.settings.min_margin) ? 'bad' : ''}">${Math.round((r.rate - r.cost) / r.rate * 100)}%</span>` : '—'}</td>
    <td class="nw r">${S.user.role === 'admin' ? `<button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button> <button class="btn sm dng" data-act="del" data-id="${r.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No items. Add one or import a CSV.</td></tr>';
  };
  draw();
  $('#rs').oninput = e => { RF.q = e.target.value; draw(); };
  $('#fi').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => guard(async () => {
      const rows = parseCSV(String(rd.result));
      if (!rows.length) throw new Error('The file is empty');
      const head = rows[0].map(h => h.trim().toLowerCase());
      const hasHead = head.includes('name');
      const idx = k => hasHead ? head.indexOf(k) : ['division', 'category', 'name', 'unit', 'rate', 'description', 'cost'].indexOf(k);
      const items = rows.slice(hasHead ? 1 : 0).map(r => {
        const dv = (r[idx('division')] || RF.div).trim().toLowerCase().replace(/\s+/g, '');
        const division = { sheetroofing: 'roofing' }[dv] || dv;
        return { division, category: r[idx('category')] || '', name: (r[idx('name')] || '').trim(), unit: r[idx('unit')] || '', rate: n(String(r[idx('rate')] || '').replace(/,/g, '')), description: idx('description') >= 0 ? (r[idx('description')] || '') : '', cost: idx('cost') >= 0 ? n(String(r[idx('cost')] || '').replace(/,/g, '')) : 0 };
      }).filter(x => x.name);
      if (!items.length) throw new Error('No valid rows found. Columns needed: division, category, name, unit, rate, description');
      const res = await api('rates/import', 'POST', { items });
      toast(res.imported + ' item(s) imported' + (res.skipped ? ', ' + res.skipped + ' skipped (already in your rate card)' : ''), 'ok'); pageRates();
    });
    rd.readAsText(file); e.target.value = '';
  };
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act;
    if (a === 'tab') { RF.div = t.dataset.d; pageRates(); }
    else if (a === 'new') rateModal({ division: RF.div, active: 1 });
    else if (a === 'edit') rateModal(S.rates.find(r => r.id == t.dataset.id));
    else if (a === 'del') { const r = S.rates.find(x => x.id == t.dataset.id); if (confirmBox(`Delete "${r.name}"? Existing quotes are not affected.`)) guard(async () => { await api('rates/' + r.id, 'DELETE'); toast('Deleted', 'ok'); pageRates(); }); }
    else if (a === 'imp') $('#fi').click();
    else if (a === 'exp') {
      const lines = [['division', 'category', 'name', 'unit', 'rate', 'description', 'cost'].join(',')].concat(S.rates.filter(r => r.division === RF.div).map(r => [r.division, r.category, r.name, r.unit, r.rate, r.description, r.cost].map(csvCell).join(',')));
      download(`rate-card-${RF.div}.csv`, lines.join('\n'));
    }
  };
}
function rateModal(r) {
  const cats = [...new Set(S.rates.map(x => x.category).filter(Boolean))];
  const m = openModal(`<h2>${r.id ? 'Edit' : 'New'} rate item</h2><form id="rf">
  <div class="grid2"><label class="f"><span>Division</span><select name="division">${divOptions(r.division)}</select></label><label class="f"><span>Category</span><input name="category" list="cats" value="${esc(r.category)}"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
  <label class="f"><span>Item description *</span><input name="name" required value="${esc(r.name)}"></label>
  <div class="grid2"><label class="f"><span>Unit</span><input name="unit" list="units" value="${esc(r.unit)}"><datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist></label><label class="f"><span>Selling rate (₹) *</span><input name="rate" type="number" step="0.01" min="0" required value="${r.rate ?? ''}"></label></div>
  <label class="f"><span>Your cost (₹) — internal, never printed; used for margin tracking</span><input name="cost" type="number" step="0.01" min="0" value="${r.cost ?? ''}"></label>
  <label class="f"><span>Notes (optional)</span><input name="description" value="${esc(r.description)}"></label>
  <label class="row small" style="gap:6px;margin-bottom:12px"><input type="checkbox" name="active" ${r.active === 0 ? '' : 'checked'}> Active (shown in quote picker)</label>
  <div class="row end"><button type="button" class="btn" id="x">Cancel</button><button class="btn pri">Save</button></div></form>`);
  $('#x', m.el).onclick = m.close;
  $('#rf', m.el).onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target), body = Object.fromEntries(fd);
    body.active = fd.has('active') ? 1 : 0;
    guard(async () => { if (r.id) await api('rates/' + r.id, 'PUT', body); else await api('rates', 'POST', body); m.close(); toast('Saved', 'ok'); RF.div = body.division; pageRates(); });
  };
}

/* ---------- settings ---------- */
function downscaleImage(file, maxW, maxH, jpeg, quality = 0.9) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, maxW / img.width, maxH / img.height);
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(!jpeg && file.type === 'image/png' ? 'image/png' : 'image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}
async function pageSettings() {
  S.settings = await api('settings');
  const s = S.settings, admin = S.user.role === 'admin';
  const inp = (k, label, type = 'text') => `<label class="f"><span>${label}</span><input data-k="${k}" type="${type}" value="${esc(s[k])}"></label>`;
  const ta = (k, label, rows = 5) => `<label class="f"><span>${label}</span><textarea data-k="${k}" rows="${rows}" style="min-height:${rows * 22}px">${esc(s[k])}</textarea></label>`;
  $('#view').innerHTML = `<div class="page-head"><h1>Settings</h1>${admin ? '<button class="btn pri" data-act="save">Save settings</button>' : '<span class="muted">View only — admin can edit</span>'}</div>
  <fieldset ${admin ? '' : 'disabled'}>
  <div class="card"><h2>Company (appears on every quotation)</h2><div class="grid2"><div>${inp('company_name', 'Company name')}${inp('company_tagline', 'Tagline')}${ta('company_address', 'Address', 3)}</div>
  <div>${inp('company_phone', 'Phone')}${inp('company_email', 'Email', 'email')}${inp('company_gstin', 'GSTIN')}${inp('signatory', 'Authorised signatory name')}</div></div>
  <div class="row"><div id="lg">${s.company_logo ? `<img src="${esc(s.company_logo)}" style="max-height:60px;background:#f1f5f9;padding:4px;border-radius:6px">` : '<span class="muted small">No logo</span>'}</div>
  <label class="btn sm">Upload logo<input type="file" id="logo" accept="image/png,image/jpeg" hidden></label><button type="button" class="btn sm" data-act="rmlogo">Remove</button></div></div>
  <div class="card"><h2>Quote defaults</h2><div class="grid3">${inp('quote_prefix', 'Quote number prefix')}${inp('validity_days', 'Validity (days)', 'number')}${inp('min_margin', 'Low-margin alert below (%)', 'number')}
  ${Object.entries(DIVS).map(([k, l]) => inp('gst_' + k, 'GST % — ' + l, 'number')).join('')}${Object.entries(DIVS).map(([k, l]) => inp('hsn_' + k, 'HSN / SAC — ' + l)).join('')}</div></div>
  <div class="card"><h2>Bank details (printed on quotations)</h2>${ta('bank_details', 'Bank details', 5)}</div>
  <div class="card"><h2>Default terms &amp; conditions (one per line)</h2><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('terms_' + k, l, 8)).join('')}</div></div>
  <div class="card"><h2>Default payment schedule — one stage per line as "Stage name|percent"</h2><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('pay_' + k, l, 5)).join('')}</div></div></fieldset>
  ${admin ? `<div class="card"><h2>Backup &amp; activity log</h2><div class="row"><a class="btn" href="api/index.php?r=backup">Download full backup (JSON)</a><span class="muted small">Quotes, clients, rate cards, projects and settings. Keep a copy regularly - also enable automatic backups in Hostinger hPanel.</span></div><div id="audit" style="margin-top:12px"></div></div>` : ''}
  ${admin ? '<div class="card" id="aicard"><span class="muted small">Loading…</span></div>' : ''}
  <div class="card"><h2>Quote templates</h2>${(S.templates || []).length ? `<table class="tbl"><tbody>${S.templates.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${divChip(t.division)}</td><td class="r">${admin ? `<button class="btn sm dng" data-act="deltpl" data-id="${t.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small" style="margin:0">No templates yet. Open any quote and click “Save as template”.</p>'}</div>
  <div class="card" id="seccard"></div>
  ${admin ? '<div class="card" id="mailcard"></div><div class="card" id="syscard"></div><div class="card" id="teamcard"></div>' : ''}`;
  const v = $('#view');
  let logo = s.company_logo || '';
  const logoIn = $('#logo');
  if (logoIn) logoIn.onchange = e => guard(async () => {
    const f = e.target.files[0]; if (!f) return;
    logo = await downscaleImage(f, 480, 200); $('#lg').innerHTML = `<img src="${logo}" style="max-height:60px;background:#f1f5f9;padding:4px;border-radius:6px">`;
  });
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    if (t.dataset.act === 'rmlogo') { logo = ''; $('#lg').innerHTML = '<span class="muted small">No logo</span>'; }
    if (t.dataset.act === 'save') guard(async () => {
      const body = { company_logo: logo };
      $$('[data-k]').forEach(el => body[el.dataset.k] = el.value);
      S.settings = await api('settings', 'PUT', body); toast('Settings saved', 'ok'); layout();
      $$('.side nav a').forEach(a => a.classList.toggle('on', a.dataset.n === 'settings'));
    });
    if (t.dataset.act === 'deltpl' && confirmBox('Delete this template?')) guard(async () => { await api('templates/' + t.dataset.id, 'DELETE'); S.templates = await api('templates'); pageSettings(); });
  };
  renderSecurity();
  if (admin) {
    api('audit').then(a => { $('#audit').innerHTML = a.length ? `<div class="small" style="max-height:220px;overflow:auto">${a.map(x => `<div class="row" style="margin-bottom:3px"><span class="muted nw">${esc(x.created_at.slice(0, 16))}</span><span class="nw">${esc(x.user_name)}</span><span><b>${esc(x.action)}</b> ${esc(x.detail)}</span></div>`).join('')}</div>` : '<span class="muted small">No activity recorded yet.</span>'; }).catch(() => {});
    renderAiCard().catch(() => { $('#aicard').innerHTML = '<span class="muted small">AI settings unavailable.</span>'; });
    renderMailCard(); renderTeam(); renderSystemCard().catch(() => {});
  }
}
