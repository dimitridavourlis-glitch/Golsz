// THE FIRST SCREENS LOOK LIKE ONE PRODUCT, AND A PHONE CAN READ THEM.
//
// AVA job 199's design review (2026-11-10) looked at the pages a new athlete
// passes on the way in: the home page, About, the 404 page and the sign-up
// form. What it found, and what this suite now holds in place:
//
//   * the first header link touched the logo ("GOLSZ.Product")
//   * the sign-up card was 920px wide on a desktop, so every field and the
//     submit button were 880px wide
//   * Full name, Email and Password had only a placeholder for a name, and
//     helper text went down to 10px
//   * the chosen Sign up / Log in tab was a second gold block beside the one
//     real primary button
//   * the site and the app drew the wordmark, the primary button and the page
//     background differently
//   * the 404 page had a shorter header with no menu on a phone
//   * the home page's goal chips were wider than the header above them, and
//     its mono captions were 10.5px
//   * About's five-step strip had two unexplained colours and broke its rows
//     on a dangling arrow
//
// These read the real files. They cannot see pixels: the look itself was
// checked in a browser, at 375 and 1280 px (AI_HANDOFF.md, 2026-11-10).

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const APP = require("./_app_source.cjs").appSource();
const CSS = read("css/styles.css");
const HOME = read("index.html");
const ABOUT = read("about.html");
const NF = read("404.html");

// One declaration block by its exact selector, comments removed.
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector) => {
  const at = BARE.split("\n").findIndex((line) => line.startsWith(selector + " {") || line.startsWith(selector + "{"));
  if (at === -1) return "";
  const rest = BARE.split("\n").slice(at).join("\n");
  return rest.slice(rest.indexOf("{") + 1, rest.indexOf("}"));
};
const rem = (block, prop) => { const m = new RegExp(prop + ":\\s*([0-9.]+)rem").exec(block); return m ? Number(m[1]) : null; };
const token = (name, sheet) => { const m = new RegExp("--" + name + ":\\s*([^;]+);").exec(sheet); return m ? m[1].trim() : null; };

/* ---------- the header ---------- */
console.log("-- header --");
const desktop = (BARE.match(/@media \(min-width: 1080px\) \{([\s\S]*?)\n\}/) || [])[1] || "";
ck("on a desktop the nav links sit a real gap away from the logo",
   /\.nav-links\s*\{[^}]*margin-left:\s*(2|2\.5|3)rem/.test(desktop), true);
ck("the wordmark is the app's: heaviest weight, widest width",
   [/font-weight:\s*900/.test(rule(".logo")), /font-stretch:\s*125%/.test(rule(".logo"))], [true, true]);
ck("the app's own wordmark is still that one", /fontWeight: 900, fontSize: 40, letterSpacing: "0\.03em", fontStretch: "expanded"/.test(APP), true);
for (const pg of ["index.html", "about.html", "404.html"]) {
  ck(`${pg} loads the wide Archivo the wordmark needs`, /family=Archivo:wdth,wght@100,400\.\.900;125,400\.\.900/.test(read(pg)), true);
}

/* ---------- one product: background, primary button ---------- */
console.log("-- site and app share their ground and their button --");
const appDark = (APP.match(/:root \{([\s\S]*?)\n  \}/) || [])[1] || "";
ck("the site's page background is the app's", token("navy", CSS), token("pitch", appDark));
ck("...and that value is a real colour, not a missing token", /^#[0-9A-F]{6}$/i.test(token("navy", CSS) || ""), true);
ck("the hero sits on that token, not on its own hex", /background:\s*var\(--navy\)/.test(rule(".lx-hero")), true);
ck("the header is not tinted blue", /rgba\(10, 22, 40/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), false);
ck("the site's primary button is flat gold, like the app's", /background:\s*var\(--gold\);/.test(rule(".btn-primary")), true);
ck("...with no gradient and no resting glow", [/gradient/.test(rule(".btn-primary")), /box-shadow/.test(rule(".btn-primary"))], [false, false]);
ck("site buttons use the button radius token", /border-radius:\s*var\(--radius-btn\)/.test(rule(".btn")), true);
const authSlice = APP.slice(APP.indexOf("function Auth({ onDone, paidReturn }) {"), APP.indexOf("function ResetPassword("));
const submit = (authSlice.match(/<button type="submit"[^>]*style=\{\{([^}]*)\}\}/) || [])[1] || "";
ck("...which is the radius of the app's submit button", [token("radius-btn", CSS), /borderRadius: 12\b/.test(submit)], ["12px", true]);
ck("the app's submit button is the gold one", /background: C\.lime, color: C\.ink/.test(submit), true);

/* ---------- sign-up form ---------- */
console.log("-- sign-up form --");
const column = Number((APP.match(/const AUTH_COLUMN = (\d+);/) || [])[1]);
ck("the sign-in column is a phone-form width on every screen", column >= 400 && column <= 440, true);
ck("the card is only wide while the plan cards are open on a desktop",
   /const plansWide = isSignup && !forgotMode && isDesktop && plansOpen;/.test(authSlice) && /maxWidth: plansWide \? 920 : AUTH_COLUMN/.test(authSlice), true);
