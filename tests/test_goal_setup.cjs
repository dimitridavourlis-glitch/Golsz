// THE GOAL STEP AFTER THE PASSPORT, RUN FROM THE SOURCE.
//
// A first visit has to end with a dated plan. GoalSetup asks for the goal right
// after the onboarding Passport save and writes starterPathwaySteps() to
// pathway_plan; Home offers the same step to anyone with a sport and no steps.
//
// Nothing here is a copy. Every top-level declaration in golsz-app.html's JSX
// block is compiled on demand (the way tools/precompile.cjs compiles it) and
// run inside one scope, so GoalSetup, GolszApp and HomeTab call the app's own
// helpers. Only the browser is stood in for: React's hooks (state re-renders at
// once, mount effects run after the first render), Supabase (a stub `sb` that
// records every write) and the clock (pinned to local noon on 2026-11-09).
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const babel = require("@babel/standalone");

const APP = require("./_app_source.cjs").appSource();
let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const open = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
const CODE = APP.slice(open.index + open[0].length, APP.indexOf("</script>", open.index));
if (CODE.length < 100000) throw new Error(`extracted only ${CODE.length} chars: extraction is wrong`);

// name -> the top-level statement that declares it
const DECLS = new Map();
for (const st of parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] }).program.body) {
  if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) DECLS.set(st.id.name, st);
  if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id.type === "Identifier") DECLS.set(d.id.name, st);
}
const goalSetupSrcOf = () => { const st = DECLS.get("GoalSetup"); return CODE.slice(st.start, st.end); };

// ---- the stand-ins ------------------------------------------------------
const TODAY = "2026-11-09";   // a Monday
const RealDate = Date;
const NOON = new RealDate(2026, 10, 9, 12, 0, 0).getTime();
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOON); }
  static now() { return NOON; }
}
let CURRENT = null;   // the hook runtime of the component rendering right now
const hook = (k) => (...a) => CURRENT[k](...a);
const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const React = {
  createElement, Fragment: "Fragment", Component: class {},
  createContext: (v) => ({ v }),
  useState: hook("useState"), useRef: hook("useRef"), useEffect: hook("useEffect"),
  useCallback: hook("useCallback"), useMemo: hook("useMemo"), useContext: hook("useContext"),
};
const tKey = (k) => k;   // the alert and field checks read keys, not English
const quiet = { log() {}, warn() {}, error() {}, info() {} };

// One scope per scenario, so a stub sb or a stubbed name never leaks between them.
function makeScope(overrides) {
  const cache = new Map(Object.entries(overrides));
  const stubbed = new Set();
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === "string" && (cache.has(k) || DECLS.has(k) || !(k in globalThis)),
    get: (_, k) => {
      if (typeof k !== "string") return undefined;
      if (cache.has(k)) return cache.get(k);
      if (DECLS.has(k)) {
        const st = DECLS.get(k);
        const js = babel.transform(CODE.slice(st.start, st.end), { presets: ["react"] }).code;
        const v = new Function("__scope", `with (__scope) {\n${js}\n;return ${k};\n}`)(scope);
        cache.set(k, v);
        return v;
      }
      stubbed.add(k);
      const stub = function () { return null; };
      cache.set(k, stub);
      return stub;
    },
    set: (_, k, v) => { cache.set(k, v); return true; },
  });
  return { scope, get: (k) => scope[k], stubbed };
}
const BASE = () => ({
  React, Date: PinnedDate, console: quiet,
  useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, useContext: React.useContext,
  useLang: () => ({ t: tKey, tv: (x) => x, lang: "en" }),
  useModalFocus: () => {}, useBuildVersion: () => false,
  ReactDOM: { createPortal: (el) => el },
  document: { getElementById: () => null, visibilityState: "visible" },
  window: { location: { search: "", pathname: "/golsz-app.html", origin: "http://127.0.0.1" }, innerWidth: 390,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});

// A component run with stand-in hooks. Re-renders on every state change.
function mount(Comp, initialProps) {
  let props = initialProps, i = 0, alive = true, tree = null;
  const slots = [], effects = [];
  const rt = {
    useState(init) { const k = i++; if (!(k in slots)) slots[k] = { v: typeof init === "function" ? init() : init }; const s = slots[k];
      return [s.v, (v) => { if (!alive) return; s.v = typeof v === "function" ? v(s.v) : v; render(); }]; },
    useRef(init) { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useEffect(fn) { const k = i++; if (!(k in slots)) { slots[k] = {}; effects.push(fn); } },
    useCallback(fn) { const k = i++; if (!(k in slots)) slots[k] = { fn }; return slots[k].fn; },
    useMemo(fn) { const k = i++; if (!(k in slots)) slots[k] = { v: fn() }; return slots[k].v; },
    useContext() { return { t: tKey, tv: (x) => x, lang: "en" }; },
  };
  function render() {
    const prev = CURRENT; CURRENT = rt; i = 0;
    try { tree = Comp(props); } finally { CURRENT = prev; }
    while (effects.length) effects.shift()();
  }
  render();
  const all = (n, pred, out = []) => {
    if (!n || typeof n !== "object") return out;
    if (pred(n)) out.push(n);
    for (const c of n.children || []) all(c, pred, out);
    return out;
  };
  const textOf = (n) => (n.children || []).map((c) => (c == null || typeof c === "boolean" ? "" : typeof c === "object" ? textOf(c) : String(c))).join("");
  return {
    findAll: (pred) => all(tree, pred),
    find: (pred) => all(tree, pred)[0] || null,
    byType: (name) => all(tree, (n) => typeof n.type === "function" && n.type.name === name),
    textOf,
    setProps: (p2) => { props = { ...props, ...p2 }; render(); },
    unmount: () => { alive = false; },
  };
}
const settle = async () => { for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r)); };

