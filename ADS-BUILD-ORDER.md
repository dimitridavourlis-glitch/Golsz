# GOLSZ — ATHLETE DIRECTION SYSTEM: BUILD ORDER

**Read this first:** you are extending a working system, not starting one. Of the brief's nine subsystems, **two are substantially built** (Action Engine, AI Scout), **four are half-built** (Home, Pathway, Gap/Bottleneck, Passport), **one is built but scoring the wrong thing** (Assessment), and **two cannot be honestly built at all today** (Opportunity match scoring, and goal-relative capability assessment) because the reference data does not exist. Six independent audits of this repo agree on that split, and every claim below carries a file:line.

---

## 1. WHAT ALREADY EXISTS

### 1.1 HOME as command centre — **70% built**

| Brief element | Status | Where |
|---|---|---|
| NEXT ACTION + WHY | **EXISTS, complete** | `golsz-app.html:10000-10038`; selection rule `nextMilestone` `:11475-11489`; 8-rung deterministic ladder `:9768-9793`, plan-gated so a Free athlete is never pointed at a paywall |
| MARK DONE / RESCHEDULE / ASK SCOUT / DROP | **EXISTS, all four** | `:10019` (optimistic write + rollback, `markStepDone` `:9667-9682`), `:10024`, `:10028`, `:10034` |
| GOAL | **EXISTS** | "CHASING", 36px, athlete's own words, DAY n + BY {grad_year}, `:10040-10088` |
| PATHWAY PROGRESS | **HALF** — Home resolves the full stage ladder and honours `current_stage_id` (`:9796-9801`) but prints only the stage name in the identity sub-line (`:9955`). A component written for exactly this, `PathwayStrip` (`:9218-9306`), is **mounted nowhere** — one occurrence in `golsz-app.html` and one in `js/app.js`, i.e. the definition only |
| BIGGEST BOTTLENECK | **COMPUTED AND THROWN AWAY** — `weakest` `:9585`, `leverKey` `:9592`, `projectedWeak` `:9595`, the latter backed by a 60-line block (`:9450-9509`) that re-runs the *real* scoring functions against hypothetical inputs rather than estimating. Neither `leverKey` nor `projectedWeak` is rendered anywhere. The `home_lever_*` strings are already translated in all four languages (`:376, :723, :1070, :1417`) |
| TODAY | **MISSING** |
| THIS WEEK (4/7) | **WRONG, not missing** — Home's STEPS tile (`:10216`) and Plan's "THIS WEEK" fraction (`:12355`) both print **lifetime** done/total (`doneCount` `:11995`), not the seven days on screen. Home's week calendar was deliberately removed (`:9808-9820`) and left five orphaned `home_week_*` i18n keys |
| NEW OPPORTUNITY | **MISSING**, and the nearest live fact is dead: the whole `doors`/`schoolsFact` block (`:9875-9893`) is computed on every Home load and rendered nowhere, and its `status === "replied"` check can **never** fire — that status is not in `TARGET_STATUSES` |

### 1.2 PATHWAY ENGINE — **stages exist; everything per-stage does not**

- **Per-athlete custom stages: SHIPPED.** `pathway_plan.stages` jsonb + `current_stage_id` (`supabase-migration-128-custom-pathway-stages.sql:31-32`), one resolver `athleteStages()` (`golsz-app.html:11210`) enforced by a grep invariant (`tests/test_pathway_milestones.cjs:232-234`), `MAX_STAGES=7` with copy that explains itself (`:11709`), delete unfiles instead of cascading (`:11842-11848`), stage id never derived from label (128:22-29).
- **`SPEC-custom-pathway-stages.md:3-4` still says "Nothing here is implemented yet". That line is false.** All six decisions and all five build steps shipped in commit c4e8c15. Anyone planning from that header will re-propose a finished subsystem.
- **Per-stage actions: EXIST** — the milestones array's `stage` field, with per-stage counts drawn on the rail (`:12023-12028`, `:11326-11327`).
- **A stage today is exactly `{id, label}`.** No status, no target date, no requirements, no blockers, no evidence. The word "blocker"/"bottleneck" appears **zero times** anywhere in the repo.
- Requirements exist one level up and are invisible: `api/scout.js:1662-1683` gives soccer eight pathways with `levels[]` and `key_evidence[]`, read **only** to build a prompt string (`:1844`). Nothing checks whether the athlete has any of it.
- Alternative routes = one 300-char `secondary_goal` sentence (`supabase-migration-125:47-70`, UI `golsz-app.html:10439-10540`). The brief wants a *branch*, which is a list of stages and collides with `MAX_STAGES=7` immediately.
- "Never delete pathway history" is currently **the opposite** of what the code does: one mutable row per athlete, full-row upsert (`:11668-11701`), `deleteStage` drops the object permanently (`:11842-11848`). No history table in 143 migrations.

### 1.3 ASSESSMENT ENGINE — **built, careful, parity-tested, and scoring the wrong thing**

`api/_readiness.js` is a real five-dimension composite — profile_quality, verification, performance, development, pathway — with `weakest` (`:160-162`), mirrored in `golsz-app.html:5021-5090` and diffed at run time by `tests/test_readiness_parity.cjs`. It already drives Home's lever line, the projected score, the Free teaser and the Scout prompt in four languages.

**It is a GOLSZ-usage completeness engine, not an athletic capability engine.** "Weakest = Verification" means *your profile is incomplete*, not *your top-end speed is holding you back*.

Also already built and strong: protocol comparability (`api/scout.js:2031-2052`, `auto_normalize: false` — it refuses a comparison rather than correcting it), per-reading measurement method with `bench_method_none` = "Method not recorded" (`golsz-app.html:4847`), and trend deltas computed **only** between readings with matching protocol signatures (`:4593-4612`). That benchmark card is the strongest provenance precedent in the codebase and the right model for the brief's tagging.

### 1.4 GAP + BOTTLENECK ENGINE — **a data-completeness gap engine exists; a capability one does not**

`PATHWAY_FIELD_PRIORITY` (`api/scout.js:2838-2867`) declares critical/useful fields per `sport:goal`; `isAssessmentReady` (`:2936-2956`) returns missing_critical / missing_useful / confidence with confidence **derived**, never model-authored; persisted (`:3890-3909`) and read by the client (`golsz-app.html:13038-13055`). That is real and reusable. What does not exist is any comparison against what the goal *requires*.

