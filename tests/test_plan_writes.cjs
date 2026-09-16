// PLAN'S ONLY WRITER, RUN RATHER THAN READ.
//
// save() had three failures an athlete could not see:
//   1. `if (busy) return` DROPPED a second action fired mid-flight. No error,
//      no retry. Tick two steps quickly and one quietly did not happen.
//   2. Nothing moved until the network came back, so every tap felt dead.
//   3. A failed write looked identical to a successful one — the catch logged
//      to a console no fifteen-year-old will open, and the row stayed ticked.
//
// Ordering and rollback are exactly the kind of thing a regex cannot check, so
// this lifts the real function and runs it against a fake client.
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

const start = APP.indexOf("  function save(overrides) {");
if (start < 0) throw new Error("save() not found — this suite is not reading what it thinks it is");
const body = APP.slice(start, APP.indexOf("\n  }", start) + 4);

// A harness that stands in for the component's state and the Supabase client.
function harness(failOn) {
  const st = { milestones: [{ id: "a", done: false }], busy: 0, error: "", exists: false, writes: [] };
  const ref = (v) => ({ current: v });
  const savesRef = ref(Promise.resolve());
  const milestonesRef = ref(st.milestones);
  let n = 0;
  const sb = { from: () => ({ upsert: async (row) => {
    n++;
    await new Promise((r) => setTimeout(r, 5));
    if (failOn && failOn.includes(n)) return { error: new Error("network") };
    st.writes.push(row.milestones.map((m) => m.id + ":" + (m.done ? 1 : 0)).join(","));
    return { error: null };
  } }) };
  const save = new Function(
    "sb", "uid", "savesRef", "milestonesRef", "setMilestones", "setBusy", "setExists", "setSaveError",
    "pathwayType", "timeline", "notes", "customStages", "currentStageId", "t", "console",
    body + " return save;"
  )(sb, "u1", savesRef, milestonesRef,
    (v) => { st.milestones = v; }, (b) => { st.busy += b ? 1 : -1; }, () => { st.exists = true; },
    (e) => { st.error = e; }, "ncaa", "", "", [], null, (k) => k, { error() {} });
  return { save, st, savesRef, milestonesRef };
}

(async () => {
  console.log("-- the screen moves before the network does --");
  {
    const h = harness();
    h.save({ milestones: [{ id: "a", done: true }] });
    ck("the change is on screen immediately, not after a round trip",
       h.st.milestones[0].done, true);
    await h.savesRef.current;
    ck("...and it is what got written", h.st.writes, ["a:1"]);
  }

  console.log("\n-- a burst is queued, not dropped --");
  {
    // THE BUG. With `if (busy) return`, the second and third of these vanished.
    const h = harness();
    h.save({ milestones: [{ id: "a", done: true }] });
    h.save({ milestones: [{ id: "a", done: true }, { id: "b", done: false }] });
    h.save({ milestones: [{ id: "a", done: true }, { id: "b", done: true }] });
    await h.savesRef.current;
    ck("every action in a fast burst reaches the server", h.st.writes.length, 3);
    ck("...in the order they were made",
       h.st.writes, ["a:1", "a:1,b:0", "a:1,b:1"]);
    ck("...and the last one is what stands", h.st.milestones.map((m) => m.id + ":" + (m.done ? 1 : 0)), ["a:1", "b:1"]);
  }

  console.log("\n-- a failed write is visible and undone --");
  {
    const h = harness([1]);
    h.save({ milestones: [{ id: "a", done: true }] });
    ck("it still shows immediately", h.st.milestones[0].done, true);
    await h.savesRef.current;
    // A step showing as done that the server never heard about is worse than
    // one that visibly failed: the athlete closes the app believing it saved.
    ck("...but is put back when the write fails", h.st.milestones[0].done, false);
    ck("...and the athlete is told", h.st.error, "pathway_save_failed");
  }

  console.log("\n-- a failure does not poison the queue --");
  {
    const h = harness([1]);
    h.save({ milestones: [{ id: "a", done: true }] });
    h.save({ milestones: [{ id: "a", done: false }, { id: "c", done: false }] });
    await h.savesRef.current;
    ck("the write after a failed one still lands", h.st.writes, ["a:0,c:0"]);
    ck("...and clears the error", h.st.error, "");
  }

  console.log("\n-- the guard that dropped work is gone --");
  // Scoped to the lifted body: another component further up the file still has
  // the same early-return guard, and asserting over the whole file would have
  // meant this passing or failing for reasons that have nothing to do with Plan.
  ck("save() no longer returns early while busy", /\|\| busy\) return;/.test(body), false);
  ck("...and the error is rendered, not only logged", /role="alert"[\s\S]{0,200}\{saveError\}/.test(APP), true);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
