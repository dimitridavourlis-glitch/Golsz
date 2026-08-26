// P1-6 / P1-7 / P1-8 / P1-9 — the credibility pass.
//
// Four separate ways the product contradicted itself in front of a user: a
// metric advertised under a name it no longer has, dropdowns that stayed
// English in every language, one-tap actions that failed into a console
// nobody reads, and a knowledge queue with no way to review it.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-115-knowledge-review.sql", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Parse the I18N block once — several checks need per-language key sets.
const I18N_START = APP.indexOf("const I18N = {");
const I18N_END = APP.indexOf("// tv() —", I18N_START);
const I18N_BLOCK = APP.slice(I18N_START, I18N_END);
const LANGS = ["en", "fr", "es", "el"];
const idx = Object.fromEntries(LANGS.map((l) => [l, I18N_BLOCK.indexOf("\n  " + l + ": {")]));
const order = LANGS.slice().sort((a, b) => idx[a] - idx[b]);
const segFor = (l) => {
  const i = order.indexOf(l);
  return I18N_BLOCK.slice(idx[l], i + 1 < order.length ? idx[order[i + 1]] : I18N_BLOCK.length);
};

console.log("-- P1-6: one name for the product metric --");
// The rename to Passport Strength happened on Home only; the signup plan
// cards, the guided-onboarding steps and a sub-score label still advertised
// "GOLSZ Readiness" — a metric an athlete would then never find.
const userFacingReadiness = [];
for (const l of LANGS) {
  const seg = segFor(l);
  for (const m of seg.matchAll(/([a-z_][a-z0-9_]*): "((?:[^"\\]|\\.)*)"/g)) {
    if (/GOLSZ Readiness/.test(m[2])) userFacingReadiness.push(`${l}.${m[1]}`);
  }
}
ck("no user-facing string still says 'GOLSZ Readiness'", userFacingReadiness, []);
ck("Home's composite is Passport Strength", /home_readiness_composite: "PASSPORT STRENGTH"/.test(APP), true);
ck("the Free plan card names Passport Strength", /plan_free_feat4: "Passport Strength score/.test(APP), true);
ck("the guided step names it too", /guided_step_readiness: "Initial Passport Strength/.test(APP), true);
ck("the locked-feature tile names it", /guided_locked_readiness: "Passport Strength"/.test(APP), true);
// The sub-score is a pathway sub-score, not a second "readiness" metric.
ck("the pathway sub-score no longer says READINESS", /home_pathway: "PATHWAY"/.test(APP), true);
// ...but ordinary-language uses of the word are untouched: assessment_ready,
// readinessStatus, READINESS_DIMENSIONS are internal identifiers, not copy.
ck("internal readiness identifiers survive the rename", /READINESS_DIMENSIONS/.test(APP), true);
ck("...and so does the readiness status strip", /const readinessStatus = \[/.test(APP), true);

console.log("\n-- P1-7: option lists are localized without changing stored values --");
ck("a value-label map exists", (APP.match(/VALUE_LABELS: \{/g) || []).length, 4);
ck("translateValue falls back to the English value", /return \(map && map\[value\]\) \|\| value;/.test(APP), true);
// Extract each language's VALUE_LABELS keys and check coverage.
const labelKeys = {};
for (const l of LANGS) {
  const seg = segFor(l);
  const m = seg.match(/VALUE_LABELS: \{([^}]*)\}/);
  labelKeys[l] = m ? [...m[1].matchAll(/"([^"]+)":/g)].map((x) => x[1]) : [];
}
ck("English defines a label for every value", labelKeys.en.length > 45, true);
for (const l of ["fr", "es", "el"]) {
  ck(`${l} covers exactly the same values`, labelKeys[l].sort(), labelKeys.en.slice().sort());
}
// The whole point: the <option value> stays English so the STORED value and
// every lookup keyed on it (SPORT_SCHEMAS, BENCHMARK_METRICS_BY_SPORT, the
// sports table, isPlayer/isParent) keep working.
ck("the sport dropdown translates the label, not the value",
   /<option key=\{s\} value=\{s\}>\{tv\(s\)\}<\/option>/.test(APP), true);
ck("the occupation dropdown does the same",
   /<option key=\{o\} value=\{o\}>\{tv\(o\)\}<\/option>/.test(APP), true);
ck("no dropdown sets a translated value", /value=\{tv\(/.test(APP), false);
for (const l of ["fr", "es", "el"]) {
  const seg = segFor(l);
  const m = seg.match(/VALUE_LABELS: \{([^}]*)\}/)[1];
  // Soccer is the one that matters most — it keys SPORT_SCHEMAS.
  ck(`${l} actually translates Soccer rather than copying it`,
     /"Soccer": "(Football|Fútbol|Ποδόσφαιρο)"/.test(m), true);
}
// Free-text datalists are deliberately NOT translated; the typed value is
// stored and matched against the schema's English position labels.
ck("country/position datalists stay English, with the reason recorded",
   /Deliberately NOT applied to COUNTRIES or the position datalists/.test(APP), true);
ck("...and the position datalist really is untranslated",
   /<datalist id="position-options">\{\(SPORT_POSITIONS\[form\.sport\] \|\| POSITIONS\.filter\(\(p\) => p !== "All"\)\)\.map\(\(p\) => <option key=\{p\} value=\{p\} \/>\)\}/.test(APP), true);
ck("the athlete reads their sport back translated on Home",
   /\{\[tv\(athlete\.sport\), athlete\.position\]/.test(APP), true);
ck("...and on the Passport", (APP.match(/<PassRow k=\{t\("passport_sport"\)\} v=\{tv\(p\.sport\)\} \/>/g) || []).length, 2);

console.log("\n-- P1-8: no athlete-facing action fails into the console --");
for (const fn of ["add suggested targets", "add suggested dev items", "add suggested pathway", "save drafted email"]) {
  // Each catch must do more than log: it must set actionError on the message.
  const i = APP.indexOf(`console.error("GOLSZ ${fn} error:", e);`);
  ck(`"${fn}" surfaces its failure to the athlete`,
     i > -1 && /setMsgs\(\(m\) => m\.map\(\(msg, i\) => \(i === msgIndex \? \{ \.\.\.msg, actionError: t\("action_add_failed"\) \}/.test(APP.slice(i, i + 400)), true);
}
ck("the error renders on the message it belongs to",
   /\{m\.actionError && <div style=\{\{ marginTop: 8, fontSize: 11\.5, color: C\.amber \}\}>\{m\.actionError\}<\/div>\}/.test(APP), true);
ck("a later success clears a previous failure", (APP.match(/actionError: null \} : msg\)\)\);/g) || []).length, 4);
ck("the copy states nothing was saved", /nothing was saved/.test(APP), true);
for (const l of LANGS) ck(`${l} defines action_add_failed`, segFor(l).includes("action_add_failed:"), true);

console.log("\n-- P1-9: discovered knowledge can finally be reviewed --");
ck("a listing RPC exists", /create or replace function admin_list_knowledge_candidates/.test(MIG), true);
ck("...gated on is_admin() inside the function body",
   /admin_list_knowledge_candidates[\s\S]{0,600}if not is_admin\(\) then\s*\n\s*raise exception 'not authorized'/.test(MIG), true);
ck("...and it only returns unreviewed rows", /where k\.verification_status in \('discovered', 'candidate'\)/.test(MIG), true);
ck("a review RPC exists", /create or replace function admin_review_knowledge/.test(MIG), true);
ck("...also gated on is_admin()",
   /admin_review_knowledge[\s\S]{0,600}if not is_admin\(\) then\s*\n\s*raise exception 'not authorized'/.test(MIG), true);
ck("approve promotes to 'verified'", /when p_approve then 'verified' else 'rejected' end/.test(MIG), true);
ck("rejected rows are kept, not deleted", /delete from golsz_knowledge/.test(MIG), false);
ck("every decision is written to the admin audit log", /insert into admin_action_log/.test(MIG), true);
ck("neither RPC is executable by anon", /revoke execute on function admin_list_knowledge_candidates\(int\) from public, anon/.test(MIG), true);
ck("...nor the review one", /revoke execute on function admin_review_knowledge\(uuid, boolean, text\) from public, anon/.test(MIG), true);
// Nothing may promote itself.
ck("the migration contains no automatic promotion", /set verification_status = 'verified'\s+where/.test(MIG), false);

// Knowledge review moved from a Safety sub-tab to Health > Advanced in the
// admin-panel trim: it is a content chore, not a safety queue. The assertion
// pinned its LOCATION, which is why it broke while the capability was intact.
// What matters is that an admin can still review candidates.
ck("knowledge candidates are still reviewable", /reviewKnowledge\(/.test(APP), true);
ck("...and the section is still rendered, with a heading",
   /sectionHead\(t\("admin_view_knowledge"\)\)/.test(APP), true);
ck("...from inside the Advanced collapse, not a top-level tab",
   /\["knowledge", t\("admin_view_knowledge"\)\]/.test(APP), false);
ck("it loads through the RPC, not a direct select",
   /sb\.rpc\("admin_list_knowledge_candidates", \{ p_limit: 50 \}\)/.test(APP), true);
ck("...because the read policy would return nothing otherwise",
   /migration 096's read policy exposes only/.test(APP), true);
ck("it is loaded on admin mount", /loadAppeals\(\); loadKnowledge\(\);/.test(APP), true);
ck("the source URL is shown for inspection", /admin_knowledge_source"\)\}: \{k\.source_url/.test(APP), true);
ck("a candidate with NO source cannot be approved", /disabled=\{!k\.source_url\}/.test(APP), true);
ck("both approve and reject are wired", /reviewKnowledge\(k\.id, true\)/.test(APP) && /reviewKnowledge\(k\.id, false\)/.test(APP), true);
for (const l of LANGS) {
  const seg = segFor(l);
  const keys = ["admin_view_knowledge", "admin_no_knowledge", "admin_knowledge_source",
    "admin_knowledge_approve", "admin_knowledge_reject", "admin_knowledge_no_source"];
  ck(`${l} defines every knowledge-review key`, keys.filter((k) => !seg.includes(k + ":")), []);
}

console.log("\n-- overall i18n parity still holds --");
const keySets = {};
for (const l of LANGS) {
  const seg = segFor(l);
  const set = new Set();
  for (const m of seg.matchAll(/(?:^|[{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)) set.add(m[1]);
  keySets[l] = set;
}
for (const l of ["fr", "es", "el"]) {
  ck(`${l} is missing no English key`, [...keySets.en].filter((k) => !keySets[l].has(k)), []);
  ck(`${l} has no key English lacks`, [...keySets[l]].filter((k) => !keySets.en.has(k)), []);
}

// --- Scout renders as raw text, so the prompt must not ask for markdown ---
//
// golsz-app.html renders a Scout reply inside a plain <div> with
// whiteSpace:"pre-wrap" and no markdown parser. Any "- " bullet, "**bold**"
// or "#" header the model emits therefore reaches the athlete as literal
// punctuation on screen. The prompt used to say "keep headers, bold and
// bullet lists for..." — actively asking for output the client cannot
// render. These lock the fix in place.
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const PROMPT = SCOUT.slice(SCOUT.indexOf("const SYSTEM_PROMPT = `"), SCOUT.indexOf("const SPECIALIST_FRAMING"));

ck("Scout replies still render with no markdown parser",
   /m\.text && <div style=\{\{ whiteSpace: "pre-wrap" \}\}>\{m\.text\}<\/div>/.test(APP), true);
ck("the prompt no longer asks for headers/bold/bullet lists",
   /Keep headers, bold and bullet lists/.test(PROMPT), false);
ck("the prompt states plain text only", /No markdown formatting/.test(PROMPT), true);
ck("...and forbids leading dash/asterisk bullets",
   /No asterisks or hyphens at the start of lines/.test(PROMPT), true);
ck("...and forbids the dash as punctuation",
   /No dashes, use commas, periods, colons/.test(PROMPT), true);

// The rule is only credible if the prompt's own worked examples obey it: a
// quoted model reply containing an em dash teaches the opposite of the rule
// no matter what the rule above says. A generic "no em dash between quotes"
// scan can't be used here — the prompt is full of quoted fragments, so such
// a regex matches ordinary instruction prose sitting BETWEEN two quotes and
// reports it as an example. These name the four worked replies instead.
// The 2026-08-11 prompt rewrite kept two of the four worked replies and
// dropped two. Only the ILLUSTRATIONS went; the rules they illustrated are
// both still stated in prose:
//   * the physio boundary -> "name the right professional (physician, physio,
//     registered dietitian) in one natural sentence and move on"
//   * the goal-changed question -> "if they disagree with what the Pathway
//     shows, that's a real conflict to surface and resolve with them"
// Asserting on examples that no longer exist would be testing a ghost, so
// they are removed here rather than kept as permanent failures. The two that
// survive still carry the point of this block: a worked reply containing a
// dash teaches the opposite of the no-dash rule above it.
for (const [label, ex] of [
  ["the sore-knee warmth example", "Two weeks of pain and still sore, that's worth getting checked out"],
  ["the Pathway upgrade pitch", "dated steps instead of us deciding it every conversation"],
]) {
  ck(`${label} is present and dash-free`, PROMPT.includes(ex), true);
}

console.log("\n-- currency is choosable BEFORE the choice becomes permanent --");
// A Stripe subscription is locked to the currency it was created in. Settings
// requires a login, so for a while the only screen where the decision is
// irreversible — signup — was the only screen with no control on it. Geo is a
// guess: a VPN, a trip, a student abroad, an expat. They must be able to
// correct it before they pay, not after.
{
  ck("the currency switcher renders in two places, not one",
     (APP.match(/onClick=\{\(\) => setCurrency\(cur\)\}/g) || []).length, 2);
  // One of them must be inside Auth, i.e. after the component starts.
  const authAt = APP.indexOf("function Auth({ onDone, paidReturn })");
  ck("Auth was found", authAt > 0, true);
  ck("...and one switcher lives inside it",
     APP.indexOf("setCurrency(cur)", authAt) > authAt, true);
  // Structural, not proximity. The first version used a 900-character window
  // between `{isSignup && (` and the switcher and failed on the plan grid in
  // between — a window is a guess about formatting, not a property. This asks
  // the real question: is the switcher inside that conditional's subtree?
  {
    const parser = require("@babel/parser");
    const mm = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
    const CODE = APP.slice(mm.index + mm[0].length, APP.indexOf("</script>", mm.index));
    const ast = parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] });
    let gated = 0;
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "LogicalExpression" && n.operator === "&&" &&
          n.left.type === "Identifier" && n.left.name === "isSignup" &&
          CODE.slice(n.start, n.end).includes("setCurrency(cur)")) gated++;
      for (const k of Object.keys(n)) if (k !== "loc" && k !== "start" && k !== "end") walk(n[k]);
    })(ast.program.body);
    ck("...gated to the signup branch, not shown when logging in", gated >= 1, true);
  }
  ck("Auth can actually set it", /const \{ t, currency, setCurrency \} = useLang\(\);/.test(APP), true);
  // Both switchers are real tap targets. The signup one especially: it is on
  // a phone, on the critical path, next to the money.
  ck("every currency button clears 44px",
     (APP.match(/minHeight: 44, minWidth: 52, padding: "6px 10px"/g) || []).length, 2);
  // Screen readers need to know which one is active — colour alone does not
  // survive being read aloud.
  // BOTH switchers, not just one. This was added to signup and missed on
  // Settings, so that copy conveyed its active state by colour alone — which
  // a screen reader cannot read. Counting is what caught it; asserting mere
  // presence would have passed on the one that had it.
  ck("both switchers expose the active currency to assistive tech",
     (APP.match(/aria-pressed=\{currency === cur\}/g) || []).length, 2);
  ck("...and both are labelled, not just coloured",
     (APP.match(/aria-label=\{t\("settings_currency"\) \+ " " \+ cur\.toUpperCase\(\)\}/g) || []).length, 2);
  // type="button" so neither can submit the signup form by accident.
  ck("neither currency button can submit a form",
     (APP.match(/<button key=\{cur\} type="button" onClick=\{\(\) => setCurrency\(cur\)\}/g) || []).length, 2);
}

console.log("\n-- the first thing a new athlete taps, on a phone --");
// MEASURED 2026-08-24 in a 390x844 mobile viewport against production: every
// control in the signed-out flow met the 44px minimum EXCEPT the two that
// matter most. Full name, Email, Password, DD/MM/YYYY and "Create free
// account" were all exactly 44. The Sign up / Log in segmented tabs were 36 —
// 10px padding around a 14px line — and they are the first thing a new
// athlete touches.
//
// Asserted at the source rather than by measuring a browser, because these
// suites do not run one. That means this checks the STYLE, not the rendered
// box: it catches the padding being lowered again, not a parent transform
// squashing the button. Worth stating, since a check that looks like it
// verifies the rendered size and does not is the kind this repo keeps finding.
{
  const tabs = APP.slice(APP.indexOf('{[["signup", t("auth_signup")], ["login", t("auth_login")]]'));
  const btn = tabs.slice(0, tabs.indexOf("))}"));
  ck("the auth mode tabs were found", btn.includes("setMode(m)"), true);
  ck("...and carry an explicit 44px minimum", /minHeight: 44/.test(btn), true);
}
// The submit and the fields already met it; pin them so they cannot drift.
for (const label of ["auth_create_free", "auth_full_name", "auth_email", "auth_password"]) {
  ck(`${label} still exists as a labelled control`, (APP.match(new RegExp(label, "g")) || []).length >= 4, true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