### 1.5 AI SCOUT — **the most built-out area in the brief, by a wide margin**

`api/scout.js` is 7,468 lines. Scout **already** receives, automatically, every turn (`getAthleteState` `:5630-5878`, prompt assembly `:6561-6760`): goal text with authorship and a 4-level precedence order; pathway type, timeline, athlete-vs-default stages, current stage, the actual open steps with due dates **and the app's own "next" rule so it cannot nominate a different one** (`:6584-6595`); benchmarks; development plan; targets; film and timeline titles (never URLs); the app-computed Passport Strength with all five sub-scores and the weakest dimension marked authoritative; plan entitlement gaps; a VERIFIED / STATED / INFERRED / KNOWN UNKNOWNS / SUPERSEDED split (`:~5300-5485`); and an explicit "these tables failed to load" notice (`:5675`, `:6572`) so an outage is never rendered as a fact about the athlete.

Scout **already proposes six kinds of structured, server-validated change**: `suggested_targets`, `suggested_dev_items`, `suggested_pathway`, `drafted_email`, `profile_updates`, `scout_context_updates`. The validation is thorough, not nominal — field allowlists (`:1087-1135`, `:1270-1300`), enum sets matched to live CHECK constraints (`:3022`), hard caps, **stage ids minted server-side with any model-supplied id discarded** (`:3062-3065`), **dates accepted only as day offsets** so a past date is unrepresentable (`:3031-3037`), `due_src` provenance, rejection of a pathway that contradicts the athlete's written goal (`:3245-3277`), plan gating, approval read from the athlete's own words not the model's claim of consent (`:3170-3187`), and a deterministic app-assembled fallback (`:3179-3237`) for the four documented production cases where the model declined to emit the object.

Client confirm cards show what a tap will destroy and require a second specific tap (`golsz-app.html:8408-8560`).

**Nobody should propose "give Scout structured context" or "let Scout suggest actions" as new work.**

### 1.6 ACTION ENGINE — **the shared store already exists as jsonb; the fields do not**

`pathway_plan.milestones` (`supabase-migration-076-pathway-plan.sql:19`) is already the one shared action store, written by **four** screens — Plan `:11668`, Home `:9667`, Benchmarks retest `:4743`, Scout `:8231` — and read server-side at `api/scout.js:5719`. The unification the brief asks for is substantially **done**.

A milestone carries exactly six fields (`normalizeMilestone` `:11421-11449`): `id, label, done, due, stage, due_src`. **Missing: category, priority** (`grep -c priority golsz-app.html` → **0**), **description, reason, evidence requirement, completed_at, goal link.** `Rescheduled` and `Dropped` cannot be represented: `setMilestoneDue` (`:11883`) overwrites in place, `deleteMilestone` (`:11966`) removes the element, undo is component state only (`:11548`).

**The single most load-bearing thing in this area, which the brief never mentions:** `due_src` + `suggestedDate` + `touchedMilestone` (`:11443-11473`). A Scout-suggested date is marked as such and gates four punitive surfaces — `nextMilestone` ranking, the overdue label, Home's `stepOverdue`/`stepsLate`, the OVERDUE band. The stated reason (`:11434-11441`): without it "an AI guess could outrank every step the athlete wrote themselves and start calling a fifteen-year-old late on deadlines nobody chose." **Any migration that drops `due_src` starts calling minors late.**