// A Supabase stand-in. `tables` answers reads; a function answers each call in turn.
function makeSb(tables, opts = {}) {
  const log = { reads: [], updates: [], upserts: [], rpcs: [] };
  const calls = {};
  const answer = (q) => {
    if (q.op === "update") { log.updates.push({ table: q.table, payload: q.payload, filters: q.filters });
      return opts.updateError && opts.updateError(q) ? { data: null, error: opts.updateError(q) } : { data: null, error: null }; }
    if (q.op === "upsert") { log.upserts.push({ table: q.table, payload: q.payload, options: q.options });
      return { data: null, error: opts.upsertError ? opts.upsertError() : null }; }
    log.reads.push({ table: q.table, filters: q.filters });
    calls[q.table] = (calls[q.table] || 0) + 1;
    const a = tables[q.table];
    const v = typeof a === "function" ? a(calls[q.table]) : a;
    if (v && v.__error) return { data: null, error: v.__error };
    return { data: v === undefined ? (q.single ? null : []) : v, error: null };
  };
  const from = (table) => {
    const q = { table, op: "select", filters: [] };
    const self = {
      select: () => self, eq: (c, v) => { q.filters.push([c, v]); return self; },
      maybeSingle: () => { q.single = true; return self; }, single: () => { q.single = true; return self; },
      order: () => self, limit: () => self, lt: () => self, not: () => self, in: () => self,
      update: (pl) => { q.op = "update"; q.payload = pl; return self; },
      upsert: (pl, o) => { q.op = "upsert"; q.payload = pl; q.options = o; return self; },
      insert: (pl) => { q.op = "insert"; q.payload = pl; return self; },
      then: (res, rej) => Promise.resolve().then(() => answer(q)).then(res, rej),
    };
    return self;
  };
  return {
    log,
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from,
    rpc: (name) => { log.rpcs.push(name); return Promise.resolve({ data: null, error: null }); },
  };
}

// ---- GoalSetup ------------------------------------------------------------
const ATHLETE = { sport: "Soccer", club_name: null, recruiting_status: null, grad_year: null, gpa: null, highlights: [] };
const RECORD = { profiles: { goal_text: "" }, athletes: ATHLETE, pathway_plan: null, athlete_benchmarks: [], outreach_targets: [] };
async function openGoalSetup(tables, opts, actingFor) {
  const sb = makeSb({ ...RECORD, ...tables }, opts);
  const S = makeScope({ ...BASE(), sb });
  const done = [], skipped = [];
  const ui = mount(S.get("GoalSetup"), { actingFor: actingFor || null, isDesktop: false, onDone: () => done.push(1), onSkip: () => skipped.push(1) });
  await settle();
  const field = (tag) => ui.find((n) => n.type === tag);
  return {
    sb, ui, S, done, skipped,
    type: (goal, pathwayType, timeline) => {
      if (goal !== undefined) field("textarea").props.onChange({ target: { value: goal } });
      if (pathwayType !== undefined) field("select").props.onChange({ target: { value: pathwayType } });
      if (timeline !== undefined) field("input").props.onChange({ target: { value: timeline } });
    },
    values: () => [field("textarea").props.value, field("select").props.value, field("input").props.value],
    buildButton: () => ui.find((n) => n.type === "button" && ["goal_setup_build", "goal_setup_building"].includes(ui.textOf(n))),
    alert: () => ui.find((n) => n.props && n.props.role === "alert"),
  };
}
const GOAL = "  Play college   soccer in the US  ";
const CLEAN_GOAL = "Play college soccer in the US";
// Every athlete id the calls named: each read's and update's id / user_id
// filter, and each upsert's user_id.
const namedIds = (sb) => [...new Set([
  ...[...sb.log.reads, ...sb.log.updates].flatMap((q) => q.filters.filter(([c]) => c === "id" || c === "user_id").map(([, v]) => v)),
  ...sb.log.upserts.map((u) => u.payload.user_id),
])];

