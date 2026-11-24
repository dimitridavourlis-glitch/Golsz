// PWA INSTALL + iPHONE NOTIFICATION COPY (AVA job 235, task t1).
//
// The finish line says an athlete uses GOLSZ between training sessions on their
// phone: every step installs to the Home Screen, and an iPhone is told to do
// that BEFORE it is asked for notification permission (iOS only supports real
// Web Push from a standalone Home Screen launch, never from Safari tabs).
//
// This suite pins the pieces, all read from the real committed files:
//   1. manifest.json — standalone display, start_url inside scope, name/
//      short_name/description, and BOTH a 192px and a 512px icon (generated
//      from the committed 1024px art).
//   2. golsz-app.html's head — viewport-fit=cover, apple-mobile-web-app-capable,
//      apple-touch-icon, the manifest link. golsz-app.jsx registers /sw.js
//      BEFORE it ever calls pushManager.subscribe.
//   3. The real enablePushNotifications/isIOSDevice/isStandaloneDisplay are
//      lifted out of the JSX and run: iOS + non-standalone throws
//      IOS_NEEDS_HOMESCREEN before requestPermission or subscribe; iOS +
//      standalone proceeds past that guard.
//   4. Both UI entry points (NotificationBell and SettingsButton) map that
//      error through notifErrorText to notif_ios_homescreen, and both are
//      driven in the component harness to show that message. The key is
//      genuinely translated in en/fr/es/el and names the Home Screen step.
//   5. notif_ios_homescreen is a translated key, not a raw English string.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

