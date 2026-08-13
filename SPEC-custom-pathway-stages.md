# Custom pathway stages — settled decisions before any code

Written 2026-08-13, at the end of the session that rebuilt milestones. Nothing
here is implemented yet. Build order is at the bottom.

## The problem this must not create

`PathwayStrip` (Home) and `PathwayMap` (Plan) both read `SPORT_PATHWAY_STAGES`
directly today. That is fine only while stages are a constant. The moment an
athlete can rename or add one, the constant becomes per-athlete data and the
two screens drift — which is exactly the "two pictures of one object" failure
this week's work removed. It would come back through a different door.

**Settle this before the migration, not after.**

## Decision 1 — one resolver, and nothing else reads the config

Add a single function; both screens call it and neither touches
`SPORT_PATHWAY_STAGES` again:

```js
// The ONLY reader of SPORT_PATHWAY_STAGES. Home and Plan must draw the same
// pathway, so they must not each decide what the stages are.
function athleteStages(athlete, pathwayRow) {
  const custom = pathwayRow && Array.isArray(pathwayRow.stages) ? pathwayRow.stages : [];
  if (custom.length) return custom;                    // the athlete's own
  const cfg = SPORT_PATHWAY_STAGES[athlete && athlete.sport] || SPORT_PATHWAY_STAGES.__default;
  return cfg.stages.map((key) => ({ id: key, label: null, key }));   // label null = translate via key
}
```

- `label === null` means "render `t("pathway_stage_" + key)`" — the sport
  default, translated. A custom stage carries a real `label` string and is
  rendered verbatim, because the athlete wrote it and it is not translatable.
- **Assert it in the suite**: no component other than `athleteStages` may
  reference `SPORT_PATHWAY_STAGES`. That is a grep-able invariant and it is the
  whole protection. Without it this decays silently the first time someone adds
  a third surface.

## Decision 2 — `currentStageIndex` stops guessing once stages are custom

Today it infers position from `recruiting_status` and `club_name` against the
sport's known sequence. That inference is only meaningful while the stages are
the sport's. It cannot know what "Trials with Panathinaikos" means.

**So: when stages are custom, the athlete states where they are.** Add
`current_stage_id` to the pathway row. Inference stays only for the untouched
sport-default case.

This is the same rule as everything else here — stated beats inferred, and an
inference must never be rendered as fact. See `athlete-claims` in golsz-guard.

## Decision 3 — the migration (small, additive, no backfill)

```sql
alter table pathway_plan add column stages jsonb not null default '[]'::jsonb;
alter table pathway_plan add column current_stage_id text;
```

Empty `stages` means "use the sport's" — so every existing row keeps working
untouched, and nothing needs backfilling. Verify with a follow-up `select`
against `information_schema`, never by re-reading the migration file.

## Decision 4 — data safety, both directions

- **Stage identity is `id`, never the label.** Renaming "Senior" to "First
  team" must not orphan the steps filed under it.
- **Deleting a stage never deletes its steps.** They fall back to *Not filed
  under a stage yet* with the existing picker — visible and recoverable. A
  cascade here is the destructive-write bug removed from Scout this session,
  reintroduced by a different door.
- **Max 7 sections.** At the cap the add control is disabled *and says why*,
  never silently inert.
- **First edit materialises the sport defaults** into stored rows, so there is
  something concrete to rename or reorder.

## Decision 5 — entitlement: no change

`FEATURE_MIN_PLAN.pathway_plan` stays `"starter"`. Do not touch it. There is no
downgrade to manage and no grandfathering to build. Revisit only with real
subscriber data.

Two things still ship, because Free is locked out of Scout's help at Starter:

- **A persistent note on the pathway card** — *Scout can help build this* —
  shown to everyone, so a Free athlete knows the door exists.
- **The locked state explains, it does not block.** For Free: *Scout can draft
  your pathway on Starter — and you can build it yourself right here*, with the
  manual controls fully working underneath, never greyed out. `FeatureLock` is
  the wrong component: it replaces content, and here the content must stay
  usable. `planKnown(plan)` first, always — a loading plan must never render a
  paywall.

## Decision 6 — Scout edits stages through the same two-tap confirm

`api/scout.js` learns a `build_stages` action. It reuses the confirm panel
built for milestones: states what changes, what is kept, what is lost, and
writes nothing until a second, mode-carrying tap. `addSuggestedPathway`'s
`mode` guard is the precedent — no write path without an explicit choice.

## Build order

1. Migration, applied and verified by query.
2. `athleteStages()` + the suite assertion that nothing else reads the config.
   Both screens switched over. **No behaviour change yet** — this step should
   be invisible to users, which is what makes it safe.
3. Tap-to-edit on the map, add/rename/reorder/delete, the 7 cap, and deleting
   the EDIT PATHWAY card (its dropdown, timeline and notes move into the goal
   node's editor).
4. The note and the Free explanation.
5. Scout's `build_stages` last.

`npm test` between each. Nothing in one step depends on a later one.
