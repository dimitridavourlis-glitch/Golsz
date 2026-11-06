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
  lift("const TARGET_DELETE_ARM_MS = ", ";"),
  lift("const TARGET_DELETE_DOUBLE_TAP_MS = ", ";"),
  lift("function targetDeleteTap(", "\n}\n"),
  lift("const TARGET_TEXT_FIELDS = ", "];"),
  lift("function targetsWithUnsavedText(", "\n}\n"),
].join("\n");
const { TARGET_LIMITS, targetFieldErrors, targetHasDraft, targetDeleteCopy, TARGET_DELETE_ARM_MS, TARGET_DELETE_DOUBLE_TAP_MS, targetDeleteTap, TARGET_TEXT_FIELDS, targetsWithUnsavedText } =
  new Function(`${src}\nreturn { TARGET_LIMITS, targetFieldErrors, targetHasDraft, targetDeleteCopy, TARGET_DELETE_ARM_MS, TARGET_DELETE_DOUBLE_TAP_MS, targetDeleteTap, TARGET_TEXT_FIELDS, targetsWithUnsavedText };`)();

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
ck("copy without a draft: the short word, no warning line", targetDeleteCopy({ name: "FC Nord", draft_email: "" }, t), { label: "ARMED", warning: "", aria: "Delete FC Nord." });
ck("copy with a draft: the same word, plus a visible line that names the draft", targetDeleteCopy({ name: "FC Nord", draft_email: "Hi" }, t), { label: "ARMED", warning: "ARMED+DRAFT", aria: "Delete FC Nord and draft." });
ck("a whitespace-only draft is no draft", targetDeleteCopy({ name: "FC Nord", draft_email: "  \n" }, t).warning, "");
ck("copy for a null row does not throw", targetDeleteCopy(null, t), { label: "ARMED", warning: "", aria: "Delete ." });

// The tap rule: only a tap on the armed row, after the double-tap window, deletes.
ck("armed for about 6 s, long enough to read the warning", TARGET_DELETE_ARM_MS, 6000);
ck("the double-tap window is well inside it", TARGET_DELETE_DOUBLE_TAP_MS, 500);
ck("nothing armed: a tap arms", targetDeleteTap(null, 0, "a", 10000), "arm");
ck("another row armed: a tap arms this one", targetDeleteTap("b", 0, "a", 10000), "arm");
ck("the armed row, 150 ms later (one double tap): wait", targetDeleteTap("a", 1000, "a", 1150), "wait");
ck("the armed row, 499 ms later: wait", targetDeleteTap("a", 1000, "a", 1499), "wait");
ck("the armed row, 500 ms later: delete", targetDeleteTap("a", 1000, "a", 1500), "delete");
ck("the armed row, 3 s later: delete", targetDeleteTap("a", 1000, "a", 4000), "delete");
ck("no id never deletes", [targetDeleteTap(null, 0, null, 9e9), targetDeleteTap(undefined, 0, undefined, 9e9)], ["arm", "arm"]);

// Which targets the card names as holding unsaved text in a closed box.
ck("the three text fields", TARGET_TEXT_FIELDS, ["fit_reasoning", "notes", "draft_email"]);
const rows = [{ id: "a", name: "Northfield", draft_email: "Old", notes: null }, { id: "b", name: "Lakeside", notes: null }];
const named = (pairs) => targetsWithUnsavedText(rows, new Map(pairs)).map((x) => x.name);
ck("nothing kept: nothing named", named([]), []);
ck("a kept draft that differs from the stored one names its target", named([["a:draft_email", "New"]]), ["Northfield"]);
ck("kept text equal to what is stored is not unsaved", named([["a:draft_email", "Old"]]), []);
ck("kept notes over a null column", named([["b:notes", "Trial in May"]]), ["Lakeside"]);
ck("kept empty text over a null column is not unsaved", named([["b:notes", ""]]), []);
ck("two fields on one target name it once", named([["a:notes", "x"], ["a:draft_email", "y"]]), ["Northfield"]);
ck("a deleted target (not in the list) is not named", named([["gone:draft_email", "x"]]), []);
ck("an unknown field is ignored", named([["a:status", "x"]]), []);

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
// Checks that await something; the summary line waits for all of them.
const pendingChecks = [];

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
const usesDraft = /<TargetTextArea key=\{"draft" \+ it\.id\} \{\.\.\.textBox\(it, "draft_email"\)\}[^>]*explicitSave/.test(CODE);
ck("the draft box gets the shared box props and the Save button", usesDraft, true);