ck("...and even then the form keeps the column", /<form onSubmit=\{[^\n]{0,80}\}\} style=\{\{ maxWidth: AUTH_COLUMN, margin: "0 auto" \}\}>/.test(authSlice), true);
ck("...and so do the tabs", /margin: "0 auto 16px", maxWidth: AUTH_COLUMN/.test(authSlice), true);
for (const id of ["signup-name", "signup-email", "signup-pw", "signup-email2"]) {
  ck(`#${id} has a visible label tied to it`, new RegExp('<label htmlFor="' + id + '" style=\\{fieldLabel\\}>').test(authSlice), true);
  const input = (authSlice.match(new RegExp('<input id="' + id + '"[^>]*')) || [""])[0];
  ck(`#${id} does not use its own name as the placeholder`, /placeholder=\{[^}]*t\("auth_/.test(input), false);
}
ck("the e-mail placeholder is an example address", /placeholder=\{AUTH_EMAIL_EXAMPLE\}/.test(authSlice) && /const AUTH_EMAIL_EXAMPLE = "[^"@\s]+@example\.com";/.test(APP), true);
ck("the date of birth carries the same label style", /<div style=\{fieldLabel\}>\{t\("auth_dob"\)\}<\/div>/.test(authSlice), true);
const labelSize = Number((authSlice.match(/const fieldLabel = \{[^}]*fontSize: ([0-9.]+)/) || [])[1]);
ck("field labels are 12px or more", labelSize >= 12, true);
// Every size written in the sign-in screens. Under 12px only a spaced-out
// caption is allowed, and never under 11.
const sizes = [...authSlice.matchAll(/fontSize: ([0-9.]+)([^}]*)\}/g)].map((m) => ({ px: Number(m[1]), rest: m[2] }));
ck("the sign-in screens state their sizes (the check below is not empty)", sizes.length > 20, true);
ck("no text there is under 11px", sizes.filter((s) => s.px < 11).map((s) => s.px), []);
ck("...and anything under 12px is a letter-spaced caption", sizes.filter((s) => s.px < 12 && !/letterSpacing/.test(s.rest)).map((s) => s.px), []);
const tab = (authSlice.match(/\[\["signup", t\("auth_signup"\)\], \["login", t\("auth_login"\)\]\]\.map\([\s\S]*?<\/button>/) || [""])[0];
ck("the Sign up / Log in tabs were found", tab.length > 100, true);
ck("the chosen tab is a quiet raised surface, not a second gold button", [/C\.lime/.test(tab), /background: mode === m \? C\.turf : "transparent"/.test(tab)], [false, true]);
ck("...and says which one is on without colour", /aria-pressed=\{mode === m\}/.test(tab), true);

// THE FORM STAYS PUT WHEN THE WEB FONT ARRIVES. The screen is drawn in the
// fallback font first. Its text is wider, so the "See plans" button used to
// sit on a second row and jump back up beside the sentence when Archivo
// loaded: a layout shift of 0.23 on a phone (budget 0.10), 2026-11-10. The
// row's own style is read here, not the words around it.
const planRow = (authSlice.match(/<div style=\{\{([^}]*)\}\}>\s*<div style=\{\{([^}]*)\}\}>\s*\{plan === "free"\s*\? t\("auth_plan_summary_free"\)[\s\S]*?<button type="button" onClick=\{\(\) => setPlansOpen\(\(v\) => !v\)\}[^>]*?style=\{\{([^}]*)\}\}/) || []);
ck("the plan summary row was found", planRow.length, 4);
ck("the row is one line of flex that never wraps its button under the sentence", [/display: "flex"/.test(planRow[1] || ""), /flexWrap/.test(planRow[1] || "")], [true, false]);
ck("...the sentence takes the room that is left and wraps inside it", /flex: "1 1 0", minWidth: 0/.test(planRow[2] || ""), true);
ck("...and the button keeps its size and its one line", [/flexShrink: 0/.test(planRow[3] || ""), /whiteSpace: "nowrap"/.test(planRow[3] || ""), /minHeight: 44/.test(planRow[3] || "")], [true, true, true]);
const authLine = Number((APP.match(/const AUTH_LINE = ([0-9.]+);/) || [])[1]);
ck("the sign-in screen has one line height that is a number, not the font's own", authLine >= 1.1 && authLine <= 1.5, true);
for (const name of ["field", "fieldLabel"]) {
  ck(`${name} uses it, so a line is the same height in the fallback font and in Archivo`,
     new RegExp("const " + name + " = \\{[^}]*lineHeight: AUTH_LINE").test(authSlice), true);
}
ck("the wordmark and the tagline state their line height too",
   [/fontSize: 40, lineHeight: [0-9.]+,[^}]*fontStretch: "expanded"/.test(authSlice), /fontSize: 11, lineHeight: AUTH_LINE,[^}]*\}\}>\{t\("auth_tagline"\)\}/.test(authSlice)], [true, true]);

