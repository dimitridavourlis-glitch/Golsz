// GDPR Article 20 — the athlete can take their own data with them.
//
// WHY A TEST AND NOT JUST THE FEATURE
// An export is the one feature whose failure is invisible to the person it
// exists for. A missing table does not look like a bug: it looks like "I had
// no data there". The athlete cannot tell the difference, and neither can we,
// unless something reconciles the export against what the app actually stores.
//
// Two things are asserted:
//   A. every table this client reads with an OWNER filter is exported;
//   B. a table that fails is RECORDED, not dropped.
//
// (B) is the same rule the rest of this codebase enforces on writes. A
// swallowed read here hands someone a file that looks complete and is not,
// which is worse than an error, because they will act on it.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the list, lifted from source rather than retyped ---------------------
const block = APP.slice(APP.indexOf("const EXPORT_TABLES = ["),
                        APP.indexOf("];", APP.indexOf("const EXPORT_TABLES = [")) + 2);
ck("EXPORT_TABLES was found", block.length > 40, true);
const exported = [...new Set([...block.matchAll(/\[\s*"[a-z_]+",\s*"([a-z_]+)"/g)].map((m) => m[1]))];
ck("...and names real tables", exported.length > 5, true);

// ---- A. every personal table the app reads is covered ---------------------
// Derived from the app, not hand-listed, so a table added later shows up here
// instead of being quietly absent from people's exports.
// Derived from the columns this client actually filters on, not from memory.
// The first version of this list held five and missed follower_id, blocker_id
// and profile_id — which made every exclusion below stale on arrival and hid
// three tables (hidden_conversations, passport_share_tokens, daily_activity)
// that were never being exported.
const OWNER_COLS = ["user_id", "sender_id", "recipient_id", "athlete_id", "parent_id",
                    "follower_id", "followed_id", "blocker_id", "blocked_id", "profile_id"];
const readWithOwner = new Set();
for (const m of APP.matchAll(/from\("([a-z_]+)"\)[\s\S]{0,260}?\.eq\("([a-z_]+)"/g)) {
  if (OWNER_COLS.includes(m[2])) readWithOwner.add(m[1]);
}
// Tables that are NOT the athlete's own record, with the reason each is out.
const NOT_PERSONAL = {
  // The only one. A share token is a LIVE access link to the athlete's
  // passport; an export file gets emailed and forwarded, and this would hand
  // out working entry to it. They can already see and revoke these in the app.
  // Everything else the client reads with an owner filter IS exported — this
  // list stayed at one entry on purpose, and the assertion below fails if it
  // ever describes a table the app no longer reads.
  passport_share_tokens: "live share tokens — an exported file would leak working links",
};
const missing = [...readWithOwner].filter((t) => !exported.includes(t) && !NOT_PERSONAL[t]);
ck("every owner-filtered table is either exported or explicitly excluded", missing, []);
// Anti-rot: an exclusion that no longer matches anything means the list has
// started describing an app that does not exist.
ck("no exclusion names a table the app no longer reads",
   Object.keys(NOT_PERSONAL).filter((t) => !readWithOwner.has(t)), []);

// ---- the athlete's own words, including from retired features -------------
// posts and messages are gone as FEATURES but the rows are still what this
// person wrote. An export that omits them is not their data.
ck("posts are exported even though the feed was retired", exported.includes("posts"), true);
ck("messages are exported even though messaging is closed", exported.includes("messages"), true);
ck("Scout conversations are exported", exported.includes("scout_history"), true);
ck("the profile and athlete records are exported",
   ["profiles", "athletes"].filter((t) => !exported.includes(t)), []);

// ---- the owner column must be the REAL one --------------------------------
// PostgREST rejects the ENTIRE request on an unknown column, so a wrong name
// here does not degrade the export, it empties that section for everyone.
// post_likes keys on profile_id, not user_id — got this wrong first time.
{
  const pairs = [...block.matchAll(/\[\s*"[a-z_]+",\s*"([a-z_]+)",\s*"([a-z_]+)"/g)].map((m) => [m[1], m[2]]);
  const SCHEMA = fs.readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");
  const bad = pairs.filter(([table, col]) => {
    const i = SCHEMA.indexOf(`create table if not exists ${table} (`);
    if (i < 0) return false;                       // base table defined elsewhere
    return !new RegExp("^\\s+" + col + "\\s", "m").test(SCHEMA.slice(i, SCHEMA.indexOf("\n);", i)));
  });
  ck("every exported table is filtered on a column that exists", bad, []);
}

// ---- B. a failed table must be recorded, not dropped ----------------------
const fn = APP.slice(APP.indexOf("async function exportMyData("),
                     APP.indexOf("async function choosePlan("));
ck("exportMyData was found", fn.length > 100, true);
ck("a per-table error is captured", /_errors\.push\(/.test(fn), true);
ck("...and the caller is TOLD the file is partial",
   /settings_export_partial/.test(fn), true);
ck("...rather than the file silently claiming to be complete",
   /_errors\.length \? t\("settings_export_partial"\)/.test(fn), true);
// It must not throw the whole export away on one bad table either.
ck("one failed table does not abandon the rest", /continue;/.test(fn), true);

// ---- reachable from the UI, in all four languages -------------------------
ck("the button is rendered", /onClick=\{exportMyData\}/.test(APP), true);
for (const k of ["settings_export_data", "settings_export_partial", "settings_your_data"]) {
  ck(`${k} is defined in all four dictionaries`, (APP.match(new RegExp(k + ":", "g")) || []).length, 4);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
