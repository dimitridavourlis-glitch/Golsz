// OUTREACH TARGET RULES. The helpers are lifted from golsz-app.html and run,
// not copied. Also pins that every target_* i18n key exists in all 4 languages.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const lift = (start, end) => {
  const s = APP.indexOf(start);
  ck(`found ${start} in the source`, s > 0, true);
  return APP.slice(s, APP.indexOf(end, s) + end.length);
};
const src = [
  lift("const TARGET_LIMITS = ", "};"),
  lift("function targetFieldErrors(", "\n}\n"),
  lift("function targetHasDraft(", "\n}\n"),
  lift("function targetDeleteCopy(", "\n}\n"),
].join("\n");
const { TARGET_LIMITS, targetFieldErrors, targetHasDraft, targetDeleteCopy } =
  new Function(`${src}\nreturn { TARGET_LIMITS, targetFieldErrors, targetHasDraft, targetDeleteCopy };`)();

const err = (o) => targetFieldErrors({ name: "FC Nord", ...o });

ck("limits", TARGET_LIMITS, { name: 120, contact_name: 120, contact_email: 200, notes: 2000, fit_reasoning: 2000, draft_email: 10000 });
ck("a valid target gives {}", err({}), {});
ck("a null draft only misses the name", targetFieldErrors(null), { name: "target_err_name_required" });
ck("empty name", err({ name: "" }).name, "target_err_name_required");
ck("whitespace name", err({ name: "   " }).name, "target_err_name_required");
ck("120-char name is fine", err({ name: "a".repeat(120) }).name, undefined);
ck("121-char name", err({ name: "a".repeat(121) }).name, "target_err_too_long");
ck("a name padded with spaces is measured trimmed", err({ name: " " + "a".repeat(120) + " " }).name, undefined);
ck("contact_name 121", err({ contact_name: "a".repeat(121) }).contact_name, "target_err_too_long");
ck("notes 2000 ok, 2001 too long", [err({ notes: "a".repeat(2000) }).notes, err({ notes: "a".repeat(2001) }).notes], [undefined, "target_err_too_long"]);
ck("fit_reasoning 2001", err({ fit_reasoning: "a".repeat(2001) }).fit_reasoning, "target_err_too_long");
ck("draft_email 10000 ok, 10001 too long", [err({ draft_email: "a".repeat(10000) }).draft_email, err({ draft_email: "a".repeat(10001) }).draft_email], [undefined, "target_err_too_long"]);
ck("coach@uni is not an email", err({ contact_email: "coach@uni" }).contact_email, "target_err_email_invalid");
ck("blank email is allowed", [err({ contact_email: "" }).contact_email, err({ contact_email: "  " }).contact_email, err({}).contact_email], [undefined, undefined, undefined]);
ck("a@b.co is ok", err({ contact_email: "a@b.co" }).contact_email, undefined);
ck("email with a space", err({ contact_email: "a b@c.com" }).contact_email, "target_err_email_invalid");
ck("email with no @", err({ contact_email: "coach.uni.edu" }).contact_email, "target_err_email_invalid");
ck("email with a trailing dot", err({ contact_email: "a@b." }).contact_email, "target_err_email_invalid");
ck("201-char email is too long, not malformed", err({ contact_email: "a".repeat(195) + "@b.com" }).contact_email, "target_err_too_long");

ck("no draft: null", targetHasDraft(null), false);
ck("no draft: undefined row", targetHasDraft(undefined), false);
ck("no draft: row without field", targetHasDraft({}), false);
ck("no draft: null field", targetHasDraft({ draft_email: null }), false);
ck("no draft: empty", targetHasDraft({ draft_email: "" }), false);
ck("no draft: whitespace", targetHasDraft({ draft_email: "   \n " }), false);
ck("draft: Hi", targetHasDraft({ draft_email: "Hi" }), true);

const t = (k) => ({
  target_delete_armed: "ARMED", target_delete_armed_draft: "ARMED+DRAFT",
  target_delete_aria: "Delete {name}.", target_delete_aria_draft: "Delete {name} and draft.",
})[k] || k;
ck("copy without a draft", targetDeleteCopy({ name: "FC Nord", draft_email: "" }, t), { label: "ARMED", aria: "Delete FC Nord." });
ck("copy with a draft names the draft", targetDeleteCopy({ name: "FC Nord", draft_email: "Hi" }, t), { label: "ARMED+DRAFT", aria: "Delete FC Nord and draft." });
ck("copy for a null row does not throw", targetDeleteCopy(null, t), { label: "ARMED", aria: "Delete ." });

/* ---------- Targets component: add / edit behaviour (AST) ---------- */
const parser = require("@babel/parser");
let traverse = require("@babel/traverse");
traverse = traverse.default || traverse;
const m = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
const CODE = APP.slice(m.index + m[0].length, APP.indexOf("</script>", m.index + m[0].length));
const ast = parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] });
let targets = null;
traverse(ast, { FunctionDeclaration(pa) { if (pa.node.id.name === "Targets" && !targets) targets = pa; } });
ck("Targets component found", !!targets, true);
const fn = (name) => { let r = null; targets.traverse({ FunctionDeclaration(pa) { if (pa.node.id.name === name && !r) r = pa; } }); return r; };
const calls = (pa, name) => { const out = []; pa.traverse({ CallExpression(c) { const cal = c.node.callee; if (cal.type === "Identifier" && cal.name === name) out.push(c); } }); return out; };

