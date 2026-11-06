// MIGRATION 165: outreach_targets length limits + updated_at trigger. Reads the
// SQL as text. Caps are compared with TARGET_LIMITS lifted from golsz-app.html.

const fs = require("fs");
const path = require("path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const APP = read("golsz-app.html");
const SQL = read("supabase-migration-165-outreach-target-limits.sql");
const SCHEMA = read("supabase-schema.sql");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const s = APP.indexOf("const TARGET_LIMITS = ");
ck("TARGET_LIMITS found in the app", s > 0, true);
const TARGET_LIMITS = new Function(APP.slice(s, APP.indexOf("};", s) + 2) + "; return TARGET_LIMITS;")();

// Statements only: the header is all comment lines.
const body = SQL.split("\n").filter((l) => !l.startsWith("--")).join("\n");
const header = SQL.split("\n").filter((l) => l.startsWith("--")).join("\n");

// Every ADD CONSTRAINT is NOT VALID, and there are exactly 7.
const adds = body.match(/add constraint[\s\S]*?;/g) || [];
ck("seven constraints added", adds.length, 7);
for (const a of adds) ck(`NOT VALID: ${a.split(/\s+/)[2]}`, /\)\s*not valid;$/.test(a), true);

// Each text column has a cap equal to TARGET_LIMITS.
for (const [col, cap] of Object.entries(TARGET_LIMITS)) {
  const m = body.match(new RegExp(`outreach_targets_${col}_len\\s+check \\(char_length\\(${col}\\) <= (\\d+)\\)`));
  ck(`cap for ${col} exists`, !!m, true);
  ck(`cap for ${col} equals TARGET_LIMITS`, m && Number(m[1]), cap);
}
ck("name must not be blank", /outreach_targets_name_not_blank\s+check \(char_length\(btrim\(name\)\) > 0\)/.test(body), true);

// updated_at trigger.
ck("BEFORE UPDATE trigger", /create trigger outreach_targets_touch_updated_at\s+before update on outreach_targets\s+for each row/.test(body), true);
ck("trigger sets updated_at = now()", /new\.updated_at := now\(\)/.test(body), true);
// The nightly reminder (api/target-followup-reminders.js) stamps only
// last_reminded_at; that must not count as the athlete touching the target,
// or Home's follow-up count drops to zero the night a reminder is sent.
const fnBody = (src) => { const i = src.indexOf("create or replace function outreach_targets_touch_updated_at()"); return src.slice(i, src.indexOf("$$;", i)); };
for (const [label, src] of [["migration", body], ["schema", SCHEMA]]) {
  const fn = fnBody(src);
  ck(`${label}: trigger compares rows without last_reminded_at`,
    /\(to_jsonb\(new\) - 'updated_at' - 'last_reminded_at'\)\s+is distinct from \(to_jsonb\(old\) - 'updated_at' - 'last_reminded_at'\)/.test(fn), true);
  ck(`${label}: bookkeeping-only update keeps old updated_at`, /else\s+new\.updated_at := old\.updated_at;/.test(fn), true);
  ck(`${label}: no unconditional now() before the comparison`, fn.indexOf("new.updated_at := now()") > fn.indexOf("is distinct from"), true);
}
const reminder = read("api/target-followup-reminders.js");
ck("the reminder's write to outreach_targets is last_reminded_at only",
  /outreach_targets\?id=eq\.\$\{target\.id\}`, \{ last_reminded_at: [^,}]+\}/.test(reminder), true);

// Rollback in the header covers every object created.
const created = [...body.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
for (const c of created) ck(`rollback drops ${c}`, header.includes(`drop constraint if exists ${c};`), true);
ck("rollback drops trigger", header.includes("drop trigger if exists outreach_targets_touch_updated_at on outreach_targets;"), true);
ck("rollback drops function", header.includes("drop function if exists outreach_targets_touch_updated_at();"), true);
ck("header has pre-run check", /PRE-RUN CHECK/.test(header), true);
ck("header has post-run check", /POST-RUN CHECK/.test(header), true);

// No RLS change; only the objects above are created.
ck("no policy statements", /\bpolicy\b/i.test(body), false);
ck("no row level security statements", /row level security/i.test(body), false);
ck("no drop table / column", /drop (table|column)/i.test(body), false);

// Schema file marks it.
ck("schema marks 165 NOT YET APPLIED", /-- 165 — NOT YET APPLIED/.test(SCHEMA), true);
ck("schema carries the trigger", SCHEMA.includes("create trigger outreach_targets_touch_updated_at"), true);

console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
process.exit(f ? 1 : 0);
