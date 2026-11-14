// The shared Passport is what a coach reads, signed out, in whichever theme
// their browser last used. This computes WCAG contrast for every text/background
// pair PublicPassport draws, in both themes, from the real :root and
// html[data-theme="light"] blocks of the CSS template string in golsz-app.html.
// 4.5:1 for all of it: the text is 9-13px, so the large-text 3:1 never applies.
const fs = require("fs");
const path = require("path");

const html = require("./_app_source.cjs").appSource();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

function block(selector) {
  const start = html.indexOf(selector + " {");
  if (start < 0) throw new Error("CSS block not found: " + selector);
  return html.slice(start, html.indexOf("\n  }", start));
}
function vars(selector) {
  const out = {};
  const re = /(--[\w-]+):\s*([^;]+);/g;
  const css = block(selector).replace(/\/\*[\s\S]*?\*\//g, "");
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2].trim();
  return out;
}

// [r,g,b,a] from #rgb/#rrggbb/rgba(); anything else (gradients) is an error.
function parse(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) { const n = m[1].split(",").map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; }
  throw new Error("cannot parse colour: " + v);
}
const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => {
  const [r, g, b] = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const themes = { dark: vars(":root"), light: vars('html[data-theme="light"]') };

// C.limeText must exist and point at the var.
ok(/limeText:\s*"var\(--lime-text\)"/.test(html), 'C.limeText = "var(--lime-text)"');
ok(themes.dark["--lime-text"] === themes.dark["--lime"], "dark --lime-text equals dark --lime (dark mode unchanged)");
ok(!!themes.light["--lime-text"], "light theme defines --lime-text");

// [label, text var, background vars]. The card is a card->turf gradient, so
// both ends are checked; --passport-strip may be translucent and is blended
// over --card (it sits on the card).
const pairs = [
  ["name/values/metric (chalk)", "--chalk", ["--card", "--turf"]],
  ["labels/dates/method (slate)", "--slate", ["--card", "--turf"]],
  ["bio (body-text)", "--body-text", ["--card", "--turf"]],
  ["strip title (lime-text)", "--lime-text", ["--passport-strip"]],
  ["benchmark values (lime-text)", "--lime-text", ["--card", "--turf"]],
  ["occupation pill + initials (lime-text)", "--lime-text", ["--card", "--turf"]],
  ["status messages (slate)", "--slate", ["--pitch"]],
  ["CTA (slate)", "--slate", ["--pitch"]],
];

for (const [name, vs] of Object.entries(themes)) {
  const card = parse(vs["--card"]);
  for (const [label, fg, bgs] of pairs) {
    for (const bgVar of bgs) {
      let bg = parse(vs[bgVar]);
      if (bg[3] < 1) bg = blend(bg, card);
      const r = ratio(parse(vs[fg]), bg);
      ok(r >= 4.5, `${name}: ${label} ${fg} ${vs[fg]} on ${bgVar} ${vs[bgVar]} = ${r.toFixed(2)}:1 (< 4.5)`);
    }
  }
}

// No hex literal inside PublicPassport (they stay dark-mode-only forever).
const s = html.indexOf("function PublicPassport(");
const body = html.slice(s, html.indexOf("\nfunction ProfileEditor(", s));
ok(!/style=\{\{[^}]*#[0-9a-fA-F]{3,8}\b/.test(body.replace(/0 20px 40px -20px #000/, "")), "no hex literal in PublicPassport style objects");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
