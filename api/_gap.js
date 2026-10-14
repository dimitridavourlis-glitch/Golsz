// THE GAP, SERVER SIDE — the same evaluation Home and Plan run.
//
// The brief asks that Scout receive bottlenecks as structured context rather
// than re-deriving them in prose. Scout already works this way for the
// Passport score: _readiness.js computes it and the prompt reports the RESULT,
// so Scout cannot contradict the number on the athlete's own screen. The same
// rule applies here.
//
// THE DATA IS NOT DUPLICATED. gapFromRows takes the pathway rows as an
// argument, so the server passes SPORT_CORE's own key_evidence — the original
// that the client mirrors. Only the function exists twice, and
// tests/test_gap_engine.cjs runs BOTH implementations over the same matrix of
// inputs and compares their output. Every duplication bug this codebase has
// had came from a parity check that compared a subset of the text; comparing
// behaviour cannot miss a branch.
//
// Nothing here scores, ranks or compares against a standard. There is no
// reference population in GOLSZ, so PRESENT / MISSING / UNKNOWN is the whole
// vocabulary, and UNKNOWN means the product has nowhere to look — never that
// the athlete falls short.

const EVIDENCE_SOURCES = {
  grad_year: "profile",
  gpa: "profile",
  citizenship: "profile",
  film: "film",
  match_minutes: "benchmark",
  ppg: "benchmark",
  exposure: "outreach",
  level: null,
  coach_evaluation: null,
  trial_history: null,
  aau_exposure: null,
};

// Where exposure begins in outreach_targets' taxonomy (migration 077:
// researching, preparing, contacted, responded, follow_up, opportunity).
// Everything from "contacted" onward means a program has actually heard from
// this athlete; the first two are preparation. A status outside the taxonomy
// must never count — testing for ABSENCE of one value made every row pass.
const CONTACTED_STATUSES = ["contacted", "responded", "follow_up", "opportunity"];

function gapFromRows(rows, pathwayType, athlete, benchmarks, outreach) {
  if (!rows || !pathwayType) return null;
  // ID FIRST, THEN goal_type. pathway_plan stores a goal_type, and soccer maps
  // TWO rows to "professional" — semi_professional and professional. Matching
  // id first means an athlete who has said "professional" is measured against
  // the professional row, the stricter of the two. Measuring them against the
  // semi-pro row instead would quietly tell them they need less than they do.
  const row = rows.find((r) => r.id === pathwayType) || rows.find((r) => r.goal_type === pathwayType);
  if (!row) return null;
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const metric = (key) => (benchmarks || []).some((b) => b && b.metric_key === key);
  const items = row.key_evidence.map((key) => {
    const src = EVIDENCE_SOURCES[key];
    if (!src) return { key, state: "unknown", source: null };
    let present = false;
    if (src === "profile") present = has(athlete && athlete[key]);
    else if (src === "film") present = !!(athlete && Array.isArray(athlete.highlights) && athlete.highlights.length > 0);
    else if (src === "benchmark") present = metric(key);
    // Being on a list is not being seen by anyone — but the first version of
    // this tested `status !== "to_contact"`, and "to_contact" has not been a
    // legal status since migration 077. Every row passed, so merely ADDING a
    // school reported exposure as present, to the athlete and to Scout. The
    // insert default is "researching", which is the opposite of contact.
    //
    // The real taxonomy, in order, is researching, preparing, contacted,
    // responded, follow_up, opportunity. Exposure begins at contacted: the
    // first two are the athlete preparing to reach out, not being seen.
    else if (src === "outreach") present = (outreach || []).some((o) => o && CONTACTED_STATUSES.indexOf(o.status) !== -1);
    return { key, state: present ? "present" : "missing", source: src };
  });
  return {
    pathway: row.id,
    items,
    missing: items.filter((x) => x.state === "missing").map((x) => x.key),
    unknown: items.filter((x) => x.state === "unknown").map((x) => x.key),
    present: items.filter((x) => x.state === "present").map((x) => x.key),
  };
}
export { EVIDENCE_SOURCES, gapFromRows };
