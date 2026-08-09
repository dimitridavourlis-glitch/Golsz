// golsz-app.html is a single 740 KB inline <script type="text/babel"> block
// transpiled in the browser at load time. There is no build step, so a JSX
// syntax error anywhere in 10,000 lines does not fail a deploy — it ships,
// and the app renders a blank page for every user until someone opens it in
// a browser and notices.
//
// `npm run check` validated api/scout.js and api/moderate.js with
// `node --check` and left the entire client unvalidated. This closes that:
// @babel/parser (zero-config, one transitive dep, parse-only — no
// transpile, no bundler) reads the same script the browser will.
//
// It also asserts the structural invariants of the file that a regex-based
// edit could plausibly break without producing a syntax error.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");

const REPO = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the browser's script block parses as JSX --");
const blocks = [...HTML.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ck("exactly one text/babel block exists", blocks.length, 1);

let parseError = null;
try {
  parser.parse(blocks[0], {
    sourceType: "script",
    plugins: ["jsx"],
    errorRecovery: false,
  });
} catch (e) {
  // Report the real location — a bare "unexpected token" in a 740 KB string
  // is useless. Convert the character offset into a line the editor can open.
  const upto = blocks[0].slice(0, (e.pos != null ? e.pos : 0));
  const lineInBlock = upto.split("\n").length;
  const blockStart = HTML.indexOf(blocks[0]);
  const lineInFile = HTML.slice(0, blockStart).split("\n").length + lineInBlock - 1;
  parseError = `${e.message} -> golsz-app.html:${lineInFile}`;
}
ck("the whole client parses with no syntax error", parseError, null);

console.log("\n-- structural invariants a bad edit could break silently --");
// A duplicated or dropped component definition parses fine and then behaves
// wrongly at runtime, which is exactly the class of damage a scripted edit
// across a 10k-line file causes.
for (const fn of ["GolszApp", "Scout", "Passport", "HomeTab", "Targets", "GoalCard", "ProfileEditor", "Auth"]) {
  const n = (blocks[0].match(new RegExp("\\bfunction " + fn + "\\s*\\(", "g")) || []).length;
  ck(`${fn}() is defined exactly once`, n, 1);
}

console.log("\n-- every component the app renders actually exists --");
// Catches a rename or a paste that left a <Foo /> pointing at nothing —
// React throws at render time, which no other check here would see.
const defined = new Set([...blocks[0].matchAll(/\bfunction ([A-Z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]));
for (const m of blocks[0].matchAll(/\bconst ([A-Z][A-Za-z0-9_]*)\s*=\s*(?:React\.)?(?:memo|forwardRef|\()/g)) defined.add(m[1]);
// Icon components and React built-ins come from elsewhere in the page.
const external = new Set(["React", "ReactDOM", "Fragment"]);
const used = new Set([...blocks[0].matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)].map((m) => m[1]));
const iconBlock = blocks[0].slice(0, blocks[0].indexOf("const I18N"));
for (const m of iconBlock.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*[:=]/g)) defined.add(m[1]);
const missing = [...used].filter((u) => !defined.has(u) && !external.has(u) && !/^React\./.test(u));
ck("no JSX element references an undefined component", missing, []);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
