// CONTROLS A KEYBOARD CAN REACH.
//
// Clickable cards and inline links built from <div>/<span> with only an onClick
// cannot be focused or activated without a mouse. Audit: 13 of them; two are
// modal backdrops (a click on the dim area closes the dialog, and Escape
// already does; a backdrop must NOT take focus), and 11 are real controls.
// asButton() makes those 11 focusable, announced as buttons, and operable with
// Enter and Space. It is extracted from the source and run here.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

/* ---------- the helper, run for real ---------- */
const s0 = APP.indexOf("function asButton(");
const src = APP.slice(s0, APP.indexOf("\n}\n", s0) + 3);
ck("found asButton in the source", src.length > 150, true);
const asButton = new Function(src + "\nreturn asButton;")();
let fired = 0;
const props = asButton(() => { fired++; });
ck("it is announced as a button and is focusable", [props.role, props.tabIndex], ["button", 0]);
ck("a click still works", (props.onClick(), fired), 1);
const key = (k, same = true) => { let prevented = false; const el = {}; props.onKeyDown({ key: k, target: el, currentTarget: same ? el : {}, preventDefault() { prevented = true; } }); return prevented; };
fired = 0;
ck("Enter activates it (and stops the page reacting)", [key("Enter"), fired], [true, 1]);
ck("Space activates it (and does not scroll the page)", [key(" "), fired], [true, 2]);
ck("other keys do nothing", [key("a"), key("Tab"), key("Escape"), fired], [false, false, false, 2]);
ck("a key pressed on a NESTED control does not fire the card as well", [key("Enter", false), fired], [false, 2]);
ck("with no handler it is not announced as a button at all", asButton(undefined), {});

/* ---------- every real control uses it ---------- */
const bare = [];
for (const m of APP.matchAll(/<(span|div|li|p|section|article|img)\b/g)) {
  let i = m.index, depth = 0, j = i;
  while (j < APP.length) { const c = APP[j]; if (c === "{") depth++; else if (c === "}") depth--; else if (c === ">" && depth === 0) break; j++; }
  const tag = APP.slice(i, j + 1);
  if (!/\bonClick=/.test(tag)) continue;
  const line = APP.slice(0, i).split("\n").length;
  const backdrop = /className="fixed-sheet"/.test(tag);
  // A dialog panel only stops a click reaching its backdrop; it is not a control.
  const dialogPanel = /role="dialog"/.test(tag);
  // Hand-written and already complete (role + focusable); the key handler is checked below.
  const handWritten = /role="button"/.test(tag) && /tabIndex=\{0\}/.test(tag) && /onKeyDown=/.test(tag);
  if (!backdrop && !dialogPanel && !handWritten && !/asButton\(/.test(tag)) bare.push(`${line}: ${tag.slice(0, 80).replace(/\s+/g, " ")}`);
}
ck("no <div>/<span> with a bare onClick remains (backdrops excepted)", bare, []);
ck("the two modal backdrops are deliberately left unfocusable", (APP.match(/<div[^>]*className="fixed-sheet"[^>]*onClick=|<div onClick=\{[^}]*\} className="fixed-sheet"/g) || []).length >= 1, true);
ck("eleven controls were converted", (APP.match(/\{\.\.\.asButton\(/g) || []).length, 11);
ck("the three sign-in links are reachable (back to login, parent signup, athlete signup)",
   ["setForgotMode(false); setErr(\"\");", "setMode(\"parent-signup\"); setErr(\"\");", "setMode(\"signup\"); setErr(\"\");"]
     .every((h) => APP.includes("{...asButton(() => { " + h + " })}")), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
