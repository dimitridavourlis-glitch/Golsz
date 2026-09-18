// No hook is called after an early return.
//
// THE FAILURE THIS CLOSES
// 2026-09-18: the Home rebuild added `const [stepBusy] = useState(false)` and
// `const [stepErr] = useState("")` beside the next-step card that uses them —
// roughly 120 lines BELOW Home's `if (!loaded) return <skeleton/>`. The first
// render is always the loading one, so it ran 40 hooks; the render after the
// fetch landed ran 42. React throws #310, the error boundary caught it, and
// every signed-in athlete saw "Something went wrong."
//
// All 71 suites were green. test_client_scope proves every identifier is
// DECLARED — `stepBusy` was declared, and declared before its use. Nothing in
// the suite knew that WHERE a declaration sits is load-bearing when the
// declaration is a hook. A signed-out visitor never reaches the second render,
// so the landing page and the whole logged-out flow looked perfect.
//
// THE RULE
// React identifies a hook by call order, so every hook in a component must run
// on every render. A component that returns a skeleton while data is in flight
// has an early return, and any hook below it is called on the loaded render
// only. Hooks nested inside callbacks (a useCallback body, an event handler,
// a child component defined inline) belong to that function, not this one, and
// are skipped.

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

const OPEN = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/;
const m = OPEN.exec(HTML);
if (!m) throw new Error("no text/babel script found — this suite is not reading what it thinks it is");
const start = m.index + m[0].length;
const end = HTML.indexOf("</script>", start);
if (end < 0) throw new Error("unterminated <script>");
const CODE = HTML.slice(start, end);
if (CODE.length < 100000) throw new Error(`extracted only ${CODE.length} chars — extraction is wrong`);

// The line number the athlete's stack trace would blame, in golsz-app.html's
// own numbering — not an offset into a stripped script nobody can open.
const LINE0 = HTML.slice(0, start).split("\n").length - 1;

const ast = parser.parse(CODE, {
  sourceType: "script",
  plugins: ["jsx"],
  errorRecovery: false,
});

const HOOK = /^use[A-Z]/;
const isHookCall = (node) => {
  if (node.type !== "CallExpression") return false;
  const c = node.callee;
  if (c.type === "Identifier") return HOOK.test(c.name);
  // React.useState(...) — the form Home uses for useCallback.
  if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
    return HOOK.test(c.property.name);
  }
  return false;
};

// A component is a top-level function whose name starts with a capital. That
// is the same shape test_client_scope walks, and it is how every screen in
// this file is written.
const components = [];
traverse(ast, {
  FunctionDeclaration(pathNode) {
    if (pathNode.parent.type !== "Program") return;
    const name = pathNode.node.id && pathNode.node.id.name;
    if (!name || !/^[A-Z]/.test(name)) return;
    components.push({ name, node: pathNode.node });
  },
});

ck("components found", components.length > 40, true);

// Walk one component body.
//
// NOT EVERY EARLY RETURN IS DANGEROUS, and a gate that cannot tell the
// difference is a gate nobody keeps. Root returns early on `?share=` before
// declaring any state:
//
//   const shareToken = new URLSearchParams(window.location.search).get("share");
//   if (shareToken) return <PublicPassport token={shareToken} />;
//
// That is read from the URL, so it is fixed for the life of the mount: Root
// either always returns early or never does, and the hook count never changes
// between two renders of the same mount. React's own lint rule objects, but no
// athlete can reach the crash.
//
// What broke Home was different in the one way that matters: the return was
// gated on `loaded`, which is STATE. False on the first render, true on the
// next, so one mount rendered both branches and the hook count changed under
// React. So this flags a hook below an early return whose condition reads a
// value this component holds in a hook — the only shape that can vary
// render-to-render.
const violations = [];

const NESTED = new Set([
  "FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration",
  "ObjectMethod", "ClassMethod",
]);

// Walk a node's own subtree, never entering a nested function: hooks and
// returns inside `async function togglePrivacy()` belong to it, not to the
// component around it.
function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const v = node[key];
    const kids = Array.isArray(v) ? v : [v];
    for (const kid of kids) {
      if (!kid || typeof kid.type !== "string") continue;
      if (NESTED.has(kid.type)) continue;
      walk(kid, fn);
    }
  }
}

function scan(comp) {
  const body = comp.node.body.body || [];

  // Everything this component holds in a hook. `const [loaded, setLoaded] =
  // useState(...)` contributes both names; `const x = useMemo(...)` contributes x.
  const stateful = new Set();
  for (const stmt of body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
      if (!d.init || !isHookCall(d.init)) continue;
      if (d.id.type === "Identifier") stateful.add(d.id.name);
      else if (d.id.type === "ArrayPattern") {
        for (const el of d.id.elements) if (el && el.type === "Identifier") stateful.add(el.name);
      }
    }
  }

  let gate = null; // the state-dependent early return, once one is seen

  for (const stmt of body) {
    if (NESTED.has(stmt.type)) continue;

    if (gate) {
      walk(stmt, (n) => {
        if (!isHookCall(n)) return;
        violations.push({
          component: comp.name,
          hook: n.callee.name || n.callee.property.name,
          hookLine: LINE0 + n.loc.start.line,
          returnLine: LINE0 + gate.line,
          on: gate.on,
        });
      });
      continue;
    }

    if (stmt === body[body.length - 1]) continue; // the component's real return

    // Does this statement return, and is it gated on something stateful?
    let ret = null;
    walk(stmt, (n) => { if (n.type === "ReturnStatement" && !ret) ret = n; });
    if (!ret) continue;

    const reads = new Set();
    if (stmt.type === "IfStatement") walk(stmt.test, (n) => { if (n.type === "Identifier") reads.add(n.name); });
    else walk(stmt, (n) => { if (n.type === "Identifier") reads.add(n.name); });

    const on = [...reads].filter((r) => stateful.has(r));
    if (on.length) gate = { line: ret.loc.start.line, on };
  }
}

for (const comp of components) scan(comp);

if (violations.length) {
  for (const v of violations) {
    console.log(
      `\n  ${v.component} calls ${v.hook}() at golsz-app.html:${v.hookLine},\n` +
      `  but returns early at golsz-app.html:${v.returnLine} on ${v.on.join(", ")} — which is state.\n` +
      `  The render before the data lands skips it, the render after runs it,\n` +
      `  and React throws #310 into the error boundary. Move the hook above\n` +
      `  the early return, beside the component's other state.\n`
    );
  }
}

ck("no hook is called after an early return", violations.map((v) => `${v.component}.${v.hook}`), []);

// The regression itself, nailed down by name. Home is the screen every
// signed-in athlete loads first, so its hook block is the one that matters.
const home = components.find((c) => c.name === "HomeTab");
ck("HomeTab found", !!home, true);
if (home) {
  const src = CODE.split("\n");
  const from = home.node.loc.start.line, to = home.node.loc.end.line;
  const region = src.slice(from - 1, to);
  const skeletonAt = region.findIndex((l) => /^  if \(!loaded\)/.test(l));
  ck("HomeTab still returns a skeleton while loading", skeletonAt >= 0, true);
  const lateHook = region.findIndex((l, i) => i > skeletonAt && /^  (const|let).*\buse(State|Effect|Memo|Callback|Ref)\s*\(/.test(l));
  ck("HomeTab declares no state below that skeleton", lateHook, -1);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
