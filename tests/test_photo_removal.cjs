// "REMOVE PHOTO" HAS TO REMOVE THE PHOTO.
//
// removeAvatar() cleared profiles.avatar_url and stopped, under a comment
// calling that harmless because the file is "never linked from anywhere once
// the column is cleared". That reasons about LINKING; the question is
// RETRIEVAL. The avatars bucket is public — the upload path takes its URL
// from getPublicUrl() — so the object stayed fetchable at a stable address by
// anyone who had ever seen it, indefinitely. An athlete who takes their photo
// down had not taken it down, and on this platform that athlete may be
// fifteen.
//
// The same gap applied on every CHANGE of photo: each upload wrote a fresh
// timestamped key and left the previous one public for ever.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the path extractor, run on real and hostile input --------------------
const at = APP.indexOf("function avatarPathFromUrl(");
ck("avatarPathFromUrl exists", at > 0, true);
const pathOf = new Function(APP.slice(at, APP.indexOf("\n}", at) + 2) + " return avatarPathFromUrl;")();

const UID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
ck("a real public avatar URL yields its object key",
   pathOf(`https://x.supabase.co/storage/v1/object/public/avatars/${UID}/1730000000000.jpg`),
   `${UID}/1730000000000.jpg`);
ck("...and a query string is not part of the key",
   pathOf(`https://x.supabase.co/storage/v1/object/public/avatars/${UID}/a.jpg?width=200`),
   `${UID}/a.jpg`);
// THE REASON IT IS SHAPE-CHECKED. avatar_url is a column; a row holding an
// externally hosted or hand-edited value must never be turned into a delete
// call against a path derived from someone else's string.
ck("an avatar hosted somewhere else yields nothing",
   pathOf("https://cdn.example.com/avatars/someone-else.jpg"), null);
ck("a URL with no avatars segment yields nothing",
   pathOf("https://x.supabase.co/storage/v1/object/public/post-images/a/b.jpg"), null);
ck("a traversal attempt does not survive the shape check",
   pathOf("https://x.supabase.co/storage/v1/object/public/avatars/../../secret.jpg"), null);
ck("a deeper path than uid/file yields nothing",
   pathOf(`https://x.supabase.co/storage/v1/object/public/avatars/${UID}/sub/a.jpg`), null);
ck("empty and non-string inputs are null, not a crash",
   [pathOf(""), pathOf(null), pathOf(undefined), pathOf(42)], [null, null, null, null]);

// ---- the object is actually deleted ---------------------------------------
const rm = APP.slice(APP.indexOf("  async function removeAvatar() {"), APP.indexOf("\n  }", APP.indexOf("  async function removeAvatar() {")));
ck("removing the photo removes the object too",
   /sb\.storage\.from\("avatars"\)\.remove\(\[gone\]\)/.test(rm), true);
// Column first, object second: a failed delete leaves the photo already off
// their Passport and the path still derivable for the next attempt, where the
// reverse order can leave a live URL pointing at nothing.
ck("...after the column is cleared, not before",
   rm.indexOf("avatar_url: null") < rm.indexOf('remove([gone])'), true);
// "Removed" must not be said about a file that is still there.
ck("...and a failed delete is surfaced, not swallowed",
   /if \(rmErr\) throw rmErr;/.test(rm), true);

// ---- and the one being replaced -------------------------------------------
const up = APP.slice(APP.indexOf("        const ext = (file.name.split"), APP.indexOf("      } catch (err) {", APP.indexOf("        const ext = (file.name.split")));
ck("changing the photo deletes the outgoing one",
   /sb\.storage\.from\("avatars"\)\.remove\(\[previous\]\)/.test(up), true);
ck("...guarded against deleting the file just written",
   /if \(previous && previous !== path\)/.test(up), true);
// The new photo IS saved by that point, so a failed cleanup must not tell the
// athlete their upload failed.
ck("...and a failed cleanup does not fail the upload",
   /if \(rmErr\) console\.error\("GOLSZ previous avatar not removed:", rmErr\);/.test(up), true);

// ---- the load-failure banner clears when a read succeeds -------------------
// Each of these effects re-runs on its own props (viewUserId, manageId,
// reloadKey), so a failure on one athlete left the error standing over the
// next one's correctly loaded list, with a Try again button offering to
// reload data that was never wrong.
ck("every loadFailed reader clears the flag where the read starts",
   (APP.match(/\(async \(\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*setLoadFailed\(false\);/g) || []).length, 5);
ck("...and there are exactly five such readers",
   (APP.match(/setLoadFailed\(true\); \}/g) || []).length, 5);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
