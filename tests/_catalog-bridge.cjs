// api/_plan-catalog.js is an ES module (package.json declares "type":
// "module") and the suites are CommonJS. Rather than convert either side,
// this strips the export statement and evaluates the module body in a CJS
// context — so the tests exercise the real file, not a copy.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "api", "_plan-catalog.js"), "utf8");
const body = src.slice(0, src.indexOf("export {"));
module.exports = eval(body + `({
  PLAN_CATALOG, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, PLAN_PRICING, VALID_PLANS, identifyPlan,
  validateConfiguration, resolvePlanFromStripe, readPriceFields,
  stripeCatalogConfigured, configuredPriceId,
})`);
