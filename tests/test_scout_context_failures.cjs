// A FAILED READ MUST NOT RENDER AS AN EMPTY ATHLETE.
//
// api/scout.js loads the athlete's context with eight Supabase reads (one
// parallel round since 2026-10-28; they were sequential before). Every one of them used to sit in `try { ... } catch {}` with a
// completely empty handler, and none of them checked r.ok. A PostgREST error
// body is an OBJECT rather than an array, so each `Array.isArray(rows)` guard
// turned a 500 into exactly the same result as a legitimately empty table.
//
// The consequence was not a missing sentence. With the athletes read failing,
// `sport` stays null and `profileComplete` is false, so ATHLETE STATE told the
// model the passport was empty — and Scout then told an athlete with a
// complete passport to go and fill it in, and answered sport questions with no
// idea what sport they played. It advised confidently on data it had failed to
// read, which is the one thing its own EPISTEMIC RULES forbid.
//
// This suite RUNS the loader against a failing database rather than grepping
// it, because "there is a catch block" was never the question.
const fs = require("fs");
const path = require("path");
// REPO + "/api/scout.js", not path.join(__dirname, ".."): tests/test_anchor_
// integrity.cjs discovers which source a suite reads by pulling the first
// quoted string out of the readFileSync call, so the path.join form hands it
// ".." and it then reports every anchor in this file as dead. Matching the
// convention the other suites use is the fix, not an exemption.
const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the shape of the fix, pinned -----------------------------------------
const TABLES = ["athletes", "profiles", "scout_daily_usage", "verification_requests",
                "pathway_plan", "development_plan_items", "outreach_targets", "athlete_benchmarks"];

// Scoped to the I/O REGION only — the eight reads — and not to the whole
// function. There is a legitimately empty catch further down around
// firstName, which parses a string already in memory: it touches no network,
// has no table to name, and a malformed name genuinely should fall back to
// null. A rule that banned every empty catch would have forced a meaningless
// log line there and taught the next person to ignore the rule.
const loaderStart = SRC.indexOf("// A FAILED READ IS NOT AN EMPTY TABLE.");
const READS_END_MARK = '} catch (e) { loadFailed.push("athlete_benchmarks")';
const loaderEnd = SRC.indexOf(READS_END_MARK, loaderStart);
if (loaderStart < 0 || loaderEnd < 0) throw new Error("context loader markers moved");
const LOADER = SRC.slice(loaderStart, SRC.indexOf("\n", loaderEnd) + 1);

ck("no silent catch survives among the eight reads", /\} catch \{\}/.test(LOADER.replace(/^\s*\/\/.*$/gm, "")), false);
for (const t of TABLES) {
  ck(`${t}: its failure is named in the log`,
     new RegExp(`loadFailed\\.push\\("${t}"\\)`).test(LOADER), true);
  ck(`${t}: a non-2xx is treated as a failure, not an empty table`,
     new RegExp(`throw new Error\\("${t} " \\+`).test(LOADER), true);
}
ck("the failures leave the loader on athleteState", /^\s*loadFailed,$/m.test(SRC), true);

// ---- the prompt says so, and says it AFTER the assignment ------------------
// athleteBlock is built with `=`, so a notice appended before it is silently
// discarded. This assertion exists because that is exactly what happened on
// the first attempt at this fix.
const iAssign = SRC.indexOf("athleteBlock = `\\n\\nATHLETE STATE");
const iNotice = SRC.indexOf("DATA NOT LOADED THIS REQUEST");
ck("the prompt carries a not-loaded notice", iNotice > 0, true);
ck("...appended AFTER the assignment that would overwrite it", iNotice > iAssign, true);
ck("...and it tells the model the values are defaults, not measurements",
   /is a DEFAULT, not a measurement/.test(SRC), true);
ck("...and forbids asserting emptiness from them",
   /do not tell them their profile, plan or record is empty/.test(SRC), true);

