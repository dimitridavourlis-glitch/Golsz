// The legal pages must be readable without anything having to fire first.
//
// terms.html went live on 2026-10-09 as a header over an empty page. Its body
// carried .reveal (opacity 0 until js/main.js adds .is-visible), and the
// reveal observer used a single 0.12 threshold: an element taller than about
// eight screens can never be 12% visible, so it never fired. Privacy was blank
// on phones for the same reason. Signup links to both pages as the consent it
// relies on, so an invisible body is a legal defect, not a styling one.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
let pass = 0, fail = 0;
function ck(name, got, want) {
  if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
}

for (const page of ["terms.html", "privacy.html"]) {
  const html = fs.readFileSync(path.join(REPO, page), "utf8");
  const bodies = html.match(/<[^>]+class="[^"]*\blegal-body\b[^"]*"/g) || [];
  ck(`${page} has a legal body`, bodies.length, 1);
  ck(`${page} legal body does not wait on .reveal`, bodies.some((t) => /\breveal\b/.test(t)), false);
}

// Any other .reveal element can still be taller than the viewport (a long
// section on a phone). The observer must reveal those on first contact.
const MAIN = fs.readFileSync(path.join(REPO, "js/main.js"), "utf8");
ck("reveal observes first contact (threshold 0)", /threshold:\s*\[\s*0\s*,/.test(MAIN), true);
ck("reveal treats taller-than-viewport elements as visible", /boundingClientRect\.height\s*>\s*entry\.rootBounds\.height/.test(MAIN), true);

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