/* ---------- Targets: text a closed box could not store stays named and comes back ---------- */
const targetsSrc = CODE.slice(targets.node.start, targets.node.end);
const textBoxSrc = (/const textBox = \(it, field\) => \(\{[\s\S]*?\n {2}\}\);/.exec(targetsSrc) || [""])[0];
ck("textBox found", textBoxSrc.length > 0, true);
ck("each box is capped at its own limit", /limit: TARGET_LIMITS\[field\]/.test(textBoxSrc), true);
ck("each box gets the text kept for it", /kept: kept\.get\(it\.id \+ ":" \+ field\)/.test(textBoxSrc), true);
ck("each box hands closed-box text to keepText", /onKeep: \(v\) => keepText\(it\.id, field, v\)/.test(textBoxSrc), true);
ck("a successful save drops text kept from an earlier close", /if \(ok\) keepText\(it\.id, field, null\)/.test(textBoxSrc), true);
const boxFields = [...targetsSrc.matchAll(/<TargetTextArea key=\{"\w+" \+ it\.id\} \{\.\.\.textBox\(it, "(\w+)"\)\}/g)].map((x) => x[1]);
ck("every text box on a target goes through textBox", boxFields, TARGET_TEXT_FIELDS);
ck("no other TargetTextArea in Targets", (targetsSrc.match(/<TargetTextArea\b/g) || []).length, TARGET_TEXT_FIELDS.length);
let keptMapTopLevel = false;
traverse(ast, { VariableDeclarator(pa) { if (pa.node.id.name === "TARGET_UNSAVED_TEXT") keptMapTopLevel = pa.parentPath.parentPath.isProgram(); } });
ck("the kept-text Map is module-level, so it outlives the Plan page", keptMapTopLevel, true);
const keepSrc = CODE.slice(fn("keepText").node.start, fn("keepText").node.end);
ck("keepText writes the module Map and the copy the page renders", /TARGET_UNSAVED_TEXT\.set\(key, text\)/.test(keepSrc) && /TARGET_UNSAVED_TEXT\.delete\(key\)/.test(keepSrc) && /setKept\(new Map\(TARGET_UNSAVED_TEXT\)\)/.test(keepSrc), true);
ck("the page starts from the Map, not empty", /useState\(\(\) => new Map\(TARGET_UNSAVED_TEXT\)\)/.test(targetsSrc), true);
ck("a deleted target's kept text is dropped", /TARGET_TEXT_FIELDS\.forEach\(\(f\) => keepText\(id, f, null\)\)/.test(CODE.slice(fn("removeTarget").node.start, fn("removeTarget").node.end)), true);
// The notice: a role=alert element listing unsavedLines, outside the rows and the Add form.
let notice = null;
targets.traverse({
  JSXElement(pa) {
    const attrs = pa.node.openingElement.attributes;
    const role = attrs.find((a) => a.name && a.name.name === "role");
    if (role && role.value.value === "alert" && /unsavedLines\.map/.test(CODE.slice(pa.node.start, pa.node.end))) notice = pa;
  },
});
ck("the card names unsaved targets in a role=alert element", !!notice, true);
const inRows = notice && notice.findParent((x) => x.isCallExpression() && x.node.callee.type === "MemberExpression" && x.node.callee.object.name === "items" && x.node.callee.property.name === "map");
const inAdd = notice && notice.findParent((x) => x.isLogicalExpression() && x.node.left.type === "Identifier" && x.node.left.name === "showAddTarget");
ck("...outside the rows (a row's box is what closed)", !!inRows, false);
ck("...and outside the Add form", !!inAdd, false);
ck("the lines come from targetsWithUnsavedText and the translated message", /const unsavedLines = targetsWithUnsavedText\(items, kept\)\.map\(\(it\) => \(\{ id: it\.id, text: t\("target_unsaved"\)\.replace\("\{name\}", it\.name \|\| ""\) \}\)\);/.test(targetsSrc), true);
ck("a closed section says it too (its note)", /<Collapsible label=\{t\("targets_title"\)\} summary=\{rosterSummary\(t, items\)\} note=\{unsavedLines\.map\(\(l\) => l\.text\)\.join\(" "\)\}/.test(targetsSrc), true);