// ---- RUN IT: a database returning 500 on every read ------------------------
// The loader is lifted out and executed with fetch stubbed, because the whole
// class of bug here is "the code ran and produced a confident wrong answer".
(async () => {
  console.log("\n-- executed against a failing database --");
  // The whole read round, from the declaration to its end marker. It used to
  // stop at the benchmarks catch line; since the reads became one
  // Promise.all, that line sits mid-array and only the marker closes it.
  const END_MARK = "// ---- END OF THE READ ROUND ----";
  const runFrom = SRC.indexOf("const loadFailed = []", loaderStart);
  const runTo = SRC.indexOf(END_MARK, runFrom);
  if (runFrom < 0 || runTo < 0) throw new Error("read round markers moved");
  const src = SRC.slice(runFrom, runTo);

  // `stub` answers each request; `delayMs` holds every answer open so reads
  // that genuinely overlap are seen overlapping.
  const exec = async (stub, delayMs = 0) => {
    let inFlight = 0, maxInFlight = 0;
    const urls = [];
    const fetchStub = async (u) => {
      urls.push(u);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return stub(u);
    };
    const fn = new Function("fetch", "url", "userId", "headers", "console", "resolveSportSupportLevel", `
      let athleteRow = null, sport = null, country = null, profileComplete = false;
      let profileRow = null, allDevItems = [], allBenchmarks = [], targetsCount = 0, allTargets = [];
      let hasPendingVerification = false, pathwayRow = null, questionsUsedToday = 0;
      let pathwayCreated = false, baselineComplete = false, pathwayType = null, sportSupportLevel = null;
      let pathwayTimeline = null, milestones = [], devItems = [], targets = [], benchmarks = [], actionRows = [];
      return (async () => { ${src}
        return { loadFailed, sport, profileComplete, pathwayCreated, targetsCount, sportSupportLevel };
      })();
    `);
    const out = await fn(fetchStub, "https://x", "u1", {}, { error() {} }, (s, d) => d);
    return { ...out, urls, maxInFlight };
  };
  const run = async (ok) => {
    const res = await exec(() => ok
      ? { ok: true, status: 200, json: async () => [] }
      // PostgREST's real failure shape: 500 with an OBJECT body. This is the
      // detail that made Array.isArray() guards read an outage as emptiness.
      : { ok: false, status: 500, json: async () => ({ code: "57014", message: "canceling statement" }) });
    return res;
  };

  const bad = await run(false);
  ck("every failing table is reported", bad.loadFailed.slice().sort(), TABLES.slice().sort());
  ck("...and the loader still returns rather than throwing", typeof bad.sport, "object");

  const good = await run(true);
  ck("a genuinely empty athlete reports NO failures", good.loadFailed, []);
  ck("...and is still correctly seen as incomplete", good.profileComplete, false);
  // This is the distinction the old code could not make: the two runs above
  // produced identical state, and only one of them was the truth.
  ck("an outage and an empty account are now distinguishable",
     bad.loadFailed.length === good.loadFailed.length, false);

  // A sorted copy would pass however the loader ordered them; the loader
  // itself must hand them over in the fixed order.
  ck("...in the fixed table order, whatever order the network answered in", bad.loadFailed, TABLES);

  // ---- ONE ROUND, NOT TEN ----------------------------------------------------
  // Positive control first: with every answer held open 15ms, a serial loader
  // never has more than one read in flight. The parallel one must have all of
  // them in flight at once.
  console.log("\n-- the reads run as one round --");
  const timed = await exec(() => ({ ok: true, status: 200, json: async () => [] }), 15);
  ck("every independent read is in flight at the same moment (8 tables + action history)", timed.maxInFlight, 9);
  ck("...and the instrument saw all nine requests", timed.urls.length, 9);
  // The one dependent read: the sports lookup needs the sport the athletes
  // read returns, so it runs after that read and is skipped without a sport.
  ck("no sport, no sports lookup", timed.urls.some((u) => u.includes("/rest/v1/sports?")), false);
  const withSport = await exec((u) => ({ ok: true, status: 200,
    json: async () => (u.includes("/rest/v1/athletes?") ? [{ sport: "Soccer" }] : u.includes("/rest/v1/sports?") ? [{ support_level: "primary" }] : []) }), 5);
  const iAth = withSport.urls.findIndex((u) => u.includes("/rest/v1/athletes?"));
  const iSport = withSport.urls.findIndex((u) => u.includes("/rest/v1/sports?"));
  ck("with a sport, the sports lookup runs", iSport >= 0, true);
  ck("...after the athletes read it depends on", iSport > iAth, true);
  ck("...and its answer still reaches sportSupportLevel", withSport.sportSupportLevel, "primary");

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
