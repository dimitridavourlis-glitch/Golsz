// THE PASSPORT IS A PROFILE, NOT A DATA-ENTRY SCREEN.
//
// Measured on a live account, the Passport rendered 37 visible controls. Eleven
// of them were inputs belonging to three "create" forms - add a highlight, add
// an achievement, record a benchmark - that were mounted permanently for the
// owner. An athlete who opened their own passport to show a coach saw empty
// input boxes above their achievements.
//
// Nothing here tests styling. Each assertion is about MOUNTING: a form that
// creates a row must not be in the tree until someone asks for it, and it must
// go away again once the row is saved. The counts at the bottom are the part
// that can regress quietly - a future section that ships its own always-open
// form would pass every other check in this file.

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

// A component's source, from its `function Name(` to the next top-level
// `function ` at column 0. Bounded by the real next declaration rather than a
// fixed character window, which is what makes the "within this component"
// assertions below mean what they say.
const body = (name) => {
  const start = APP.indexOf(`\nfunction ${name}(`);
  if (start < 0) return "";
  const next = APP.indexOf("\nfunction ", start + 1);
  return APP.slice(start, next < 0 ? APP.length : next);
};

/* ---------- the affordance itself ---------- */

const toggle = body("AddToggle");
ck("AddToggle exists", toggle.length > 0, true);
ck("it offers Cancel while the form is open", /t\("ui_cancel"\)/.test(toggle), true);
ck("it calls the opener, not setState directly", /onClick=\{open \? onClose : onOpen\}/.test(toggle), true);

/* ---------- each form is gated, per component ---------- */

const SECTIONS = [
  { comp: "Highlights", cta: "add_highlight_cta", input: "highlights_title_ph" },
  { comp: "Timeline",   cta: "add_timeline_cta",  input: "timeline_year_ph" },
  { comp: "Benchmarks", cta: "add_benchmark_cta", input: "benchmarks_value_ph" },
];

for (const s of SECTIONS) {
  const b = body(s.comp);
  ck(`${s.comp}: found`, b.length > 0, true);
  ck(`${s.comp}: declares its own open/closed state`,
     b.includes("const [adding, setAdding] = useState(false);"), true);
  ck(`${s.comp}: renders the toggle with its own label`,
     b.includes(`label={t("${s.cta}")}`), true);
  // The form's inputs must sit under a guard that includes `adding &&`. If the
  // guard were only `{sb && (` again the inputs would mount for everyone, which
  // is exactly the state this file exists to prevent.
  const guardIdx = b.indexOf("adding && (");
  const inputIdx = b.indexOf(`t("${s.input}")`);
  ck(`${s.comp}: its inputs are below an \`adding &&\` guard`,
     guardIdx > 0 && inputIdx > guardIdx, true);
  ck(`${s.comp}: saving collapses the form again`, b.includes("setAdding(false);"), true);
  // setAdding(false) has to be on the SUCCESS path, not only in a catch. The
  // clear-the-fields line is the success marker in all three of these.
  const clears = b.match(/set\w+\(""\);[^\n]*\n\s*setAdding\(false\);/);
  ck(`${s.comp}: it collapses where the fields are cleared, not in a catch`, !!clears, true);
}

ck("one toggle per section, no more", (APP.match(/<AddToggle /g) || []).length, SECTIONS.length);

/* ---------- translations ---------- */

const LANGS = ["en", "fr", "es", "el"];
for (const k of ["ui_cancel", ...SECTIONS.map((s) => s.cta)]) {
  const hits = (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length;
  ck(`${k} is translated in all ${LANGS.length} languages`, hits, LANGS.length);
}

/* ---------- the count that regresses quietly ---------- */

// Every always-mounted owner-only create form the Passport used to carry. This
// walks the three sections' sources and insists none of them reintroduces an
// input that is reachable without the toggle.
for (const s of SECTIONS) {
  const b = body(s.comp);
  const beforeGuard = b.slice(0, Math.max(b.indexOf("adding && ("), 0));
  ck(`${s.comp}: no input mounts above the guard`,
     /<(input|textarea|select)\b/.test(beforeGuard), false);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("AddToggle"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
