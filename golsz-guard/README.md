# golsz-guard

Four skills that carry the GOLSZ project's hard-won rules into every Claude Code session,
instead of leaving them in READMEs and comments that only apply when someone reads them.

| skill | triggers on |
|---|---|
| `measurement-integrity` | queries, scans, test suites, "the tests pass", a number that didn't move |
| `supabase-write-safety` | any insert/update/delete/rpc, optimistic UI, admin actions, "it didn't save" |
| `athlete-claims` | SYSTEM_PROMPT edits, model output contracts, rendering scout_context, loading and empty states, gated features |
| `launch-readiness` | "what should I work on", "is this ready", anything about shipping or pricing |

## Install locally

From the repo root:

```bash
cp -r golsz-guard .claude/plugins/
```

Or test without installing:

```bash
claude --plugin-dir ./golsz-guard
```

## Keep it current

These skills are written from specific production failures. When a new one is found and
fixed, add the rule *and the failure it came from* — the reasoning is what makes the rule
survive contact with a case it does not literally cover.

Do not add a rule that has not cost something. A skill full of plausible advice trains
the reader to skim it.
