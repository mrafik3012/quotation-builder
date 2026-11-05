'use strict';
/* Alternative packages (Good / Better / Best): common sections + one selected option */

function effSections(d) {
  const o = Array.isArray(d.options) ? d.options : [];
  if (!o.length) return d.sections;
  return d.sections.concat((o[d.selected_option] || o[0]).sections || []);
}
const secSum = secs => secs.reduce((t, s) => t + s.items.reduce((a, it) => a + r2(n(it.qty) * n(it.rate)), 0), 0);
function optionTotals(d, i) { // totals if option i is chosen, with the quote's discount / tax / round-off
  return totals(Object.assign({}, d, { selected_option: i }));
}
function addQuoteOption(name, sections, note) {
  const d = Q.data; d.options = d.options || [];
  if (d.options.length >= 6) { toast('Maximum 6 options per quote', 'err'); return; }
  d.options.push({ name: name || 'Option ' + (d.options.length + 1), note: note || '', sections: sections && sections.length ? sections : [{ title: 'Option items', items: [] }] });
  if (d.options.length === 1) d.selected_option = 0;
}

function drawOptions() {
  const box = $('#optbox'); if (!box) return;
  const d = Q.data, o = d.options || [];
  if (!o.length) {
    box.innerHTML = `<div class="card"><h2>Options (Good / Better / Best)</h2><p class="muted small" style="margin:0 0 8px">Offer alternative packages on the same quote - e.g. GI vs UPVC vs PUF. The client picks one; the grand total follows the selected option. Sections above stay common to all options.</p>
    <button class="btn sm" data-act="optadd">+ Add option</button>${Q.division === 'roofing' ? ' <span class="muted small">or use the Roofing calculator → “Add as option”</span>' : ''}</div>`;
    return;
  }
  box.innerHTML = `<div class="card"><h2>Options (Good / Better / Best)</h2>
  <p class="muted small" style="margin:0 0 10px">Common sections above + <b>one</b> option below. Select the option that drives the grand total (the client can also choose on the shared link).</p>
  ${o.map((op, oi) => `<div class="sec" data-o="${oi}"><div class="sec-h"><label class="row" style="gap:6px;white-space:nowrap"><input type="radio" style="width:auto" name="optsel" data-act="optsel" ${d.selected_option === oi ? 'checked' : ''}><span class="small">Selected</span></label>
   <input data-of="name" aria-label="Option name" value="${esc(op.name)}" placeholder="Option name"><span class="muted small nw" id="ot-${oi}"></span><button class="btn sm dng" data-act="optdel" title="Remove option" aria-label="Remove option">✕</button></div>
   <div style="padding:8px 12px"><input data-of="note" aria-label="Option note shown to the client" value="${esc(op.note)}" placeholder="Short note shown to the client (e.g. 20-year warranty, best insulation)"></div>
   ${op.sections.map((s, si) => `<div class="scroll"><table class="items"><thead><tr><th colspan="7"><input data-os="title" aria-label="Section title" data-si="${si}" value="${esc(s.title)}" placeholder="Section title"></th></tr><tr><th>#</th><th>Description</th><th>Unit</th><th>Qty</th><th>Rate (₹)</th><th class="r">Amount</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
   ${s.items.map((it, ii) => `<tr data-si="${si}" data-ii="${ii}"><td class="muted" style="width:38px;padding-top:11px">${ii + 1}</td><td><textarea data-oi="desc" aria-label="Description" rows="1">${esc(it.desc)}</textarea></td><td style="width:84px"><input data-oi="unit" aria-label="Unit" list="units" value="${esc(it.unit)}"></td>
   <td style="width:96px"><input data-oi="qty" aria-label="Quantity" type="number" step="any" min="0" value="${esc(it.qty)}"></td><td style="width:116px"><input data-oi="rate" aria-label="Rate" type="number" step="any" min="0" value="${esc(it.rate)}"></td>
   <td class="amt" style="width:120px">${fmt(r2(n(it.qty) * n(it.rate)))}</td><td style="width:34px"><button class="btn sm dng" data-act="optdelitem" aria-label="Remove item">✕</button></td></tr>`).join('')}</tbody></table></div>
   <div class="sec-f"><button class="btn sm" data-act="optaddrate" data-si="${si}">+ From rate card</button><button class="btn sm" data-act="optadditem" data-si="${si}">+ Custom item</button></div>`).join('')}</div>`).join('')}
  <div class="row"><button class="btn sm" data-act="optadd">+ Add option</button></div></div>`;
  $$('#optbox textarea').forEach(growTa);
  updOptionTotals();
}
function updOptionTotals() {
  const d = Q.data; (d.options || []).forEach((op, i) => { const e = $('#ot-' + i); if (e) e.textContent = 'Option ' + inr(secSum(op.sections)) + ' · Quote total ' + inr(optionTotals(d, i).total); });
}

/* hooks called by the editor */
function optionsInput(t) {
  const row = t.closest('.sec[data-o]'); if (!row) return false;
  const op = Q.data.options[+row.dataset.o];
  if (t.dataset.of) op[t.dataset.of] = t.value;
  else if (t.dataset.os) op.sections[+t.dataset.si].title = t.value;
  else if (t.dataset.oi) {
    const tr = t.closest('tr'), it = op.sections[+tr.dataset.si].items[+tr.dataset.ii];
    it[t.dataset.oi] = t.value; if (t.tagName === 'TEXTAREA') growTa(t);
    const a = tr.querySelector('.amt'); if (a) a.textContent = fmt(r2(n(it.qty) * n(it.rate)));
  } else return false;
  markDirty(); updOptionTotals(); recalc(); return true;
}
function optionsClick(a, t) {
  const d = Q.data, row = t.closest('.sec[data-o]'), oi = row ? +row.dataset.o : -1;
  if (a === 'optadd') { addQuoteOption('', null); markDirty(); drawEditor(); }
  else if (a === 'optsel') { d.selected_option = oi; markDirty(); updOptionTotals(); recalc(); }
  else if (a === 'optdel') { if (confirmBox('Remove this option?')) { d.options.splice(oi, 1); d.selected_option = 0; markDirty(); drawEditor(); } }
  else if (a === 'optadditem') { d.options[oi].sections[+t.dataset.si].items.push({ desc: '', unit: '', qty: 1, rate: '' }); markDirty(); drawOptions(); }
  else if (a === 'optdelitem') { const tr = t.closest('tr'); d.options[oi].sections[+tr.dataset.si].items.splice(+tr.dataset.ii, 1); markDirty(); drawOptions(); recalc(); }
  else if (a === 'optaddrate') pickRates(-1, { oi, si: +t.dataset.si });
  else return false;
  return true;
}
