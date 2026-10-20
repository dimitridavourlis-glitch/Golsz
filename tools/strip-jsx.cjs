// REMOVE THE AUTHORING SOURCE FROM THE SERVED PAGE.
//
// golsz-app.html carries the whole app as JSX inside
//     <script type="text/babel-deferred" data-presets="react">
// That type is not one any browser executes, and babel-standalone has not been
// loaded since tools/precompile.cjs started compiling at author time. So every
// visitor downloads ~1.3MB (393KB gzipped) of source that the browser parses
// as an opaque text node and throws away, and THEN downloads js/app.js to get
// the same code in a form it can run. Measured at fc28b85: 393KB + 337KB
// gzipped, of which 98.7% of the HTML was the dead block. Roughly half of a
// first load, paid by a fifteen-year-old on mobile data.
//
// WHY THIS IS A BUILD STEP AND NOT AN EDIT.
// The JSX in that block is the SOURCE. tools/precompile.cjs reads it to build
// js/app.js, and all 104 test suites read it as the thing they are asserting
// about. Deleting it from the repo would delete the program. So the repo file
// keeps it, and this runs on Vercel only (vercel.json's buildCommand), against
// a throwaway checkout, after the gate has already passed.
//
// A stripped file must never be committed. tests/test_served_bundle.cjs
// asserts the committed golsz-app.html still CONTAINS the block, so if one
// ever is, the gate goes red on the next run rather than silently shipping a
// repo with no source in it.
//
// Usage: node tools/strip-jsx.cjs [htmlPath] [bundlePath]
// Defaults to the repo's own files; the test passes copies.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const HTML = process.argv[2] || path.join(ROOT, "golsz-app.html");
const BUNDLE = process.argv[3] || path.join(ROOT, "js", "app.js");

// Byte-identical to precompile.cjs's, so the two can never disagree about
// where the block starts or how its source is hashed.
const OPEN = '<script type="text/babel-deferred" data-presets="react">';
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

const MARKER = "<!-- Source compiled to js/app.js at build time (tools/strip-jsx.cjs). -->";

const html = fs.readFileSync(HTML, "utf8");
const open = html.indexOf(OPEN);

if (open < 0) {
  // Idempotent: a second build pass, or a file already stripped, is a no-op
  // rather than an error. Nothing is written.
  console.log("strip: no JSX block present, nothing to do");
  process.exit(0);
}

const start = open + OPEN.length;
const end = html.indexOf("</script>", start);
if (end < 0) {
  console.error("strip: the JSX block has no closing </script> — refusing to guess where it ends");
  process.exit(1);
}
const jsx = html.slice(start, end);

// THE REFUSAL THAT MATTERS. Stripping is only safe if the bundle about to be
// served was built from exactly this source. If someone edits the JSX and
// deploys without recompiling, the served page would lose the new code and
// run the old bundle, with no error anywhere. precompile stamps the hash it
// built from; if it is not there, stop.
const bundle = fs.readFileSync(BUNDLE, "utf8");
const want = "// source-sha: " + sha(jsx);
if (bundle.indexOf(want) < 0) {
  console.error("strip: " + path.basename(BUNDLE) + " was not built from this JSX (" + want + " missing).");
  console.error("       Run `npm run compile` first — stripping now would serve a stale bundle.");
  process.exit(1);
}

const stripped = html.slice(0, open) + MARKER + html.slice(end + "</script>".length);

// Everything the page needs to boot lives outside the block; verify rather
// than assume, because the cost of being wrong is a white screen for everyone.
for (const needed of ["<style>", 'id="root"', "js/app.js?v="]) {
  if (stripped.indexOf(needed) < 0) {
    console.error("strip: the stripped page is missing " + needed + " — refusing to write it");
    process.exit(1);
  }
}

fs.writeFileSync(HTML, stripped);
const pct = ((1 - stripped.length / html.length) * 100).toFixed(1);
console.log(
  "strip: removed " + jsx.length + " chars of JSX  (" +
  html.length + " -> " + stripped.length + ", -" + pct + "%)"
);
