const DEV_FOCUS_AREA_SET = new Set(["training", "strength", "speed", "conditioning", "recovery", "sleep", "hydration", "nutrition", "other"]);

function extractSuggestedTargets(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    if (!parsed || !Array.isArray(parsed.suggested_targets)) return null;
    const clean2 = parsed.suggested_targets
      .filter((t) => t && typeof t.name === "string" && t.name.trim())
      .slice(0, 5)
      .map((t) => ({ name: t.name.trim().slice(0, 120), reasoning: typeof t.reasoning === "string" ? t.reasoning.trim().slice(0, 300) : "" }));
    return clean2.length ? clean2 : null;
  } catch {
    return null;
  }
}

function extractSuggestedDevItems(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    if (!parsed || !Array.isArray(parsed.suggested_dev_items)) return null;
    const clean2 = parsed.suggested_dev_items
      .filter((i) => i && typeof i.goal === "string" && i.goal.trim())
      .slice(0, 3)
      .map((i) => ({ focus_area: DEV_FOCUS_AREA_SET.has(i.focus_area) ? i.focus_area : "other", goal: i.goal.trim().slice(0, 200) }));
    return clean2.length ? clean2 : null;
  } catch {
    return null;
  }
}

function mkData(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

let failed = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)})`);
}

check("no suggested_targets key -> null",
  extractSuggestedTargets(mkData({ reply: "hi" })), null);

check("suggested_targets: null -> null",
  extractSuggestedTargets(mkData({ reply: "hi", suggested_targets: null })), null);

check("valid targets, capped at 5, trimmed",
  extractSuggestedTargets(mkData({ reply: "hi", suggested_targets: [
    { name: "State University", reasoning: "Strong D1 program matching your grad year." },
    { name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E (should be dropped)" },
  ] })),
  [
    { name: "State University", reasoning: "Strong D1 program matching your grad year." },
    { name: "A", reasoning: "" }, { name: "B", reasoning: "" }, { name: "C", reasoning: "" }, { name: "D", reasoning: "" },
  ]);

check("malformed entries filtered out",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "" }, { reasoning: "no name" }, null, { name: "Valid" }] })),
  [{ name: "Valid", reasoning: "" }]);

check("empty array after filtering -> null",
  extractSuggestedTargets(mkData({ suggested_targets: [{ name: "" }] })), null);

check("malformed JSON -> null (never throws)",
  extractSuggestedTargets({ content: [{ type: "text", text: "not json {{{" }] }), null);

check("dev items valid, unknown focus_area falls back to other",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [
    { focus_area: "speed", goal: "Improve 40-yard dash by 0.1s" },
    { focus_area: "made_up_area", goal: "Something else" },
  ] })),
  [
    { focus_area: "speed", goal: "Improve 40-yard dash by 0.1s" },
    { focus_area: "other", goal: "Something else" },
  ]);

check("dev items capped at 3",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [
    { focus_area: "speed", goal: "1" }, { focus_area: "speed", goal: "2" },
    { focus_area: "speed", goal: "3" }, { focus_area: "speed", goal: "4" },
  ] })).length, 3);

check("dev items missing goal filtered",
  extractSuggestedDevItems(mkData({ suggested_dev_items: [{ focus_area: "speed" }] })), null);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
