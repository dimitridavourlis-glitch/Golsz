// ============================================================
// GOLSZ — Visitor region lookup (marketing homepage hero variant)
// Deploy target: /api/geo.js
//
// Reads Vercel's own edge-injected geolocation headers (no third-party
// IP-lookup service, no client-side geo API, no IP address ever leaves
// Vercel's network) to tell the homepage which regional hero image to
// show: Canada, the US, Europe, or a default for everywhere else.
// x-vercel-ip-country / x-vercel-ip-continent are documented, stable
// Vercel platform headers, available on every deployment automatically —
// see https://vercel.com/docs/headers/request-headers.
//
// ALSO reports the deployed build's commit SHA. That does not belong in a
// geo endpoint and it is here for an unglamorous reason: the Hobby plan
// caps a deployment at 12 Serverless Functions and this project is at 12.
// A dedicated /api/version was written, rejected at deploy time, and folded
// in here rather than dropping something else.
//
// The version matters because golsz-app.html is a single hand-edited file
// with no build step, so there is nothing to fingerprint and no cache to
// bust: a returning athlete can run cached JavaScript against an API that
// has moved on indefinitely. That was observed in the wild on 2026-08-08 —
// a tab still rendering a label removed hours earlier — and old client
// against new server is the shape of that day's outages. The client
// remembers the value it first saw and offers a refresh when it changes.
//
// This is the right endpoint to overload if any is: the app already calls
// it, and it is cheap and unauthenticated. If the function budget ever
// frees up, split it back out.
// ============================================================

export default function handler(req, res) {
  const country = req.headers["x-vercel-ip-country"] || "";
  const continent = req.headers["x-vercel-ip-continent"] || "";

  let region = "default";
  if (country === "CA") region = "ca";
  else if (country === "US") region = "us";
  else if (continent === "EU") region = "eu";

  // Short cache — geo headers are per-request/per-edge-node, and a visitor's
  // region never changes mid-session, but this is cheap enough to just
  // recompute rather than reason about caching correctness here. no-store
  // is also required for the version field below: a cached version check is
  // a contradiction in terms.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json({
    region,
    version: String(
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev"
    ).slice(0, 12),
  });
}
