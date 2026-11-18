"use strict";

// PURE, DOM-FREE VERDICT for the installed (Home Screen) app at phone size
// (AVA job 235, t4-r3-2).
//
// tools/record-installed-fullscreen.cjs reads one snapshot per mode from a real
// headless Chrome (browserSnapshot, below, runs in the page) and hands it to
// installedVerdict here, in Node; tests/test_installed_fullscreen_verdict.cjs
// runs the same function on fixtures, so a recorded verdict comes from tested code.
//
// A snapshot is { mode: "standalone" | "tab", isStandalone, innerWidth, innerHeight,
// docScrollWidth, rootHeight, shellHeight, headerPadTop, navPadBottom, envTop,
// envBottom, content: [{ what, top }] } plus what the run asked for:
// { insetTop, insetBottom, safeArea: "applied" | "unsupported" }. envTop/envBottom
// are what CSS env(safe-area-inset-*) resolved to in the page, so an emulation
// Chrome accepted but did not apply reads as unsupported, never as a pass.

const TOL = 1; // css px: sub-pixel rounding

// Visible text or controls whose top sits inside the top inset (under the
// iPhone's status bar). Containers that only paint a background there (the
// header) are not in `content`, so they are not counted.
function underTopInset(content, insetTop, tol) {
  const t = typeof tol === "number" ? tol : TOL;
  if (!(insetTop > 0)) return [];
  return (content || []).filter(function (c) { return typeof c.top === "number" && c.top < insetTop - t; });
}

// Whether the run's safe-area emulation took effect in the page's CSS.
function safeAreaApplied(s) {
  return s.safeArea === "applied" && Math.abs(s.envTop - s.insetTop) <= TOL && Math.abs(s.envBottom - s.insetBottom) <= TOL;
}

function installedVerdict(snapshot) {
  const s = snapshot || {};
  const reasons = [], unsupported = [];
  const near = function (a, b) { return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= TOL; };
  if (s.mode === "tab") {
    if (s.isStandalone !== false) reasons.push("isStandaloneDisplay() is " + s.isStandalone + " in a browser tab (expected false)");
  } else {
    if (s.isStandalone !== true) reasons.push("isStandaloneDisplay() is " + s.isStandalone + " when installed (expected true)");
    if (!near(s.rootHeight, s.innerHeight)) reasons.push("#root is " + s.rootHeight + "px tall, the screen " + s.innerHeight + "px");
    if (!near(s.shellHeight, s.innerHeight)) reasons.push(".app-shell is " + s.shellHeight + "px tall, the screen " + s.innerHeight + "px");
  }
  if (!(typeof s.docScrollWidth === "number" && s.docScrollWidth <= s.innerWidth + TOL)) {
    reasons.push("document scrolls sideways (" + s.docScrollWidth + "/" + s.innerWidth + ")");
  }
  let under = [];
  if (s.mode !== "tab") {
    if (!safeAreaApplied(s)) {
      unsupported.push("safe-area emulation unsupported (env top/bottom read " + s.envTop + "/" + s.envBottom + ", asked " + s.insetTop + "/" + s.insetBottom + ")");
    } else {
      if (!(s.headerPadTop >= s.envTop - TOL)) reasons.push("header top padding " + s.headerPadTop + "px is less than the " + s.envTop + "px top inset");
      if (!(s.navPadBottom >= s.envBottom - TOL)) reasons.push("nav bottom padding " + s.navPadBottom + "px is less than the " + s.envBottom + "px bottom inset");
      under = underTopInset(s.content, s.envTop);
      if (under.length) reasons.push(under.length + " visible item(s) start under the " + s.envTop + "px top inset");
    }
  }
  return { pass: reasons.length === 0, reasons: reasons, unsupported: unsupported, underTopInset: under,
    doc: s.docScrollWidth + "/" + s.innerWidth, root: s.rootHeight + "/" + s.innerHeight, shell: s.shellHeight + "/" + s.innerHeight };
}

// Runs in Chrome (injected by its source). Reads the raw numbers only; the
// verdict is computed in Node by installedVerdict.
function browserSnapshot() {
  const px = function (v) { return Math.round(parseFloat(v) * 100) / 100 || 0; };
  const height = function (el) { return el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null; };
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const envTop = px(getComputedStyle(probe).paddingTop), envBottom = px(getComputedStyle(probe).paddingBottom);
  probe.remove();
  const shell = document.querySelector(".app-shell");
  const header = shell && (shell.querySelector(":scope > header") || shell.querySelector("header"));
  const nav = shell && (shell.querySelector(":scope > nav") || shell.querySelector("nav"));
  const vw = window.innerWidth, vh = window.innerHeight;
  const shown = function (el, r) {
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0"
      && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  // What a person reads or taps: text (measured by its own line box, not its
  // parent's padding box) and controls/images. Only the top 200px matters here.
  const content = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.data.trim() || !n.parentElement || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.top < 200 && shown(n.parentElement, r)) content.push({ what: "text \"" + n.data.trim().slice(0, 24) + "\"", top: Math.round(r.top * 100) / 100 });
  }
  document.querySelectorAll("button,a,input,select,textarea,img,svg,[role=button]").forEach(function (el) {
    const r = el.getBoundingClientRect();
    if (r.top < 200 && shown(el, r)) content.push({ what: el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? " " + el.getAttribute("aria-label") : ""), top: Math.round(r.top * 100) / 100 });
  });
  return {
    isStandalone: typeof window.isStandaloneDisplay === "function" ? window.isStandaloneDisplay() : "missing",
    matchStandalone: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: window.navigator.standalone === undefined ? "undefined" : window.navigator.standalone,
    innerWidth: vw, innerHeight: vh, docScrollWidth: document.documentElement.scrollWidth,
    rootHeight: height(document.querySelector("#root")), shellHeight: height(shell),
    headerPadTop: header ? px(getComputedStyle(header).paddingTop) : null,
    navPadBottom: nav ? px(getComputedStyle(nav).paddingBottom) : null,
    envTop: envTop, envBottom: envBottom, content: content,
  };
}

function snapshotExpression() { return "(" + browserSnapshot.toString() + ")()"; }

module.exports = { TOL, underTopInset, safeAreaApplied, installedVerdict, browserSnapshot, snapshotExpression };
