#!/usr/bin/env node
// STOP SERVING THE REPO'S WORKING PAPERS ON THE PRODUCT DOMAIN.
//
// vercel.json sets outputDirectory to ".", so every file in the checkout was a
// public URL: CLAUDE.md, AGENTS.md, AI_HANDOFF.md, every supabase-migration
// file, supabase-schema.sql, tests/, tools/, golsz-guard/, .github/ and
// .claude/ (verified live 2026-10-22). The repository is public, so nothing
// secret was exposed, but none of it is part of the product: it hands anyone
// on golsz.com a map of the database and of the internal process, and it puts
// planning documents next to the pages a search engine indexes.
//
// WHY A BUILD STEP AND NOT .vercelignore. .vercelignore keeps files out of the
// upload, and the gate (`npm run check`) runs INSIDE the Vercel build and
// reads supabase-schema.sql, the migrations, vercel.json, tests/ and tools/.
// Ignoring them would turn the gate red or, worse, make suites that cannot
// find a file pass vacuously. This runs last, after the gate has passed, on a
// throwaway checkout, exactly like tools/strip-jsx.cjs.
//
// WHAT IT NEVER TOUCHES: api/. Vercel builds the serverless functions from
// those files after buildCommand finishes, so deleting them here would delete
// the backend. (api/*.js is therefore still readable as a static file; that
// source is public in the repo anyway.) It also leaves package.json and
// package-lock.json, which the function build reads.
//
// A DENYLIST, ON PURPOSE. An allowlist that misses one file the site needs
// breaks production silently; a denylist that misses one internal file leaves
// today's exposure in place. tests/test_unpublish_internal.cjs scans every
// served page for references to what is removed and fails if any exist.
//
// SAFETY: with no argument it refuses to run unless VERCEL=1, so
// `npm run unpublish` in a working checkout deletes nothing. The suite passes
// an explicit temp directory instead.
//
// Usage: node tools/unpublish-internal.cjs [rootDir]

const fs = require("fs");
const path = require("path");

const ARG = process.argv[2];
if (!ARG && process.env.VERCEL !== "1") {
  console.error("unpublish-internal: refusing to run outside a Vercel build (VERCEL is not 1).\n" +
    "It deletes files from the working tree. Pass an explicit directory to run it elsewhere.");
  process.exit(1);
}
const ROOT = path.resolve(ARG || path.join(__dirname, ".."));

const INTERNAL_DIRS = ["tests", "tools", "golsz-guard", ".github", ".claude"];
const isInternalFile = (name) =>
  /\.md$/i.test(name) ||
  name === "opencode.json" ||
  /^supabase-.*\.sql$/.test(name);

const removed = [];
for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name);
  const st = fs.lstatSync(full);
  if (st.isDirectory() && INTERNAL_DIRS.includes(name)) {
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(name + "/");
  } else if (st.isFile() && isInternalFile(name)) {
    fs.rmSync(full, { force: true });
    removed.push(name);
  }
}

console.log(removed.length
  ? `unpublish-internal: removed ${removed.length} internal path(s) from the served tree.`
  : "unpublish-internal: nothing to do (already removed).");
