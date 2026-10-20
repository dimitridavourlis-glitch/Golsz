// SCOUT, REDESIGNED — and the three places its numbers live.
//
// The brief calls SCOUT_DAILY_LIMITS its single highest-risk value, and it is
// right: the same four numbers are written down three times. The server meters
// with them, the pricing page SELLS them, and the client now needs them to say
// what a plan would give you on the card shown when you have run out - at which
// point no response is arriving to carry scout_usage. All three are parsed and
// compared here rather than asserted as literals, so a change to any one of
// them fails by name instead of quietly making the app lie about what you paid
// for.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

/* ---------- the four numbers, from all three sources ---------- */

// 1. the client mirror
const cm = APP.match(/const SCOUT_DAILY_LIMITS = \{ free: (\d+), starter: (\d+), pro: (\d+), elite: (\d+) \};/);
ck("the client mirror exists", !!cm, true);
const client = cm ? { free: +cm[1], starter: +cm[2], pro: +cm[3], elite: +cm[4] } : null;

// 2. the server, which owns them
const srv = {};
for (const [k, env] of [["free", "FREE"], ["starter", "STARTER"], ["pro", "PRO"], ["elite", "ELITE"]]) {
  const m = SCOUT.match(new RegExp(env + "_DAILY_LIMIT \\|\\| (\\d+)"));
  srv[k] = m ? +m[1] : null;
}
ck("the server states all four", Object.values(srv).every((v) => v !== null), true);
ck("the client mirror matches the server exactly", client, srv);

// 3. the pricing copy, which is what the athlete was sold
const sold = {};
for (const [k, key] of [["free", "plan_free_feat1"], ["starter", "plan_starter_feat1"],
                        ["pro", "plan_pro_feat1"], ["elite", "plan_elite_feat1"]]) {
  const m = APP.match(new RegExp(key + ': "(\\d+) '));
  sold[k] = m ? +m[1] : null;
}
ck("every plan's copy states a number", Object.values(sold).every((v) => v !== null), true);
ck("what is sold matches what is metered", sold, srv);

/* ---------- the free lifetime cap is a DIFFERENT limit ---------- */

// Free runs out two ways and they are not the same problem. The daily cap
// returns 402 and comes back tomorrow; the lifetime cap returns 403 and does
// not. api/scout.js says so in its own comment, and the client must not
// collapse them back into one "try again tomorrow".
const life = APP.match(/const SCOUT_FREE_LIFETIME = (\d+);/);
ck("the client knows the lifetime cap too", !!life, true);
const lifeSrv = SCOUT.match(/FREE_LIFETIME_LIMIT \|\| (\d+)/);
ck("...and it matches the server", life && lifeSrv ? +life[1] === +lifeSrv[1] : false, true);
// ...and the number the pricing page quotes for it.
const lifeSold = APP.match(/plan_free_feat1: "\d+ [^"]*?(\d+) lifetime/);
ck("...and the number Free was sold", life && lifeSold ? +life[1] === +lifeSold[1] : false, true);

ck("the server still returns two distinct refusals",
   /code: "daily_limit_reached"/.test(SCOUT) && /code: "free_ai_exhausted"/.test(SCOUT), true);
ck("...with different status codes",
   /status\(402\)[\s\S]{0,400}daily_limit_reached/.test(SCOUT) && /status\(403\)[\s\S]{0,200}free_ai_exhausted/.test(SCOUT), true);
// The client already told them apart before this redesign; it must keep doing so.
ck("the client tells them apart",
   /status === 402 \|\| \(status === 403 && code === "free_ai_exhausted"\)/.test(APP), true);
ck("...and has separate copy for each",
   /scout_err_free_exhausted/.test(APP) && /scout_err_daily_limit/.test(APP), true);

/* ---------- the limit card tells the two apart ---------- */

const at = APP.indexOf("function ScoutLimitCard({ kind, usage, plan, onUpgrade, t }) {");
ck("the limit card exists", at > 0, true);
const CARD = at > 0 ? APP.slice(at, APP.indexOf("\nfunction ", at + 10)) : "";
ck("it branches on which limit was hit", /const daily = kind !== "life";/.test(CARD), true);
ck("only the daily card counts dots", /const dots = daily && limit <= 8 \? limit : 0;/.test(CARD), true);
ck("the lifetime card uses the lifetime number, not the daily one",
   /t\("scout_limit_life_title"\)\.replace\("\{n\}", SCOUT_FREE_LIFETIME\)/.test(CARD), true);
// BOTH halves must branch. An earlier version of this file asserted only that
// the two strings existed and that `daily` was computed - and a mutation that
// replaced the subtitle with the daily one unconditionally passed all of it.
// The lie is in the SUBTITLE ("new questions tomorrow"), so that is what has
// to be pinned.
ck("the title branches on which limit was hit",
   /daily \? t\("scout_limit_title"\)/.test(CARD), true);
ck("...and so does the subtitle, which is where the lie would be",
   /\{daily \? t\("scout_limit_sub"\) : t\("scout_limit_life_sub"\)\}/.test(CARD), true);
