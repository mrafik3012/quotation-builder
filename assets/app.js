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
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
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
  o.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
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
async function init() {
  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', e => { if (window.__dirty) { e.preventDefault(); e.returnValue = ''; } });
  try {
    const me = await api('auth/me');
    if (!me.user) return showLogin();
    S.user = me.user;
    await loadBootstrap();
    route();
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><img class="logo" src="assets/logo.png" alt="Infraura"><h1>Quotation Builder</h1><p class="muted">${esc(e.message)}</p></div>`;
  }
}
async function loadBootstrap() {
  const b = await api('bootstrap');
  S.user = b.user; S.settings = b.settings; S.clients = b.clients; S.rates = b.rates; S.templates = b.templates || [];
}
function showLogin() {
  document.body.classList.remove('printmode');
  $('#app').innerHTML = `<form class="login" id="lf"><img class="logo" src="assets/logo.png" alt="Infraura"><h1>Quotation Builder</h1><p class="muted" style="margin:0 0 16px">Sign in to continue</p>
  <label class="f"><span>Email</span><input type="email" name="email" required autofocus autocomplete="username"></label>
  <label class="f"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
  <button class="btn pri" style="width:100%;justify-content:center">Sign in</button></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f); btn.disabled = true;
    try {
      const r = await api('auth/login', 'POST', { email: f.email.value, password: f.password.value });
      S.user = r.user; await loadBootstrap(); location.hash = '#/dashboard'; route();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  };
}
async function logout() { await guard(() => api('auth/logout', 'POST')); S.user = null; window.__dirty = false; showLogin(); }

