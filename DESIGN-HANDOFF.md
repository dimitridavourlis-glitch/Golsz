# GOLSZ — complete app inventory for redesign

A handoff document. Everything the app currently contains, what each part is
for, and the constraints a redesign has to respect. Written from the code, not
from memory — generated 2026-08-12.

---

## 1. What this is and who uses it

GOLSZ is an AI-powered athlete development and recruiting platform, based in
Nicosia, Cyprus. An athlete builds a verified profile ("Sports Passport"),
talks to an AI advisor ("Scout") about their pathway, and works a plan of
targets, benchmarks and development goals toward a specific goal — a university
programme, a club, a professional contract.

**Three facts that constrain every design decision:**

1. **Most users are minors.** Under-16 accounts are parent-managed by
   architecture, not by policy. Anything the interface asserts about a young
   person's prospects is an input into a real decision about their education.
2. **Four languages ship today**: English, Greek (Ελληνικά), Spanish, French.
   ~1,278 translated strings. Greek and French run 30–40% longer than English —
   any layout that only works at English string lengths is broken on arrival.
3. **Mobile-first, but there is a desktop sidebar.** Bottom tab bar on mobile,
   left sidebar on desktop, same four destinations.

**Tech reality that affects what you can ask for:** the entire client is a
*single HTML file* (~842 KB) with React and Babel compiled in the browser. No
build step, no component library, no Tailwind, no CSS framework. All styling is
inline style objects and CSS custom properties. This does not prevent a
redesign — it means new visual ideas must be expressible in plain CSS, and
"just add shadcn" is not available.

---

## 2. Navigation — four destinations

The live navigation is deliberately narrow:

| Tab | Label | Icon today | Purpose |
|---|---|---|---|
| `home` | Home | Home | Dashboard — status and the single next action |
| `scout` | Scout / AI Scout | Radar | Conversation with the AI advisor |
| `targets` | Plan | Share (branching) | Workspace — pathway, goals, targets, benchmarks |
| `profile` | Passport | User | The athlete's profile, titled **SPORTS PASSPORT** |

**Important for a redesigner:** several fully-built surfaces are deliberately
**not** in the launch navigation — `Feed`, `Discover`, `Events`, `Messages`,
`Highlights`, `Timeline`, `Benchmarks` as a standalone page. The social layer
exists and works; it was scoped off the nav for launch focus. Messages is still
reachable when a conversation is opened directly. Do not treat their absence
from the tab bar as "these don't exist" — and do not assume they're coming
back either. Ask before designing around them.

**Account** is not a tab — it opens as an overlay from a settings affordance.

---

## 3. Screen by screen

### 3.1 Home — the dashboard

*Job: answer "where am I and what do I do next" in one screen, for every plan
tier including Free.*

Contains, top to bottom:

- **Identity row** — avatar, name, sport, club, grad year. Verified badge if
  identity-verified.
- **Pathway strip** — a compact horizontal version of the pathway map: where
  the athlete is now and the next node. Includes an "also possible" caption for
  branches rather than an unlabelled node.
- **Next Move** — one deterministic recommended action with an icon and an
  explicit CTA button. Computed client-side, not asked of the model, so it is
  stable between sessions.
- **Readiness** — a composite score with a progress bar and plain-language
  status words. The composite renders for *every* plan; the deep numeric
  sub-score breakdown and "why this score" reasoning are Pro+.
- **Status strip** — icon + count summary (highlights, targets, benchmarks,
  etc.).

Sub-scores that feed Readiness are profile-completeness signals: sport, club,
grad year, country, recruiting status, bio, photo, highlights, career timeline.

### 3.2 Scout — the AI advisor

*Job: a conversation that produces real changes to the athlete's plan, not just
answers.*

- Chat transcript with an enlarged header ring, message timestamps, a waveform
  affordance, and an inline send control.
- Quick links as a list, not chips.
- Questions-remaining indicator for plan-limited tiers; Free has a lifetime
  budget rather than a daily one.
- Scout can take **persistent actions** that write to the athlete's data:
  build a target list, add development-plan items, build a pathway, draft
  outreach emails, record benchmarks.
- A guided assessment flow for new athletes and an accelerated "Direct to
  Elite" branch for advanced ones.

