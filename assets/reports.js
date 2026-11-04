'use strict';
/* Reports: conversion, salesperson, lead source, margin, aging, receivables */

async function pageReports() {
  const r = await api('reports');
  const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '—';
  const maxM = Math.max(1, ...r.monthly.map(m => m.value));
  const bar = (v, mx, cls = '') => `<div class="hbar"><i class="${cls}" style="width:${Math.round(v * 100 / Math.max(mx, 1))}%"></i></div>`;
  const marginRows = r.margin.map(m => ({ ...m, pct: m.rev > 0 ? (m.rev - m.cost) * 100 / m.rev : 0 }));
  const minM = n(S.settings.min_margin);
  const maxAge = Math.max(1, ...r.aging.map(a => a.value));
  const rc = r.receivables;
  $('#view').innerHTML = `<div class="page-head"><h1>Reports</h1><span class="muted small">Latest revision of every quote</span></div>
  <div class="tiles">
   <div class="tile"><div class="l">Contract value (projects)</div><div class="v">${inr0(rc.contract)}</div><div class="s">${rc.projects} project(s)</div></div>
   <div class="tile"><div class="l">Collected</div><div class="v good">${inr0(rc.received)}</div><div class="s">${pct(rc.received, rc.contract)} of contract</div></div>
   <div class="tile"><div class="l">Outstanding</div><div class="v ${rc.overdue ? 'bad' : ''}">${inr0(rc.outstanding)}</div><div class="s">${rc.overdue} overdue milestone(s)</div></div>
  </div>
  <div class="grid2"><div class="card"><h3>Quote → win by division</h3><div class="scroll"><table class="tbl"><thead><tr><th>Division</th><th class="r">Quotes</th><th class="r">Won</th><th class="r">Lost</th><th class="r">Win rate</th><th class="r">Won value</th></tr></thead><tbody>
   ${r.by_division.map(d => `<tr><td>${divChip(d.division)}</td><td class="r">${d.n}</td><td class="r good">${d.won}</td><td class="r">${d.lost}</td><td class="r"><b>${pct(d.won, d.won + d.lost)}</b></td><td class="r nw">${inr0(d.won_value)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No data yet</td></tr>'}</tbody></table></div></div>
  <div class="card"><h3>Margin by division</h3>${marginRows.length ? `<table class="tbl"><thead><tr><th>Division</th><th class="r">Quotes costed</th><th class="r">Margin</th></tr></thead><tbody>${marginRows.map(m => `<tr><td>${divChip(m.division)}</td><td class="r">${m.n}</td><td class="r"><b class="${minM && m.pct < minM ? 'bad' : 'good'}">${m.pct.toFixed(1)}%</b></td></tr>`).join('')}</tbody></table><p class="muted small" style="margin:8px 0 0">Based on line costs (rate cards or edited in quotes). Target ${minM || '—'}%.</p>` : '<p class="muted small" style="margin:0">Add costs to rate items to see margins.</p>'}</div></div>
  <div class="card"><h3>Quotes by month (last 12)</h3>${r.monthly.length ? r.monthly.map(m => `<div class="row small" style="margin-bottom:6px"><span class="nw" style="width:56px">${monthLabel(m.month)}</span><div style="flex:1">${bar(m.value, maxM)}</div><span class="nw" style="width:260px;text-align:right">${m.n} quotes · ${inr0(m.value)} · won ${m.won} (${inr0(m.won_value)})</span></div>`).join('') : '<p class="muted small" style="margin:0">No data yet</p>'}</div>
  <div class="grid2"><div class="card"><h3>By salesperson</h3><table class="tbl"><thead><tr><th>Name</th><th class="r">Quotes</th><th class="r">Won</th><th class="r">Won value</th></tr></thead><tbody>${r.by_user.map(u => `<tr><td>${esc(u.name)}</td><td class="r">${u.n}</td><td class="r">${u.won} <span class="muted small">(${pct(u.won, u.n)})</span></td><td class="r nw">${inr0(u.won_value)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data yet</td></tr>'}</tbody></table></div>
  <div class="card"><h3>By lead source</h3><table class="tbl"><thead><tr><th>Source</th><th class="r">Quotes</th><th class="r">Won</th><th class="r">Won value</th></tr></thead><tbody>${r.sources.sort((a, b) => b.won_value - a.won_value || b.n - a.n).map(u => `<tr><td>${esc(u.source)}</td><td class="r">${u.n}</td><td class="r">${u.won} <span class="muted small">(${pct(u.won, u.n)})</span></td><td class="r nw">${inr0(u.won_value)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data yet</td></tr>'}</tbody></table><p class="muted small" style="margin:8px 0 0">Set “Lead source” on each quote to fill this in.</p></div></div>
  <div class="card"><h3>Sent quotes waiting for a reply</h3>${r.aging.map(a => `<div class="row small" style="margin-bottom:6px"><span class="nw" style="width:90px">${esc(a.bucket)}</span><div style="flex:1">${bar(a.value, maxAge, a.bucket === '15+ days' ? 'bad' : '')}</div><span class="nw" style="width:170px;text-align:right">${a.n} quote(s) · ${inr0(a.value)}</span></div>`).join('')}</div>`;
}