(async () => {
  console.log("-- GoalSetup opens on the athlete's own record --");
  {
    const g = await openGoalSetup();
    ck("the form shows once the reads land (no LoadError)", [!!g.ui.find((n) => n.type === "textarea"), g.ui.byType("LoadError").length], [true, 0]);
    ck("the pathway is preselected from the sport (Soccer: professional)", g.values()[1], "professional");
    ck("the three fields are labelled", g.ui.findAll((n) => n.type === "label").map((n) => n.props.htmlFor),
       ["goal-setup-goal", "goal-setup-pathway", "goal-setup-timeline"]);
    ck("...and each label names a field that exists",
       ["goal-setup-goal", "goal-setup-pathway", "goal-setup-timeline"].every((id) => !!g.ui.find((n) => n.props && n.props.id === id)), true);
    ck("every PATHWAY_TYPES value is offered", g.ui.findAll((n) => n.type === "option").map((n) => n.props.value), g.S.get("PATHWAY_TYPES"));
    ck("it is a labelled dialog", (() => { const d = g.ui.find((n) => n.props && n.props.role === "dialog"); return d && [d.props["aria-modal"], d.props["aria-labelledby"]]; })(), ["true", "goal-setup-title"]);
    ck("nothing was written by opening it", [g.sb.log.updates.length, g.sb.log.upserts.length], [0, 0]);
    const types = ["Basketball", "Tennis", "Cricket", "Quidditch"].map((sport) => g.S.get("starterPathwayType")(sport));
    ck("starterPathwayType: college where the ladder has it, pro where it ends in one, else development", types, ["ncaa", "professional", "development", "development"]);
  }
  {
    const g = await openGoalSetup({ profiles: { goal_text: "Sign with a pro club in Spain" }, pathway_plan: { pathway_type: "european_club", target_timeline: "Summer 2027", milestones: [] } });
    ck("a goal and a row with no steps yet are the starting point", g.values(), ["Sign with a pro club in Spain", "european_club", "Summer 2027"]);
  }
  {
    const g = await openGoalSetup({ pathway_plan: { pathway_type: "ncaa", milestones: [{ id: "m1", label: "Mine", done: false }] } });
    ck("a plan with steps on file at open: straight to Home, nothing written", [g.done.length, g.sb.log.updates.length, g.sb.log.upserts.length], [1, 0, 0]);
  }
  {
    const g = await openGoalSetup({ pathway_plan: { __error: { message: "network" } } });
    ck("a failed read shows LoadError, not an empty form", [g.ui.byType("LoadError").length, !!g.ui.find((n) => n.type === "textarea")], [1, false]);
    ck("...and Skip for now is still there (no dead end)", !!g.ui.find((n) => n.type === "button" && g.ui.textOf(n) === "goal_setup_skip"), true);
  }

  console.log("\n-- the form's own rules --");
  {
    const g = await openGoalSetup();
    g.type("D1");
    ck("a too-short goal is refused", await g.buildButton().props.onClick(), false);
    const ta = g.ui.find((n) => n.type === "textarea");
    ck("...marked aria-invalid and described by its message", [ta.props["aria-invalid"], ta.props["aria-describedby"]], [true, "goal-setup-err-goal"]);
    ck("...which says why, in words", g.ui.textOf(g.ui.find((n) => n.props && n.props.id === "goal-setup-err-goal")), "goal_card_too_short");
    ck("...in C.limeText", g.ui.find((n) => n.props && n.props.id === "goal-setup-err-goal").props.style.color, "var(--lime-text)");
    g.type(CLEAN_GOAL, undefined, "Fall 2025");
    ck("typing clears the goal's message", !!g.ui.find((n) => n.props && n.props.id === "goal-setup-err-goal"), false);
    await g.buildButton().props.onClick();
    ck("a timeline that has passed is refused", g.ui.textOf(g.ui.find((n) => n.props && n.props.id === "goal-setup-err-timeline")), "goal_setup_timeline_past");
    g.type(undefined, undefined, "someday");
    await g.buildButton().props.onClick();
    ck("one it cannot read is refused too", g.ui.textOf(g.ui.find((n) => n.props && n.props.id === "goal-setup-err-timeline")), "goal_setup_timeline_unread");
    ck("nothing was written by any refused tap", [g.sb.log.updates.length, g.sb.log.upserts.length], [0, 0]);
    const errs = g.S.get("goalSetupFieldErrors");
    ck("goalSetupFieldErrors: an empty timeline is fine", errs({ goal: CLEAN_GOAL, timeline: "  " }, TODAY), {});
    ck("...an empty goal is goal_card_required", errs({ goal: "   ", timeline: "" }, TODAY), { goal: "goal_card_required" });
    ck("...a date ahead is fine", errs({ goal: CLEAN_GOAL, timeline: "2027-09" }, TODAY), {});
  }

  console.log("\n-- (a) two quick taps write one plan --");
  {
    const g = await openGoalSetup();
    g.type(GOAL, "ncaa", "Fall 2027");
    const onClick = g.buildButton().props.onClick;
    const first = onClick(), second = onClick();
    ck("the second tap is refused at once", await second, false);
    ck("the first builds the plan", await first, true);
    await settle();
    ck("exactly one pathway_plan upsert", g.sb.log.upserts.filter((u) => u.table === "pathway_plan").length, 1);
    ck("...one goal write", g.sb.log.updates.filter((u) => u.table === "profiles").length, 1);
    ck("...and one trip Home", g.done.length, 1);
  }

  console.log("\n-- (b) a plan made elsewhere is never written over --");
  {
    const other = { pathway_type: "ncaa", milestones: [{ id: "other-device", label: "Theirs", done: false }], stages: [], current_stage_id: null };
    const g = await openGoalSetup({ pathway_plan: (n) => (n === 1 ? null : other) });
    g.type(GOAL, "ncaa", "");
    ck("the form opened (no steps at the first read)", !!g.buildButton(), true);
    ck("building finds the other device's plan and returns true", await g.buildButton().props.onClick(), true);
    ck("...no upsert", g.sb.log.upserts.length, 0);
    ck("...no goal write either: the plan on file stays whole", g.sb.log.updates.length, 0);
    ck("...and it goes Home", g.done.length, 1);
  }

  console.log("\n-- (c) a refused upsert keeps the form --");
  {
    let refuse = true;
    const g = await openGoalSetup({}, { upsertError: () => (refuse ? { message: "new row violates row-level security policy" } : null) });
    g.type(GOAL, "naia", "Spring 2028");
    ck("the build returns false", await g.buildButton().props.onClick(), false);
    ck("what was typed is still there", g.values(), [GOAL, "naia", "Spring 2028"]);
    ck("a role=alert line says so", !!g.alert(), true);
    ck("...with the save-failed key", g.ui.textOf(g.ui.find((n) => n.type === "span" && g.ui.textOf(n) === "goal_setup_save_err")), "goal_setup_save_err");
    ck("...and a Retry button inside it", (() => { const a = g.alert(); return !!a && g.ui.findAll((n) => n.type === "button").some((b) => g.ui.textOf(b) === "load_retry" && JSON.stringify(a).includes('"load_retry"')); })(), true);
    ck("it did not go Home", g.done.length, 0);
    refuse = false;
    const retry = g.ui.findAll((n) => n.type === "button").find((b) => g.ui.textOf(b) === "load_retry");
    ck("Retry builds it once the write is accepted", await retry.props.onClick(), true);
    ck("...the alert is gone and it goes Home", [!!g.alert(), g.done.length], [false, 1]);
  }

  console.log("\n-- (d) a success writes the goal and starterPathwaySteps' plan --");
  {
    const benchmarks = [{ metric_key: "sprint_30m" }];
    const targets = [{ status: "researching" }];
    const row = { pathway_type: "ncaa", target_timeline: null, milestones: [], stages: [], current_stage_id: null };
    const g = await openGoalSetup({ athlete_benchmarks: benchmarks, outreach_targets: targets, pathway_plan: row });
    g.type(GOAL, "ncaa", " Fall 2027 ");
    ck("the build returns true", await g.buildButton().props.onClick(), true);
    const goalWrite = g.sb.log.updates.find((u) => u.table === "profiles");
    ck("goal_text is the cleaned sentence, goal_defined true, the athlete's own words",
       goalWrite && [goalWrite.payload.goal_text, goalWrite.payload.goal_defined, goalWrite.payload.goal_source], [CLEAN_GOAL, true, "athlete_edited"]);
    ck("...written to the signed-in athlete's row", goalWrite && goalWrite.filters, [["id", "u1"]]);
    const up = g.sb.log.upserts[0];
    const expected = g.S.get("starterPathwaySteps")({ sport: "Soccer", pathwayType: "ncaa", timeline: "Fall 2027", today: TODAY,
      athlete: ATHLETE, benchmarks, targets, pathwayRow: row, t: tKey });
    ck("the milestones equal starterPathwaySteps' output", up && up.payload.milestones, expected);
    ck("...which is a real plan: 5 to 8 steps, the first due today", [expected.length >= 5 && expected.length <= 8, expected[0].due], [true, TODAY]);
    ck("one upsert on user_id with the type and timeline",
       up && [up.table, up.options, up.payload.user_id, up.payload.pathway_type, up.payload.target_timeline], ["pathway_plan", { onConflict: "user_id" }, "u1", "ncaa", "Fall 2027"]);
    ck("...and nothing else from the row (notes, stages, stage are kept)", up && Object.keys(up.payload).sort(), ["milestones", "pathway_type", "target_timeline", "updated_at", "user_id"]);
    ck("the action mirror is asked to catch up", g.sb.log.rpcs, ["sync_athlete_actions"]);
    ck("...and it goes Home once", g.done.length, 1);
    ck("GoalCard's writer is the one used (saveGoalText)", /const \{ error: goalError \} = await saveGoalText\(sb, uid, cleanGoalText\(goal\)\);/.test(APP), true);
    ck("every read and write named the signed-in athlete, and no one else", namedIds(g.sb), ["u1"]);
    ck("...and both pathway_plan reads took the whole row (stages and stage too)",
       [...goalSetupSrcOf().matchAll(/from\("pathway_plan"\)\.select\("([^"]+)"\)\.eq\("user_id", (who|uid)\)\.maybeSingle\(\)/g)]
         .map((m) => /\bstages\b/.test(m[1]) && /current_stage_id/.test(m[1])), [true, true]);
  }

  console.log("\n-- a parent managing an athlete: that athlete's plan, never the parent's --");
  {
    const g = await openGoalSetup({}, {}, "child-1");
    g.type(GOAL, "ncaa", "");
    ck("the build returns true", await g.buildButton().props.onClick(), true);
    ck("every read and write named the managed athlete (child-1), none the signed-in parent (u1)", namedIds(g.sb), ["child-1"]);
    ck("...the goal and the plan are theirs", [g.sb.log.updates.map((u) => u.filters), g.sb.log.upserts.map((u) => u.payload.user_id)],
       [[[["id", "child-1"]]], ["child-1"]]);
  }

  console.log("\n-- GolszApp: after the onboarding save, and not after a plain one --");
  const appWith = (start, search) => {
    const S = makeScope({ ...BASE(), sb: null, useIsDesktop: () => false });
    S.get("window").location.search = search || "";
    return mount(S.get("GolszApp"), { onSignOut() {}, startOnboarding: start });
  };
  {
    const app = appWith(true);
    const passport = () => app.byType("Passport")[0];
    ck("a fresh sign-up starts on the Passport with the editor asked for", [!!passport(), passport().props.autoEdit], [true, true]);
    passport().props.onAutoEditConsumed();
    ck("the editor opening does not end onboarding", [passport().props.autoEdit, app.byType("GoalSetup").length], [false, 0]);
    passport().props.onProfileSaved({ sport: "Soccer", occupation: "Player" });
    ck("the onboarding save with a sport opens GoalSetup", app.byType("GoalSetup").length, 1);
    ck("...for the signed-in athlete (no one is being managed)", app.byType("GoalSetup")[0].props.actingFor, null);
    ck("...over the Passport, which stays", !!passport(), true);
    app.byType("GoalSetup")[0].props.onSkip();
    ck("Skip for now: GoalSetup closes and Home opens", [app.byType("GoalSetup").length, app.byType("HomeTab").length], [0, 1]);
    ck("Home is offered the same step", typeof app.byType("HomeTab")[0].props.onSetGoal, "function");
    app.byType("HomeTab")[0].props.onSetGoal();
    ck("...and its card opens GoalSetup again", app.byType("GoalSetup").length, 1);
    const keyBefore = app.byType("HomeTab")[0].props.key;
    app.byType("GoalSetup")[0].props.onDone();
    ck("a built plan closes it and remounts Home to read the steps", [app.byType("GoalSetup").length, app.byType("HomeTab")[0].props.key], [0, keyBefore + 1]);
  }
  {
    const app = appWith(true);
    app.byType("Passport")[0].props.onProfileSaved({ sport: null, occupation: "Player" });
    ck("an onboarding save without a sport does not open it", app.byType("GoalSetup").length, 0);
    app.byType("Passport")[0].props.onProfileSaved({ sport: "Soccer", occupation: "Parent" });
    ck("...nor does a parent's", app.byType("GoalSetup").length, 0);
  }
  {
    const app = appWith(false, "?page=profile");
    ck("outside onboarding the editor is not asked for", app.byType("Passport")[0].props.autoEdit, false);
    app.byType("Passport")[0].props.onProfileSaved({ sport: "Soccer", occupation: "Player" });
    ck("a plain Passport save does not open GoalSetup", app.byType("GoalSetup").length, 0);
  }
  {
    const S = makeScope({ ...BASE(), sb: null, useIsDesktop: () => true });
    const app = mount(S.get("GolszApp"), { onSignOut() {}, startOnboarding: true });
    app.byType("Passport")[0].props.onProfileSaved({ sport: "Tennis", occupation: null });
    ck("the desktop layout opens it too", app.byType("GoalSetup").length, 1);
  }
  // "Confirm email" is on, so a new athlete's first session often starts with a
  // plain sign-in (no startOnboarding). GolszApp's own profile check finding no
  // sport is what makes that session's Passport save the onboarding one.
  const signedIn = async (athletes) => {
    const sb = makeSb({ athletes, profiles: { occupation: null, full_name: "Ana Diaz" } });
    const S = makeScope({ ...BASE(), sb, useIsDesktop: () => false, setInterval: () => 0, clearInterval() {} });
    S.get("window").location.search = "?page=profile";
    const app = mount(S.get("GolszApp"), { onSignOut() {}, startOnboarding: false });
    await settle();
    app.byType("Passport")[0].props.onProfileSaved({ sport: "Soccer", occupation: "Player" });
    return app;
  };
  {
    const app = await signedIn({ sport: null });
    ck("a sign-in that finds no sport: the save that adds one opens GoalSetup", app.byType("GoalSetup").length, 1);
    ck("...and the daily check-in waits for it", app.byType("DailyCheckIn").length, 0);
  }
  ck("a sign-in with the sport on file: a save is a plain one", (await signedIn({ sport: "Soccer" })).byType("GoalSetup").length, 0);
  ck("a failed profile read is not taken for a new athlete", (await signedIn({ __error: { message: "network" } })).byType("GoalSetup").length, 0);
  // The editor Passport rendered, saved as a person saves it: the sport picked
  // in its select, then Save. What reaches onProfileSaved is the app's own.
  const saveInEditor = async (passportUi, sport) => {
    const el = passportUi.byType("ProfileEditor")[0];
    if (!el) return false;
    const editor = mount(el.type, el.props);
    editor.find((n) => n.type === "select" && n.props["aria-label"] === "editor_sport_label").props.onChange({ target: { value: sport } });
    await editor.find((n) => n.type === "button" && editor.textOf(n) === "editor_save").props.onClick();
    await settle();
    return true;
  };
  {
    // The whole hand-off, nothing built by this test: GolszApp's own props for
    // Passport, Passport's own editor, the editor's own save.
    const sb = makeSb({ profiles: { full_name: "Ana Diaz", occupation: "Player" }, athletes: { sport: null } });
    const S = makeScope({ ...BASE(), sb, useIsDesktop: () => false, setInterval: () => 0, clearInterval() {} });
    const app = mount(S.get("GolszApp"), { onSignOut() {}, startOnboarding: true });
    await settle();
    const passport = mount(S.get("Passport"), app.byType("Passport")[0].props);
    await settle();
    const before = app.byType("GoalSetup").length;
    const saved = await saveInEditor(passport, "Soccer");
    const stored = sb.log.updates.find((u) => u.table === "athletes");
    ck("the onboarding editor's own save stores the sport", [saved, stored && stored.payload.sport], [true, "Soccer"]);
    ck("...and, passed on by Passport, opens GoalSetup (closed before it)", [before, app.byType("GoalSetup").length], [0, 1]);
  }
  // Manage mode (a parent editing a managed athlete's Passport): GolszApp hands
  // both layouts' Passport afterPassportSave, so Passport's own guard is what
  // keeps that athlete's save from opening GoalSetup.
  const passportSaves = async (manageMode) => {
    const S = makeScope({ ...BASE(), sb: makeSb({ profiles: { full_name: "Ana Diaz", occupation: "Player" }, athletes: { sport: null } }) });
    const saves = [];
    const ui = mount(S.get("Passport"), { autoEdit: true, onAutoEditConsumed() {}, onProfileSaved: (s) => saves.push(s),
      viewUserId: manageMode ? "child-1" : null, manageMode });
    await settle();
    return (await saveInEditor(ui, "Soccer")) ? saves : "no editor";
  };
  ck("Passport passes on what its editor saved, and never a managed athlete's save",
     [await passportSaves(false), await passportSaves(true)], [[{ sport: "Soccer", occupation: "Player" }], []]);

  console.log("\n-- HomeTab: the 'set your goal' card, and never in place of LoadError --");
  const home = async (tables, props) => {
    const sb = makeSb({ profiles: { full_name: "Ana Diaz", goal_defined: false, goal_text: "", plan: "free" }, athletes: ATHLETE,
      verification_requests: [], athlete_benchmarks: [], development_plan_items: [], pathway_plan: null, outreach_targets: [],
      passport_share_tokens: [], development_plan_ticks: [], athlete_actions: [], assessment_snapshots: null, ...tables });
    const S = makeScope({ ...BASE(), sb });
    const opened = [];
    const ui = mount(S.get("HomeTab"), { onNavigate() {}, plan: "free", onUpgrade() {}, actingFor: null, resting: false, checkinChip: null, onBetter() {},
      onSetGoal: () => opened.push(1), ...props });
    await settle();
    return { ui, opened, S };
  };
  {
    const h = await home();
    const card = h.ui.byType("SetGoalCard");
    ck("profile complete, no pathway_plan row: the card shows (Free plan)", card.length, 1);
    ck("...and it is not LoadError", h.ui.byType("LoadError").length, 0);
    card[0].props.onOpen();
    ck("...its button opens GoalSetup", h.opened.length, 1);
    const own = h.S.get("SetGoalCard")({ onOpen() {} });
    ck("the card says what to do, with no read-failure text", [own.children.some((c) => c && c.children && c.children.includes("home_set_goal_title")), JSON.stringify(own).includes("load_failed")], [true, false]);
  }
  ck("a row with no steps: the card shows", (await home({ pathway_plan: { pathway_type: "ncaa", milestones: [] } })).ui.byType("SetGoalCard").length, 1);
  {
    const steps = [{ id: "s1", label: "Ask Scout what to focus on this week", done: false, due: TODAY, due_src: "scout", category: "other", stage: "academy" }];
    const h = await home({ pathway_plan: { pathway_type: "ncaa", milestones: steps } });
    ck("a plan with steps: no card", h.ui.byType("SetGoalCard").length, 0);
    ck("...and on Free the Today tile names the athlete's own step", JSON.stringify(h.ui.findAll((n) => n.type === "button")).includes("Ask Scout what to focus on this week"), true);
  }
  // Behind the Today tile and "Show my progress", TODAY and THIS WEEK count the athlete's
  // own steps on every plan. On Free (Plan locked) they only report; from Basic
  // up they open Plan.
  {
    const step = (id, due) => ({ id, label: "Step " + id, done: false, due, due_src: "scout", category: "other", stage: "academy" });
    const week = [step("s1", TODAY), step("s2", "2026-11-12"), step("s3", "2026-11-18")];   // today, Thursday, next week
    for (const plan of ["free", "starter"]) {
      const nav = [];
      const h = await home({ pathway_plan: { pathway_type: "ncaa", milestones: week } }, { plan, onNavigate: (pg) => nav.push(pg) });
      h.ui.findAll((n) => n.type === "button").find((b) => JSON.stringify(b).includes('"tile_today"')).props.onClick();
      h.ui.findAll((n) => n.type === "button").find((b) => h.ui.textOf(b) === "home_more").props.onClick();
      const cell = (k, label) => h.ui.find((n) => (n.type === "div" || n.type === "button") && n.props.key === k && h.ui.textOf(n).startsWith(label));
      const today = cell("today", "home_week_today"), wk = cell("week", "home_week_title");
      ck(`${plan}: the Today view shows TODAY 0/1 and THIS WEEK 0/2`, [today && h.ui.textOf(today), wk && h.ui.textOf(wk)], ["home_week_today0/1", "home_week_title0/2"]);
      if (plan === "free") {
        ck("...on Free both only report (no button into the locked Plan page)",
           [today && today.type, wk && wk.type, !!(today && today.props.onClick), !!(wk && wk.props.onClick)], ["div", "div", false, false]);
      } else {
        for (const c of [today, wk]) if (c && c.props.onClick) c.props.onClick();
        ck("...on Basic both are buttons that open Plan", [today && today.type, wk && wk.type, nav], ["button", "button", ["targets", "targets"]]);
      }
    }
  }
  // The Today tile's "N to do" badge is the first number a new plan puts on
  // Home. It drew black on black in the light theme (C.ink ground, C.chalk text).
  {
    const h = await home({ pathway_plan: { pathway_type: "ncaa", milestones: [{ id: "b1", label: "Step b1", done: false, due: TODAY, due_src: "scout" }] } });
    const badge = h.ui.find((n) => n.type === "span" && h.ui.textOf(n) === "tile_today_count");
    const hexOf = (block, v) => (new RegExp("--" + v + ":\\s*(#[0-9A-Fa-f]{6})").exec(block) || [])[1];
    const lightAt = APP.indexOf('html[data-theme="light"] {');
    const blocks = { dark: APP.slice(APP.lastIndexOf(":root {", lightAt), lightAt), light: APP.slice(lightAt, APP.indexOf("}", lightAt)) };
    const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const vars = badge && [badge.props.style.background, badge.props.style.color].map((s) => (/^var\(--([a-z-]+)\)$/.exec(s) || [])[1]);
    ck("the Today badge's ground and text are both theme tokens", !!vars && vars.every(Boolean), true);
    for (const th of ["dark", "light"]) {
      const pair = vars && vars.map((v) => hexOf(blocks[th], v));
      ck(`...and the count reads at 4.5:1 or more in the ${th} theme`, !!pair && pair.every(Boolean) && ratio(pair[0], pair[1]) >= 4.5, true);
    }
  }
  ck("no sport yet: no card (the Passport comes first)", (await home({ athletes: { ...ATHLETE, sport: null } })).ui.byType("SetGoalCard").length, 0);
  // GolszApp hands GoalSetup the same actingFor (asserted below), and GoalSetup
  // writes only that athlete's rows (asserted above).
  ck("a parent managing an athlete with no steps: the card shows for that athlete",
     (await home({}, { actingFor: "child-1" })).ui.byType("SetGoalCard").length, 1);
  {
    const h = await home({ pathway_plan: { __error: { message: "network" } } });
    ck("a failed pathway read: LoadError, and no card", [h.ui.byType("LoadError").length, h.ui.byType("SetGoalCard").length], [1, 0]);
  }

  console.log("\n-- no plan gate, Scout's draft unchanged, every language --");
  const goalSetupSrc = goalSetupSrcOf();
  ck("GoalSetup checks no plan", /featureUnlocked|featureLocked|planKnown|FEATURE_MIN_PLAN/.test(goalSetupSrc), false);
  ck("...and is handed none", /^function GoalSetup\(\{ actingFor, isDesktop, onDone, onSkip \}\)/.test(goalSetupSrc), true);
  ck("GolszApp renders it in both layouts, gated only by goalSetupOpen, for the athlete being shown",
     (APP.match(/\{goalSetupOpen && <GoalSetup actingFor=\{actingFor && actingFor\.id\} isDesktop=\{isDesktop\} onDone=\{finishGoalSetup\} onSkip=\{finishGoalSetup\} \/>\}/g) || []).length, 2);
  ck("GoalSetup never scopes a query to user.id directly", /\.eq\("(user_id|id)", user\.id\)/.test(goalSetupSrc), false);
  ck("'Let Scout draft my steps' keeps its own gate", /\{onNavigate && featureUnlocked\(plan, "pathway_plan"\) && \(/.test(APP), true);
  const KEYS = ["goal_setup_title", "goal_setup_sub", "goal_setup_goal_label", "goal_setup_pathway_label", "goal_setup_timeline_label",
    "goal_setup_timeline_ph", "goal_setup_timeline_unread", "goal_setup_timeline_past", "goal_setup_build", "goal_setup_building",
    "goal_setup_save_err", "goal_setup_skip", "home_set_goal_title", "home_set_goal_sub"];
  const I18N = makeScope(BASE()).get("I18N");
  for (const lang of ["en", "fr", "es", "el"]) {
    ck(`${lang} has every GoalSetup key, none blank`, KEYS.filter((k) => !(typeof I18N[lang][k] === "string" && I18N[lang][k].trim())), []);
  }
  ck("the alert reads as the task asked", I18N.en.goal_setup_save_err, "Couldn't save your plan. Try again.");
  ck("the card reads as the task asked", I18N.en.home_set_goal_title, "Set your goal to get your plan");

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL  the suite threw: " + (e && e.stack || e)); console.log(`\n${p}/${p + f + 1} passed`); process.exit(1); });
