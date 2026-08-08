function extractDraftedEmail(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    return (parsed && typeof parsed.drafted_email === "string" && parsed.drafted_email.trim()) ? parsed.drafted_email.trim().slice(0, 4000) : null;
  } catch {
    return null;
  }
}
function mkData(obj) { return { content: [{ type: "text", text: JSON.stringify(obj) }] }; }

let failed = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)})`);
}

check("no drafted_email key -> null", extractDraftedEmail(mkData({ reply: "hi" })), null);
check("drafted_email: null -> null", extractDraftedEmail(mkData({ reply: "hi", drafted_email: null })), null);
check("valid drafted email -> trimmed string", extractDraftedEmail(mkData({ drafted_email: "  Dear Coach Smith,\n\nI'm interested...\n\nBest,\nJordan  " })), "Dear Coach Smith,\n\nI'm interested...\n\nBest,\nJordan");
check("empty string -> null", extractDraftedEmail(mkData({ drafted_email: "   " })), null);
check("non-string -> null", extractDraftedEmail(mkData({ drafted_email: 123 })), null);
check("capped at 4000 chars", extractDraftedEmail(mkData({ drafted_email: "x".repeat(5000) })).length, 4000);
check("malformed JSON -> null", extractDraftedEmail({ content: [{ type: "text", text: "not json" }] }), null);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
