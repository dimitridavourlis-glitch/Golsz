// extractSuggestedTargets / extractSuggestedDevItems — the validators that
// stand between raw model output and a client-side bulk insert.
//
// WHY THIS FILE WAS REWRITTEN
// It used to open with hand-typed copies of both functions, and the copies
// had drifted from api/scout.js in two ways that mattered:
//
//   1. the copy joined text blocks with `.join("\n")`; production uses
//      `.join("")`. A reply split across blocks mid-token therefore parsed
//      in the test and would not have in production (and vice versa).
//   2. the copy called `JSON.parse(clean.slice(indexOf("{"), lastIndexOf("}")+1))`
//      inline; production calls parseReplyObject(), which falls back to
//      field-by-field SALVAGE when the object is truncated. Every truncated
//      -reply case — the whole reason parseReplyObject exists — was
//      unreachable from this suite.
//
// So the suite exercised a code path production no longer runs, and was
// green throughout. Both functions and their two dependencies are now sliced
// out of api/scout.js at run time. See tests/README.md, "the one rule".

const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- extract the REAL implementations ------------------------------------
// Each of these is a top-level declaration in api/scout.js, so its closing
// brace/bracket sits in column 0 and "\n}\n" / "\n];\n" is an unambiguous
// terminator. Anything that cannot be located throws loudly rather than
// leaving an undefined behind — a suite that silently tests nothing is the
// failure mode this whole file exists to correct.
function sliceDecl(startMarker, endMarker, label) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error(`could not find ${label} in api/scout.js — it moved or was renamed; update this suite`);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error(`could not find the end of ${label} in api/scout.js; update this suite`);
  return SRC.slice(a, b + endMarker.length);
}
const fnSrc = (name) => sliceDecl(`function ${name}(`, "\n}\n", name);

// salvageJsonValue + REPLY_FIELDS + parseReplyObject are the dependency
// chain the two extractors call; slicing the extractors alone would produce
// functions that throw on their first line.
//
// Evaluated as ONE bundle inside a new Function rather than as six separate
// eval() calls: a bare eval of `const REPLY_FIELDS = [...]` creates a
// block-scoped binding that dies with the eval, so parseReplyObject would
// have compiled fine and then thrown ReferenceError the moment it was
// actually used — green extraction, dead functions.
const BUNDLE = [
  fnSrc("salvageJsonValue"),
  sliceDecl("const REPLY_FIELDS = [", "\n];\n", "REPLY_FIELDS"),
  fnSrc("parseReplyObject"),
  fnSrc("extractSuggestedTargets"),
  sliceDecl("const DEV_FOCUS_AREA_SET = new Set(", "\n", "DEV_FOCUS_AREA_SET"),
  fnSrc("extractSuggestedDevItems"),
].join("\n");
const { salvageJsonValue, parseReplyObject, extractSuggestedTargets, extractSuggestedDevItems, DEV_FOCUS_AREA_SET } =
  new Function(BUNDLE + "\nreturn { salvageJsonValue, parseReplyObject, extractSuggestedTargets, extractSuggestedDevItems, DEV_FOCUS_AREA_SET };")();

console.log("-- the extraction itself worked --");
for (const [n, v] of [["salvageJsonValue", salvageJsonValue], ["parseReplyObject", parseReplyObject],
                      ["extractSuggestedTargets", extractSuggestedTargets], ["extractSuggestedDevItems", extractSuggestedDevItems]]) {
  ck(`${n} was sliced out of api/scout.js`, typeof v, "function");
}
ck("DEV_FOCUS_AREA_SET came with it", DEV_FOCUS_AREA_SET instanceof Set && DEV_FOCUS_AREA_SET.has("speed"), true);
ck("this suite contains no reimplementation of the functions under test",
   /^function extractSuggested/m.test(fs.readFileSync(__filename, "utf8")), false);

// Fixtures are the shape the Anthropic API actually returns: a content array
// of typed blocks. See tests/README.md, "fixtures must be the shape
// production sends".
const mkData = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

console.log("\n-- suggested_targets --");
ck("no suggested_targets key -> null", extractSuggestedTargets(mkData({ reply: "hi" })), null);
ck("suggested_targets: null -> null", extractSuggestedTargets(mkData({ reply: "hi", suggested_targets: null })), null);
ck("a non-array value -> null", extractSuggestedTargets(mkData({ suggested_targets: "State University" })), null);

ck("valid targets, capped at 5, trimmed",
  extractSuggestedTargets(mkData({ reply: "hi", suggested_targets: [
    { name: "State University", reasoning: "Strong D1 program matching your grad year." },
    { name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E (should be dropped)" },
  ] })),
  [
    { name: "State University", reasoning: "Strong D1 program matching your grad year." },
    { name: "A", reasoning: "" }, { name: "B", reasoning: "" }, { name: "C", reasoning: "" }, { name: "D", reasoning: "" },
  ]);

ck("malformed entries filtered out",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "" }, { reasoning: "no name" }, null, { name: "Valid" }] })),
  [{ name: "Valid", reasoning: "" }]);
ck("empty array after filtering -> null",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "" }] })), null);
ck("whitespace-only name is not a name",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "   " }] })), null);
ck("a non-string reasoning becomes an empty string, not a crash",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "X", reasoning: { evil: true } }] })),
  [{ name: "X", reasoning: "" }]);
