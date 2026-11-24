// LABELS AND FOCUS ON THE THREE FIRST SCREENS (AVA job 235, t2).
//
// A keyboard or screen-reader athlete reaches Home, Passport and Scout first.
// Every control there must have a name a screen reader can say, and Tab must
// leave a visible ring even where a component sets an inline outline:"none"
// for its resting look. This suite mounts the REAL components through
// tests/_app_mount.cjs (stand-in hooks, stand-in Supabase), walks every DOM
// button / [role=button] they actually render — including nested components
// and the principal dialogs — and computes the accessible name the way the
// acceptance criteria defines it: aria-label, an aria-labelledby target's
// text, or visible text. A `title` on its own does NOT count: an icon-only
// control with nothing but a title is the bug this job fixes.
//
// Coverage: each screen's loading, empty and error states; ProfileEditor and
// the goal cards (mounted directly); Scout's history panel with its delete
// row (driven through the real History button); and the global :focus-visible
// rule that beats inline outline:none on dialog panels and inputs.
const path = require("path");
const { APP, React, makeScope, mount, settle } = require("./_app_mount.cjs");

const REPO = path.join(__dirname, "..");
let p = 0, f = 0;
const ck = (label, actual, expected) => {
  const A = JSON.stringify(actual), E = JSON.stringify(expected);
  if (A === E) { p++; console.log("PASS  " + label); }
  else { f++; console.log(`FAIL  ${label}\n   exp ${E}\n   got ${A}`); }
};

const I18N = makeScope({ React }).get("I18N");
const LANGS = ["en", "fr", "es", "el"];
const t = (k) => (I18N.en[k] != null ? I18N.en[k] : k);

// ---------------------------------------------------------------------------
// Stand-ins. Only the browser/backend is stood in; every component, helper and
// dictionary is the app's own, compiled by _app_mount.cjs.
// ---------------------------------------------------------------------------
function chain(value) {
  const q = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "neq", "order", "limit", "range",
    "single", "maybeSingle", "in", "like", "ilike", "is", "gte", "lte", "gt", "lt", "textSearch",
    "contains", "or", "match", "upsert", "onConflict", "not"]) q[m] = () => q;
  q.then = (res, rej) => Promise.resolve(value).then(res, rej);
  q.catch = (fn) => Promise.resolve(value).catch(fn);
  return q;
}

const NOW = new Date().toISOString();
const ROWS = {
  profiles: { full_name: "Test Athlete", occupation: "Player", avatar_url: "http://example.test/a.png",
    plan: "pro", identity_verified: false, goal_defined: false, goal_text: "Play college soccer in the US" },
  athletes: { sport: "Soccer", position: "Forward", club_name: "Northfield FC", country: "Canada",
    highlights: [], timeline: [] },
  athlete_benchmarks: [{ metric: "40 m dash", value: 5, unit: "s", recorded_date: NOW }],
  pathway_plan: { pathway_type: "college", milestones: [{ id: "m1", label: "Ask Scout what to focus on this week", due: NOW.slice(0, 10), done: false }] },
  outreach_targets: [{ id: "t1", name: "Northfield College", status: "contacted", updated_at: NOW }],
  scout_history: [{ conversation_id: "c1", messages: [{ role: "user", content: "Which clubs fit me?" }], created_at: NOW }],
};

function makeSb(mode) {
  if (mode === "loading") {
    // A read that never resolves keeps every screen in its loading state.
    const never = new Promise(() => {});
    return {
      auth: { getUser: () => never, getSession: () => never },
      from: () => chain(never), rpc: () => never,
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {},
    };
  }
  const err = { message: "boom" };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u" } } }), getSession: async () => ({ data: { session: null } }) },
    from(table) {
      // "error" fails every read; screens then show their LoadError/Retry.
      const value = mode === "error"
        ? { data: null, error: err, count: null }
        : { data: ROWS[table] != null ? ROWS[table] : null, error: null, count: 0 };
      return chain(value);
    },
    rpc: async () => ({ data: null, error: null }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

function makeDoc() {
  const el = { focus() {}, contains() { return false; }, querySelectorAll() { return []; }, offsetWidth: 1, offsetHeight: 1 };
  return { activeElement: el, body: el, addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, getElementById() { return null; }, contains() { return false; } };
}

function scopeFor(mode) {
  return makeScope({
    React,
    ReactDOM: { createPortal: (el) => el },
    useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    useCallback: React.useCallback, useMemo: React.useMemo,
    useLang: () => ({ t, tv: (k, v) => (v == null ? k : v), lang: "en" }),
    sb: makeSb(mode),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    document: makeDoc(),
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
      location: { origin: "http://example.test", pathname: "/golsz-app.html" } },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  });
}

// ---------------------------------------------------------------------------
// Walking a rendered tree. _app_mount leaves child components as elements, so
// expand() mounts them too — with a signature guard so repeated instances of
// the same component with different props are each inspected once, and cycles
// cannot spin.
// ---------------------------------------------------------------------------
function textOf(n) {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n !== "object") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return (n.children || []).map(textOf).join("");
}
const rootOf = (ui) => ui.findAll(() => true)[0];

