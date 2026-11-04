'use strict';
/* Settings cards for account security (password, 2FA), e-mail, and team management; "Email to client" dialog */

async function renderSecurity() {
  const box = $('#seccard'); if (!box) return;
  const me = await api('auth/me'); const on = !!(me.user && me.user.totp);
  box.innerHTML = `<h3>My account &amp; security</h3><div class="grid2"><div>
   <form id="pw"><label class="f"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label><label class="f"><span>New password (min 8 characters)</span><input type="password" name="new" minlength="8" required autocomplete="new-password"></label><button class="btn">Update password</button></form></div>
   <div><p style="margin:0 0 6px"><b>Two-step sign-in</b> ${on ? '<span class="chip accepted">On</span>' : '<span class="chip draft">Off</span>'}</p>
   <p class="muted small" style="margin-top:0">Adds a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…) to your password. Strongly recommended for admins.</p>
   <div id="tfa">${on ? '<button class="btn dng" data-tf="off" type="button">Turn off…</button>' : '<button class="btn pri" data-tf="on" type="button">Set up two-step sign-in</button>'}</div></div></div>`;
  $('#pw').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('auth/password', 'POST', { current: f.current.value, new: f.new.value }); toast('Password updated', 'ok'); f.reset(); }); };
  box.onclick = e => {
    const t = e.target.closest('[data-tf]'); if (!t) return;
    if (t.dataset.tf === 'on') guard(async () => {
      const r = await api('auth/2fa/setup', 'POST'); const pretty = r.secret.replace(/(.{4})/g, '$1 ').trim();
      $('#tfa').innerHTML = `<ol class="small" style="padding-left:18px;margin:0 0 10px"><li>In your authenticator app choose <b>Add account → Enter a setup key</b> (or tap the link on your phone).</li><li>Account: <b>${esc(S.user.email)}</b> · Key: <code style="font-size:14px;color:var(--gold2)">${esc(pretty)}</code> · Type: time-based</li><li>Type the 6-digit code it shows:</li></ol>
        <a class="btn sm" href="${esc(r.uri)}">Open in authenticator app</a> <div class="row" style="margin-top:10px"><input id="tfc" inputmode="numeric" maxlength="6" placeholder="123456" style="width:140px"><button class="btn pri" id="tfv" type="button">Verify &amp; turn on</button></div>`;
      $('#tfv').onclick = () => guard(async () => { const x = await api('auth/2fa/enable', 'POST', { code: $('#tfc').value }); showRecovery(x.recovery_codes); renderSecurity(); });
    });
    if (t.dataset.tf === 'off') { const pw = window.prompt('Enter your password to turn off two-step sign-in'); if (pw) guard(async () => { await api('auth/2fa/disable', 'POST', { password: pw }); toast('Two-step sign-in is off', 'ok'); renderSecurity(); }); }
  };
}
function showRecovery(codes) {
  const text = codes.join('\n');
  const m = openModal(`<h2>Two-step sign-in is on</h2><div class="banner"><b>Save these recovery codes now.</b> Each works once if you lose your phone. They are shown only this one time.</div>
  <pre class="snip" style="font-size:16px;letter-spacing:1px">${esc(text)}</pre><div class="row"><button class="btn" id="rc1" type="button">Copy</button><button class="btn" id="rc2" type="button">Download</button><span class="sp"></span><button class="btn pri" id="rc3" type="button">I have saved them</button></div>`);
  $('#rc1', m.el).onclick = () => copyText(text); $('#rc2', m.el).onclick = () => download('recovery-codes.txt', text + '\n', 'text/plain'); $('#rc3', m.el).onclick = m.close;
}

