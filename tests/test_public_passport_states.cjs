// THE SHARED PASSPORT LINK: WHAT A COACH SEES WHEN THERE IS NOTHING TO SHOW.
//
// PublicPassport is the one screen a coach or university opens without an
// account, and the athlete cannot check it from their side. Three promises:
//   1. a link that resolves to nothing (revoked, banned, deleted, legacy link
//      never made public) says ONE honest thing, "not available", so the
//      message never reveals that an account was banned;
//   2. a failed lookup (network) is a different state with a Try again button,
//      guarded against a double tap, so a bad connection never leaves a coach
//      on the wrong message;
//   3. a field the athlete hid leaves no label behind (no empty "Club: —").
// The server half (migration 158) must keep returning null / blanking fields.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-158-access-hardening.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Same indentation-based extraction as test_audit_ux_fixes.cjs.
function block(src, anchor) {
  let start = src.indexOf(anchor);
  if (start < 0) return null;
  const indent = src.slice(src.lastIndexOf("\n", start) + 1, start);
  if (/\S/.test(indent)) return null;
  const close = new RegExp("\\n" + indent + "\\}(?=\\n|;\\n)", "g");
  close.lastIndex = start;
  const m = close.exec(src);
  return m ? src.slice(start, m.index + m[0].length) : null;
}
const pub = block(APP, "function PublicPassport({ userId, token }) {");
ck("PublicPassport was found", !!pub && pub.length > 500, true);

// ---- the lookup effect, run for real against a fake rpc -------------------
// Lift the effect body and run it with stubbed state setters.
const effStart = pub.indexOf("useEffect(() => {");
const effEnd = pub.indexOf("}, [userId, token, attempt]);");
ck("the effect re-runs on `attempt`", effStart > 0 && effEnd > effStart, true);
const effBody = pub.slice(effStart + "useEffect(() => {".length, effEnd);

async function lookup(rpcResult) {
  const states = [];
  const sb = { rpc: async () => { if (rpcResult instanceof Error) throw rpcResult; return rpcResult; } };
  const retryingRef = { current: true };
  const run = new Function("sb", "userId", "token", "setState", "setP", "retryingRef", "console",
    `${effBody}\nreturn Promise.resolve();`);
  const quiet = { error() {} };
  run(sb, null, "tok", (s) => states.push(s), () => {}, retryingRef, quiet);
  await new Promise((r) => setTimeout(r, 10));
  return { states, retryingRef };
}

(async () => {
  let r = await lookup({ data: null, error: null });
  ck("null data -> unavailable", r.states, ["unavailable"]);
  ck("...and the retry guard is released", r.retryingRef.current, false);
  r = await lookup({ data: { full_name: "A" }, error: null });
  ck("data -> ok", r.states, ["ok"]);
  r = await lookup(new Error("Failed to fetch"));
  ck("thrown error -> error (not unavailable)", r.states, ["error"]);
  r = await lookup({ data: null, error: { message: "boom" } });
  ck("rpc error object -> error", r.states, ["error"]);

  // ---- markup ------------------------------------------------------------
  ck("unavailable state renders the new key", /state === "unavailable"[^\n]*t\("public_passport_unavailable"\)/.test(pub), true);
  ck("error state keeps public_passport_not_found", /state === "error"[\s\S]*?t\("public_passport_not_found"\)/.test(pub), true);
  ck("error state has a Try again control wired to retry",
     /onClick=\{retry\}[^\n]*t\("scout_try_again"\)/.test(pub), true);
  ck("retry ignores a tap while a lookup is running", /if \(retryingRef\.current\) return;/.test(pub), true);
  ck("public_passport_private is no longer rendered", /public_passport_private/.test(pub), false);
  ck("public_passport_private is gone from the app", /public_passport_private/.test(APP), false);
  ck("the Club row is conditional on a value", /\{p\.club_name && <div>[^\n]*t\("passport_club"\)/.test(pub), true);
  ck("the country span is conditional on a value", /\{p\.country && <span[^\n]*flagFor\(p\.country\)/.test(pub), true);
  ck("no unguarded flag/country line left",
     pub.split("\n").filter((l) => /flagFor\(p\.country\)/.test(l) && !/p\.country &&/.test(l)).length, 0);
  ck("<style>{CSS}</style> is still in the component", pub.includes("<style>{CSS}</style>"), true);
  for (const k of ["passport_sport", "passport_grad", "passport_status"]) {
    ck(k + " row keeps the dash fallback", new RegExp(`t\\("${k}"\\)[^\\n]*dash\\(`).test(pub), true);
  }
  ck("handedness row keeps the dash fallback", /prefLabelFor\(p\.sport, t\)[^\n]*dash\(p\.foot\)/.test(pub), true);

  // ---- dictionaries ------------------------------------------------------
  const hits = APP.match(/public_passport_unavailable: "[^"]+"/g) || [];
  ck("the new key exists in all four languages", hits.length, 4);
  ck("every wording is distinct (translated)", new Set(hits).size, 4);
  ck("none mentions a ban", hits.some((h) => /ban|bloqu|απαγορ/i.test(h)), false);

  // ---- the server half (migration 158) -----------------------------------
  const fnSrc = MIG.slice(MIG.indexOf("create or replace function get_public_passport_by_token"));
  const fnBody = fnSrc.slice(0, fnSrc.indexOf("$$;", 30));
  ck("by_token returns null for a banned account", /is_banned\(v_user\) then return null/.test(fnBody), true);
  ck("by_token returns null for a revoked token", /not revoked/.test(fnBody), true);
  ck("by_token blanks club_name behind show_club", /case when a\.show_club then a\.club_name else null end/.test(fnBody), true);
  ck("by_token blanks country behind show_country", /case when a\.show_country then a\.country else null end/.test(fnBody), true);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