const JSX = read("golsz-app.jsx");
const HTML = read("golsz-app.html");
const MANIFEST = JSON.parse(read("manifest.json"));
const SW = read("sw.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};
const yes = (l, cond) => ck(l, !!cond, true);

/* ---------- 1. the web manifest ---------- */

ck("manifest display is standalone", MANIFEST.display, "standalone");
for (const k of ["name", "short_name", "description"]) {
  ck(`manifest ${k} is a non-empty string`, typeof MANIFEST[k] === "string" && MANIFEST[k].trim().length > 0, true);
}
yes("start_url is inside scope (so the installed app opens here)",
  typeof MANIFEST.start_url === "string" && typeof MANIFEST.scope === "string" &&
  MANIFEST.start_url.indexOf(MANIFEST.scope) === 0);
const sizes = (MANIFEST.icons || []).map((i) => i.sizes);
for (const s of ["192x192", "512x512"]) {
  yes(`manifest declares a ${s} icon`, sizes.includes(s));
  const icon = (MANIFEST.icons || []).find((i) => i.sizes === s);
  yes(`...and its file is committed (${icon && icon.src})`,
    !!icon && /\.png$/i.test(icon.src) && fs.existsSync(path.join(REPO, icon.src.replace(/^\//, ""))));
}

/* ---------- 2. the installed launch + service worker ---------- */

const head = HTML.slice(0, HTML.indexOf("</head>"));
yes("viewport keeps viewport-fit=cover (safe-area insets reach the CSS)",
  /<meta[^>]+name="viewport"[^>]+content="[^"]*viewport-fit=cover/i.test(head));
yes("apple-mobile-web-app-capable=yes (an installed launch runs standalone)",
  /<meta[^>]+name="apple-mobile-web-app-capable"[^>]+content="yes"/i.test(head));
yes("an apple-touch-icon is declared", /<link[^>]+rel="apple-touch-icon"[^>]+href="[^"]+"/i.test(head));
yes("the web manifest is linked in the head", /<link[^>]+rel="manifest"[^>]+href="[^"]*manifest\.json"/i.test(head));
yes("sw.js exists and is the push service worker", /addEventListener\(\s*["']push["']/.test(SW));
const srcAt = (re) => { const m = re.exec(JSX); return m ? m.index : -1; };
const iRegister = srcAt(/navigator\.serviceWorker\.register\(\s*["']\/sw\.js["']\s*\)/);
const iSubscribe = srcAt(/pushManager\.subscribe\(/);
yes("enablePushNotifications registers /sw.js before it subscribes",
  iRegister > 0 && iSubscribe > iRegister);

/* ---------- lift the real declarations out of the JSX ---------- */

const ast = parser.parse(JSX, { sourceType: "script", plugins: ["jsx"] });
const decls = new Map();
for (const st of ast.program.body) {
  if (st.type === "FunctionDeclaration" && st.id) decls.set(st.id.name, JSX.slice(st.start, st.end));
}
const need = ["isIOSDevice", "isStandaloneDisplay", "pushSupported", "urlBase64ToUint8Array", "enablePushNotifications", "notifErrorText"];
ck("found every push helper in the source", need.map((n) => decls.has(n)), need.map(() => true));
const helpersSrc = need.map((n) => decls.get(n)).join("\n");

// A browser stood in for, so the real helpers can run in Node. Calls record
// their order; requestPermission/subscribe are the two things the iOS guard
// must prevent in regular Safari.
function env({ ua, platform = "", maxTouchPoints = 0, standalone = false, standaloneMedia = false, permission = "granted" }) {
  const calls = [];
  const sub = { toJSON: () => ({ endpoint: "https://push.example/e", keys: { p256dh: "p", auth: "a" } }) };
  const reg = { pushManager: {
    subscribe: async () => { calls.push("subscribe"); return sub; },
    getSubscription: async () => null,
  } };
  const nav = {
    userAgent: ua, platform, maxTouchPoints,
    serviceWorker: { register: async (u) => { calls.push("register:" + u); return reg; }, getRegistration: async () => reg },
  };
  if (standalone) nav.standalone = true;
  const win = {
    navigator: nav,
    matchMedia: (q) => ({ matches: standaloneMedia && /display-mode:\s*standalone/.test(q) }),
    PushManager: function PushManager() {},
  };
  const N = { permission: "default", requestPermission: async () => { calls.push("requestPermission"); return permission; } };
  win.Notification = N;
  const sb = { from: () => ({ upsert: async () => ({ error: null }) }) };
  const make = new Function("navigator", "window", "Notification", "sb", "VAPID_PUBLIC_KEY", "atob",
    helpersSrc + "\nreturn { enablePushNotifications, isIOSDevice, isStandaloneDisplay, pushSupported, notifErrorText };");
  return { calls, ...make(nav, win, N, sb, "not-a-real-key", globalThis.atob) };
}
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

(async () => {
  /* ---------- 3. the guard itself ---------- */

  const blocked = env({ ua: IOS_UA });
  let thrown = null, result = null;
  try { result = await blocked.enablePushNotifications("athlete-1"); } catch (e) { thrown = e; }
  ck("iOS in a Safari tab throws", !!thrown, true);
  ck("...with the code the UI switches on", thrown && thrown.code, "IOS_NEEDS_HOMESCREEN");
  ck("...before asking for permission or subscribing", blocked.calls, []);
  ck("...and returns no success", result, null);

  // The other two ways iOS can look non-standalone, and the two ways it can be
  // standalone, all use the SAME real helpers.
  const ipad = env({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 });
  ck("an iPad (desktop UA + touch) is detected as iOS", ipad.isIOSDevice(), true);
  let ipadThrown = false;
  try { await ipad.enablePushNotifications("athlete-1"); } catch (e) { ipadThrown = e.code === "IOS_NEEDS_HOMESCREEN"; }
  ck("...and is blocked in a tab too", ipadThrown && ipad.calls.length === 0, true);

  for (const [label, opts] of [
    ["navigator.standalone", { ua: IOS_UA, standalone: true }],
    ["display-mode: standalone media query", { ua: IOS_UA, standaloneMedia: true }],
  ]) {
    const e = env(opts);
    ck(`iOS ${label} is detected as standalone`, e.isStandaloneDisplay(), true);
    const ok = await e.enablePushNotifications("athlete-1");
    ck(`...and the guard lets it through (${label})`, ok, true);
    ck(`...registering sw.js before subscribing (${label})`,
      e.calls, ["requestPermission", "register:/sw.js", "subscribe"]);
  }
  const android = env({ ua: ANDROID_UA });
  ck("a non-iOS device is not blocked by the iOS guard", await android.enablePushNotifications("athlete-1"), true);
  ck("...and takes the normal push path", android.calls, ["requestPermission", "register:/sw.js", "subscribe"]);
  const denied = env({ ua: ANDROID_UA, permission: "denied" });
  ck("a refused permission gives up before registering", await denied.enablePushNotifications("athlete-1"), false);
  ck("...with no subscribe call", denied.calls, ["requestPermission"]);

  /* ---------- the shared error message ---------- */

  const id = (k) => k;
  const { notifErrorText } = env({ ua: ANDROID_UA });
  ck("the iOS error maps to notif_ios_homescreen", notifErrorText({ code: "IOS_NEEDS_HOMESCREEN" }, id), "notif_ios_homescreen");
  ck("any other error maps to the generic retry line", notifErrorText({ code: "E" }, id), "notif_error");
  ck("a missing error maps to the generic retry line", notifErrorText(null, id), "notif_error");

  /* ---------- 4. both entry points use that mapping ---------- */

  const bodyOf = (name) => {
    const st = ast.program.body.find((n) => n.type === "FunctionDeclaration" && n.id && n.id.name === name);
    return st ? JSX.slice(st.start, st.end) : "";
  };
  for (const name of ["NotificationBell", "SettingsButton"]) {
    const body = bodyOf(name);
    yes(`${name} exists in the source`, !!body);
    yes(`${name} maps the error through notifErrorText`, /notifErrorText\(e,\s*t\)/.test(body));
  }
  yes("NotificationBell is actually rendered in both app headers",
    (JSX.match(/<NotificationBell\s*\/>/g) || []).length >= 2);

  /* ---------- driven in the real component harness ---------- */

  const { React, makeScope, mount, settle } = require("./_app_mount.cjs");
  const I18N = makeScope({ React }).get("I18N");
  const LANGS = ["en", "fr", "es", "el"];
  const t = (k) => (typeof I18N.en[k] === "string" ? I18N.en[k] : k);

  // The four translations really exist, are different from one another and
  // from the key, and name the Home Screen install step in each language.
  const HOME_WORDS = [/home screen/i, /écran d'accueil/i, /pantalla de inicio/i, /αρχική οθόνη/i];
  const SHARE_WORDS = [/share/i, /partager/i, /compartir/i, /κοινή χρήση/i];
  for (let i = 0; i < LANGS.length; i++) {
    const s = I18N[LANGS[i]].notif_ios_homescreen;
    ck(`${LANGS[i]}: notif_ios_homescreen is a real translation`, typeof s === "string" && s.length > 20 && s !== "notif_ios_homescreen", true);
    yes(`${LANGS[i]}: the message names the Home Screen install step`, HOME_WORDS[i].test(s));
    yes(`${LANGS[i]}: the message says to tap Share first`, SHARE_WORDS[i].test(s));
  }
  ck("the four translations are genuinely different", new Set(LANGS.map((l) => I18N[l].notif_ios_homescreen)).size, 4);

  // A signed-in athlete. enablePushNotifications is the REAL guard winner's
  // stand-in here: we force the exact error the iOS path throws, so the UI's
  // mapping is exercised without a phone.
  const iosError = () => { const e = new Error("iOS requires installing to the Home Screen first"); e.code = "IOS_NEEDS_HOMESCREEN"; throw e; };
  const fakeSb = {
    auth: { getUser: async () => ({ data: { user: { id: "athlete-1", email: "a@b.co" } } }) },
    from: () => {
      const q = { then: (res) => Promise.resolve({ data: null, error: null }).then(res) };
      for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
      q.single = () => q; q.maybeSingle = () => q;
      return q;
    },
  };
  const scope = (extra) => makeScope(Object.assign({
    React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    useLang: () => ({ t, lang: "en" }),
    sb: fakeSb,
    enablePushNotifications: iosError,
    pushSupported: () => true,
    Notification: { permission: "default" },
    navigator: { serviceWorker: { getRegistration: async () => null } },
    document: { documentElement: { setAttribute() {}, lang: "en" }, activeElement: null, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, location: { href: "" } },
    localStorage: { getItem: () => null, setItem() {} },
    ReactDOM: { createPortal: (el) => el },
    console: { log() {}, warn() {}, info() {}, error() {} },
  }, extra || {}));

  // (a) the header bell — one tap, message appears, no permission prompt.
  {
    const ui = mount(scope().get("NotificationBell"), {});
    await settle();
    const bell = ui.find((n) => n.type === "button");
    yes("the bell is a labelled button", !!(bell && bell.props["aria-label"]));
    await bell.props.onClick();
    await settle();
    yes("NotificationBell shows the install-first message", ui.text().includes(I18N.en.notif_ios_homescreen));
    yes("...and not the generic error", !ui.text().includes(I18N.en.notif_error));
  }
  // (b) the Settings toggle — open the modal, tap "Notifications On".
  {
    const ui = mount(scope().get("SettingsButton"), { openSignal: 0 });
    await settle();
    const gear = ui.find((n) => n.type === "button" && n.props.title === t("settings_title"));
    yes("SettingsButton renders its gear", !!gear);
    await gear.props.onClick();
    await settle();
    const on = ui.findAll((n) => n.type === "button").find((n) => (n.children || []).some((c) => c === t("settings_notif_on")));
    yes("the settings modal has a Notifications On button", !!on);
    await on.props.onClick();
    await settle();
    yes("SettingsButton shows the install-first message", ui.text().includes(I18N.en.notif_ios_homescreen));
    yes("...and not the generic error", !ui.text().includes(I18N.en.notif_error));
  }

  console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
