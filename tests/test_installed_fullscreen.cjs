// THE INSTALLED APP FILLS THE PHONE SCREEN (AVA job 235, task t4).
//
// An athlete who adds GOLSZ to an iPhone's Home Screen opens it full-screen
// (standalone): no Safari bars, the app's header below the status bar and its
// bottom nav above the home indicator. This suite pins both halves of that from
// the committed files, with no browser:
//   1. Standalone detection. The REAL isIOSDevice, isStandaloneDisplay,
//      pushSupported, urlBase64ToUint8Array, enablePushNotifications and
//      notifErrorText are lifted out of golsz-app.jsx and run on an iPhone stand-in:
//      the display-mode media query or navigator.standalone === true counts as
//      installed, a Safari tab does not. Installed asks for permission and
//      subscribes; a tab throws IOS_NEEDS_HOMESCREEN before either, and that error
//      reads as notif_ios_homescreen in all four languages.
//   2. The full-screen layout rules: viewport-fit=cover (without it iOS keeps the
//      page inside the safe area), the manifest's standalone display, #root at
//      least 100dvh, .app-shell exactly 100dvh, and the phone shell's header and
//      bottom nav padded by env(safe-area-inset-top) / env(safe-area-inset-bottom).
// test_pwa_install_ios.cjs covers the manifest's icons, sw.js and both
// notification buttons; this suite does not repeat them. It reads only
// golsz-app.jsx, golsz-app.html and manifest.json next to its own folder, so a
// mutant copy of those three files is enough to watch it fail.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

const JSX = read("golsz-app.jsx");
const HTML = read("golsz-app.html");
const MANIFEST = JSON.parse(read("manifest.json"));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};
const yes = (l, cond) => ck(l, !!cond, true);

const ast = parser.parse(JSX, { sourceType: "script", plugins: ["jsx"] });
const fnDecl = (name) => ast.program.body.find((n) => n.type === "FunctionDeclaration" && n.id && n.id.name === name);
const varInit = (name) => {
  for (const st of ast.program.body) {
    if (st.type !== "VariableDeclaration") continue;
    const d = st.declarations.find((x) => x.id.type === "Identifier" && x.id.name === name);
    if (d) return d.init;
  }
  return null;
};

/* ---------- lift the real helpers and dictionaries out of the JSX ---------- */

const need = ["isIOSDevice", "isStandaloneDisplay", "pushSupported", "urlBase64ToUint8Array", "enablePushNotifications", "notifErrorText"];
ck("found every push helper in the source", need.map((n) => !!fnDecl(n)), need.map(() => true));
const helpersSrc = need.map((n) => { const d = fnDecl(n); return d ? JSX.slice(d.start, d.end) : ""; }).join("\n");
const i18nNode = varInit("I18N");
yes("the I18N dictionaries are found", i18nNode && i18nNode.type === "ObjectExpression");
const I18N = i18nNode ? new Function(`return (${JSX.slice(i18nNode.start, i18nNode.end)});`)() : { en: {}, fr: {}, es: {}, el: {} };
const LANGS = ["en", "fr", "es", "el"];

// An iPhone stood in for, so the real helpers run in Node. Safari defines
// navigator.standalone on iOS (false in a tab, true once launched from the Home
// Screen icon); matchMedia answers the display-mode query the installed launch
// sets. Calls record their order: requestPermission and subscribe are what a
// tab must never reach.
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
function iphone({ standalone = false, standaloneMedia = false, permission = "granted" } = {}) {
  const calls = [], queries = [];
  const sub = { toJSON: () => ({ endpoint: "https://push.example/e", keys: { p256dh: "p", auth: "a" } }) };
  const reg = { pushManager: { subscribe: async () => { calls.push("subscribe"); return sub; } } };
  const nav = {
    userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5, standalone,
    serviceWorker: { register: async (u) => { calls.push("register:" + u); return reg; } },
  };
  const win = {
    navigator: nav,
    matchMedia: (q) => { queries.push(q); return { matches: standaloneMedia && /\(display-mode:\s*standalone\)/.test(q) }; },
    PushManager: function PushManager() {},
  };
  const N = { permission: "default", requestPermission: async () => { calls.push("requestPermission"); return permission; } };
  win.Notification = N;
  const sb = { from: (table) => ({ upsert: async () => { calls.push("store:" + table); return { error: null }; } }) };
  const make = new Function("navigator", "window", "Notification", "sb", "VAPID_PUBLIC_KEY", "atob",
    helpersSrc + "\nreturn { enablePushNotifications, isIOSDevice, isStandaloneDisplay, notifErrorText };");
  return { calls, queries, ...make(nav, win, N, sb, "not-a-real-key", globalThis.atob) };
}
const FULL_PATH = ["requestPermission", "register:/sw.js", "subscribe", "store:push_subscriptions"];
// Turning notifications on, with a throw recorded as the result: an installed
// launch that throws is a failed check, not a crashed suite.
const turnOn = async (e) => {
  try { return await e.enablePushNotifications("athlete-1"); } catch (err) { return "threw " + ((err && err.code) || err); }
};

