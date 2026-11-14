#!/usr/bin/env node
// COMPILE THE CLIENT ONCE, HERE, INSTEAD OF ON EVERY ATHLETE'S PHONE.
//
// golsz-app.jsx is the whole SPA as JSX. Until 2026-10 every page load
// downloaded babel-standalone (~2.9MB raw) and spent roughly 1.8s of blocked
// main thread compiling it; the page's own comment recorded first paint 3336ms
// on a real logged-in load. This builds it once, at author time:
//
//   golsz-app.jsx  ->  js/app.js           the app, with the English dictionary
//                      js/i18n/fr.js       the French dictionary,
//                      js/i18n/es.js       Spanish and Greek; golsz-app.html's
//                      js/i18n/el.js       loader fetches only the one in use
//
// and stamps golsz-app.html's js/app.js?v= with a hash of all four files.
//
// WHAT IS COMMITTED IS WHAT IS SERVED. The outputs are committed, the gate
// (tests/test_compiled_artifact.cjs) fails when they are stale, and Vercel
// serves them as they are: since 2026-11-14 its build runs no compile, split or
// strip step (see CLAUDE.md "THE DEPLOY GATE"). Before that the repo served a
// different app from production's: golsz-app.html still carried 1.45 MB of JSX
// and js/app.js all four languages, and a phone took about 5 s to show the
// sign-up screen in AVA's speed check (AVA job 216).
//
// WHY THE SOURCE KEEPS ALL FOUR LANGUAGES. Every i18n suite asserts key parity,
// interpolation parity and duplicate-freedom against golsz-app.jsx, so the
// dictionaries stay there and are lifted out here, in memory.
//
// THE COMPILER IS PINNED EXACT. A caret would let another machine produce
// different bytes from unchanged source and fail the gate on a repo nobody
// touched.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Babel = require("@babel/standalone");
const Terser = require("terser");

const REPO = path.join(__dirname, "..");
const SOURCE = path.join(REPO, "golsz-app.jsx");
const HTML = path.join(REPO, "golsz-app.html");
const APP_OUT = path.join(REPO, "js", "app.js");
const I18N_DIR = path.join(REPO, "js", "i18n");

// English stays in the bundle: it is the fallback every other language leans
// on, so it must be there before any dictionary has had a chance to load.
const LIFTED = ["fr", "es", "el"];
// The line in golsz-app.jsx that merges a fetched dictionary into I18N. Without
// it a lifted dictionary would be written to a global nothing reads, and three
// languages would silently become English.
const MERGE_HOOK = 'Object.assign(I18N, (typeof window !== "undefined" && window.__GOLSZ_I18N) || {});';

// The option set babel-standalone itself applies to data-presets="react".
// Deliberately NOT passing sourceType: production parses this source the way
// babel-standalone's own buildBabelOptions does, and changing that silently
// switches strict-mode semantics for 20,000 lines.
const OPTIONS = { presets: ["react"] };

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function readSource() {
  const jsx = fs.readFileSync(SOURCE, "utf8");
  if (jsx.length < 500000) throw new Error(`golsz-app.jsx holds only ${jsx.length} chars — that is not the app`);
  return jsx;
}