**Design constraint:** Scout has hard rules about what it may state as fact —
it may not classify a real named organisation (division, tier, league,
ranking) from memory. So Scout answers will sometimes *deliberately* omit a
detail a designer might expect to be there. Do not design a layout that
requires a field Scout is forbidden from filling.

### 3.3 Plan — the workspace

*Job: everything about the athlete's route is here, and all of it is editable
in place.*

- **Goal card** — the athlete's own goal in their own words.
- **Backup plan card** — the athlete's own backup, not the sport's statistical
  default. Three renderings: stated, inferred-shown-as-a-question, or absent
  with an ask.
- **Pathway map** — a diagonal visual route with labelled nodes, sub-labels,
  and a branch for the secondary pathway.
- **Next 30 / 90 days**, **Season**, **Targets** — collapsible rows.
- **Development plan items** — rename, reorder, edit goals inline.
- **Targets** — university/club outreach pipeline with status, fit reasoning,
  contact details, and drafted emails. Names and contacts are editable.
- **Benchmarks** — recorded results with retest history.

### 3.4 Passport — the profile

*Job: the thing an athlete shows a coach.*

- Rectangular photo, blue Verified badge, barcode motif, icon+count summary
  strip, tile sub-labels.
- Highlights (video links), career timeline, benchmark results.
- **PDF export** (Starter+).
- **Public share links** — revocable tokens, viewable with no login, with a
  soft call-to-action for the viewer.

---

## 4. Secondary surfaces

| Surface | Notes |
|---|---|
| **Auth / signup** | Email+password, Turnstile widget, honeypot. Password reset flow. |
| **Guided assessment** | First-run onboarding that produces enough context for Scout to be useful. |
| **Upgrade / conversion screen** | Free→paid, positioned across four tiers. |
| **Elite welcome** | Separate onboarding branch for the top tier. |
| **Family access / My Athletes** | Parent-managed accounts; a parent acts *for* an athlete, with a persistent "managing" banner. |
| **Public Passport** | No-login shared profile view. |
| **Admin panel** | Users, Moderation, Analytics, System, Reports, Auto Queue, Verification, Appeals, Audit log, Errors. Internal only, but it is real UI and currently unstyled relative to the rest. |
| **Banned / restricted screens** | Full-screen states for banned and rate-limited accounts. |
| **Verification request** | Self-service identity verification with admin review. |
| **Update bar** | Prompts a reload when a new client version has shipped. |

---

## 5. Plans and gating

Four tiers: **Free → Starter → Pro → Elite.**

| Feature | Minimum plan |
|---|---|
| PDF export | Starter |
| Targets | Starter |
| Benchmarks | Starter |
| Pathway plan | Starter |
| Readiness (deep breakdown) | Pro |
| Development plan | Pro |

**The rule that matters visually:** entitlement is *three-valued* in the UI,
not two. `unlocked`, `locked`, and **`plan not yet known`**. A loading profile
must never render a paywall — that bug once showed "Upgrade to unlock" to
paying athletes on every gated page for the two seconds before the plan
loaded. Any redesigned locked state needs a third rendering for "still
loading", and it must not be the paywall.

Free is explicitly **not** a crippled demo. Home's core job — "what should I do
next" — works fully on Free.

---

## 6. The three-state rule for all data display

This is the strongest cross-cutting design constraint in the product, and a
redesign will hit it on nearly every card:

1. **Loading** → a skeleton. Never a zero, never an empty string.
2. **Empty** → an explicit label plus the action that fills it. Never a blank
   area, never a `0` that reads as a measured result.
3. **Present** → the value.

And a fourth distinction specific to this product:

- **Stated** (the athlete told us) → render as theirs.
- **Inferred** (the AI guessed) → render as a *question they can confirm*, never
  as a fact about them.
- **Absent** → render the ask.

An athlete finding a fact about themselves on their own profile that they never
provided is the failure this prevents.

---

## 7. Current visual system

