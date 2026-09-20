# GOLSZ

An AI sports-passport and pathway app for athletes aged 18 and over. Live at
**[golsz.com](https://golsz.com)**.

An athlete records what they have actually done — sport, position, club,
benchmarks with the method and date each was measured — names a goal, and gets
a route with dated steps. An assistant called **Scout** reads that record and
answers in the athlete's own context.

---

## Run it

```bash
npm ci            # required: 8 suites need @babel/parser and @babel/traverse
npm run check     # the gate — syntax-checks api/*.js and js/*.js, then the suite
```

`npm run check` must pass before any push. Pushing to `main` auto-deploys
production; there is no separate deploy step.

If you edit the JSX inside `golsz-app.html`:

```bash
npm run compile   # regenerates js/app.js — the gate fails if you forget
```

## What is where

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/main.js` | The marketing site. Static, English only. |
| `golsz-app.html` | The whole app — one ~1MB file, React via CDN, JSX in one `text/babel-deferred` block. |
| `js/app.js` | **Generated.** `tools/precompile.cjs` compiles the JSX at author time; the browser never compiles. Do not hand-edit. |
| `api/*.js` | Vercel serverless functions. **At the 12-function ceiling** — adding one means removing one. |
| `supabase-migration-NNN-*.sql` | The database, one numbered migration at a time. Each carries its reasoning. |
| `supabase-schema.sql` | Reference for what is deployed. See the warning below. |
| `tests/*.cjs` | 74 suites, ~3,150 assertions. Plain Node, no framework. |

## The tests are the thing to read first

There is no framework. `tests/run-all.cjs` runs every `test_*.cjs`. Many suites
lift real expressions out of the source and `eval` them, so they fail when the
source changes rather than when a mock does, and several have been verified to
fail when the bug they guard is reintroduced.

They are also where the codebase keeps its history: most suites open with the
specific failure that motivated them. `test_hook_order.cjs`,
`test_write_error_checked.cjs`, `test_client_scope.cjs` and
`test_features_off.cjs` are the ones that explain the most about how this app
breaks.

## Things that will bite you

- **`supabase-schema.sql` is an append-only ledger, not a clean dump.** It is
  safe to run against a brand-new project and unsafe against the live one — it
  contains `drop policy` / `create policy` pairs and data statements. Change the
  live database with a new numbered migration instead.
- **A JSX comment placed between `&& (` or `? (` and its element** parses as an
  object literal and has taken the app down five times. Comments go above the
  guard.
- **Hooks must not sit below an early return gated on state.** That crashed
  production for every signed-in user on 2026-09-18. `test_hook_order.cjs`
  guards it.
- **supabase-js resolves with `{ error }` rather than throwing.** Every write
  must check it. `test_write_error_checked.cjs` guards it.
- **Four languages** (en/fr/es/el). New user-facing strings need all four,
  appended at the END of each dictionary line.
- **Guard lines are byte-identical across components.** Edit by owning
  function, never by first text match.

## State of play

- **Payments are live but unproven.** Nine Stripe Payment Links (3 tiers x
  EUR/CAD/USD) and a webhook exist, but **nobody has completed a purchase**, so
  the signing secret has never been exercised by a real event.
- **`STRIPE_PORTAL_LINK` is wrong** — it holds a payment-link id, so no
  subscriber can cancel, while `index.html` says "Cancel any time". Fixing it
  means pasting the real portal URL from the Stripe Dashboard.
- **Parent accounts are off** behind `PARENT_ACCOUNTS_ENABLED` in
  `golsz-app.html`; the plumbing is intact and production had zero of them.
- **Athlete discovery is off** — migration 143 revoked execute on
  `search_players()`. The function and `athletes.scout_visible` are kept so it
  returns by decision rather than by rebuild.
- **Six components are defined and mounted nowhere**: Feed, Discover, Messages,
  FollowListCard, PostsGrid, BlockedAccounts. `PublicPassport` looks dead to a
  grep but is mounted via `React.createElement` — it is live.

`CLAUDE.md` is the long-form version of all of this, including the reasoning
behind most decisions. `SETUP.md` covers standing up a fresh environment.