/* ---------- layout & router ---------- */
let lastHash = '';
function layout() {
  const s = S.settings, logo = s.company_logo ? `<img src="${esc(s.company_logo)}" alt="">` : '<img class="logo" src="assets/logo.png" alt="Infraura">';
  $('#app').innerHTML = `<div class="shell"><aside class="side noprint"><div class="brand">${logo}<b>${esc(s.company_name || 'Infraura')}</b><small>Quotation Builder</small></div>
  <nav><a href="#/dashboard" data-n="dashboard">Dashboard</a><a href="#/quotes" data-n="quotes">Quotes</a><a href="#/clients" data-n="clients">Clients</a><a href="#/rates" data-n="rates">Rate Cards</a><a href="#/settings" data-n="settings">Settings</a></nav>
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
  document.body.classList.toggle('printmode', p[0] === 'quotes' && p[2] === 'print');
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
    } else if (p[0] === 'clients') await pageClients();
    else if (p[0] === 'rates') await pageRates();
    else if (p[0] === 'settings') await pageSettings();
    else { location.hash = '#/dashboard'; }
  } catch (e) {
    if (e.message !== 'Session expired') $('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

/* ---------- dashboard ---------- */
async function pageDashboard() {
  const d = await api('dashboard');
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
  <div class="page-head"><h1>Dashboard</h1><a class="btn pri" href="#/quotes">All quotes</a></div>
  <div class="tiles">
   <div class="tile"><div class="l">Quotes</div><div class="v">${total}</div><div class="s">latest revisions</div></div>
   <div class="tile"><div class="l">Open pipeline</div><div class="v">${inr0(open)}</div><div class="s">${openN} draft / sent</div></div>
   <div class="tile"><div class="l">Accepted</div><div class="v">${inr0(g('accepted').value)}</div><div class="s">${g('accepted').n} quotes · ${win}</div></div>
   <div class="tile"><div class="l">Clients</div><div class="v">${d.clients}</div><div class="s">in your book</div></div>
  </div>
  <div class="divcards">${Object.entries(DIVS).map(([k, label]) => {
    const x = dv[k] || { n: 0, value: 0 };
    return `<div class="divcard"><h4>${label}</h4><div class="v">${inr0(x.value)}</div><div class="muted small">${x.n} quote${x.n === 1 ? '' : 's'}</div>
    <div class="hbar"><i style="width:${Math.round(x.value * 100 / maxD)}%"></i></div>
    <a class="btn sm" style="margin-top:10px" href="#/quotes/new/${k}">+ New ${label} quote</a></div>`;
  }).join('')}</div>
  <div class="grid2"><div class="card"><h3>Quote value — last 6 months</h3>${d.monthly.length ? `<div class="bars">${d.monthly.map(m => `<div class="b" title="${m.n} quotes"><span>${inr0(m.value).replace('₹ ', '')}</span><i style="height:${Math.max(3, Math.round(m.value * 90 / maxM))}%"></i><span>${esc(monthLabel(m.month))}</span></div>`).join('')}</div>` : '<p class="muted">No quotes yet.</p>'}</div>
  <div class="card"><h3>By status</h3>${['draft', 'sent', 'accepted', 'rejected'].map(k => `<div class="row" style="margin-bottom:6px">${statusChip(k)}<span class="sp"></span><span class="muted small">${g(k).n} quotes</span><b>${inr0(g(k).value)}</b></div>`).join('')}</div></div>
  <div class="card"><h3>Recent quotes</h3>${quoteTable(d.recent)}</div>`;
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
  ${Object.entries(DIVS).map(([k, l]) => `<a class="btn ${k === 'roofing' ? 'pri' : ''}" href="#/quotes/new/${k}">+ ${l}</a>`).join('')}</div>
  <div class="card"><div class="row" style="margin-bottom:12px">
   <input id="qs" placeholder="Search quote no., client, project…" value="${esc(QF.q)}" style="max-width:300px">
   <select id="qd" style="max-width:170px">${divOptions(QF.division, true)}</select>
   <select id="qst" style="max-width:150px"><option value="">All statuses</option>${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${QF.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <label class="row small" style="gap:5px"><input type="checkbox" id="qa" ${QF.all ? 'checked' : ''}> Show all revisions</label>
   ${clientName ? `<span class="chip div">Client: ${esc(clientName)} <a href="#" id="cc">✕</a></span>` : ''}</div>
   <div id="ql"><p class="muted">Loading…</p></div></div>`;
  const load = async () => {
    const qs = new URLSearchParams();
    if (QF.q) qs.set('q', QF.q); if (QF.status) qs.set('status', QF.status);
    if (QF.division) qs.set('division', QF.division); if (QF.all) qs.set('all', '1'); if (QF.client_id) qs.set('client_id', QF.client_id);
    const rows = await api('quotes' + (qs.toString() ? '&' + qs : ''));
    $('#ql').innerHTML = quoteTable(rows) + (rows.length ? `<p class="muted small" style="margin:10px 0 0">${rows.length} quote${rows.length === 1 ? '' : 's'} · total ${inr0(rows.filter(r => r.status !== 'superseded').reduce((a, r) => a + r.total, 0))}</p>` : '');
  };
  let tm; const reload = () => { clearTimeout(tm); tm = setTimeout(() => guard(load), 200); };
  $('#qs').oninput = e => { QF.q = e.target.value; reload(); };
  $('#qd').onchange = e => { QF.division = e.target.value; reload(); };
  $('#qst').onchange = e => { QF.status = e.target.value; reload(); };
  $('#qa').onchange = e => { QF.all = e.target.checked; reload(); };
  const cc = $('#cc'); if (cc) cc.onclick = e => { e.preventDefault(); QF.client_id = ''; pageQuotes(); };
  await load();
}

/* ---------- clients ---------- */
async function pageClients() {
  const rows = await api('clients'); S.clients = rows;
  const v = $('#view');
  v.innerHTML = `<div class="page-head"><h1>Clients</h1><button class="btn pri" data-act="new">+ New client</button></div>
  <div class="card"><input id="cs" placeholder="Search clients…" style="max-width:280px;margin-bottom:12px"><div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>GSTIN</th><th class="r">Quotes</th><th></th></tr></thead><tbody id="cb"></tbody></table></div></div>`;
  const draw = () => {
    const f = $('#cs').value.toLowerCase();
    $('#cb').innerHTML = rows.filter(c => !f || (c.name + c.phone + c.email + c.contact_person).toLowerCase().includes(f)).map(c => `<tr>
    <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.address)}</div></td><td>${esc(c.contact_person)}</td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${esc(c.gstin)}</td>
    <td class="r"><a href="#/quotes" data-act="q" data-id="${c.id}">${c.quote_count}</a></td>
    <td class="nw r"><button class="btn sm" data-act="edit" data-id="${c.id}">Edit</button> <button class="btn sm dng" data-act="del" data-id="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No clients yet.</td></tr>';
  };
  draw(); $('#cs').oninput = draw;
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const c = rows.find(x => x.id == t.dataset.id);
    if (t.dataset.act === 'new') clientModal(null);
    if (t.dataset.act === 'edit') clientModal(c);
    if (t.dataset.act === 'q') { QF.client_id = c.id; QF.all = false; QF.q = QF.status = QF.division = ''; }
    if (t.dataset.act === 'del' && confirmBox(`Delete client "${c.name}"?`)) guard(async () => { await api('clients/' + c.id, 'DELETE'); toast('Client deleted', 'ok'); pageClients(); });
  };
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
      S.clients = await api('clients'); m.close(); toast('Client saved', 'ok');
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
  v.innerHTML = `<div class="page-head"><h1>Rate Cards</h1><button class="btn" data-act="exp">Export CSV</button><button class="btn" data-act="imp">Import CSV</button><button class="btn pri" data-act="new">+ New item</button><input type="file" id="fi" accept=".csv,text/csv" hidden></div>
  <div class="card"><div class="tabs">${Object.entries(DIVS).map(([k, l]) => `<button data-act="tab" data-d="${k}" class="${k === RF.div ? 'on' : ''}">${l} <span class="muted small">${S.rates.filter(r => r.division === k).length}</span></button>`).join('')}</div>
  <input id="rs" placeholder="Search items…" value="${esc(RF.q)}" style="max-width:280px;margin-bottom:12px">
  <p class="muted small" style="margin:0 0 10px">Rates shown are indicative starting values — edit them to your actual costs. Items you mark inactive stay saved but are hidden from the quote picker.</p>
  <div class="scroll"><table class="tbl"><thead><tr><th>Category</th><th>Item</th><th>Unit</th><th class="r">Rate (₹)</th><th class="r">Cost (₹)</th><th class="r">Margin</th><th></th></tr></thead><tbody id="rb"></tbody></table></div></div>`;
  const draw = () => {
    const f = RF.q.toLowerCase();
    const rows = S.rates.filter(r => r.division === RF.div && (!f || (r.name + r.category).toLowerCase().includes(f)));
    $('#rb').innerHTML = rows.map(r => `<tr style="${r.active ? '' : 'opacity:.5'}"><td class="muted nw">${esc(r.category)}</td><td>${esc(r.name)}${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td>${esc(r.unit)}</td><td class="r nw"><b>${fmt(r.rate)}</b></td><td class="r nw muted">${r.cost ? fmt(r.cost) : '—'}</td><td class="r nw">${r.cost && r.rate ? `<span class="${(r.rate - r.cost) / r.rate * 100 < n(S.settings.min_margin) ? 'bad' : ''}">${Math.round((r.rate - r.cost) / r.rate * 100)}%</span>` : '—'}</td>
    <td class="nw r"><button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button> <button class="btn sm dng" data-act="del" data-id="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No items. Add one or import a CSV.</td></tr>';
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
      toast(res.imported + ' items imported', 'ok'); pageRates();
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
function downscaleImage(file, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, maxW / img.width, maxH / img.height);
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9));
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
  <div class="card"><h3>Company (appears on every quotation)</h3><div class="grid2"><div>${inp('company_name', 'Company name')}${inp('company_tagline', 'Tagline')}${ta('company_address', 'Address', 3)}</div>
  <div>${inp('company_phone', 'Phone')}${inp('company_email', 'Email', 'email')}${inp('company_gstin', 'GSTIN')}${inp('signatory', 'Authorised signatory name')}</div></div>
  <div class="row"><div id="lg">${s.company_logo ? `<img src="${esc(s.company_logo)}" style="max-height:60px;background:#f1f5f9;padding:4px;border-radius:6px">` : '<span class="muted small">No logo</span>'}</div>
  <label class="btn sm">Upload logo<input type="file" id="logo" accept="image/png,image/jpeg" hidden></label><button type="button" class="btn sm" data-act="rmlogo">Remove</button></div></div>
  <div class="card"><h3>Quote defaults</h3><div class="grid3">${inp('quote_prefix', 'Quote number prefix')}${inp('validity_days', 'Validity (days)', 'number')}${inp('min_margin', 'Low-margin alert below (%)', 'number')}
  ${Object.entries(DIVS).map(([k, l]) => inp('gst_' + k, 'GST % — ' + l, 'number')).join('')}</div></div>
  <div class="card"><h3>Bank details (printed on quotations)</h3>${ta('bank_details', 'Bank details', 5)}</div>
  <div class="card"><h3>Default terms &amp; conditions (one per line)</h3><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('terms_' + k, l, 8)).join('')}</div></div>
  <div class="card"><h3>Default payment schedule — one stage per line as "Stage name|percent"</h3><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('pay_' + k, l, 5)).join('')}</div></div></fieldset>
  <div class="card"><h3>Quote templates</h3>${(S.templates || []).length ? `<table class="tbl"><tbody>${S.templates.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${divChip(t.division)}</td><td class="r">${admin ? `<button class="btn sm dng" data-act="deltpl" data-id="${t.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small" style="margin:0">No templates yet. Open any quote and click “Save as template”.</p>'}</div>
  <div class="grid2"><div class="card"><h3>Change my password</h3><form id="pw"><label class="f"><span>Current password</span><input type="password" name="current" required></label><label class="f"><span>New password (min 8)</span><input type="password" name="new" minlength="8" required></label><button class="btn">Update password</button></form></div>
  ${admin ? `<div class="card"><h3>Team</h3><div id="ul"></div><form id="uf" style="margin-top:12px"><div class="grid2"><label class="f"><span>Name</span><input name="name" required></label><label class="f"><span>Email</span><input name="email" type="email" required></label><label class="f"><span>Password</span><input name="password" type="password" minlength="8" required></label><label class="f"><span>Role</span><select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label></div><button class="btn">Add user</button></form></div>` : ''}</div>`;
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
    if (t.dataset.act === 'deluser' && confirmBox('Remove this user?')) guard(async () => { await api('users/' + t.dataset.id, 'DELETE'); loadUsers(); });
  };
  $('#pw').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('auth/password', 'POST', { current: f.current.value, new: f.new.value }); toast('Password updated', 'ok'); f.reset(); }); };
  async function loadUsers() {
    const us = await api('users');
    $('#ul').innerHTML = `<table class="tbl"><tbody>${us.map(u => `<tr><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></td><td>${esc(u.role)}</td><td class="r">${u.id === S.user.id ? '<span class="muted small">you</span>' : `<button class="btn sm dng" data-act="deluser" data-id="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>`;
  }
  if (admin) {
    await loadUsers();
    $('#uf').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('users', 'POST', Object.fromEntries(new FormData(f))); toast('User added', 'ok'); f.reset(); loadUsers(); }); };
  }
}
