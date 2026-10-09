// Minimal test harness that runs both in the browser (tests/index.html) and on the command line
// with macOS's built-in JavaScriptCore (tests/run-cli.sh) — no Node or npm required.

const suites = [];
export function suite(name, fn) { suites.push({ name, fn }); }

class Ctx {
  constructor() { this.passed = 0; this.failures = []; }
  ok(cond, msg) { if (cond) this.passed++; else this.failures.push(msg); }
  equal(actual, expected, msg) {
    this.ok(actual === expected, `${msg}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
  close(actual, expected, tol, msg) {
    const good = typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) <= tol;
    this.ok(good, `${msg}: expected ${fmt(expected)} ± ${tol}, got ${fmt(actual)}`);
  }
}
const fmt = (v) => (typeof v === 'number' ? (Math.round(v * 100) / 100).toLocaleString('en-US') : JSON.stringify(v));

export function runAll() {
  const results = [];
  for (const s of suites) {
    const t = new Ctx();
    const started = Date.now();
    try { s.fn(t); } catch (e) { t.failures.push(`threw: ${e && e.stack || e}`); }
    results.push({ name: s.name, passed: t.passed, failures: t.failures, ms: Date.now() - started });
  }
  return results;
}
