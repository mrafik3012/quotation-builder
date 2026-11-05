'use strict';
/* Projects: billing milestones, receipts, variation orders, site log and tax invoices */

const PSTATE = { pending: 'Not billed', invoiced: 'Invoiced', part: 'Part paid', paid: 'Paid', credited: 'Credited' };
const pchip = s => `<span class="chip ${s === 'paid' ? 'accepted' : s === 'invoiced' || s === 'part' ? 'sent' : s === 'credited' ? 'superseded' : 'draft'}">${esc(PSTATE[s] || s)}</span>`;
const PSTATUS = { active: 'Active', on_hold: 'On hold', completed: 'Completed' };

async function pageProjects() {
  const r = await api('projects'), s = r.summary;
  $('#view').innerHTML = `<div class="page-head"><h1>Projects</h1><span class="muted small">Accepted quotes become projects - open a quote and click “Convert to project”.</span></div>
  <div class="tiles">
   <div class="tile"><div class="l">Active projects</div><div class="v">${s.active}</div><div class="s">${s.projects} in total</div></div>
   <div class="tile"><div class="l">Contract value</div><div class="v">${inr0(s.contract)}</div><div class="s">incl. approved variations</div></div>
   <div class="tile"><div class="l">Received</div><div class="v">${inr0(s.received)}</div><div class="s">collected so far</div></div>
   <div class="tile"><div class="l">Outstanding</div><div class="v ${s.overdue ? 'bad' : ''}">${inr0(s.outstanding)}</div><div class="s">${s.overdue ? s.overdue + ' overdue milestone(s)' : 'nothing overdue'}</div></div>
  </div>
  <div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Project</th><th>Client</th><th>Division</th><th class="r">Contract (₹)</th><th class="r">Received (₹)</th><th class="r">Outstanding (₹)</th><th>Status</th></tr></thead><tbody>
  ${r.projects.map(p => `<tr class="click" data-go="${p.id}"><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.quote_no)}</div></td><td>${esc(p.client_name || '')}</td><td>${divChip(p.division)}</td><td class="r nw">${fmt(p.contract)}</td><td class="r nw">${fmt(p.received)}</td><td class="r nw ${p.overdue ? 'bad' : ''}">${fmt(p.contract - p.received)}${p.overdue ? ' ⚠' : ''}</td><td>${esc(PSTATUS[p.status] || p.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No projects yet.</td></tr>'}
  </tbody></table></div></div>`;
  $('#view').onclick = e => { const t = e.target.closest('[data-go]'); if (t) location.hash = '#/projects/' + t.dataset.go; };
}

async function pageProject(id) {
  const r = await api('projects/' + id), p = r.project, T = r.totals, today_ = today();
  const lastProg = (r.log.find(l => l.progress !== null) || {}).progress, admin = S.user.role === 'admin';
  const v = $('#view');
  v.innerHTML = `<div class="page-head"><h1>${esc(p.name)}</h1><span>${divChip(p.division)} <button class="btn sm" data-act="portal" type="button">Client portal</button></span></div>
  <div class="row" style="margin-bottom:14px"><a class="btn" href="#/projects">← Projects</a>${r.quote ? `<a class="btn" href="#/quotes/${r.quote.id}">Quotation ${esc(r.quote.quote_no)}</a>` : ''}<span class="sp"></span>${S.user.role === 'admin' ? '<button class="btn dng" data-act="delproj">Delete project</button>' : ''}</div>
  <div class="tiles">
   <div class="tile"><div class="l">Contract value</div><div class="v">${inr0(T.contract)}</div><div class="s">${T.variations ? 'incl. ' + inr0(T.variations) + ' variations' : 'incl. GST'}${T.credits ? ' · − ' + inr0(T.credits) + ' credit notes' : ''}</div></div>
   <div class="tile"><div class="l">Billed (milestones)</div><div class="v">${inr0(T.billed)}</div><div class="s">${T.contract ? Math.round(T.billed * 100 / T.contract) : 0}% of contract</div></div>
   <div class="tile"><div class="l">Received</div><div class="v good">${inr0(T.received)}</div><div class="s">${T.contract ? Math.round(T.received * 100 / T.contract) : 0}% collected</div></div>
   <div class="tile"><div class="l">Outstanding</div><div class="v">${inr0(T.outstanding)}</div><div class="s">${lastProg != null ? 'Site progress ' + lastProg + '%' : 'no progress logged'}</div></div>
  </div>
  <div class="card"><h2>Project details</h2><div class="grid3">
   <label class="f"><span>Name</span><input id="pn" value="${esc(p.name)}"></label>
   <label class="f"><span>Status</span><select id="ps">${Object.entries(PSTATUS).map(([k, l]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><span></span>
   <label class="f"><span>Start date</span><input id="pd1" type="date" value="${esc(p.start_date || '')}"></label><label class="f"><span>Target completion</span><input id="pd2" type="date" value="${esc(p.end_date || '')}"></label>
   <label class="f"><span>Client</span><input readonly value="${esc((r.quote && r.quote.client && r.quote.client.name) || '')}"></label>
   <label class="f"><span>AMC / warranty ends on</span><input id="pamc" type="date" value="${esc(p.amc_end || '')}"></label><label class="f"><span>AMC / warranty note</span><input id="pamcn" maxlength="255" value="${esc(p.amc_note || '')}" placeholder="e.g. 10-yr sheet warranty, annual AMC"></label></div>
   <label class="f"><span>Notes</span><textarea id="pnote" rows="2">${esc(p.notes || '')}</textarea></label><button class="btn pri" data-act="saveproj">Save details</button></div>
  <div class="card"><h2>Billing milestones</h2><div class="scroll"><table class="tbl"><thead><tr><th>Stage</th><th>Due</th><th class="r">Amount (₹)</th><th class="r">Paid (₹)</th><th>Status</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
  ${r.milestones.map(m => `<tr><td><b>${esc(m.label)}</b>${m.percent ? ` <span class="muted small">${m.percent}%</span>` : ''}${m.invoice_no ? `<div class="muted small">Invoice ${esc(m.invoice_no)}</div>` : ''}</td><td class="nw ${m.overdue ? 'bad' : ''}">${m.due_date ? esc(fdate(m.due_date)) : '—'}${m.overdue ? ' (overdue)' : ''}</td><td class="r nw">${fmt(m.amount)}${m.credited ? `<div class="small bad">− ${fmt(m.credited)} credit</div>` : ''}</td><td class="r nw">${fmt(m.paid)}</td><td>${pchip(m.state)}</td>
   <td class="r nw"><button class="btn sm" data-act="inv" data-id="${m.id}">${m.invoice_no ? 'View invoice' : 'Create invoice'}</button> ${m.state !== 'paid' && m.state !== 'credited' ? `<button class="btn sm pri" data-act="pay" data-id="${m.id}">Record payment</button>` : ''} <button class="btn sm" data-act="editm" data-id="${m.id}">Edit</button>${m.invoice_no ? ` <button class="btn sm" data-act="einv" data-id="${m.id}" title="Paste the IRN / acknowledgement from the e-invoice portal">${m.irn ? 'e-Invoice ✓' : 'e-Invoice'}</button>` : ''}${admin && m.invoice_no ? ` <button class="btn sm" data-act="credit" data-id="${m.id}">Credit note</button> <button class="btn sm dng" data-act="cancelinv" data-id="${m.id}">Cancel invoice</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No milestones. Add one below.</td></tr>'}
  </tbody></table></div><div class="row" style="margin-top:10px"><button class="btn sm" data-act="addm">+ Add milestone</button></div></div>
  <div class="grid2"><div class="card"><h2>Payments received</h2>${r.receipts.length ? `<table class="tbl"><tbody>${r.receipts.map(x => { const m = r.milestones.find(y => y.id === x.milestone_id); return `<tr><td class="nw">${esc(fdate(x.received_on))}</td><td>${m ? esc(m.label) : '<span class="muted">General</span>'}<div class="muted small">${esc([x.mode, x.reference, x.note].filter(Boolean).join(' · '))}</div></td><td class="r nw"><b>${fmt(x.amount)}</b>${x.receipt_no ? `<div class="small"><a href="#/projects/${id}/receipt/${x.id}">${esc(x.receipt_no)}</a></div>` : ''}</td><td class="r">${admin ? `<button class="btn sm dng" data-act="delrc" data-id="${x.id}" aria-label="Delete payment">✕</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted small" style="margin:0">No payments recorded yet.</p>'}</div>
  <div class="card"><h2>Variation orders (extras on site)</h2>${r.variations.map(x => `<div class="row" style="margin-bottom:8px"><div style="flex:1;min-width:150px"><b>${esc(x.title)}</b><div class="muted small">${esc(x.note || '')} ${inr0(x.amount)} + GST</div></div><select data-vs="${x.id}" aria-label="Variation status" style="width:auto">${['proposed', 'approved', 'rejected'].map(k => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select>${x.status === 'proposed' && +x.amount > 0 ? `<button class="btn sm" data-act="reqvar" data-id="${x.id}">${x.approval_token ? 'Resend for approval' : 'Send for client approval'}</button>` : ''}<button class="btn sm dng" data-act="delvar" data-id="${x.id}" aria-label="Delete variation">✕</button>${x.decided_by ? `<div class="muted small" style="flex-basis:100%">${x.status === 'approved' ? '✓ Approved' : 'Declined'} online by ${esc(x.decided_by)} on ${esc((x.decided_at || '').slice(0, 10))}${x.client_note ? ' - “' + esc(x.client_note) + '”' : ''}</div>` : (x.approval_token && x.status === 'proposed' ? '<div class="muted small" style="flex-basis:100%">Sent to the client - waiting for approval</div>' : '')}</div>`).join('') || '<p class="muted small" style="margin:0 0 8px">None yet. Approved variations are added to the contract and billed as a new milestone.</p>'}
   <form id="vf" class="row" style="margin-top:8px"><input name="title" aria-label="What changed" placeholder="What changed?" required style="flex:2;min-width:140px"><input name="amount" aria-label="Amount excluding GST" type="number" step="any" min="0" placeholder="Amount ex-GST" required style="flex:1;min-width:110px"><button class="btn">Add</button></form></div></div>
  ${r.credit_notes.length || r.invoice_history.length ? `<div class="card"><h2>Credit notes &amp; cancelled invoices</h2><table class="tbl"><tbody>${r.credit_notes.map(x => `<tr><td class="nw">${esc(fdate(x.credit_date))}</td><td><a href="#/projects/${id}/credit/${x.id}"><b>${esc(x.credit_no)}</b></a><div class="muted small">${esc(x.reason || '')}</div></td><td class="r nw bad">− ${fmt(x.amount)}</td></tr>`).join('')}${r.invoice_history.map(x => `<tr><td class="nw">${esc(fdate(x.invoice_date))}</td><td><b>${esc(x.invoice_no)}</b> <span class="chip rejected">cancelled</span><div class="muted small">${esc(x.reason || '')}</div></td><td class="r nw">${fmt(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <div class="card"><h2>Site log</h2><form id="lf2" class="row" style="margin-bottom:12px"><input name="log_date" aria-label="Date" type="date" value="${today_}" style="width:auto"><input name="progress" aria-label="Progress percent" type="number" min="0" max="100" placeholder="Progress %" style="width:110px"><input name="text" aria-label="Site update" placeholder="Today's update, issue, material received…" required style="flex:1;min-width:200px"><label class="btn" title="Attach up to 3 site photos"><input type="file" id="lph" accept="image/png,image/jpeg" multiple hidden>📷 Photos</label><span id="lphn" class="muted small"></span><button class="btn pri">Add update</button></form>
  ${r.log.map(l => `<div class="row small" style="margin-bottom:6px;align-items:flex-start"><span class="muted nw">${esc(fdate(l.log_date))}</span><span style="flex:1">${esc(l.text)} ${l.progress != null ? `<b>(${l.progress}%)</b>` : ''}<span class="muted"> — ${esc(l.author || '')}</span>${(l.photos || []).length ? `<div class="phrow">${l.photos.map(ph => `<img class="lth" src="${ph}" alt="Site photo" tabindex="0">`).join('')}</div>` : ''}</span><button class="btn sm dng" data-act="dellog" data-id="${l.id}" aria-label="Delete update">✕</button></div>`).join('') || '<p class="muted small" style="margin:0">No updates yet.</p>'}</div>`;
  const reload = () => pageProject(id), call = (path, method, body, msg) => guard(async () => { await api(`projects/${id}/${path}`, method, body); if (msg) toast(msg, 'ok'); reload(); });
  $('#vf').onsubmit = e => { e.preventDefault(); call('variations', 'POST', Object.fromEntries(new FormData(e.target)), 'Variation added'); };
  let photos = [];
  $('#lph').onchange = e => guard(async () => { photos = []; for (const f of Array.from(e.target.files).slice(0, 3)) { let q = 0.8, d = await downscaleImage(f, 1000, 800, true, q); while (d.length > 200000 && q > 0.3) { q -= 0.15; d = await downscaleImage(f, 1000, 800, true, q); } if (d.length > 200000) throw new Error('A photo is too large - try a smaller one'); photos.push(d); } $('#lphn').textContent = photos.length + ' photo(s) attached'; });
  $('#lf2').onsubmit = e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); delete b.undefined; b.photos = photos; call('log', 'POST', b, 'Update added'); };
  v.addEventListener('click', e => { const im = e.target.closest('.lth'); if (im) { const m = openModal(`<img src="${im.src}" alt="Site photo" style="width:100%;border-radius:8px"><div class="row end" style="margin-top:10px"><button class="btn" id="phx" type="button">Close</button></div>`, true); $('#phx', m.el).onclick = m.close; } });
  v.onchange = e => { const t = e.target; if (t.dataset.vs) { const x = r.variations.find(y => y.id == t.dataset.vs); call('variations/' + x.id, 'PUT', { title: x.title, note: x.note, amount: x.amount, status: t.value }, 'Variation ' + t.value); } };
  v.onclick = e => {
    const t = e.target.closest('[data-act]'); if (!t) return; const a = t.dataset.act, mid = +t.dataset.id;
    if (a === 'saveproj') guard(async () => { await api('projects/' + id, 'PUT', { name: $('#pn').value, status: $('#ps').value, start_date: $('#pd1').value, end_date: $('#pd2').value, notes: $('#pnote').value, amc_end: $('#pamc').value, amc_note: $('#pamcn').value }); toast('Saved', 'ok'); reload(); });
    else if (a === 'delproj') { if (confirmBox('Delete this project with all its milestones, payments and log? The quotation is kept.')) guard(async () => { await api('projects/' + id, 'DELETE'); location.hash = '#/projects'; }); }
    else if (a === 'addm') milestoneModal(id, null, reload);
    else if (a === 'editm') milestoneModal(id, r.milestones.find(m => m.id === mid), reload);
    else if (a === 'pay') payModal(id, r.milestones.find(m => m.id === mid), reload);
    else if (a === 'credit') creditModal(id, r.milestones.find(m => m.id === mid), reload);
    else if (a === 'cancelinv') { const m = r.milestones.find(x => x.id === mid), why = window.prompt(`Cancel invoice ${m.invoice_no}? The number stays on record and is never reused.\nReason:`); if (why) guard(async () => { const x = await api(`projects/${id}/milestones/${mid}/cancel-invoice`, 'POST', { reason: why }); toast('Invoice cancelled' + (x.note ? ' - ' + x.note : ''), 'ok'); reload(); }); }
    else if (a === 'einv') einvModal(id, r.milestones.find(m => m.id === mid), reload);
    else if (a === 'inv') guard(async () => { await api(`projects/${id}/milestones/${mid}/invoice`, 'POST'); location.hash = `#/projects/${id}/invoice/${mid}`; });
    else if (a === 'delrc') { if (confirmBox('Delete this payment record?')) call('receipts/' + mid, 'DELETE', undefined, 'Deleted'); }
    else if (a === 'portal') guard(portalDialog);
    else if (a === 'reqvar') guard(async () => {
      const res = await api(`projects/${id}/variations/${mid}/request-approval`, 'POST', {});
      const m = openModal(`<h2>Change order sent</h2><p>${res.emailed ? 'The client has been e-mailed the approval link.' : esc(res.note || '')}</p><label class="f"><span>Approval link (you can also WhatsApp it)</span><input id="vlink" readonly value="${esc(res.link)}"></label><div class="row end"><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('Please review and approve this change order: ' + res.link)}">WhatsApp</a><button class="btn pri" id="vok" type="button">Done</button></div>`);
      $('#vok', m.el).onclick = () => { m.close(); reload(); }; $('#vlink', m.el).onfocus = ev => ev.target.select();
    });
    else if (a === 'delvar') { if (confirmBox('Delete this variation?')) call('variations/' + mid, 'DELETE', undefined, 'Deleted'); }
    else if (a === 'dellog') call('log/' + mid, 'DELETE');
  };
}

function milestoneModal(pid, m, done) {
  const mo = openModal(`<h2>${m ? 'Edit' : 'Add'} milestone</h2><form id="mf"><label class="f"><span>Stage name</span><input name="label" required value="${esc(m ? m.label : '')}"></label>
  <div class="grid2"><label class="f"><span>Amount incl. GST (₹)</span><input name="amount" type="number" step="0.01" min="0" required value="${m ? m.amount : ''}"></label><label class="f"><span>Due date</span><input name="due_date" type="date" value="${esc(m && m.due_date ? m.due_date : '')}"></label></div>
  <div class="row end">${m ? '<button type="button" class="btn dng" id="md">Delete</button>' : ''}<span class="sp"></span><button type="button" class="btn" id="mx">Cancel</button><button class="btn pri">Save</button></div></form>`);
  $('#mx', mo.el).onclick = mo.close;
  if (m) $('#md', mo.el).onclick = () => guard(async () => { await api(`projects/${pid}/milestones/${m.id}`, 'DELETE'); mo.close(); done(); });
  $('#mf', mo.el).onsubmit = e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); guard(async () => { await api(`projects/${pid}/milestones${m ? '/' + m.id : ''}`, m ? 'PUT' : 'POST', b); mo.close(); done(); }); };
}
function payModal(pid, m, done) {
  const due = r2(m.amount - m.paid);
  const mo = openModal(`<h2>Record payment</h2><p class="muted small" style="margin-top:0">${esc(m.label)} · balance ${inr(due)}</p><form id="rf3">
  <div class="grid2"><label class="f"><span>Amount received (₹)</span><input name="amount" type="number" step="0.01" min="0.01" required value="${due}"></label><label class="f"><span>Date</span><input name="received_on" type="date" value="${today()}"></label>
  <label class="f"><span>Mode</span><select name="mode"><option>Bank transfer</option><option>UPI</option><option>Cheque</option><option>Cash</option></select></label><label class="f"><span>Reference / UTR</span><input name="reference"></label></div>
  <div class="row end"><button type="button" class="btn" id="rx">Cancel</button><button class="btn pri">Save payment</button></div></form>`);
  $('#rx', mo.el).onclick = mo.close;
  $('#rf3', mo.el).onsubmit = e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.milestone_id = m.id; guard(async () => { await api(`projects/${pid}/receipts`, 'POST', b); toast('Payment recorded', 'ok'); mo.close(); done(); }); };
}

/* ---------- tax invoice (printable) ---------- */
async function pageInvoice(pid, mid) {
  const r = await api('projects/' + pid), m = r.milestones.find(x => x.id === mid);
  if (!m || !m.invoice_no) { location.hash = '#/projects/' + pid; return; }
  const s = S.settings, p = r.project, c = (r.quote && r.quote.client) || {}, rate = n(p.tax_rate);
  const taxable = r2(m.amount / (1 + rate / 100)), tax = r2(m.amount - taxable);
  const mode = gstMode({ gst_mode: r.quote && r.quote.gst_mode }, s, c);
  const gstRows = mode === 'inter' ? `<tr><td>IGST @ ${rate}%</td><td>${fmt(tax)}</td></tr>` : mode === 'intra' ? `<tr><td>CGST @ ${rate / 2}%</td><td>${fmt(r2(tax / 2))}</td></tr><tr><td>SGST @ ${rate / 2}%</td><td>${fmt(r2(tax - r2(tax / 2)))}</td></tr>` : `<tr><td>GST @ ${rate}%</td><td>${fmt(tax)}</td></tr>`;
  const bal = r2(m.amount - m.credited - m.paid);
  $('#view').innerHTML = `<div class="toolbar noprint"><a class="btn" href="#/projects/${pid}">← Back to project</a><button class="btn pri" id="pr">Print / Save as PDF</button></div>
  <div class="doc"><div class="hd"><div class="co"><img src="${s.company_logo ? esc(s.company_logo) : 'assets/logo.png'}" alt=""><div><h2>${esc(s.company_name)}</h2><div>${esc(s.company_address)}</div><div>${[s.company_phone && 'Phone: ' + s.company_phone, s.company_email && 'Email: ' + s.company_email, s.company_gstin && 'GSTIN: ' + s.company_gstin].filter(Boolean).map(esc).join(' · ')}</div></div></div>
  <div class="qt"><h1>TAX INVOICE</h1><table><tr><td>Invoice no.</td><td><b>${esc(m.invoice_no)}</b></td></tr><tr><td>Date</td><td>${esc(fdate(m.invoice_date))}</td></tr>${m.due_date ? `<tr><td>Due date</td><td>${esc(fdate(m.due_date))}</td></tr>` : ''}<tr><td>Quotation ref.</td><td>${esc(p.quote_no)}</td></tr></table></div></div>
  <div class="two"><div class="box"><h2 class="bx">Bill to</h2><div><b>${esc(c.name || '')}</b>${c.address ? '\n' + esc(c.address) : ''}${c.phone ? '\nPhone: ' + esc(c.phone) : ''}${c.gstin ? '\nGSTIN: ' + esc(c.gstin) : ''}</div></div><div class="box"><h2 class="bx">Project</h2><div><b>${esc(p.name)}</b></div></div></div>
  <table class="q"><thead><tr><th style="width:36px">#</th><th>Description</th><th class="num" style="width:110px">HSN / SAC</th><th class="num" style="width:120px">Taxable value (₹)</th></tr></thead><tbody><tr><td>1</td><td>${esc(m.label)} — ${esc(p.name)}<div class="muted small">Against quotation ${esc(p.quote_no)}</div></td><td class="num">${esc(r.quote && r.quote.hsn || s['hsn_' + p.division] || '')}</td><td class="num">${fmt(taxable)}</td></tr></tbody></table>
  <div class="sum"><div class="w">${esc(amountWords(m.amount))}</div><table><tr><td>Taxable value</td><td>${fmt(taxable)}</td></tr>${gstRows}<tr class="g"><td>Invoice total (₹)</td><td>${fmt(m.amount)}</td></tr>${m.credited ? `<tr><td>Less: credit notes</td><td>− ${fmt(m.credited)}</td></tr>` : ''}${m.paid ? `<tr><td>Received</td><td>− ${fmt(m.paid)}</td></tr>` : ''}${m.paid || m.credited ? `<tr><td><b>Balance due</b></td><td><b>${fmt(bal)}</b></td></tr>` : ''}</table></div>
  ${m.irn ? `<div class="box" style="margin-bottom:10px;font-size:11px"><h2 class="bx">e-Invoice</h2><div style="word-break:break-all">IRN: ${esc(m.irn)}\nAck no.: ${esc(m.ack_no || '')}${m.ack_date ? ' · Ack date: ' + esc(fdate(m.ack_date)) : ''}</div></div>` : ''}
  ${s.bank_details && s.bank_details.replace(/[\s\w ]*:\s*/g, '').trim() ? `<h2>Bank details for payment</h2><pre>${esc(s.bank_details)}</pre>` : ''}
  <div class="sig"><div>Received by (client)</div><div>For ${esc(s.company_name)}${s.signatory ? '<br><b>' + esc(s.signatory) + '</b>' : ''}<br>Authorised signatory</div></div>
  <div class="foot">${mode === 'intra' ? 'Intra-state supply (CGST + SGST) · ' : mode === 'inter' ? 'Inter-state supply (IGST) · ' : ''}This is a computer-generated invoice · ${esc(m.invoice_no)}</div></div>`;
  $('#pr').onclick = () => window.print();
}

function creditModal(pid, m, done) {
  const left = r2(m.amount - m.credited);
  const mo = openModal(`<h2>Credit note against ${esc(m.invoice_no)}</h2><p class="muted small" style="margin-top:0">Reduces what the client owes (e.g. discount, returned material, work not done). Amounts include GST. Invoice value still open to credit: <b>${inr(left)}</b>.</p><form id="cf">
  <div class="grid2"><label class="f"><span>Credit amount incl. GST (₹)</span><input name="amount" type="number" step="0.01" min="0.01" max="${left}" required></label><label class="f"><span>Date</span><input name="date" type="date" value="${today()}"></label></div>
  <label class="f"><span>Reason *</span><input name="reason" required maxlength="255" placeholder="e.g. 200 sq ft sheeting not executed"></label>
  <div class="row end"><button type="button" class="btn" id="cx">Cancel</button><button class="btn pri">Issue credit note</button></div></form>`);
  $('#cx', mo.el).onclick = mo.close;
  $('#cf', mo.el).onsubmit = e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); guard(async () => { const r = await api(`projects/${pid}/milestones/${m.id}/credit-note`, 'POST', b); toast('Credit note issued', 'ok'); mo.close(); location.hash = `#/projects/${pid}/credit/${r.id}`; }); };
}
function einvModal(pid, m, done) {
  const mo = openModal(`<h2>e-Invoice details for ${esc(m.invoice_no)}</h2><p class="muted small" style="margin-top:0">If your turnover requires e-invoicing, generate the IRN on the government e-invoice portal (or your GST software) and paste the details here so they print on the invoice. This app does not connect to the portal.</p><form id="ef">
  <label class="f"><span>IRN (64 characters)</span><input name="irn" value="${esc(m.irn || '')}" maxlength="80" style="font-family:monospace"></label>
  <div class="grid2"><label class="f"><span>Acknowledgement no.</span><input name="ack_no" value="${esc(m.ack_no || '')}"></label><label class="f"><span>Acknowledgement date</span><input name="ack_date" type="date" value="${esc(m.ack_date || '')}"></label></div>
  <div class="row end"><button type="button" class="btn" id="ex">Cancel</button><button class="btn pri">Save</button></div></form>`);
  $('#ex', mo.el).onclick = mo.close;
  $('#ef', mo.el).onsubmit = e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); guard(async () => { await api(`projects/${pid}/milestones/${m.id}/einvoice`, 'POST', b); toast('Saved', 'ok'); mo.close(); done(); }); };
}

/* ---------- payment receipt & credit note (printable) ---------- */
function docHeader(s, title, rows) {
  return `<div class="hd"><div class="co"><img src="${s.company_logo ? esc(s.company_logo) : 'assets/logo.png'}" alt=""><div><h2>${esc(s.company_name)}</h2><div>${esc(s.company_address)}</div><div>${[s.company_phone && 'Phone: ' + s.company_phone, s.company_email && 'Email: ' + s.company_email, s.company_gstin && 'GSTIN: ' + s.company_gstin].filter(Boolean).map(esc).join(' · ')}</div></div></div>
  <div class="qt"><h1>${esc(title)}</h1><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table></div></div>`;
}
async function pageReceipt(pid, rid) {
  const r = await api('projects/' + pid), x = r.receipts.find(y => y.id === rid);
  if (!x) { location.hash = '#/projects/' + pid; return; }
  const s = S.settings, p = r.project, c = (r.quote && r.quote.client) || {}, m = r.milestones.find(y => y.id === x.milestone_id);
  const paidAfter = m ? r2(r.receipts.filter(y => y.milestone_id === m.id && (y.received_on < x.received_on || (y.received_on === x.received_on && y.id <= x.id))).reduce((t, y) => t + y.amount, 0)) : 0;
  $('#view').innerHTML = `<div class="toolbar noprint"><a class="btn" href="#/projects/${pid}">← Back to project</a><button class="btn pri" id="pr">Print / Save as PDF</button></div>
  <div class="doc">${docHeader(s, 'PAYMENT RECEIPT', [['Receipt no.', `<b>${esc(x.receipt_no || '#' + x.id)}</b>`], ['Date', esc(fdate(x.received_on))], ['Project', esc(p.quote_no)]])}
  <div class="two"><div class="box"><h2 class="bx">Received from</h2><div><b>${esc(c.name || '')}</b>${c.address ? '\n' + esc(c.address) : ''}${c.gstin ? '\nGSTIN: ' + esc(c.gstin) : ''}</div></div><div class="box"><h2 class="bx">Towards</h2><div><b>${esc(p.name)}</b>${m ? '\n' + esc(m.label) : ''}${m && m.invoice_no ? '\nInvoice ' + esc(m.invoice_no) : ''}</div></div></div>
  <table class="q"><thead><tr><th>Payment details</th><th class="num" style="width:150px">Amount (₹)</th></tr></thead><tbody><tr><td>Received by ${esc(x.mode || 'payment')}${x.reference ? ' · Ref: ' + esc(x.reference) : ''}${x.note ? '<br>' + esc(x.note) : ''}</td><td class="num"><b>${fmt(x.amount)}</b></td></tr></tbody></table>
  <div class="sum"><div class="w">${esc(amountWords(x.amount))}</div><table>${m ? `<tr><td>Invoice / stage value</td><td>${fmt(m.net)}</td></tr><tr><td>Received to date</td><td>${fmt(paidAfter)}</td></tr><tr class="g"><td>Balance</td><td>${fmt(r2(Math.max(m.net - paidAfter, 0)))}</td></tr>` : ''}</table></div>
  <div class="sig"><div>Received with thanks</div><div>For ${esc(s.company_name)}${s.signatory ? '<br><b>' + esc(s.signatory) + '</b>' : ''}<br>Authorised signatory</div></div>
  <div class="foot">This is a computer-generated receipt · ${esc(x.receipt_no || '')}</div></div>`;
  $('#pr').onclick = () => window.print();
}
async function pageCredit(pid, cid) {
  const r = await api('projects/' + pid), x = r.credit_notes.find(y => y.id === cid);
  if (!x) { location.hash = '#/projects/' + pid; return; }
  const s = S.settings, p = r.project, c = (r.quote && r.quote.client) || {}, m = r.milestones.find(y => y.id === x.milestone_id), rate = n(p.tax_rate);
  const taxable = r2(x.amount / (1 + rate / 100)), tax = r2(x.amount - taxable), mode = gstMode({ gst_mode: r.quote && r.quote.gst_mode }, s, c);
  const rows = mode === 'inter' ? `<tr><td>IGST @ ${rate}%</td><td>${fmt(tax)}</td></tr>` : mode === 'intra' ? `<tr><td>CGST @ ${rate / 2}%</td><td>${fmt(r2(tax / 2))}</td></tr><tr><td>SGST @ ${rate / 2}%</td><td>${fmt(r2(tax - r2(tax / 2)))}</td></tr>` : `<tr><td>GST @ ${rate}%</td><td>${fmt(tax)}</td></tr>`;
  const orig = m && m.invoice_no ? m.invoice_no : (r.invoice_history.find(h => h.milestone_id === x.milestone_id) || {}).invoice_no || '';
  $('#view').innerHTML = `<div class="toolbar noprint"><a class="btn" href="#/projects/${pid}">← Back to project</a><button class="btn pri" id="pr">Print / Save as PDF</button></div>
  <div class="doc">${docHeader(s, 'CREDIT NOTE', [['Credit note no.', `<b>${esc(x.credit_no)}</b>`], ['Date', esc(fdate(x.credit_date))], ['Against invoice', esc(orig)], ['Quotation ref.', esc(p.quote_no)]])}
  <div class="two"><div class="box"><h2 class="bx">Issued to</h2><div><b>${esc(c.name || '')}</b>${c.address ? '\n' + esc(c.address) : ''}${c.gstin ? '\nGSTIN: ' + esc(c.gstin) : ''}</div></div><div class="box"><h2 class="bx">Project</h2><div><b>${esc(p.name)}</b>${m ? '\n' + esc(m.label) : ''}</div></div></div>
  <table class="q"><thead><tr><th>Description</th><th class="num" style="width:110px">HSN / SAC</th><th class="num" style="width:130px">Taxable value (₹)</th></tr></thead><tbody><tr><td>Credit against invoice ${esc(orig)} — ${esc(x.reason || '')}</td><td class="num">${esc(r.quote && r.quote.hsn || '')}</td><td class="num">${fmt(taxable)}</td></tr></tbody></table>
  <div class="sum"><div class="w">${esc(amountWords(x.amount))}</div><table><tr><td>Taxable value</td><td>${fmt(taxable)}</td></tr>${rows}<tr class="g"><td>Credit total (₹)</td><td>${fmt(x.amount)}</td></tr></table></div>
  <div class="sig"><div>Client acknowledgement</div><div>For ${esc(s.company_name)}${s.signatory ? '<br><b>' + esc(s.signatory) + '</b>' : ''}<br>Authorised signatory</div></div>
  <div class="foot">${mode === 'intra' ? 'Intra-state supply (CGST + SGST) · ' : mode === 'inter' ? 'Inter-state supply (IGST) · ' : ''}This is a computer-generated credit note · ${esc(x.credit_no)}</div></div>`;
  $('#pr').onclick = () => window.print();
}


/* ---------- client portal (private progress link) ---------- */
async function portalDialog() {
  const id = +location.hash.split('/')[2];
  const res = await api(`projects/${id}/portal`, 'POST', {});
  const m = openModal(`<h2>Client portal</h2><p class="small muted">A private page where the client follows progress: site updates with photos, payment schedule and amounts received. Costs and margins are never shown.</p>
   <label class="f"><span>Private link</span><input id="plink" readonly value="${esc(res.link)}"></label>
   <label class="f"><span>E-mail it to (defaults to the client)</span><input id="pto" type="email" placeholder="client@example.com"></label>
   <div class="row"><button class="btn pri" id="pmail" type="button">E-mail link</button><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('Follow your project progress here: ' + res.link)}">WhatsApp</a><a class="btn" target="_blank" rel="noopener" href="${esc(res.link)}">Preview</a></div>
   <div class="row" style="margin-top:10px"><button class="btn sm" id="prot" type="button">Make a new link</button><button class="btn sm dng" id="prev" type="button">Turn portal off</button><span class="sp"></span><button class="btn" id="pcl" type="button">Close</button></div>
   <p class="small muted" style="margin-top:8px">A new link or turning it off stops the old link working immediately.</p>`);
  $('#plink', m.el).onfocus = e => e.target.select();
  $('#pcl', m.el).onclick = m.close;
  $('#pmail', m.el).onclick = () => guard(async () => { const r = await api(`projects/${id}/portal/email`, 'POST', { to: $('#pto', m.el).value.trim() }); toast('Portal link e-mailed to ' + r.to, 'ok'); });
  $('#prot', m.el).onclick = () => { if (confirmBox('Create a new link? The old link will stop working.')) guard(async () => { const r = await api(`projects/${id}/portal`, 'POST', { rotate: true }); $('#plink', m.el).value = r.link; toast('New link created', 'ok'); }); };
  $('#prev', m.el).onclick = () => { if (confirmBox('Turn the portal off? The current link will stop working.')) guard(async () => { await api(`projects/${id}/portal`, 'DELETE'); m.close(); toast('Portal turned off', 'ok'); }); };
}
