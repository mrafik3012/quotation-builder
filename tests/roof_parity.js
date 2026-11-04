'use strict';
/* The server-side roof calculator (api/core.php, used by the MCP tools) must price exactly like the browser one (assets/roof.js). */
const fs = require('fs'), vm = require('vm'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const ctx = vm.createContext({ document: { querySelector() {}, querySelectorAll() { return []; }, addEventListener() {} }, window: { addEventListener() {} }, console, Intl, localStorage: {}, navigator: {}, location: { hash: '' } });
for (const f of ['app.js', 'options.js', 'editor.js', 'roof.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8').replace(/^'use strict';/, ''), ctx, { filename: f });
vm.runInContext('globalThis.__run = (inp, rates, mats) => { S.rates = rates.map(r => ({ ...r, active: 1, division: "roofing" })); Q = { data: { roofcalc: { custom: {} }, tax_rate: 18 } }; const p = Object.assign({}, ROOF_DEFAULT, inp); const g = roofGeometry(p); if (!g) return null; const out = {}; for (const k of mats) { const it = roofItems(g, p, k); out[k] = [roofSum(it), it.length, r2(it.reduce((s, i) => s + i.qty * i.cost, 0))]; } return out; };', ctx);

let seed = 987; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)], dec = (m, d = 1) => Math.round(rnd() * m * 10 ** d) / 10 ** d;
const mats = ['gi', 'gi55', 'galv', 'upvc', 'upvcasa', 'puf30', 'puf50', 'puf75', 'alu', 'poly'];
const matchNames = ['GI colour coated sheet 0.40 mm (PPGI)', 'UPVC trapezoidal roofing sheet 2.5 mm', 'PUF sandwich panel 50 mm - supply', 'Aluminium roofing sheet 0.60 mm coated', 'GI / MS purlins (Z / C) - supply & fixing', 'Ridge cap flashing (PPGI)', 'Box gutter - GI 0.8 mm, fabricated', 'Turbo ventilator 24 inch (aluminium)', 'FRP roofing sheet 1.5 mm', 'Polycarbonate multiwall sheet 6 mm'];
const cases = [];
for (let i = 0; i < 1500; i++) {
  const inp = { type: pick(['gable', 'shed', 'flat']), len: pick([0, dec(300), dec(60)]), wid: pick([dec(120), dec(40), 25.5]), slope: pick([0, 5, 10, 15.5, 30, 60, dec(45)]), eave: pick([0, 1, dec(4)]), gable: pick([0, .5, dec(3)]), height: pick([0, 12, dec(30)]), waste: pick([0, 7, 10, dec(20)]), pspace: pick([0, 3, 4, dec(8)]), purlinkg: pick([1.5, 2, dec(4)]), framekg: pick([2.5, 4, dec(6)]), screws: pick([0.7, 1, dec(2)]), turbo: pick([0, 1000, 500, dec(3000, 0)]), sky: pick([0, 5, dec(20)]), gutter: pick(['yes', 'no']) };
  const rates = matchNames.filter(() => rnd() < 0.6).map(n => ({ name: n + ' extra', rate: dec(500, 2), cost: pick([0, dec(400, 2)]) }));
  cases.push({ in: inp, rates });
}
const tmp = path.join(os.tmpdir(), 'roof-cases.json'); fs.writeFileSync(tmp, JSON.stringify(cases));
const php = JSON.parse(execFileSync('php', [path.join(__dirname, 'roof_parity.php'), tmp], { maxBuffer: 1 << 28 }).toString());
let bad = 0, compared = 0;
cases.forEach((c, i) => {
  const js = ctx.__run(JSON.parse(JSON.stringify(c.in)), c.rates, mats), p = php[i];
  if ((js === null) !== (p === null)) { if (bad++ < 5) console.log('NULL MISMATCH', JSON.stringify(c.in)); return; }
  if (!js) return;
  for (const k of mats) { compared++; if (Math.abs(js[k][0] - p[k][0]) > 0.011 || js[k][1] !== p[k][1] || Math.abs(js[k][2] - p[k][2]) > 0.05) { if (bad++ < 5) console.log('MISMATCH', k, JSON.stringify(c.in), 'js', js[k], 'php', p[k]); } }
});
console.log(bad ? `FAIL: ${bad} differences` : `OK: PHP and JS roof calculators agree on ${compared} priced packages`);
process.exit(bad ? 1 : 0);