function signature(node) {
  const prim = {};
  for (const [k, v] of Object.entries(node.props || {})) {
    if (typeof v !== "function" && typeof v !== "object") prim[k] = v;
  }
  return `${node.type.name || "anon"}|${JSON.stringify(prim)}`;
}

function expand(node, out, seen, depth) {
  if (node == null || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) { node.forEach((n) => expand(n, out, seen, depth)); return; }
  if (typeof node.type === "function") {
    const sig = signature(node);
    if (seen.has(sig)) return;
    seen.add(sig);
    let sub;
    try { sub = mount(node.type, node.props || {}); }
    catch (e) { return; } // a child that needs more stand-ins contributes no DOM here
    expand(rootOf(sub), out, seen, depth + 1);
    return;
  }
  if (node.type === "button" || (node.props && node.props.role === "button")) out.push(node);
  for (const c of node.children || []) expand(c, out, seen, depth + 1);
}

// Every node of the current tree (for resolving aria-labelledby targets).
function allNodes(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => allNodes(n, out)); return out; }
  out.push(node);
  for (const c of node.children || []) allNodes(c, out);
  return out;
}

// The accessible name as the brief defines it. Deliberately does NOT fall
// back to `title`: that is exactly the icon-only-button failure being fixed.
function accessibleName(node, nodes) {
  const props = node.props || {};
  if (typeof props["aria-label"] === "string" && props["aria-label"].trim()) return props["aria-label"].trim();
  if (typeof props["aria-labelledby"] === "string") {
    const named = props["aria-labelledby"].split(/\s+/)
      .map((id) => nodes.find((n) => n.props && n.props.id === id))
      .filter(Boolean).map(textOf).join(" ").trim();
    if (named) return named;
  }
  return textOf(node).trim();
}

function assertNamed(label, ui, minButtons = 0) {
  const root = rootOf(ui);
  const nodes = allNodes(root);
  const buttons = [];
  expand(root, buttons, new Set(), 0);
  // A loading skeleton legitimately has no controls; where a state should
  // render buttons, require some so the naming check cannot pass vacuously.
  if (minButtons) ck(`${label}: rendered at least ${minButtons} button`, buttons.length >= minButtons, true);
  const unnamed = buttons.filter((b) => !accessibleName(b, nodes));
  ck(`${label}: every button / [role=button] has an accessible name`, unnamed, []);
  return buttons.length;
}

// Temporarily quiet the app's own console.error/warn during error-state mounts,
// then restore the suite's own output.
async function quiet(fn) {
  const keep = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  try { return await fn(); }
  finally { Object.assign(console, keep); }
}

async function screen(compName, mode, props) {
  const scope = scopeFor(mode);
  let ui;
  await quiet(async () => {
    ui = mount(scope.get(compName), props);
    await settle();
  });
  return { ui, scope };
}

const homeProps = () => ({ onNavigate() {}, plan: "pro", onUpgrade() {}, actingFor: null,
  resting: false, checkinChip: null, onBetter() {}, onSetGoal() {} });
const passportProps = () => ({ onSignOut() {}, plan: "pro", onUpgrade() {}, onProfileStatus() {},
  onProfileSaved() {}, onOpenAdmin() {}, onMessage() {}, onViewProfile() {} });
const scoutProps = () => ({ plan: "pro", onUpgrade() {}, onGoToProfile() {}, onNavigate() {},
  actingFor: null, seedPrompt: null, onSeedSent() {} });

