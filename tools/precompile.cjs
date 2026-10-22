#!/usr/bin/env node
// COMPILE THE CLIENT ONCE, HERE, INSTEAD OF ON EVERY ATHLETE'S PHONE.
//
// golsz-app.html carries the whole SPA as JSX inside one <script> block, and
// until now every page load downloaded babel-standalone (~2.9MB raw) and spent
// roughly 1.8s of blocked main thread compiling 985,000 characters of it. The
// file's own comment records the consequence: first paint 3336ms on a real
// logged-in load. That is the single biggest thing standing between a
// fifteen-year-old and this app, because a slow start and a dead app look
// identical — you close both.
//
// WHY THE OUTPUT IS COMMITTED RATHER THAN BUILT ON DEPLOY.
// Pushing to main auto-deploys production and there is no Vercel CLI here.
// The artifact (js/app.js) is committed, and the gate fails if it is stale.
// (Since 2026-10-21 the buildCommand also runs split, a second compile and
// strip on Vercel; see CLAUDE.md "THE DEPLOY GATE". Those steps never touch
// what is committed.) Committing the artifact keeps the deploy path
// checkable locally: the compiled file git holds is the one the gate tests.
//
// WHY THE JSX BLOCK STAYS IN THE HTML.
// 21 test suites readFileSync golsz-app.html and slice real expressions out of
// it by string anchor. Removing the block is a separate change with its own
// blast radius. It is inert now — nothing compiles it, because the browser
// ignores a script of unknown type and babel-standalone is gone.
//
// THE COMPILER IS PINNED EXACT, and to the same version the page loaded from
// cdnjs. A caret would let another machine produce different bytes from
// unchanged source and fail the gate on a repo nobody touched.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Babel = require("@babel/standalone");
const Terser = require("terser");

const REPO = path.join(__dirname, "..");
const HTML = path.join(REPO, "golsz-app.html");
const OUT = path.join(REPO, "js", "app.js");
const OPEN = '<script type="text/babel-deferred" data-presets="react">';

// The option set babel-standalone itself applies to data-presets="react".
// Deliberately NOT passing sourceType: production parses this block the way
// babel-standalone's own buildBabelOptions does, and changing that silently
// switches strict-mode semantics for 14,000 lines.
const OPTIONS = { presets: ["react"] };

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function extract(html) {
  const n = html.split(OPEN).length - 1;
  if (n !== 1) throw new Error(`expected exactly 1 app script block, found ${n}`);
  const start = html.indexOf(OPEN) + OPEN.length;
  const end = html.indexOf("</script>", start);
  if (end < 0) throw new Error("unterminated app script block");
  const jsx = html.slice(start, end);
  if (jsx.length < 500000) throw new Error(`extracted only ${jsx.length} chars — extraction is wrong`);
  return jsx;
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
//   comments are dropped. The source-sha stamp is added by the caller AFTER
//     this runs, because tools/strip-jsx.cjs and tests/test_compiled_artifact.cjs
//     read it from the first lines of the file.
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

module.exports = { OPEN, OPTIONS, extract, compile, sha };

if (require.main === module) {
  const html = fs.readFileSync(HTML, "utf8");
  const jsx = extract(html);
  const code = compile(jsx);
  const header = `// GENERATED by tools/precompile.cjs — DO NOT EDIT.\n`
    + `// Edit the JSX in golsz-app.html, then run: npm run compile\n`
    + `// source-sha: ${sha(jsx)}\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + code);
  // THE CACHE BUSTER IS DERIVED, NOT TYPED. golsz-app.html is served
  // must-revalidate but js/app.js is a static asset a CDN or a browser may
  // hold; if the query string did not change with the bytes, a deploy could
  // ship new HTML against a stale bundle, which is the one failure worse than
  // a slow load because it is silent and version-skewed.
  const stamp = sha(header + code);
  const h = fs.readFileSync(HTML, "utf8");
  const next = h.replace(/js\/app\.js\?v=[0-9a-f]{16}|js\/app\.js\?v=__APPHASH__/g, `js/app.js?v=${stamp}`);
  if (next === h && !h.includes(`js/app.js?v=${stamp}`)) throw new Error("no js/app.js?v= reference found in golsz-app.html to stamp");
  if (next !== h) fs.writeFileSync(HTML, next);
  console.log(`precompile: jsx ${jsx.length} -> js ${code.length} chars  source-sha ${sha(jsx)}  bundle ${stamp}`);
}