/* ---------- 2. the full-screen layout rules ---------- */

// Top-level rules of a stylesheet, comments removed: [{ selector, body }]. A rule
// inside @media is not top-level, so it cannot pass for the shell's own rule.
function topLevelRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let depth = 0, start = 0, selector = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") { if (depth === 0) { selector = src.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (c === "}") { depth--; if (depth === 0) { rules.push({ selector, body: src.slice(start, i) }); start = i + 1; } }
    else if (c === ";" && depth === 0) start = i + 1;
  }
  return rules;
}
// What a property ends up as across every top-level rule naming the selector:
// the LAST declaration wins, so a 100vh written after 100dvh would undo it.
function cascadeValue(rules, selector, prop) {
  let value = null;
  for (const r of rules) {
    if (!r.selector.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const decl of r.body.split(";")) {
      const m = /^\s*([-\w]+)\s*:\s*([\s\S]*?)\s*$/.exec(decl);
      if (m && m[1].toLowerCase() === prop) value = m[2].replace(/\s*!important$/i, "");
    }
  }
  return value;
}

const head = HTML.slice(0, HTML.indexOf("</head>"));
const viewport = /<meta[^>]+name="viewport"[^>]+content="([^"]*)"/i.exec(head);
const vp = Object.fromEntries((viewport ? viewport[1] : "").split(",").map((kv) => kv.split("=").map((s) => s.trim())));
ck("the viewport meta sets viewport-fit=cover (the page reaches under the status bar and home indicator)", vp["viewport-fit"], "cover");
ck("...and width=device-width", vp.width, "device-width");

ck("manifest display is standalone (Add to Home Screen opens without browser bars)", MANIFEST.display, "standalone");
yes("...and no display_override sends it back to a browser view",
  !MANIFEST.display_override || !MANIFEST.display_override.some((d) => d === "browser" || d === "minimal-ui"));

const headCss = (head.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).map((s) => s.replace(/<\/?style[^>]*>/gi, "")).join("\n");
ck("#root's min-height ends up 100dvh (golsz-app.html head)", cascadeValue(topLevelRules(headCss), "#root", "min-height"), "100dvh");

const cssNode = varInit("CSS");
yes("the app's CSS template string is found", cssNode && cssNode.type === "TemplateLiteral");
const appCss = cssNode && cssNode.type === "TemplateLiteral" ? cssNode.quasis.map((q) => q.value.raw).join("__expr__") : "";
ck(".app-shell's height ends up 100dvh (a top-level rule in CSS)", cascadeValue(topLevelRules(appCss), ".app-shell", "height"), "100dvh");

