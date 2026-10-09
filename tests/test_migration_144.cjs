// Migration 144 — access hardening. Reads the SQL and asserts the properties
// that make each of its eight fixes real.
//
// WHAT THIS CAN AND CANNOT PROVE
// There is no database in the gate (the suite must run with no network and no
// secrets), so nothing here executes the SQL. What it does instead is read the
// EXECUTABLE text — comments stripped first, so a fix that exists only in a
// comment cannot pass — and check the shape of every object 144 replaces.
// Where 144 claims to reproduce an older definition "verbatim apart from X",
// the older definition is read from its own migration file and diffed, so a
// silently dropped clause fails here rather than in production.
//
// The behaviour was additionally exercised once, by hand, against a local
// Postgres 16 with a Supabase-shaped mock (auth.uid()/auth.role(), storage
// .objects, the real 138/126 definitions underneath): both runs clean, under-18
// and no-DOB signups refused, self-approval refused, storage listing scoped,
// fake public events refused and invisible to search_events, hidden club and
// country blanked, banned Passports gone. That run is not repeatable inside
// this gate; these assertions are the part that is.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

const FILE = "supabase-migration-144-access-hardening.sql";
const RAW = fs.existsSync(path.join(REPO, FILE)) ? read(FILE) : "";
const M138 = read("supabase-migration-138-remove-scout-coach-physio.sql");
const M126 = read("supabase-migration-126-audit-fixes.sql");
const SCHEMA_REF = read("supabase-schema.sql");
const ENTITLEMENTS = read("api/_entitlements.js");
const SCOUT_JS = read("api/scout.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Line comments out, string literals kept. None of these files put "--"
// inside a string literal, which is checked rather than assumed.
function code(sql) {
  return sql.split("\n").map((line) => {
    const i = line.indexOf("--");
    return i === -1 ? line : line.slice(0, i);
  }).join("\n");
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Anything a check depends on that cannot be found is itself a FAILURE,
// recorded here — never an empty string that the negative assertions below
// would then pass against, and never a crash that skips the tally line.
function found(label, value) {
  ck(`found: ${label}`, value !== null && value !== undefined, true);
  return value;
}

// The text of one `create or replace function NAME(...)` up to its closing
// `$$;` (the last definition in the file — later definitions win).
function fnText(sql, name) {
  const esc = name.replace(/[()]/g, "\\$&") + (/\w$/.test(name) ? "\\b" : "");
  const re = new RegExp(`create or replace function ${esc}[\\s\\S]*?\\$\\$;`, "gi");
  const all = [...sql.matchAll(re)].map((m) => m[0]);
  return found(`function ${name}`, all.length ? all[all.length - 1] : null) || "";
}
function policyText(sql, name) {
  const m = new RegExp(`create policy ${name} on[\\s\\S]*?;`, "i").exec(sql);
  return found(`policy ${name}`, m ? m[0] : null) || "";
}

const SQL = code(RAW);

console.log("-- the file --");
ck("migration 144 is on disk", RAW.length > 0, true);
// Every "--" must start a comment, i.e. sit after an even number of quotes on
// its line; one inside a string literal would make code() cut the string.
ck("no '--' inside a string literal (so stripping comments is safe)",
   RAW.split("\n").filter((l) => l.includes("--") && (l.slice(0, l.indexOf("--")).split("'").length - 1) % 2 === 1), []);
ck("it is one transaction: begin; first, commit; last",
   /^\s*begin;/m.test(SQL) && SQL.trim().endsWith("commit;") && SQL.indexOf("begin;") < SQL.indexOf("create "), true);
ck("it destroys nothing (no drop table/column, truncate or delete)",
   /drop table|drop column|truncate|delete from/i.test(SQL), false);

// Idempotency: every create policy / create trigger is preceded by its drop.
const policies = [...SQL.matchAll(/create policy (\w+) on ([\w.]+)/gi)];
ck("every created policy is dropped-if-exists first",
   policies.filter(([, n, t]) => !new RegExp(`drop policy if exists ${n} on ${t.replace(".", "\\.")};`, "i").test(SQL)).map((m) => m[1]), []);
const triggers = [...SQL.matchAll(/create trigger (\w+)/gi)];
ck("every created trigger is dropped-if-exists first",
   triggers.filter(([, n]) => !new RegExp(`drop trigger if exists ${n}\\b`, "i").test(SQL)).map((m) => m[1]), []);
ck("no bare create table / create view / add column without a guard",
   /create table (?!if not exists)|create view|add column (?!if not exists)/i.test(SQL), false);

console.log("\n-- 144.1 public_profile_names --");
ck("the view is security_invoker",
   /create or replace view public_profile_names with \(security_invoker = true\) as/i.test(SQL), true);
ck("...and re-asserted with alter view, so a re-run repairs it",
   /alter view public_profile_names set \(security_invoker = true\);/i.test(SQL), true);
const viewSel = /create or replace view public_profile_names[^;]*? as\s+(select[^;]*);/i.exec(SQL);
ck("same five columns 126 exposed, nothing more",
   viewSel && norm(viewSel[1]),
   "select id, full_name, occupation, verified_tier, avatar_url from profiles");
ck("anon stays revoked", /revoke all on public_profile_names from anon;/i.test(SQL), true);
ck("anon is never granted the view", /grant [^;]*on public_profile_names to [^;]*anon/i.test(SQL), false);

console.log("\n-- 144.2 handle_new_user --");
const HNU = code(fnText(RAW, "handle_new_user"));
const HNU138 = code(fnText(M138, "handle_new_user"));
ck("refuses a missing date of birth",
   /if v_dob is null then\s+raise exception/i.test(HNU), true);
ck("refuses under-18 unless parent-managed",
   /if v_is_minor and not v_parent_managed then\s+raise exception/i.test(HNU), true);
ck("the age test is the same expression is_minor has always used",
   /v_is_minor := \(date_part\('year', age\(v_dob\)\) < 18\);/.test(HNU), true);
ck("the exemption reads raw_app_meta_data (Admin-API-only)",
   /new\.raw_app_meta_data->>'managed_by_parent'/.test(HNU), true);
ck("...and never raw_user_meta_data, which any client sets",
   /raw_user_meta_data->>'managed_by_parent'/.test(HNU), false);
ck("both refusals come before anything is written",
   HNU.search(/raise exception/i) < HNU.search(/insert into profiles/i), true);
ck("no parent_links row is created any more", /insert into parent_links/i.test(HNU), false);
ck("...and the variable only that branch used is gone", /v_parent_id/.test(HNU), false);
// VERBATIM-APART-FROM. Every code line of 138's body, minus the removed
// auto-link branch and its variable, must appear in 144's body in order.
{
  const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const old = lines(HNU138);
  const start = old.findIndex((l) => /^if v_is_minor and v_parent_email is not null then$/.test(l));
  // the branch is the outer `if` through its matching outer `end if;`
  let depth = 0, end = -1;
  for (let i = start; i < old.length; i++) {
    if (/^if\b/.test(old[i])) depth++;
    if (/^end if;$/.test(old[i])) { depth--; if (depth === 0) { end = i; break; } }
  }
  ck("138's auto-link branch was located (guards the diff below)", start > 0 && end > start, true);
  const expected = old.filter((l, i) => !(i >= start && i <= end) && !/^v_parent_id uuid;$/.test(l));
  const now = lines(HNU);
  let j = 0;
  const missing = [];
  for (const l of expected) {
    const k = now.indexOf(l, j);
    if (k === -1) missing.push(l); else j = k + 1;
  }
  ck("every other line of 138's handle_new_user survives, in order", missing, []);
}
ck("plan is still forced to 'free'", /'free'::plan_tier/.test(HNU), true);
ck("occupation allowlist still Player/Parent", /v_occupation not in \('Player', 'Parent'\)/.test(HNU), true);
ck("honeypot still zeroes trust_score", /v_trust_score := 0;/.test(HNU), true);

console.log("\n-- 144.3 parent_links approval --");
ck("requested_by column added idempotently",
   /alter table parent_links add column if not exists requested_by uuid;/i.test(SQL), true);
const STAMP = code(fnText(RAW, "stamp_parent_link_requester"));
ck("requested_by is stamped from auth.uid(), not trusted from the client",
   /new\.requested_by := auth\.uid\(\);/.test(STAMP), true);
ck("a client-created link is always born pending", /new\.approved_at\s*:= null;/.test(STAMP), true);
ck("the stamp runs before insert",
   /create trigger stamp_parent_link_requester_trigger\s+before insert on parent_links/i.test(SQL), true);
const PROTECT_PL = code(fnText(RAW, "protect_parent_link_columns"));
ck("protect_parent_link_columns still pins parent_id and athlete_id",
   /new\.parent_id\s*:= old\.parent_id;/.test(PROTECT_PL) && /new\.athlete_id := old\.athlete_id;/.test(PROTECT_PL), true);
ck("...and now pins requested_by", /new\.requested_by := old\.requested_by;/.test(PROTECT_PL), true);
const APPROVE = norm(policyText(SQL, "parent_links_approve"));
ck("approval USING requires the athlete AND a parent-initiated row",
   APPROVE.includes("using (athlete_id = auth.uid() and requested_by = parent_id)"), true);
ck("...and so does WITH CHECK",
   APPROVE.includes("with check (athlete_id = auth.uid() and requested_by = parent_id)"), true);
ck("no link is revoked automatically — the revoke is a commented review step",
   /update parent_links set approved_at = null/i.test(SQL) === false && /update parent_links set approved_at = null/i.test(RAW), true);

console.log("\n-- 144.4 storage listing --");
for (const [pol, bucket] of [["avatars_read", "avatars"], ["post_images_read", "post-images"]]) {
  const t = norm(policyText(SQL, pol));
  ck(`${pol} is scoped to its bucket`, t.includes(`bucket_id = '${bucket}'`), true);
  ck(`${pol} limits reads to the caller's own folder or an admin`,
     t.includes("(storage.foldername(name))[1] = auth.uid()::text or public.is_admin()"), true);
  ck(`${pol} is authenticated-only`, t.includes("for select to authenticated"), true);
}

console.log("\n-- 144.5 events --");
ck("visibility defaults to private",
   /alter table events alter column visibility set default 'private';/i.test(SQL), true);
const EW = norm(policyText(SQL, "events_write"));
ck("a non-admin can only insert a private event of their own",
   EW.includes("created_by = auth.uid() and (visibility = 'private' or is_admin())"), true);
const EU = norm(policyText(SQL, "events_update"));
ck("a non-admin's row must still be private after an update",
   EU.includes("with check ((created_by = auth.uid() and visibility = 'private') or is_admin())"), true);
ck("...and the USING clause is unchanged from 009", EU.includes("using (created_by = auth.uid() or is_admin())"), true);
const PEC = code(fnText(RAW, "protect_event_columns"));
ck("protect_event_columns still pins is_blocked", /new\.is_blocked := old\.is_blocked;/.test(PEC), true);
ck("...and now pins created_by", /new\.created_by := old\.created_by;/.test(PEC), true);
const SE = code(fnText(RAW, "search_events"));
const SE126 = code(fnText(M126, "search_events"));
ck("search_events: public and unblocked, as in 126",
   /not e\.is_blocked/.test(SE) && /e\.visibility = 'public'/.test(SE), true);
ck("search_events: created by an admin, or no creator",
   /e\.created_by is null\s+or exists \(select 1 from profiles ap where ap\.id = e\.created_by and ap\.is_admin\)/.test(SE), true);
const sig = (s) => norm(s.slice(0, s.indexOf("language")));
ck("search_events signature and return columns unchanged", sig(SE), sig(SE126));
ck("search_events keeps the 25-row cap", /limit least\(coalesce\(p_limit, 10\), 25\)/.test(SE), true);
ck("service_role keeps execute (Scout calls it with the service key)",
   /grant execute on function search_events\(text, text, text, date, int\) to service_role;/i.test(SQL), true);
ck("no event is privatised automatically — that is a commented review step",
   /update events set visibility/i.test(SQL) === false && /update events set visibility = 'private'/i.test(RAW), true);

console.log("\n-- 144.6 shared Passport --");
const keys = (s) => [...s.matchAll(/'(\w+)', /g)].map((m) => m[1]);
for (const name of ["get_public_passport(p_user uuid)", "get_public_passport_by_token"]) {
  const now = code(fnText(RAW, name));
  const was = code(fnText(M126, name));
  ck(`${name}: club blanked unless show_club`,
     now.includes("'club_name', case when a.show_club then a.club_name else null end"), true);
  ck(`${name}: country blanked unless show_country`,
     now.includes("'country', case when a.show_country then a.country else null end"), true);
  ck(`${name}: nothing for a banned account`, /is_banned\((p_user|v_user)\)/.test(now), true);
  ck(`${name}: same field list as 126`, keys(now), keys(was));
}
const BYID = code(fnText(RAW, "get_public_passport(p_user uuid)"));
ck("get_public_passport still requires passport_public consent",
   /when not coalesce\(\(select passport_public from profiles where id = p_user\), false\) then null/.test(BYID), true);
const BYTOK = code(fnText(RAW, "get_public_passport_by_token"));
ck("the token variant still refuses a revoked link", /where token = p_token and not revoked/.test(BYTOK), true);
ck("the ban check runs before the access is recorded",
   BYTOK.indexOf("is_banned(v_user)") > -1 && BYTOK.indexOf("is_banned(v_user)") < BYTOK.indexOf("update passport_share_tokens"), true);
ck("both stay callable logged-out",
   /grant execute on function get_public_passport\(uuid\) to anon, authenticated;/.test(SQL)
   && /grant execute on function get_public_passport_by_token\(text\) to anon, authenticated;/.test(SQL), true);
ck("nothing else is granted to anon",
   [...SQL.matchAll(/grant [^;]* to ([^;]*);/gi)].filter((m) => /\banon\b/.test(m[1]))
     .map((m) => m[0]).filter((g) => !/get_public_passport/.test(g)), []);

console.log("\n-- 144.7 plan copy Scout reads --");
const planUpdate = (id) => {
  const m = new RegExp(`update plan_config set\\s+live_features = '(\\[[^']*\\])'::jsonb,\\s+ai_daily_question_limit = (\\d+),\\s+ai_lifetime_question_limit = (\\w+),[^;]*?where plan_id = '${id}'`, "i").exec(SQL);
  if (!found(`plan_config update for ${id}`, m)) return { features: [], daily: null, lifetime: undefined };
  return { features: JSON.parse(m[1]), daily: Number(m[2]), lifetime: m[3] === "null" ? null : Number(m[3]) };
};
const PLANS = Object.fromEntries(["free", "starter", "pro", "elite"].map((id) => [id, planUpdate(id)]));
const allCopy = Object.values(PLANS).flatMap((x) => x.features).join(" | ");
// "goal discovery" (Scout's intake) is real; ATHLETE discovery is off (143).
ck("no unbuilt feature is promised (schedule, diary, Motion, nutrition, athlete discovery, messaging)",
   /schedule|diary|motion|nutrition|athlete discovery|athlete search|messag/i.test(allCopy), false);
// The copy is only honest while the gate it describes is the gate that runs.
// Read FEATURE_MIN_PLAN from the authoritative module rather than restating it.
const fmpSrc = found("FEATURE_MIN_PLAN in api/_entitlements.js", /const FEATURE_MIN_PLAN = (\{[\s\S]*?\});/.exec(ENTITLEMENTS));
const fmp = fmpSrc ? Function(`return (${fmpSrc[1]})`)() : null;
ck("FEATURE_MIN_PLAN is what this copy was written against",
   fmp, { pdf_export: "starter", readiness: "pro", targets: "starter", benchmarks: "starter", development_plan: "pro", pathway_plan: "starter" });
const has = (id, re) => PLANS[id].features.some((s) => re.test(s));
ck("Basic lists the targets, benchmarks, pathway and PDF it unlocks",
   [/target list with outreach tracking and follow-up reminders/i, /benchmarks/i, /pathway with dated milestones/i, /pdf/i].every((re) => has("starter", re)), true);
ck("Pro lists the Passport Strength breakdown and development plan",
   has("pro", /passport strength breakdown/i) && has("pro", /development plan/i), true);
ck("Free does not list anything gated at Basic or above",
   [/pdf/i, /benchmark/i, /pathway/i, /target/i, /breakdown/i, /development plan/i].some((re) => has("free", re)), false);
ck("Elite is everything in Pro, nothing invented", PLANS.elite.features.slice(1), ["Everything in Pro"]);
// Limits: the column values, the copy, and api/scout.js's defaults agree.
const scoutDefault = (env) => {
  const m = found(`${env} default in api/scout.js`, new RegExp(`process\\.env\\.${env} \\|\\| (\\d+)`).exec(SCOUT_JS));
  return m ? Number(m[1]) : null;
};
ck("daily limits match api/scout.js",
   [PLANS.free.daily, PLANS.starter.daily, PLANS.pro.daily, PLANS.elite.daily],
   [scoutDefault("FREE_DAILY_LIMIT"), scoutDefault("STARTER_DAILY_LIMIT"), scoutDefault("PRO_DAILY_LIMIT"), scoutDefault("ELITE_DAILY_LIMIT")]);
ck("free lifetime limit matches api/scout.js; paid plans have none",
   [PLANS.free.lifetime, PLANS.starter.lifetime, PLANS.pro.lifetime, PLANS.elite.lifetime],
   [scoutDefault("FREE_LIFETIME_LIMIT"), null, null, null]);
ck("each plan's first line states its own limit",
   ["free", "starter", "pro", "elite"].map((id) => PLANS[id].features[0].startsWith(String(PLANS[id].daily) + " AI Scout questions a day")),
   [true, true, true, true]);

console.log("\n-- 144.8 model pricing --");
const price = /update scout_model_config set\s+input_cost_per_million = ([\d.]+),\s+output_cost_per_million = ([\d.]+),\s+cached_input_cost_per_million = ([\d.]+),[\s\S]*?where provider = 'anthropic'\s+and model_name = '([\w-]+)'/i.exec(SQL);
ck("claude-sonnet-5 moves to $2 / $10 per 1M (cache read 10% of input)",
   price && [price[4], Number(price[1]), Number(price[2]), Number(price[3])], ["claude-sonnet-5", 2, 10, 0.2]);
ck("no other model's row is updated",
   [...SQL.matchAll(/update scout_model_config[\s\S]*?;/gi)].length, 1);

console.log("\n-- the schema reference knows --");
ck("supabase-schema.sql names migration 144", SCHEMA_REF.includes("supabase-migration-144-access-hardening.sql"), true);
ck("...and carries the security_invoker view", /public_profile_names with \(security_invoker = true\)/.test(SCHEMA_REF), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
