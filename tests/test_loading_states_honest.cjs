// While a fetch is in flight a screen says "Loading…" (or shows a skeleton); it never shows
// its "nothing here yet" text or content, and the one hardcoded demo profile (PASSPORT) is
// never reachable once a backend exists.
//
// Second "done" rule of the speed-and-honesty brief; the first half (read FAILURES shown,
// never as empty) is tests/test_read_failures_shown.cjs and covers the same screens.
//
// WHAT IT CHECKS, per entry of the two registries below (same screens as that suite):
//   "state"  screens (a null / not-yet-loaded state variable while the fetch runs):
//            the component renders t("loading"), and every empty-state text sits under a
//            guard that reads the state variable (`posts && ...`, `players !== null && ...`,
//            `threadLoaded && ...`), so null can never reach the empty text.
//   "early"  screens (`if (!loaded) return <skeleton>` before the real render): the early
//            return exists in the component body, renders a skeleton or a t("loading")
//            label, and comes before every empty-state text.
//   PASSPORT: every identifier reference sits under a branch whose test mentions `!sb`.
// The detector is first shown to fail against deliberately broken in-memory copies.

const fs = require("fs");
const path = require("path");
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

const STATE = [
  { component: "Feed", v: "posts", empty: ["feed_no_posts", "feed_no_match"] },
  { component: "Discover", v: "players", empty: ["discover_no_athletes", "discover_no_match"] },
  { component: "Messages", v: "conversations", empty: ["messages_empty", "messages_no_match"] },
  { component: "Messages", v: "threadLoaded", empty: ["messages_say_hello_pre"] },
  { component: "Events", v: "myEvents", empty: ["events_empty"] },
  { component: "PostsGrid", v: "posts", empty: ["passport_posts_empty"] },
  { component: "Scout", v: "history", empty: ["scout_no_past"] },
  { component: "Scout", v: "loaded", empty: [], loadingOnly: true }, // the restored chat: "Loading…" until loaded
];
const EARLY = [
  { component: "HomeTab", v: "loaded" },
  { component: "GoalCard", v: "loaded" },
  { component: "Passport", v: "loaded", empty: ["passport_posts_empty"] },
];

function codeOf(html) {
  const m = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(html);
  if (!m) throw new Error("no text/babel script found — this suite is not reading what it thinks it is");
  const s = m.index + m[0].length;
  const code = html.slice(s, html.indexOf("</script>", s));
  if (code.length < 100000) throw new Error(`extracted only ${code.length} chars — extraction is wrong`);
  return code;
}
const parse = (code) => parser.parse(code, { sourceType: "script", plugins: ["jsx"] });

function findComponent(ast, name) {
  let comp = null;
  traverse(ast, { FunctionDeclaration(pa) { if (pa.node.id && pa.node.id.name === name && !comp) comp = pa; } });
  return comp;
}
const isT = (n, key) => n.callee.name === "t" && n.arguments[0] && n.arguments[0].type === "StringLiteral" && (!key || n.arguments[0].value === key);

// problems for a "state" screen
function auditState(code, ast, { component, v, empty, loadingOnly }) {
  const comp = findComponent(ast, component);
  if (!comp) return [`component ${component} not found`];
  const problems = [];
  const guardRe = new RegExp(`(^|[^\\w.])${v}\\s*($|&&|!==\\s*null|!=\\s*null|\\?)`);
  let loading = 0, emptyCount = 0;
  comp.traverse({
    CallExpression(pa) {
      if (isT(pa.node, "loading")) loading++;
      const a = pa.node.arguments[0];
      if (!(isT(pa.node) && empty.includes(a.value))) return;
      emptyCount++;
      let ok = false;
      for (let q = pa.parentPath; q && q !== comp; q = q.parentPath) {
        const n = q.node;
        const test = n.type === "LogicalExpression" && n.operator === "&&" ? n.left
          : n.type === "ConditionalExpression" ? n.test : null;
        if (test && guardRe.test(code.slice(test.start, test.end))) { ok = true; break; }
      }
      if (!ok) problems.push(`"${a.value}" can show while ${v} is still loading`);
    },
  });
  if (!loading) problems.push(`${component} never renders t("loading")`);
  if (!loadingOnly && emptyCount < empty.length) problems.push(`found ${emptyCount} of ${empty.length} empty texts — registry is stale`);
  return problems;
}

