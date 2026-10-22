# GOLSZ: briefing for legal counsel

Prepared 2026-10-22 from the code and from `terms.html` / `privacy.html` as deployed. It states
facts and open questions. **It is not legal advice and reaches no legal conclusion.** The
repository is public: nothing here is private, and counts for the owner to fill in are kept out
of it (see "Numbers to bring").

## What GOLSZ is

An AI sports-passport and pathway app at golsz.com. An athlete records sport, club, dated
benchmarks and a goal, gets a dated route of steps, and chats with an AI assistant (Scout).
Operated from Montréal, Québec, by its founder. Plans: Free, Basic, Pro, Elite, billed through
Stripe in CAD, USD and EUR. Stripe is live but has not yet taken a real payment.

## Corrections to a common misreading

- **Under-18s cannot register today.** The age rule is 18+. It is enforced in the client, in
  `api/create-child-account.js` (`PARENT_ACCOUNTS_ENABLED = false`; refuses every request) and,
  once migration 158 is confirmed applied, in the database (`handle_new_user()` rejects a missing
  or under-18 date of birth).
- **Parental consent is therefore not a launch question for the current product.** It is a gate
  on *re-enabling* managed profiles, and a question about the legacy rows described below.
- The questions that apply to the product as it runs today are items 1 to 7.

## Questions for counsel, in the order they bite

1. **Québec Charter of the French Language.** `terms.html` and `privacy.html` are English only
   (Terms § 25 says so). The operator is in Québec. Counsel to confirm what must exist in French,
   and when, before the terms can be relied on against Québec users.
2. **Law 25 (Québec) obligations.** (a) A privacy impact assessment before personal information
   leaves Québec; the data is stored in the United States (Supabase, Vercel) and processed by AI
   providers. (b) The person in charge of personal information: the policy names the founder;
   confirm or delegate in writing. (c) The confidentiality-incident register and the notice
   process and timing. (d) Retention periods per data category, backup period, and whether
   moderation records should keep the flagged text.
3. **Health information, a live feature.** Athletes can mark themselves hurt or limited in
   Settings or the daily check-in: status, start date, expected return date, a free-text note. No
   diagnosis is recorded. It is sent to Scout as context and can adjust their plan. Counsel to
   confirm whether express consent must be captured before an athlete records it (Law 25
   sensitive information; GDPR special category).
4. **AI providers.** Scout sends the question plus profile, plan and conversation context to
   Anthropic's API; moderation sends flagged text there too; xAI is an emergency fallback. Nobody
   has verified the providers' retention and model-training terms for API usage. Counsel to
   confirm and the policy to be corrected to match.
5. **EU/EEA/UK 14-day withdrawal.** Terms § 6 gives a refund minus a proportionate amount if the
   customer asked for immediate service. Counsel to confirm whether the express request and
   acknowledgement must be captured at checkout, not only stated in the terms.
6. **Operator identity.** Terms need the registered legal name and address (Québec Consumer
   Protection Act, distance contracts). Also: the notice wording for term changes (CPA s. 11.2).
7. **Policy accuracy.** `privacy.html` says Cloudflare Turnstile "is not active". The signup
   code supports it but the site key in `golsz-app.html` is empty; whether Supabase Auth's CAPTCHA
   setting is on is an owner-only fact. Counsel will want the policy to match reality once the
   owner confirms.
8. **Legacy under-18 data.** Before 2026-09-20 an adult could create a managed profile for an
   athlete under 18, holding the athlete's name and date of birth in the adult's account. Before
   the 18+ rule (changed 2026-09-07) 16- and 17-year-olds could self-register. Counsel to say what
   must be done about that data: retention, deletion or notification.
9. **Reintroducing managed profiles, if ever.** `terms.html` (§ 3) marks the clauses that would
   have to be restored first. Today's flow, when it existed, was mutual in-app consent between
   adult and athlete, not identity-verified parental consent (COPPA / GDPR-K style).

## Who receives data

Supabase (database, sign-in, files; sign-in email through its delivery provider). Vercel (hosting,
server functions). Stripe (payments). Anthropic (Scout, moderation, web search tool). xAI
(fallback). Google Fonts, cdnjs and jsDelivr (a browser's IP address reaches them when pages
load). Browser push services (Apple, Google, Mozilla) if notifications are on. Exact hosting
regions for Supabase and Vercel: owner to confirm; not stated in the repo.

## Numbers to bring (owner runs these in the Supabase SQL Editor; read-only)

```sql
select count(*) filter (where is_minor)        as profiles_flagged_minor,
       count(*) filter (where parent_managed)  as parent_managed_profiles,
       count(*)                                as all_profiles
  from profiles;

select count(*) as approved_parent_links from parent_links where approved_at is not null;

select count(*) as availability_records from athlete_outcomes;
```

## Where the product already limits exposure

Adults-only contracting; account deletion and data export exist in the app; admin actions are
audit-logged; moderation and reporting exist; the shared Passport is opt-in and revocable by link.
Detail: `CLAUDE.md` § Current state (note: that file is not served publicly once the deploy step
`tools/unpublish-internal.cjs` is live).
