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
  // recompute rather than reason about caching correctness here.
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ region });
}
