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
const apply = /querySelector\("#boot \.m"\)[\s\S]{0,80}bootCopy\(\)\[2\]/.exec(APP);
ck("the saved language is applied from bootCopy()[2]", !!apply);
// The browser can paint #boot while it is still parsing the ~19,000-line inert JSX block, so the
// translation must run before that block, right after #boot, or fr/es/el visitors see English first.
const jsxAt = APP.indexOf('<script type="text/babel-deferred"');
ck("BOOT_COPY is defined after #boot and before the JSX block",
   APP.indexOf("var BOOT_COPY = {") > APP.indexOf('<div id="boot"') && APP.indexOf("var BOOT_COPY = {") < jsxAt);
ck("the loading line is translated before the JSX block", !!apply && apply.index < jsxAt);
ck("BOOT_COPY is defined once (bootFailed reuses it)", APP.split("var BOOT_COPY = {").length - 1, 1);

// Run the early script against a fake DOM: each saved language gets its own line, unknown falls back.
const early = (/var BOOT_COPY = \{[\s\S]*?(?=<\/script>)/.exec(APP) || [""])[0];
for (const [saved, txt] of [[null, "Loading…"], ["fr", "Chargement…"], ["es", "Cargando…"], ["el", "Φόρτωση…"], ["xx", "Loading…"]]) {
  const line = { textContent: "Loading…" };
  const document = { querySelector: (q) => (q === "#boot .m" ? line : null) };
  const localStorage = { getItem: () => saved };
  new Function("document", "localStorage", early)(document, localStorage);
  ck(`golsz-lang=${saved}: the line reads ${txt}`, line.textContent, txt);
}

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
