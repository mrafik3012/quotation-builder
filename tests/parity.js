'use strict';
/* Proves the browser (JS) and server (PHP) money math agree to the paisa on thousands of random quotes,
   including rounding ties (e.g. 1.005). Usage: node tests/parity.js   (needs `php` on PATH) */
const fs = require('fs'), vm = require('vm'), path = require('path'), { execFileSync } = require('child_process'), os = require('os');
const ctx = vm.createContext({ document: { querySelector() {}, querySelectorAll() { return []; }, addEventListener() {} }, window: { addEventListener() {} }, console, Intl, localStorage: {}, navigator: {}, location: { hash: '' } });
for (const f of ['app.js', 'options.js', 'editor.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8').replace(/^'use strict';/, ''), ctx, { filename: f });
vm.runInContext('globalThis.__totals = totals;', ctx);

let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
const dec = (max, dp) => Math.round(rnd() * max * 10 ** dp) / 10 ** dp;
const cases = [];
for (let i = 0; i < 4000; i++) {
  const items = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({ qty: pick([1, 2, 3, 0.5, 1.5, 2.25, dec(500, 2), dec(50, 3)]), rate: pick([0.05, 1.005, 99.99, 333.33, dec(100000, 2), dec(100, 3), 0.1, 10.5]) }));
  cases.push({ sections: [{ items: items.slice(0, 3) }, { items: items.slice(3) }], discount: { type: pick(['percent', 'flat']), value: pick([0, 2.5, 5, 7.5, 10, 12.5, dec(30, 2), dec(5000, 2)]) }, tax_rate: pick([0, 5, 12, 18, 28, 2.5, 9]), round_off: rnd() < 0.4 });
}
const tmp = path.join(os.tmpdir(), 'parity-cases.json'); fs.writeFileSync(tmp, JSON.stringify(cases));
const php = JSON.parse(execFileSync('php', [path.join(__dirname, 'parity.php'), tmp], { maxBuffer: 1 << 26 }).toString());
let bad = 0;
cases.forEach((c, i) => {
  const t = ctx.__totals(JSON.parse(JSON.stringify(c))); const p = php[i];
  const js = [t.sub, t.disc, t.tax, t.ro, t.total];
  if (js.some((v, k) => Math.abs(v - p[k]) > 0.0001)) { if (bad++ < 5) console.log('MISMATCH', JSON.stringify(c), 'js', js, 'php', p); }
});
console.log(bad ? `FAIL: ${bad} of ${cases.length} cases differ` : `OK: JS and PHP agree on all ${cases.length} random quotes`);
process.exit(bad ? 1 : 0);
