// THE 390px "FITS ON A PHONE" MEASUREMENT (AVA job 235, t3).
//
// The recorded run (tools/check-phone-main-path.cjs) walks the main path in
// Chrome and prints a pass/fail per screen. That verdict must be able to come
// out BOTH ways, or it proves nothing. This suite exercises the pure helpers
// behind that verdict against a known-good screen and a known-broken one (a
// 2000px bar plus a button clipped by its scroll container). The same helper
// sources are injected into Chrome, so a change here is a change to the run.
const M = require("../tools/_phone-measure.cjs");

let p = 0, f = 0;
const ck = (label, actual, expected) => {
  const A = JSON.stringify(actual), E = JSON.stringify(expected);
  if (A === E) { p++; console.log("PASS  " + label); }
  else { f++; console.log(`FAIL  ${label}\n   exp ${E}\n   got ${A}`); }
};

const box = (left, right, extra) => Object.assign({ left, right, width: right - left, height: 40, display: "block", visibility: "visible", opacity: 1 }, extra || {});
const btn = (left, right, clips, extra) => Object.assign(box(left, right), { label: "Button", clips: clips || [] }, extra || {});

// A screen that fits: viewport and document both 390, ordinary content, a
// header button unclipped, and a scrollable panel whose button sits inside it.
const good = {
  innerWidth: 390,
  docScrollWidth: 390,
  elements: [box(0, 390), box(16, 200), box(200, 374), box(0, 390)],
  buttons: [btn(300, 374, [{ left: 0, right: 390 }]), btn(24, 140, [{ left: 0, right: 390 }, { left: 0, right: 390 }])],
};

// A screen that does not fit. The bar starts on screen and runs to 2000px, so
// it both scrolls the document sideways and reaches past the right edge. The
// "Save" button ends past its panel's 390px clip, so it is visibly cut off.
const broken = {
  innerWidth: 390,
  docScrollWidth: 2000,
  elements: good.elements.concat([box(0, 2000, { tag: "div", height: 1 })]),
  buttons: good.buttons.concat([btn(320, 460, [{ left: 0, right: 390 }], { label: "Save" })]),
};

// --- visible box gate -------------------------------------------------------
ck("isVisibleBox: an ordinary laid-out box is visible", M.isVisibleBox(box(0, 100)), true);
ck("isVisibleBox: display:none, hidden, zero-size and transparent are not", [
  M.isVisibleBox(box(0, 100, { display: "none" })),
  M.isVisibleBox(box(0, 100, { visibility: "hidden" })),
  M.isVisibleBox(box(0, 0)),
  M.isVisibleBox(box(0, 100, { opacity: 0 })),
  M.isVisibleBox(null),
], [false, false, false, false, false]);

// --- past right edge --------------------------------------------------------
ck("pastRightEdge: the good screen has nothing past the edge", M.pastRightEdge(good.elements, 390), []);
const bar = broken.elements[broken.elements.length - 1];
ck("pastRightEdge: the 2000px bar is flagged", M.pastRightEdge(broken.elements, 390).map((e) => e.right), [2000]);
ck("pastRightEdge: a box exactly at the edge is fine; 1.5px past is not", [
  M.pastRightEdge([box(0, 390)], 390).length,
  M.pastRightEdge([box(0, 391.5)], 390).length,
], [0, 1]);
ck("pastRightEdge: a closed drawer parked to the right is not visible content", M.pastRightEdge([box(1200, 1600)], 390), []);
ck("pastRightEdge: hidden / zero-size boxes are ignored", M.pastRightEdge([
  box(0, 2000, { display: "none" }), box(0, 2000, { width: 0, height: 0 }),
], 390), []);
ck("pastRightEdge: a custom tolerance is honoured", [
  M.pastRightEdge([box(0, 392)], 390, 2).length,
  M.pastRightEdge([box(0, 393)], 390, 2).length,
], [0, 1]);

