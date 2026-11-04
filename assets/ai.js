'use strict';
/* Settings -> "AI assistants (MCP)": create / revoke tokens and copy ready-made connection snippets */

function mcpUrl() { return new URL('api/mcp.php', location.href.split('#')[0]).href; }

async function renderAiCard() {
  const box = $('#aicard'); if (!box) return;
  const toks = await api('tokens'), s0 = S.settings;
  const live = toks.filter(t => !t.revoked);
  box.innerHTML = `<h3>AI assistants (MCP)</h3>
  <p class="small" style="margin-top:0">Let Claude, ChatGPT-style assistants and other AI tools that support the <b>Model Context Protocol</b> look up rates, price roofs, search quotes and <b>draft</b> quotations. They can never send a quote, accept, delete, record payments or change settings.</p>
  <label class="f"><span>Server address (give this to your AI tool)</span><div class="row"><input readonly id="mcpurl" value="${esc(mcpUrl())}" style="flex:1"><button class="btn" data-ai="copyurl" type="button">Copy</button></div></label>
  <div class="banner" style="margin:0 0 12px"><b>Connect Claude.ai (web) or another “connector” app without a token:</b> in Claude go to <i>Settings → Connectors → Add custom connector</i> and paste the server address above. You will be asked to sign in here and approve the connection. ${s0.oauth_enabled === '0' ? '<b class="bad">Currently switched off.</b>' : ''}<br><label class="row small" style="gap:6px;margin-top:6px"><input type="checkbox" id="oaon" ${s0.oauth_enabled === '0' ? '' : 'checked'}> Allow apps to connect by sign-in (OAuth)</label></div>
  ${live.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Access</th><th>Costs</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${live.map(t => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${t.oauth ? 'connected app · ' : esc(t.prefix) + '… · '}by ${esc(t.owner || '')}</div></td><td>${t.scope === 'write' ? '<span class="chip sent">Read + draft</span>' : '<span class="chip draft">Read only</span>'}</td><td>${t.hide_costs ? 'Hidden' : '<span class="bad">Visible</span>'}</td><td class="nw">${t.last_used_at ? esc(t.last_used_at.slice(0, 16)) : '<span class="muted">never</span>'}</td><td class="nw ${t.expired ? 'bad' : ''}">${t.oauth ? (t.expired ? 'lapsed - reconnect' : 'renews automatically') : t.expires_at ? esc(t.expires_at.slice(0, 10)) + (t.expired ? ' (expired)' : '') : 'never'}</td><td class="r"><button class="btn sm dng" data-ai="revoke" data-id="${t.id}" type="button">${t.oauth ? 'Disconnect' : 'Revoke'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No tokens yet.</p>'}
  <form id="aif" style="margin-top:12px"><div class="grid3"><label class="f"><span>Name (who / what will use it)</span><input name="name" required maxlength="120" placeholder="e.g. Claude - sales team"></label>
   <label class="f"><span>Access</span><select name="scope"><option value="read">Read only (safest)</option><option value="write">Read + create / edit draft quotes</option></select></label>
   <label class="f"><span>Expires</span><select name="expires_days"><option value="30">in 30 days</option><option value="90" selected>in 90 days</option><option value="365">in 1 year</option><option value="0">never</option></select></label></div>
   <label class="row small" style="gap:6px;margin-bottom:10px"><input type="checkbox" name="show_costs"> Let this assistant see your <b>costs and margins</b> (leave off for anything that may talk to clients)</label>
   <button class="btn pri">Create token</button></form>`;
  const oa = $('#oaon'); if (oa) oa.onchange = () => guard(async () => { S.settings = await api('settings', 'PUT', { oauth_enabled: oa.checked ? '1' : '0' }); toast(oa.checked ? 'App sign-in enabled' : 'App sign-in switched off', 'ok'); renderAiCard(); });
  box.onclick = e => {
    const t = e.target.closest('[data-ai]'); if (!t) return;
    if (t.dataset.ai === 'copyurl') copyText($('#mcpurl').value);
    if (t.dataset.ai === 'revoke' && confirmBox('Revoke this token? Any AI tool using it stops working immediately.')) guard(async () => { await api('tokens/' + t.dataset.id, 'DELETE'); toast('Token revoked', 'ok'); renderAiCard(); });
  };
  $('#aif').onsubmit = e => {
    e.preventDefault(); const fd = new FormData(e.target), body = Object.fromEntries(fd); body.show_costs = fd.has('show_costs'); body.expires_days = +body.expires_days;
    guard(async () => { const r = await api('tokens', 'POST', body); showToken(r.token, body); renderAiCard(); });
  };
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); } catch (e) { const t = document.createElement('textarea'); t.value = s; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('Copied', 'ok');
}

function showToken(token, meta) {
  const url = mcpUrl(), q = s => s.replace(/"/g, '\\"');
  const snippets = {
    'Claude Code (terminal)': `claude mcp add --transport http infraura ${url} --header "Authorization: Bearer ${token}"`,
    'Claude Desktop (via mcp-remote)': JSON.stringify({ mcpServers: { infraura: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`] } } }, null, 2),
    'Cursor / Windsurf (mcp.json)': JSON.stringify({ mcpServers: { infraura: { url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2),
    'VS Code (.vscode/mcp.json)': JSON.stringify({ servers: { infraura: { type: 'http', url, headers: { Authorization: 'Bearer ' + token } } } }, null, 2),
    'Test with curl': `curl -s ${url} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
  const m = openModal(`<h2>Token created: ${esc(meta.name)}</h2>
  <div class="banner"><b>Copy it now - it is shown only once.</b> It is stored as a one-way hash, so nobody (including you) can read it again. If lost, revoke it and create a new one.</div>
  <label class="f"><span>Token</span><div class="row"><input readonly id="tkv" value="${esc(token)}" style="flex:1;font-family:monospace"><button class="btn pri" id="tkc" type="button">Copy</button></div></label>
  <p class="small muted" style="margin:0 0 8px">${meta.scope === 'write' ? 'Read + draft access' : 'Read-only access'} · costs ${meta.show_costs ? 'visible' : 'hidden'} · ${meta.expires_days ? 'expires in ' + meta.expires_days + ' days' : 'never expires'}</p>
  ${Object.entries(snippets).map(([k, v], i) => `<details ${i === 0 ? 'open' : ''} style="margin-bottom:8px"><summary class="small" style="cursor:pointer"><b>${esc(k)}</b></summary><pre class="snip">${esc(v)}</pre><button class="btn sm" data-sn="${i}" type="button">Copy</button></details>`).join('')}
  <div class="row end"><button class="btn pri" id="tkx">Done</button></div>`, true);
  $('#tkc', m.el).onclick = () => copyText(token);
  $$('[data-sn]', m.el).forEach(b => { b.onclick = () => copyText(Object.values(snippets)[+b.dataset.sn]); });
  $('#tkx', m.el).onclick = m.close;
}
