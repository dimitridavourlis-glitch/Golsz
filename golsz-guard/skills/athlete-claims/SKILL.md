---
name: athlete-claims
description: Use when editing SYSTEM_PROMPT or CLASSIFIER_SYSTEM in api/scout.js, designing or parsing any model output contract, rendering scout_context or other inferred data in the client, writing loading and empty states, or gating a feature by plan. Covers what GOLSZ may state to an athlete as fact, and what must be asked rather than asserted.
---

# What GOLSZ may claim to an athlete

GOLSZ serves minors making decisions about their education and career. A
confident wrong sentence about a real institution is not a bad answer, it is a
wrong input into someone's life. Every rule here comes from a claim that
reached production.

## The output-shape ban

Scout told an athlete their own school was "Tusculum University (NCAA Division
III)". Tusculum is Division II. The athlete corrected it — and got a canned
FAQ about how NCAA divisions work in reply.

The fix is **not** "be careful when unsure". The model is not reliably unsure
at the moment it invents a parenthetical.

> **Being unsure is not the trigger. The trigger is the shape of the claim.**

The ban is on the *form*: classifying a real, named organisation — division,
tier, league, ranking, accreditation status — from memory. It applies whether
or not the model feels confident. Three escapes exist, all named explicitly in
the prompt: verify it with a tool, attribute it to what the athlete said, or
leave it out. Leaving it out is always available, and an answer with no
division in it is a good answer.

When you edit `SYSTEM_PROMPT`, the ban is the correctness guarantee. Routing,
escalation and model choice are performance decisions layered on top — an
earlier attempt put the guarantee in an escalation rule instead, which both
pushed ordinary chat to ~25s and left the guarantee dependent on a classifier
being right.

## When they correct you

An athlete correcting Scout about their own school, club or level is
**authoritative**. Use the correction, do not argue it, do not answer with
general reference material about the topic they just corrected.

Structurally: a correction must never route to the FAQ or the response cache.
`shouldUseFaqMatch()` and `withForcedCorrection()` exist for this, and
`withForcedCorrection()` is wired into **all four** `persistMemoryWrites`
sites — a correction that persists on three paths and not the fourth is a bug
that shows up as the athlete being corrected twice.

## Model output contracts

Two rules, both bought in production:

**A new field must not read like a value of a sibling field.** `is_correction`
was added as a boolean beside `intent`. The model wrote `is_correction` *into*
`intent`. That single leak cost the cheap model, the FAQ path and the cache
simultaneously, and it looked like a latency problem.

**Allowlists on model output degrade silently and all at once.** An unknown
enum value does not error — it falls through every branch and the request
takes the most expensive path available.

So: **repair at the parse boundary, never at the use site.**
`normalizeClassification()` in `api/scout.js` is where a leaked boolean gets
pulled back out of `intent` and an unrecognised intent defaults to
`career_advice`. Add new fields and their normalisation in the same commit as
the prompt change.

## Stated vs inferred

`scout_context` holds both what the athlete told us and what the model
inferred. **Rendering an inference as a statement is the same failure as the
Tusculum parenthetical, one layer down** — the athlete reads their own profile
and finds a fact about themselves they never gave.

`statedContextValue(scoutContext, field)` returns nothing for `ai_inferred`.
Three renderings, and the middle one is not optional:

- **stated** → show it as theirs
- **inferred** → show it as a question they can confirm ("Is this right?")
- **absent** → show the ask, not a blank

The backup plan on the Plan page is the athlete's own, not the sport's
statistical default. A pathway node with no label claims nothing and therefore
implies anything — when you delete a false claim, check what it was explaining.

## Absent is not zero, and unknown is not locked

**Loading, empty and absent are three different states.** A skeleton
(`SkeletonCard`) while loading; an explicit empty label with an action while
empty; never a `0` that reads as a measured result when nothing has been
measured.

The entitlement version of this shipped to paying athletes: `plan == null`
while the profile was still loading rendered **"Upgrade to unlock"** on every
gated page. The fix is three states, not two — `featureUnlocked`,
`featureLocked`, `planKnown`.

> **Invariant: no function returns "locked" when the plan is unknown.**

Check `planKnown` before showing any locked-state UI. When adding a gated
surface, this is the thing to get right first.

## Numbers and language

Say what a number is measured over. A readiness sub-score computed from two
inputs is not "your readiness" — and a percentage with no denominator invites
an athlete to compare themselves against a population that was never in the
calculation.

Prefer the athlete's own words for their goal and level over the taxonomy's.
If the stored goal contradicts the stored pathway, that contradiction is
visible to them and reads as the product not knowing who they are — surface it
as a prompt to resolve, do not silently pick one.
