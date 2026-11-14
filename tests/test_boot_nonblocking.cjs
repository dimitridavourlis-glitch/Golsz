// The app's boot logo must paint before the outside libraries download, so the three CDN scripts in <head>
// are deferred, and the bottom loader must not inject js/app.js until they have run (DOMContentLoaded).
// Pins: defer, unchanged integrity, the gate, preload href == APP_SRC, watchdog and onerror path.
const fs = require("fs");
const path = require("path");
const APP = require("./_app_source.cjs").appSource();
let pass = 0, fail = 0;
const ck = (name, got, want = true) => { if (got === want) pass++; else { fail++; console.error("FAIL: " + name); } };

const head = APP.slice(0, APP.indexOf("</head>"));
const libs = head.match(/<script src="https:\/\/[^"]+"[^>]*><\/script>/g) || [];
ck("three CDN scripts in <head>", libs.length, 3);
ck("none is parser-blocking (all have defer)", libs.every((t) => /\sdefer(\s|>)/.test(t)));
ck("none is async (order matters: React, ReactDOM, supabase)", libs.some((t) => /\sasync(\s|>)/.test(t)), false);
const integrity = libs.map((t) => (/integrity="([^"]+)"/.exec(t) || [])[1]);
ck("integrity values unchanged", integrity.join(), [
  "sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z",
  "sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1",
  "sha384-fPWur1rx/DE6YtXP/x0MD6dd90RgnVsz5yX/DIg7CcVAnTBZsENWuIcpvVTM39ti"].join());
ck("crossorigin kept", libs.every((t) => /crossorigin="anonymous"/.test(t)));
ck("no other blocking external script in <head>", (head.match(/<script[^>]+src=/g) || []).length, 3);

const loader = APP.slice(APP.indexOf("THE LOADER: IT RUNS js/app.js ONLY AFTER"));
const appSrc = (/var APP_SRC = "([^"]+)"/.exec(loader) || [])[1];
const preload = /<link rel="preload" as="script" href="([^"]+)"/.exec(head);
ck("APP_SRC found", !!appSrc);
ck("preload href equals APP_SRC exactly", !!preload && preload[1] === appSrc);

// the injection of app.js happens inside loadApp(), reached only through compile(), which is gated
const compileFn = loader.slice(loader.indexOf("function compile()"), loader.indexOf("var APP_SRC"));
ck("compile() returns until DOMContentLoaded or readyState complete",
  /readyState !== "complete" && !domReady\) return;[\s\S]*started = true/.test(compileFn));
ck("not gated on readyState 'interactive' (deferred scripts may not have run)", /readyState\s*[!=]==?\s*"interactive"/.test(loader), false);
ck("DOMContentLoaded sets the flag and calls compile()",
  /addEventListener\("DOMContentLoaded", function \(\) \{ domReady = true; compile\(\); \}\)/.test(loader));
ck("app.js is only created inside loadApp()", (loader.match(/s\.src = APP_SRC/g) || []).length, 1);
ck("the dictionary fetch is inside compile() too", loader.indexOf('d.src = "js/i18n/"') > loader.indexOf("function compile()"));
ck("two-rAF trigger kept", /requestAnimationFrame\(function \(\) \{ requestAnimationFrame\(function \(\) \{ compile\(\); \}\); \}\)/.test(loader));
ck("setTimeout(compile, 300) kept", /setTimeout\(compile, 300\);/.test(loader));
ck("12 s watchdog kept", /bootFailed\("timeout"\);\s*\}, 12000\)/.test(loader));
ck("onerror -> bootFailed('load') kept", /s\.onerror = function \(\) \{ bootFailed\("load"\); \}/.test(loader));

// The web fonts start loading in <head>, while the boot screen is up. Found only at mount (the @import in the
// app's CSS), they arrived after the first screen was drawn and redrew it: layout shift 0.23 on a phone, 2026-11-10.
const fontLinks = head.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) || [];
const fontSheet = fontLinks.filter((l) => /rel="stylesheet"/.test(l));
const fontHref = (l) => (/href="([^"]+)"/.exec(l || "") || [])[1];
const cssImport = (/@import url\('(https:\/\/fonts\.googleapis\.com\/css2[^']+)'\);/.exec(APP) || [])[1];
ck("the app's CSS still imports the fonts (screens drawn after a late or failed <head> load)", !!cssImport);
ck("one font stylesheet in <head>", fontSheet.length, 1);
ck("it does not block the first paint (media=print, switched on by onload)", /media="print"/.test(fontSheet[0] || "") && /onload="this\.media='all'"/.test(fontSheet[0] || ""));
ck("its address is the @import's, character for character (one download, not two)", fontHref(fontSheet[0]), cssImport);
ck("it is preloaded as a style at the same address", fontHref(fontLinks.find((l) => /rel="preload" as="style"/.test(l))), cssImport);
ck("both font origins are preconnected", /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/.test(head) && /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/.test(head));
ck("the boot screen's line is set in Archivo, which is what makes the browser fetch the font file before the app mounts",
  /#boot \.m\{[^}]*font:[^;}]*\bArchivo\b/.test(head));

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
