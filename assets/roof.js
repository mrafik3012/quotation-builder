'use strict';
/* Roofing calculator: roof geometry -> quantities -> priced packages for GI / UPVC / PUF / Aluminium etc. */

const ROOF_MATS = {
  gi:     { label: 'GI colour coated (PPGI) 0.40 mm', short: 'GI', match: 'GI colour coated sheet 0.40', def: 88, cover: 3.28 },
  gi55:   { label: 'GI colour coated (PPGI) 0.55 mm', short: 'GI 0.55', match: 'GI colour coated sheet 0.55', def: 118, cover: 3.28 },
  galv:   { label: 'Galvalume 0.45 mm', short: 'Galvalume', match: 'Galvalume (Zn-Al) sheet 0.45', def: 100, cover: 3.28 },
  upvc:   { label: 'UPVC trapezoidal 2.5 mm', short: 'UPVC', match: 'UPVC trapezoidal roofing sheet 2.5', def: 140, cover: 3.5 },
  upvcasa:{ label: 'UPVC ASA tile-profile 3 mm', short: 'UPVC ASA', match: 'UPVC tile-profile (ASA', def: 175, cover: 3.5 },
  puf30:  { label: 'PUF sandwich panel 30 mm', short: 'PUF 30', match: 'PUF sandwich panel 30 mm', def: 215, cover: 3.28 },
  puf50:  { label: 'PUF sandwich panel 50 mm', short: 'PUF 50', match: 'PUF sandwich panel 50 mm', def: 270, cover: 3.28 },
  puf75:  { label: 'PUF sandwich panel 75 mm', short: 'PUF 75', match: 'PUF sandwich panel 75 mm', def: 335, cover: 3.28 },
  alu:    { label: 'Aluminium roofing 0.60 mm coated', short: 'Aluminium', match: 'Aluminium roofing sheet 0.60', def: 195, cover: 3.28 },
  poly:   { label: 'Polycarbonate multiwall 6 mm', short: 'Polycarbonate', match: 'Polycarbonate multiwall sheet 6', def: 150, cover: 3.28 },
};
const ROOF_PARTS = {
  purlin: { name: 'GI / MS purlins (Z / C) - supply & fixing', match: 'GI / MS purlins (Z / C)', def: 88, unit: 'kg' },
  frame:  { name: 'MS structural truss / rafter - fabrication & erection', match: 'MS structural truss / rafter', def: 92, unit: 'kg' },
  ridge:  { name: 'Ridge cap flashing (PPGI)', match: 'Ridge cap flashing (PPGI)', def: 185, unit: 'rft' },
  barge:  { name: 'Barge / gable flashing', match: 'Barge / gable flashing', def: 160, unit: 'rft' },
  gutter: { name: 'Box gutter - GI 0.8 mm, fabricated', match: 'Box gutter - GI 0.8', def: 380, unit: 'rft' },
  pipe:   { name: 'Downpipe - GI / MS 100 mm', match: 'Downpipe - GI / MS 100', def: 220, unit: 'rft' },
  screw:  { name: 'Self-drilling roofing screws (bi-metal) with EPDM washer', match: 'Self-drilling roofing screws', def: 4, unit: 'nos' },
  turbo:  { name: 'Turbo ventilator 24 inch (aluminium, with base)', match: 'Turbo ventilator 24 inch', def: 4500, unit: 'nos' },
  sky:    { name: 'FRP roofing sheet 1.5 mm (translucent)', match: 'FRP roofing sheet 1.5', def: 85, unit: 'sq ft' },
};
const ROOF_DEFAULT = {
  type: 'gable', len: '', wid: '', slope: 10, eave: 1, gable: 0.5, height: 12, waste: 7,
  pspace: 4, purlinkg: 1.5, framekg: 2.5, screws: 0.7, turbo: 1000, sky: 0, gutter: 'yes',
  mats: ['gi', 'upvc', 'puf50', 'alu'], custom: {},
};

function roofRate(key, kind) {
  const src = kind === 'mat' ? ROOF_MATS[key] : ROOF_PARTS[key];
  const c = (Q.data.roofcalc && Q.data.roofcalc.custom) || {};
  if (c[key] != null && c[key] !== '') return n(c[key]);
  const it = (S.rates || []).find(r => r.active && r.division === 'roofing' && r.name.toLowerCase().includes(src.match.toLowerCase()));
  return it ? it.rate : src.def;
}

