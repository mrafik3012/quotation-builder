'use strict';
/* Shared test helpers: tiny fake SMTP server, TOTP generator, cookie-aware API client. No dependencies. */
const net = require('net'), crypto = require('crypto');

/** Fake SMTP server (supports EHLO, AUTH LOGIN, MAIL/RCPT/DATA/QUIT). Captured mail is in .messages. */
function startSmtp(opts = {}) {
  const messages = []; const auth = { seen: [] };
  const server = net.createServer(sock => {
    let buf = '', inData = false, data = '', state = '', cur = { from: '', to: [] };
    const send = s => sock.write(s + '\r\n');
    send('220 fake.smtp ESMTP ready');
    sock.on('data', chunk => {
      buf += chunk.toString('binary');
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n'); if (i < 0) { data += buf; buf = buf.slice(-5); data = data.slice(0, data.length - 0); return; }
          data += buf.slice(0, i); buf = buf.slice(i + 5); inData = false;
          if (opts.rejectData) send('554 Rejected by test'); else { messages.push({ from: cur.from, to: cur.to, raw: data }); send('250 OK queued'); }
          data = ''; cur = { from: '', to: [] }; continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (state === 'user') { auth.seen.push(Buffer.from(line, 'base64').toString()); state = 'pass'; send('334 UGFzc3dvcmQ6'); continue; }
        if (state === 'pass') { auth.seen.push(Buffer.from(line, 'base64').toString()); state = ''; if (opts.password && auth.seen[auth.seen.length - 1] !== opts.password) send('535 Authentication failed'); else send('235 Authenticated'); continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { sock.write('250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n'); }
        else if (up === 'AUTH LOGIN') { state = 'user'; send('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('MAIL FROM:')) { cur.from = line.slice(10).replace(/[<>\s]/g, ''); send('250 OK'); }
        else if (up.startsWith('RCPT TO:')) { cur.to.push(line.slice(8).replace(/[<>\s]/g, '')); send('250 OK'); }
        else if (up === 'DATA') { inData = true; send('354 End data with <CR><LF>.<CR><LF>'); }
        else if (up === 'QUIT') { send('221 Bye'); sock.end(); return; }
        else send('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, messages, auth, close: () => server.close() })));
}

/** Decode a captured message into { headers, subject, text, html }. */
function parseMail(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n'); const body = rest.join('\r\n\r\n');
  const headers = {}; head.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach(l => { const k = l.indexOf(':'); if (k > 0) headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); });
  const dec = s => { const m = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(s || ''); return m ? Buffer.from(m[1], 'base64').toString('utf8') : (s || ''); };
  const part = type => { const m = new RegExp('Content-Type: ' + type + '[^\\r\\n]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)', 'i').exec(body); return m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8') : ''; };
  return { headers, subject: dec(headers.subject), text: part('text/plain'), html: part('text/html'), raw };
}

function b32decode(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret, atMs = Date.now(), offset = 0) {
  const ctr = Math.floor(atMs / 30000) + offset; const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(b).digest(); const o = h[19] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]; return String(n % 1000000).padStart(6, '0');
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async call(method, url, body, headers = {}) {
    const r = await fetch(this.base + '/' + url, { method, headers: { 'X-Requested-With': 'infraura', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data, headers: r.headers };
  }
  api(method, route, body) { return this.call(method, `api/index.php?r=${route}`, body); }
}

module.exports = { startSmtp, parseMail, totp, Client };
