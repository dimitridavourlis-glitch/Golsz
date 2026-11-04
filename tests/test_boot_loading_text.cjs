// The boot screen (#boot) shows a visible "Loading…" line under the bar, in the saved language.
// Pins: the element, the four-language copy, the colours' contrast, and that it is not left behind.
const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");
let pass = 0, fail = 0;
const ck = (name, got, want = true) => { if (got === want) pass++; else { fail++; console.error("FAIL: " + name); } };

const boot = APP.slice(APP.indexOf('<div id="boot"'), APP.indexOf('<script type="text/babel-deferred"'));
ck("#boot has a visible .m line reading Loading…", /<p class="m">Loading…<\/p>/.test(boot));
ck("the line is not aria-hidden or display:none", /class="m"[^>]*(aria-hidden|hidden)/.test(boot), false);

const copy = APP.slice(APP.indexOf("var BOOT_COPY = {"), APP.indexOf("function bootCopy("));
const want = { en: "Loading…", fr: "Chargement…", es: "Cargando…", el: "Φόρτωση…" };
for (const [l, txt] of Object.entries(want)) {
  ck(`BOOT_COPY.${l} has the loading string`, new RegExp(l + ': \\["[^"]+", "[^"]+", "' + txt + '"\\]').test(copy));
}
ck("the saved language is applied from bootCopy()[2]", /querySelector\("#boot \.m"\)[\s\S]{0,80}bootCopy\(\)\[2\]/.test(APP));

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const css = APP.slice(0, APP.indexOf("</head>"));
const dark = /#boot \.m\{[^}]*color:(#[0-9A-Fa-f]{6})/.exec(css);
const light = /html\[data-theme="light"\] #boot \.m\{color:(#[0-9A-Fa-f]{6})/.exec(css);
ck("dark colour found", !!dark); ck("light colour found", !!light);
ck("dark text clears 4.5:1 on #0D1210", !!dark && ratio(dark[1], "#0D1210") >= 4.5);
ck("light text clears 4.5:1 on #F5F7F3", !!light && ratio(light[1], "#F5F7F3") >= 4.5);

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