// updateTarget undoes only its own fields: run it with two writes at once,
// the notes one refused and the draft one stored.
{
  const upSrc = CODE.slice(fn("updateTarget").node.start, fn("updateTarget").node.end);
  ck("updateTarget no longer restores a whole-list copy", /setItems\(before\)/.test(upSrc), false);
  const js = require("@babel/standalone").transform(upSrc, { presets: ["react"] }).code;
  let state = [{ id: "a", notes: "N0", draft_email: "D0" }, { id: "b", notes: "other" }];
  const setItems = (f) => { state = typeof f === "function" ? f(state) : f; };
  const pending = [];
  const sbStub = { from: () => ({ update: (u) => { let res; const p = new Promise((r) => { res = r; }); pending.push({ u, res }); const q = { eq: () => q, then: (a, b) => p.then(a, b) }; return q; } }) };
  const errs = [];
  const makeUpdate = (items) => new Function("items", "setItems", "sb", "actingFor", "uid", "setErr", "t", "console", js + "\nreturn updateTarget;")(items, setItems, sbStub, null, "u1", (e) => errs.push(e), (k) => k, { error() {} });
  pendingChecks.push((async () => {
    const items0 = state;
    const notes = makeUpdate(items0)("a", { notes: "N1" }, true);
    const draft = makeUpdate(items0)("a", { draft_email: "D1" }, true);
    ck("both writes show at once", [state[0].notes, state[0].draft_email], ["N1", "D1"]);
    pending.find((x) => "draft_email" in x.u).res({ error: null });
    pending.find((x) => "notes" in x.u).res({ error: { message: "refused" } });
    ck("results", [await notes, await draft], [false, true]);
    ck("the refused notes go back, the stored draft stays", [state[0].notes, state[0].draft_email], ["N0", "D1"]);
    ck("other rows untouched", state[1], { id: "b", notes: "other" });
    ck("rowError=true leaves the card's err alone", errs, [""]);
    ck("the write is scoped to the row and stamps updated_at", Object.keys(pending[0].u).sort(), ["notes", "updated_at"]);
  })());
}

