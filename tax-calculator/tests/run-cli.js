// Command-line test runner for macOS JavaScriptCore (see tests/run-cli.sh).
import { runAll } from './harness.js';
import './all.js';

const results = runAll();
let failed = 0, passed = 0;
for (const r of results) {
  passed += r.passed;
  const status = r.failures.length ? 'FAIL' : 'ok  ';
  print(`${status} ${r.name} (${r.passed} checks, ${r.ms} ms)`);
  for (const f of r.failures) { failed++; print(`     ✗ ${f}`); }
}
print(`\n${passed} checks passed, ${failed} failed`);
if (failed) throw new Error(`${failed} test failures`);