// ---------------------------------------------------------------------------
console.log("-- Home: loading, empty (loaded), error --");
(async () => {
  for (const [screenName, comp, props] of [
    ["Home", "HomeTab", homeProps()],
    ["Passport", "Passport", passportProps()],
    ["Scout", "Scout", scoutProps()],
  ]) {
    console.log(`\n  ${screenName}`);
    const loading = await screen(comp, "loading", props);
    const empty = await screen(comp, "empty", props);
    const error = await screen(comp, "error", props);
    assertNamed(`${screenName} loading`, loading.ui);
    assertNamed(`${screenName} loaded/empty`, empty.ui, 1);
    assertNamed(`${screenName} error`, error.ui, 1);
    // Prove the loading stub really held the screen in its loading state:
    // Home's skeleton is marked aria-busy and carries no buttons at all.
    if (screenName === "Home") {
      const busy = loading.ui.findAll((n) => n.props && n.props["aria-busy"] === "true");
      ck("Home loading is a busy skeleton, not a half-drawn screen", busy.length, 1);
      ck("Home loading has no interactive controls", rootOf(loading.ui) ? allNodes(rootOf(loading.ui)).filter((n) => n.type === "button").length : -1, 0);
    }
  }

  console.log("\n-- Principal dialogs and panels --");
  {
    const scope = scopeFor("empty");
    let editor;
    await quiet(async () => {
      editor = mount(scope.get("ProfileEditor"), { initial: { full_name: "Test Athlete", occupation: "Player",
        sport: "Soccer" }, locked: false, onClose() {}, onSaved() {}, onSignOut() {} });
      await settle();
    });
    assertNamed("ProfileEditor dialog", editor, 1);
    // The panel itself is script-focused (tabIndex -1, no ring), but the
    // focusable children inside it are real buttons/inputs that the global
    // :focus-visible rule rings even though their resting style (and the
    // panel's) sets outline:none.
    const panel = allNodes(rootOf(editor)).find((n) => n.props && n.props.role === "dialog");
    ck("ProfileEditor renders an aria-modal dialog panel focused by script",
      !!(panel && panel.props["aria-modal"] === "true" && panel.props.tabIndex === -1), true);
    const inPanel = panel ? allNodes(panel).filter((n) => n.type === "button" || n.type === "input" || n.type === "textarea") : [];
    ck("that dialog panel holds focusable children (buttons/inputs)", inPanel.length > 0, true);
  }
  {
    const scope = scopeFor("empty");
    const goal = mount(scope.get("GoalCard"), { actingFor: null, onSaved() {}, onOpenPlan() {},
      onGoalText() {}, hero: true });
    assertNamed("GoalCard", goal);
    const setGoal = mount(scope.get("SetGoalCard"), { onOpen() {} });
    assertNamed("SetGoalCard", setGoal);
  }
  {
    // Scout's history panel + its two-tap delete row are driven through the
    // real History button, so this is the app's own panel, not a mock.
    const { ui } = await screen("Scout", "empty", scoutProps());
    const historyBtn = ui.find((n) => n.type === "button" && n.props["aria-label"] === t("scout_history_title"));
    ck("Scout header History button is named", !!historyBtn, true);
    await quiet(async () => {
      if (historyBtn && historyBtn.props.onClick) { historyBtn.props.onClick(); await settle(); }
    });
    assertNamed("Scout history panel (with delete row)", ui, 1);
    const del = ui.find((n) => n.type === "button" && n.props["aria-label"] === t("scout_delete_conv"));
    ck("Scout history delete row is named", !!del, true);
    await quiet(async () => {
      if (del && del.props.onClick) { del.props.onClick(); await settle(); }
    });
    assertNamed("Scout history delete armed", ui, 1);
  }

  console.log("\n-- Translated keys: no raw English aria-label on a fixed control --");
  {
    // The five icon-only controls fixed in this job. Each aria-label is a t()
    // call, and its key resolves to a real string in all four dictionaries.
    const fixed = [
      ["passport_photo_remove", "passport remove-photo button"],
      ["scout_history_title", "Scout History button"],
      ["feed_remove_photo", "Scout attached-photo remove button"],
      ["scout_attach_photo", "Scout attach-photo button"],
      ["a11y_send", "Scout send button"],
    ];
    for (const [key, label] of fixed) {
      const values = LANGS.map((lang) => I18N[lang] && I18N[lang][key]);
      ck(`${label}: "${key}" is a non-empty translated string in en/fr/es/el`,
        values.every((v) => typeof v === "string" && v.trim().length > 0), true);
      ck(`${label}: not the raw key name in any language`, values.includes(key), false);
    }
  }

  console.log("\n-- Global :focus-visible ring survives inline outline:none --");
  {
    const css = APP.slice(APP.indexOf("const CSS = `"), APP.indexOf("`;", APP.indexOf("const CSS = `")));
    const rule = css.match(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/);
    ck("a :focus-visible rule exists", !!rule, true);
    const sel = rule ? rule[1] : "";
    for (const el of ["input", "textarea", "select", "button", "a", '[role="button"]']) {
      ck(`it covers ${el}`, new RegExp("(^|[\\s,])" + el.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":focus-visible").test(sel), true);
    }
    ck("it covers focusable elements with a tabindex", /\[tabindex\]:not\(\[tabindex="-1"\]\):focus-visible/.test(sel), true);
    ck("script-focused dialog panels (tabindex=-1) are excluded", /:not\(\[tabindex="-1"\]\)/.test(sel), true);
    // Test the declarations against the whole CSS block: a naive {..} capture
    // stops at the `}` inside ${C.lime} and truncates the second declaration.
    ck("it beats inline outline:none (!important on both declarations)",
      /outline: 2px solid \$\{C\.lime\} !important; outline-offset: 2px !important;/.test(css), true);
    ck("the ring uses the design token, not a raw colour", /solid \$\{C\.lime\}/.test(css), true);
    // The rule is only needed because inline outline:none really is used on
    // inputs and dialog panels — prove that premise, not just the rule.
    ck("inline outline:none is present in the app (why !important is required)",
      /outline:\s*"none"/.test(APP), true);
    ck("dialog panels are script-focused with tabIndex -1 and aria-modal",
      /tabIndex=\{-1\}[^>]*role="dialog" aria-modal="true"/.test(APP), true);
  }

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
