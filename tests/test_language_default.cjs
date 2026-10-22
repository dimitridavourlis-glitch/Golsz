// WHICH LANGUAGE A FIRST-TIME VISITOR GETS.
//
// The app speaks four languages but started in English for everyone who had not
// already chosen one, so a Quebec visitor met an English app. The loader in
// golsz-app.html now picks once, before the app runs:
//   a remembered choice > ?lang= > the browser's preference list in order > English
// and saves the result so everything that reads "golsz-lang" agrees with the
// dictionary the loader fetched. pickLang is extracted from the real source.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const s = APP.indexOf("function pickLang() {");
const e = APP.indexOf("\n    var want = pickLang();", s);
ck("found pickLang in the loader", s > 0 && e > s, true);
const src = APP.slice(s, e);
const run = ({ saved, search = "", languages, language, throwing }) => {
  const localStorage = { getItem: () => { if (throwing) throw new Error("blocked"); return saved === undefined ? null : saved; } };
  const location = { search };
  const navigator = { languages, language };
  return new Function("localStorage", "location", "navigator", src + "\nreturn pickLang();")(localStorage, location, navigator);
};

ck("a Quebec browser (fr-CA) gets French", run({ languages: ["fr-CA", "en-CA"] }), "fr");
ck("a plain French browser", run({ languages: ["fr"] }), "fr");
ck("Spanish (es-MX)", run({ languages: ["es-MX"] }), "es");
ck("Greek (el-GR)", run({ languages: ["el-GR"] }), "el");
ck("English stays English", run({ languages: ["en-US", "fr"] }), "en");
ck("the FIRST supported preference wins, not the first listed", run({ languages: ["de-DE", "es-ES", "fr-FR"] }), "es");
ck("nothing supported falls back to English", run({ languages: ["de", "ja"] }), "en");
ck("a browser with only the old navigator.language", run({ language: "fr-FR" }), "fr");
ck("a browser with no language information at all", run({}), "en");
ck("an empty preference list falls through to navigator.language", run({ languages: [], language: "es" }), "es");

ck("A REMEMBERED CHOICE BEATS THE BROWSER (someone who picked English stays English)", run({ saved: "en", languages: ["fr-CA"] }), "en");
ck("...and beats ?lang=", run({ saved: "el", search: "?lang=fr", languages: ["es"] }), "el");
ck("?lang= beats the browser when nothing is remembered", run({ search: "?lang=es", languages: ["fr-CA"] }), "es");
ck("...found among other parameters", run({ search: "?checkout=success&lang=fr", languages: ["en"] }), "fr");
ck("an unsupported ?lang= is ignored", run({ search: "?lang=de", languages: ["fr"] }), "fr");
ck("a longer token is not mistaken for a code (?lang=frx)", run({ search: "?lang=frx", languages: ["en"] }), "en");
ck("a garbage remembered value is ignored", run({ saved: "klingon", languages: ["fr"] }), "fr");
ck("storage that throws (private mode) does not break it", run({ throwing: true, languages: ["fr-CA"] }), "fr");
ck("...and a prototype-key attack on the supported table is not a language", run({ saved: "constructor", languages: ["en"] }), "en");

// What the loader does with the answer.
ck("the result is saved when nothing was, so every reader of golsz-lang agrees",
   /var want = pickLang\(\);\s*try \{ if \(!localStorage\.getItem\("golsz-lang"\)\) localStorage\.setItem\("golsz-lang", want\); \} catch \(e\) \{\}/.test(APP), true);
ck("English skips the dictionary fetch; the others fetch only their own file",
   /if \(want === "en"\) \{ loadApp\(\); return; \}\s*var d = document\.createElement\("script"\);\s*d\.src = "js\/i18n\/" \+ want \+ "\.js/.test(APP), true);
ck("a dictionary that fails to arrive still boots the app", /d\.onerror = loadApp;/.test(APP), true);
ck("the old English-unless-saved rule is gone", /var want = "en";\s*try \{\s*var saved/.test(APP), false);
ck("every language the picker can return has a dictionary (fr, es, el are in the source for the build to lift)",
   ["fr", "es", "el"].every((l) => new RegExp("\\n  " + l + ": \\{\\n").test(APP)), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
