// THE APP'S SOURCE AS ONE TEXT, FOR THE SUITES.
//
// Until 2026-11-14 golsz-app.html carried the whole app as JSX inside
// <script type="text/babel-deferred" data-presets="react">, and the suites read
// it from there: they slice functions out between string anchors, and some of
// them check the page around it as well (the head, the boot screen, the loader).
// The JSX now lives in golsz-app.jsx and the page keeps one comment line in its
// place, so a phone downloads a 22 KB page instead of 1.5 MB. (AVA's speed check
// serves the repo uncompressed; that dead block alone cost about 1.5 s on a phone
// network before the app could start. AVA job 216.)
//
// appSource() puts the two back together exactly as the file used to read, so
// every anchor in every suite still finds what it found before. A new suite can
// read golsz-app.jsx (the app) and golsz-app.html (the page) directly.
// Not a suite: run-all.cjs only runs test_*.cjs.
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const OPEN = '<script type="text/babel-deferred" data-presets="react">';
// The one line golsz-app.html keeps where the block was. tests/test_served_bundle.cjs pins it.
const MARKER = "<!-- The app itself is golsz-app.jsx. `npm run compile` (tools/precompile.cjs) builds it into js/app.js, which the loader below runs. -->";

function appSource() {
  const page = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
  const jsx = fs.readFileSync(path.join(REPO, "golsz-app.jsx"), "utf8");
  const parts = page.split(MARKER);
  if (parts.length !== 2) throw new Error(`golsz-app.html must carry the source marker exactly once (found ${parts.length - 1})`);
  // join, not replace: the JSX is full of "$&"-like text that replace() would expand.
  return parts.join(OPEN + jsx + "</script>");
}

module.exports = { appSource, OPEN, MARKER };
