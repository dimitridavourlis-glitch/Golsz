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

/* ---------- i18n: every key in all four languages ---------- */
const keys = ["target_err_name_required", "target_err_too_long", "target_err_email_invalid",
  "target_delete_armed", "target_delete_armed_draft", "target_delete_aria", "target_delete_aria_draft"];
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
