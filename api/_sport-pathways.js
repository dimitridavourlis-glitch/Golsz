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
