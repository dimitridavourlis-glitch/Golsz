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
//       *_empty i18n key sits under a `!<failedFlag>` guard (an entry may scope
//       this to its own `emptyKeys` when one component has two loaders)
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
  { component: "Messages", loader: "loadConversations" },
  { component: "Messages", loader: "loadThread", emptyKeys: [] }, // the empty text belongs to the list loader,
  { component: "Passport", loader: "load" },
  { component: "PostsGrid", loader: "load" },
  { component: "HomeTab", loader: "reload" },
  { component: "GoalCard", loader: "load" },
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
function audit(ast, component, loader, emptyKeys) {
  const problems = [];
  let comp = null;
  traverse(ast, {
    FunctionDeclaration(pa) { if (pa.node.id && pa.node.id.name === component && !comp) comp = pa; },
  });
  if (!comp) return [`component ${component} not found`];

  let load = null;
  comp.traverse({
    FunctionDeclaration(pa) { if (pa.node.id.name === loader && !load) load = pa; },
    // `const reload = React.useCallback(async () => {...})`
    VariableDeclarator(pa) { if (pa.node.id.name === loader && !load) load = pa; },
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
      if (pa.node.callee.name === "t" && a && a.type === "StringLiteral" && EMPTY_KEY.test(a.value) && (!emptyKeys || emptyKeys.includes(a.value)) && flag && !guarded(pa)) {
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
for (const { component, loader, emptyKeys } of REGISTRY) {
  ck(`${component}.${loader}: failure shown with Retry, never as empty`, audit(ast, component, loader, emptyKeys), []);
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

// ---- Messages: with the thread load failed, the composer and the Accept/Decline
// banner must not render (the request status is unknown), and both reads go through must() ----
{
  let composer = false, composerGuarded = false, acceptBtn = false, acceptGuarded = false;
  const underNotFailed = (pa) => {
    for (let q = pa.parentPath; q; q = q.parentPath) {
      const n = q.node;
      if (n.type === "LogicalExpression" && n.operator === "&&" && n.left.type === "UnaryExpression"
        && n.left.operator === "!" && n.left.argument.name === "threadFailed") return true;
    }
    return false;
  };
  traverse(ast, {
    FunctionDeclaration(pa) {
      if (!pa.node.id || pa.node.id.name !== "Messages") return;
      pa.traverse({
        JSXOpeningElement(jp) {
          if (jp.node.name.name === "input" && jp.node.attributes.some((a) => a.name && a.name.name === "onKeyDown")) {
            composer = true; composerGuarded = underNotFailed(jp);
          }
        },
        CallExpression(cp) {
          const a = cp.node.arguments[0];
          // the first messages_accept in source order is the thread banner (the list's buttons come after)
          if (cp.node.callee.name === "t" && a && a.value === "messages_accept" && !acceptBtn) {
            acceptBtn = true; acceptGuarded = underNotFailed(cp);
          }
        },
      });
    },
  });
  ck("Messages thread composer exists", composer, true);
  ck("Messages thread composer is guarded by !threadFailed", composerGuarded, true);
  ck("Messages thread Accept/Decline banner exists", acceptBtn, true);
  ck("Messages thread Accept/Decline banner is guarded by !threadFailed", acceptGuarded, true);
  const mustCount = (name) => {
    let n = 0;
    traverse(ast, {
      FunctionDeclaration(pa) {
        if (!pa.node.id || pa.node.id.name !== name) return;
        pa.traverse({ CallExpression(cp) { if (cp.node.callee.name === "must") n++; } });
      },
    });
    return n;
  };
  ck("Messages.loadConversations: both reads go through must()", mustCount("loadConversations") >= 2, true);
  ck("Messages.loadThread: both reads go through must()", mustCount("loadThread") >= 2, true);
}

// ---- Passport: a failed load must not seed ProfileEditor with blanks, and must not
// consume autoEdit (onboarding has to open after a successful Retry) ----
{
  let editorAt = -1, failReturnAt = -1, failReturn = null, loadNode = null;
  const mustCalls = [], consumed = [];
  traverse(ast, {
    FunctionDeclaration(pa) {
      if (!pa.node.id || pa.node.id.name !== "Passport") return;
      pa.traverse({
        FunctionDeclaration(lp) { if (lp.node.id.name === "load" && lp.parentPath.parentPath === pa) loadNode = lp; },
        JSXOpeningElement(jp) { if (jp.node.name.name === "ProfileEditor") editorAt = jp.node.start; },
        IfStatement(ip) {
          const t = ip.node.test;
          // top-level `if (loadFailed) return ...` in the component body
          if (ip.parentPath.parentPath === pa && t.type === "Identifier" && t.name === "loadFailed") { failReturnAt = ip.node.start; failReturn = ip; }
        },
      });
    },
  });
  ck("Passport has ProfileEditor", editorAt > 0, true);
  ck("Passport: ProfileEditor is only reachable past the `if (loadFailed) return` guard", failReturnAt > 0 && failReturnAt < editorAt, true);
  // The failed state replaces the body, not the header: a viewed Passport
  // (from a thread, Feed or Discover) must keep its Back button.
  let failBack = false;
  if (failReturn) failReturn.traverse({
    LogicalExpression(lp) {
      const { left, right } = lp.node;
      if (lp.node.operator !== "&&" || left.type !== "Identifier" || left.name !== "viewingOther") return;
      if (right.type !== "JSXElement" || right.openingElement.name.name !== "button") return;
      failBack = right.openingElement.attributes.some((a) => a.name && a.name.name === "onClick" &&
        a.value.expression && a.value.expression.type === "Identifier" && a.value.expression.name === "onBack");
    },
  });
  ck("Passport: the loadFailed return keeps the onBack button when viewingOther", failBack, true);
  ck("Passport.load found", !!loadNode, true);
  if (loadNode) {
    loadNode.traverse({
      CallExpression(cp) {
        const c = cp.node.callee;
        if (c.type === "Identifier" && c.name === "onAutoEditConsumed") consumed.push(cp);
        if (c.type === "MemberExpression" && c.property.name === "map" && cp.node.arguments[0] && cp.node.arguments[0].name === "must") mustCalls.push(cp);
      },
      LogicalExpression(lp) { if (lp.node.right.type === "CallExpression" && lp.node.right.callee.name === "onAutoEditConsumed") consumed.push(lp); },
    });
    const inCatch = (pa) => !!pa.findParent((q) => q.isCatchClause());
    ck("Passport.load: onAutoEditConsumed is called", consumed.length > 0, true);
    ck("Passport.load: onAutoEditConsumed is never in a catch", consumed.some(inCatch), false);
    const lastMust = Math.max(...mustCalls.map((c) => c.node.end));
    ck("Passport.load: onAutoEditConsumed comes after the must() reads", consumed.every((c) => c.node.start > lastMust), true);
    // the profiles/public_profile_names and athletes reads each sit inside a Promise.all(...).map(must)
    for (const table of ["profiles", "public_profile_names", "athletes"]) {
      let viaMust = false;
      loadNode.traverse({
        StringLiteral(sp) {
          if (sp.node.value !== table || !sp.parentPath.isCallExpression() || sp.parent.callee.property.name !== "from") return;
          viaMust = viaMust || !!sp.findParent((q) => q.isCallExpression() && q.node.callee.type === "MemberExpression"
            && q.node.callee.property.name === "map" && q.node.arguments[0] && q.node.arguments[0].name === "must");
        },
      });
      ck(`Passport.load: the ${table} read goes through must()`, viaMust, true);
    }
    // Clearing loadFailed while `loaded` stays true renders a blank '—' Passport and
    // lets onProfileStatus report "incomplete", locking every tab (mustFinishProfile).
    const clears = [];
    loadNode.traverse({
      CallExpression(cp) {
        const a = cp.node.arguments[0];
        if (cp.node.callee.name === "setLoadFailed" && a && a.type === "BooleanLiteral" && !a.value) clears.push(cp);
      },
    });
    // each clear must follow a must() read in its own branch (the own and viewed-other branches each have one)
    const afterOwnReads = (cp) => {
      const block = cp.findParent((q) => q.isBlockStatement());
      return mustCalls.some((m) => m.node.end < cp.node.start && m.node.start > block.node.start && m.node.end < block.node.end);
    };
    ck("Passport.load clears loadFailed", clears.length > 0, true);
    ck("Passport.load: loadFailed is cleared only after the must() reads", clears.every(afterOwnReads), true);
  }
  // Retry must go back to the skeleton (loaded = false), not straight into load().
  const retryOf = (component) => {
    let handler = null, body = null;
    traverse(ast, {
      FunctionDeclaration(pa) {
        if (!pa.node.id || pa.node.id.name !== component) return;
        pa.traverse({
          JSXOpeningElement(jp) {
            if (jp.node.name.name !== "LoadError") return;
            const a = jp.node.attributes.find((x) => x.name && x.name.name === "onRetry");
            handler = a && a.value.expression.name;
          },
        });
        pa.traverse({ FunctionDeclaration(fp) { if (handler && fp.node.id.name === handler) body = CODE.slice(fp.node.body.start, fp.node.body.end); } });
      },
    });
    return { handler, body: body || "" };
  };
  const pr = retryOf("Passport");
  ck("Passport: Retry is not a bare load()", pr.handler !== "load" && !!pr.handler, true);
  ck("Passport: Retry shows the skeleton (setLoaded(false)) before load()", /setLoaded\(false\);[\s\S]*load\(\)/.test(pr.body), true);
  const gr = retryOf("PostsGrid");
  ck("PostsGrid: Retry resets posts to null (loading, not the empty text) before load()", /setPosts\(null\);[\s\S]*load\(\)/.test(gr.body), true);
}

// ---- GoalCard: the edit button is hidden while the goal could not be read ----
{
  let guardedButtons = 0, buttons = 0;
  traverse(ast, {
    FunctionDeclaration(pa) {
      if (!pa.node.id || pa.node.id.name !== "GoalCard") return;
      pa.traverse({
        JSXOpeningElement(jp) {
          const a = jp.node.attributes.find((x) => x.name && x.name.name === "onClick");
          if (jp.node.name.name !== "button" || !a || !a.value.expression || a.value.expression.name !== "startEdit") return;
          buttons++;
          for (let q = jp.parentPath; q && q !== pa; q = q.parentPath) {
            const n = q.node;
            if (n.type === "LogicalExpression" && n.operator === "&&" && CODE.slice(n.left.start, n.left.end).includes("!loadFailed")) { guardedButtons++; break; }
            if (n.type === "ConditionalExpression" && CODE.slice(n.test.start, n.test.end).includes("!loadFailed")) { guardedButtons++; break; }
          }
        },
      });
    },
  });
  ck("GoalCard has edit buttons", buttons >= 2, true);
  ck("GoalCard: every edit button is guarded by !loadFailed", guardedButtons, buttons);
}

// ---- HomeTab: homeReadFailures + what the loader does with it ----
{
  const m = /function homeReadFailures\([\s\S]*?\n\}\n/.exec(CODE);
  if (!m) throw new Error("homeReadFailures() not found in golsz-app.html");
  const core = /const HOME_CORE_READS = (\[[^\]]*\]);/.exec(CODE);
  if (!core) throw new Error("HOME_CORE_READS not found in golsz-app.html");
  const ctx = vm.runInNewContext(`(function(){ ${m[0]}; return { homeReadFailures, core: ${core[1]} }; })()`);
  const ok = { data: [], error: null }, bad = { data: null, error: { message: "x" } };
  const all = (over) => Object.assign({ profiles: ok, athletes: ok, pathway: ok, shares: ok, ticks: ok, benchmarks: ok }, over);
  const r1 = ctx.homeReadFailures(all({ pathway: bad }), ctx.core);
  ck("homeReadFailures: pathway error is core", r1.core, true);
  ck("homeReadFailures: pathway error is listed", [...r1.failed], ["pathway"]);
  const r2 = ctx.homeReadFailures(all({ shares: bad }), ctx.core);
  ck("homeReadFailures: share tokens error is not core", r2.core, false);
  ck("homeReadFailures: share tokens error is listed", [...r2.failed], ["shares"]);
  ck("homeReadFailures: profiles and athletes are core", ["profiles", "athletes"].every((k) => ctx.homeReadFailures(all({ [k]: bad }), ctx.core).core), true);
  const r3 = ctx.homeReadFailures(all({}), ctx.core);
  ck("homeReadFailures: no errors, nothing failed", [r3.core, r3.failed.size], [false, 0]);
  ck("homeReadFailures: a null result is not an error", ctx.homeReadFailures(all({ ticks: null }), ctx.core).failed.size, 0);
  // the snapshot of the day is insert-only: it must not be written from a partial read
  const reload = /const reload = React\.useCallback[\s\S]*?\}, \[actingFor\]\);/.exec(CODE);
  ck("HomeTab.reload skips the daily snapshot when a read failed", /if \(!failed\.size\) \{\s*const snapScores/.test(reload ? reload[0] : ""), true);
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