ck("an oversized name is truncated to 120",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "z".repeat(500) }] }))[0].name.length, 120);
ck("an oversized reasoning is truncated to 300",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "X", reasoning: "z".repeat(900) }] }))[0].reasoning.length, 300);
ck("malformed JSON -> null (never throws)",
  extractSuggestedTargets({ content: [{ type: "text", text: "not json {{{" }] }), null);
ck("a missing content array -> null", extractSuggestedTargets({}), null);

console.log("\n-- suggested_dev_items --");
ck("dev items valid, unknown focus_area falls back to other",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [
    { focus_area: "speed", goal: "Improve 40-yard dash by 0.1s" },
    { focus_area: "made_up_area", goal: "Something else" },
  ] })),
  [
    { focus_area: "speed", goal: "Improve 40-yard dash by 0.1s" },
    { focus_area: "other", goal: "Something else" },
  ]);
ck("dev items capped at 3",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [
    { focus_area: "speed", goal: "1" }, { focus_area: "speed", goal: "2" },
    { focus_area: "speed", goal: "3" }, { focus_area: "speed", goal: "4" },
  ] })).length, 3);
ck("dev items missing goal filtered",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [{ focus_area: "speed" }] })), null);
ck("a missing focus_area becomes other",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [{ goal: "Sleep 8h" }] })),
  [{ focus_area: "other", goal: "Sleep 8h" }]);
ck("an oversized goal is truncated to 200",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [{ focus_area: "sleep", goal: "z".repeat(900) }] }))[0].goal.length, 200);
ck("no key -> null", extractSuggestedDevItems(mkData({ reply: "hi" })), null);

console.log("\n-- the two behaviours the old hand-copy got wrong --");
// (1) BLOCK JOINING. Production joins with "", not "\n". A model that emits
// the envelope across two text blocks splits it at an arbitrary byte — very
// often mid-token. Joining with "\n" injects a newline that is legal inside
// JSON whitespace but NOT inside a string literal or a number, so the two
// implementations genuinely disagree.
const split = (a, b) => ({ content: [{ type: "text", text: a }, { type: "text", text: b }] });
const envelope = JSON.stringify({ suggested_targets: [{ name: "Split University", reasoning: "ok" }] });
const cut = envelope.indexOf("Split") + 2;   // mid-string-literal
ck("a payload split mid-string still parses (join(\"\"))",
   extractSuggestedTargets(split(envelope.slice(0, cut), envelope.slice(cut))),
   [{ name: "Split University", reasoning: "ok" }]);
ck("...which the old .join(\"\\n\") copy could not do",
   (() => { try { return JSON.parse([envelope.slice(0, cut), envelope.slice(cut)].join("\n")) && "parsed"; }
            catch { return "threw"; } })(), "threw");
ck("non-text blocks are ignored when joining",
   extractSuggestedTargets({ content: [{ type: "server_tool_use", name: "web_search" }, { type: "text", text: envelope }] }),
   [{ name: "Split University", reasoning: "ok" }]);

// (2) SALVAGE. parseReplyObject falls back to per-field recovery when the
// object never closed — the ordinary "ran out of output tokens" shape. The
// old inline JSON.parse(slice(indexOf("{"), lastIndexOf("}")+1)) returned
// null for all of these, so none of it was ever covered.
// Output ran out AFTER both arrays closed but BEFORE the envelope's own "}".
const truncated =
  '{"reply":"Here are some schools I would look at","suggested_targets":' +
  '[{"name":"Truncated State","reasoning":"good fit"}],' +
  '"suggested_dev_items":[{"focus_area":"speed","goal":"faster"}]';
ck("a truncated envelope still yields its targets (salvage path)",
   extractSuggestedTargets({ content: [{ type: "text", text: truncated }] }),
   [{ name: "Truncated State", reasoning: "good fit" }]);
ck("...and its dev items",
   extractSuggestedDevItems({ content: [{ type: "text", text: truncated }] }),
   [{ focus_area: "speed", goal: "faster" }]);
ck("...whereas the old inline parse got nothing",
   (() => { const c = truncated; const s = c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1);
            try { const o = JSON.parse(s); return Array.isArray(o.suggested_targets); } catch { return "threw"; } })(),
   "threw");

// Salvage is not magic, and this boundary is worth pinning: an array cut off
// mid-way never closed, so there is no way to know what the last element was
// meant to be. Returning null is correct — inventing the truncated tail would
// push a half-parsed target into a bulk insert.
const severed =
  '{"reply":"...","suggested_targets":[{"name":"Kept U","reasoning":"ok"}],' +
  '"suggested_dev_items":[{"focus_area":"speed","goal":"faster"}';
ck("a severed array is refused rather than guessed",
   extractSuggestedDevItems({ content: [{ type: "text", text: severed }] }), null);
ck("...and the intact field beside it still comes through",
   extractSuggestedTargets({ content: [{ type: "text", text: severed }] }),
   [{ name: "Kept U", reasoning: "ok" }]);

console.log("\n-- fenced output, which the model does emit --");
const fenced = "```json\n" + JSON.stringify({ suggested_targets: [{ name: "Fenced U" }] }) + "\n```";
ck("``` fences are stripped before parsing",
   extractSuggestedTargets({ content: [{ type: "text", text: fenced }] }),
   [{ name: "Fenced U", reasoning: "" }]);
ck("prose before the object does not defeat it",
   extractSuggestedTargets({ content: [{ type: "text", text: "Sure — here you go:\n" + JSON.stringify({ suggested_targets: [{ name: "Preamble U" }] }) }] }),
   [{ name: "Preamble U", reasoning: "" }]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
