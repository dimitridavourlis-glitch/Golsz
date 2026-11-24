"use strict";

// PURE, DOM-FREE MEASUREMENT RULES for the 390px main-path walk (AVA job 235, t3).
//
// One definition of "fits a phone" is shared by two callers:
//   * tests/test_phone_main_path.cjs exercises these functions against fixtures,
//     including a known-good screen and a known-broken (2000px bar) screen;
//   * tools/check-phone-main-path.cjs injects their .toString() source into
//     Chrome's Runtime.evaluate, so the verdict a recorded run prints is
//     computed by the exact code the suite tests, not a copy.
//
// A snapshot is { innerWidth, docScrollWidth, elements: [...], buttons: [...] }.
// A box is { left, right, width, height, display, visibility, opacity }.
// A button also carries clips: [{ left, right }] — the box of each ancestor that
// scrolls or clips (computed overflowX/Y other than "visible"), in the same
// viewport coordinate space as the button's own getBoundingClientRect().

const TOL = 1; // css px: sub-pixel rounding is not a sideways scroll

function isVisibleBox(e) {
  return !!(e && e.width > 0 && e.height > 0 && e.display !== "none" && e.visibility !== "hidden" && e.opacity !== 0);
}

// Visible elements that begin on screen but end more than TOL past the right edge.
// A box parked entirely off-canvas to the right (left > vw) is a closed drawer,
// not something the athlete can see, so it is deliberately not counted here.
function pastRightEdge(elements, vw, tol) {
  const t = typeof tol === "number" ? tol : TOL;
  const edge = typeof vw === "number" ? vw : 0;
  return (elements || []).filter(function (e) {
    return isVisibleBox(e) && e.left <= edge + t && e.right > edge + t;
  });
}

// Buttons whose own box pokes outside a clipping ancestor's box. `clips` is
// empty when no ancestor scrolls/clips, in which case a button cannot be
// clipped. Comparing viewport-space rects also catches a button hidden under a
// horizontally scrolled container (scrollLeft changes both rects together).
function clippedButtons(buttons, tol) {
  const t = typeof tol === "number" ? tol : TOL;
  return (buttons || []).filter(function (b) {
    if (!isVisibleBox(b)) return false;
    return (b.clips || []).some(function (c) {
      return b.right > c.right + t || b.left < c.left - t;
    });
  });
}

// The whole verdict for one screen. Reasons are plain English so a recorded
// run can name exactly why a screen failed. pass=true only when all three
// acceptance conditions hold: the document does not scroll sideways, no
// visible element reaches past the right edge, and no button is clipped.
function screenVerdict(s) {
  const snap = s || {};
  const vw = typeof snap.innerWidth === "number" ? snap.innerWidth : 0;
  const reasons = [];
  if (typeof snap.docScrollWidth === "number" && snap.docScrollWidth > vw + TOL) {
    reasons.push("document scrolls sideways (" + snap.docScrollWidth + "/" + vw + ")");
  }
  const past = pastRightEdge(snap.elements, vw);
  if (past.length) reasons.push(past.length + " visible element(s) past the right edge");
  const clipped = clippedButtons(snap.buttons);
  if (clipped.length) reasons.push(clipped.length + " button(s) clipped by an overflow ancestor");
  return { pass: reasons.length === 0, reasons: reasons, past: past, clipped: clipped,
    doc: (typeof snap.docScrollWidth === "number" ? snap.docScrollWidth : "?") + "/" + vw,
    innerWidth: vw, pastCount: past.length, clippedCount: clipped.length };
}

// Runs in Chrome. Collects the snapshot from the live DOM, then hands it to
// screenVerdict. Injected together with the four helpers above by
// measureExpression(), so the browser uses the same function bodies.
function browserMeasure() {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const elements = [], buttons = [];
  const all = document.querySelectorAll("body *");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const box = { tag: tag.toLowerCase(), id: el.id || "", left: r.left, right: r.right,
      width: r.width, height: r.height, display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
    elements.push(box);
    if (tag === "BUTTON" || el.getAttribute("role") === "button") {
      const clips = [];
      for (let p = el.parentElement; p && p !== doc; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === "visible" && pcs.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        clips.push({ left: pr.left, right: pr.right });
      }
      const label = el.getAttribute("aria-label") || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      buttons.push(Object.assign({ label: label }, box, { clips: clips }));
    }
  }
  return screenVerdict({ innerWidth: vw, docScrollWidth: doc.scrollWidth, elements: elements, buttons: buttons });
}

// The Runtime.evaluate expression. An IIFE keeps the helper names out of the
// page's globals. Every function the collector calls is injected from its own
// source, and TOL is injected too, so there is one definition of the rules.
function measureExpression() {
  const defs = [isVisibleBox, pastRightEdge, clippedButtons, screenVerdict].map(function (f) {
    return "var " + f.name + "=" + f.toString() + ";";
  }).join("");
  return "(function(){var TOL=" + TOL + ";" + defs + "return (" + browserMeasure.toString() + ")();})()";
}

module.exports = { TOL, isVisibleBox, pastRightEdge, clippedButtons, screenVerdict, browserMeasure, measureExpression };
