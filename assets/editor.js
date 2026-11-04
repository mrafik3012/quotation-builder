'use strict';
/* Quote editor, PMC fee calculator and printable quotation */

let Q = null;
const SEC_TITLE = { roofing: 'Roofing Works', interior: 'Interior Works', construction: 'Construction Works', pmc: 'PMC Services' };
const PMC_SEC = 'PMC Fees (calculated)';

function parsePay(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, p] = l.split('|'); return { label: label.trim(), percent: n(p) }; });
}
function setPath(obj, path, val) {
  const k = path.split('.'); let o = obj;
  for (let i = 0; i < k.length - 1; i++) { if (o[k[i]] == null || typeof o[k[i]] !== 'object') o[k[i]] = {}; o = o[k[i]]; }
  o[k[k.length - 1]] = val;
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function normalizeQuote() {
  const d = Q.data = Q.data || {};
  d.sections = Array.isArray(d.sections) ? d.sections : [];
  d.discount = d.discount && typeof d.discount === 'object' ? d.discount : { type: 'percent', value: 0 };
  d.tax_rate = d.tax_rate ?? 18;
  d.payment_schedule = Array.isArray(d.payment_schedule) ? d.payment_schedule : [];
  d.terms = Array.isArray(d.terms) ? d.terms : [];
  d.source = d.source || ''; d.gst_mode = d.gst_mode || ''; d.hsn = d.hsn || ''; d.notes = d.notes || ''; d.scope = d.scope || ''; d.site_address = d.site_address || ''; d.area_sqft = d.area_sqft || '';
  d.options = Array.isArray(d.options) ? d.options.map(o => ({ name: o.name || '', note: o.note || '', sections: Array.isArray(o.sections) ? o.sections : [] })) : [];
  d.selected_option = d.options.length ? Math.min(Math.max(+d.selected_option || 0, 0), d.options.length - 1) : 0;
  d.pmc = d.pmc && typeof d.pmc === 'object' ? d.pmc : { mode: 'percent', base_cost: '', percent: 4, area: '', per_sqft: 60, months: '', monthly_fee: 85000 };
  const c = Q.client && typeof Q.client === 'object' && !Array.isArray(Q.client) ? Q.client : {};
  Q.client = { name: c.name || '', contact_person: c.contact_person || '', phone: c.phone || '', email: c.email || '', address: c.address || '', gstin: c.gstin || '' };
}
function newQuote(div) {
  const s = S.settings, date = today();
  Q = {
    id: null, quote_no: '', rev: 0, division: div, status: 'draft', client_id: null, client: {}, title: '', quote_date: date,
    valid_until: addDays(date, parseInt(s.validity_days) || 15), revisions: [],
    data: {
      sections: [{ title: SEC_TITLE[div], items: [] }], discount: { type: 'percent', value: 0 }, tax_rate: n(s['gst_' + div] || 18), round_off: false,
      payment_schedule: parsePay(s['pay_' + div]), terms: (s['terms_' + div] || '').split('\n').map(x => x.trim()).filter(Boolean), notes: '', scope: '', site_address: '', area_sqft: '',
      pmc: null, hsn: s['hsn_' + div] || '', gst_mode: '',
    },
  };
  normalizeQuote();
}

async function pageEditor(id, div) {
  if (id) {
    const r = await api('quotes/' + id);
    Q = r.quote; Q.revisions = r.revisions; Q.share = r.share; Q.events = r.events || []; Q.project = r.project; normalizeQuote();
  } else {
    if (!DIVS[div]) { location.hash = '#/quotes'; return; }
    newQuote(div);
  }
  window.__dirty = false;
  drawEditor();
}

/* ---------- calculations ---------- */
function totals(d) {
  let sub = 0;
  effSections(d).forEach(s => s.items.forEach(it => { sub += r2(n(it.qty) * n(it.rate)); }));
  sub = r2(sub);
  let disc = d.discount.type === 'flat' ? n(d.discount.value) : sub * n(d.discount.value) / 100;
  disc = r2(Math.min(Math.max(disc, 0), sub));
  const taxable = sub - disc, tax = r2(taxable * n(d.tax_rate) / 100);
  let total = taxable + tax, ro = 0;
  if (d.round_off) { const r = Math.floor(r2(total) + 0.5); ro = r2(r - total); total = r; }
  return { sub: r2(sub), disc: r2(disc), taxable: r2(taxable), tax, ro, total: r2(total) };
}
function pmcFee() {
  const p = Q.data.pmc;
  if (p.mode === 'percent') return r2(n(p.base_cost) * n(p.percent) / 100);
  if (p.mode === 'sqft') return r2(n(p.area) * n(p.per_sqft));
  return r2(n(p.months) * n(p.monthly_fee));
}

/* ---------- rendering ---------- */
function drawEditor() {
  const sup = Q.status === 'superseded', acc = Q.status === 'accepted', ro = sup || acc, isNew = !Q.id, v = $('#view');
  v.innerHTML = `
  <datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist>
  <div class="page-head noprint"><h1>${isNew ? 'New ' + esc(DIVS[Q.division]) + ' quote' : esc(Q.quote_no) + (Q.rev ? ` <span class="muted">· Rev ${Q.rev}</span>` : '')}</h1>
   ${divChip(Q.division)} ${isNew ? '' : statusChip(Q.status)}</div>
  <div class="row noprint" style="margin-bottom:14px">
   ${ro ? '' : '<button class="btn pri" data-act="save">Save</button>'}
   ${isNew || sup ? '' : '<button class="btn pri" data-act="share">' + (acc ? 'Client link' : 'Share with client') + '</button>'}
   ${Q.status === 'accepted' && Q.id ? (Q.project ? `<a class="btn pri" href="#/projects/${Q.project}">Open project</a>` : '<button class="btn pri" data-act="toproject">Convert to project</button>') : ''}
   ${Q.division === 'roofing' && !ro ? '<button class="btn" data-act="roofcalc">Roofing calculator</button>' : ''}
   ${isNew ? '' : `<a class="btn" href="#/quotes/${Q.id}/print">Preview / PDF</a>`}
   ${isNew || sup || (acc && S.user.role !== 'admin') ? '' : `<select id="stsel" style="width:auto"><option disabled>Status…</option>${['draft', 'sent', 'accepted', 'rejected'].map(k => `<option value="${k}" ${Q.status === k ? 'selected' : ''}>${STATUS_LABEL[k]}</option>`).join('')}</select>`}
   <span class="sp"></span>
   ${isNew || sup || Q.project ? '' : '<button class="btn" data-act="revise">New revision</button>'}
   ${Q.division === 'interior' && !ro ? '<button class="btn" data-act="rooms">+ Add rooms</button>' : ''}
   ${isNew ? '' : '<button class="btn" data-act="csv">Export lines (CSV)</button>'}
   ${ro ? '' : '<button class="btn" data-act="savetpl" title="Reuse these sections on future quotes">Save as template</button>'}
   ${isNew ? '' : '<button class="btn" data-act="dup">Duplicate</button>'}
   ${isNew || Q.status !== 'draft' ? '' : '<button class="btn dng" data-act="del">Delete</button>'}
  </div>
  ${acc ? `<div class="banner"><b>Accepted - locked.</b> The client has accepted this quotation, so it can no longer be edited.${Q.project ? ' Record changes as variation orders in the project.' : ' To change it, create a <b>New revision</b>' + (S.user.role === 'admin' ? ' or re-open it using the Status menu.' : ' (an admin can also re-open it).')}</div>` : ''}
  ${sup ? `<div class="banner">This is Rev ${Q.rev}, which has been superseded and is read-only. <a href="#" data-act="latest">Open the latest revision</a>.</div>` : ''}
  <fieldset ${ro ? 'disabled' : ''}>
  ${isNew ? tplBar() : ''}
  <div class="grid2">
   <div class="card"><h3>Client</h3>
    <label class="f"><span>Saved client</span><select id="clientsel"><option value="">— Type new client below —</option>${S.clients.map(c => `<option value="${c.id}" ${Q.client_id == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Client name *</span><input data-b="client.name" value="${esc(Q.client.name)}"></label>
    <div class="grid2"><label class="f"><span>Contact person</span><input data-b="client.contact_person" value="${esc(Q.client.contact_person)}"></label><label class="f"><span>Phone</span><input data-b="client.phone" value="${esc(Q.client.phone)}"></label>
    <label class="f"><span>Email</span><input data-b="client.email" value="${esc(Q.client.email)}"></label><label class="f"><span>GSTIN</span><input data-b="client.gstin" value="${esc(Q.client.gstin)}"></label></div>
    <label class="f"><span>Billing address</span><textarea data-b="client.address" rows="2">${esc(Q.client.address)}</textarea></label>
    <p class="muted small" style="margin:0">New client names are saved to your client list automatically. Editing here changes this quote only.</p></div>
   <div class="card"><h3>Project</h3>
    <label class="f"><span>Quotation title / project name</span><input data-b="title" value="${esc(Q.title)}" placeholder="e.g. Warehouse roofing — Phase 1"></label>
    <label class="f"><span>Site address</span><textarea data-b="data.site_address" rows="2">${esc(Q.data.site_address)}</textarea></label>
    <div class="grid3"><label class="f"><span>Built-up / project area (sq ft)</span><input type="number" step="any" min="0" data-b="data.area_sqft" value="${esc(Q.data.area_sqft)}"></label>
    <label class="f"><span>Quote date</span><input type="date" data-b="quote_date" value="${esc(Q.quote_date)}"></label>
    <label class="f"><span>Valid until</span><input type="date" data-b="valid_until" value="${esc(Q.valid_until)}"></label></div>
    <label class="f"><span>Lead source (internal, for reports)</span><select data-b="data.source"><option value="">—</option>${['Referral', 'Walk-in', 'Website', 'WhatsApp', 'Instagram', 'Facebook', 'Google', 'Repeat client', 'Tender', 'Other'].map(x => `<option ${Q.data.source === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="f"><span>Scope of work (printed above the items)</span><textarea data-b="data.scope" rows="3">${esc(Q.data.scope)}</textarea></label></div>
  </div>
  <div id="pmcbox"></div>
  <div id="sections"></div>
  <div class="row" style="margin-bottom:16px"><button class="btn" data-act="addsec">+ Add section</button><span class="muted small" id="rsq"></span></div>
  <div id="optbox"></div>
  <div class="grid2">
   <div class="card"><h3>Summary</h3>
    <div class="grid3"><label class="f"><span>Discount type</span><select data-b="data.discount.type"><option value="percent" ${Q.data.discount.type !== 'flat' ? 'selected' : ''}>Percent %</option><option value="flat" ${Q.data.discount.type === 'flat' ? 'selected' : ''}>Flat ₹</option></select></label>
    <label class="f"><span>Discount</span><input type="number" step="any" min="0" data-b="data.discount.value" value="${esc(Q.data.discount.value)}"></label>
    <label class="f"><span>GST %</span><input type="number" step="any" min="0" data-b="data.tax_rate" value="${esc(Q.data.tax_rate)}"></label></div>
    <div class="grid2"><label class="f"><span>Place of supply (tax split)</span><select data-b="data.gst_mode"><option value="" ${!Q.data.gst_mode ? 'selected' : ''}>Auto (from GSTIN)</option><option value="intra" ${Q.data.gst_mode === 'intra' ? 'selected' : ''}>Same state — CGST + SGST</option><option value="inter" ${Q.data.gst_mode === 'inter' ? 'selected' : ''}>Other state — IGST</option></select></label>
    <label class="f"><span>HSN / SAC code</span><input data-b="data.hsn" value="${esc(Q.data.hsn)}"></label></div>
    <label class="row small" style="gap:6px;margin-bottom:10px"><input type="checkbox" data-b="data.round_off" ${Q.data.round_off ? 'checked' : ''}> Round off grand total to nearest rupee</label>
    <table class="totals"><tr><td>Subtotal</td><td id="t-sub"></td></tr><tr><td>Discount</td><td id="t-disc"></td></tr><tr><td>Taxable amount</td><td id="t-taxable"></td></tr><tr><td id="t-gstl">GST</td><td id="t-tax"></td></tr><tr id="t-rorow"><td>Round off</td><td id="t-ro"></td></tr><tr class="g"><td>Grand total</td><td id="t-total"></td></tr></table>
    <p class="muted small" id="t-words" style="margin:8px 0 0"></p><div id="marginbox" class="noprint" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)"></div></div>
   <div class="card"><h3>Payment schedule</h3><div id="paybox"></div></div>
  </div>
  <div class="grid2"><div class="card"><h3>Terms &amp; conditions (one per line)</h3><textarea data-b="terms_text" rows="9">${esc(Q.data.terms.join('\n'))}</textarea></div>
  <div class="card"><h3>Notes (printed at the end)</h3><textarea data-b="data.notes" rows="9">${esc(Q.data.notes)}</textarea></div></div>
  </fieldset>
  ${activityHtml()}
  ${Q.revisions && Q.revisions.length > 1 ? `<div class="card noprint"><h3>Revision history</h3>${Q.revisions.map(r => `<div class="row" style="margin-bottom:4px"><a href="#/quotes/${r.id}">Rev ${r.rev}</a>${statusChip(r.status)}<span class="muted small">${esc(r.updated_at)}</span><span class="sp"></span><b>${inr0(r.total)}</b></div>`).join('')}</div>` : ''}`;
  drawPmc(); drawSections(); drawOptions(); drawPay(); recalc();
  wireEditor();
}

function shareUrl(tok) { return location.href.split('#')[0].replace(/[^/]*$/, '') + 'view.html?t=' + tok; }
function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}
async function shareQuote() {
  if (Q.status !== 'accepted') await ensureSaved();
  const r = await api(`quotes/${Q.id}/share`, 'POST'); Q.share = r.token; Q.updated_at = r.updated_at; if (Q.status === 'draft') Q.status = 'sent';
  const url = shareUrl(r.token), s = S.settings, c = Q.client;
  const msg = `Hello ${c.contact_person || c.name || ''},\nPlease find your quotation ${Q.quote_no}${Q.title ? ' for ' + Q.title : ''} from ${s.company_name}.\nView, choose your option and accept online: ${url}\nValid until ${fdate(Q.valid_until)}.`;
  const m = openModal(`<h2>Share quotation ${esc(Q.quote_no)}</h2>
  <p class="muted small" style="margin-top:0">Anyone with this private link can view the quotation, pick an option and accept or decline it. Status is set to <b>Sent</b>.</p>
  <label class="f"><span>Client link</span><input id="shl" readonly value="${esc(url)}"></label>
  <label class="f"><span>Message</span><textarea id="shm" rows="5">${esc(msg)}</textarea></label>
  <div class="row"><button class="btn" id="shc">Copy link</button><a class="btn pri" id="shw" target="_blank" rel="noopener">Send on WhatsApp</a><a class="btn" id="she">Email</a><span class="sp"></span><button class="btn dng" id="shr" title="Stops the link working immediately">Revoke link</button><button class="btn" id="shx">Close</button></div>
  ${c.phone ? '' : '<p class="muted small" style="margin:10px 0 0">No client phone saved - WhatsApp will ask you to pick a contact.</p>'}`);
  const upd = () => { const t = $('#shm', m.el).value; $('#shw', m.el).href = waLink(c.phone, t); $('#she', m.el).href = `mailto:${encodeURIComponent(c.email || '')}?subject=${encodeURIComponent('Quotation ' + Q.quote_no + ' - ' + s.company_name)}&body=${encodeURIComponent(t)}`; };
  upd(); $('#shm', m.el).oninput = upd;
  $('#shc', m.el).onclick = async () => { try { await navigator.clipboard.writeText(url); } catch (e) { $('#shl', m.el).select(); document.execCommand('copy'); } toast('Link copied', 'ok'); };
  $('#shx', m.el).onclick = () => { m.close(); pageEditor(Q.id); };
  $('#shr', m.el).onclick = () => { if (confirmBox('Revoke this link? The client will no longer be able to open it. You can create a new link any time.')) guard(async () => { await api(`quotes/${Q.id}/share`, 'DELETE'); toast('Link revoked', 'ok'); m.close(); pageEditor(Q.id); }); };
}
function activityHtml() {
  if (!Q.id || !Q.events || !Q.events.length) return '';
  const lab = e => ({ view: 'Client viewed the quotation', shared: 'Link shared' + (e.detail && e.detail.by ? ' by ' + esc(e.detail.by) : ''),
    accepted: `<b class="good">Accepted</b> by ${esc(e.actor || '')}${e.detail && e.detail.option ? ' — ' + esc(e.detail.option) : ''}${e.has_signature ? ' (e-signed)' : ''}${e.detail && e.detail.note ? '<br><span class="muted">“' + esc(e.detail.note) + '”</span>' : ''}`,
    rejected: `<b class="bad">Declined</b>${e.actor ? ' by ' + esc(e.actor) : ''}${e.detail && e.detail.note ? '<br><span class="muted">“' + esc(e.detail.note) + '”</span>' : ''}` }[e.type] || esc(e.type));
  const views = Q.events.filter(e => e.type === 'view').length;
  return `<div class="card noprint"><h3>Client activity${views ? ` · viewed ${views}×` : ''}</h3>${Q.events.map(e => `<div class="row small" style="margin-bottom:6px;align-items:flex-start"><span class="muted nw">${esc(e.created_at.slice(0, 16))}</span><span>${lab(e)}${e.rev ? ` <span class="muted">(Rev ${e.rev})</span>` : ''}</span></div>`).join('')}</div>`;
}

function tplBar() {
  const list = (S.templates || []).filter(t => t.division === Q.division);
  if (!list.length) return '';
  return `<div class="card noprint"><h3>Start from a template</h3><div class="row"><select id="tplsel" style="max-width:360px">${list.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button type="button" class="btn" data-act="usetpl">Load template</button><span class="muted small">Fills the sections below - edit quantities and rates as needed. Save your own with “Save as template”.</span></div></div>`;
}
function useTemplate() {
  const t = (S.templates || []).find(x => x.id == $('#tplsel').value); if (!t) return;
  if (Q.data.sections.some(s => s.items.length) && !confirmBox('Replace the current sections with this template?')) return;
  const d = JSON.parse(JSON.stringify(t.data || {}));
  Q.data.sections = Array.isArray(d.sections) && d.sections.length ? d.sections : Q.data.sections;
  if (Array.isArray(d.terms) && d.terms.length) Q.data.terms = d.terms;
  if (d.scope) Q.data.scope = d.scope;
  if (d.notes) Q.data.notes = d.notes;
  markDirty(); drawEditor(); toast('Template loaded', 'ok');
}
function saveTemplate() {
  const name = window.prompt('Template name (e.g. "40x100 ft godown - GI roof")', Q.title || '');
  if (!name || !name.trim()) return;
  guard(async () => {
    const d = Q.data;
    await api('templates', 'POST', { name: name.trim(), division: Q.division, data: { sections: d.sections, terms: d.terms, scope: d.scope, notes: d.notes } });
    S.templates = await api('templates'); toast('Template saved', 'ok');
  });
}

function drawPmc() {
  const box = $('#pmcbox');
  if (Q.division !== 'pmc') { box.innerHTML = ''; return; }
  const p = Q.data.pmc;
  const mode = (k, l) => `<label class="${p.mode === k ? 'on' : ''}"><input type="radio" name="pmcmode" value="${k}" data-b="data.pmc.mode" ${p.mode === k ? 'checked' : ''}>${l}</label>`;
  const f = (k, l, step = 'any') => `<label class="f"><span>${l}</span><input type="number" step="${step}" min="0" data-b="data.pmc.${k}" data-pmc="1" value="${esc(p[k])}"></label>`;
  box.innerHTML = `<div class="card"><h3>PMC fee calculator</h3>
  <div class="pmc-modes">${mode('percent', '% of project cost')}${mode('sqft', 'Per sq ft of area')}${mode('monthly', 'Monthly retainer')}</div>
  <div class="grid3">${p.mode === 'percent' ? f('base_cost', 'Estimated project cost (₹)') + f('percent', 'PMC fee (%)') : ''}
   ${p.mode === 'sqft' ? f('area', 'Built-up area (sq ft)') + f('per_sqft', 'Fee per sq ft (₹)') : ''}
   ${p.mode === 'monthly' ? f('months', 'Duration (months)') + f('monthly_fee', 'Monthly fee (₹)') : ''}
   <div class="feebox" style="align-self:end">Fee: <span id="pmcfee"></span></div></div>
  <div class="row" style="margin-top:12px"><button class="btn pri" data-act="pmcapply">Add fee to quote</button><button class="btn" data-act="pmcpay">Use PMC payment stages</button>
  <span class="muted small">Adds a line under “${PMC_SEC}”. Add resources (site engineer, QS, audits…) from the rate card below.</span></div></div>`;
  updPmc();
}
function updPmc() { const e = $('#pmcfee'); if (e) e.textContent = inr(pmcFee()); }

function secHtml(si) {
  const s = Q.data.sections[si];
  return `<div class="sec" data-s="${si}"><div class="sec-h"><span class="muted">${si + 1}.</span><input data-sf="title" value="${esc(s.title)}" placeholder="Section title">
   <span class="muted small nw" id="ss-${si}"></span>${Q.data.sections.length > 1 ? '<button class="btn sm dng" data-act="delsec" title="Remove section">✕</button>' : ''}</div>
  <div class="scroll"><table class="items"><thead><tr><th>#</th><th>Description</th><th>Unit</th><th>Qty</th><th>Rate (₹)</th><th title="Internal - never printed">Cost (₹)</th><th class="r">Amount (₹)</th><th></th></tr></thead><tbody>
  ${s.items.map((it, ii) => `<tr data-i="${ii}"><td class="muted" style="width:38px;padding-top:11px">${si + 1}.${ii + 1}</td>
   <td><textarea data-f="desc" rows="1">${esc(it.desc)}</textarea></td><td style="width:84px"><input data-f="unit" list="units" value="${esc(it.unit)}"></td>
   <td style="width:96px"><input data-f="qty" type="number" step="any" min="0" value="${esc(it.qty)}"></td><td style="width:116px"><input data-f="rate" type="number" step="any" min="0" value="${esc(it.rate)}"></td><td style="width:100px"><input data-f="cost" type="number" step="any" min="0" value="${esc(it.cost ?? '')}" title="Your cost - internal only" style="color:var(--mut)"></td>
   <td class="amt" style="width:120px" id="a-${si}-${ii}"></td><td style="width:34px"><button class="btn sm dng" data-act="delitem" title="Remove">✕</button></td></tr>`).join('')}
  </tbody></table></div>
  <div class="sec-f"><button class="btn sm" data-act="addrate">+ From rate card</button><button class="btn sm" data-act="additem">+ Custom item</button>${Q.division === 'interior' || (s.images || []).length ? '<button class="btn sm" data-act="secimg" title="Add a photo or render shown under this section on the quotation">+ Image</button>' : ''}${(s.images || []).map((im, k) => `<span><img src="${im}" style="height:34px;border-radius:4px;vertical-align:middle"><a href="#" data-act="delimg" data-k="${k}" style="margin-left:2px" title="Remove">✕</a></span>`).join('')}</div></div>`;
}
function drawSections() {
  $('#sections').innerHTML = Q.data.sections.map((_, i) => secHtml(i)).join('');
  $$('#sections textarea').forEach(growTa);
  recalc();
}
function growTa(t) { t.style.height = 'auto'; t.style.height = Math.max(34, t.scrollHeight) + 'px'; }

function drawPay() {
  const pay = Q.data.payment_schedule;
  $('#paybox').innerHTML = `<table class="items" style="min-width:0"><tbody>${pay.map((p, i) => `<tr data-p="${i}"><td><input data-pf="label" value="${esc(p.label)}" placeholder="Stage"></td>
  <td style="width:78px"><input data-pf="percent" type="number" step="any" min="0" value="${esc(p.percent)}"></td><td class="amt" style="width:110px" id="pa-${i}"></td><td style="width:34px"><button class="btn sm dng" data-act="delpay">✕</button></td></tr>`).join('')}</tbody></table>
  <div class="row" style="margin-top:8px"><button class="btn sm" data-act="addpay">+ Add stage</button><span class="sp"></span><span class="small" id="paytot"></span></div>`;
  recalc();
}

function recalc() {
  if (!Q || !$('#t-total')) return;
  const d = Q.data, t = totals(d);
  $('#t-sub').textContent = inr(t.sub); $('#t-disc').textContent = t.disc ? '− ' + inr(t.disc) : inr(0);
  $('#t-taxable').textContent = inr(t.taxable); { const gm = gstMode(d, S.settings, Q.client); $('#t-gstl').textContent = gm === 'inter' ? `IGST @ ${n(d.tax_rate)}%` : gm === 'intra' ? `CGST + SGST @ ${n(d.tax_rate)}%` : `GST @ ${n(d.tax_rate)}%`; } $('#t-tax').textContent = inr(t.tax);
  $('#t-rorow').style.display = d.round_off ? '' : 'none'; $('#t-ro').textContent = (t.ro < 0 ? '− ' : '') + inr(Math.abs(t.ro));
  $('#t-total').textContent = inr(t.total); $('#t-words').textContent = amountWords(t.total);
  d.sections.forEach((s, si) => {
    let st = 0;
    s.items.forEach((it, ii) => { const a = r2(n(it.qty) * n(it.rate)); st += a; const e = $(`#a-${si}-${ii}`); if (e) e.textContent = fmt(a); });
    const e = $(`#ss-${si}`); if (e) e.textContent = 'Section total ' + inr(st);
  });
  let pp = 0;
  d.payment_schedule.forEach((p, i) => { pp += n(p.percent); const e = $(`#pa-${i}`); if (e) e.textContent = inr(r2(t.total * n(p.percent) / 100)); });
  const pt = $('#paytot');
  if (pt) { pt.textContent = `Total ${r2(pp)}%`; pt.style.color = d.payment_schedule.length && Math.abs(pp - 100) > 0.01 ? 'var(--bad)' : 'var(--ok)'; pt.title = Math.abs(pp - 100) > 0.01 ? 'Stages should add up to 100%' : ''; }
  drawMargin(d, t);
  const rsq = $('#rsq'), area = n(d.area_sqft);
  if (rsq) rsq.textContent = area > 0 && t.sub > 0 ? `≈ ${inr0(t.total / area)} per sq ft (incl. GST) on ${area} sq ft` : '';
}

function drawMargin(d, t) {
  const box = $('#marginbox'); if (!box) return;
  let cost = 0, rev = 0, missing = 0;
  effSections(d).forEach(s => s.items.forEach(it => { const a = n(it.qty) * n(it.rate); if (a <= 0) return; if (n(it.cost) > 0) { cost += n(it.qty) * n(it.cost); rev += a; } else missing++; }));
  if (rev <= 0) { box.innerHTML = '<span class="muted small">Internal margin: add costs to line items (or rate cards) to see your margin. Never printed.</span>'; return; }
  const net = rev * (t.sub > 0 ? t.taxable / t.sub : 1), m = net - cost, pct = net > 0 ? m / net * 100 : 0, min = n(S.settings.min_margin);
  const low = min > 0 && pct < min;
  box.innerHTML = `<div class="small"><b>Internal margin</b> <span class="muted">(never printed)</span><br>Cost ${inr0(cost)} · Margin <b class="${low ? 'bad' : 'good'}">${inr0(m)} (${pct.toFixed(1)}%)</b>${low ? ` <span class="bad">— below your ${min}% target</span>` : ''}${missing ? `<br><span class="muted">${missing} line(s) have no cost and are excluded.</span>` : ''}</div>`;
}

/* ---------- events ---------- */
function markDirty() { window.__dirty = true; }
function wireEditor() {
  const v = $('#view');
  const onField = e => {
    const t = e.target;
    if (t.id === 'stsel') return;
    if (t.id === 'clientsel') {
      const c = S.clients.find(x => x.id == t.value);
      Q.client_id = c ? c.id : null;
      if (c) { Q.client = { name: c.name || '', contact_person: c.contact_person || '', phone: c.phone || '', email: c.email || '', address: c.address || '', gstin: c.gstin || '' }; $$('[data-b^="client."]').forEach(el => el.value = Q.client[el.dataset.b.slice(7)] || ''); }
      markDirty(); return;
    }
    if (t.dataset.b) {
      const val = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.b === 'terms_text') Q.data.terms = val.split('\n').map(x => x.trim()).filter(Boolean);
      else if (t.type === 'radio') { if (!t.checked) return; setPath(Q, t.dataset.b, val); drawPmc(); }
      else setPath(Q, t.dataset.b, val);
      if (t.dataset.b.startsWith('client.') && t.dataset.b === 'client.name') Q.client_id = Q.client_id && S.clients.find(c => c.id == Q.client_id && c.name === val) ? Q.client_id : (Q.client_id || null);
      if (t.dataset.pmc) updPmc();
      markDirty(); recalc(); return;
    }
    if (optionsInput(t)) return;
    const sec = t.closest('.sec');
    if (sec && t.dataset.sf) { Q.data.sections[+sec.dataset.s].title = t.value; markDirty(); return; }
    if (sec && t.dataset.f) {
      const tr = t.closest('tr'); Q.data.sections[+sec.dataset.s].items[+tr.dataset.i][t.dataset.f] = t.value;
      if (t.tagName === 'TEXTAREA') growTa(t);
      markDirty(); recalc(); return;
    }
    if (t.dataset.pf) { Q.data.payment_schedule[+t.closest('tr').dataset.p][t.dataset.pf] = t.value; markDirty(); recalc(); }
  };
  v.oninput = onField;
  v.onchange = e => {
    if (e.target.id === 'stsel') return setStatus(e.target.value);
    if (e.target.dataset.act === 'optsel') return optionsClick('optsel', e.target);
    if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT' || e.target.type === 'radio') onField(e);
  };
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act, sec = t.closest('.sec'), si = sec && sec.dataset.s != null ? +sec.dataset.s : -1;
    if (a.startsWith('opt')) { if (a !== 'optsel') optionsClick(a, t); return; }
    if (a === 'latest') { e.preventDefault(); const l = Q.revisions.find(r => r.status !== 'superseded') || Q.revisions[0]; if (l) location.hash = '#/quotes/' + l.id; }
    else if (a === 'save') guard(saveQuote);
    else if (a === 'share') guard(shareQuote);
    else if (a === 'toproject') guard(async () => { await ensureSaved(); const r = await api('projects', 'POST', { quote_id: Q.id }); toast('Project created', 'ok'); location.hash = '#/projects/' + r.id; });
    else if (a === 'rooms') roomsModal();
    else if (a === 'csv') exportLines();
    else if (a === 'secimg') addSecImage(si);
    else if (a === 'delimg') { e.preventDefault(); Q.data.sections[si].images.splice(+t.dataset.k, 1); markDirty(); drawSections(); }
    else if (a === 'usetpl') useTemplate();
    else if (a === 'savetpl') saveTemplate();
    else if (a === 'roofcalc') openRoofCalc();
    else if (a === 'addsec') { Q.data.sections.push({ title: '', items: [] }); markDirty(); drawSections(); }
    else if (a === 'delsec') { const s = Q.data.sections[si]; if (!s.items.length || confirmBox('Remove this section and its items?')) { Q.data.sections.splice(si, 1); markDirty(); drawSections(); } }
    else if (a === 'additem') { Q.data.sections[si].items.push({ desc: '', unit: '', qty: 1, rate: '', cost: '' }); markDirty(); drawSections(); const ts = $$('#sections .sec')[si].querySelectorAll('textarea'); if (ts.length) ts[ts.length - 1].focus(); }
    else if (a === 'delitem') { Q.data.sections[si].items.splice(+t.closest('tr').dataset.i, 1); markDirty(); drawSections(); }
    else if (a === 'addrate') pickRates(si);
    else if (a === 'addpay') { Q.data.payment_schedule.push({ label: '', percent: '' }); markDirty(); drawPay(); }
    else if (a === 'delpay') { Q.data.payment_schedule.splice(+t.closest('tr').dataset.p, 1); markDirty(); drawPay(); }
    else if (a === 'pmcpay') { Q.data.payment_schedule = parsePay(S.settings.pay_pmc); markDirty(); drawPay(); toast('Payment stages set', 'ok'); }
    else if (a === 'pmcapply') applyPmc();
    else if (a === 'revise') guard(reviseQuote);
    else if (a === 'dup') guard(dupQuote);
    else if (a === 'del') { if (confirmBox('Delete this draft quote (all revisions)? This cannot be undone.')) guard(async () => { await api('quotes/' + Q.id, 'DELETE'); window.__dirty = false; toast('Deleted', 'ok'); location.hash = '#/quotes'; }); }
  };
  $$('#view textarea').forEach(growTa);
}

const ROOMS = ['Living Room', 'Dining Area', 'Kitchen', 'Master Bedroom', 'Bedroom 2', 'Bedroom 3', 'Kids Room', 'Guest Room', 'Bathrooms', 'Balcony', 'Pooja Room', 'Study / Home Office', 'Foyer / Entrance', 'Utility / Wash Area', 'Whole house (ceiling, paint, electrical)'];
function roomsModal() {
  const m = openModal(`<h2>Add rooms</h2><p class="muted small" style="margin-top:0">Creates one section per room so the quote and its subtotals read room by room. Add items from the rate card inside each room.</p>
  <div class="pmc-modes" id="rl">${ROOMS.map(r => `<label><input type="checkbox" value="${esc(r)}">${esc(r)}</label>`).join('')}</div>
  <div class="row" style="margin-top:8px"><input id="rc" placeholder="Other room (optional)" style="flex:1"><span class="sp"></span><button class="btn" id="rx2">Cancel</button><button class="btn pri" id="rok">Add</button></div>`, true);
  $$('#rl label', m.el).forEach(l => { l.querySelector('input').onchange = () => l.classList.toggle('on', l.querySelector('input').checked); });
  $('#rx2', m.el).onclick = m.close;
  $('#rok', m.el).onclick = () => {
    const names = $$('#rl input:checked', m.el).map(x => x.value), o = $('#rc', m.el).value.trim(); if (o) names.push(o);
    if (!names.length) { m.close(); return; }
    const secs = Q.data.sections;
    if (secs.length === 1 && !secs[0].items.length && (!secs[0].title || secs[0].title === SEC_TITLE[Q.division])) secs.splice(0, 1);
    names.forEach(nm => secs.push({ title: nm, items: [], images: [] }));
    markDirty(); drawSections(); m.close(); toast(names.length + ' room(s) added', 'ok');
  };
}
function addSecImage(si) {
  const f = document.createElement('input'); f.type = 'file'; f.accept = 'image/png,image/jpeg';
  f.onchange = () => guard(async () => {
    const file = f.files[0]; if (!file) return;
    const sec = Q.data.sections[si]; sec.images = sec.images || [];
    if (sec.images.length >= 3) throw new Error('Up to 3 images per section');
    let q = 0.8, data = await downscaleImage(file, 900, 700, true, q);
    while (data.length > 200000 && q > 0.3) { q -= 0.15; data = await downscaleImage(file, 900, 700, true, q); }
    if (data.length > 200000) throw new Error('Image is too large - try a smaller photo');
    sec.images.push(data); markDirty(); drawSections();
  });
  f.click();
}
function exportLines() {
  const d = Q.data, rows = [['section', 'no', 'description', 'unit', 'qty', 'rate', 'amount']];
  effSections(d).forEach((s, si) => s.items.forEach((it, ii) => rows.push([s.title, `${si + 1}.${ii + 1}`, it.desc, it.unit, it.qty, it.rate, r2(n(it.qty) * n(it.rate))])));
  const t = totals(d);
  rows.push([], ['', '', 'Subtotal', '', '', '', t.sub], ['', '', 'Discount', '', '', '', t.disc], ['', '', 'GST', '', '', '', t.tax], ['', '', 'Grand total', '', '', '', t.total]);
  download((Q.quote_no || 'quote').replace(/\//g, '-') + '.csv', rows.map(r => r.map(csvCell).join(',')).join('\n'));
}

function applyPmc() {
  const p = Q.data.pmc, fee = pmcFee();
  if (fee <= 0) { toast('Enter the values to calculate a fee first', 'err'); return; }
  let item;
  if (p.mode === 'percent') item = { desc: `Project management consultancy fee @ ${n(p.percent)}% of estimated project cost ${inr0(n(p.base_cost))}`, unit: 'lot', qty: 1, rate: fee };
  else if (p.mode === 'sqft') item = { desc: `PMC fee for ${n(p.area)} sq ft built-up area @ ₹${fmt(n(p.per_sqft))} per sq ft`, unit: 'sq ft', qty: n(p.area), rate: n(p.per_sqft) };
  else item = { desc: `PMC monthly retainer for ${n(p.months)} month(s)`, unit: 'month', qty: n(p.months), rate: n(p.monthly_fee) };
  let sec = Q.data.sections.find(s => s.title === PMC_SEC);
  if (!sec) { sec = { title: PMC_SEC, items: [] }; if (Q.data.sections.length === 1 && !Q.data.sections[0].items.length) Q.data.sections[0] = sec; else Q.data.sections.unshift(sec); }
  sec.items = sec.items.filter(i => !i.desc.startsWith('Project management consultancy fee') && !i.desc.startsWith('PMC fee for') && !i.desc.startsWith('PMC monthly retainer'));
  sec.items.unshift(item);
  markDirty(); drawSections(); toast('PMC fee added to quote', 'ok');
}

function pickRates(si, opt) {
  let div = Q.division, term = '';
  const m = openModal(`<h2>Add from rate card</h2><div class="row"><select id="pd" style="width:auto">${divOptions(div, true).replace('All divisions', 'All divisions')}</select><input id="pq" placeholder="Search items…" style="flex:1" autofocus></div>
  <div class="pick" id="pl"></div><div class="row" style="margin-top:12px"><span class="muted small">Click an item to add it (quantity 1). You can add several, then edit quantities in the quote.</span><span class="sp"></span><button class="btn pri" id="done">Done</button></div>`, true);
  $('#pd', m.el).value = div;
  const draw = () => {
    const rows = S.rates.filter(r => r.active && (!div || r.division === div) && (!term || (r.name + ' ' + r.category).toLowerCase().includes(term)));
    let last = '', html = '';
    rows.forEach(r => {
      const cat = (div ? '' : DIVS[r.division] + ' · ') + (r.category || 'General');
      if (cat !== last) { html += `<div class="cat">${esc(cat)}</div>`; last = cat; }
      html += `<div class="it" data-id="${r.id}"><span class="nm">${esc(r.name)}</span><span class="muted small">${esc(r.unit)}</span><b>${fmt(r.rate)}</b></div>`;
    });
    $('#pl', m.el).innerHTML = html || '<p class="muted" style="padding:12px">No matching items. Add items under Rate Cards.</p>';
  };
  draw();
  $('#pd', m.el).onchange = e => { div = e.target.value; draw(); };
  $('#pq', m.el).oninput = e => { term = e.target.value.toLowerCase(); draw(); };
  $('#pl', m.el).onclick = e => {
    const it = e.target.closest('.it'); if (!it) return;
    const r = S.rates.find(x => x.id == it.dataset.id);
    const row = { desc: r.name, unit: r.unit, qty: 1, rate: r.rate, cost: r.cost || '' };
    if (opt) { Q.data.options[opt.oi].sections[opt.si].items.push(row); it.classList.add('added'); markDirty(); drawOptions(); recalc(); return; }
    Q.data.sections[si].items.push(row);
    it.classList.add('added'); markDirty(); drawSections();
  };
  $('#done', m.el).onclick = m.close;
}

async function saveQuote() {
  const d = Q.data;
  if (!Q.client.name.trim()) { toast('Enter the client name before saving', 'err'); return false; }
  const body = { division: Q.division, client_id: Q.client_id || null, client: Q.client, title: Q.title, quote_date: Q.quote_date, valid_until: Q.valid_until, data: d, updated_at: Q.updated_at };
  if (!Q.id) {
    const r = await api('quotes', 'POST', body);
    window.__dirty = false; S.clients = await api('clients'); toast('Saved as ' + r.quote_no, 'ok'); location.hash = '#/quotes/' + r.id;
  } else {
    const r = await api('quotes/' + Q.id, 'PUT', body);
    window.__dirty = false; Q.client_id = r.client_id || Q.client_id; Q.updated_at = r.updated_at; S.clients = await api('clients'); toast('Saved', 'ok');
  }
  return true;
}
async function ensureSaved() { if (window.__dirty) { const ok = await saveQuote(); if (ok === false) throw new Error('Save the quote first'); } }
async function setStatus(s) { await guard(async () => { await ensureSaved(); await api(`quotes/${Q.id}/status`, 'POST', { status: s }); Q.status = s; toast('Status: ' + STATUS_LABEL[s], 'ok'); pageEditor(Q.id); }); }
async function reviseQuote() {
  if (!confirmBox('Create a new revision? The current version will be locked as superseded.')) return;
  await ensureSaved();
  const r = await api(`quotes/${Q.id}/revise`, 'POST'); toast('Revision ' + r.rev + ' created', 'ok'); location.hash = '#/quotes/' + r.id;
}
async function dupQuote() {
  await ensureSaved();
  const r = await api(`quotes/${Q.id}/duplicate`, 'POST'); toast('Duplicated as ' + r.quote_no, 'ok'); location.hash = '#/quotes/' + r.id;
}

/* ---------- printable quotation ---------- */
function gstMode(d, s, c) {
  if (d.gst_mode) return d.gst_mode;
  const a = String((s && s.company_gstin) || '').trim().slice(0, 2), b = String((c && c.gstin) || '').trim().slice(0, 2);
  return /^\d\d$/.test(a) && /^\d\d$/.test(b) ? (a === b ? 'intra' : 'inter') : '';
}
function gstRowsHtml(d, t, mode) {
  const rt = n(d.tax_rate);
  if (mode === 'inter') return `<tr><td>IGST @ ${rt}%</td><td>${fmt(t.tax)}</td></tr>`;
  if (mode === 'intra') { const h = r2(t.tax / 2); return `<tr><td>CGST @ ${rt / 2}%</td><td>${fmt(h)}</td></tr><tr><td>SGST @ ${rt / 2}%</td><td>${fmt(r2(t.tax - h))}</td></tr>`; }
  return `<tr><td>GST @ ${rt}%</td><td>${fmt(t.tax)}</td></tr>`;
}
function quoteDocHtml(s) {
  const d = Q.data, t = totals(d), c = Q.client, gm = gstMode(d, s, c);
  let body = '';
  d.sections.forEach((sec, si) => {
    if (!sec.items.length) return;
    const multi = d.sections.filter(x => x.items.length).length > 1;
    if (multi || sec.title) body += `<tr class="st"><td colspan="6">${esc(sec.title || 'Items')}</td></tr>`;
    if ((sec.images || []).length) body += `<tr><td colspan="6" style="border:0">${sec.images.map(im => `<img src="${im}" style="height:120px;margin:4px 8px 4px 0;border-radius:4px">`).join('')}</td></tr>`;
    let st = 0;
    sec.items.forEach((it, ii) => {
      const a = r2(n(it.qty) * n(it.rate)); st += a;
      body += `<tr><td>${si + 1}.${ii + 1}</td><td>${esc(it.desc).replace(/\n/g, '<br>')}</td><td>${esc(it.unit)}</td><td class="num">${esc(n(it.qty))}</td><td class="num">${fmt(n(it.rate))}</td><td class="num">${fmt(a)}</td></tr>`;
    });
    if (multi) body += `<tr class="ss"><td colspan="5" class="num">Sub-total — ${esc(sec.title)}</td><td class="num">${fmt(st)}</td></tr>`;
  });
  let optHtml = '';
  if (d.options.length) {
    const L = i => String.fromCharCode(65 + i);
    d.options.forEach((op, oi) => {
      const secs = op.sections.filter(x => x.items.length); if (!secs.length) return;
      body += `<tr class="st"><td colspan="6">Option ${L(oi)} — ${esc(op.name)}${d.selected_option === oi ? ' (selected)' : ''}${op.note ? ' · <span style="font-weight:400">' + esc(op.note) + '</span>' : ''}</td></tr>`;
      let ot = 0;
      secs.forEach(sec => sec.items.forEach((it, ii) => { const a = r2(n(it.qty) * n(it.rate)); ot += a; body += `<tr><td>${L(oi)}.${ii + 1}</td><td>${esc(it.desc).replace(/\n/g, '<br>')}</td><td>${esc(it.unit)}</td><td class="num">${esc(n(it.qty))}</td><td class="num">${fmt(n(it.rate))}</td><td class="num">${fmt(a)}</td></tr>`; }));
      body += `<tr class="ss"><td colspan="5" class="num">Sub-total — Option ${L(oi)}</td><td class="num">${fmt(ot)}</td></tr>`;
    });
    optHtml = `<h4>Choose your option</h4><table class="q"><thead><tr><th>Option</th><th>Highlights</th><th class="num">Package (₹)</th><th class="num">Quote total incl. GST (₹)</th></tr></thead><tbody>${d.options.map((op, oi) => `<tr${d.selected_option === oi ? ' class="st"' : ''}><td>${L(oi)} — ${esc(op.name)}${d.selected_option === oi ? ' ✓' : ''}</td><td>${esc(op.note)}</td><td class="num">${fmt(secSum(op.sections))}</td><td class="num">${fmt(optionTotals(d, oi).total)}</td></tr>`).join('')}</tbody></table>`;
  }
  const pay = d.payment_schedule.length ? `<h4>Payment schedule</h4><table class="q"><thead><tr><th>Stage</th><th class="num">%</th><th class="num">Amount (₹)</th></tr></thead><tbody>${d.payment_schedule.map(p => `<tr><td>${esc(p.label)}</td><td class="num">${esc(n(p.percent))}%</td><td class="num">${fmt(r2(t.total * n(p.percent) / 100))}</td></tr>`).join('')}</tbody></table>` : '';
  return `<div class="doc">
   <div class="hd"><div class="co"><img src="${s.company_logo ? esc(s.company_logo) : 'assets/logo.png'}" alt=""><div><h2>${esc(s.company_name)}</h2><div>${esc(s.company_tagline)}</div><div>${esc(s.company_address)}</div><div>${[s.company_phone && 'Phone: ' + s.company_phone, s.company_email && 'Email: ' + s.company_email, s.company_gstin && 'GSTIN: ' + s.company_gstin].filter(Boolean).map(esc).join(' · ')}</div></div></div>
   <div class="qt"><h1>QUOTATION</h1><table><tr><td>Quote no.</td><td><b>${esc(Q.quote_no)}</b></td></tr>${Q.rev ? `<tr><td>Revision</td><td>${Q.rev}</td></tr>` : ''}<tr><td>Date</td><td>${fdate(Q.quote_date)}</td></tr><tr><td>Valid until</td><td>${fdate(Q.valid_until)}</td></tr><tr><td>Division</td><td>${esc(DIVS[Q.division])}</td></tr></table></div></div>
   <div class="two"><div class="box"><h5>Quotation for</h5><div><b>${esc(c.name)}</b>${c.contact_person ? '\nAttn: ' + esc(c.contact_person) : ''}${c.address ? '\n' + esc(c.address) : ''}${c.phone ? '\nPhone: ' + esc(c.phone) : ''}${c.email ? '\nEmail: ' + esc(c.email) : ''}${c.gstin ? '\nGSTIN: ' + esc(c.gstin) : ''}</div></div>
   <div class="box"><h5>Project</h5><div><b>${esc(Q.title || '—')}</b>${d.site_address ? '\nSite: ' + esc(d.site_address) : ''}${n(d.area_sqft) ? '\nArea: ' + esc(n(d.area_sqft)) + ' sq ft' : ''}</div></div></div>
   ${d.scope ? `<h4>Scope of work</h4><pre>${esc(d.scope)}</pre>` : ''}
   <table class="q" style="margin-top:10px"><thead><tr><th style="width:36px">#</th><th>Description</th><th style="width:48px">Unit</th><th class="num" style="width:56px">Qty</th><th class="num" style="width:84px">Rate (₹)</th><th class="num" style="width:100px">Amount (₹)</th></tr></thead><tbody>${body || '<tr><td colspan="6">No items</td></tr>'}</tbody></table>
   <div class="sum"><div class="w">${esc(amountWords(t.total))}</div><table><tr><td>Subtotal</td><td>${fmt(t.sub)}</td></tr>${t.disc ? `<tr><td>Discount${d.discount.type === 'percent' ? ' (' + n(d.discount.value) + '%)' : ''}</td><td>− ${fmt(t.disc)}</td></tr><tr><td>Taxable amount</td><td>${fmt(t.taxable)}</td></tr>` : ''}${gstRowsHtml(d, t, gm)}${d.round_off && t.ro ? `<tr><td>Round off</td><td>${t.ro < 0 ? '− ' : ''}${fmt(Math.abs(t.ro))}</td></tr>` : ''}<tr class="g"><td>Grand total (₹)${d.options.length ? '<br><span style="font-weight:400;font-size:10px">Option ' + String.fromCharCode(65 + d.selected_option) + ' — ' + esc(d.options[d.selected_option].name) + '</span>' : ''}</td><td>${fmt(t.total)}</td></tr></table></div>
   ${optHtml}
   ${pay}
   ${d.terms.length ? `<h4>Terms &amp; conditions</h4><ol>${d.terms.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
   ${d.notes ? `<h4>Notes</h4><pre>${esc(d.notes)}</pre>` : ''}
   ${s.bank_details && s.bank_details.replace(/[\s\w ]*:\s*/g, '').trim() ? `<h4>Bank details</h4><pre>${esc(s.bank_details)}</pre>` : ''}
   <div class="sig"><div>Client acceptance &amp; date</div><div>For ${esc(s.company_name)}${s.signatory ? '<br><b>' + esc(s.signatory) + '</b>' : ''}<br>Authorised signatory</div></div>
   <div class="foot">${d.hsn ? 'HSN / SAC: ' + esc(d.hsn) + ' · ' : ''}${gm === 'intra' ? 'Intra-state supply (CGST + SGST)' : gm === 'inter' ? 'Inter-state supply (IGST)' : ''}${d.hsn || gm ? '<br>' : ''}This is a computer-generated quotation · ${esc(Q.quote_no)}</div></div>`;
}

async function pagePrint(id) {
  const r = await api('quotes/' + id);
  Q = r.quote; Q.revisions = r.revisions; normalizeQuote();
  $('#view').innerHTML = `<div class="toolbar noprint"><a class="btn" href="#/quotes/${Q.id}">← Back to editor</a><button class="btn pri" id="pr">Print / Save as PDF</button><span class="muted small">In the print dialog choose “Save as PDF” as the destination. Turn off “Headers and footers” for a clean page.</span></div>
  ${quoteDocHtml(S.settings)}`;
  $('#pr').onclick = () => window.print();
}