// problems for an "early return" screen
function auditEarly(code, ast, { component, v, empty = [] }) {
  const comp = findComponent(ast, component);
  if (!comp) return [`component ${component} not found`];
  const problems = [];
  let early = null;
  comp.traverse({
    IfStatement(pa) {
      const t = pa.node.test;
      if (pa.parentPath.parentPath === comp && t.type === "UnaryExpression" && t.operator === "!" && t.argument.name === v && !early) early = pa.node;
    },
  });
  if (!early) return [`no top-level \`if (!${v}) return\` in ${component}`];
  const src = code.slice(early.consequent.start, early.consequent.end);
  if (!/\breturn\b/.test(src)) problems.push("the early branch does not return");
  if (!/SkeletonCard|aria-busy|t\("loading"\)/.test(src)) problems.push("the early return is not a skeleton or a Loading… label");
  comp.traverse({
    CallExpression(pa) {
      if (isT(pa.node) && empty.includes(pa.node.arguments[0].value) && pa.node.start < early.end) {
        problems.push(`"${pa.node.arguments[0].value}" is rendered before the loading return`);
      }
    },
  });
  return problems;
}

// references to PASSPORT that are not behind `!sb`
function passportLeaks(code, ast) {
  const leaks = [];
  traverse(ast, {
    Identifier(pa) {
      if (pa.node.name !== "PASSPORT" || !pa.isReferencedIdentifier()) return;
      for (let q = pa.parentPath; q; q = q.parentPath) {
        const n = q.node;
        const test = n.type === "IfStatement" || n.type === "ConditionalExpression" ? n.test
          : n.type === "LogicalExpression" ? n.left : null;
        if (test && /!\s*sb\b/.test(code.slice(test.start, test.end))) return;
      }
      leaks.push(pa.node.loc.start.line);
    },
  });
  return leaks;
}

// ---- the detectors must bite on broken copies ----
const CODE = codeOf(HTML);
const mutate = (from, to) => {
  if (CODE.split(from).length !== 2) throw new Error(`mutation anchor not unique in golsz-app.html: ${from}`);
  return CODE.replace(from, to);
};
const check = (code) => ({ ast: parse(code), code });
{
  const broken = check(mutate("{!loadFailed && posts && posts.length === 0 && <div", "{!loadFailed && (posts || []).length === 0 && <div"));
  ck("detector flags an empty text that no longer waits for the data (Feed)",
    auditState(broken.code, broken.ast, STATE[0]).length > 0, true);
  const noLoading = check(mutate("{!loadFailed && myEvents === null && <div style={{ color: C.slate, fontSize: 13, textAlign: \"center\", padding: \"30px 0\" }}>{t(\"loading\")}</div>}", ""));
  ck("detector flags a screen that lost its Loading… text (Events)",
    auditState(noLoading.code, noLoading.ast, STATE[4]).length > 0, true);
  const noGate = check(mutate("{threadLoaded && threadMsgs.length === 0 && (", "{threadMsgs.length === 0 && ("));
  ck("detector flags the thread's hello text shown before load (Messages)",
    auditState(noGate.code, noGate.ast, STATE[3]).length > 0, true);
  const noEarly = check(mutate("if (!loaded) return <div style={{ padding: \"8px 12px 20px\" }}><SkeletonCard height={120} />", "if (false) return <div style={{ padding: \"8px 12px 20px\" }}><SkeletonCard height={120} />"));
  ck("detector flags a lost early skeleton return (Passport)",
    auditEarly(noEarly.code, noEarly.ast, EARLY[2]).length > 0, true);
  const leak = check(mutate("const p = toPassport(profile, athlete, viewingOther ? viewUserId : uid, t, tv);", "const p = profile ? toPassport(profile, athlete, viewingOther ? viewUserId : uid, t, tv) : PASSPORT;"));
  ck("detector flags PASSPORT outside a !sb branch", passportLeaks(leak.code, leak.ast).length, 1);
  const guarded = check(mutate("const p = toPassport(profile, athlete, viewingOther ? viewUserId : uid, t, tv);", "const p = !sb ? PASSPORT : toPassport(profile, athlete, viewingOther ? viewUserId : uid, t, tv);"));
  ck("detector accepts PASSPORT behind !sb", passportLeaks(guarded.code, guarded.ast), []);
}

// ---- the real screens ----
const real = check(CODE);
for (const e of STATE) {
  ck(`${e.component} (${e.v}): says Loading… and keeps the empty text for loaded data`, auditState(real.code, real.ast, e), []);
}
for (const e of EARLY) {
  ck(`${e.component} (${e.v}): shows a loading skeleton before rendering anything`, auditEarly(real.code, real.ast, e), []);
}
ck("PASSPORT is referenced only behind !sb", passportLeaks(real.code, real.ast), []);
ck("the loading key exists in all four languages", (HTML.match(/^\s*loading: "[^"]+…"/gm) || []).length >= 4, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
