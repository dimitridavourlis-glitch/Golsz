// Harness test for the Scout Cache pure functions in api/scout.js:
// researchTopicKey / athleteStateDigest / usedWebSearch / extractSearchSources
// / extractResearchNote. Mirrored inline, same approach as the other harnesses.
const TOPIC_STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","could","do","does","for","from","get","got","how","i","if","in","is","it","its","me","my","of","on","or","should","so","that","the","their","them","there","they","this","to","was","we","what","when","where","which","who","why","will","with","would","you","your","about","any","need","want","tell","know","much","many","some","just","like","really","please",
]);
function researchTopicKey(text, sport, country) {
  const tokens = String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w));
  const uniq = Array.from(new Set(tokens)).sort().slice(0, 12);
  if (!uniq.length) return null;
  return [String(sport || "any").toLowerCase(), String(country || "any").toLowerCase(), uniq.join("-")].join(":").slice(0, 400);
}
function athleteStateDigest(state, plan, goalDefined) {
  return [
    String((state && state.sport) || "?"), String((state && state.country) || "?"),
    String(plan || "?"), goalDefined ? "goal" : "nogoal",
    state && state.pathwayCreated ? "pathway" : "nopathway",
    state && state.baselineComplete ? "baseline" : "nobaseline",
  ].join("|");
}
function usedWebSearch(data) {
  return (data && Array.isArray(data.content) ? data.content : []).some(
    (b) => b && (b.type === "web_search_tool_result" || (b.type === "server_tool_use" && b.name === "web_search")));
}
function extractSearchSources(data) {
  const out = [];
  for (const b of (data && Array.isArray(data.content) ? data.content : [])) {
    if (!b || b.type !== "web_search_tool_result") continue;
    for (const r of (Array.isArray(b.content) ? b.content : [])) {
      if (r && typeof r.url === "string") out.push({ url: r.url.slice(0, 500), title: typeof r.title === "string" ? r.title.slice(0, 200) : null });
      if (out.length >= 8) return out;
    }
  }
  return out;
}
const RESEARCH_TTL_DEFAULT_DAYS = 14;
function extractResearchNote(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    const note = parsed && parsed.research_note;
    if (!note || typeof note !== "object") return null;
    const summary = typeof note.summary === "string" ? note.summary.trim().slice(0, 1200) : "";
    if (summary.length < 20) return null;
    let confidence = typeof note.confidence === "number" ? note.confidence : 0.6;
    if (!(confidence >= 0 && confidence <= 1)) confidence = 0.6;
    let validDays = Number.isInteger(note.valid_days) ? note.valid_days : RESEARCH_TTL_DEFAULT_DAYS;
    if (validDays < 1 || validDays > 90) validDays = RESEARCH_TTL_DEFAULT_DAYS;
    return { summary, confidence, validDays };
  } catch { return null; }
}
// Mirrors the selection rule inside getResearchCache().
function pickUsable(rows, stateDigest) {
  return rows.find((c) => c.scope === "athlete" && c.athlete_state_hash === stateDigest) || rows.find((c) => c.scope === "global") || null;
}

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
};
const wrap = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

// --- topic key: the whole point is paraphrase tolerance ---
check("word order does not change the key",
  researchTopicKey("what are the NCAA eligibility rules", "Soccer", "Canada"),
  researchTopicKey("eligibility rules for the NCAA", "Soccer", "Canada"));
check("punctuation and case do not change the key",
  researchTopicKey("NCAA Eligibility Rules?!", "Soccer", "Canada"),
  researchTopicKey("ncaa eligibility rules", "Soccer", "Canada"));
check("filler words do not change the key",
  researchTopicKey("can you please tell me about NCAA eligibility rules", "Soccer", "Canada"),
  researchTopicKey("NCAA eligibility rules", "Soccer", "Canada"));
check("different sport gives a different key",
  researchTopicKey("ncaa eligibility rules", "Soccer", "Canada") === researchTopicKey("ncaa eligibility rules", "Tennis", "Canada"), false);
check("different country gives a different key",
  researchTopicKey("ncaa eligibility rules", "Soccer", "Canada") === researchTopicKey("ncaa eligibility rules", "Soccer", "Greece"), false);
check("genuinely different question gives a different key",
  researchTopicKey("ncaa eligibility rules", "Soccer", "Canada") === researchTopicKey("mls academy trial dates", "Soccer", "Canada"), false);
check("missing sport/country still yields a key", researchTopicKey("ncaa eligibility rules", null, null).startsWith("any:any:"), true);
check("all-stopword question yields null (never cached)", researchTopicKey("what about it?", "Soccer", "Canada"), null);
check("empty text yields null", researchTopicKey("", "Soccer", "Canada"), null);
check("key is capped at 400 chars", researchTopicKey(Array.from({length:200},(_,i)=>"word"+i).join(" "), "Soccer", "Canada").length <= 400, true);

