// WHAT MAY BE CALLED VERIFIED, AND IN WHOSE WORDS.
//
// The brief names seven verification states and one rule above all of them:
// never display self-reported information as verified. Those states are
// DISPLAY LABELS here, over the evidence_tiers ladder api/scout.js already
// validates. GOLSZ had four provenance vocabularies before this; a fifth set
// of words for the same idea is the failure mode, not the feature. So the
// first thing this suite asserts is that there is still only one list, and
// that the client's copy matches the server's byte for byte — a drift means
// the server accepts a tier the Passport cannot render.
//
// Then it runs benchmarkTier on inputs that LOOK like third-party
// verification — measured_by "coach", measured_by "official", a planted
// verified flag — and asserts the answer is still athlete_stated. That is the
// assertion worth having: a grep-only version of this file would pass on a
// function that promoted a dropdown value to "Coach evaluation".

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- one list, and the two copies agree ------------------------------------
const evalList = (src, decl) => {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("[", at);
  const close = src.indexOf("]", open);
  return vm.runInNewContext(src.slice(open, close + 1));
};
const CLIENT = evalList(APP, "const EVIDENCE_TIERS = [");
const SERVER = evalList(SCOUT, "evidence_tiers: [");

ck("the client declares the tier list", Array.isArray(CLIENT), true);
ck("the server declares the tier list", Array.isArray(SERVER), true);
ck("THE TWO COPIES ARE IDENTICAL, IN ORDER", CLIENT, SERVER);
ck("...and it is the seven-tier ladder", CLIENT, [
  "ai_inferred", "athlete_stated", "parent_stated", "coach_evaluation",
  "measured_test", "official_competition_result", "verified_third_party",
]);
ck("no fifth vocabulary was introduced alongside it", /VERIFICATION_REACHABLE|benchmarkVerification/.test(APP), false);
ck("the client list is top level, not inside a component", /\nconst EVIDENCE_TIERS = \[/.test(APP), true);

// ---- behaviour: run the real function --------------------------------------
// benchmarkTier reads only EVIDENCE_TIERS, so both evaluate standalone. If
// that stops being true this throws rather than silently testing nothing.
const declAt = APP.indexOf("const EVIDENCE_TIERS = [");
const reachAt = APP.indexOf("const BENCH_TIERS_REACHABLE = [");
const fnAt = APP.indexOf("function benchmarkTier(entry) {");
ck("benchmarkTier exists", fnAt > 0, true);
const { TIERS, REACHABLE, fn } = vm.runInNewContext(
  APP.slice(declAt, APP.indexOf("];", declAt) + 2) + "\n" +
  APP.slice(reachAt, APP.indexOf("\n", reachAt)) + "\n" +
  APP.slice(fnAt, APP.indexOf("\n}", fnAt) + 2) + "\n" +
  "({ TIERS: EVIDENCE_TIERS, REACHABLE: BENCH_TIERS_REACHABLE, fn: benchmarkTier })"
);

ck("exactly one tier is reachable for a reading today", REACHABLE, ["athlete_stated"]);
for (const t of ["coach_evaluation", "measured_test", "official_competition_result", "verified_third_party", "ai_inferred", "parent_stated"]) {
  ck(`${t} is not reachable`, REACHABLE.includes(t), false);
}

// Nothing recorded, and a method recorded, are the same provenance: the
// athlete typed the number either way. The METHOD being unknown is a separate
// line on screen (bench_method_none), not a different tier.
ck("no entry at all is athlete_stated", fn(null), "athlete_stated");
ck("a bare value is athlete_stated", fn({ value: "11.2", unit: "s" }), "athlete_stated");
ck("a recorded protocol is athlete_stated", fn({ protocol: { surface: "track" } }), "athlete_stated");
ck('measured_by "self" is athlete_stated', fn({ measured_by: "self" }), "athlete_stated");

// THIS is the assertion the brief's rule is about.
ck('measured_by "coach" does NOT become coach_evaluation', fn({ measured_by: "coach" }), "athlete_stated");
ck('measured_by "official" does NOT become official_competition_result', fn({ measured_by: "official" }), "athlete_stated");
ck("a planted verified flag changes nothing", fn({ verified: true, verified_by: "club" }), "athlete_stated");
ck("...nor does a planted tier under the wrong key", fn({ verification: "verified_third_party" }), "athlete_stated");

// A stored tier is honoured, so the day per-claim provenance lands there is
// one place to change — and an unrecognised value falls DOWN, never up.
ck("a stored tier is honoured", fn({ evidence_quality: "official_competition_result" }), "official_competition_result");
ck("an unrecognised stored tier falls back down", fn({ evidence_quality: "club_verified" }), "athlete_stated");
ck("...including one that is merely truthy", fn({ evidence_quality: true }), "athlete_stated");

// Whatever is thrown at it, the answer is a real tier.
const probes = [null, undefined, {}, { measured_by: "coach" }, { measured_by: "official" },
  { protocol: { surface: "track" }, measured_by: "official" }, { verified: true },
  { evidence_quality: "" }, { evidence_quality: "nonsense" }, { protocol: null, measured_by: "" }];
ck("every input lands on a declared tier", probes.every((x) => TIERS.includes(fn(x))), true);
ck("...and no athlete-entered input reaches a verified tier",
  probes.some((x) => ["coach_evaluation", "measured_test", "official_competition_result", "verified_third_party"].includes(fn(x))), false);

// ---- the chip must not look like a badge -----------------------------------
const tagAt = APP.indexOf("function VerifyTag(");
ck("VerifyTag exists", tagAt > 0, true);
const tag = APP.slice(tagAt, APP.indexOf("\n}", tagAt));
ck("...and is not rendered in gold", /C\.lime/.test(tag), false);
ck("...it labels the tier through i18n", tag.includes('t("tier_" + tier)'), true);

// ---- it is actually on screen ----------------------------------------------
ck("every benchmark reading renders its tier",
  /<VerifyTag tier=\{benchmarkTier\(e\)\} t=\{t\} \/>/.test(APP), true);
ck("...and the card says once who produced the numbers",
  /items\.length > 0 && \([\s\S]{0,260}t\("verify_bench_note"\)/.test(APP), true);

// ---- four languages, every tier labelled -----------------------------------
// A tier with no label renders a raw snake_case string to a scout, so the
// label set must cover the whole ladder, not just the reachable part.
for (const lang of ["en", "fr", "es", "el"]) {
  const at = APP.indexOf("\n  " + lang + ": {");
  ck(`${lang} dictionary found`, at > 0, true);
  const dict = APP.slice(at, APP.indexOf("\n  },", at));
  const missing = CLIENT.filter((tier) => !new RegExp("\\btier_" + tier + ': "[^"]+"').test(dict));
  ck(`  ${lang} labels every tier`, missing, []);
  ck(`  ${lang}.verify_bench_note`, /\bverify_bench_note: "[^"]+"/.test(dict), true);
}

// The compiled bundle is what ships.
const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("the ladder is in the compiled bundle", JS.includes("benchmarkTier"), true);
ck("...and so is the chip", JS.includes("VerifyTag"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