// Elite has nothing to upgrade to; the server says so with can_upgrade:false.
ck("Elite is not offered an upgrade", /plan !== "elite" \? \(/.test(CARD), true);
// Without a response there is no scout_usage, which is exactly when the card
// shows. The mirror is the only source left for "what would a plan give me".
ck("it falls back to the mirrored limits when no usage arrived",
   /SCOUT_DAILY_LIMITS\[plan\] \|\| SCOUT_DAILY_LIMITS\.free/.test(CARD), true);

/* ---------- running out is reported, never inferred ---------- */

ck("the limit state is set only by a refusal the server sent",
   /failure\.code === "free_ai_exhausted" \|\| failure\.code === "daily_limit_reached"/.test(APP), true);
ck("...and scoutFailureFor hands the code back for it",
   /code: code \|\| \(status === 402 \? "daily_limit_reached" : ""\)/.test(APP), true);
ck("...or by a usage count of zero, which is also the server's word",
   /scoutUsage && scoutUsage\.remaining === 0 \? "daily" : null/.test(APP), true);
// A missing scout_usage is what an UNLIMITED account looks like. Treating it
// as exhausted would invent a cap the athlete does not have.
ck("a missing usage is never treated as empty",
   /const outOfQuestions = limitHit\s*\n\s*\|\| \(scoutUsage &&/.test(APP), true);
ck("a new chat does not refill a spent cap",
   /limitHit is deliberately NOT cleared/.test(APP), true);

/* ---------- the balls ---------- */

const bat = APP.indexOf("function ScoutBalls({ usage, t }) {");
ck("the balls exist", bat > 0, true);
const BALLS = bat > 0 ? APP.slice(bat, APP.indexOf("\nfunction ", bat + 10)) : "";
ck("nothing is drawn for an unlimited account",
   /if \(!usage \|\| typeof usage\.remaining !== "number"\) return null;/.test(BALLS), true);
ck("dots only when they can be counted", /limit > 0 && limit <= 8 \? limit : 0/.test(BALLS), true);
ck("...and the number is always shown", /t\("scout_left"\)\.replace/.test(BALLS), true);

/* ---------- the start screen ---------- */

const sat = APP.indexOf("function ScoutStart({ name, isPlayer, hasSport, onPick, t }) {");
ck("the start screen exists", sat > 0, true);
const START = sat > 0 ? APP.slice(sat, APP.indexOf("\nfunction ", sat + 10)) : "";
ck("it offers four questions", (START.match(/\{ k: "scout_/g) || []).length, 8); // 4 player + 4 not
ck("non-players get their own four", /scout_np_chip4|scout_np_chip1/.test(START), true);
// Each button sends its own label through the normal send(), so it costs one
// daily question exactly as typing it would.
ck("a button is a real message, metered like any other",
   /onPick=\{\(label\) => send\(label\)\}/.test(APP), true);
ck("the first-time line shows only when the sport is unknown",
   /isPlayer && !hasSport \? \(/.test(START), true);
ck("it shows only before the first question",
   /msgs\.length <= 1 && REDESIGN_SCOUT/.test(APP), true);
// The greeting stays in msgs (and in what is sent) but is not drawn.
ck("the greeting bubble is hidden, not deleted",
   /!\(REDESIGN_SCOUT && msgs\.length <= 1\) && msgs\.map/.test(APP), true);

/* ---------- the header ---------- */

ck("the avatar exists, because none did before", /function ScoutFace\(\{ size \}\)/.test(APP), true);
ck("the back arrow is the new-chat button", /REDESIGN_SCOUT && msgs && msgs\.length > 1 \? \(/.test(APP), true);
ck("the separate plus button is gone when the flag is on",
   /REDESIGN_SCOUT \? null : \(\n\s*<button onClick=\{newChat\}/.test(APP), true);
// The brief's header rewrite would have removed this silently. It is the one
// indicator that says something true: a reply is actually in flight.
ck("the in-flight heartbeat survives the rewrite", /M2 14 H52 l6 -9/.test(APP), true);
ck("...and so do the typing dots", /className="running"/.test(APP), true);

ck("the flag exists", /const REDESIGN_SCOUT = (true|false);/.test(APP), true);

/* ---------- one shape for every offer ---------- */

ck("every suggestion uses the one card", (APP.match(/<ScoutActionCard /g) || []).length, 4);
const cardSrc = APP.slice(APP.indexOf("function ScoutActionCard({"), APP.indexOf("\nfunction ", APP.indexOf("function ScoutActionCard({") + 10));
// A locked card is still DRAWN. An athlete who cannot see what they are
// missing cannot decide whether to pay for it.
ck("a locked card shows the offer and the plan, not nothing",
   /t\("scout_card_locked"\)\.replace\("\{plan\}", lockPlan\)/.test(cardSrc), true);
ck("...and the destructive path is a text link, never a second button",
   /textDecoration: "underline"[\s\S]{0,120}dangerLabel/.test(cardSrc) || /dangerLabel[\s\S]{0,400}textDecoration: "underline"/.test(cardSrc), true);

/* ---------- the one-tap gate ---------- */

// THE LOAD-BEARING TEST. addSuggestedPathway writes pathway_type
// UNCONDITIONALLY in both modes, and api/scout.js guarantees every proposal
// carries one - so without this equality check, one tap silently changes which
// route the athlete is on.
ck("the write really does overwrite pathway_type every time",
   /const row = \{ user_id: uidRef\.current, pathway_type: pathway\.pathway_type/.test(APP), true);
ck("one tap requires the same route type",
   /const oneTap = !bringsStages && \(!curType \|\| curType === p\.pathway_type\);/.test(APP), true);
ck("...and a proposal bringing stages is never one tap",
   /const bringsStages = Array\.isArray\(p\.stages\) && p\.stages\.length > 0;/.test(APP), true);
// Anything else opens the existing panel. Nothing is written until they confirm.
ck("otherwise it opens the what-changes panel instead of writing",
   /oneTap\s*\n?\s*\? addSuggestedPathway\(i, p, "add"\)\s*\n?\s*: setMsgs\(\(ms\) => ms\.map\(\(x, xi\) => \(xi === i \? \{ \.\.\.x, pathwayConfirm: "choose" \}/.test(APP), true);
ck("replacing is offered only when there is something to lose",
   /dangerLabel=\{cur\.length \? t\("scout_replace_road"\) : null\}/.test(APP), true);
ck("...and still goes through its own confirmation",
   /pathwayConfirm: "replace"/.test(APP), true);

/* ---------- the receipt ---------- */

const addPath = APP.slice(APP.indexOf("async function addSuggestedPathway("), APP.indexOf("\n  async function", APP.indexOf("async function addSuggestedPathway(") + 10));
ck("the road receipt is set only after the write resolved",
   addPath.indexOf("if (error) throw error;") < addPath.indexOf("setAddedScreen"), true);
// remap.milestones is what was WRITTEN, so the "next stop" it names is the one
// Plan will actually show.
ck("...and names the next stop from what was written, not what was proposed",
   /const nx = nextMilestone\(remap\.milestones\);/.test(addPath), true);
const addTgt = APP.slice(APP.indexOf("async function addSuggestedTargets("), APP.indexOf("\n  async function", APP.indexOf("async function addSuggestedTargets(") + 10));
ck("the schools receipt is also set only after its write",
   addTgt.indexOf("if (error) throw error;") < addTgt.indexOf("setAddedScreen"), true);
ck("it covers the conversation, not the header or the tabs",
   /\{REDESIGN_SCOUT && addedScreen \? \(/.test(APP), true);
const added = APP.slice(APP.indexOf("function ScoutAdded({"), APP.indexOf("\nfunction ", APP.indexOf("function ScoutAdded({") + 10));
ck("one step with a date reads differently from one without",
   /day\s*\n?\s*\? t\("scout_done_road_one"\)/.test(added) && /scout_done_road_one_nodate/.test(added), true);
ck("...and several read differently again", /scout_done_road_many/.test(added), true);
ck("the receipt's icon follows its destination",
   /road \? <MapFolded size=\{22\} \/> : <GraduationCap size=\{22\} \/>/.test(added), true);

/* ---------- the email card invents nothing ---------- */

// The recipient is chosen in the picker, so the card cannot name one. It shows
// what the email SAYS; the picker names who it is to, once that is known.
ck("the card shows the email's own first line, not a guessed recipient",
   /title=\{String\(m\.draftedEmail\)\.split\("\\n"\)/.test(APP), true);
ck("the picker names the recipient once one is chosen",
   /REDESIGN_SCOUT && selectedEmailTarget \? \(/.test(APP), true);
// The restyle must not have touched the save path's overwrite guard.
ck("overwriting an existing draft still takes a second, specific tap",
   /if \(chosen && chosen\.draft_email && String\(chosen\.draft_email\)\.trim\(\) && !confirmedReplace\) \{/.test(APP), true);

/* ---------- replies that follow an offer ---------- */

ck("a card changes what the quick replies are",
   /const SHOWN_CHIPS = REDESIGN_SCOUT\s*\n?\s*\? \(lastHasCard \? REPLY_AFTER_CARD : CHIPS\.slice\(0, 3\)\)/.test(APP), true);
ck("...and a failed message does not count as an offer",
   /lastMsg\.role === "assistant" && !lastMsg\.failed/.test(APP), true);
ck("chips wrap rather than scroll out of sight",
   /flexWrap: REDESIGN_SCOUT \? "wrap" : "nowrap"/.test(APP), true);

/* ---------- translations ---------- */

for (const k of ["scout_title", "scout_start_hi", "scout_start_q", "scout_start_intro",
  "scout_big_next", "scout_big_schools", "scout_big_coach", "scout_big_stuck",
  "scout_input_start", "scout_left", "scout_limit_title", "scout_limit_sub",
  "scout_limit_cta", "scout_limit_plans", "scout_limit_life_title", "scout_limit_life_sub"]) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}
// The daily card promises tomorrow. The lifetime card must NOT - those
// questions are gone, and saying otherwise is a lie the athlete finds out
// about tomorrow.
ck("only the daily card mentions tomorrow",
   /scout_limit_life_sub: "These do not come back tomorrow/.test(APP), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
