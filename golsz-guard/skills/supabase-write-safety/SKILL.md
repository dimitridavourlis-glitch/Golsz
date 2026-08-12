---
name: supabase-write-safety
description: Use when writing or reviewing any Supabase mutation in the GOLSZ codebase — insert, update, delete, upsert, or a mutating sb.rpc() — and when touching optimistic UI, admin actions, RLS grants, or CHECK constraints in a migration. Also use when an athlete reports something "didn't save", a row is missing, or a write appears to succeed but changes nothing.
---

# Supabase write safety

## The bug this whole skill exists for

**supabase-js RESOLVES with `{ error }`. It does not throw.**

```js
try { await sb.from("x").update(y).eq("id", id); }
catch (e) { console.error(e); }
```

This catches a network throw and **nothing else**. An RLS rejection, a
constraint violation, an expired session — all look exactly like success. The
UI keeps the optimistic value, the row never changed, and the athlete believes
their note, highlight or target was saved.

A scan found **36 such writes**. The error was not ignored; it was
*unobservable*, because the result was never bound at all.

## The shape

```js
const { error } = await sb.from("development_plan_items").update(updates).eq("id", id);
if (error) throw error;
```

Both binding forms count — `const { error } = await …` and
`({ error } = await …)` reassigning an outer binding.

A write need not be awaited. `sb.rpc(...).then(({ error }) => …)` is the other
shape in this codebase, and it must destructure `error` in the callback.

## Order matters

Check `{ error }` **before** `logAdmin()` and before any list refresh. An
admin action log that records a change which did not happen is worse than no
log — it is a false record that the next person will trust.

For optimistic UI: **snapshot → write → check `{ error }` → revert → surface a
per-item error.** A global banner is not enough when a list has ten editable
rows; the athlete has to know which one failed.

## When silence is acceptable

The rule is **SELF-CORRECTION, not importance.**

A like that failed to save springs back on the next feed load and the athlete
sees the truth unaided. A deleted highlight that failed to delete looks gone
until they return and find it. Silence is acceptable only where the next
render corrects it.

Currently accepted, each with a recorded reason: `post_likes`, `follows`,
`messages` (read receipts), `ensure_message_request` (idempotent, retried),
`push_subscriptions` (cleanup). Anything else that discards its result fails
`tests/test_write_error_checked.cjs`.

## The list of mutating RPCs is an allowlist, and allowlists rot

`sb.rpc()` is used for reads too, so mutating RPCs are listed by name. That
list was **already wrong** when written: seven entries, nine mutating RPCs
missing, one entry for an RPC the client never calls.

The suite now asserts both directions — every RPC called must be classified,
every classified RPC must still be called. **Adding a mutating RPC without
listing it fails the suite instead of passing unexamined.** If you add one,
add it to `MUTATING_RPCS`.

## Migrations

**`drop constraint; add constraint` rewrites the whole list.** Migration 111
recreated a CHECK constraint and dropped `'failed'` from the allowed values,
so every failed-request log row was silently rejected for months — the table
had zero failed rows in its entire history, which read like "nothing ever
failed".

When you touch a CHECK constraint, read the existing definition out of
`pg_constraint` first and carry every value forward. Verify after applying:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint where conname = '...';
```

**Client-writable RPCs**: force the trusted fields server-side rather than
trusting a parameter. `set_athlete_context_field` takes no `p_source` at all —
it writes `'athlete_stated'` itself, because a client that can name the source
can launder an inference into a claim. Authorization is own-row or
`is_parent_of()`; execute is granted to `authenticated` and **revoked from
`anon`**. Verify grants against `information_schema.role_routine_grants` after
applying, not by reading the migration you just wrote.

Keep the narrow RPC narrow: `merge_scout_context` (the wide writer) stays
`service_role` only. If that ever flips, the narrow one was pointless.

## Two allowlists that must agree

A field athlete-editable via the RPC but missing from `SCOUT_CONTEXT_KEYS` in
`api/scout.js` works when the athlete types it and **vanishes when Scout
writes it**, with nothing failing — because the write-path tests go through
the RPC, not through Scout. Enforced as a subset assertion in
`tests/test_athlete_editable_context.cjs`. Add new fields to both in the same
commit.

## Deploy

`api/` is at **12/12 on the Vercel Hobby function cap**. A new route needs an
existing one merged or a `_`-prefixed filename (excluded from the count).

```bash
npm run check > /tmp/check.log 2>&1 && vercel deploy --prod --scope golszcom
```

Gate on the real exit code — piping into `grep` takes grep's.
