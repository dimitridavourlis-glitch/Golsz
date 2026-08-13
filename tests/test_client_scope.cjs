// No identifier is used without being declared.
//
// THE FAILURE THIS CLOSES
// This has happened twice, and both times the suite stayed green and a grep
// found it:
//   • 2026-08-08: `storedAssessment` was declared inside `if (userId) { ... }`
//     and read outside it. Every established athlete got a 502 AFTER the model
//     had answered and been billed. Recorded in tests/README.md.
//   • 2026-08-11: `noteDraft` was used in DevelopmentPlan and never declared,
//     because the script meant to add it aborted first.
//
// `node --check` and a Babel transform both check SYNTAX. An undeclared
// identifier is a runtime ReferenceError — perfectly well-formed source. So
// the suite was structurally incapable of catching this, and "green" meant
// nothing about it. That is a gap to close, not a discipline to remember.
//
// This parses the real client with @babel/parser (jsx) and walks it with
// @babel/traverse, which resolves actual scope bindings. An identifier that
// resolves to no binding and is not a known global is a ReferenceError waiting
// for the right code path.
//
// devDependencies only — nothing here ships to an athlete. The repo's
// one-runtime-dependency discipline is about the bundle, not the toolchain.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
let traverse = require("@babel/traverse");
traverse = traverse.default || traverse;

const REPO = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// The app is one <script type="text/babel"> block.
const OPEN = /<script[^>]*type=["']text\/babel["'][^>]*>/;
const m = OPEN.exec(HTML);
if (!m) throw new Error("no text/babel script found — this suite is not reading what it thinks it is");
const start = m.index + m[0].length;
const end = HTML.indexOf("</script>", start);
if (end < 0) throw new Error("unterminated <script>");
const CODE = HTML.slice(start, end);
if (CODE.length < 100000) throw new Error(`extracted only ${CODE.length} chars — extraction is wrong`);

// Browser + library globals this file legitimately relies on. Anything not
// here and not declared is the bug being hunted.
const GLOBALS = new Set([
  "window", "document", "navigator", "location", "history", "console", "fetch",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "localStorage", "sessionStorage", "URL", "URLSearchParams", "FormData", "Blob", "File",
  "FileReader", "Image", "Audio", "AbortController", "IntersectionObserver", "MutationObserver",
  "ResizeObserver", "crypto", "atob", "btoa", "Uint8Array", "ArrayBuffer", "Notification", "AbortSignal", "TextEncoder", "TextDecoder", "alert", "confirm", "prompt", "structuredClone",
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Error",
  "TypeError", "RangeError", "Promise", "Set", "Map", "WeakMap", "WeakSet", "Symbol", "BigInt",
  "Intl", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "globalThis", "undefined", "NaN", "Infinity",
  "React", "ReactDOM", "Babel", "supabase", "process", "module", "require", "exports",
]);

function undeclaredIn(code, label) {
  const ast = parser.parse(code, {
    sourceType: "script",
    errorRecovery: false,
    plugins: ["jsx"],
  });
  const bad = [];
  traverse(ast, {
    ReferencedIdentifier(pathNode) {
      const name = pathNode.node.name;
      if (GLOBALS.has(name)) return;
      if (pathNode.scope.hasBinding(name, true)) return;
      // JSX intrinsics (<div>) parse as JSXIdentifier, not references, but be
      // safe about lowercase tags slipping through.
      if (pathNode.parent && pathNode.parent.type && pathNode.parent.type.startsWith("JSX") && /^[a-z]/.test(name)) return;
      bad.push(`${name} (line ${pathNode.node.loc ? pathNode.node.loc.start.line : "?"})`);
    },
  });
  return [...new Set(bad)];
}

// ---- the check ----------------------------------------------------------
const undeclared = undeclaredIn(CODE, "golsz-app.html");
console.log(`   parsed ${CODE.length.toLocaleString()} chars of client JSX`);
ck("no identifier is referenced without a binding", undeclared, []);

// ---- NO COMMENT LEAKS INTO THE PAGE AS TEXT -----------------------------
// 2026-08-13, shipped to production and seen on a phone: a {/* */} block was
// rewritten as `//` lines inside JSX. There, `//` is not a comment — it is
// text. Six lines of source commentary about SPORT_PATHWAY_STAGES rendered on
// the Plan page, in the middle of an athlete's pathway.
//
// Every check in this repo passed, before and after: the JSX parses, the scope
// is clean, the i18n keys are intact. Syntax and scope cannot see "this is
// visible garbage". That was a whole class with no coverage, not a slip.
//
// JSXText that begins with // or contains /* is a leaked comment. Real copy
// never starts that way — and if it ever legitimately must, it belongs in the
// dictionaries, not inline.
const leaked = [];
traverse(parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] }), {
  JSXText(p) {
    const raw = p.node.value;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("//") || t.includes("/*") || t.includes("*/")) {
        leaked.push(t.slice(0, 70) + (p.node.loc ? "  (line " + p.node.loc.start.line + ")" : ""));
      }
    }
  },
});
ck("no source comment renders as page text", leaked, []);

// The detector must fire on the real shape, or it is decoration.
const LEAK_FIXTURE = `
  function W() {
    return (
      <div>
        // this is not a comment here, it is text
        <span>ok</span>
      </div>
    );
  }
`;
const fixtureLeaks = [];
traverse(parser.parse(LEAK_FIXTURE, { sourceType: "script", plugins: ["jsx"] }), {
  JSXText(p) {
    for (const line of p.node.value.split("\n")) {
      if (line.trim().startsWith("//")) fixtureLeaks.push(line.trim());
    }
  },
});
ck("...and it fires on a deliberately leaked comment", fixtureLeaks.length, 1);

// ---- the suite must fail on a known-broken input ------------------------
// A detector is only worth its green if the thing it looks for is ABSENT from
// the failure case. The write-error scan written earlier today searched for
// the string "error" near a call — which `catch (e) { console.error(...) }`
// also contains — so the broken pattern counted as evidence of the fix, and it
// reported 4 when the answer was 36. Test the detector against a known break.
const BROKEN = `
  function Widget() {
    const [a, setA] = useState(0);
    return <div onClick={() => setB(1)}>{noteDraft.x}{a}</div>;
  }
`;
const caught = undeclaredIn(BROKEN, "fixture");
ck("the detector fires on a deliberately broken fixture",
   caught.some((s) => s.startsWith("noteDraft ")) && caught.some((s) => s.startsWith("setB ")), true);
// ...and does not fire on the same code once declared, so it is detecting the
// missing binding rather than just the identifier's presence.
const FIXED = `
  function Widget() {
    const [a, setA] = useState(0);
    const [noteDraft, setNoteDraft] = React.useState({});
    const setB = () => {};
    return <div onClick={() => setB(1)}>{noteDraft.x}{a}</div>;
  }
`;
ck("...and is silent once those are declared",
   undeclaredIn(FIXED, "fixture").filter((s) => /^(noteDraft|setB) /.test(s)), []);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