// --- clipped buttons --------------------------------------------------------
ck("clippedButtons: buttons inside their clip on the good screen are fine", M.clippedButtons(good.buttons), []);
ck("clippedButtons: a button with no clipping ancestor cannot be clipped", M.clippedButtons([btn(320, 800, [])]), []);
ck("clippedButtons: Save ending past its panel's clip is flagged", M.clippedButtons(broken.buttons).map((b) => b.label), ["Save"]);
ck("clippedButtons: a button clipped on the left is flagged too", M.clippedButtons([btn(-20, 80, [{ left: 0, right: 390 }], { label: "Back" })]).map((b) => b.label), ["Back"]);
ck("clippedButtons: a hidden or zero-size button is ignored", M.clippedButtons([
  btn(320, 800, [{ left: 0, right: 390 }], { display: "none" }),
  btn(320, 800, [{ left: 0, right: 390 }], { width: 0, height: 0 }),
]), []);

// --- combined verdict: the outcome the recorded run reports ----------------
const goodVerdict = M.screenVerdict(good);
ck("screenVerdict: a screen that fits passes with no reasons", { pass: goodVerdict.pass, reasons: goodVerdict.reasons }, { pass: true, reasons: [] });
const badVerdict = M.screenVerdict(broken);
ck("screenVerdict: the broken screen fails for all three reasons", { pass: badVerdict.pass, reasons: badVerdict.reasons }, {
  pass: false,
  reasons: ["document scrolls sideways (2000/390)", "1 visible element(s) past the right edge", "1 button(s) clipped by an overflow ancestor"],
});
ck("screenVerdict: the pass field is decided by the reasons, never hardcoded", [
  M.screenVerdict({ innerWidth: 390, docScrollWidth: 2000, elements: [], buttons: [] }).pass,
  M.screenVerdict({ innerWidth: 390, docScrollWidth: 390, elements: [box(0, 2000)], buttons: [] }).pass,
  M.screenVerdict({ innerWidth: 390, docScrollWidth: 390, elements: [], buttons: [btn(320, 800, [{ left: 0, right: 390 }])] }).pass,
], [false, false, false]);
ck("screenVerdict: an empty snapshot passes (nothing measured is not a failure)", M.screenVerdict(null).pass, true);

// --- the Chrome injection is the same code ---------------------------------
const expr = M.measureExpression();
for (const fn of ["isVisibleBox", "pastRightEdge", "clippedButtons", "screenVerdict"]) {
  ck("measureExpression injects " + fn + " from its own source", expr.includes("var " + fn + "=" + M[fn].toString() + ";"), true);
}
ck("measureExpression injects the collector and returns its verdict",
  expr.includes("return (" + M.browserMeasure.toString() + ")();") && expr.startsWith("(function(){var TOL=1;"), true);
// Running the injected expression in Node with a stubbed DOM proves the browser
// path produces the same verdict shapes the suite asserts on above. No copy.
const docEl = { scrollWidth: 390 };
const stubEls = good.elements.map((b) => ({ tagName: "DIV", id: "", getAttribute: () => null, parentElement: null,
  getBoundingClientRect: () => ({ left: b.left, right: b.right, width: b.width, height: b.height }),
  _box: b }));
const stubBtns = good.buttons.map((b) => ({ tagName: "BUTTON", id: "", textContent: b.label, getAttribute: () => null, parentElement: null,
  getBoundingClientRect: () => ({ left: b.left, right: b.right, width: b.width, height: b.height }), _box: b }));
const result = (function () {
  const window = { innerWidth: 390 };
  const document = { documentElement: docEl, querySelectorAll: () => stubEls.concat(stubBtns) };
  const getComputedStyle = (el) => ({ display: el._box.display, visibility: el._box.visibility, opacity: el._box.opacity, overflowX: "visible", overflowY: "visible" });
  // Evaluate exactly the string Chrome evaluates, with the DOM stand-ins in scope.
  return eval(expr);
})();
ck("the injected Chrome expression computes a passing verdict on the good screen", { pass: result.pass, reasons: result.reasons }, { pass: true, reasons: [] });

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