// --- athlete state digest: step 3, "have circumstances materially changed" ---
const base = { sport: "Soccer", country: "Canada", pathwayCreated: false, baselineComplete: false };
check("same state gives same digest", athleteStateDigest(base, "free", false), athleteStateDigest({ ...base }, "free", false));
check("gaining a goal changes the digest",
  athleteStateDigest(base, "free", false) === athleteStateDigest(base, "free", true), false);
check("gaining a pathway changes the digest",
  athleteStateDigest(base, "free", false) === athleteStateDigest({ ...base, pathwayCreated: true }, "free", false), false);
check("changing plan changes the digest",
  athleteStateDigest(base, "free", false) === athleteStateDigest(base, "pro", false), false);
check("changing sport changes the digest",
  athleteStateDigest(base, "free", false) === athleteStateDigest({ ...base, sport: "Tennis" }, "free", false), false);
check("null state does not throw", typeof athleteStateDigest(null, null, false), "string");

// --- cache selection / staleness ---
const D = athleteStateDigest(base, "free", false);
const stale = athleteStateDigest(base, "free", true);
check("fresh athlete-scoped row is used",
  pickUsable([{ scope: "athlete", athlete_state_hash: D, summary: "x" }], D).summary, "x");
check("stale athlete-scoped row is rejected",
  pickUsable([{ scope: "athlete", athlete_state_hash: stale, summary: "x" }], D), null);
check("stale athlete row falls back to a global row",
  pickUsable([{ scope: "athlete", athlete_state_hash: stale, summary: "a" }, { scope: "global", summary: "g" }], D).summary, "g");
check("athlete row is preferred over global when fresh",
  pickUsable([{ scope: "global", summary: "g" }, { scope: "athlete", athlete_state_hash: D, summary: "a" }], D).summary, "a");
check("no rows yields null", pickUsable([], D), null);

// --- web search detection ---
check("web_search_tool_result counts", usedWebSearch({ content: [{ type: "web_search_tool_result", content: [] }] }), true);
check("server_tool_use web_search counts", usedWebSearch({ content: [{ type: "server_tool_use", name: "web_search" }] }), true);
check("GOLSZ player search does NOT count",
  usedWebSearch({ content: [{ type: "tool_use", name: "search_golsz_players" }] }), false);
check("plain text reply does not count", usedWebSearch({ content: [{ type: "text", text: "hi" }] }), false);
check("missing content does not throw", usedWebSearch({}), false);

// --- sources come from tool results, not the model ---
check("sources extracted from tool result blocks",
  extractSearchSources({ content: [{ type: "web_search_tool_result", content: [{ url: "https://ncaa.org/x", title: "NCAA" }] }] }),
  [{ url: "https://ncaa.org/x", title: "NCAA" }]);
check("source without title still captured",
  extractSearchSources({ content: [{ type: "web_search_tool_result", content: [{ url: "https://a.b" }] }] }), [{ url: "https://a.b", title: null }]);
check("sources capped at 8",
  extractSearchSources({ content: [{ type: "web_search_tool_result", content: Array.from({ length: 30 }, (_, i) => ({ url: "https://x/" + i })) }] }).length, 8);
check("model-claimed sources in the text are ignored",
  extractSearchSources(wrap({ research_note: { summary: "s".repeat(30) }, sources: ["https://fake.example"] })), []);

// --- research note validation ---
check("valid note parsed",
  extractResearchNote(wrap({ research_note: { summary: "NCAA D1 requires 16 core courses.", confidence: 0.8, valid_days: 30 } })),
  { summary: "NCAA D1 requires 16 core courses.", confidence: 0.8, validDays: 30 });
check("absent note yields null", extractResearchNote(wrap({ reply: "hi" })), null);
check("too-short summary rejected", extractResearchNote(wrap({ research_note: { summary: "short" } })), null);
check("valid_days out of range falls back to 14",
  extractResearchNote(wrap({ research_note: { summary: "s".repeat(30), valid_days: 9999 } })).validDays, 14);
check("valid_days zero falls back to 14",
  extractResearchNote(wrap({ research_note: { summary: "s".repeat(30), valid_days: 0 } })).validDays, 14);
check("confidence out of range falls back to 0.6",
  extractResearchNote(wrap({ research_note: { summary: "s".repeat(30), confidence: 5 } })).confidence, 0.6);
check("summary truncated to 1200",
  extractResearchNote(wrap({ research_note: { summary: "z".repeat(9000) } })).summary.length, 1200);
check("unparseable reply yields null", extractResearchNote({ content: [{ type: "text", text: "nope" }] }), null);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
