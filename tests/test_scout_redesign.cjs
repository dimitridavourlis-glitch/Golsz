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