/* geometry + quantities (pure function, easy to test) */
function roofGeometry(p) {
  const L = n(p.len), W = n(p.wid), th = Math.min(Math.max(n(p.slope), 0), 45) * Math.PI / 180;
  if (L <= 0 || W <= 0) return null;
  const cos = Math.cos(th) || 1;
  const eave = Math.max(n(p.eave), 0), gab = Math.max(n(p.gable), 0);
  const roofLen = L + 2 * gab;
  let slopeLen, slopes, area, ridge = 0, barge = 0, gutterRft = 0;
  if (p.type === 'gable') {
    slopes = 2; slopeLen = (W / 2 + eave) / cos; area = slopes * slopeLen * roofLen;
    ridge = roofLen; barge = 4 * slopeLen; gutterRft = 2 * roofLen;
  } else if (p.type === 'shed') {
    slopes = 1; slopeLen = (W + 2 * eave) / cos; area = slopeLen * roofLen;
    barge = 2 * slopeLen; gutterRft = roofLen; ridge = roofLen; // high-side flashing
  } else {
    slopes = 1; slopeLen = W + 2 * eave; area = slopeLen * roofLen; barge = 0; gutterRft = roofLen; ridge = 0;
  }
  const plan = L * W, waste = Math.max(n(p.waste), 0) / 100;
  const billed = area * (1 + waste);
  const rows = Math.ceil(slopeLen / Math.max(n(p.pspace) || 4, 1)) + 1;
  const purlinRft = rows * roofLen * slopes;
  const pipes = p.gutter === 'yes' ? Math.max(Math.ceil(gutterRft / 30), 1) : 0;
  return {
    plan, area, billed, slopeLen, slopes, roofLen, ridge, barge,
    gutterRft: p.gutter === 'yes' ? gutterRft : 0, pipes, pipeRft: pipes * Math.max(n(p.height), 0),
    purlinKg: purlinRft * n(p.purlinkg), purlinRft,
    frameKg: plan * n(p.framekg), screws: Math.ceil(billed * n(p.screws)),
    turbo: n(p.turbo) > 0 ? Math.max(Math.round(plan / n(p.turbo)), 0) : 0,
    skyArea: area * Math.max(n(p.sky), 0) / 100,
  };
}

/* the priced line items for one material package */
function roofCost(key, kind) {
  const src = kind === 'mat' ? ROOF_MATS[key] : ROOF_PARTS[key];
  const it = (S.rates || []).find(r => r.active && r.division === 'roofing' && r.name.toLowerCase().includes(src.match.toLowerCase()));
  const rate = roofRate(key, kind);
  return it && it.cost && n((Q.data.roofcalc.custom || {})[key]) === 0 ? it.cost : r2(rate * 0.8);
}
function roofItems(g, p, key) {
  const m = ROOF_MATS[key];
  const sheetArea = Math.max(g.billed - g.skyArea * (1 + n(p.waste) / 100), 0);
  const items = [];
  const add = (desc, unit, qty, rate, ck, kind = 'part') => { if (qty > 0) items.push({ desc, unit, qty: r2(qty), rate: r2(rate), cost: ck ? roofCost(ck, kind) : 0 }); };
  const dims = `${r2(n(p.len))} x ${r2(n(p.wid))} ft ${p.type === 'gable' ? 'gable' : p.type === 'shed' ? 'mono-slope' : 'flat'} roof, slope ${n(p.slope)}°`;
  add(`Roof sheet - ${m.label}, supply & fixing\n(${dims}; roof area ${Math.round(g.area).toLocaleString('en-IN')} sq ft + ${n(p.waste)}% wastage/laps)`, 'sq ft', sheetArea, roofRate(key, 'mat'), key, 'mat');
  if (g.skyArea > 0) add('Translucent FRP skylight sheet - supply & fixing', 'sq ft', g.skyArea * (1 + n(p.waste) / 100), roofRate('sky', 'part'), 'sky');
  add('MS structural frame / truss / rafter - fabrication & erection', 'kg', g.frameKg, roofRate('frame', 'part'), 'frame');
  add('GI / MS purlins (Z / C) - supply & fixing', 'kg', g.purlinKg, roofRate('purlin', 'part'), 'purlin');
  add('Ridge cap flashing', 'rft', g.ridge, roofRate('ridge', 'part'), 'ridge');
  add('Barge / gable flashing', 'rft', g.barge, roofRate('barge', 'part'), 'barge');
  add('Roof gutter with end caps & outlets', 'rft', g.gutterRft, roofRate('gutter', 'part'), 'gutter');
  add('Downpipe 100 mm with clamps', 'rft', g.pipeRft, roofRate('pipe', 'part'), 'pipe');
  add('Self-drilling roofing screws with EPDM washers', 'nos', g.screws, roofRate('screw', 'part'), 'screw');
  add('Turbo ventilator 24 inch with base', 'nos', g.turbo, roofRate('turbo', 'part'), 'turbo');
  return items;
}
const roofSum = items => r2(items.reduce((s, i) => s + r2(i.qty * i.rate), 0));