// The phone shell: the one element with className "app-shell", inside GolszApp.
const attr = (el, name) => el.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);
const tagName = (el) => (el.openingElement.name.type === "JSXIdentifier" ? el.openingElement.name.name : null);
const styleProps = (el) => {
  const a = el && attr(el, "style");
  const obj = a && a.value && a.value.type === "JSXExpressionContainer" ? a.value.expression : null;
  const out = {};
  if (obj && obj.type === "ObjectExpression") {
    for (const prop of obj.properties) {
      if (prop.type !== "ObjectProperty") continue;
      const k = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
      out[k] = JSX.slice(prop.value.start, prop.value.end);
    }
  }
  return out;
};
const shells = [];
(function walk(n) {
  if (!n || typeof n.type !== "string") return;
  if (n.type === "JSXElement") {
    const c = attr(n, "className");
    if (c && c.value && c.value.type === "StringLiteral" && c.value.value.split(/\s+/).includes("app-shell")) shells.push(n);
  }
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
  }
})(ast.program);
ck("exactly one element is the phone shell (.app-shell)", shells.length, 1);
const shell = shells[0];
const golsz = fnDecl("GolszApp");
yes("...and GolszApp renders it", shell && golsz && shell.start > golsz.start && shell.end < golsz.end);
const shellStyle = styleProps(shell);
yes("...and its inline style sets no height of its own (it would beat the 100dvh rule)",
  shell && !("height" in shellStyle) && !("maxHeight" in shellStyle));

const kids = shell ? shell.children.filter((c) => c.type === "JSXElement") : [];
const header = kids.find((c) => tagName(c) === "header");
const nav = kids.find((c) => tagName(c) === "nav");
const padding = (el, side) => ["padding", side].map((k) => styleProps(el)[k] || "").join(" ");
yes("the shell's header is padded by env(safe-area-inset-top) (clear of the status bar)",
  header && /env\(\s*safe-area-inset-top\b/.test(padding(header, "paddingTop")));
yes("the shell's bottom nav is padded by env(safe-area-inset-bottom) (clear of the home indicator)",
  nav && /env\(\s*safe-area-inset-bottom\b/.test(padding(nav, "paddingBottom")));

(async () => {
  /* ---------- 1. standalone detection, on an iPhone ---------- */

  const tab = iphone();
  ck("an iPhone is detected as iOS", tab.isIOSDevice(), true);
  ck("a Safari tab (ordinary browsing) is not standalone", tab.isStandaloneDisplay(), false);
  const viaMedia = iphone({ standaloneMedia: true });
  ck("matchMedia('(display-mode: standalone)') matching counts as installed", viaMedia.isStandaloneDisplay(), true);
  yes("...asked with the display-mode: standalone query",
    viaMedia.queries.some((q) => /\(display-mode:\s*standalone\)/.test(q)));
  ck("navigator.standalone === true counts as installed", iphone({ standalone: true }).isStandaloneDisplay(), true);

  for (const [label, opts] of [["display-mode media query", { standaloneMedia: true }], ["navigator.standalone", { standalone: true }]]) {
    const e = iphone(opts);
    ck(`installed (${label}): turning notifications on succeeds`, await turnOn(e), true);
    ck(`...asking for permission, then registering sw.js, subscribing and storing (${label})`, e.calls, FULL_PATH);
  }
  const refused = iphone({ standaloneMedia: true, permission: "denied" });
  ck("installed, permission refused: gives up", await turnOn(refused), false);
  ck("...without subscribing", refused.calls, ["requestPermission"]);

  let thrown = null, result = null;
  try { result = await tab.enablePushNotifications("athlete-1"); } catch (e) { thrown = e; }
  ck("a Safari tab throws", !!thrown, true);
  ck("...IOS_NEEDS_HOMESCREEN", thrown && thrown.code, "IOS_NEEDS_HOMESCREEN");
  ck("...before asking for permission or subscribing", tab.calls, []);
  ck("...and reports no success", result, null);

  // The thrown error, through the one mapper both notification buttons use.
  for (const lang of LANGS) {
    const dict = I18N[lang];
    const t = (k) => (typeof dict[k] === "string" ? dict[k] : k);
    const text = tab.notifErrorText(thrown, t);
    ck(`${lang}: the error reads as the notif_ios_homescreen text`, text, dict.notif_ios_homescreen);
    yes(`${lang}: ...a real translation, not the key or the generic retry line`,
      typeof text === "string" && text.length > 20 && text !== "notif_ios_homescreen" && text !== dict.notif_error);
  }
  yes("en: the message says to add GOLSZ to the Home Screen first", /home screen/i.test(I18N.en.notif_ios_homescreen));

  console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