GOLSZ actually has **three** action-ish systems: milestones (dated, one-off), `development_plan_items` + `development_plan_ticks` (recurring habits, per-day history, `focus_area` enum already covers most of the brief's category list — `supabase-migration-075:14-22`, `141:17-26`), and `outreach_targets` with a **working daily server-side nudge cron** (`api/target-followup-reminders.js`, `vercel.json` `"0 13 * * *"`). The weekly loop has a shipping precedent to extend, not to invent.

### 1.7 PASSPORT — **the proof surface exists; the verification ladder does not**

Sharing is essentially complete and built to the right security shape: `passport_share_tokens` with select-only RLS and **no** insert/update/delete policies, create/revoke through security-definer RPCs so `user_id` is always `auth.uid()` (`supabase-migration-078:15-54`), public reads through `get_public_passport_by_token()`, revoke listed in Settings with a failure that says so out loud ("That link was NOT revoked — it is still live", `golsz-app.html:2492-2516`).

Verification is **one binary plus one request queue**: `profiles.identity_verified`, `verification_requests` with a typed `proof_url` (`supabase-migration-058:23-33`). The 7-way trust-stamp row at `:6115-6135` renders under `{!real &&` — **demo only, never for a real athlete**. The only per-datapoint provenance that reaches the database is `athlete_benchmarks.measured_by` ∈ (self, coach, official).

The public passport omits **benchmarks and the career timeline** — the two things most load-bearing for "what can this athlete prove" (`:5288-5340`).

### 1.8 OPPORTUNITY ENGINE — **a dated-events table and a hardened search; nothing else**

`events` (`supabase-migration-002:47-57`, personal/private added in 011) covers trials, combines, camps, showcases, with `search_events()` security-definer, hardened in `126:922-983` to exclude private rows, and already called by Scout (`api/scout.js:4371-4384`). No universities, clubs, academies, agents, scholarships or leagues. No `opportunity_type`, no deadline, no eligibility fields, no provenance column. `clubs` is recorded as an empty read-only directory (`supabase-schema.sql:30-32`). **No match scoring of any kind:** grep for `match_score` / `matchScore` / `% MATCH` returns nothing.

### 1.9 PROGRESS + WEEKLY LOOP — **the inputs exist in production and nothing reads them**

Dated series that exist: `development_plan_ticks` (one row per habit per day, indexed `(user_id, tick_date desc)`), `athlete_benchmarks.recorded_date`, `daily_activity`, `athletes.timeline`.

**Already migrated with correct RLS and literally zero call sites** (verified: `grep -c` returns 0 in `golsz-app.html` and 0 across `api/`):
- `athlete_schedule` (`095:45-63`) — weekly routine, reminders, 12 activity types. **Keyed on `day_of_week`, no date column** — a routine, not a task table, so it is *not* a shortcut to the action table.
- `athlete_diary_entries` (`095:71-86`) — per-day energy, sleep, soreness, **readiness 1-10**. These are the brief's availability inputs.
- `athlete_outcomes` (`101:19-36`) — **append-only, dated, RLS'd, with `outcome_type` already covering `trial_unsuccessful`, `transfer_completed`, `position_changed`, `offer_received`, `college_commitment` and an `evidence` tier.** This is the "never delete pathway history" table, already in production, zero readers, zero writers.
- `dismiss_next_move()` (`070:13-21`) — **the brief's MARK DONE, already written, already granted to `authenticated`, zero call sites in the entire repo.**
- `profiles.scout_assessment` jsonb (`107:26`) — zero readers, zero writers.

No weekly-loop machinery exists, and it cannot exist until an action carries `completed_at` and a status log.

---

## 2. WHAT IS BLOCKED ON DATA, NOT CODE

Read this section to the end before approving anything in section 3. Four of the brief's headline promises cannot be built honestly today, and the reason is never engineering.

### 2.1 Benchmark reference standards — the headline blocker

```
api/scout.js:2088    const BENCHMARK_BANDS = [];
```

Empty. Deliberately. `readinessScoringReady()` (`:2718`) returns `ready:false` on **both** legs — no bands, and every value in `READINESS_WEIGHTS` is `null` with the stated rule "a null weight means not yet decided and the engine must refuse to score rather than substitute a default."

That emptiness is pinned in place by **two test suites** (`tests/test_readiness_foundation.cjs:96`, `tests/test_benchmark_intelligence.cjs:106`) and **two production migration headers** (`112:33-35`, `114:31-34`: "BENCHMARK_BANDS is still empty, readinessScoringReady() still returns false, and no comparison is offered anywhere in the UI").

Worse for a soccer-first brief: of the four entries in `BENCHMARK_SOURCES` (`api/scout.js:1962+`), two are **NBA Combine** and two are **hand-vs-electronic timing methodology papers**. Not one soccer source is even registered.

**The code to consume reference data is already written, already validated, already tested, and called from nowhere in the request path**: `compareToReference` (`:2605`), `benchmarkBandFor` (`:2648`), `selectReferencePopulation` (`:2194`), `resolveCurrentLevel` (`:2672`), specificity and sample-size tiers (`:2133-2251`), unit conversion, `validateBenchmarkBand` requiring 15 provenance fields, and a full RFC-4180 CSV importer with per-line rejection reports (`:2563-2598`). Roughly **700 lines of correct, unreachable inventory.** Nobody should re-specify it.

**What is blocked:** per-area scores that carry a rating; position-weighted scoring; "you are below what this goal requires"; any capability bottleneck; any athletic-fit component of a match score.

**What would legitimately fill it:** sourced distributions per sport / metric / sex / age band / competition level / measurement protocol, each with source name, source URL, source date and sample size — the fields `validateBenchmarkBand` already demands. Realistic sources: national federation testing batteries, published academy screening studies, peer-reviewed youth-soccer normative data. This is literature work, measured in weeks of someone reading papers, not sprints.

**There is also nowhere to put it when it arrives.** `api/scout.js:2573-2575` states persistence is "deliberately unbuilt — there is no benchmark-population table yet, only the in-memory `BENCHMARK_BANDS`". An import today is validated and then lost at process exit.

**What the UI shows in the meantime:** the honest answer, which this codebase already knows how to render. "Not compared — measured differently, or the method was not recorded" (`bench_trend_incomparable`, `golsz-app.html:663`) and "Method not recorded" are the existing precedents. An area with no metric and no reading reads **UNKNOWN**, not 0%, not "average", not a ring at 50%.

### 2.2 The "86% MATCH" score — blocked, and the most dangerous item in the brief

There is no opportunity catalogue to match against. No university records. No club records (`clubs` is empty and read-only). No eligibility rules — `grep "insert into golsz_knowledge"` across all 143 migrations returns **nothing**; the knowledge table has never been seeded, so GOLSZ Core is empty by construction. No level vocabulary beyond free-text `events.level`. No academic requirement data. `resolveCurrentLevel` (`:2672`) correctly returns `known:false` unless the level was explicitly stated, and never infers one from a club name.

`outreach_targets` has `fit_reasoning` — **explanation without a score**, the exact inverse of what the brief asks for.

**A percentage computed over an empty catalogue is a fabricated number wearing a deterministic alibi.** That is precisely what the brief's own rule ("AI may explain, never invent the score") exists to prevent. Shipping it is the one thing that would make this product feel fake, and it would be fake.

**What would legitimately fill it:** a curated catalogue with provenance per row — who entered it, from what source, when, and when it expires. `golsz_knowledge` already has exactly that shape, including `recheck_after` so time-sensitive knowledge "must expire rather than silently harden into permanent fact" (`096:16-38`), with RLS exposing only verified/active rows to clients (`115:5-7`). The machinery is built. **The catalogue is the project, and it is content operations, not engineering.**

**Meanwhile:** show real `events` rows with their real fields and no score. Scout may *discuss* fit in prose, which it already does. No percentage appears anywhere until a catalogue with provenance exists.

### 2.3 COACH-VERIFIED / CLUB-VERIFIED / DATA-PROVIDER-VERIFIED — structurally blocked

There is no second party in this product who could sign an attestation. Migration 138 is `remove-scout-coach-physio`. `coaches` and `agents` are recorded as "RLS on, zero policies, fully locked" (`supabase-schema.sql:31-32`). Migration 132 dropped the follow write policies; migration 143 revoked `search_players` from `authenticated` and `anon`; Feed/Discover/Messages are defined and mounted nowhere.

Creating a verifier account type **reopens the cross-account contact surface that 139 and 143 just deliberately closed**, and the brief separately forbids building a social network.

**Buildable now:** SELF-REPORTED, ATHLETE-UPLOADED, VIDEO-SUPPORTED, GOLSZ-VERIFIED (admin-reviewed, reusing `admin_review_verification`'s security-definer + `is_admin()`-inside-the-body pattern, `058:50-67`). **Ship four of seven tiers and label the other three as not yet available** — do not render a greyed-out COACH-VERIFIED chip that can never light up. That is what the demo trust-stamp row already is, and it is correctly hidden from real athletes.

### 2.4 Soccer technical and defending metrics — no inputs exist

`SPORT_SCHEMAS.soccer.performance_indicators` (`api/scout.js:1636-1645`) has eight metrics: `sprint_10m`, `sprint_40m`, `vertical_jump`, `yo_yo`, `match_minutes`, `goals`, `assists`, `clean_sheets`. **There is no technical metric and no defending metric at all.** "Exposure" exists only as a label (`:1595`) and an athlete-stated field.

Production volume: `supabase-migration-142:4-5` records **three benchmark rows platform-wide** as of 2026-09-18. `golsz-app.html:11857-11860` records 14 athletes, 1 pathway plan, 0 steps, 0 dated, as of 2026-09-12.

**Consequence worth stating plainly: the pathway and assessment engines are effectively pre-launch. "Never destroy production data" is cheap here. The risk is entirely in the shape chosen, not in migrating rows.** And every chart will be empty on day one — which must read as UNKNOWN, never as flat.

### 2.5 Honest alternative to all of the above, buildable now with zero invention

A **requirements-presence gap engine**. Each pathway already declares `key_evidence` (`api/scout.js:1664-1682`, e.g. `ncaa: grad_year, gpa, match_minutes, film, exposure`). Evaluate it against the athlete's actual rows and return **present / missing / unknown** per requirement. No standard is asserted, no number is invented — it is a presence check. That gives a real requirements gap for Home, Plan and Scout, and it is days of work.

Pair it with the athlete's **own stated** `main_gap`, which `scout_context` already captures as `{value, source, confidence}` with source forced server-side to `athlete_stated` (`125:47-96`) and which currently feeds nothing but a prompt string. Label it self-reported. **That is the cheapest honest bottleneck GOLSZ can ship, and it needs no schema and no research.**

**Do not relabel `weakest` as "BIGGEST BOTTLENECK".** It names what is holding back the athlete's *use of the app*, not what is holding back the athlete. Shipping it under the brief's name would quietly overclaim, and it would be the same class of error as the Home-vs-Scout contradiction of 2026-08-10 that `api/_readiness.js:14-16` was written to close.

---

## 3. THE BUILD ORDER

Nine phases. Each is independently shippable and leaves the app working. Sizes are solo-developer calendar estimates for someone who knows this codebase, and they include the tests each phase needs — a phase without its tests is not shippable here, because this repo's 74 suites are the only thing standing between a jsonb rename and silent data loss.

**Phases 0-8 total roughly 16-22 weeks of focused solo work.** Phase 9 and 10 are gated on content, not code.

---

### PHASE 0 — TRUTH PASS (3-5 days) — *do not skip, do not parallelise*

No features. This phase exists because three things in the repo currently assert something false, and designing thirteen new concepts on top of them is how the next migration-131 incident happens.

**What gets built:**
1. **Reconcile `supabase-schema.sql` against live `information_schema`.** It calls itself the ledger of what is deployed and is missing **three applied migrations' columns**, verified: `grep -c "current_stage_id\|full_access\|metric_key" supabase-schema.sql` → **0**. Two of those three are the exact pathway and benchmark columns this brief extends. `131:1-11` spells out the cost: "PostgREST rejects an ENTIRE select for one unknown column, so a missing `full_access` does not degrade the profile read, it destroys it."
2. **Fix `tests/test_schema_reference_current.cjs`.** It passes today while the file is three migrations stale, because it asserts only that the schema file *mentions the newest migration number* (`:17-25`), not that any column exists. Add a column-existence assertion for every column the client selects.
3. **Settle the RLS convention, in writing, before thirteen tables are written to the wrong one.** Ten tables use four named policies with `user_id = auth.uid() or is_parent_of(user_id)` (`076:25-45`, `075:29-49`, `072:29-48`, `071:28-42`). The newest table deliberately broke it — `development_plan_ticks` is self-only, justified at `141:33-41` on the grounds that "parent accounts were turned off in 144". **There is no migration 144** (verified: `ls | grep -c migration-144` → 0). Either it exists unfiled in production — 131 is precedent that hand-applied changes have gone unrecorded — or the justification is wrong. Get the answer before writing any policy.
4. **Run the verification queries nobody has run:** migration 128's own VERIFY block (`128:37-41`), `select count(*) from pathway_plan where stages <> '[]'`, `select count(*) from athlete_outcomes`, `select count(*) from athlete_benchmarks`. Record the answers in the repo.
5. **Correct `SPEC-custom-pathway-stages.md:3-4`** to say it shipped in c4e8c15.
6. **Fix four cheap defects while you are in here:** Reschedule renders on an undated step and deep-links a null day so nothing opens (`:10019` vs `:13117`); Scout labels are capped 200 server-side but truncated to 120 on acceptance, silently mid-sentence (`api/scout.js:3111` vs `golsz-app.html:11425`); `schoolsFact`'s `"replied"` status can never fire; `positions: ["gk","cb","rb","lb"]` is declared server-side for `clean_sheets` (`api/scout.js:1644`) and dropped by the client mirror (`:4520-4528`), so **a striker is offered "Clean sheets" today** — and `tests/test_benchmark_input.cjs` diffs keys, labels and units but not the gate.

**What the athlete can newly do:** nothing. **What you gain:** the right to trust the next eight phases.

---

### PHASE 1 — ACTION ENGINE, DATA LAYER (3-4 weeks)

The brief puts this first and it is correct: Home, Plan and Scout all depend on it.

**Decision, stated plainly: move to a real table.** The jsonb array has no concurrency control — `save()` (`:11668-11701`) is a full-row upsert of six fields from component state with no version or `updated_at` guard. It survives today only because of three separate mitigations for the same structural problem (a promise chain `:11661`, a ref `:11665`, a re-read before write `:4752-4757`) **and because Home deliberately refuses to reschedule or drop** (`:9663-9666`). The brief adds writers — Scout reschedule, Scout drop, a weekly recalculation — so the mitigations stop holding. jsonb also cannot be filtered or indexed: Home already fetches the whole array on every load to count two numbers (`:9403`), and so does the server (`api/scout.js:5728`).

**Files and tables:** migrations 145-147 (below). New `api/_actions.js` shared module (free — not a deployed function). `golsz-app.html` readers left on jsonb this phase.

**Work:**
- `athlete_actions` table with the brief's full field list, `sort_order` preserving array position (**position is semantic** — `moveMilestone` `:11938-11945` reorders by index and `undoDelete` restores by index), and **`due_src` carried forward column-for-column**.
- `athlete_action_events` append-only log: every status change, every date change with its prior value, every drop with a reason and timestamp. This is what makes `Rescheduled` and `Dropped` representable and satisfies "never delete pathway history."
- Migration from jsonb via `jsonb_array_elements`, **preserving `id`** so no in-flight client loses its keys. The jsonb column is **not dropped** — it stays as the legacy source through Phase 2.
- Security-definer write RPCs (`create_action`, `update_action`, `complete_action`, `reschedule_action`, `drop_action`), allowlisted per migration 125's template, with `origin` ∈ (athlete, scout, system) **forced server-side** so "a malicious client cannot launder an inference into a statement."
- **Re-apply the four `due_src` gates against the new table** — `nextMilestone` ranking, the overdue label, Home's `stepOverdue`/`stepsLate`, the OVERDUE band — with a test that a `due_src='scout'` date never marks an athlete overdue and never outranks an athlete-authored date.
- Extend the data-export registry (`golsz-app.html:2038-2060`) to cover **both shapes** during the overlap.

**What the athlete can newly do:** nothing visible. This is the one phase with no user-facing payoff, and it is unavoidable.

**Test surface:** `tests/test_pathway_milestones.cjs` holds **55 cases**; plus `test_plan_week.cjs`, `test_plan_writes.cjs`, `test_scout_pathway_filing.cjs`, `test_suggested_extractors.cjs`, `test_data_export.cjs`, `test_schema_reference_current.cjs`. All of them must pass against both shapes before Phase 2 starts.

---

### PHASE 2 — ACTION ENGINE, READER CUTOVER + FIELDS (2-3 weeks)

**Work:** cut the ~8 client read sites (`:4752, 8234-8257, 9403, 9659-9682, 11624-11633, 11668-11701` and all of PathwayPlan's mutators) and the 2 server sites (`api/scout.js:5719-5728, 5783-5821`) over to the table, **all writes through `_actions.js` so there is still exactly one writer.** Then add the fields: `category` (11 values, seeded from `development_plan_items.focus_area`'s existing enum rather than a new list), `priority`, `description`, `reason`, `evidence_requirement`, `completed_at`, `goal_id`, and the six-state `status`.

A **dropped** action must be excluded from `nextMilestone`, the band counts, the done/total counters (`:9856-9864`, `:11995`) and the calendar dots — four places, easy to miss three.

Every new string needs **four i18n entries** — the parallel blocks at `:375-524, 719-868, 1066-1214, 1413-1561`. `tests/test_i18n_keys_resolve.cjs` exists and will catch a missing key; it will not catch an English string pasted into the Spanish block.

**Decision required from the owner:** do habits merge into actions? Honest options: **(a)** leave `development_plan_items` + `development_plan_ticks` as the recurring case, declare them out of the Action Engine's scope, and say so in a comment — *hours*; **(b)** give actions a recurrence concept, migrate habits and their per-day tick history, and re-decide what the readiness ring counts — *weeks, and it touches the score*. **Recommend (a).** `141`'s own header states item status is the habit lifecycle and "is NOT a daily state"; collapsing the two loses that distinction and the tick table is the only real time series GOLSZ has.

**What the athlete can newly do:** reschedule and drop an action **from Home**, without being handed off to Plan; see a category, a priority and a real reason on each action; and never silently lose an action's history.

---

### PHASE 3 — REQUIREMENTS + BOTTLENECK ENGINE, HONEST VERSION (1-2 weeks)

**Work:** new `api/_gap.js`. Evaluate each pathway's declared `key_evidence` (`api/scout.js:1664-1682`) against the athlete's real rows and return **present / missing / unknown per requirement**. Surface the athlete's own `main_gap`, labelled self-reported. Name the biggest bottleneck as *the highest-priority missing requirement for the current stage*, with `weakest` kept as a clearly separate "complete your Passport" line under its existing name.

Wire the result into the slot `weakest` already occupies in the Scout prompt (`api/scout.js:6661-6670`) — **copy that block's wording verbatim**, including "These numbers are authoritative. Never state a score that is not in this block, never invent a sixth category." It is the correct pattern and it is already proven.

**What the athlete can newly do:** see what their stated goal actually requires, which of those things GOLSZ can see they have, and which it cannot see — with UNKNOWN where it does not know, never a guess.

**Explicitly not in this phase:** per-area capability scores, position-weighted scoring, any "you are below the level this requires". Blocked per §2.1.

---

### PHASE 4 — HOME AS COMMAND CENTRE (1 week)

Cheapest phase with the largest visible payoff, because most of it is already computed.

**Work:** render `leverKey` + `projectedWeak` (dead since written, `:9592-9595`, strings already translated in four languages) as the BOTTLENECK card, now fed by Phase 3's requirement gap. Add TODAY and THIS WEEK (4/7) as a **week-scoped** fraction — the week derivation already exists on Plan as `calView.days` (`:12076`); counting `weekDays.flatMap(d => d.rows)` fixes the lifetime-vs-week bug in **both** places (`:10216` and `:12355`). Either mount `PathwayStrip` (written, matches Home's already-resolved stages, never rendered) or add a compact progress line; delete it if neither. Delete or wire the dead `doors`/`schoolsFact` block and the five orphaned `home_week_*` keys.

**One deliberate decision, not a rebuild:** Home's week calendar was removed on purpose (`:9808-9820`) for competing with the goal and the next-action card. Re-adding "4/7" as a *number* is not the same as re-adding the calendar. Re-add the number only.

**What the athlete can newly do:** open Home and see, in one screen, what is due today, how this week is going against seven days, what is actually blocking them, and where they are on the pathway.

---

### PHASE 5 — PATHWAY: PER-STAGE FIELDS (2 weeks)

**Half-day prerequisite that must land first.** Five separate projections strip every key that is not `id` or `label` — `golsz-app.html:11634`, `:11213-11215`, `:8244`, `api/scout.js:5871`, `:3058-3065` — and every save rewrites the whole array from state (`:11682`). A new per-stage field would survive its migration and **die on the next stage rename**, silently erasing target dates on all seven stages. Widen all five projections, add a `normalizeStage()` modelled on `normalizeMilestone()`, and add a test that a stage round-trips an unknown key through load → rename → save.

**Work:** `status`, `target_date`, `blockers[]`, `evidence[]` per stage in the existing jsonb (no CHECK constraint by design, `128:23-25`), plus UI in `stagePanel()` (`:11755-11796`). Requirements render from Phase 3 at **pathway** level, as-is, never invented per stage. Per-stage percentage is arithmetic on data that already exists.

**Wire `athlete_outcomes` as the pathway history log** (migration 148) — it is append-only, dated, RLS'd, has the right `outcome_type` vocabulary and zero writers. That gives rerouting the before-state it needs. Stop deleting stages: mark `{removed_at}` instead of filtering out (`:11842-11848`).

**Fix two defects:** `PathwayMap` (`:11227`) ignores `current_stage_id` entirely and recomputes from `recruiting_status`, so "Set current" has **no visible effect on Plan's live map** — pass the resolved index in instead. And the test meant to prevent exactly that (`tests/test_pathway_milestones.cjs:261-262`) passes only because its regex matches **dead code inside the unmounted `PathwayStrip`**; Home's live version does not match the regex at all. Rewrite it to count stated-vs-inferred derivations rather than match one spelling.

Also: accepting a Scout pathway in **add** mode replaces the sections while keeping the athlete's steps, orphaning every filed step and leaving `current_stage_id` dangling, with nothing on screen saying so (`:8238-8250`). Remap by stage position, or refuse, and say how many steps will be unfiled.

**What the athlete can newly do:** give each stage a target date and a status, record what is blocking it, and see a pathway that remembers what it used to be.

**Not in this phase:** alternative routes as branches (collides with `MAX_STAGES=7` and needs its own storage shape), computed rerouting (needs eligibility and calendar facts the brief forbids inventing — the most that can honestly ship is "your route changed, here is what Scout can discuss").

---

### PHASE 6 — SCOUT: ACTION VOCABULARY, DATES, AVAILABILITY (2-3 weeks)

**Work, in this order:**
1. **Parallelise `getAthleteState`'s eight reads first.** They are sequential awaits (`api/scout.js:5675-5775`) despite a comment at `:5625` claiming they are "five small parallel queries (one round of Promise.all, not serial)". The whole handler lives inside `SCOUT_BUDGET_MS = 50000`. Do this before adding reads, not after.
2. **Tell Scout what day it is** — as a server-computed, pre-bucketed line (today's date, today/this-week/overdue/missed counts and labels), not by asking the model to do date arithmetic. The prompt currently states "You are not told today's date and must never write one" (`:4257-4259`); that rule becomes "use only the dates in this block." Today, THIS WEEK 4/7, Overdue and "what you missed" are **literally uncomputable by Scout** until this lands.
3. **Extend `responseCacheFingerprint` (`:810-822`) in the same pass**, with an action-state digest plus today's date. It currently keys on plan, goal text, pathway booleans and the readiness composite — nothing time-varying. Without this, "what should I do today" can be served from **yesterday's cached reply**. That is a silent correctness bug, not a performance one, and `tests/test_response_cache_key.cjs` exists to extend.
4. **New structured action kinds** beside the six existing extractors, each with a validator as careful as the `stage_index` one: reschedule an existing action, drop one, create a standalone training/testing/film/outreach action outside a pathway. **A model must never be allowed to name an existing action id** — resolve by index into a server-sent list, exactly as `extractSuggestedPathway` does for stages. Widen `NEXT_ACTION_TYPES` (`:3868`) beyond its three app destinations.
5. **Availability:** two reads added to `getAthleteState` for `athlete_schedule` and `athlete_diary_entries` (both already in production with correct RLS and zero readers), rendered as a training-load line and a readiness/soreness trend. **The medical-deferral boundary must survive this** — `:4039`, `:4292` and `ANTI_HALLUCINATION_RULES` rule 2 (`:5489`) forbid inventing an injury prognosis. Availability is a scheduling fact, not a diagnosis.
6. **Cheapest honesty win in the repo:** add `measured_by` and `protocol` to Scout's benchmark select (`:5756`) and tag the rendered line. Today a coach-measured 10m and a self-typed one are presented identically as "the record."

**Cost note the owner should know:** `athleteBlock` is sent as an **uncached** system block (`:188-189`, `:6894`) while only `systemStatic` gets the ephemeral cache mark. Every field added here is re-billed as fresh input tokens **on every turn**, and `budgetGate` (`:490`) walks tiers on exactly that number. Hand over computed results, terse and pre-bucketed, not rows.

**What the athlete can newly do:** ask Scout "what should I do today" and get an answer grounded in real dates; have Scout move or drop an action rather than only create one; have Scout know they trained four times this week and slept badly.

---

### PHASE 7 — PASSPORT: PROVENANCE + EVIDENCE (2-3 weeks)

**Decision, stated plainly: adopt the seven-tier `evidence_tiers` ladder that already exists** (`api/scout.js:1606-1610`: `ai_inferred < athlete_stated < parent_stated < coach_evaluation < measured_test < official_competition_result < verified_third_party`) as the one vocabulary, and map the brief's four states onto it. GOLSZ already has **four** provenance vocabularies — `{value, source, confidence}` (050), `protocol` + `measured_by` (114/142), `outcomes.evidence` (101), `knowledge.verification_status` (096). **Adding a fifth is the failure mode, not the feature.**

**Work:** migration 149 (per-claim provenance for the scalar Passport columns — `height_cm`, `weight_kg`, `gpa`, `grad_year`, `club_name`, `position` — which carry **no** provenance today and have no column to hold it), migration 150 (an evidence storage bucket with own-folder RLS; only two buckets exist in the whole client, `post-images` and `avatars`). Then: an evidence requirement on an action that stores a typed URL and, where a bucket exists, an upload. Render the tier on every claim. Extend `get_public_passport_by_token()` to carry benchmarks **with their measurement method** — that is the half that makes them credible — and timeline entries, each with its own privacy flag.

**Hard rule, non-negotiable:** `NULL` means *not recorded* and must **never** be backfilled to self-reported. `114:38-45` and `142:40-47` both make this explicit; breaking it would be a real regression and would silently upgrade three production benchmark rows into claims nobody made.

**Ship four tiers, not seven.** Per §2.3.

**What the athlete can newly do:** see, on every number on their Passport, where it came from; attach proof to an action; and share a public passport that includes the benchmarks and the career history, with per-section control.

---

### PHASE 8 — PROGRESS + WEEKLY LOOP (1-2 weeks)

Possible only after Phase 2, because it needs `completed_at` and the event log.

**Work:** migration 151 (`assessment_snapshots`, dated, so a score has a history — nothing is persisted today), migration 152 (`weekly_reviews`). The recalculation goes **inside the existing cron** `api/target-followup-reminders.js` (`vercel.json`, `"0 13 * * *"`), or a second cron entry calling an RPC — **not** a new endpoint. The don't-re-notify pattern is already proven via `outreach_targets.last_reminded_at` (`079:10`).

**Wire `dismiss_next_move()`** (`070:13-21`) or retire it — it has been granted to `authenticated` with zero call sites since migration 70.

**What the athlete can newly do:** start a week with goal → stage → bottleneck → priorities → actions, and end it with what they completed, missed and rescheduled, and what changed as a result.

**Honest note:** the charts will be empty for every existing athlete on day one (3 benchmark rows, 0 dated steps platform-wide). They must read UNKNOWN, not flat.

---

### PHASE 9 — OPPORTUNITY ARCHITECTURE (1 week of code, gated on content)

**Build only if the owner accepts that it ships empty.** Migration 154 adds `opportunities` with an `opportunity_type` taxonomy and provenance/curation columns, keeping `events` as the dated-event subset it already is. Deterministic scoring goes in a new `api/_match.js` and is handed to Scout as a *result*, per the readiness precedent.

**No percentage renders until the catalogue has rows with sources.** Until then the surface shows real `events` and nothing else. Per §2.2 — this is the one item where shipping the architecture early creates pressure to fill it with a guess.

---

### PHASE 10 — MULTI-SPORT TABLES (deferred, weeks)

The brief asks the backend to let other sports define their own positions, benchmarks, assessment categories, pathways and requirements. **That decision was already made the other way, deliberately, and documented.** `SPORT_PATHWAY_STAGES` covers 41 sports as a code constant in two hand-synced copies (`golsz-app.html:11092-11164`, `api/_sport-pathways.js:20-62`, diffed by `tests/test_sport_pathway_parity.cjs`), chosen over a table because `scout_model_config` **shipped empty to production and silently broke routing for months** (`api/scout.js:1565-1569`). `094:8-12` states outright that `sport_pathway_types` was not built "before any one sport has real authored pathway content."

**The precondition is authored soccer content.** Reverse this only after Phase 3 and 5 prove the shape, and keep `resolveSportSupportLevel()`'s cap (`:1776-1780`) so a row can never claim more support than the data behind it. Also: `sports.pathway_enabled` (`094:21`) has **zero readers** — wire it or delete it; a column nothing reads is a false declaration.

---

## 4. THE MIGRATIONS

**Before numbering anything: establish whether a migration 144 exists in production.** `141:37` cites one and the files stop at 143. If it exists, shift everything below by one.

| # | Name | What it adds | Why it cannot be a column | Touches athlete data? |
|---|---|---|---|---|
| 144 | `verify-and-reconcile` | No DDL unless introspection finds drift. Records the live-state reconciliation and the RLS convention decision from Phase 0. | Not DDL — this is the ledger entry the repo has been missing since 131 was hand-applied with no file. | No |
| 145 | `athlete-actions` | The unified action table: athlete, goal, pathway, stage, category, title, description, reason, priority, due_date, status, evidence_requirement, completed_at, **due_src**, origin, sort_order. Index `(user_id, status, due_date)`. | **No table in 143 migrations has a due date.** `milestones` is jsonb on a single row per athlete with no version guard; the brief adds writers, so the existing mitigations stop holding. | **YES — copies from `pathway_plan.milestones`. Copy, do not drop. `due_src` and array position must survive or Scout dates start calling minors late.** |
| 146 | `athlete-action-events` | Append-only status/date/drop log with prior value and reason. | History is one-to-many per action; "never delete pathway history" requires append-only rows, and a nested jsonb array inside each element is where jsonb stops being right-sized. | No (new rows only) |
| 147 | `action-write-rpcs` | Security-definer `create/update/complete/reschedule/drop_action`, allowlisted fields, `origin` forced server-side. | api/ is at 12/12 Vercel functions. **This is the only place the brief's "validated server-side" guarantee can live**, since `api/scout.js` uses the service key and bypasses RLS. Template: `125:47-96`. | No |
| 148 | `pathway-history-via-outcomes` | Extends `athlete_outcomes.outcome_type` with pathway/reroute events; adds a read index. | `outcome_type` is a CHECK constraint. The table is otherwise exactly right — append-only, dated, RLS'd to self + approved parent. | No — zero rows, zero readers, zero writers today |
| 149 | `claim-provenance` | Per-claim evidence tier for the scalar Passport columns, using the existing seven-tier `evidence_tiers` vocabulary. | `height_cm`, `gpa`, `grad_year`, `club_name` carry no provenance and **there is no column to hold it**; a tier plus verifier identity plus timestamp is one-to-many over time. | **YES — must insert nothing. `NULL` = not recorded and must never be backfilled to self-reported (114:38-45, 142:40-47).** |
| 150 | `evidence-storage` | Storage bucket + own-folder RLS for athlete-uploaded evidence, admin read. | A storage policy is not a column. Only `post-images` and `avatars` exist today. | No |
| 151 | `assessment-snapshots` | Dated per-area and composite score history. | A score history is one row per date; nothing persists a score today (`profiles.scout_assessment` jsonb has zero readers and zero writers). | No |
| 152 | `weekly-reviews` | One row per athlete per week: goal/stage/bottleneck snapshot, completed/missed/rescheduled counts, new evidence, `recalculated_at`. | One row per week per athlete. | No |
| 153 | `benchmark-populations` | The reference-band table the fully-built CSV importer has nowhere to write to. Read-only to athletes. | Reference data is not athlete data and needs different RLS. `api/scout.js:2573-2575`: persistence "deliberately unbuilt — there is no benchmark-population table yet." | No. **Ships empty — see §2.1.** |
| 154 | `opportunities` | Opportunity type taxonomy, deadline, eligibility, source/provider, curation provenance. `events` stays the dated-event subset. | `events` is user-created content policed by a fake-event detector (062), not a curated catalogue; mixing curation provenance into it would make a public directory into a claims table. | No. **Ships empty — see §2.2.** |
| 155 | `sport-definitions` | `sport_stages`, `sport_positions`, `sport_assessment_areas`, `sport_indicators`. | **DEFERRED.** Only build after authored soccer content exists; the argument to beat is `api/scout.js:1565-1569`. | No |

**One migration that must NOT be written:** changing `development_plan_items.focus_area`'s CHECK constraint to reconcile taxonomies. It has production rows, and `141`'s header is explicit that item status is a habit lifecycle, not a daily state. Seed the action `category` enum *from* that list instead; leave the constraint alone.

---

## 5. THE 12-FUNCTION WALL

`api/` holds 17 files. **Five are underscore-prefixed shared modules and are not deployed as functions** (`_acting-for`, `_entitlements`, `_plan-catalog`, `_readiness`, `_sport-pathways`). The twelve deployed functions are `admin-user-action`, `create-child-account`, `delete-account`, `geo`, `health-alert`, `moderate`, `scout`, `send-push`, `signup-guard`, `stripe-webhook`, `target-followup-reminders`, `verify-turnstile` — **exactly at the Hobby limit. No new endpoint is possible, and none is needed.**

Four seams absorb everything in this plan:

1. **Scout proposals need no endpoint at all.** They are fields on the existing reply contract (`api/scout.js:4131-4280`), extracted by a function beside the six existing extractors and attached at the same four response sites (`:7170, 7272, 7338, 7399`). Adding a seventh is a known, repeated shape.
2. **Writes need no endpoint.** Today the client applies Scout's proposals under ownership-only RLS (`golsz-app.html:8189-8262`). The new action table follows the same own-row pattern.
3. **Server-owned writes go in a security-definer RPC, not a route.** Migration 125 hit this exact wall and documented the resolution (`125:17-20`): "Adding an API route instead is not available: api/ is at exactly 12 of the 12 functions a Vercel Hobby project may deploy." Its answer — an allowlisted security-definer function with the field list hardcoded and the provenance forced server-side — is the template. **This is also the only place "validated server-side" can actually be true**, because `api/scout.js` runs with the service key and bypasses RLS entirely.
4. **If a sub-action dispatch is genuinely needed**, `api/scout.js` can take one at the body level. It currently reads only `messages/lang/conversationId/summary/requestId/athleteId` (`:6254-6307`) and dispatches nothing; the precedent for action-dispatch inside one function is `api/admin-user-action.js:257-274`.

**The weekly loop rides the existing cron.** `api/target-followup-reminders.js` is 308 lines, already scheduled daily at 13:00 (`vercel.json`), and already proves the don't-re-notify pattern. Adding the weekly recalculation there costs **zero functions**.

**Pure logic goes in new `_` modules, which are free:** `_actions.js`, `_gap.js`, `_match.js`. Five such modules already exist and are excluded from the count by design (`api/_readiness.js:31-32`).

---

## 6. RISKS TO THE WORKING PRODUCT

### 6.1 The single biggest regression risk: the date consent model

`due_src` + `suggestedDate` + `touchedMilestone` (`golsz-app.html:11443-11473`) gate **four** punitive surfaces. The brief does not mention them once. A migration that carries the data but not the gates will start marking fifteen-year-olds overdue on dates an AI chose — which is exactly the failure `:11434-11441` was written to prevent. **Four assertions, written before migration 145 runs, not after.**

### 6.2 PostgREST destroys a whole select for one unknown column

`131:1-11`. If migration 145 is written against a `supabase-schema.sql` that is three migrations stale, the first client select that names a column which is not there **does not degrade the profile read, it destroys it** — and the symptom is a blank screen, not an error on the column. Phase 0 exists for this.

### 6.3 Four writers on an unversioned jsonb row, during the overlap

Phase 1 and 2 run with both shapes live. The jsonb has no version guard and `save()` is a full-row upsert from component state. **The overlap window is where data is lost.** Mitigation: one writer module from day one, writes to the table authoritative, jsonb written as a derived mirror only — never the reverse.

### 6.4 Accepting a Scout pathway already orphans filed steps

`:8238-8250`, today, in production. It degrades quietly (`stageLabelFor` returns `""` so steps fall into "Not filed under a stage yet") and leaves dangling ids in the row forever. Any work that touches stages will either fix this or multiply it.

### 6.5 Three places assert something false right now

- `SPEC-custom-pathway-stages.md:3-4` says nothing is implemented. All of it is.
- `api/scout.js:5625` says eight reads are parallel. They are sequential.
- `tests/test_pathway_milestones.cjs:261-262` asserts the stated-stage invariant via a regex whose **only match is inside an unmounted component**. Home's live version does not match it at all.

A plan built from any of the three will be wrong in a way the tests will not reveal.

### 6.6 What the 74 test suites WOULD catch

Client/server scoring drift (`test_readiness_parity.cjs` extracts both copies at run time), sport pathway ladder drift (`test_sport_pathway_parity.cjs`), enum drift against live CHECK constraints (`test_enum_parity.cjs`), Scout extractor regressions (`test_suggested_extractors.cjs`, `test_scout_pathway_filing.cjs`), unresolved i18n keys (`test_i18n_keys_resolve.cjs`), compiled-bundle divergence from source (`test_compiled_artifact.cjs`), unchecked write errors (`test_write_error_checked.cjs`, `test_server_write_error_checked.cjs`), cache-key regressions (`test_response_cache_key.cjs`), Scout safety rules (`test_scout_safety_rules.cjs`, `test_no_unverified_classification.cjs`), and the 55 milestone cases.

### 6.7 What they would NOT catch — plan around these

- **Anything RLS.** No suite runs against a live database. A policy written to the wrong convention (self-only vs `or is_parent_of()`) ships green, and the failure mode is one athlete reading another's records.
- **A missing column.** `test_schema_reference_current.cjs` asserts only that the schema file *mentions the newest migration number* (`:17-25`). Verified: `grep -c "current_stage_id\|full_access\|metric_key" supabase-schema.sql` → **0**, and the suite passes.
- **Concurrent jsonb writes.** Nothing simulates two screens upserting the same row.
- **An English string in the Spanish block.** Key resolution is tested; translation is not.
- **Dead code.** Four components and RPCs are written, correct, tested-by-construction and mounted nowhere (`PathwayStrip`, `leverKey`/`projectedWeak`, `dismiss_next_move()`, the whole `doors` block). Nothing fails when a feature is built and never rendered — which is how this codebase accumulated the thing the brief is now asking for twice.
- **Prompt-level Scout regressions.** Structure is tested; whether the model still behaves after the prompt grows by 40 lines is not.
- **A stage field silently erased on rename.** Add that round-trip test in Phase 5 before the field, not after.

### 6.8 Honest sizing

Phases 0-8: **16-22 weeks solo**, and Phase 1 is the three weeks with nothing to show for them. Phase 9 is a week of code behind an unbounded content project. Phase 10 should not start.

**Two of the brief's nine subsystems — the "86% MATCH" opportunity engine and goal-relative capability assessment — are not schedulable at all.** They are gated on someone sourcing reference distributions and curating a catalogue, with provenance, by hand. Everything else in this plan is extension work on a system that already does more than the brief assumes.