Light and dark themes both ship. Current tokens:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--pitch` | `#FDF9F2` | `#0A0A0A` | Page background |
| `--card` | `#FFFFFF` | `#131519` | Card surface |
| `--chalk` | `#F7F4EA` | `#0D1210` | Secondary surface |
| `--body-text` | `#1B263B` | `#ECE8DC` | Body copy |
| `--turf` | `#1B263B` | `#ECE8DC` | Headings |
| `--slate` | `#415A77` | `#8B96A8` | Muted text |
| `--line` | `#ECE8DC` | `rgba(247,244,234,0.08)` | Borders |
| `--lime` | `#B58A1A` | `#D4AF37` | Gold accent |
| `--amber` | `#B58A1A` | `#D4AF37` | Warning accent |
| `--elite` | `#415A77` | `#6B84A3` | Elite tier |
| `--info` | `#1D6FD0` | `#4A9EFF` | Info / links |
| `--passport-wash` | cream gradient | transparent | Passport header wash |

The intended character is **near-black + cream + selective gold** — restrained,
document-like, with gold used sparingly for achievement rather than decoration.
Note the accent is a muted brass (`#B58A1A` / `#D4AF37`), not a bright yellow.

Icons are inline SVG components (`Home`, `Radar`, `Share`, `User`, and others).
There is no icon library dependency.

---

## 8. Component inventory

Reusable: `Avatar` · `Badge` · `Bars` · `BreakdownBar` · `CollapsibleRow` ·
`FeatureLock` · `Linkify` · `PassRow` · `PathNode` · `SectionTitle` ·
`SettingsButton` · `SkeletonCard` · `Tag` · `NotificationBell` · `UpdateBar`

Feature-level: `HomeTab` · `Scout` · `PathwayPlan` · `PathwayMap` ·
`PathwayStrip` · `DevelopmentPlan` · `GoalCard` · `BackupPlanCard` ·
`ReadinessCard` · `Targets` · `Benchmarks` · `Passport` · `PublicPassport` ·
`ProfileEditor` · `Highlights` · `Timeline` · `PostsGrid` · `FollowListCard` ·
`GuidedAssessment` · `UpgradeScreen` · `EliteWelcome` · `VerificationRequest` ·
`FamilyAccess` · `MyAthletes` · `ManagingBanner` · `RestrictedBanner` ·
`BannedScreen` · `BlockedAccounts` · `AdminPanel` · `Auth` · `ResetPassword` ·
`TurnstileWidget` · `LangProvider`

Off the launch nav but built: `Feed` · `Discover` · `Events` · `EventRow` ·
`AddToEventsModal` · `Messages`

---

## 9. Known UX problems worth fixing

Stated plainly, because a redesign that doesn't know these will preserve them:

1. **Home and Plan were recently redesigned; the rest was not.** Passport,
   Scout and every secondary surface are older visual work. There is a real
   consistency gap.
2. **The admin panel is functionally complete and visually unconsidered.**
3. **Goal and pathway can contradict each other on screen.** If the stored goal
   says one thing and the pathway says another, the Plan page currently states
   both. It should surface the contradiction as something to resolve, not pick
   one silently.
4. **Long-language layout.** Greek and French overflow in several tight
   components. Test every new layout at Greek string lengths.
5. **Four tiers is a lot to communicate.** The upgrade screen has to explain
   Free/Starter/Pro/Elite without becoming a pricing table wall.
6. **Density on Plan.** It is now the workspace for goals, pathway, 30/90-day
   items, season, targets and benchmarks. It works, but it is the screen most
   at risk of feeling like a wall.

---

## 10. Non-negotiables for any redesign

- Loading, empty and absent stay three distinct states. No skeleton→paywall.
- Inferred data is never rendered as a statement of fact.
- Free keeps a complete, non-crippled Home.
- Four languages, with Greek as the length stress case.
- Everything expressible in plain CSS + inline styles, no framework.
- Light and dark both remain first-class.
- Accessibility matters more than usual here: the primary user may be 14 and on
  a mid-range Android phone on mobile data.

---

## 11. What is *not* in the app, despite appearances

So no one designs for something that has no data behind it:

- **Clubs directory** — an empty, dormant table stub. Not a feature.
- **Motion / Diary / Schedule** — schema shells only, no UI, no data.
- **Comments/replies** — do not exist. Posts have likes only.
- **Video content analysis** — highlights are external links; nothing inspects
  the video itself.
- **Coach/club/organisation accounts** — the platform has athletes, parents and
  admins. There is no coach-side product today.
