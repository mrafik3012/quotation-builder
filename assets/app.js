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
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  quotes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  rates: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  roofing: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  interior: '<path d="M4 11V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3"/><path d="M2 14a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v4H2z"/><path d="M6 18v2M18 18v2"/>',
  construction: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4"/>',
  pmc: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  revise: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
};
const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const divIc = (d, cls = '') => ic(ICONS[d] ? d : 'quotes', cls);
const initials = s => (String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const prettyDate = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const divChip = d => `<span class="chip div dv-${esc(d)}">${esc(DIVS[d] || d)}</span>`;
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
  t.className = 'toast ' + type; t.innerHTML = ic(type === 'err' ? 'alert' : type === 'ok' ? 'check' : 'info') + '<span></span>'; t.lastChild.textContent = msg;
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

function countUp(root) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  $$('[data-count]', root).forEach(el => {
    const to = +el.dataset.count, pre = el.dataset.pre || '', t0 = performance.now(), dur = 900;
    const f = x => pre + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(x));
    if (reduce || !to) { el.textContent = f(to); return; }
    const tick = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = f(to * e); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
const compactINR = v => v >= 1e7 ? (v / 1e7).toFixed(v >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'Cr' : v >= 1e5 ? (v / 1e5).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : String(Math.round(v));

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
    $('#app').innerHTML = `<div class="login-solo"><h2 style="margin:0 0 6px">Quotation Builder</h2><p class="muted" style="margin:0">${esc(e.message)}</p></div>`;
  }
}
async function loadBootstrap() {
  const b = await api('bootstrap');
  S.user = b.user; S.settings = b.settings; S.clients = b.clients; S.rates = b.rates;
}
function brandMark(logo) { return logo ? `<img src="${esc(logo)}" alt="">` : `<span class="mark">${ic('roofing')}</span>`; }
function showLogin() {
  document.body.classList.remove('printmode');
  const st = S.settings || {};
  $('#app').innerHTML = `<div class="auth">
  <section class="auth-art"><div class="lg">${brandMark(st.company_logo)}<span>${esc(st.company_name || 'Infraura')}</span></div>
   <h2>Precise quotations for <em>serious</em> projects.</h2>
   <p>One workspace for roofing, interiors, construction and project management consultancy — from rate card to signed proposal.</p>
   <div class="pills"><span>${ic('roofing')} Sheet Roofing</span><span>${ic('interior')} Interiors</span><span>${ic('construction')} Construction</span><span>${ic('pmc')} PMC</span></div>
   <small>© ${new Date().getFullYear()} ${esc(st.company_name || 'Infraura')} · Authorised users only</small></section>
  <section class="auth-form"><form class="login" id="lf"><div class="eyebrow">Welcome back</div><h1>Sign in to your workspace</h1><p class="muted" style="margin:0 0 26px">Enter your credentials to continue.</p>
  <label class="f"><span>Email</span><div class="inp-ic">${ic('mail')}<input type="email" name="email" required autofocus autocomplete="username" placeholder="you@company.com"></div></label>
  <label class="f"><span>Password</span><div class="inp-ic">${ic('shield')}<input type="password" name="password" required autocomplete="current-password" placeholder="••••••••"></div></label>
  <button class="btn pri">Sign in ${ic('arrow', 'sm')}</button>
  <div class="lock">${ic('shield', 'sm')} Secured session · SSL encrypted</div></form></section></div>`;
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
const NAV = [['Workspace', [['dashboard', 'Dashboard'], ['quotes', 'Quotes'], ['clients', 'Clients']]], ['Library', [['rates', 'Rate Cards']]], ['Admin', [['settings', 'Settings']]]];
function layout() {
  const s = S.settings;
  $('#app').innerHTML = `<div class="shell"><aside class="side noprint"><div class="brand">${brandMark(s.company_logo)}<div class="bt"><b>${esc(s.company_name || 'Infraura')}</b><small>Quotation Suite</small></div></div>
  <button class="btn gold newq" data-newq>${ic('plus')} New quotation</button>
  <nav>${NAV.map(([g, items]) => `<div class="grp">${g}</div>` + items.map(([k, l]) => `<a href="#/${k}" data-n="${k}">${ic(k)}${l}</a>`).join('')).join('')}</nav>
  <div class="userbox"><div class="avatar">${esc(initials(S.user.name))}</div><div class="un"><b>${esc(S.user.name)}</b><span>${esc(S.user.role)}</span></div><button id="lo" title="Sign out" aria-label="Sign out">${ic('logout', 'sm')}</button></div></aside>
  <main class="main"><div id="view"></div></main>
  <nav class="mbar noprint"><a href="#/dashboard" data-n="dashboard">${ic('dashboard')}Home</a><a href="#/quotes" data-n="quotes">${ic('quotes')}Quotes</a><a href="#" class="fab" data-newq aria-label="New quotation">${ic('plus', 'lg')}</a><a href="#/clients" data-n="clients">${ic('clients')}Clients</a><a href="#/rates" data-n="rates">${ic('rates')}Rates</a></nav></div>`;
  $('#lo').onclick = logout;
  $$('[data-newq]').forEach(b => b.onclick = e => { e.preventDefault(); newQuoteModal(); });
}
const DIV_DESC = { roofing: 'Sheets, purlins, ridge & flashing', interior: 'Modular, ceilings, furniture', construction: 'Civil, RCC, finishing works', pmc: 'Fee calculator & resources' };
function newQuoteModal() {
  const m = openModal(`<div class="card-h"><h2 style="margin:0;flex:1">Start a new quotation</h2><button class="btn ghost ico sm" id="x" aria-label="Close">${ic('x')}</button></div><p class="muted" style="margin:-8px 0 18px">Choose a division — rate cards, GST, terms and payment stages load automatically.</p>
  <div class="divpick">${Object.entries(DIVS).map(([k, l]) => `<a href="#/quotes/new/${k}" class="dv-${k}"><span class="di">${divIc(k, 'lg')}</span><b>${l}</b><span>${DIV_DESC[k]}</span></a>`).join('')}</div>`);
  $('#x', m.el).onclick = m.close; m.el.addEventListener('click', e => { if (e.target.closest('.divpick a')) m.close(); });
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
  $$('.side nav a, .mbar a[data-n]').forEach(a => a.classList.toggle('on', a.dataset.n === p[0]));
  const v = $('#view'); v.onclick = v.oninput = v.onchange = null;
  window.scrollTo(0, 0);
  if (p[0] !== 'dashboard') v.innerHTML = '<div class="boot"><div class="spin"></div>Loading…</div>';
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
const STATUS_COL = { draft: '#8b94ab', sent: '#1f4fd1', accepted: '#0f7a4d', rejected: '#b4232c' };
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
  const statSum = ['draft', 'sent', 'accepted', 'rejected'].reduce((a, k) => a + g(k).value, 0) || 1;
  const tile = (i, color, icon, label, val, sub, pre = '₹ ') => `<div class="tile rise" style="--i:${i};--tc:${color}"><div class="ti">${ic(icon)}</div><div class="l">${label}</div><div class="v" ${typeof val === 'number' ? `data-count="${val}" data-pre="${pre}"` : ''}>${typeof val === 'number' ? pre + '0' : val}</div><div class="s">${sub}</div></div>`;
  $('#view').innerHTML = `
  <section class="hero rise"><div><div class="eyebrow">${esc(prettyDate())}</div><h1>${greeting()}, ${esc((S.user.name || '').split(' ')[0])}</h1>
   <p>${openN ? `You have <b>${openN}</b> open quotation${openN === 1 ? '' : 's'} worth <b>${inr0(open)}</b> in the pipeline.` : 'Your pipeline is clear — start a new quotation to get going.'}</p></div><span class="sp"></span>
   <button class="btn gold" data-newq2>${ic('plus')} New quotation</button></section>
  <div class="tiles">
   ${tile(1, '#223a72', 'layers', 'Total quotes', total, 'latest revisions', '')}
   ${tile(2, '#b8893b', 'trend', 'Open pipeline', open, `${openN} draft / sent`)}
   ${tile(3, '#0f7a4d', 'check', 'Accepted value', g('accepted').value, `${g('accepted').n} quotes · ${win}`)}
   ${tile(4, '#7c3aed', 'clients', 'Clients', d.clients, 'in your book', '')}
  </div>
  <div class="divcards">${Object.entries(DIVS).map(([k, label], i) => {
    const x = dv[k] || { n: 0, value: 0 };
    return `<div class="divcard dv-${k} rise" style="--i:${i + 3}"><div class="dh"><span class="di">${divIc(k)}</span><div><h4>${label}</h4><div class="muted small">${x.n} quote${x.n === 1 ? '' : 's'}</div></div></div>
    <div class="v">${inr0(x.value)}</div><div class="hbar"><i style="width:${Math.max(x.value ? 4 : 0, Math.round(x.value * 100 / maxD))}%"></i></div>
    <a class="btn sm" href="#/quotes/new/${k}">${ic('plus', 'sm')} New ${label} quote</a></div>`;
  }).join('')}</div>
  <div class="grid2" style="grid-template-columns:1.5fr 1fr">
   <div class="card rise" style="--i:6"><div class="card-h"><h3>Quote value · last 6 months</h3></div>${d.monthly.length ? (() => {
     const top = maxM; const ticks = [1, .75, .5, .25, 0].map(f => `<i><span>${f ? compactINR(top * f) : '0'}</span></i>`).join('');
     return `<div class="chart"><div class="grid">${ticks}</div><div class="bars">${d.monthly.map((m, i) => `<div class="b" style="--i:${i}"><div class="col"><span class="tip">${m.n} quote${m.n === 1 ? '' : 's'} · ${inr0(m.value)}</span><i style="height:${Math.max(2, Math.round(m.value * 100 / top))}%"></i></div><em>${esc(monthLabel(m.month))}</em></div>`).join('')}</div></div>`;
   })() : `<div class="empty"><div class="ei">${ic('trend')}</div><b>No data yet</b>Create your first quotation to see trends here.</div>`}</div>
   <div class="card rise" style="--i:7"><div class="card-h"><h3>Pipeline by status</h3></div>
    <div class="stack">${['accepted', 'sent', 'draft', 'rejected'].map(k => g(k).value ? `<i style="width:${g(k).value * 100 / statSum}%;background:${STATUS_COL[k]}"></i>` : '').join('')}</div>
    <div class="legend">${['draft', 'sent', 'accepted', 'rejected'].map(k => `<div class="lr"><span class="dot" style="--c:${STATUS_COL[k]}"></span><span>${STATUS_LABEL[k]}</span><span class="sp"></span><span class="muted small">${g(k).n}</span><b class="tnum" style="min-width:96px;text-align:right">${inr0(g(k).value)}</b></div>`).join('')}</div></div></div>
  <div class="card rise" style="--i:8"><div class="card-h"><h3>Recent quotes</h3><a class="btn sm" href="#/quotes">View all ${ic('arrow', 'sm')}</a></div>${quoteTable(d.recent)}</div>`;
  $$('[data-newq2]').forEach(b => b.onclick = newQuoteModal);
  countUp($('#view'));
}

/* ---------- quotes list ---------- */
const QF = { q: '', status: '', division: '', all: false, client_id: '' };
function quoteTable(rows) {
  if (!rows.length) return `<div class="empty"><div class="ei">${ic('quotes')}</div><b>No quotations found</b>Try changing the filters, or create a new quotation.</div>`;
  return `<div class="scroll"><table class="tbl"><thead><tr><th>Quote no.</th><th>Client / Project</th><th>Division</th><th>Date</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>${rows.map(r => `
  <tr class="click" onclick="location.hash='#/quotes/${r.id}'"><td class="nw"><a class="qno" href="#/quotes/${r.id}">${esc(r.quote_no)}</a>${r.rev ? ` <span class="muted small">Rev ${r.rev}</span>` : ''}</td>
  <td><div class="who"><span class="av">${esc(initials(r.client.name))}</span><div><b>${esc(r.client.name || '—')}</b><div class="muted small">${esc(r.title)}</div></div></div></td><td>${divChip(r.division)}</td><td class="nw muted">${fdate(r.quote_date)}</td><td class="r nw tnum"><b>${inr0(r.total)}</b></td><td>${statusChip(r.status)}</td></tr>`).join('')}</tbody></table></div>`;
}
async function pageQuotes() {
  const v = $('#view');
  const clientName = QF.client_id ? (S.clients.find(c => c.id == QF.client_id) || {}).name : '';
  const segS = [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['rejected', 'Rejected']];
  v.innerHTML = `<div class="page-head"><div class="ph-t"><h1>Quotes</h1><div class="sub">Search, filter and track every quotation across divisions.</div></div>
  <button class="btn gold" data-newq2>${ic('plus')} New quotation</button></div>
  <div class="card" style="padding:18px 20px"><div class="filters">
   <div class="inp-ic" style="flex:1;min-width:220px;max-width:340px">${ic('search')}<input id="qs" placeholder="Search quote no., client, project…" value="${esc(QF.q)}"></div>
   <div class="seg" id="sg-s">${segS.map(([k, l]) => `<button data-v="${k}" class="${QF.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
   <div class="seg" id="sg-d"><button data-v="" class="${QF.division === '' ? 'on' : ''}">All</button>${Object.entries(DIVS).map(([k, l]) => `<button data-v="${k}" class="dv-${k} ${QF.division === k ? 'on' : ''}"><i class="dot"></i>${l}</button>`).join('')}</div>
   <span class="sp"></span>
   <label class="sw"><input type="checkbox" id="qa" ${QF.all ? 'checked' : ''}> Show all revisions</label>
   ${clientName ? `<span class="chip div plain">Client: ${esc(clientName)} <a href="#" id="cc" aria-label="Clear client filter">✕</a></span>` : ''}</div>
   <div id="ql"><div class="sk" style="height:220px"></div></div></div>`;
  const load = async () => {
    const qs = new URLSearchParams();
    if (QF.q) qs.set('q', QF.q); if (QF.status) qs.set('status', QF.status);
    if (QF.division) qs.set('division', QF.division); if (QF.all) qs.set('all', '1'); if (QF.client_id) qs.set('client_id', QF.client_id);
    const rows = await api('quotes' + (qs.toString() ? '&' + qs : ''));
    $('#ql').innerHTML = quoteTable(rows) + (rows.length ? `<p class="muted small" style="margin:12px 4px 0">${rows.length} quote${rows.length === 1 ? '' : 's'} · combined value <b>${inr0(rows.filter(r => r.status !== 'superseded').reduce((a, r) => a + r.total, 0))}</b></p>` : '');
  };
  let tm; const reload = () => { clearTimeout(tm); tm = setTimeout(() => guard(load), 200); };
  const seg = (id, key) => { $(id).onclick = e => { const b = e.target.closest('button'); if (!b) return; QF[key] = b.dataset.v; $$('button', $(id)).forEach(x => x.classList.toggle('on', x === b)); reload(); }; };
  seg('#sg-s', 'status'); seg('#sg-d', 'division');
  $('#qs').oninput = e => { QF.q = e.target.value; reload(); };
  $('#qa').onchange = e => { QF.all = e.target.checked; reload(); };
  $$('[data-newq2]').forEach(b => b.onclick = newQuoteModal);
  const cc = $('#cc'); if (cc) cc.onclick = e => { e.preventDefault(); QF.client_id = ''; pageQuotes(); };
  await load();
}

/* ---------- clients ---------- */
async function pageClients() {
  const rows = await api('clients'); S.clients = rows;
  const v = $('#view');
  v.innerHTML = `<div class="page-head"><div class="ph-t"><h1>Clients</h1><div class="sub">${rows.length} client${rows.length === 1 ? '' : 's'} in your book.</div></div><button class="btn pri" data-act="new">${ic('plus')} New client</button></div>
  <div class="card"><div class="inp-ic" style="max-width:320px;margin-bottom:14px">${ic('search')}<input id="cs" placeholder="Search clients…"></div><div class="scroll"><table class="tbl"><thead><tr><th>Client</th><th>Contact</th><th>Phone</th><th>Email</th><th>GSTIN</th><th class="r">Quotes</th><th></th></tr></thead><tbody id="cb"></tbody></table></div></div>`;
  const draw = () => {
    const f = $('#cs').value.toLowerCase();
    $('#cb').innerHTML = rows.filter(c => !f || (c.name + c.phone + c.email + c.contact_person).toLowerCase().includes(f)).map(c => `<tr>
    <td><div class="who"><span class="av">${esc(initials(c.name))}</span><div><b>${esc(c.name)}</b><div class="muted small">${esc(c.address)}</div></div></div></td><td>${esc(c.contact_person)}</td><td class="nw">${esc(c.phone)}</td><td>${esc(c.email)}</td><td class="nw">${esc(c.gstin)}</td>
    <td class="r"><a class="chip div plain" href="#/quotes" data-act="q" data-id="${c.id}">${c.quote_count}</a></td>
    <td class="nw r"><button class="btn sm ico" title="Edit" aria-label="Edit" data-act="edit" data-id="${c.id}">${ic('edit', 'sm')}</button> <button class="btn sm ico dng" title="Delete" aria-label="Delete" data-act="del" data-id="${c.id}">${ic('trash', 'sm')}</button></td></tr>`).join('') || `<tr><td colspan="7"><div class="empty"><div class="ei">${ic('clients')}</div><b>No clients yet</b>Clients are added automatically when you save a quote.</div></td></tr>`;
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
  v.innerHTML = `<div class="page-head"><div class="ph-t"><h1>Rate Cards</h1><div class="sub">Your master price book — pick from it while building quotes.</div></div><button class="btn" data-act="exp">${ic('download', 'sm')} Export CSV</button><button class="btn" data-act="imp">${ic('upload', 'sm')} Import CSV</button><button class="btn pri" data-act="new">${ic('plus')} New item</button><input type="file" id="fi" accept=".csv,text/csv" hidden></div>
  <div class="card"><div class="tabs">${Object.entries(DIVS).map(([k, l]) => `<button data-act="tab" data-d="${k}" class="${k === RF.div ? 'on' : ''}">${divIc(k, 'sm')} ${l} <span class="ct">${S.rates.filter(r => r.division === k).length}</span></button>`).join('')}</div>
  <div class="row" style="margin-bottom:14px"><div class="inp-ic" style="flex:1;max-width:320px">${ic('search')}<input id="rs" placeholder="Search items…" value="${esc(RF.q)}"></div><p class="hint">${ic('info', 'sm')} Starter rates are indicative — edit to your actual costs. Inactive items stay saved but are hidden from the picker.</p></div>
  <div class="scroll"><table class="tbl"><thead><tr><th>Category</th><th>Item</th><th>Unit</th><th class="r">Rate (₹)</th><th></th></tr></thead><tbody id="rb"></tbody></table></div></div>`;
  const draw = () => {
    const f = RF.q.toLowerCase();
    const rows = S.rates.filter(r => r.division === RF.div && (!f || (r.name + r.category).toLowerCase().includes(f)));
    $('#rb').innerHTML = rows.map(r => `<tr style="${r.active ? '' : 'opacity:.5'}"><td class="nw"><span class="chip plain" style="background:var(--line2)">${esc(r.category || 'General')}</span></td><td>${esc(r.name)}${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td><td>${esc(r.unit)}</td><td class="r nw tnum"><b>${fmt(r.rate)}</b></td>
    <td class="nw r"><button class="btn sm ico" title="Edit" aria-label="Edit" data-act="edit" data-id="${r.id}">${ic('edit', 'sm')}</button> <button class="btn sm ico dng" title="Delete" aria-label="Delete" data-act="del" data-id="${r.id}">${ic('trash', 'sm')}</button></td></tr>`).join('') || `<tr><td colspan="5"><div class="empty"><div class="ei">${ic('rates')}</div><b>No items</b>Add an item or import a CSV.</div></td></tr>`;
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
      const idx = k => hasHead ? head.indexOf(k) : ['division', 'category', 'name', 'unit', 'rate', 'description'].indexOf(k);
      const items = rows.slice(hasHead ? 1 : 0).map(r => {
        const dv = (r[idx('division')] || RF.div).trim().toLowerCase().replace(/\s+/g, '');
        const division = { sheetroofing: 'roofing' }[dv] || dv;
        return { division, category: r[idx('category')] || '', name: (r[idx('name')] || '').trim(), unit: r[idx('unit')] || '', rate: n(String(r[idx('rate')] || '').replace(/,/g, '')), description: idx('description') >= 0 ? (r[idx('description')] || '') : '' };
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
      const lines = [['division', 'category', 'name', 'unit', 'rate', 'description'].join(',')].concat(S.rates.filter(r => r.division === RF.div).map(r => [r.division, r.category, r.name, r.unit, r.rate, r.description].map(csvCell).join(',')));
      download(`rate-card-${RF.div}.csv`, lines.join('\n'));
    }
  };
}
function rateModal(r) {
  const cats = [...new Set(S.rates.map(x => x.category).filter(Boolean))];
  const m = openModal(`<h2>${r.id ? 'Edit' : 'New'} rate item</h2><form id="rf">
  <div class="grid2"><label class="f"><span>Division</span><select name="division">${divOptions(r.division)}</select></label><label class="f"><span>Category</span><input name="category" list="cats" value="${esc(r.category)}"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
  <label class="f"><span>Item description *</span><input name="name" required value="${esc(r.name)}"></label>
  <div class="grid2"><label class="f"><span>Unit</span><input name="unit" list="units" value="${esc(r.unit)}"><datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist></label><label class="f"><span>Rate (₹) *</span><input name="rate" type="number" step="0.01" min="0" required value="${r.rate ?? ''}"></label></div>
  <label class="f"><span>Notes (optional)</span><input name="description" value="${esc(r.description)}"></label>
  <label class="sw" style="margin-bottom:18px"><input type="checkbox" name="active" ${r.active === 0 ? '' : 'checked'}> Active (shown in quote picker)</label>
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
  $('#view').innerHTML = `<div class="page-head"><div class="ph-t"><h1>Settings</h1><div class="sub">Company identity, quote defaults, bank details and team access.</div></div>${admin ? `<button class="btn pri" data-act="save">${ic('save', 'sm')} Save settings</button>` : '<span class="chip draft plain">View only — admin can edit</span>'}</div>
  <fieldset ${admin ? '' : 'disabled'}>
  <div class="card"><h3>Company (appears on every quotation)</h3><div class="grid2"><div>${inp('company_name', 'Company name')}${inp('company_tagline', 'Tagline')}${ta('company_address', 'Address', 3)}</div>
  <div>${inp('company_phone', 'Phone')}${inp('company_email', 'Email', 'email')}${inp('company_gstin', 'GSTIN')}${inp('signatory', 'Authorised signatory name')}</div></div>
  <div class="row" style="margin-top:4px"><div id="lg">${s.company_logo ? `<img src="${esc(s.company_logo)}" style="max-height:60px;background:#f1f5f9;padding:4px;border-radius:6px">` : '<span class="muted small">No logo</span>'}</div>
  <label class="btn sm">${ic('upload', 'sm')} Upload logo<input type="file" id="logo" accept="image/png,image/jpeg" hidden></label><button type="button" class="btn sm" data-act="rmlogo">Remove</button></div></div>
  <div class="card"><h3>Quote defaults</h3><div class="grid3">${inp('quote_prefix', 'Quote number prefix')}${inp('validity_days', 'Validity (days)', 'number')}<span></span>
  ${Object.entries(DIVS).map(([k, l]) => inp('gst_' + k, 'GST % — ' + l, 'number')).join('')}</div></div>
  <div class="card"><h3>Bank details (printed on quotations)</h3>${ta('bank_details', 'Bank details', 5)}</div>
  <div class="card"><h3>Default terms &amp; conditions (one per line)</h3><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('terms_' + k, l, 8)).join('')}</div></div>
  <div class="card"><h3>Default payment schedule — one stage per line as "Stage name|percent"</h3><div class="grid2">${Object.entries(DIVS).map(([k, l]) => ta('pay_' + k, l, 5)).join('')}</div></div></fieldset>
  <div class="grid2"><div class="card"><h3>Change my password</h3><form id="pw"><label class="f"><span>Current password</span><input type="password" name="current" required></label><label class="f"><span>New password (min 8)</span><input type="password" name="new" minlength="8" required></label><button class="btn pri">Update password</button></form></div>
  ${admin ? `<div class="card"><h3>Team</h3><div id="ul"></div><form id="uf" style="margin-top:12px"><div class="grid2"><label class="f"><span>Name</span><input name="name" required></label><label class="f"><span>Email</span><input name="email" type="email" required></label><label class="f"><span>Password</span><input name="password" type="password" minlength="8" required></label><label class="f"><span>Role</span><select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label></div><button class="btn pri">${ic('plus', 'sm')} Add user</button></form></div>` : ''}</div>`;
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
      S.settings = await api('settings', 'PUT', body); toast('Settings saved', 'ok'); layout(); route();
    });
    if (t.dataset.act === 'deluser' && confirmBox('Remove this user?')) guard(async () => { await api('users/' + t.dataset.id, 'DELETE'); loadUsers(); });
  };
  $('#pw').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('auth/password', 'POST', { current: f.current.value, new: f.new.value }); toast('Password updated', 'ok'); f.reset(); }); };
  async function loadUsers() {
    const us = await api('users');
    $('#ul').innerHTML = `<table class="tbl"><tbody>${us.map(u => `<tr><td><div class="who"><span class="av">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></div></div></td><td><span class="chip div plain">${esc(u.role)}</span></td><td class="r">${u.id === S.user.id ? '<span class="muted small">you</span>' : `<button class="btn sm dng" data-act="deluser" data-id="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>`;
  }
  if (admin) {
    await loadUsers();
    $('#uf').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('users', 'POST', Object.fromEntries(new FormData(f))); toast('User added', 'ok'); f.reset(); loadUsers(); }); };
  }
}
