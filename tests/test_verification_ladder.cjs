// WHAT MAY BE CALLED VERIFIED.
//
// The brief names seven levels and one rule above all of them: never display
// self-reported information as verified. Four of the seven are structurally
// unreachable — COACH, CLUB, PROVIDER and GOLSZ verification all require an
// actor GOLSZ does not have, because no coach, club, data provider or review
// process exists in the system. An athlete picking "Official / combine" from
// a dropdown is still the athlete saying so.
//
// So this suite does two things. It pins the ladder as one list, so nobody
// re-derives a different set of levels later. And it runs
// benchmarkVerification on inputs that LOOK like third-party verification —
// measured_by "coach", measured_by "official" — and asserts the answer is
// still SELF. That is the assertion worth having: the grep half of this file
// would pass on a function that promoted a dropdown value to COACH-VERIFIED.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the ladder is declared once, and declares all seven -------------------
const declAt = APP.indexOf("const VERIFICATION = {");
ck("the ladder is declared", declAt > 0, true);
const declEnd = APP.indexOf("};", declAt);
const decl = APP.slice(declAt, declEnd);
for (const level of ["UNKNOWN", "SELF", "UPLOADED", "VIDEO", "COACH", "CLUB", "PROVIDER", "GOLSZ"]) {
  ck(`...with ${level}`, new RegExp("\\n  " + level + ": \"").test(decl), true);
}
ck("...declared at the top level, not inside a component", /\nconst VERIFICATION = \{/.test(APP), true);

// The four unreachable levels must say so where they are declared, or the
// next person wires a UI to one of them.
for (const level of ["COACH", "CLUB", "PROVIDER", "GOLSZ"]) {
  const line = decl.split("\n").find((l) => l.trim().startsWith(level + ":")) || "";
  ck(`${level} is marked unreachable at its declaration`, /UNREACHABLE/.test(line), true);
}

// ---- behaviour: run the real function --------------------------------------
// Both blocks are self-contained — benchmarkVerification reads only
// VERIFICATION — so they evaluate standalone. If that stops being true this
// throws rather than silently testing nothing.
const fnAt = APP.indexOf("function benchmarkVerification(entry) {");
ck("benchmarkVerification exists", fnAt > 0, true);
const fnEnd = APP.indexOf("\n}", fnAt) + 2;
const reachAt = APP.indexOf("const VERIFICATION_REACHABLE = ");
const sandbox = {};
vm.createContext(sandbox);
const RESULT = vm.runInContext(
  APP.slice(declAt, declEnd + 2) + "\n" +
  APP.slice(reachAt, APP.indexOf("\n", reachAt)) + "\n" +
  APP.slice(fnAt, fnEnd) + "\n" +
  "({ V: VERIFICATION, REACHABLE: VERIFICATION_REACHABLE, fn: benchmarkVerification })",
  sandbox
);
const { V, REACHABLE, fn } = RESULT;

ck("exactly four levels are reachable", REACHABLE.length, 4);
ck("...and they are the four with no third party in them",
  REACHABLE.slice().sort(), [V.UNKNOWN, V.SELF, V.UPLOADED, V.VIDEO].slice().sort());
for (const level of [V.COACH, V.CLUB, V.PROVIDER, V.GOLSZ]) {
  ck(`${level} is not reachable`, REACHABLE.includes(level), false);
}

// A reading with nothing recorded about how it was taken is UNKNOWN, not SELF.
// Those are different claims and the Passport renders them differently.
ck("no entry at all is UNKNOWN", fn(null), V.UNKNOWN);
ck("a bare value is UNKNOWN", fn({ value: "11.2", unit: "s" }), V.UNKNOWN);
ck("an empty protocol object is UNKNOWN", fn({ value: "11.2", protocol: {} }), V.UNKNOWN);

// A method recorded by the athlete is SELF — including when the athlete says
// someone else took it. THIS is the assertion the rule is about.
ck("a recorded protocol is SELF-REPORTED", fn({ protocol: { surface: "track" } }), V.SELF);
ck('measured_by "self" is SELF-REPORTED', fn({ measured_by: "self" }), V.SELF);
ck('measured_by "coach" is STILL SELF-REPORTED, not COACH-VERIFIED', fn({ measured_by: "coach" }), V.SELF);
ck('measured_by "official" is STILL SELF-REPORTED, not CLUB-VERIFIED', fn({ measured_by: "official" }), V.SELF);

// Whatever is thrown at it, the answer stays inside the reachable set.
const probes = [null, undefined, {}, { measured_by: "coach" }, { measured_by: "official" },
  { protocol: { surface: "track" }, measured_by: "official" }, { verified: true },
  { verification: "golsz_verified" }, { protocol: null, measured_by: "" }];
ck("every input lands on a reachable level",
  probes.every((x) => REACHABLE.includes(fn(x))), true);
ck("...and none of them reaches a verified level",
  probes.some((x) => [V.COACH, V.CLUB, V.PROVIDER, V.GOLSZ].includes(fn(x))), false);

// ---- the chip must not look like a badge -----------------------------------
const tagAt = APP.indexOf("function VerifyTag(");
ck("VerifyTag exists", tagAt > 0, true);
const tag = APP.slice(tagAt, APP.indexOf("\n}", tagAt));
ck("...and is not rendered in gold", /C\.lime/.test(tag), false);
ck("...it covers each reachable level", ["verify_self", "verify_uploaded", "verify_video", "verify_unverified"]
  .every((k) => tag.includes('t("' + k + '")')), true);

// ---- it is actually on screen ----------------------------------------------
ck("every benchmark reading renders its level",
  /<VerifyTag level=\{benchmarkVerification\(e\)\} t=\{t\} \/>/.test(APP), true);
ck("...and the card says once who produced the numbers",
  /items\.length > 0 && \([\s\S]{0,260}t\("verify_bench_note"\)/.test(APP), true);

// ---- four languages --------------------------------------------------------
const KEYS = ["verify_self", "verify_uploaded", "verify_video", "verify_unverified", "verify_bench_note"];
for (const lang of ["en", "fr", "es", "el"]) {
  const at = APP.indexOf("\n  " + lang + ": {");
  ck(`${lang} dictionary found`, at > 0, true);
  const dict = APP.slice(at, APP.indexOf("\n  },", at));
  for (const k of KEYS) ck(`  ${lang}.${k}`, new RegExp("\\b" + k + ': "[^"]+"').test(dict), true);
}

// The compiled bundle is what ships.
const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("the ladder is in the compiled bundle", JS.includes("benchmarkVerification"), true);
ck("...and so is the chip", JS.includes("VerifyTag"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