/* ---------- Targets: the two-tap delete ---------- */
{
  const babel = require("@babel/standalone");
  const srcOf = (name) => CODE.slice(fn(name).node.start, fn(name).node.end);
  ck("tapDelete, armDelete and disarmDelete exist", ["tapDelete", "armDelete", "disarmDelete"].every((n) => !!fn(n)), true);

  // removeTarget is reachable only from the armed branch.
  const removes = calls(targets, "removeTarget");
  ck("removeTarget is called from exactly one place", removes.length, 1);
  const rm = removes[0];
  ck("...inside tapDelete", !!rm.findParent((x) => x.isFunctionDeclaration() && x.node.id.name === "tapDelete"), true);
  const rmIf = rm.findParent((x) => x.isIfStatement());
  ck("...behind if (step === \"delete\")", rmIf && CODE.slice(rmIf.node.test.start, rmIf.node.test.end), 'step === "delete"');
  ck("...in its consequent, not an else", !!rmIf && rmIf.node.consequent.start <= rm.node.start && rm.node.end <= rmIf.node.consequent.end, true);
  ck("step is targetDeleteTap of the armed row as drawn, at the tap's own time", /const step = targetDeleteTap\(armedTarget, armRef\.current\.at, id, tappedAt\);/.test(srcOf("tapDelete")), true);
  ck("the button hands over the click's time stamp, not the time the handler ran", /onClick=\{\(e\) => tapDelete\(it\.id, e\.timeStamp\)\}/.test(CODE.slice(targets.node.start, targets.node.end)) && !/Date\.now/.test(srcOf("tapDelete") + srcOf("armDelete")), true);
  const taps = calls(targets, "tapDelete");
  ck("the delete button is the only caller of tapDelete", taps.length === 1 && !!taps[0].findParent((x) => x.isJSXAttribute() && x.node.name.name === "onClick"), true);

  // The armed wording comes from targetDeleteCopy, and the draft warning is visible text.
  const targetsCode = CODE.slice(targets.node.start, targets.node.end);
  ck("armedCopy is targetDeleteCopy of the armed row", /const armedCopy = targetDeleteCopy\(items\.find\(\(it\) => it\.id === armedTarget\), t\);/.test(targetsCode), true);
  ck("armed, the button shows armedCopy.label in the X's place", /\{armedTarget === it\.id \? armedCopy\.label : <X size=\{14\} \/>\}/.test(targetsCode), true);
  ck("armed, its accessible name is armedCopy.aria", /aria-label=\{armedTarget === it\.id \? armedCopy\.aria : /.test(targetsCode), true);
  let warnLine = null;
  targets.traverse({
    JSXExpressionContainer(pa) {
      const s = CODE.slice(pa.node.start, pa.node.end);
      if (/^\{armedTarget === it\.id && armedCopy\.warning && <div role="alert"[^>]*>\{armedCopy\.warning\}<\/div>\}$/.test(s)) warnLine = pa;
    },
  });
  ck("an armed row with a draft shows armedCopy.warning as a role=alert line", !!warnLine, true);
  ck("...on the row (inside items.map), not inside the button", !!warnLine && !!warnLine.findParent((x) => x.isCallExpression() && x.node.callee.type === "MemberExpression" && x.node.callee.property.name === "map") && !warnLine.findParent((x) => x.isJSXElement() && x.node.openingElement.name.name === "button"), true);
  ck("no armed wording bypasses targetDeleteCopy", /targets_delete_confirm|t\("target_delete_(armed|aria)/.test(targetsCode), false);
  ck("a refused delete shows target_delete_err on its row", /\{deleteFailedId === it\.id && <div role="alert"[^>]*>\{t\("target_delete_err"\)\}<\/div>\}/.test(targetsCode), true);

  // The armed button is wider than the X, so the contact line gets narrower: the email breaks after its "@".
  const mailJs = babel.transform(lift("function emailWithBreak(", "\n}\n"), { presets: ["react"] }).code;
  const el = (type, props, ...children) => ({ type, props: props || {}, children });
  const emailWithBreak = new Function("React", mailJs + "\nreturn emailWithBreak;")({ createElement: el });
  const flat = (n) => (n == null ? "" : typeof n === "string" ? n : n.type === "wbr" ? "|" : n.children.map(flat).join(""));
  ck("an email gets one break point, right after the @", flat(emailWithBreak("rivera@example.edu")), "rivera@|example.edu");
  ck("...inside one inline block (whole on its own line when it fits)", emailWithBreak("rivera@example.edu").props.style, { display: "inline-block" });
  ck("...and its text is unchanged (nothing added to a copy)", flat(emailWithBreak("rivera@example.edu")).replace("|", ""), "rivera@example.edu");
  ck("no @: the text as it is; nothing: empty", [emailWithBreak("coach"), emailWithBreak(null)], ["coach", ""]);
  ck("the contact line renders the email through it", /\{emailWithBreak\(it\.contact_email\)\}/.test(targetsCode), true);

  // The real handlers, run as each render would see them, with a stand-in clock and timers.
  const tapJs = babel.transform(["tapDelete", "armDelete", "disarmDelete"].map(srcOf).join("\n"), { presets: ["react"] }).code;
  function tapHarness() {
    const h = { armed: null, deleted: [], failedId: "x", now: 1000, timers: new Map(), ref: { current: { at: 0, timer: null } } };
    let nextTimer = 1;
    const env = {
      setArmedTarget: (v) => { h.armed = v; },
      setDeleteFailedId: (v) => { h.failedId = v; },
      removeTarget: (id) => { h.deleted.push(id); },
      setTimeout: (f, ms) => { const id = nextTimer++; h.timers.set(id, { f, at: h.now + ms }); return id; },
      clearTimeout: (id) => { h.timers.delete(id); },
    };
    const names = ["armedTarget", "armRef", "targetDeleteTap", "TARGET_DELETE_ARM_MS", ...Object.keys(env)];
    const make = new Function(...names, tapJs + "\nreturn tapDelete;");
    // at: the tap's event time stamp; by default the moment it is handled.
    h.tap = (id, at = h.now) => make(h.armed, h.ref, targetDeleteTap, TARGET_DELETE_ARM_MS, ...Object.values(env))(id, at);
    h.wait = (ms) => { h.now += ms; for (const [id, tm] of [...h.timers]) if (tm.at <= h.now) { h.timers.delete(id); tm.f(); } };
    return h;
  }
  {
    const h = tapHarness();
    h.tap("a");
    ck("the first tap arms the row and deletes nothing", [h.armed, h.deleted], ["a", []]);
    ck("...and clears an earlier refused-delete line", h.failedId, null);
    h.wait(150); h.tap("a");
    ck("a second tap 150 ms later (a double tap) deletes nothing and stays armed", [h.armed, h.deleted], ["a", []]);
    h.wait(850); h.tap("a");
    ck("a tap a second after arming deletes that row and disarms", [h.armed, h.deleted], [null, ["a"]]);
    ck("...leaving no timer behind", h.timers.size, 0);
  }
  {
    // A slow phone: the second tap of a double tap happened 150 ms after the first but is handled 900 ms
    // later, after the re-render. Its own time stamp is what counts.
    const h = tapHarness();
    const first = h.now;
    h.tap("a"); h.wait(900); h.tap("a", first + 150);
    ck("a double tap handled late still deletes nothing", [h.armed, h.deleted], ["a", []]);
  }
  {
    const h = tapHarness();
    h.tap("a"); h.wait(5999);
    ck("still armed just before 6 s", h.armed, "a");
    h.wait(1);
    ck("disarmed at 6 s", h.armed, null);
    h.tap("a");
    ck("after it disarms, a tap arms again, never deletes", [h.armed, h.deleted], ["a", []]);
  }
  {
    const h = tapHarness();
    h.tap("a"); h.wait(1000); h.tap("b");
    ck("arming another row disarms the first and deletes nothing", [h.armed, h.deleted], ["b", []]);
    h.wait(5500);
    ck("the first row's timer does not cut the second row's 6 s short", h.armed, "b");
    h.wait(500);
    ck("the second row disarms at its own 6 s", h.armed, null);
  }

  // The real removeTarget against a stand-in database answer.
  const rmJs = babel.transform(srcOf("removeTarget"), { presets: ["react"] }).code;
  function rmHarness() {
    const h = { state: [{ id: "a", name: "A" }, { id: "b", name: "B", draft_email: "Hi" }, { id: "c", name: "C" }], failedId: "x", errs: [], kept: [], sent: [] };
    let answer; const reply = new Promise((r) => { answer = r; });
    h.answer = answer;
    const sbStub = { from: (table) => ({ delete: () => { const q = { eq: (k, v) => { h.sent.push([table, k, v]); return q; }, then: (a, b) => reply.then(a, b) }; return q; } }) };
    const make = new Function("items", "setItems", "sb", "actingFor", "uid", "setErr", "setDeleteFailedId", "keepText", "TARGET_TEXT_FIELDS", "console", rmJs + "\nreturn removeTarget;");
    h.run = (id) => make(h.state, (f) => { h.state = typeof f === "function" ? f(h.state) : f; }, sbStub, null, "u1",
      (e) => h.errs.push(e), (v) => { h.failedId = v; }, (id2, field, v) => h.kept.push([id2, field, v]), TARGET_TEXT_FIELDS, { error() {} })(id);
    return h;
  }
  pendingChecks.push((async () => {
    {
      const h = rmHarness();
      const done = h.run("b");
      ck("the row leaves the list at once", h.state.map((r) => r.id), ["a", "c"]);
      h.state = h.state.map((r) => (r.id === "c" ? { ...r, status: "contacted" } : r));  // another row changes meanwhile
      h.answer({ error: { message: "refused" } }); await done;
      ck("a refused delete puts the row back in its place", h.state.map((r) => r.id), ["a", "b", "c"]);
      ck("...with its draft", h.state[1].draft_email, "Hi");
      ck("...without undoing another row's change", h.state[2].status, "contacted");
      ck("...and marks that row, which shows the error", h.failedId, "b");
      ck("...and keeps any text kept for its boxes", h.kept, []);
    }
    {
      const h = rmHarness();
      const done = h.run("b"); h.answer({ error: null }); await done;
      ck("a stored delete leaves the row gone", h.state.map((r) => r.id), ["a", "c"]);
      ck("...with no error mark", h.failedId, null);
      ck("...and drops text kept for each of its boxes", h.kept, TARGET_TEXT_FIELDS.map((field) => ["b", field, null]));
      ck("the delete is scoped to the row and its owner", h.sent, [["outreach_targets", "id", "b"], ["outreach_targets", "user_id", "u1"]]);
    }
    {
      const h = rmHarness();
      await h.run("gone");
      ck("a row that is not on the list sends nothing", h.sent, []);
    }
  })());
}

/* ---------- TargetTextArea run with stand-in hooks ---------- */
// The real component source, compiled as the app compiles it, run with a
// minimal hook runtime: state re-renders at once, mount effects run after the
// first render, and after unmount nothing renders (as in React).
const boxJs = require("@babel/standalone").transform(CODE.slice(ta.node.start, ta.node.end), { presets: ["react"] }).code;
const tk = (k) => (k === "target_counter" ? "{n} / {max}" : k);
function mountBox(initial) {
  let props = initial, i = 0, alive = true, tree = null;
  const slots = [], effects = [], cleanups = [];
  const useState = (init) => { const k = i++; if (!(k in slots)) slots[k] = { v: init }; const s = slots[k]; return [s.v, (v) => { if (!alive) return; s.v = typeof v === "function" ? v(s.v) : v; render(); }]; };
  const useRef = (init) => { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; };
  const useEffect = (f) => { const k = i++; if (!(k in slots)) { slots[k] = {}; effects.push(f); } };
  const React = { createElement: (type, p, ...children) => ({ type, props: p || {}, children: children.flat() }) };
  const C = new Proxy({}, { get: (o, k) => "var(--" + String(k) + ")" });
  const Box = new Function("React", "useState", "useRef", "useEffect", "useLang", "C", boxJs + "\nreturn TargetTextArea;")(React, useState, useRef, useEffect, () => ({ t: tk }), C);
  function render() { i = 0; tree = Box(props); while (effects.length) { const c = effects.shift()(); if (typeof c === "function") cleanups.push(c); } }
  render();
  // No default for n: an absent child ({hint && ...}) is undefined and must not mean "the whole tree".
  const findIn = (n, pred) => {
    if (!n || typeof n !== "object") return null;
    if (pred(n)) return n;
    for (const c of n.children || []) { const r = findIn(c, pred); if (r) return r; }
    return null;
  };
  const find = (pred) => findIn(tree, pred);
  const textOf = (n) => (n.children || []).map((c) => (c == null || typeof c === "boolean" ? "" : typeof c === "object" ? textOf(c) : String(c))).join("");
  const area = () => find((n) => n.type === "textarea");
  return {
    text: () => area().props.value,
    status: () => textOf(find((n) => n.props.role === "status")),
    counter: () => { const s = find((n) => n.type === "span" && / \/ /.test(textOf(n))); return s ? textOf(s) : null; },
    saveButton: () => find((n) => n.type === "button"),
    type: (v) => area().props.onChange({ target: { value: v } }),
    blur: () => area().props.onBlur(),
    setProps: (p) => { props = { ...props, ...p }; if (alive) render(); },
    unmount: () => { alive = false; cleanups.forEach((c) => c()); },
  };
}
// onSave like Targets' updateTarget: shows the text at once, rolls it back if refused.
function pageLike(stored, extra) {
  const saves = [], keeps = [];
  let value = stored, box = null;
  const show = (v) => { value = v; box.setProps({ value: v }); };
  box = mountBox({
    value: stored, limit: TARGET_LIMITS.draft_email, label: "Draft", explicitSave: true, style: {},
    onSave: (v) => {
      const before = value; show(v);
      let res; const p = new Promise((r) => { res = r; });
      saves.push({ v, answer: (ok) => { if (!ok) show(before); res(ok); } });
      return p;
    },
    onKeep: (v) => keeps.push(v),
    ...extra,
  });
  return { box, saves, keeps };
}
const tick = () => new Promise((r) => setImmediate(r));
pendingChecks.push((async () => {
  {
    // The reviewer's flow: type, leave the box (blur saves), close the row at once, the save is refused.
    const { box, saves, keeps } = pageLike("Old draft");
    box.type("Hello Coach Rivera"); box.blur();
    ck("blur starts one save with the typed text", saves.map((s) => s.v), ["Hello Coach Rivera"]);
    ck("Saving… while it is on the way", box.status(), "target_status_saving");
    box.unmount();
    ck("closing during the save reports nothing yet", keeps, []);
    saves[0].answer(false); await tick();
    ck("the refused save after the close hands the typed text to the page", keeps, ["Hello Coach Rivera"]);
  }
  {
    const { box, saves, keeps } = pageLike("Old draft");
    box.type("Stored now"); box.blur(); box.unmount();
    saves[0].answer(true); await tick();
    ck("a stored save after the close reports nothing left (null)", keeps, [null]);
  }
  {
    const { box, saves, keeps } = pageLike("Old draft");
    box.type("First part"); box.blur(); box.type("First part, and more"); box.unmount();
    saves[0].answer(true); await tick();
    ck("text typed while the save was on the way is not lost when the box closes", keeps, ["First part, and more"]);
  }
  {
    const { box, saves, keeps } = pageLike("Old draft");
    box.type("Typed, never left the box"); box.unmount();
    ck("closing with changes and no blur hands them over at once", [saves.length, keeps], [0, ["Typed, never left the box"]]);
  }
  {
    const { box, keeps } = pageLike("Old draft");
    box.unmount();
    ck("closing an untouched box reports null", keeps, [null]);
  }
  {
    // Refused while open: the text stays, the status says so, Save works again.
    const { box, saves, keeps } = pageLike("Old draft");
    box.type("Keep me"); box.saveButton().props.onClick();
    ck("Save is disabled while saving", box.saveButton().props.disabled, true);
    box.saveButton().props.onClick(); box.blur();
    ck("a second tap or a blur while saving starts no second save", saves.length, 1);
    saves[0].answer(false); await tick();
    ck("after a refusal the typed text is still in the box", box.text(), "Keep me");
    ck("...the status says Not saved", box.status(), "target_status_failed");
    ck("...and Save can be pressed again", box.saveButton().props.disabled, false);
    ck("...and the open box keeps its own text (nothing handed over)", keeps, []);
    box.saveButton().props.onClick(); saves[1].answer(true); await tick();
    ck("the retry is stored and says Saved", [saves[1].v, box.status(), box.saveButton().props.disabled], ["Keep me", "target_status_saved", true]);
    box.type("Keep me!");
    ck("a new change says Unsaved changes", box.status(), "target_status_unsaved");
  }
  {
    // Reopened from kept text: the box starts from it, says Not saved, and takes it over.
    const { box, keeps } = pageLike("Old draft", { kept: "Lost draft" });
    ck("a reopened box starts from the kept text", box.text(), "Lost draft");
    ck("...says Not saved", box.status(), "target_status_failed");
    ck("...offers Save", box.saveButton().props.disabled, false);
    ck("...and takes the text over from the page (onKeep(null))", keeps, [null]);
    box.unmount();
    ck("closing it again unsaved hands it back", keeps, [null, "Lost draft"]);
  }
  {
    const { box } = pageLike("Same", { kept: "Same" });
    ck("kept text equal to the stored text is not a failure", [box.text(), box.status()], ["Same", ""]);
  }
  {
    const { box } = pageLike("");
    box.type("a".repeat(10001));
    ck("a 10,001-character paste is cut to the limit", box.text().length, 10000);
    ck("...and the counter shows it", box.counter(), "10000 / 10000");
    box.type("a".repeat(8999));
    ck("no counter below 90% of the limit", box.counter(), null);
  }
})());

/* ---------- i18n: every key in all four languages ---------- */
const keys = ["target_err_name_required", "target_err_too_long", "target_err_email_invalid",
  "target_delete_armed", "target_delete_armed_draft", "target_delete_aria", "target_delete_aria_draft", "target_delete_err", "targets_save_err",
  "target_draft_save", "target_status_unsaved", "target_status_saving", "target_status_saved", "target_status_failed", "target_draft_to", "target_counter",
  "target_unsaved"];
const usedKeys = new Set(src.match(/target_[a-z_]+/g).filter((k) => !k.startsWith("target_limits")));
for (const k of usedKeys) ck(`helper key ${k} is in the list checked below`, keys.includes(k), true);
const langs = ["en", "fr", "es", "el"];
const starts = langs.map((l) => APP.indexOf(`\n  ${l}: {`, APP.indexOf("const I18N = {")));
langs.forEach((l, i) => {
  const block = APP.slice(starts[i], starts[i + 1] > 0 ? starts[i + 1] : undefined);
  for (const k of keys) ck(`${l} has ${k}`, new RegExp(`\\b${k}: "[^"]+"`).test(block), true);
  ck(`${l} aria texts carry {name}`, ["target_delete_aria", "target_delete_aria_draft"].every((k) => new RegExp(`\\b${k}: "[^"]*\\{name\\}`).test(block)), true);
  ck(`${l} target_unsaved names the target`, /\btarget_unsaved: "[^"]*\{name\}/.test(block), true);
  // The armed word replaces a 44px X inside a full row, so it stays one short word.
  const word = (/\btarget_delete_armed: "([^"]+)"/.exec(block) || [])[1] || "";
  const warning = (/\btarget_delete_armed_draft: "([^"]+)"/.exec(block) || [])[1] || "";
  ck(`${l} armed word is short (${word})`, word.length > 0 && word.length <= 12, true);
  ck(`${l} the draft warning is a sentence of its own`, warning.length > word.length + 10, true);
  ck(`${l} the retired targets_delete_confirm keys are gone`, /\btargets_delete_confirm(_aria)?:/.test(block), false);
});
ck("en: a target with no draft says the short Delete?", /\btarget_delete_armed: "Delete\?"/.test(APP), true);
ck("en: the draft warning names the draft and asks for a second tap", /\btarget_delete_armed_draft: "Delete this and its draft email\? Tap again to confirm\."/.test(APP), true);

Promise.all(pendingChecks).then(() => {
  console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
  process.exit(f ? 1 : 0);
}, (e) => { console.log("FAIL  the async checks threw: " + (e && e.stack)); process.exit(1); });
