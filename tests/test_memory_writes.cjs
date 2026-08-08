// Harness test for extractMemoryWrites() (api/scout.js). Mirrored inline
// rather than imported, same approach as test_compute_next_move.js — the real
// function lives in a Vercel handler module with top-level env reads.
// The invariants under test are the spec's provenance rules:
//   "USER CLAIMS ARE NOT GLOBAL FACTS / SCOUT INFERENCES ARE NOT GLOBAL FACTS"
// enforced here as: the model cannot self-certify a FACT, and cannot ever
// produce source = "verified".
const MEMORY_TYPES = new Set([
  "FACT", "USER_STATED", "SCOUT_INFERENCE", "GOAL", "PREFERENCE", "CONCERN",
  "UNKNOWN", "NEXT_DATA_NEEDED", "ASSESSMENT", "DECISION",
  "PATHWAY_CONSIDERED", "PATHWAY_REJECTED", "PATHWAY_ACTIVE", "MILESTONE",
]);
const MEMORY_ASSERTED_TYPES = new Set(["FACT", "USER_STATED"]);

function extractMemoryWrites(data) {
  let writes;
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    writes = parsed && Array.isArray(parsed.memory_writes) ? parsed.memory_writes : null;
  } catch { return []; }
  if (!writes) return [];
  const out = [];
  for (const raw of writes.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const subject = typeof raw.subject === "string" ? raw.subject.trim().slice(0, 120) : "";
    const content = typeof raw.content === "string" ? raw.content.trim().slice(0, 1000) : "";
    if (!subject || !content) continue;
    let type = typeof raw.type === "string" ? raw.type.trim().toUpperCase() : "";
    if (!MEMORY_TYPES.has(type)) continue;
    const source = raw.source === "athlete_stated" ? "athlete_stated" : "ai_inferred";
    if (MEMORY_ASSERTED_TYPES.has(type) && source !== "athlete_stated") type = "SCOUT_INFERENCE";
    let confidence = typeof raw.confidence === "number" ? raw.confidence : 0.6;
    if (!(confidence >= 0 && confidence <= 1)) confidence = 0.6;
    let importance = Number.isInteger(raw.importance) ? raw.importance : 3;
    if (importance < 1 || importance > 5) importance = 3;
    out.push({ type, subject, content, confidence, source, importance });
  }
  return out;
}

const wrap = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const one = (m) => extractMemoryWrites(wrap({ reply: "hi", memory_writes: [m] }))[0];

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
};

// --- provenance: the model cannot self-certify a fact ---
check("FACT claimed with ai_inferred source is downgraded",
  one({ type: "FACT", subject: "club", content: "Omonia", source: "ai_inferred" }).type, "SCOUT_INFERENCE");
check("FACT with no source at all is downgraded",
  one({ type: "FACT", subject: "club", content: "Omonia" }).type, "SCOUT_INFERENCE");
check("USER_STATED claimed with ai_inferred is downgraded",
  one({ type: "USER_STATED", subject: "club", content: "Omonia", source: "ai_inferred" }).type, "SCOUT_INFERENCE");
check("FACT genuinely marked athlete_stated survives",
  one({ type: "FACT", subject: "club", content: "Omonia", source: "athlete_stated" }).type, "FACT");
check("SCOUT_INFERENCE + athlete_stated keeps its type (only asserted types are policed)",
  one({ type: "SCOUT_INFERENCE", subject: "level", content: "mid", source: "athlete_stated" }).type, "SCOUT_INFERENCE");

// --- source can never be "verified" ---
check("source 'verified' is coerced to ai_inferred",
  one({ type: "GOAL", subject: "goal", content: "MLS", source: "verified" }).source, "ai_inferred");
check("garbage source is coerced to ai_inferred",
  one({ type: "GOAL", subject: "goal", content: "MLS", source: "<script>" }).source, "ai_inferred");

// --- type allowlist ---
check("unknown type is dropped entirely",
  extractMemoryWrites(wrap({ memory_writes: [{ type: "TOTALLY_MADE_UP", subject: "s", content: "c" }] })).length, 0);
check("lowercase type is normalised",
  one({ type: "goal", subject: "g", content: "c", source: "athlete_stated" }).type, "GOAL");

// --- required fields ---
check("missing subject drops the row",
  extractMemoryWrites(wrap({ memory_writes: [{ type: "GOAL", content: "c" }] })).length, 0);
check("blank content drops the row",
  extractMemoryWrites(wrap({ memory_writes: [{ type: "GOAL", subject: "s", content: "   " }] })).length, 0);
check("non-object entry is skipped",
  extractMemoryWrites(wrap({ memory_writes: ["nope", null, 42] })).length, 0);

// --- numeric clamping ---
check("confidence above 1 falls back to default", one({ type: "GOAL", subject: "g", content: "c", confidence: 9 }).confidence, 0.6);
check("negative confidence falls back to default", one({ type: "GOAL", subject: "g", content: "c", confidence: -1 }).confidence, 0.6);
check("valid confidence preserved", one({ type: "GOAL", subject: "g", content: "c", confidence: 0.9 }).confidence, 0.9);
check("importance 0 falls back to 3", one({ type: "GOAL", subject: "g", content: "c", importance: 0 }).importance, 3);
check("importance 99 falls back to 3", one({ type: "GOAL", subject: "g", content: "c", importance: 99 }).importance, 3);
check("non-integer importance falls back to 3", one({ type: "GOAL", subject: "g", content: "c", importance: 2.5 }).importance, 3);
check("valid importance preserved", one({ type: "GOAL", subject: "g", content: "c", importance: 5 }).importance, 5);

// --- caps and truncation ---
check("caps at 8 writes",
  extractMemoryWrites(wrap({ memory_writes: Array.from({ length: 20 }, (_, i) => ({ type: "GOAL", subject: "s" + i, content: "c" })) })).length, 8);
check("subject truncated to 120 chars", one({ type: "GOAL", subject: "x".repeat(500), content: "c" }).subject.length, 120);
check("content truncated to 1000 chars", one({ type: "GOAL", subject: "s", content: "y".repeat(5000) }).content.length, 1000);

// --- absence / malformed payloads ---
check("no memory_writes key yields []", extractMemoryWrites(wrap({ reply: "hello" })), []);
check("memory_writes null yields []", extractMemoryWrites(wrap({ memory_writes: null })), []);
check("non-array memory_writes yields []", extractMemoryWrites(wrap({ memory_writes: { a: 1 } })), []);
check("unparseable content yields []", extractMemoryWrites({ content: [{ type: "text", text: "not json at all" }] }), []);
check("empty content yields []", extractMemoryWrites({ content: [] }), []);
check("json fenced in markdown still parses",
  extractMemoryWrites({ content: [{ type: "text", text: '```json\n{"memory_writes":[{"type":"GOAL","subject":"g","content":"c"}]}\n```' }] }).length, 1);

// --- the Yiorgi third-party case from the spec's acceptance tests ---
// "cousin Harry Davourlis reportedly scouted by a Cypriot team" is a claim
// about someone else. Even if the model mislabels it as an athlete-stated
// FACT, it must not be stored as an asserted fact.
const thirdParty = one({ type: "FACT", subject: "cousin scouted", content: "Cousin reportedly scouted by a Cypriot team", source: "ai_inferred", confidence: 0.3 });
check("third-party claim is not stored as FACT", thirdParty.type, "SCOUT_INFERENCE");
check("third-party claim keeps its low confidence", thirdParty.confidence, 0.3);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