// addTarget: a ref is set true before the first await
const add = fn("addTarget");
ck("addTarget exists", !!add, true);
let firstAwait = Infinity, refSet = Infinity;
add.traverse({
  AwaitExpression(a) { firstAwait = Math.min(firstAwait, a.node.start); },
  AssignmentExpression(a) {
    const l = a.node.left;
    if (l.type === "MemberExpression" && l.property.name === "current" && /Ref$/.test(l.object.name) && a.node.right.value === true) refSet = Math.min(refSet, a.node.start);
  },
});
ck("addTarget sets a ref guard before its first await", refSet < firstAwait, true);
ck("addTarget returns early when the ref guard is set", /addingRef\.current\) return/.test(CODE.slice(add.node.start, add.node.end)), true);

// saveEdit: setEditingTarget(null) only inside an `if`, after the awaited update
const save = fn("saveEdit");
ck("saveEdit exists", !!save, true);
const closes = calls(save, "setEditingTarget");
ck("saveEdit closes the form exactly once", closes.length, 1);
let awaitedUpdate = Infinity;
save.traverse({ AwaitExpression(a) { awaitedUpdate = Math.min(awaitedUpdate, a.node.start); } });
const close = closes[0];
ck("the close comes after the awaited update", close.node.start > awaitedUpdate, true);
const ifParent = close.findParent((x) => x.isIfStatement());
ck("the close sits in an if on the update result", !!ifParent && ifParent.node.test.type === "Identifier", true);
ck("saveEdit runs targetFieldErrors before writing", calls(save, "targetFieldErrors").length === 1 && calls(save, "targetFieldErrors")[0].node.start < awaitedUpdate, true);
ck("saveEdit has a ref guard", /savingEditRef\.current\) return/.test(CODE.slice(save.node.start, save.node.end)), true);
ck("the only other setEditingTarget(null) is Cancel", calls(targets, "setEditingTarget").filter((c) => c.node.arguments[0] && c.node.arguments[0].type === "NullLiteral").length, 2);

// the err line is rendered outside the showAddTarget branch
let errInAdd = 0, errOutside = 0;
targets.traverse({
  JSXExpressionContainer(pa) {
    const e = pa.node.expression;
    if (e.type !== "LogicalExpression" || e.left.type !== "Identifier" || e.left.name !== "err") return;
    const inAdd = pa.findParent((x) => x.isLogicalExpression() && x.node.left.type === "Identifier" && x.node.left.name === "showAddTarget");
    if (inAdd) errInAdd++; else errOutside++;
  },
});
ck("err is rendered once, outside the showAddTarget branch", [errInAdd, errOutside], [0, 1]);

/* ---------- TargetTextArea: draft save path ---------- */
let ta = null;
traverse(ast, { FunctionDeclaration(pa) { if (pa.node.id.name === "TargetTextArea" && !ta) ta = pa; } });
ck("TargetTextArea found", !!ta, true);
const saveFn = (() => { let r = null; ta.traverse({ FunctionDeclaration(pa) { if (pa.node.id.name === "save") r = pa; } }); return r; })();
ck("save exists", !!saveFn, true);
const saveSrc = CODE.slice(saveFn.node.start, saveFn.node.end);
ck("save has a ref guard", /savingRef\.current \|\| [^)]*\) return/.test(saveSrc), true);
let clears = 0;
saveFn.traverse({ CallExpression(c) { const cal = c.node.callee, a0 = c.node.arguments[0]; if (cal.type === "Identifier" && cal.name === "setText") clears++; } });
ck("save never touches the text (no setText in the error path)", clears, 0);
ck("the failed status is set from the save result", /setStatus\(ok \? "saved" : "failed"\)/.test(saveSrc), true);
const taSrc = CODE.slice(ta.node.start, ta.node.end);
ck("Save is disabled while saving", /disabled=\{status === "saving"/.test(taSrc), true);
ck("text is capped at the limit", /slice\(0, limit\)/.test(taSrc) && /maxLength=\{limit\}/.test(taSrc), true);
ck("blur saves", /onBlur=\{save\}/.test(taSrc), true);
const usesDraft = /<TargetTextArea key=\{"draft"[^>]*TARGET_LIMITS\.draft_email[\s\S]*?explicitSave/.test(CODE);
ck("the draft box uses the draft limit and the Save button", usesDraft, true);

/* ---------- i18n: every key in all four languages ---------- */
const keys = ["target_err_name_required", "target_err_too_long", "target_err_email_invalid",
  "target_delete_armed", "target_delete_armed_draft", "target_delete_aria", "target_delete_aria_draft", "targets_save_err",
  "target_draft_save", "target_status_unsaved", "target_status_saving", "target_status_saved", "target_status_failed", "target_draft_to", "target_counter"];
const usedKeys = new Set(src.match(/target_[a-z_]+/g).filter((k) => !k.startsWith("target_limits")));
for (const k of usedKeys) ck(`helper key ${k} is in the list checked below`, keys.includes(k), true);
const langs = ["en", "fr", "es", "el"];
const starts = langs.map((l) => APP.indexOf(`\n  ${l}: {`, APP.indexOf("const I18N = {")));
langs.forEach((l, i) => {
  const block = APP.slice(starts[i], starts[i + 1] > 0 ? starts[i + 1] : undefined);
  for (const k of keys) ck(`${l} has ${k}`, new RegExp(`\\b${k}: "[^"]+"`).test(block), true);
  ck(`${l} aria texts carry {name}`, ["target_delete_aria", "target_delete_aria_draft"].every((k) => new RegExp(`\\b${k}: "[^"]*\\{name\\}`).test(block)), true);
});

console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
process.exit(f ? 1 : 0);
