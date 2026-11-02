// The marketing pages must not wait for Google Fonts before first paint.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const pages = ['index', 'about', 'contact', 'terms', 'privacy', '404'];
let n = 0, failed = 0;
function ok(c, m) { n++; if (!c) { failed++; console.log('FAIL: ' + m); } }
const links = h => h.match(/<link\b[^>]*>/gi) || [];
let url = null;
for (const p of pages) {
  const html = fs.readFileSync(path.join(root, p + '.html'), 'utf8');
  const outside = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  const inside = (html.match(/<noscript>[\s\S]*?<\/noscript>/gi) || []).join('');
  const font = links(outside).filter(l => /fonts\.googleapis\.com\/css2/.test(l));
  const blocking = font.filter(l => /rel="stylesheet"/.test(l) && !/media="print"/.test(l));
  ok(blocking.length === 0, p + ': no blocking fonts stylesheet outside noscript');
  ok(font.some(l => /rel="preload"/.test(l) && /as="style"/.test(l)), p + ': has preload');
  const deferred = font.find(l => /rel="stylesheet"/.test(l) && /media="print"/.test(l) && /onload="this\.media='all'"/.test(l));
  ok(!!deferred, p + ': has media=print onload stylesheet');
  ok(/<link[^>]*rel="stylesheet"[^>]*fonts\.googleapis\.com\/css2/.test(inside), p + ': noscript fallback');
  ok(/rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/.test(html) && /rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/.test(html), p + ': preconnects kept');
  const m = font[0] && font[0].match(/href="([^"]+)"/);
  ok(m && /display=swap/.test(m[1]), p + ': display=swap');
  if (m) { if (!url) url = m[1]; ok(m[1] === url, p + ': same font URL as other pages'); }
  ok(/href="(?:\/)?css\/styles\.css/.test(html), p + ': links css/styles.css');
  if (p !== '404') ok(/src="(?:\/)?js\/main\.js/.test(html), p + ': links js/main.js'); // 404 has no script by design
}
const csp = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
ok(/script-src[^;"]*'unsafe-inline'/.test(csp) && /style-src[^;"]*fonts\.googleapis\.com/.test(csp) && /font-src[^;"]*fonts\.gstatic\.com/.test(csp), 'CSP allows inline onload and Google Fonts');
console.log((n - failed) + '/' + n + ' passed');
process.exit(failed ? 1 : 0);
