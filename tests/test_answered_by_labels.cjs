// Every routing outcome scout.js can write must be one the database accepts.
//
// THE BUG THIS KILLS
// scout_routing_log.answered_by has a CHECK constraint. Three migrations have
// rewritten it, and each rewrite replaced the whole list rather than adding to
// it:
//   109 → ('haiku','sonnet','database','failed')
//   111 → ('haiku','sonnet','database','cross_provider')   -- 'failed' lost
// From migration 111 onward, every `logRouting("failed", ...)` produced a 400
// from PostgREST. logRouting() does not check r.ok and swallows everything in
// a try/catch, so nothing threw, nothing logged, and the row simply was not
// there. Failed Scout requests — the single outcome you most need counted —
// were invisible, and nothing in the codebase could tell you.
//
// Migration 111's own comment describes this exact failure mode for
// cross_provider and then reintroduces it for 'failed' in the same statement.
// That is not carelessness so much as proof that a human reading a diff cannot
// reliably catch it: the dangerous part of `drop constraint; add constraint`
// is what is ABSENT from the new list, and absence is what review misses.
//
// So this suite reads both sides out of the real files and compares them as
// sets. Add a routing outcome without extending the constraint — or extend the
// constraint and drop a value by accident — and this goes red immediately,
// instead of silently costing you a month of telemetry.
//
// It also pins the faq/cache split (migration 124), which exists so the $0
// share can be attributed to a mechanism rather than to a shrug.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const SCHEMA = fs.readFileSync(REPO + "/supabase-schema.sql", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- what the code can write --------------------------------------------
const written = [...SCOUT.matchAll(/logRouting\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
if (!written.length) throw new Error("found no logRouting() call sites — the matcher is broken, not the code");
const writtenSet = [...new Set(written)].sort();

// ---- what the database will accept --------------------------------------
// supabase-schema.sql is append-ordered, so the LAST definition is live.
const allDefs = [...SCHEMA.matchAll(/check\s*\(answered_by in \(([^)]*)\)\)/g)];
if (!allDefs.length) throw new Error("no answered_by CHECK constraint found in supabase-schema.sql");
const liveDef = allDefs[allDefs.length - 1][1];
const allowedSet = [...new Set(liveDef.split(",").map((s) => s.trim().replace(/^'|'$/g, "")))].sort();

console.log("   writes :", writtenSet.join(", "));
console.log("   allows :", allowedSet.join(", "));

// ---- the assertion that matters -----------------------------------------
const unaccepted = writtenSet.filter((v) => !allowedSet.includes(v));
ck("every value scout.js writes is accepted by the live constraint", unaccepted, []);

// The reverse is not an error — 'database' is retained deliberately for
// historical rows — but an allowed value that nothing writes and that is not
// the known-historical one is dead and worth noticing.
const unwritten = allowedSet.filter((v) => !writtenSet.includes(v) && v !== "database");
ck("no allowed value is dead (excluding the historical 'database')", unwritten, []);

// ---- the specific regressions, named ------------------------------------
ck("'failed' is accepted again — it was lost by migration 111", allowedSet.includes("failed"), true);
ck("...and scout.js does still write it", writtenSet.includes("failed"), true);
ck("'cross_provider' survived the repair", allowedSet.includes("cross_provider"), true);
ck("'database' is retained so historical rows still read", allowedSet.includes("database"), true);

// ---- the faq/cache split (migration 124) --------------------------------
ck("the FAQ path writes its own label", writtenSet.includes("faq"), true);
ck("the response cache writes its own label", writtenSet.includes("cache"), true);
ck("neither path writes the old ambiguous label any more", writtenSet.includes("database"), false);
ck("exactly one site logs faq", written.filter((v) => v === "faq").length, 1);
ck("exactly one site logs cache", written.filter((v) => v === "cache").length, 1);

// The split is only real if the two sites are the two mechanisms. Anchor each
// label to the log line that identifies its path.
const faqIdx = SCOUT.indexOf('logRouting("faq"');
const cacheIdx = SCOUT.indexOf('logRouting("cache"');
ck("the faq label sits with the FAQ match",
   SCOUT.lastIndexOf("GOLSZ scout FAQ match", faqIdx) > SCOUT.lastIndexOf("GOLSZ scout cache hit", faqIdx), true);
ck("the cache label sits with the cache hit",
   SCOUT.lastIndexOf("GOLSZ scout cache hit", cacheIdx) > SCOUT.lastIndexOf("GOLSZ scout FAQ match", cacheIdx), true);

// ---- the dashboard must count what the table now holds ------------------
// Introducing a label the reporting RPC does not count makes those rows
// vanish from the Admin Panel rather than move — the same trap, one layer up.
const mix = SCHEMA.slice(SCHEMA.lastIndexOf("create or replace function admin_scout_model_mix"));
const mixBody = mix.slice(0, mix.indexOf("$$;"));
for (const v of allowedSet) {
  ck(`admin_scout_model_mix() counts '${v}'`, mixBody.includes(`answered_by = '${v}'`), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
