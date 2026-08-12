---
name: launch-readiness
description: Use when asked what to work on next, whether GOLSZ is ready to launch, whether something should ship, or anything about pricing, payments, signup abuse, or the moderation backlog. Also use when summarising a session's work — this skill covers reporting progress honestly against what actually blocks launch.
---

# Launch readiness

## The asymmetry, which is the whole point of this skill

GOLSZ has two kinds of remaining work, and they behave differently:

**The correctness surface does not bottom out.** Every fix reveals the next
one. On 2026-08-11, the tool built to catch a class of silent write failure
contained **two more instances of silent failure of its own** — an allowlist
that was already wrong when written, and a detector blind to an entire call
shape. That is not a sign the work was done badly. It is what that surface is
like, and it will produce another finding tomorrow.

**The launch blockers are finite and countable.** They are the same three or
four things they were a week ago, and finishing them ends them.

A day can produce ten commits, all real, all correctness and trust, and move
**zero** blockers. That is worth naming plainly rather than reporting as
productivity. When asked what to work on, the default answer is a blocker.

## The blockers, as last established (2026-08-11 — re-verify before quoting)

This list goes stale. Check current state before repeating any of it.

1. **Turnstile keys unset.** The signup honeypot is client-side; a bot calling
   Supabase Auth directly bypasses it. Product serves minors — signup abuse is
   a safety issue, not just a spam one.
2. **Live EUR Stripe not configured.** No revenue can be collected. Test-mode
   keys pass every check that exists.
3. **~207-item moderation queue, unreviewed.** Real reported content on a
   platform with minors on it, waiting.

Nothing in the codebase fails when these are broken. They are all *absent
configuration and unperformed work*, which no suite can go red about — the
class that stays invisible unless someone asks directly.

## Verifying, not assuming

Each blocker has a check that distinguishes done from not-done:

- Turnstile: the env var is set **in the production environment** and signup
  rejects a request without a token. Reading the code that would use the key
  proves nothing.
- Stripe: a live-mode key and a completed EUR test purchase against live
  config — not a test-mode success.
- Queue: a count from `moderation_queue` where `resolved_at is null`, read
  now.

Do not report a blocker cleared on the strength of the code being written. All
three fail in configuration, not in code.

## Shipping

```bash
npm run check > /tmp/check.log 2>&1 && vercel deploy --prod --scope golszcom
```

`api/` sits at **12/12 on the Vercel Hobby function cap** — a new route needs
an existing one merged, or a `_`-prefixed filename.

Migrations are applied by hand through the Supabase SQL editor. It is Monaco:
programmatic `setValue` bypasses React state and leaves Run inert, long
strings freeze the renderer. One statement at a time, then verify with a
`select` against `pg_constraint` / `information_schema` — never by re-reading
the migration file.

## Pricing and plan changes

Plan gating touches `featureUnlocked` / `featureLocked` / `planKnown` in the
client and `FEATURE_MIN_PLAN` server-side. The invariant that broke once and
must not break again: **no function returns "locked" when the plan is
unknown** — a loading profile once showed "Upgrade to unlock" to paying
athletes on every gated page. See `athlete-claims`.

## Exercise the boundary that defines a tier before shipping it

Free / Starter €6 / Pro €14 / Elite €30 were differentiated by exactly one
thing: a question cap. That cap **could not fire** — the counter was clamped
before it was compared, so `allowed` was structurally always true (see
`measurement-integrity`). Every paid tier enforced nothing, and the pricing
page described behaviourally identical products.

The suites were green because they mocked the RPC as `{allowed: true}`. They
tested the handler's reaction to a limit, never that a limit existed.

**Before shipping a tier, hit its boundary for real.** A tier is a claim about
what happens at the limit; nothing else about it is checkable.

## Ask what a monitor does when the target hangs

`.github/workflows/health-alert.yml` had no `--max-time`, no
`--connect-timeout`, and no job `timeout-minutes`. If `/api/health-alert`
hangs — the most common outage shape, and the exact class of the incident the
file's own header cites — curl blocks, the job neither succeeds nor fails, and
**no alert is emitted at all.**

Compounding: GitHub silently disables `schedule:` triggers after 60 days of
repo inactivity, which a pre-launch repo hits routinely. Nothing inside the
workflow can detect that, because the thing that stops is the workflow.

**Absence of an alert is not evidence of health.** Every monitor needs a
timeout, and something outside it has to notice its silence.

## Two open leads — verify before treating as fact

Reported by reviewers, call paths read, defects **not reproduced**. They are
listed so they are not lost, not so they can be cited:

- **Signup gates may be advisory.** `api/signup-guard.js` states in its own
  header that it is "a real gate", but both it and `verify-turnstile.js` are
  called by the browser, which then calls `sb.auth.signUp()` directly with the
  anon key. If nothing binds a verified token to account creation, a script
  POSTing to `/auth/v1/signup` never touches either. Would not be fixable in
  application code — GoTrue must enforce it.
- **Internal terminology may reach athletes on the retry path.** The
  `req:<requestId>` cache may be written before `reply_text` and the
  suggestion fields are attached, so a timeout retry could replay an object
  that bypasses `stripInternalTerminology` / `stripMetaCommentary`.

Verify the write ordering and the signup call path before writing either up as
a rule. A plausible rule with no confirmed failure behind it teaches the
reader to skim.

## Reporting honestly

At the end of a stretch of work, say which of these it was:

- moved a blocker
- removed a way the product lies to an athlete
- removed a way the codebase can fail silently
- none of the above

All four are legitimate outcomes. Conflating them is not. "Ten commits, all
green, no blocker moved" is a more useful sentence to the person deciding
what happens tomorrow than any list of what was fixed.
