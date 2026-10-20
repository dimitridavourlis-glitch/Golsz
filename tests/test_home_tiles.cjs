// HOME AS SIX PICTURES — and the screen it replaced, still intact behind one.
//
// The thing most worth protecting here is not the grid. It is that NOTHING was
// deleted: the old Home renders unchanged behind the Today tile, with a back
// row on top, and every assertion in every other Home suite still runs against
// it. A redesign that quietly dropped a feature would pass a grid test.
//
// The other half is the deep links. A section id is written straight into
// getElementById, so this file checks the allowlist BOTH WAYS: an id with no
// anchor is a link to nowhere, and an anchor nothing may name is unreachable.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) return "";
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};

/* ---------- the branch exists and is gated ---------- */

const at = APP.indexOf('if (view === "tiles") {');
ck("the tile Home is the branch HomeTab takes", at > 0, true);
const TILES = at > 0 ? APP.slice(at, APP.indexOf('\n  return (\n    <div className="gz-home"', at)) : "";
// Declaration, not a bare name: the source still describes the deleted flags
// in a comment, which a loose match would read as the flag surviving.
ck("...and not behind a phase flag any more", /const REDESIGN_[A-Z_]+ =/.test(APP), false);

/* ---------- nothing was deleted ---------- */

// The old Home is the fall-through, reachable from the Today tile.
ck("the Today tile opens the screen Home used to be", /act: \(\) => setView\("today"\)/.test(TILES), true);
ck("...and there is a way back", /onClick=\{\(\) => setView\("tiles"\)\}/.test(APP), true);
// The back row must not render when the flag is off, or it leads nowhere.
ck("...and the back row renders only on that screen",
   /\{view === "today" && \(/.test(APP), true);
// The old body is still one `return (` in HomeTab, not a copy.
ck("the old Home body was not duplicated",
   (APP.match(/<div className="gz-home" style=\{\{ padding: "8px 12px 20px" \}\}>/g) || []).length, 1);

/* ---------- locks ---------- */

// While the plan is UNKNOWN neither a lock nor the feature may show. A lock
// rendered during the plan fetch tells a paying athlete they have to upgrade.
ck("a lock needs the plan to be known first",
   /const lockedFor = \(feat\) => planKnown\(plan\) && !featureUnlocked\(plan, feat\);/.test(TILES), true);
ck("Schools locks on the targets feature", /locked: lockedFor\("targets"\)/.test(TILES), true);
ck("Tests locks on the benchmarks feature", /locked: lockedFor\("benchmarks"\)/.test(TILES), true);
ck("a locked tile upgrades instead of navigating",
   /onClick=\{tile\.locked \? onUpgrade : tile\.act\}/.test(TILES), true);
// Only those two. Today, Scout, Passport and Videos work on Free.
ck("exactly two tiles can lock", (TILES.match(/locked: lockedFor\(/g) || []).length, 2);

/* ---------- sub-lines ---------- */

// "A tile with nothing to say is not rendered" - the rule the old status row
// already follows. An em-dash is a tile asking to be ignored.
ck("no sub-line is an em-dash", /\\u2014|—/.test(TILES), false);
ck("a missing sub-line renders nothing at all", /: tile\.sub \? \(/.test(TILES), true);
// No tile says a zero out loud. "0 on my list" is true and useless, and it is
// the first thing a brand-new athlete would read.
ck("Schools goes quiet at zero rather than reporting none",
   /!targetRows\.length \? null/.test(TILES), true);
ck("Videos goes quiet at zero", /clipCount \? t\("tile_videos_n"\)/.test(TILES), true);
ck("Tests goes quiet at zero", /recentBenchmarks\.length \? t\("tile_tests_n"\)/.test(TILES), true);
// The page is not named after one of its own buttons when there is no name.
ck("no name means no greeting line, not a wrong one",
   /\{name \? \(\n\s*<div style=\{\{ fontSize: 32/.test(TILES), true);
ck("the Today tile hides its badge when there is nothing to do",
   /badge: resting \|\| !todoLeft \? null/.test(TILES), true);
ck("...and the count cannot go negative",
   /const todoLeft = Math\.max\(0, todaySteps\.length - todayDone\);/.test(TILES), true);

/* ---------- resting ---------- */

ck("the Today tile goes grey while resting", /grey: resting/.test(TILES), true);
ck("...and says so", /t\("tile_today_rest"\)/.test(TILES), true);
ck("...and drops its badge", /badge: resting \|\|/.test(TILES), true);

/* ---------- no new fetches ---------- */

// Every value the grid shows is computed for the old Home already. A fetch
// inside this branch would mean the brief's claim had quietly become false.
ck("the tile branch fetches nothing", /sb\.from\(/.test(TILES), false);
ck("...and reads the resting prop rather than its own query",
   /availability_status/.test(TILES), false);

/* ---------- the loader's positional destructuring ---------- */

// Home awaits one Promise.all and destructures it BY POSITION. Adding or
// removing a query shifts every name after it onto the wrong table, and
// nothing throws - benchmarks would simply contain development plan items.
// This walks both lists and checks each name against the table it is fed by,
// so the next person to touch that array finds out immediately.
{
  const lines = APP.split("\n");
  const i = lines.findIndex((l) => /data: shareTokens/.test(l) && /await Promise\.all/.test(l));
  ck("Home's combined loader was found", i > -1, true);
  const m = i > -1 ? lines[i].match(/const \[(.*)\] = await/) : null;
  const slots = m ? m[1].split(/,\s*(?=\{)/).map((x) => x.trim().replace(/[{}]/g, "").replace("data: ", "").trim()) : [];
  const q = [];
  for (let n = i; n > -1 && n < i + 70; n++) {
    const mm = (lines[n] || "").match(/sb\.from\("([a-z_]+)"\)/);
    if (mm) q.push(mm[1]);
  }
  ck("every destructured name has a query behind it", slots.length, q.length);
  // The pairs themselves, so a reorder is caught and not just a count change.
  const EXPECT = [
    ["prof", "profiles"], ["ath", "athletes"], ["reqs", "verification_requests"],
    ["benchmarks", "athlete_benchmarks"], ["devItems", "development_plan_items"],
    ["pathwayRow", "pathway_plan"], ["targets", "outreach_targets"],
    ["shareTokens", "passport_share_tokens"], ["todayTicks", "development_plan_ticks"],
    ["actionRows", "athlete_actions"], ["lastSnap", "assessment_snapshots"],
  ];
  ck("...and each one is fed by the table it is named for",
     slots.map((sName, n) => sName + "<-" + (q[n] || "none")),
     EXPECT.map(([a, b]) => a + "<-" + b));
  // scout_history pulled six full jsonb transcripts on the app's most-opened
  // screen to compute a value nothing rendered. It must not come back by
  // accident.
  ck("Home does not fetch Scout transcripts", q.indexOf("scout_history"), -1);
}

/* ---------- deep links, checked both ways ---------- */

ck("go() takes a section", /const go = \(id, from, seed, day, section\) => \{/.test(APP), true);
ck("...and only an allowlisted one survives",
   /SECTION_IDS\.indexOf\(section\) !== -1 \? section : null/.test(APP), true);

const idsLine = (APP.match(/const SECTION_IDS = \[([^\]]*)\]/) || [])[1] || "";
const IDS = idsLine.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
ck("the allowlist is not empty", IDS.length > 0, true);
for (const id of IDS) {
  // EVERY allowlisted id must exist as a real anchor, or it is a link to
  // nowhere that fails silently.
  ck(`${id} has an anchor on the page it names`,
     new RegExp(`(id="${id}"|anchorId="${id}")`).test(APP), true);
  // ...and something must actually navigate to it, or it is unreachable.
  ck(`...and something links to ${id}`, APP.indexOf(`"${id}")`) > 0 || APP.indexOf(`, "${id}"`) > 0, true);
}
// And no stray anchor nothing may name.
const anchors = (APP.match(/id="(gz-[a-z-]+)"/g) || []).map((s) => s.slice(4, -1));
for (const a of anchors) ck(`the anchor ${a} is on the allowlist`, IDS.indexOf(a) !== -1, true);

/* ---------- the scroll never latches ---------- */

const focus = grab("function useFocusSection(section, nonce, onDone) {");
ck("useFocusSection exists", focus.length > 0, true);
// A target inside a Collapsible does not exist on the tick the effect fires,
// so it retries - but it must give up and STILL clear, or the page can never
// accept another deep link.
ck("it retries across frames", /requestAnimationFrame\(tick\)/.test(focus), true);
ck("...gives up rather than spinning", /if \(\+\+tries < 20\)/.test(focus), true);
ck("...and clears the signal even when it never found the target",
   /else if \(onDone\) onDone\(\);/.test(focus), true);
ck("...and cancels on unmount", /cancelled = true/.test(focus), true);
// A changing nonce, not a boolean: a boolean could not re-open the same
// section on a second tap, and would take the open state away from Collapsible.
ck("the signal is a changing value, not a boolean",
   /if \(wanted\) setFocusNonce\(\(n\) => n \+ 1\);/.test(APP), true);

/* ---------- the bottom bar ---------- */

ck("the bar has exactly four tabs", (APP.match(/\{ id: "(home|scout|targets|profile)", icon:/g) || []).length, 8); // NAV + SIDEBAR_NAV
ck("the active tab is gold with ink on it", /background: C\.lime, color: C\.ink/.test(APP), true);

/* ---------- translations ---------- */

const KEYS = ["home_tiles_hi", "home_tiles_sub", "tile_today", "tile_scout", "tile_passport",
  "tile_schools", "tile_videos", "tile_tests", "tile_today_count", "tile_today_rest",
  "tile_scout_sub", "tile_schools_n", "tile_videos_n", "tile_tests_n", "tile_passport_opened",
  "tile_passport_unshared", "tile_locked", "home_tiles_goal", "home_today_back"];
for (const k of KEYS) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("useFocusSection"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
