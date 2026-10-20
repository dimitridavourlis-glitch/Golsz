// THE ROUTE GOLSZ SHOWS AN ATHLETE, AVAILABLE TO THE SERVER.
//
// golsz-app.html draws a pathway ladder for all 40 sports in its picker.
// api/scout.js knew about two — SPORT_SCHEMAS covers soccer and basketball —
// and the system prompt told Scout that for every other sport there was "no
// position structure, no competition ladder, no pathway list". So an archer
// or a rower was drawn a four-stage route on the Plan screen while Scout, in
// the same app, said it had no route data for their sport.
//
// This is a VERBATIM COPY of that table, for the same reason api/_readiness.js
// and api/_entitlements.js are copies: the client is one bundle with no build
// step and the server is ESM serverless functions, so they cannot import from
// each other. tests/test_sport_pathway_parity.cjs diffs the two and fails on
// any difference, which is what makes a copy safe rather than a time bomb.
//
// Comments are stripped here on purpose: the rationale for each ladder lives
// beside the original in golsz-app.html, and duplicating prose would mean two
// places to update when the reasoning changes.

export const SPORT_PATHWAY_STAGES = {
  "Soccer": { stages: ["academy", "u19_u21", "senior", "professional"], altBranch: "ncaa" },
  "Futsal": { stages: ["academy", "u19_u21", "senior_futsal", "professional_futsal"], altBranch: null },
  "American Football": { stages: ["high_school", "ncaa_football", "professional_football"], altBranch: null },
  "Baseball": { stages: ["academy_hs", "ncaa_juco", "minor_league", "professional_baseball"], altBranch: null },
  "Basketball": { stages: ["academy_hs", "ncaa_basketball", "professional_basketball"], altBranch: null },
  "Tennis": { stages: ["junior", "itf", "challenger", "pro_tour"], altBranch: "ncaa" },
  "Golf": { stages: ["junior_golf", "college_golf", "developmental_tour", "professional_golf"], altBranch: null },
  "Lacrosse": { stages: ["club_hs", "ncaa_lacrosse", "professional_lacrosse"], altBranch: null },
  "Handball": { stages: ["youth_club", "senior_club", "professional_handball"], altBranch: null },
  "Volleyball": { stages: ["club_hs", "ncaa_volleyball", "professional_volleyball"], altBranch: null },
  "Softball": { stages: ["school_club", "ncaa_college", "pro_league"], altBranch: null },
  "Field Hockey": { stages: ["school_club", "ncaa_college", "national_team"], altBranch: null },
  "Water Polo": { stages: ["school_club", "ncaa_college", "national_team"], altBranch: null },
  "Swimming": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Diving": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Track": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Cross Country": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Wrestling": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Gymnastics": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Fencing": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Rowing": { stages: ["school_club", "ncaa_college", "national", "international"], altBranch: null },
  "Bowling": { stages: ["school_club", "ncaa_college", "pro_circuit"], altBranch: null },
  "Cheerleading": { stages: ["school_club", "regional", "ncaa_college", "national"], altBranch: null },
  "Hockey": { stages: ["school_club", "junior_league", "ncaa_college", "pro_league"], altBranch: null },
  "Rugby": { stages: ["school_club", "senior_club", "pro_league", "national_team"], altBranch: null },
  "Cricket": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Archery": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Badminton": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Table Tennis": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Squash": { stages: ["school_club", "regional", "national", "pro_circuit"], altBranch: null },
  "Racquetball": { stages: ["school_club", "regional", "national", "pro_circuit"], altBranch: null },
  "Boxing": { stages: ["school_club", "regional", "national", "professional"], altBranch: null },
  "Martial Arts": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Weightlifting": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Cycling": { stages: ["school_club", "regional", "national", "pro_circuit"], altBranch: null },
  "Triathlon": { stages: ["school_club", "regional", "national", "pro_circuit"], altBranch: null },
  "Skiing": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Snowboarding": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Sailing": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "Equestrian": { stages: ["school_club", "regional", "national", "international"], altBranch: null },
  "__default": { stages: ["developing", "competing", "advancing"], altBranch: null },
};

