'use strict';
/* Public client page: view quotation, choose an option, accept with e-signature or decline */

const TOK = new URLSearchParams(location.search).get('t') || '';
const PUB = { resp: null, expired: false, signed: false };

async function pub(act, body) {
  const opt = { method: body ? 'POST' : 'GET', headers: { 'X-Requested-With': 'infraura' } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(`api/public.php?r=${act}&t=${encodeURIComponent(TOK)}`, opt);
  let data = null; try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
  return data;
}

async function boot() {
  try {
    const r = await pub('quote');
    Q = r.quote; normalizeQuote(); S.settings = r.settings; PUB.resp = r.response; PUB.expired = r.expired;
    document.title = `Quotation ${Q.quote_no} - ${r.settings.company_name || ''}`;
    draw();
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><img class="logo" src="assets/logo.png" alt=""><h1>Quotation unavailable</h1><p class="muted">${esc(e.message)}</p></div>`;
  }
}

function draw() {
  const d = Q.data, s = S.settings, open = Q.status === 'sent' || Q.status === 'draft';
  const canAct = open && !PUB.expired;
  let top = '';
  if (Q.status === 'accepted') top = `<div class="banner" style="margin:0 0 14px"><b>✓ Accepted</b>${PUB.resp ? ` by ${esc(PUB.resp.name)} on ${esc((PUB.resp.at || '').slice(0, 10))}` : ''}. Thank you - our team will be in touch shortly.</div>`;
  else if (Q.status === 'rejected') top = `<div class="banner" style="margin:0 0 14px">This quotation was declined. If that was a mistake, please contact us.</div>`;
  else if (PUB.expired) top = `<div class="banner" style="margin:0 0 14px">This quotation expired on ${esc(fdate(Q.valid_until))}. Please contact us for a refreshed quote.</div>`;
  const opts = d.options.length && canAct ? `<div class="card noprint"><h3>Choose your option</h3><div class="optpick">${d.options.map((o, i) => `<label class="optcard ${d.selected_option === i ? 'on' : ''}"><input type="radio" name="opt" value="${i}" ${d.selected_option === i ? 'checked' : ''}><b>${esc(o.name)}</b><span class="muted small">${esc(o.note)}</span><span class="optp">${inr0(optionTotals(d, i).total)}<small> incl. GST</small></span></label>`).join('')}</div></div>` : '';
  const act = canAct ? `<div class="card noprint" id="acc"><h3>Accept this quotation</h3>
   <div class="grid2"><label class="f"><span>Your full name *</span><input id="an" value="${esc(Q.client.contact_person || '')}" autocomplete="name"></label><label class="f"><span>Comments (optional)</span><input id="ac" maxlength="400"></label></div>
   <div class="f"><span>Sign here (optional)</span><canvas id="sig" class="sigpad" width="640" height="180"></canvas><div class="row"><button type="button" class="btn sm" id="sigc">Clear</button><span class="muted small">Draw with your finger or mouse</span></div></div>
   <p class="muted small">By clicking Accept you confirm this quotation (${d.options.length ? 'with the option selected above, ' : ''}total <b>${inr(totals(d).total)}</b>) and its terms &amp; conditions.</p>
   <div class="row"><button class="btn pri" id="aok">Accept quotation</button><button class="btn dng" id="ano">Decline</button></div></div>` : '';
  $('#app').innerHTML = `<div class="pubwrap">${top}${opts}<div class="toolbar noprint"><button class="btn" id="pp">Print / Save as PDF</button><span class="sp"></span><span class="muted small">${esc(s.company_phone || '')} ${esc(s.company_email || '')}</span></div>${quoteDocHtml(s)}${act}</div>`;
  $('#pp').onclick = () => window.print();
  $$('input[name=opt]').forEach(r => r.onchange = () => { d.selected_option = +r.value; draw(); });
  if (canAct) wireAct();
}

function wireAct() {
  const cv = $('#sig'), cx = cv.getContext('2d'); let down = false; PUB.signed = false;
  cx.lineWidth = 2.5; cx.lineCap = 'round'; cx.strokeStyle = '#111';
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  cv.style.touchAction = 'none';
  cv.onpointerdown = e => { down = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); cx.beginPath(); cx.moveTo(x, y); };
  cv.onpointermove = e => { if (!down) return; const [x, y] = pos(e); cx.lineTo(x, y); cx.stroke(); PUB.signed = true; };
  cv.onpointerup = () => { down = false; };
  $('#sigc').onclick = () => { cx.clearRect(0, 0, cv.width, cv.height); PUB.signed = false; };
  const send = async (action) => {
    const name = $('#an').value.trim();
    if (action === 'accept' && !name) { toast('Please type your full name', 'err'); return; }
    if (action === 'reject' && !confirmBox('Decline this quotation?')) return;
    try {
      await pub('respond', { action, name, note: $('#ac').value, option: Q.data.selected_option, signature: PUB.signed && action === 'accept' ? cv.toDataURL('image/png') : '' });
      toast(action === 'accept' ? 'Quotation accepted - thank you!' : 'Response sent', 'ok'); boot(); window.scrollTo(0, 0);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#aok').onclick = () => send('accept');
  $('#ano').onclick = () => send('reject');
}
boot();
