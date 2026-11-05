'use strict';
/* Quick roofing quote: size + material in, priced draft out (optionally e-mailed to the client right away). */
function quickRoofDialog() {
  const clients = S.clients || [];
  const mats = Object.entries(ROOF_MATS);
  const m = openModal(`<h2>Quick roofing quote</h2><p class="small muted">Enter the size and material. The app works out the roof, prices every line from your rate card and saves a draft.</p><form id="qrf">
  <label class="f"><span>Client</span><select name="client_id"><option value="">— new / not decided —</option>${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
  <label class="f"><span>…or new client name</span><input name="client_name" autocomplete="off"></label>
  <div class="grid2"><label class="f"><span>Length (ft) *</span><input name="length_ft" type="number" min="1" step="any" required></label><label class="f"><span>Width (ft) *</span><input name="width_ft" type="number" min="1" step="any" required></label></div>
  <label class="f"><span>Roof type</span><select name="roof_type"><option value="gable">A-type (two slopes)</option><option value="shed">Mono-slope (shed)</option><option value="flat">Flat</option></select></label>
  <div class="f"><span>Material (pick up to 4 to give the client options)</span><div class="pmc-modes" id="qrm">${mats.map(([k, v]) => `<label class="${k === 'gi' ? 'on' : ''}"><input type="checkbox" value="${k}" ${k === 'gi' ? 'checked' : ''}>${esc(v.short)}</label>`).join('')}</div></div>
  <label class="f"><span><input type="checkbox" name="structure" checked> Include steel frame &amp; purlins</span></label>
  <label class="f"><span><input type="checkbox" name="gutters" checked> Include gutters &amp; downpipes</span></label>
  <label class="f"><span><input type="checkbox" name="send"> E-mail it to the client right away (needs a client with an e-mail)</span></label>
  <div class="row end"><button type="button" class="btn" id="qrx">Cancel</button><button class="btn pri">Create quote</button></div></form>`);
  $('#qrx', m.el).onclick = m.close;
  $$('#qrm input', m.el).forEach(i => { i.onchange = () => i.parentElement.classList.toggle('on', i.checked); });
  $('#qrf', m.el).onsubmit = e => {
    e.preventDefault();
    const f = e.target, picked = $$('#qrm input:checked', m.el).map(i => i.value);
    if (!picked.length) return toast('Pick at least one material', 'err');
    const body = { length_ft: +f.length_ft.value, width_ft: +f.width_ft.value, roof_type: f.roof_type.value, materials: picked.slice(0, 4), include_structure: f.structure.checked, include_gutters: f.gutters.checked, send: f.send.checked };
    if (f.client_id.value) body.client_id = +f.client_id.value; else if (f.client_name.value.trim()) body.client = { name: f.client_name.value.trim() };
    guard(async () => {
      const r = await api('quotes/quick-roofing', 'POST', body);
      m.close();
      toast(r.sent ? 'Quote created and e-mailed' : (r.send_note ? 'Quote created. ' + r.send_note : 'Quote created'), 'ok');
      location.hash = '#/quotes/' + r.quote_id;
    });
  };
}