async function renderMailCard() {
  const box = $('#mailcard'); if (!box) return;
  const s = S.settings; const configured = !!(s.smtp_host || s.mail_from);
  box.innerHTML = `<h3>E-mail (quotes, reminders, password resets)</h3>
  <p class="small" style="margin-top:0">${configured ? '<span class="chip accepted">Configured</span>' : '<span class="chip draft">Not set up</span>'} Use the mail account from your hosting (Hostinger: <b>smtp.hostinger.com</b>, port <b>465</b>, SSL, the full mailbox address as user). Without SMTP the app falls back to PHP's mail(), which often lands in spam.</p>
  <div class="grid3"><label class="f"><span>SMTP server</span><input data-m="smtp_host" value="${esc(s.smtp_host || '')}" placeholder="smtp.hostinger.com"></label>
  <label class="f"><span>Port</span><input data-m="smtp_port" type="number" value="${esc(s.smtp_port || '465')}"></label>
  <label class="f"><span>Encryption</span><select data-m="smtp_enc">${[['ssl', 'SSL (port 465)'], ['tls', 'STARTTLS (port 587)'], ['none', 'None (not recommended)']].map(([v, l]) => `<option value="${v}" ${(s.smtp_enc || 'ssl') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label class="f"><span>SMTP user</span><input data-m="smtp_user" value="${esc(s.smtp_user || '')}" autocomplete="off"></label>
  <label class="f"><span>SMTP password</span><input data-m="smtp_pass" type="password" value="${esc(s.smtp_pass || '')}" autocomplete="new-password" placeholder="${s.smtp_pass ? '' : 'mailbox password'}"></label><span></span>
  <label class="f"><span>“From” address</span><input data-m="mail_from" type="email" value="${esc(s.mail_from || '')}" placeholder="quotes@yourdomain.com"></label>
  <label class="f"><span>“From” name</span><input data-m="mail_from_name" value="${esc(s.mail_from_name || '')}" placeholder="${esc(s.company_name || '')}"></label>
  <label class="f"><span>Automatic client reminders</span><select data-m="client_reminders"><option value="0" ${s.client_reminders !== '1' ? 'selected' : ''}>Off - only remind me</option><option value="1" ${s.client_reminders === '1' ? 'selected' : ''}>On - e-mail clients after 3 and 7 days</option></select></label></div>
  <div class="row"><button class="btn pri" id="msave" type="button">Save e-mail settings</button><input id="mto" type="email" placeholder="send a test to…" style="max-width:240px" value="${esc(S.user.email)}"><button class="btn" id="mtest" type="button">Send test e-mail</button><span id="mres" class="small"></span></div>`;
  const body = () => Object.fromEntries($$('[data-m]', box).map(el => [el.dataset.m, el.value]));
  $('#msave').onclick = () => guard(async () => { S.settings = await api('settings', 'PUT', body()); toast('E-mail settings saved', 'ok'); renderMailCard(); });
  $('#mtest').onclick = () => guard(async () => {
    S.settings = await api('settings', 'PUT', body());
    const r = await api('mail/test', 'POST', { to: $('#mto').value }); $('#mres').innerHTML = r.ok ? '<span class="good">Sent - check the inbox (and spam).</span>' : `<span class="bad">Failed: ${esc(r.error)}</span>`;
  });
}

async function renderTeam() {
  const box = $('#teamcard'); if (!box) return;
  const us = await api('users');
  box.innerHTML = `<h3>Team</h3><div class="scroll"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>2-step</th><th></th></tr></thead><tbody>${us.map(u => `<tr><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></td>
   <td><select data-role="${u.id}" style="width:auto"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
   <td>${u.totp_enabled ? '<span class="chip accepted">On</span>' : '<span class="muted small">off</span>'}${u.must_change_password ? ' <span class="chip sent">must change pw</span>' : ''}</td>
   <td class="r nw"><button class="btn sm" data-tm="reset" data-id="${u.id}" type="button">Reset password</button>${u.totp_enabled ? ` <button class="btn sm" data-tm="no2fa" data-id="${u.id}" type="button">Turn off 2-step</button>` : ''}${u.id === S.user.id ? ' <span class="muted small">you</span>' : ` <button class="btn sm dng" data-tm="del" data-id="${u.id}" type="button">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>
  <form id="uf" style="margin-top:12px"><div class="grid2"><label class="f"><span>Name</span><input name="name" required></label><label class="f"><span>Email</span><input name="email" type="email" required></label><label class="f"><span>Password (min 8)</span><input name="password" type="text" minlength="8" required autocomplete="off"></label><label class="f"><span>Role</span><select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label></div><button class="btn">Add user</button></form>`;
  box.onchange = e => { const t = e.target; if (t.dataset.role) guard(async () => { await api('users/' + t.dataset.role, 'PUT', { role: t.value }); toast('Role updated', 'ok'); renderTeam(); }).then(() => renderTeam()); };
  box.onclick = e => {
    const t = e.target.closest('[data-tm]'); if (!t) return; const id = t.dataset.id, a = t.dataset.tm;
    if (a === 'del' && confirmBox('Remove this user?')) guard(async () => { await api('users/' + id, 'DELETE'); renderTeam(); });
    if (a === 'no2fa' && confirmBox('Turn off two-step sign-in for this user (e.g. they lost their phone)?')) guard(async () => { await api(`users/${id}/disable-2fa`, 'POST', {}); toast('Two-step sign-in turned off', 'ok'); renderTeam(); });
    if (a === 'reset' && confirmBox('Reset this user\'s password? They will have to choose a new one at next sign-in.')) guard(async () => {
      const r = await api(`users/${id}/reset-password`, 'POST', { send_email: !!(S.settings.smtp_host || S.settings.mail_from) });
      const m = openModal(`<h2>Temporary password</h2><div class="banner">Give this to the user. It works once and they must change it at sign-in.${r.emailed ? ' It was also e-mailed to them.' : ''}</div><pre class="snip" style="font-size:20px;letter-spacing:1px">${esc(r.temp_password)}</pre><div class="row end"><button class="btn" id="tp1" type="button">Copy</button><button class="btn pri" id="tp2" type="button">Done</button></div>`);
      $('#tp1', m.el).onclick = () => copyText(r.temp_password); $('#tp2', m.el).onclick = () => { m.close(); renderTeam(); };
    });
  };
  $('#uf').onsubmit = e => { e.preventDefault(); const f = e.target; guard(async () => { await api('users', 'POST', Object.fromEntries(new FormData(f))); toast('User added', 'ok'); renderTeam(); }); };
}

/* ---- "Email to client" from the quote editor ---- */
function emailQuoteDialog() {
  const c = Q.client || {}, co = S.settings.company_name || '';
  const m = openModal(`<h2>E-mail quotation ${esc(Q.quote_no)}</h2><p class="muted small" style="margin-top:0">Sends a branded e-mail with a private link where the client can view, choose an option and accept. The quote is marked <b>Sent</b>.</p>
  <label class="f"><span>To</span><input id="eto" type="email" value="${esc(c.email || '')}" placeholder="client@example.com" required></label>
  <label class="f"><span>Message (optional - leave blank for the standard text)</span><textarea id="emsg" rows="4" placeholder="Dear ${esc(c.contact_person || c.name || '')}, please find the quotation we discussed…"></textarea></label>
  <div class="row end"><button class="btn" id="ex" type="button">Cancel</button><button class="btn pri" id="es" type="button">Send e-mail</button></div>`);
  $('#ex', m.el).onclick = m.close;
  $('#es', m.el).onclick = () => guard(async () => {
    const btn = $('#es', m.el); btn.disabled = true;
    try { const r = await api(`quotes/${Q.id}/email`, 'POST', { to: $('#eto', m.el).value, message: $('#emsg', m.el).value }); Q.updated_at = r.updated_at; toast('E-mail sent to ' + r.to, 'ok'); m.close(); pageEditor(Q.id); }
    catch (e) { btn.disabled = false; throw e; }
  });
}

/* ---- Settings -> System health, backups and scheduled jobs ---- */
async function renderSystemCard() {
  const box = $('#syscard'); if (!box) return;
  const s = await api('system');
  const age = s.backups.length ? Math.round((Date.now() - new Date(s.backups[0].at.replace(' ', 'T'))) / 36e5) : null;
  const cronAge = s.cron_last_run ? Math.round((Date.now() - new Date(s.cron_last_run.replace(' ', 'T'))) / 36e5) : null;
  const dot = (good, warn) => `<span class="chip ${good ? 'accepted' : warn ? 'sent' : 'rejected'}">${good ? 'OK' : warn ? 'Check' : 'Action needed'}</span>`;
  box.innerHTML = `<h3>System health, backups &amp; scheduled jobs</h3>
  <div class="scroll"><table class="tbl"><tbody>
   <tr><td>Automatic backup</td><td>${s.backups.length ? `last one ${age} h ago` : 'never run'}</td><td class="r">${dot(age !== null && age < 48, age !== null)}</td></tr>
   <tr><td>Scheduled jobs (cron)</td><td>${s.cron_last_run ? `last ran ${cronAge} h ago (${esc(s.cron_last_run)})` : 'not set up yet - see below'}</td><td class="r">${dot(cronAge !== null && cronAge < 48, cronAge !== null)}</td></tr>
   <tr><td>E-mail</td><td>${s.mail_configured ? 'configured' : 'not set up - reminders and password resets need it'}</td><td class="r">${dot(s.mail_configured, false)}</td></tr>
   <tr><td>Errors in the last 24 hours</td><td>${s.errors_24h}${s.recent_errors.length ? `<div class="muted small">${s.recent_errors.map(e => esc(e.at.slice(11, 16) + ' ' + e.msg.slice(0, 110))).join('<br>')}</div>` : ''}</td><td class="r">${dot(s.errors_24h === 0, s.errors_24h < 5)}</td></tr>
   <tr><td>Server</td><td>PHP ${esc(s.php)} · ${esc(s.driver)} · schema v${s.schema} · ${s.db_quotes} quotes · ${s.disk_free_mb} MB free</td><td></td></tr></tbody></table></div>
  <div class="row" style="margin:12px 0"><button class="btn pri" id="bknow" type="button">Back up now</button><span class="muted small">Backups are kept on the server (api/data/backups, private) - download a copy occasionally and keep it off the server.</span></div>
  ${s.backups.length ? `<div class="small" style="max-height:140px;overflow:auto;margin-bottom:12px">${s.backups.slice(0, 10).map(b => `<div class="row" style="margin-bottom:3px"><span class="muted nw">${esc(b.at.slice(0, 16))}</span><a href="api/index.php?r=system/backup/${esc(b.name)}">${esc(b.name)}</a><span class="muted">${Math.round(b.bytes / 1024)} KB</span></div>`).join('')}</div>` : ''}
  <details><summary class="small" style="cursor:pointer"><b>Set up the daily scheduled job (backups, reminders, daily summary e-mail)</b></summary>
   <p class="small">In Hostinger hPanel open <b>Advanced → Cron Jobs</b>, choose <b>once per day</b> (e.g. 7:30 am) and use this command:</p><pre class="snip">${esc(s.cron_cmd)}</pre><button class="btn sm" data-cp="${esc(s.cron_cmd)}" type="button">Copy command</button>
   <p class="small">If your host cannot run PHP commands, use any web scheduler to open this address daily:</p><pre class="snip">${esc(s.cron_url)}</pre><button class="btn sm" data-cp="${esc(s.cron_url)}" type="button">Copy address</button></details>
  <details style="margin-top:8px"><summary class="small" style="cursor:pointer"><b>Uptime monitoring</b></summary><p class="small">Point a free monitor (UptimeRobot, Better Stack…) at this address - it answers 200 when the app and database are healthy:</p><pre class="snip">${esc(s.health_url)}</pre><button class="btn sm" data-cp="${esc(s.health_url)}" type="button">Copy address</button></details>`;
  box.onclick = e => {
    const cp = e.target.closest('[data-cp]'); if (cp) return copyText(cp.dataset.cp);
    if (e.target.id === 'bknow') guard(async () => { e.target.disabled = true; const r = await api('system/backup', 'POST'); toast('Backup saved: ' + r.file, 'ok'); renderSystemCard(); });
  };
}