function openRoofCalc() {
  const rc = Q.data.roofcalc = Object.assign({}, ROOF_DEFAULT, Q.data.roofcalc || {});
  rc.custom = rc.custom || {}; rc.mats = Array.isArray(rc.mats) && rc.mats.length ? rc.mats : ROOF_DEFAULT.mats;
  const num = (k, l, step = 'any') => `<label class="f"><span>${l}</span><input type="number" step="${step}" min="0" data-k="${k}" value="${esc(rc[k])}"></label>`;
  const m = openModal(`<h2>Roofing calculator &amp; material comparison</h2>
  <div class="grid3">
   <label class="f"><span>Roof type</span><select data-k="type"><option value="gable" ${rc.type === 'gable' ? 'selected' : ''}>Gable (2 slopes)</option><option value="shed" ${rc.type === 'shed' ? 'selected' : ''}>Mono-slope / shed</option><option value="flat" ${rc.type === 'flat' ? 'selected' : ''}>Flat / near flat</option></select></label>
   ${num('len', 'Building length (ft)')}${num('wid', 'Building width / span (ft)')}
   ${num('slope', 'Roof slope (degrees)')}${num('eave', 'Eave overhang (ft)')}${num('gable', 'Gable overhang (ft)')}
   ${num('height', 'Eave height for downpipes (ft)')}${num('waste', 'Wastage + laps (%)')}${num('sky', 'Skylight area (% of roof)')}
  </div>
  <details style="margin:4px 0 10px"><summary class="small" style="cursor:pointer">Advanced assumptions</summary><div class="grid3" style="margin-top:8px">
   ${num('pspace', 'Purlin spacing (ft)')}${num('purlinkg', 'Purlin weight (kg per ft)')}${num('framekg', 'Frame steel (kg per sq ft plan)')}
   ${num('screws', 'Screws per sq ft of roof')}${num('turbo', 'One turbo ventilator per (sq ft plan, 0 = none)')}
   <label class="f"><span>Gutter &amp; downpipes</span><select data-k="gutter"><option value="yes" ${rc.gutter === 'yes' ? 'selected' : ''}>Include</option><option value="no" ${rc.gutter === 'no' ? 'selected' : ''}>Exclude</option></select></label></div></details>
  <div class="small" style="font-weight:700;margin-bottom:4px">Compare materials</div>
  <div class="pmc-modes" id="rmats">${Object.entries(ROOF_MATS).map(([k, v]) => `<label class="${rc.mats.includes(k) ? 'on' : ''}"><input type="checkbox" value="${k}" ${rc.mats.includes(k) ? 'checked' : ''}>${esc(v.short)}</label>`).join('')}</div>
  <div id="rout"></div>
  <div class="row" style="margin-top:12px"><span class="muted small">Rates come from your Rate Card (editable below each column). Quantities are estimates - verify on site.</span><span class="sp"></span><button class="btn" id="rclose">Close</button></div>`, true);
  const out = $('#rout', m.el);
  const draw = () => {
    const g = roofGeometry(rc);
    if (!g) { out.innerHTML = '<p class="muted">Enter the building length and width to see quantities and prices.</p>'; return; }
    const keys = rc.mats.filter(k => ROOF_MATS[k]);
    const sets = keys.map(k => ({ k, items: roofItems(g, rc, k) })).map(s => ({ ...s, total: roofSum(s.items) }));
    const best = sets.length ? Math.min(...sets.map(s => s.total)) : 0;
    const gstR = n(Q.data.tax_rate);
    out.innerHTML = `<div class="card" style="margin:0 0 12px"><div class="grid3 small">
      <div><span class="muted">Plan area</span><br><b>${Math.round(g.plan).toLocaleString('en-IN')} sq ft</b></div>
      <div><span class="muted">Roof (sloped) area</span><br><b>${Math.round(g.area).toLocaleString('en-IN')} sq ft</b> · with wastage <b>${Math.round(g.billed).toLocaleString('en-IN')}</b></div>
      <div><span class="muted">Slope length</span><br><b>${r2(g.slopeLen)} ft</b> × ${g.slopes} slope(s)</div>
      <div><span class="muted">Ridge / barge</span><br><b>${Math.round(g.ridge)} / ${Math.round(g.barge)} rft</b></div>
      <div><span class="muted">Gutter / downpipe</span><br><b>${Math.round(g.gutterRft)} / ${Math.round(g.pipeRft)} rft</b></div>
      <div><span class="muted">Steel (frame + purlin)</span><br><b>${Math.round(g.frameKg + g.purlinKg).toLocaleString('en-IN')} kg</b></div></div></div>
    ${sets.length ? `<div class="scroll"><table class="tbl"><thead><tr><th><span class="sr">Item</span></th>${sets.map(s => `<th class="r">${esc(ROOF_MATS[s.k].short)}${s.total === best && sets.length > 1 ? ' ★' : ''}</th>`).join('')}</tr></thead><tbody>
     <tr><td>Sheet rate / sq ft (₹)</td>${sets.map(s => `<td class="r"><input aria-label="Sheet rate per sq ft for ${esc(ROOF_MATS[s.k].short)}" style="width:84px;text-align:right" type="number" step="any" min="0" data-rate="${s.k}" value="${roofRate(s.k, 'mat')}"></td>`).join('')}</tr>
     <tr><td>Roof sheets</td>${sets.map(s => `<td class="r">${fmt(roofSum(s.items.slice(0, 1)))}</td>`).join('')}</tr>
     <tr><td>Structure, flashings, gutter, fasteners &amp; ventilation</td>${sets.map(s => `<td class="r">${fmt(s.total - roofSum(s.items.slice(0, 1)))}</td>`).join('')}</tr>
     <tr><td><b>Total before GST</b></td>${sets.map(s => `<td class="r"><b>${fmt(s.total)}</b></td>`).join('')}</tr>
     <tr><td>Per sq ft of plan area</td>${sets.map(s => `<td class="r">${fmt(g.plan ? s.total / g.plan : 0)}</td>`).join('')}</tr>
     <tr><td>Incl. GST @ ${gstR}%</td>${sets.map(s => `<td class="r">${fmt(r2(s.total * (1 + gstR / 100)))}</td>`).join('')}</tr>
     <tr><td></td>${sets.map(s => `<td class="r nw"><button class="btn sm pri" data-use="${s.k}">Use in quote</button><br><button class="btn sm" style="margin-top:4px" data-opt="${s.k}">Add as option</button></td>`).join('')}</tr></tbody></table></div>
     <p class="muted small" style="margin:8px 0 0">“Use in quote” adds a new section with these lines. “Add as option” lists it as an alternative package the client can choose (Good / Better / Best).</p>` : '<p class="muted">Pick at least one material to compare.</p>'}`;
  };
  m.el.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.k) { rc[t.dataset.k] = t.value; draw(); markDirty(); }

  });
  m.el.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.rate) { rc.custom[t.dataset.rate] = t.value; markDirty(); draw(); }
    else if (t.closest('#rmats')) {
      rc.mats = $$('#rmats input:checked', m.el).map(x => x.value);
      $$('#rmats label', m.el).forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
      markDirty(); draw();
    } else if (t.tagName === 'SELECT' && t.dataset.k) { rc[t.dataset.k] = t.value; markDirty(); draw(); }
  });
  m.el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const g = roofGeometry(rc); if (!g) return;
    if (b.dataset.use) {
      const key = b.dataset.use;
      const sec = { title: `Roofing - ${ROOF_MATS[key].label}`, items: roofItems(g, rc, key) };
      if (Q.data.sections.length === 1 && !Q.data.sections[0].items.length) Q.data.sections[0] = sec; else Q.data.sections.push(sec);
      if (!n(Q.data.area_sqft)) Q.data.area_sqft = Math.round(g.plan);
      markDirty(); drawEditor(); m.close(); toast('Roofing section added', 'ok');
    } else if (b.dataset.opt && typeof addQuoteOption === 'function') {
      const key = b.dataset.opt;
      addQuoteOption(ROOF_MATS[key].label, [{ title: `Roofing - ${ROOF_MATS[key].label}`, items: roofItems(g, rc, key) }]);
      if (!n(Q.data.area_sqft)) Q.data.area_sqft = Math.round(g.plan);
      markDirty(); drawEditor(); toast('Added as option', 'ok');
    } else if (b.id === 'rclose') { m.close(); }
  });
  draw();
}
