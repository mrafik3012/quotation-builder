'use strict';
/* Public client page: review a change order (extra work) and approve or decline it online. */
const VTOK = new URLSearchParams(location.search).get('t') || '';

async function vpub(act, body) {
  const opt = { method: body ? 'POST' : 'GET', headers: { 'X-Requested-With': 'infraura' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(`api/public.php?r=${act}&t=${encodeURIComponent(VTOK)}`, opt);
  let data = null; try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
  return data;
}

function drawVariation(r) {
  const v = r.variation, s = r.settings, open = v.status === 'proposed';
  document.title = `Change order - ${r.project.name}`;
  const banner = v.status === 'approved' ? `<div class="banner" style="margin:0 0 14px"><b>✓ Approved</b>${v.decided_by ? ` by ${esc(v.decided_by)} on ${esc((v.decided_at || '').slice(0, 10))}` : ''}. Thank you - this has been added to your project.</div>`
    : v.status === 'rejected' ? `<div class="banner" style="margin:0 0 14px">This change order was declined. Please contact us if that was a mistake.</div>` : '';
  $('#app').innerHTML = `<div style="max-width:640px;margin:0 auto;padding:18px 16px">
   <div class="row"><h1 style="margin:0;font-size:22px">${esc(s.company_name || 'Change order')}</h1></div>
   <p class="muted small">${esc(s.company_address || '')}${s.company_gstin ? ' · GSTIN ' + esc(s.company_gstin) : ''}</p>
   ${banner}
   <div class="card"><h2 style="margin-top:0">Change order</h2>
    <p class="muted small" style="margin:0 0 8px">Project: <b>${esc(r.project.name)}</b> · Quotation ${esc(r.project.quote_no)}</p>
    <h3 style="margin:8px 0">${esc(v.title)}</h3>${v.note ? `<p>${esc(v.note)}</p>` : ''}
    <table class="t"><tbody>
     <tr><td>Additional work (ex-GST)</td><td class="r">${inr(v.amount)}</td></tr>
     <tr><td>GST @ ${n(v.gst_rate)}%</td><td class="r">${inr(v.gst)}</td></tr>
     <tr><td><b>Additional cost</b></td><td class="r"><b>${inr(v.total)}</b></td></tr>
     <tr><td class="muted">Contract value before</td><td class="r muted">${inr(r.contract_before)}</td></tr>
     <tr><td class="muted">Contract value ${open ? 'after approval' : 'now'}</td><td class="r muted">${inr(r.contract_after)}</td></tr>
    </tbody></table></div>
   ${open ? `<div class="card" id="vacc"><h2 style="margin-top:0">Your response</h2>
    <label class="f"><span>Your full name *</span><input id="vn" autocomplete="name"></label>
    <label class="f"><span>Comments (optional)</span><input id="vc" maxlength="500"></label>
    <div class="row"><button class="btn pri" id="vyes" type="button">Approve change order</button><button class="btn dng" id="vno" type="button">Decline</button></div>
    <p class="muted small">By approving you agree to the additional cost above. Your name, the time and your IP address are recorded as evidence.</p></div>` : ''}
  </div>`;
  if (open) {
    const send = action => async () => {
      const name = $('#vn').value.trim();
      if (action === 'accept' && !name) return toast('Please type your full name', 'err');
      if (action === 'decline' && !window.confirm('Decline this change order?')) return;
      try { await vpub('variation-respond', { action, name, note: $('#vc').value, expected_total: v.total }); drawVariation(await vpub('variation')); toast(action === 'accept' ? 'Thank you - approved' : 'Declined', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#vyes').onclick = send('accept'); $('#vno').onclick = send('decline');
  }
}

(async () => {
  try { drawVariation(await vpub('variation')); }
  catch (e) { $('#app').innerHTML = `<div class="login"><img class="logo" src="assets/logo.png" alt=""><h1>Change order unavailable</h1><p class="muted">${esc(e.message)}</p></div>`; }
})();