// THE HUMAN NAME FOR EACH OF THOSE STAGES, ALSO AVAILABLE TO THE SERVER.
//
// A stage in the table above is an ID, and for a sport-default ladder that id
// is a TRANSLATION KEY, not a label: golsz-app.html renders every default
// stage as t("pathway_stage_" + stage.id) and a stored stage keeps
// label:null until the athlete renames it (SPEC-custom-pathway-stages.md).
//
// The server had no dictionary, so api/scout.js printed the key. The Scout
// prompt read "They have said they are currently at: school_club" — an
// internal key handed to the model as the athlete's own words, which it could
// then reason about and quote back at them — and the standard-route sentence
// listed "academy -> u19_u21 -> senior -> professional" for every soccer
// player, where the Plan screen says "Academy -> U19/U21 -> Senior ->
// Professional".
//
// A VERBATIM COPY of the English pathway_stage_* strings in golsz-app.html's
// I18N.en, grouped on the same lines as the original so the two can be read
// side by side. Same reason the table above is a copy: one bundle with no
// build step, ESM functions on the other side, no import between them.
// tests/test_scout_stage_labels.cjs diffs the two and fails on any drift,
// including a ladder stage that has no label at all.
//
// ENGLISH ONLY, on purpose. The whole system prompt is English and the model
// is told separately to answer in the athlete's language (LANG_NAMES in
// api/scout.js), so the other three dictionaries would be copies nothing
// reads.
export const SPORT_PATHWAY_STAGE_LABELS = {
  academy: "Academy", u19_u21: "U19/U21", senior: "Senior", professional: "Professional",
  senior_futsal: "Senior Futsal", professional_futsal: "Pro Futsal",
  high_school: "High School", ncaa_football: "NCAA", professional_football: "NFL / Pro",
  academy_hs: "Academy / HS", ncaa_juco: "NCAA / JUCO", minor_league: "Minor League", professional_baseball: "MLB / Pro",
  ncaa_basketball: "NCAA", professional_basketball: "Pro",
  junior: "Junior", itf: "ITF", challenger: "Challenger", pro_tour: "ATP/WTA",
  junior_golf: "Junior Golf", college_golf: "College Golf", developmental_tour: "Development Tour", professional_golf: "Pro Tour",
  club_hs: "Club / HS", ncaa_lacrosse: "NCAA", professional_lacrosse: "Pro",
  youth_club: "Youth Club", senior_club: "Senior Club", professional_handball: "Pro",
  ncaa_volleyball: "NCAA", professional_volleyball: "Pro",
  developing: "Developing", school_club: "School or club team", regional: "Regional level", ncaa_college: "College (NCAA / NAIA / JUCO)", national: "National level", national_team: "National team", international: "International competition", pro_league: "Professional league", pro_circuit: "Professional circuit", junior_league: "Junior league", competing: "Competing", advancing: "Advancing",
};

// OWN PROPERTIES ONLY, and null for anything unknown.
//
// The id reaching this function comes from user-writable JSON —
// pathway_plan.current_stage_id and milestones[].stage — so a plain property
// read would resolve "constructor" to Object itself, truthy, and put a
// function's source text into the prompt. api/scout.js shipped exactly that
// bug with LANG_NAMES and lang:"constructor" (see langCode there).
//
// Null, never the id, is the point of this function. A caller that cannot
// name a stage must drop the sentence that would have named it: "currently at
// school_club" is worse than saying nothing, and a deleted custom section
// leaves current_stage_id pointing at a uuid that belongs in no prompt.
export function defaultStageLabel(id) {
  if (typeof id !== "string" || !id) return null;
  return Object.prototype.hasOwnProperty.call(SPORT_PATHWAY_STAGE_LABELS, id)
    ? SPORT_PATHWAY_STAGE_LABELS[id]
    : null;
}