/* ---------- home page ---------- */
console.log("-- home page --");
ck("the goal chips are capped so they stay inside the header's edges", /max-width:\s*\d+rem/.test(rule(".lx-chips")) && /margin:\s*0 auto/.test(rule(".lx-chips")), true);
const chipCap = rem(rule(".lx-chips"), "max-width") * 16;
ck("...narrower than the page container", chipCap < Number((token("container", CSS) || "").replace("px", "")) - 48, true);
for (const sel of [".lx-fine", ".lx-ask-label", ".lx-own-toggle", ".lx-out-cap > span"]) {
  ck(`${sel}: a caption of 11px or more`, rem(rule(sel), "font-size") * 16 >= 11, true);
  ck(`${sel}: in the muted text colour, not the faint one`, /color:\s*var\(--ink-muted\)/.test(rule(sel)), true);
}
const sentence = rule(".lx-out-cap > .lx-out-cap2");
ck("the sentence under the route is reading text: UI typeface, 14px or more",
   [/font-family:\s*var\(--font-body\)/.test(sentence), rem(sentence, "font-size") * 16 >= 14, /color:\s*var\(--ink-soft\)/.test(sentence)], [true, true, true]);
ck("the home page still has that sentence and its caption", /class="lx-out-cap2">Scout builds the real route/.test(HOME) && /data-cap-main/.test(HOME), true);

/* ---------- About: the five steps ---------- */
console.log("-- about: journey strip --");
const journey = (ABOUT.match(/<div class="journey"[\s\S]*?<\/div>/) || [""])[0];
const steps = [...journey.matchAll(/<span class="journey-step">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
ck("five steps, in order", steps.map((s) => (s.match(/<b>([^<]+)<\/b>/) || [])[1]), ["Athlete", "Passport", "AI Scout", "Plan", "Progress"]);
ck("each arrow sits inside the step that follows it", steps.map((s) => /^<i aria-hidden="true">&rarr;<\/i><b>/.test(s)), [false, true, true, true, true]);
ck("no arrow is left between two steps, where a row could end on it", /<\/span>\s*<i/.test(journey), false);
ck("a step never breaks apart from its arrow", /white-space:\s*nowrap/.test(rule(".journey-step")), true);
ck("the steps share one style (no second colour)", [/is-hot/.test(journey), /\.journey b\.is-hot/.test(CSS)], [false, false]);
ck("step text is 11px or more", rem(rule(".journey b"), "font-size") * 16 >= 11, true);

/* ---------- 404 ---------- */
console.log("-- 404 --");
const links = (html, nav) => [...((html.match(new RegExp('<nav class="' + nav + '"[\\s\\S]*?</nav>')) || [""])[0]).matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)]
  .map((m) => [m[1].replace(/^\/?/, "/"), m[2].trim()]);
ck("the home header has its five links", links(HOME, "nav-links").map((l) => l[1]), ["Product", "How it works", "Pricing", "About", "Contact"]);
ck("the 404 header has the same links to the same places", links(NF, "nav-links"), links(HOME, "nav-links"));
ck("...and the same phone menu", links(NF, "mobile-panel"), links(HOME, "mobile-panel"));
ck("its menu needs no script: the button is a <details> summary",
   /<details class="nav-menu">\s*<summary class="nav-toggle" aria-label="Menu"><span class="bar"><\/span><\/summary>\s*<nav class="mobile-panel"/.test(NF), true);
ck("a closed menu takes no room; an open one drops under the header",
   [/display:\s*none/.test(rule(".nav-menu:not([open]) .mobile-panel")), /position:\s*absolute/.test(rule(".nav-menu[open] .mobile-panel")), /top:\s*100%/.test(rule(".nav-menu[open] .mobile-panel"))], [true, true, true]);
ck("the summary shows no browser marker", /list-style:\s*none/.test(rule(".nav-menu > summary")), true);
ck("from 1080px up the menu button is gone, like on the other pages", /\.nav-menu\s*\{\s*display:\s*none;?\s*\}/.test(BARE.slice(BARE.indexOf(".nav-menu[open] .mobile-panel"))), true);
const nfMain = (NF.match(/<main[\s\S]*<\/main>/) || [""])[0];
ck("no 404 text is dimmed with opacity", /opacity/.test(nfMain), false);
ck("one primary button and one outlined button, no bare text buttons",
   [...nfMain.matchAll(/class="(btn[^"]*)"/g)].map((m) => m[1]), ["btn btn-primary", "btn btn-ghost"]);
ck("the footer reaches the bottom of a short page",
   [/display:\s*flex/.test(rule("body")), /flex-direction:\s*column/.test(rule("body")), /min-height:\s*100vh/.test(rule("body")), /flex:\s*1 0 auto/.test(rule("body > main"))], [true, true, true, true]);
for (const pg of ["index.html", "about.html", "contact.html", "terms.html", "privacy.html", "404.html"]) {
  ck(`${pg} has the <main> that rule needs, directly under <body>`, /\n<main id="main">/.test(read(pg)), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