// Takes fr/es/el out of the I18N object. Each dictionary is a run of very long
// lines closed by a `  },` at the same indent; bounded by that rather than by a
// character count, because a fixed window is exactly how this repo's i18n tests
// once spilled one language into the next. Returns the English-only source and
// each lifted dictionary's body. Pure: no I/O.
function liftDictionaries(jsx) {
  if (!jsx.includes(MERGE_HOOK)) throw new Error("golsz-app.jsx has no __GOLSZ_I18N merge hook — refusing to lift dictionaries nothing would read");
  let out = jsx;
  const dictionaries = {};
  for (const lang of LIFTED) {
    const open = "\n  " + lang + ": {\n";
    const i = out.indexOf(open);
    if (i < 0) throw new Error("could not find the " + lang + " dictionary");
    const bodyStart = i + open.length;
    const close = out.indexOf("\n  },\n", bodyStart);
    if (close < 0) throw new Error("the " + lang + " dictionary has no closing brace");
    const body = out.slice(bodyStart, close);
    if (!/\w+:\s*"/.test(body)) throw new Error("the " + lang + " block does not look like a dictionary");
    dictionaries[lang] = body;
    out = out.slice(0, i) + out.slice(close + "\n  },".length);
  }
  if (!out.includes("\n  en: {\n")) throw new Error("English is missing from the reduced source");
  for (const lang of LIFTED) if (out.includes("\n  " + lang + ": {\n")) throw new Error(lang + " survived the lift");
  return { jsx: out, dictionaries };
}

function compile(jsx) {
  const out = Babel.transform(jsx, OPTIONS);
  if (!out || !out.code) throw new Error("babel produced no output");
  const code = out.code;
  if (!code.includes("React.createElement")) throw new Error("no React.createElement in output — the react preset did not run");
  if (/jsx-runtime|jsx-dev-runtime/.test(code)) throw new Error("automatic runtime leaked in — this browser has no module loader");
  return minify(code);
}

// MINIFIED, CONSERVATIVELY. Babel compiles JSX but does not compress, so the
// bundle was 1.18 MB (about 352 KB gzipped) for an athlete on a phone.
//
// Settings that matter, and why:
//   toplevel is OFF (the default). This is a classic script, not a module, and
//     golsz-app.html's own loader references globals the bundle defines
//     (I18N, BUILD, window.__GOLSZ_I18N). Top-level names must keep their names.
//   keep_fnames is ON. Error messages, the render-crash boundary's logs and any
//     stack an athlete pastes into a support email name the component that
//     failed; "t.a is not a function" would make the next outage harder to
//     diagnose than it is worth saving a few KB.
//   comments are dropped. The source-sha stamp is added by build() AFTER this
//     runs, because tests/test_compiled_artifact.cjs reads it from the first
//     lines of the file.
// Deterministic: the same JSX always yields the same bytes, which is what lets
// test_compiled_artifact rebuild the bundle and compare it byte for byte.
function minify(code) {
  const out = Terser.minify_sync(code, {
    compress: { passes: 1 },
    mangle: { keep_fnames: true },
    keep_fnames: true,
    format: { comments: false },
  });
  if (!out || out.error || !out.code) throw new Error("terser produced no output: " + (out && out.error));
  if (!out.code.includes("React.createElement")) throw new Error("minified bundle lost React.createElement");
  return out.code;
}

const header = (jsx) => `// GENERATED by tools/precompile.cjs — DO NOT EDIT.\n`
  + `// Edit golsz-app.jsx, then run: npm run compile\n`
  + `// source-sha: ${sha(jsx)}\n`;

// Everything the build writes, from the source text. Pure: no I/O.
//   app     js/app.js
//   i18n    { fr, es, el }: js/i18n/<lang>.js
//   stamp   the ?v= for golsz-app.html, over all four files. The dictionaries
//           are fetched with the same ?v= (golsz-app.html's loader derives it),
//           so a change to one of them alone must change it too.
function build(jsx) {
  const lifted = liftDictionaries(jsx);
  const app = header(jsx) + compile(lifted.jsx);
  const i18n = {};
  for (const lang of LIFTED) {
    i18n[lang] = header(jsx)
      + "window.__GOLSZ_I18N = window.__GOLSZ_I18N || {};\n"
      + "window.__GOLSZ_I18N." + lang + " = {\n" + lifted.dictionaries[lang] + "\n};\n";
  }
  return { app, i18n, stamp: stampOf(app, i18n) };
}

function stampOf(app, i18n) {
  return sha(app + LIFTED.map((lang) => i18n[lang]).join(""));
}

module.exports = { OPTIONS, SOURCE, LIFTED, MERGE_HOOK, readSource, liftDictionaries, compile, build, stampOf, sha };

if (require.main === module) {
  const jsx = readSource();
  const out = build(jsx);
  fs.mkdirSync(I18N_DIR, { recursive: true });
  fs.writeFileSync(APP_OUT, out.app);
  for (const lang of LIFTED) fs.writeFileSync(path.join(I18N_DIR, lang + ".js"), out.i18n[lang]);
  // THE CACHE BUSTER IS DERIVED, NOT TYPED. golsz-app.html is served
  // must-revalidate but js/app.js is a static asset a CDN or a browser may
  // hold; if the query string did not change with the bytes, a deploy could
  // ship new HTML against a stale bundle, which is the one failure worse than
  // a slow load because it is silent and version-skewed.
  const h = fs.readFileSync(HTML, "utf8");
  const next = h.replace(/js\/app\.js\?v=[0-9a-f]{16}|js\/app\.js\?v=__APPHASH__/g, `js/app.js?v=${out.stamp}`);
  if (next === h && !h.includes(`js/app.js?v=${out.stamp}`)) throw new Error("no js/app.js?v= reference found in golsz-app.html to stamp");
  if (next !== h) fs.writeFileSync(HTML, next);
  const kb = (s) => Math.round(Buffer.byteLength(s) / 1000) + " KB";
  console.log(`precompile: golsz-app.jsx (source-sha ${sha(jsx)}) -> js/app.js ${kb(out.app)}, `
    + LIFTED.map((lang) => `js/i18n/${lang}.js ${kb(out.i18n[lang])}`).join(", ") + `  stamp ${out.stamp}`);
}
