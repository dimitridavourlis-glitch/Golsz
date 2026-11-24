// RECORDED RUN — the Settings notification toggle under an iOS user agent in
// a regular (non-standalone) tab. Task t1's finish-line item: the athlete must
// see the "add to Home Screen first" message and must NOT be shown a browser
// permission prompt. Run: node tools/record-ios-install-notice.cjs
//
// This uses the app's OWN compiled-at-author-time declarations: it lifts the
// real enablePushNotifications / isIOSDevice / isStandaloneDisplay out of
// golsz-app.jsx, gives them an iOS stand-in browser whose requestPermission and
// pushManager.subscribe record (and refuse) any call, and drives the real
// mounted SettingsButton to the "Notifications On" tap. No network, no secrets.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const REPO = path.join(__dirname, "..");
const JSX = fs.readFileSync(path.join(REPO, "golsz-app.jsx"), "utf8");

const ast = parser.parse(JSX, { sourceType: "script", plugins: ["jsx"] });
const decls = new Map();
for (const st of ast.program.body) {
  if (st.type === "FunctionDeclaration" && st.id) decls.set(st.id.name, JSX.slice(st.start, st.end));
}
const names = ["isIOSDevice", "isStandaloneDisplay", "pushSupported", "urlBase64ToUint8Array", "enablePushNotifications", "notifErrorText"];
const helpers = new Function("navigator", "window", "Notification", "sb", "VAPID_PUBLIC_KEY", "atob",
  names.map((n) => decls.get(n)).join("\n") +
  "\nreturn { enablePushNotifications, notifErrorText };");

const calls = [];
const forbidden = (name) => () => { calls.push(name); const e = new Error(name + " must not be called on iOS before install"); e.code = "SHOULD_NOT_BE_CALLED"; throw e; };
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const reg = { pushManager: { subscribe: forbidden("subscribe"), getSubscription: async () => null } };
const nav = { userAgent: IOS_UA, platform: "iPhone", maxTouchPoints: 1,
  serviceWorker: { register: forbidden("register"), getRegistration: async () => reg } };
const Notification = { permission: "default", requestPermission: forbidden("requestPermission") };
const win = { navigator: nav, Notification, PushManager: function () {},
  matchMedia: () => ({ matches: false }) };
const real = helpers(nav, win, Notification, { from: () => ({ upsert: async () => ({ error: null }) }) }, "stand-in", globalThis.atob);

const { React, makeScope, mount, settle } = require("../tests/_app_mount.cjs");
const I18N = makeScope({ React }).get("I18N");
const t = (k) => (typeof I18N.en[k] === "string" ? I18N.en[k] : k);
const fakeSb = {
  auth: { getUser: async () => ({ data: { user: { id: "athlete-1", email: "a@b.co" } } }) },
  from: () => {
    const q = { then: (res) => Promise.resolve({ data: null, error: null }).then(res) };
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.single = () => q; q.maybeSingle = () => q;
    return q;
  },
};
const scope = makeScope({
  React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
  useLang: () => ({ t, lang: "en" }), sb: fakeSb,
  enablePushNotifications: real.enablePushNotifications,   // the REAL guard
  pushSupported: () => true, Notification, navigator: nav,
  document: { documentElement: { setAttribute() {}, lang: "en" }, activeElement: null, addEventListener() {}, removeEventListener() {} },
  window: { addEventListener() {}, removeEventListener() {}, location: { href: "" } },
  localStorage: { getItem: () => null, setItem() {} },
  ReactDOM: { createPortal: (el) => el },
  console: { log() {}, warn() {}, info() {}, error() {} },
});

(async () => {
  const ui = mount(scope.get("SettingsButton"), { openSignal: 0 });
  await settle();
  await ui.find((n) => n.type === "button" && n.props.title === t("settings_title")).props.onClick();
  await settle();
  const on = ui.findAll((n) => n.type === "button").find((n) => (n.children || []).some((c) => c === t("settings_notif_on")));
  if (!on) throw new Error("Settings modal had no Notifications On button");
  await on.props.onClick();
  await settle();
  const shown = ui.text();
  const record = {
    userAgent: IOS_UA, standalone: false,
    installMessageShown: shown.includes(I18N.en.notif_ios_homescreen),
    genericErrorShown: shown.includes(I18N.en.notif_error),
    calls,
    permissionPromptCount: calls.filter((c) => c === "requestPermission").length,
    subscribeCallCount: calls.filter((c) => c === "subscribe").length,
    serviceWorkerRegisterCount: calls.filter((c) => c === "register").length,
  };
  console.log("settings-notification-toggle iOS/non-standalone: " + JSON.stringify(record));
  const pass = record.installMessageShown && !record.genericErrorShown && record.permissionPromptCount === 0 && record.subscribeCallCount === 0;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
