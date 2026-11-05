'use strict';
/* Public client portal: follow a project - progress, site updates with photos, payment schedule, amounts received. Read-only. */
const PTOK = new URLSearchParams(location.search).get('t') || '';

async function ppub(act, extra) {
  const res = await fetch(`api/public.php?r=${act}&t=${encodeURIComponent(PTOK)}${extra || ''}`, { headers: { 'X-Requested-With': 'infraura' } });
  let data = null; try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
  return data;
}

const STATE_LABEL = { paid: 'Paid', part: 'Part paid', invoiced: 'Invoiced', pending: 'Upcoming', credited: 'Credited' };

function drawPortal(r) {
  const p = r.project, s = r.settings, t = r.totals;
  document.title = `${p.name} - ${s.company_name || ''}`;
  const pct = p.progress != null ? Math.max(0, Math.min(100, p.progress)) : null;
  const paidPct = t.contract > 0 ? Math.max(0, Math.min(100, Math.round(t.received * 100 / t.contract))) : 0;
  const ms = r.milestones.map(m => `<tr><td>${esc(m.label)}${m.invoice_no ? `<div class="muted small">Invoice ${esc(m.invoice_no)}</div>` : ''}</td><td class="nw">${m.due_date ? esc(fdate(m.due_date)) : '—'}</td><td class="r nw">${inr(m.amount)}</td><td class="nw">${m.overdue ? '<span class="chip rejected">Overdue</span>' : `<span class="chip ${m.state === 'paid' ? 'accepted' : 'draft'}">${STATE_LABEL[m.state] || esc(m.state)}</span>`}</td></tr>`).join('');
  const rc = r.receipts.map(x => `<tr><td class="nw">${esc(fdate(x.date))}</td><td>${esc(x.receipt_no || '')}</td><td>${esc(x.mode || '')}</td><td class="r nw">${inr(x.amount)}</td></tr>`).join('');
  const vr = r.variations.map(v => `<div class="row" style="margin-bottom:6px"><div style="flex:1;min-width:160px"><b>${esc(v.title)}</b>${v.note ? `<div class="muted small">${esc(v.note)}</div>` : ''}</div><span>${inr(v.total)}</span>${v.status === 'proposed' && v.approve_link ? `<a class="btn sm pri" href="${esc(v.approve_link)}">Review &amp; approve</a>` : `<span class="chip ${v.status === 'approved' ? 'accepted' : v.status === 'rejected' ? 'rejected' : 'draft'}">${esc(v.status[0].toUpperCase() + v.status.slice(1))}</span>`}</div>`).join('');
  const ups = r.updates.map(u => `<div class="card" style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>${esc(fdate(u.date))}</b>${u.progress != null ? `<span class="chip accepted">${u.progress}% complete</span>` : ''}</div><p style="margin:6px 0">${esc(u.text)}</p>${u.photos ? `<div class="row" style="gap:8px;flex-wrap:wrap">${Array.from({ length: u.photos }, (_, i) => `<a href="api/public.php?r=portal-photo&t=${encodeURIComponent(PTOK)}&l=${u.id}&i=${i}" target="_blank" rel="noopener"><img class="lth" loading="lazy" alt="Site photo ${i + 1}, ${esc(fdate(u.date))}" src="api/public.php?r=portal-photo&t=${encodeURIComponent(PTOK)}&l=${u.id}&i=${i}" style="width:120px;height:90px;object-fit:cover;border-radius:8px"></a>`).join('')}</div>` : ''}</div>`).join('');
  $('#app').innerHTML = `<div style="max-width:760px;margin:0 auto;padding:18px 16px">
   <h1 style="margin:0;font-size:22px">${esc(s.company_name || 'Project portal')}</h1>
   <p class="muted small">${esc(s.company_address || '')}${s.company_phone ? ' · ' + esc(s.company_phone) : ''}${s.company_email ? ' · ' + esc(s.company_email) : ''}</p>
   <div class="card"><h2 style="margin-top:0">${esc(p.name)}</h2>
    <p class="muted small" style="margin:0 0 10px">${p.client ? esc(p.client) + ' · ' : ''}Quotation ${esc(p.quote_no)} · ${esc(p.status === 'completed' ? 'Completed' : p.status === 'on_hold' ? 'On hold' : 'In progress')}${p.start_date ? ' · started ' + esc(fdate(p.start_date)) : ''}${p.end_date ? ' · target ' + esc(fdate(p.end_date)) : ''}</p>
    ${pct != null ? `<div class="small">Work progress: <b>${pct}%</b></div><div class="bar" role="progressbar" aria-label="Work progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>` : '<p class="muted small">Progress updates will appear here.</p>'}
    <div class="tiles" style="margin-top:14px"><div class="tile"><div class="l">Contract value</div><div class="v">${inr0(t.contract)}</div><div class="s">incl. GST</div></div>
     <div class="tile"><div class="l">Paid so far</div><div class="v">${inr0(t.received)}</div><div class="s">${paidPct}% of contract</div></div>
     <div class="tile"><div class="l">Balance</div><div class="v">${inr0(t.outstanding)}</div><div class="s">remaining</div></div></div>
    ${p.amc_end ? `<p class="small muted">Warranty / AMC valid until <b>${esc(fdate(p.amc_end))}</b>.</p>` : ''}
    ${r.quote_link ? `<p class="small"><a href="${esc(r.quote_link)}">View your quotation</a></p>` : ''}</div>
   ${vr ? `<div class="card"><h2 style="margin-top:0">Change orders</h2>${vr}</div>` : ''}
   <div class="card"><h2 style="margin-top:0">Payment schedule</h2><div class="scroll" tabindex="0" role="region" aria-label="Payment schedule"><table class="t"><thead><tr><th>Stage</th><th>Due</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${ms || '<tr><td colspan="4" class="muted">No stages yet.</td></tr>'}</tbody></table></div></div>
   ${rc ? `<div class="card"><h2 style="margin-top:0">Payments received</h2><div class="scroll" tabindex="0" role="region" aria-label="Payments received"><table class="t"><thead><tr><th>Date</th><th>Receipt</th><th>Mode</th><th class="r">Amount</th></tr></thead><tbody>${rc}</tbody></table></div></div>` : ''}
   <h2>Site updates</h2>${ups || '<p class="muted">No updates yet - we will post progress and photos here.</p>'}
   <p class="muted small" style="text-align:center;margin-top:24px">Questions? ${s.company_phone ? 'Call ' + esc(s.company_phone) : 'Contact us'}${s.company_email ? ' or write to ' + esc(s.company_email) : ''}. This page is private to you - please do not share the link.</p>
  </div>`;
}

(async () => {
  try { drawPortal(await ppub('portal')); }
  catch (e) { $('#app').innerHTML = `<div class="login"><img class="logo" src="assets/logo.png" alt=""><h1>Project portal unavailable</h1><p class="muted">${esc(e.message)}</p></div>`; }
})();
