// THE APP'S OWN COMPONENTS, RUN IN NODE WITH STAND-IN HOOKS.
//
// Shared by tests/test_scout_limit_path.cjs and tests/test_scout_today_card.cjs
// (AVA job 216). Not a suite: run-all.cjs only runs test_*.cjs.
//
// Every top-level declaration of golsz-app.html's JSX block is compiled when
// first used (as tools/precompile.cjs compiles it) and run in one scope, so
// Scout calls the app's real helpers and child components. Only the browser
// is stood in for: React's hooks (state re-renders at once, mount effects run
// after the first render), and what a suite hands makeScope: Supabase (`sb`),
// the network (`fetch`), useLang. A child component stays an element
// ({ type, props, children }); mount(el.type, el.props) draws it the way React
// would, with its own function and its own props.
const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const babel = require("@babel/standalone");

const APP = require("./_app_source.cjs").appSource();
const open = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
const CODE = APP.slice(open.index + open[0].length, APP.indexOf("</script>", open.index));
if (CODE.length < 100000) throw new Error(`extracted only ${CODE.length} chars: extraction is wrong`);
const DECLS = new Map();
for (const st of parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] }).program.body) {
  if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) DECLS.set(st.id.name, st);
  if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id.type === "Identifier") DECLS.set(d.id.name, st);
}
let CURRENT = null;   // the hook runtime of the component rendering right now
const hook = (k) => (...a) => CURRENT[k](...a);
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  Fragment: "Fragment", Component: class {}, createContext: (v) => ({ v }),
  useState: hook("useState"), useRef: hook("useRef"), useEffect: hook("useEffect"),
};
function makeScope(overrides) {
  const cache = new Map(Object.entries(overrides));
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === "string" && (cache.has(k) || DECLS.has(k) || !(k in globalThis)),
    get: (_, k) => {
      if (typeof k !== "string") return undefined;
      if (cache.has(k)) return cache.get(k);
      if (DECLS.has(k)) {
        const st = DECLS.get(k);
        const js = babel.transform(CODE.slice(st.start, st.end), { presets: ["react"] }).code;
        const v = new Function("__scope", `with (__scope) {\n${js}\n;return ${k};\n}`)(scope);
        cache.set(k, v);
        return v;
      }
      const stub = function () { return null; };
      cache.set(k, stub);
      return stub;
    },
    set: (_, k, v) => { cache.set(k, v); return true; },
  });
  return { get: (k) => scope[k] };
}
function mount(Comp, initialProps) {
  const props = initialProps;
  let i = 0, tree = null;
  const slots = [], effects = [];
  const rt = {
    useState(init) { const k = i++; if (!(k in slots)) slots[k] = { v: typeof init === "function" ? init() : init }; const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === "function" ? v(s.v) : v; render(); }]; },
    useRef(init) { const k = i++; if (!(k in slots)) slots[k] = { current: init }; return slots[k]; },
    useEffect(fn) { const k = i++; if (!(k in slots)) { slots[k] = {}; effects.push(fn); } },
  };
  function render() {
    const prev = CURRENT; CURRENT = rt; i = 0;
    try { tree = Comp(props); } finally { CURRENT = prev; }
    while (effects.length) effects.shift()();
  }
  render();
  const all = (n, pred, out = []) => {
    if (!n || typeof n !== "object") return out;
    if (pred(n)) out.push(n);
    for (const c of n.children || []) all(c, pred, out);
    return out;
  };
  const textOf = (n) => (n.children || []).map((c) => (c == null || typeof c === "boolean" ? "" : typeof c === "object" ? textOf(c) : String(c))).join("");
  return {
    findAll: (pred, within) => all(within || tree, pred),
    find: (pred, within) => all(within || tree, pred)[0] || null,
    byType: (name) => all(tree, (n) => typeof n.type === "function" && n.type.name === name),
    textOf,
    text: () => textOf({ children: [tree] }).trim(),
  };
}
// The real handler awaits a few dozen mocked calls; let every one of them land.
const settle = async () => { for (let k = 0; k < 300; k++) await new Promise((r) => setImmediate(r)); };

module.exports = { APP, CODE, React, makeScope, mount, settle };
