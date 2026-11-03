// A read that failed must say so and offer Retry; it must never look empty.
//
// THE BUG THIS ENFORCES AGAINST
// supabase-js resolves with { error } instead of throwing. A loader whose catch
// did `setList((l) => l || [])` turned a failed load into the "nothing here
// yet" text, so an athlete with data saw a blank list and assumed it was lost.
//
// WHAT IT CHECKS, per REGISTRY entry { component, loader } (later tasks append):
//   (a) the loader's catch calls a set*Failed(true) / set*LoadFailed(true) setter
//   (b) the catch does not write an empty array anywhere (`[]`, `l || []`)
//   (c) the component renders <LoadError, and every element that uses an
//       *_empty i18n key sits under a `!<failedFlag>` guard
// plus a unit check of must(), evaluated from the source.
// The detector is validated first against a known-broken and a known-good snippet.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const parser = require("@babel/parser");
let traverse = require("@babel/traverse");
traverse = traverse.default || traverse;

const HTML = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const REGISTRY = [
  { component: "Events", loader: "load" },
  { component: "Feed", loader: "loadFeed" },
  { component: "Discover", loader: "loadPlayers" },
];

const m = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(HTML);
if (!m) throw new Error("no text/babel script found — this suite is not reading what it thinks it is");
const start = m.index + m[0].length;
const CODE = HTML.slice(start, HTML.indexOf("</script>", start));
if (CODE.length < 100000) throw new Error(`extracted only ${CODE.length} chars — extraction is wrong`);

const parse = (code) => parser.parse(code, { sourceType: "script", plugins: ["jsx"] });
// "nothing here yet" texts: the *_empty keys plus Feed's and Discover's own names for them
const EMPTY_KEY = /_empty$|^feed_no_posts$|^feed_no_match$|^discover_no_athletes$|^discover_no_match$/;
const FAILED_SETTER = /^set\w*(Load)?Failed$/;

// Returns a list of problems (empty = fine) for one component/loader in an AST.
function audit(ast, component, loader) {
  const problems = [];
  let comp = null;
  traverse(ast, {
    FunctionDeclaration(pa) { if (pa.node.id && pa.node.id.name === component && !comp) comp = pa; },
  });
  if (!comp) return [`component ${component} not found`];

  let load = null;
  comp.traverse({
    FunctionDeclaration(pa) { if (pa.node.id.name === loader && !load) load = pa; },
  });
  if (!load) return [`loader ${loader} not found in ${component}`];

  const catches = [];
  load.traverse({ CatchClause(pa) { catches.push(pa); } });
  if (!catches.length) problems.push("loader has no catch");

  let flag = null;
  for (const c of catches) {
    c.traverse({
      CallExpression(pa) {
        const callee = pa.node.callee, a = pa.node.arguments[0];
        if (callee.type === "Identifier" && FAILED_SETTER.test(callee.name) && a && a.type === "BooleanLiteral" && a.value) {
          // setFooFailed -> state variable fooFailed
          const n = callee.name.slice(3);
          flag = n[0].toLowerCase() + n.slice(1);
        }
      },
      ArrayExpression(pa) { if (pa.node.elements.length === 0) problems.push("catch writes an empty array"); },
    });
  }
  if (!flag) problems.push("catch never calls a set*Failed(true) setter");

  let rendersError = false;
  const guarded = (pa) => {
    // some ancestor (within the component) is `<cond> && ...` or a ternary whose test mentions !flag
    for (let q = pa.parentPath; q && q !== comp; q = q.parentPath) {
      const n = q.node;
      const test = n.type === "LogicalExpression" && n.operator === "&&" ? n.left
        : n.type === "ConditionalExpression" ? n.test : null;
      if (!test) continue;
      let hit = false;
      (function walk(x) {
        if (!x || typeof x.type !== "string") return;
        if (x.type === "UnaryExpression" && x.operator === "!" && x.argument.type === "Identifier" && x.argument.name === flag) hit = true;
        for (const k of Object.keys(x)) {
          const v = x[k];
          if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v);
        }
      })(test);
      if (hit) return true;
    }
    return false;
  };
  comp.traverse({
    JSXOpeningElement(pa) { if (pa.node.name.name === "LoadError") rendersError = true; },
    CallExpression(pa) {
      const a = pa.node.arguments[0];
      if (pa.node.callee.name === "t" && a && a.type === "StringLiteral" && EMPTY_KEY.test(a.value) && flag && !guarded(pa)) {
        problems.push(`"${a.value}" is shown without a !${flag} guard`);
      }
    },
  });
  if (!rendersError) problems.push("component never renders <LoadError");
  return problems;
}

// ---- the detector must see the broken case and pass the good one ----
const SHELL = (catchBody, guard) => `
function C() {
  const [rows, setRows] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  async function load() { try { setRows([1]); } catch (e) { ${catchBody} } }
  return <div>{loadFailed && <LoadError onRetry={load} />}{${guard}rows && <p>{t("x_empty")}</p>}</div>;
}`;
ck("detector flags the old `l || []` catch",
  audit(parse(SHELL("setRows((l) => l || []);", "!loadFailed && ")), "C", "load").length > 0, true);
ck("detector flags an unguarded *_empty",
  audit(parse(SHELL("setLoadFailed(true);", "")), "C", "load").length > 0, true);
ck("detector passes the fixed shape",
  audit(parse(SHELL("setLoadFailed(true);", "!loadFailed && ")), "C", "load"), []);

// ---- the real components ----
const ast = parse(CODE);
for (const { component, loader } of REGISTRY) {
  ck(`${component}.${loader}: failure shown with Retry, never as empty`, audit(ast, component, loader), []);
}

// ---- Feed: a failed blocks read must fail the load, or blocked people's posts would show ----
{
  let viaMust = false, readsBlocks = false;
  traverse(ast, {
    FunctionDeclaration(pa) {
      if (!pa.node.id || pa.node.id.name !== "loadFeed") return;
      pa.traverse({
        StringLiteral(sp) {
          if (sp.node.value !== "blocks") return;
          readsBlocks = true;
          for (let q = sp.parentPath; q && q !== pa; q = q.parentPath) {
            if (q.isCallExpression() && q.node.callee.name === "must") { viaMust = true; break; }
          }
        },
      });
    },
  });
  ck("Feed.loadFeed reads blocks", readsBlocks, true);
  ck("Feed.loadFeed: the blocks read goes through must()", viaMust, true);
}

// ---- must() ----
const src = /function must\(res\) \{[^\n]*\}/.exec(CODE);
if (!src) throw new Error("must() not found in golsz-app.html");
const must = vm.runInNewContext(`(${src[0].replace(/^function must/, "function")})`);
ck("must({data:1}) returns 1", must({ data: 1, error: null }), 1);
ck("must(null) returns null", must(null), null);
let thrown = null;
try { must({ data: null, error: new Error("x") }); } catch (e) { thrown = e.message; }
ck("must({error}) throws that error", thrown, "x");

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
