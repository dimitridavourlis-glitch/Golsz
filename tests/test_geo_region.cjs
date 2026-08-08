function resolveRegion(country, continent) {
  let region = "default";
  if (country === "CA") region = "ca";
  else if (country === "US") region = "us";
  else if (continent === "EU") region = "eu";
  return region;
}

let failed = 0;
function check(name, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${got}, expected ${expect})`);
}

check("Canada -> ca", resolveRegion("CA", "NA"), "ca");
check("US -> us", resolveRegion("US", "NA"), "us");
check("France (EU continent) -> eu", resolveRegion("FR", "EU"), "eu");
check("Germany (EU continent) -> eu", resolveRegion("DE", "EU"), "eu");
check("UK (EU continent per Vercel's geo header) -> eu", resolveRegion("GB", "EU"), "eu");
check("Japan (Asia) -> default", resolveRegion("JP", "AS"), "default");
check("Brazil (South America) -> default", resolveRegion("BR", "SA"), "default");
check("Missing headers -> default", resolveRegion("", ""), "default");
check("US takes priority over continent if both somehow set", resolveRegion("US", "EU"), "us");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
