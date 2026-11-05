'use strict';
/* Quick quote: a few inputs in, a priced draft out (optionally e-mailed to the client right away).
   Services: Roofing (size + material), Interior (BHK + finish), Construction (built-up area + finish), PMC (cost + duration). */
const QUICK_SERVICES = {
  roofing: { label: 'Roofing' }, interior: { label: 'Interior' }, construction: { label: 'Construction' }, pmc: { label: 'PMC' },
};
function quickFields(svc) {
  const tiers = (name, list, first) => `<div class="f"><span>${name} (pick several to give the client options)</span><div class="pmc-modes" data-group="variants">${list.map(([k, l], i) => `<label class="${i === first ? 'on' : ''}"><input type="checkbox" value="${k}" ${i === first ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div></div>`;
  if (svc === 'roofing') return `
    <div class="grid2"><label class="f"><span>Length (ft) *</span><input name="length_ft" type="number" min="1" step="any" required></label><label class="f"><span>Width (ft) *</span><input name="width_ft" type="number" min="1" step="any" required></label></div>
    <label class="f"><span>Roof type</span><select name="roof_type"><option value="gable">A-type (two slopes)</option><option value="shed">Mono-slope (shed)</option><option value="flat">Flat</option></select></label>
    <div class="f"><span>Material (pick up to 4 to give the client options)</span><div class="pmc-modes" data-group="materials">${Object.entries(ROOF_MATS).map(([k, v]) => `<label class="${k === 'gi' ? 'on' : ''}"><input type="checkbox" value="${k}" ${k === 'gi' ? 'checked' : ''}>${esc(v.short)}</label>`).join('')}</div></div>
    <label class="f"><span><input type="checkbox" name="include_structure" checked> Include steel frame &amp; purlins</span></label>
    <label class="f"><span><input type="checkbox" name="include_gutters" checked> Include gutters &amp; downpipes</span></label>`;
  if (svc === 'interior') return `
    <div class="grid2"><label class="f"><span>Home size (BHK) *</span><select name="bhk">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n} BHK</option>`).join('')}</select></label><label class="f"><span>Carpet area (sq ft, optional)</span><input name="carpet_sqft" type="number" min="200" step="any" placeholder="from BHK if empty"></label></div>
    ${tiers('Finish', [['standard', 'Standard'], ['premium', 'Premium']], 0)}`;
  if (svc === 'construction') return `
    <div class="grid2"><label class="f"><span>Built-up area (sq ft) *</span><input name="built_up_sqft" type="number" min="100" step="any" required></label><label class="f"><span>Floors</span><input name="floors" type="number" min="1" value="1"></label></div>
    ${tiers('Finish', [['grey', 'Grey structure'], ['standard', 'Standard finish'], ['premium', 'Premium finish']], 1)}
    <label class="f"><span><input type="checkbox" name="include_design" checked> Include architectural &amp; structural design</span></label>
    <label class="f"><span><input type="checkbox" name="include_waterproofing" checked> Include terrace waterproofing</span></label>
    <label class="f"><span><input type="checkbox" name="include_approvals" checked> Include plan approval allowance</span></label>`;
  return `
    <div class="grid2"><label class="f"><span>Project cost (₹)</span><input name="project_cost" type="number" min="100000" step="any" placeholder="or give built-up area"></label><label class="f"><span>…or built-up area (sq ft)</span><input name="built_up_sqft" type="number" min="100" step="any"></label></div>
    <label class="f"><span>Duration (months) *</span><input name="duration_months" type="number" min="1" max="60" required></label>
    ${tiers('Scope', [['full', 'Full PMC'], ['part', 'Part scope (design review / QS)']], 0)}
    <label class="f"><span><input type="checkbox" name="site_staff" checked> Include full-time site engineer &amp; QS</span></label>`;
}
function quickRoofDialog(initial) {
  let svc = initial || 'roofing';
  const clients = S.clients || [];
  const m = openModal(`<h2>Quick quote</h2><p class="small muted">A few details in, a fully priced draft out. Prices come from your rate cards.</p><form id="qrf">
  <div class="pmc-modes" id="qsvc" role="group" aria-label="Service">${Object.entries(QUICK_SERVICES).map(([k, v]) => `<label class="${k === svc ? 'on' : ''}"><input type="radio" name="svc" value="${k}" ${k === svc ? 'checked' : ''}>${esc(v.label)}</label>`).join('')}</div>
  <label class="f"><span>Client</span><select name="client_id"><option value="">— new / not decided —</option>${clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
  <label class="f"><span>…or new client name</span><input name="client_name" autocomplete="off"></label>
  <div id="qfields">${quickFields(svc)}</div>
  <label class="f"><span><input type="checkbox" name="send"> E-mail it to the client right away (needs a client with an e-mail)</span></label>
  <div class="row end"><button type="button" class="btn" id="qrx">Cancel</button><button class="btn pri">Create quote</button></div></form>`);
  const wireGroups = () => $$('.pmc-modes[data-group] input', m.el).forEach(i => { i.onchange = () => i.parentElement.classList.toggle('on', i.checked); });
  wireGroups();
  $('#qrx', m.el).onclick = m.close;
  $$('#qsvc input', m.el).forEach(r => {
    r.onchange = () => { svc = r.value; $$('#qsvc label', m.el).forEach(l => l.classList.toggle('on', l.firstElementChild.checked)); $('#qfields', m.el).innerHTML = quickFields(svc); wireGroups(); };
  });
  $('#qrf', m.el).onsubmit = e => {
    e.preventDefault();
    const f = e.target, body = { send: f.send.checked };
    const group = name => $$(`.pmc-modes[data-group=${name}] input:checked`, m.el).map(i => i.value);
    const num = k => (f.elements[k] && f.elements[k].value !== '' ? +f.elements[k].value : undefined);
    const chk = k => (f.elements[k] ? f.elements[k].checked : undefined);
    if (f.client_id.value) body.client_id = +f.client_id.value; else if (f.client_name.value.trim()) body.client = { name: f.client_name.value.trim() };
    if (svc === 'roofing') {
      const mats = group('materials'); if (!mats.length) return toast('Pick at least one material', 'err');
      Object.assign(body, { length_ft: num('length_ft'), width_ft: num('width_ft'), roof_type: f.roof_type.value, materials: mats.slice(0, 4), include_structure: chk('include_structure'), include_gutters: chk('include_gutters') });
    } else {
      const v = group('variants'); if (!v.length) return toast('Pick at least one option', 'err');
      body.variants = v;
      if (svc === 'interior') Object.assign(body, { bhk: num('bhk'), carpet_sqft: num('carpet_sqft') });
      if (svc === 'construction') Object.assign(body, { built_up_sqft: num('built_up_sqft'), floors: num('floors'), include_design: chk('include_design'), include_waterproofing: chk('include_waterproofing'), include_approvals: chk('include_approvals') });
      if (svc === 'pmc') Object.assign(body, { project_cost: num('project_cost'), built_up_sqft: num('built_up_sqft'), duration_months: num('duration_months'), site_staff: chk('site_staff') });
    }
    guard(async () => {
      const r = await api(svc === 'roofing' ? 'quotes/quick-roofing' : 'quotes/quick/' + svc, 'POST', body);
      m.close();
      toast(r.sent ? 'Quote created and e-mailed' : (r.send_note ? 'Quote created. ' + r.send_note : 'Quote created'), 'ok');
      location.hash = '#/quotes/' + r.quote_id;
    });
  };
}
