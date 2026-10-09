// Proves the JavaScript replica recalculates the workbook exactly as Excel last did:
// every one of the workbook's formula cells is recalculated from scratch and compared with
// the value Excel saved in the file.
import { suite } from './harness.js';
import data from '../src/excel/workbook-data.js';
import cached from './fixtures/workbook-cached.js';
import { Workbook } from '../src/excel/workbook.js';
import { isError } from '../src/excel/formula.js';

// Cells inside the Solar sizing loop (Excel iterative calculation). Excel saves a snapshot taken
// part-way through its ± step search, and the saved loop cells are not even consistent with each
// other (e.g. saved Project Cost × 36% ≠ saved Equity Contribution). So for those cells, and the
// summary cells fed by them, we allow a small difference and separately check that our result
// satisfies the loop's own stopping rule.
const LOOP_SHEETS = /^Solar/;
const LOOP_DOWNSTREAM = /^(Strategy comparison|DB comparison|Roth comparison|RMD Simulation)!/;
const loopTolerance = (expected) => Math.max(150, Math.abs(expected) * 5e-4);

export function compareWithCached(wb, t) {
  let checked = 0;
  const mismatches = [];
  for (const [ref, expected] of Object.entries(cached)) {
    const actual = wb.get(ref);
    checked++;
    if (expected && typeof expected === 'object' && expected.error) {
      if (!(isError(actual) && actual.code === expected.error)) mismatches.push(`${ref}: expected ${expected.error}, got ${actual}`);
      continue;
    }
    if (typeof expected === 'number') {
      const tol = Math.max(1e-6, Math.abs(expected) * 1e-9);
      if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) continue;
      mismatches.push({ ref, expected, actual });
      continue;
    }
    const norm = (v) => (v === null || v === undefined ? '' : v);
    if (norm(actual) !== norm(expected)) mismatches.push(`${ref}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return { checked, mismatches };
}

suite('Excel replica: every formula cell matches the values saved in the workbook', (t) => {
  const wb = new Workbook(data);
  const { checked, mismatches } = compareWithCached(wb, t);
  t.ok(checked > 7000, `expected to check >7000 cells, checked ${checked}`);
  const loop = [], hard = [];
  for (const m of mismatches) {
    const near = typeof m === 'object' && typeof m.actual === 'number' && Math.abs(m.actual - m.expected) <= loopTolerance(m.expected);
    if (near && (LOOP_SHEETS.test(m.ref) || LOOP_DOWNSTREAM.test(m.ref))) loop.push(m); else hard.push(m);
  }
  t.ok(hard.length === 0, `${hard.length} cells differ from Excel:\n  ` + hard.slice(0, 25)
    .map((m) => (typeof m === 'string' ? m : `${m.ref}: expected ${m.expected}, got ${m.actual}`)).join('\n  '));
  const worst = loop.reduce((w, m) => Math.max(w, Math.abs(m.actual - m.expected)), 0);
  t.ok(true, `checked ${checked} cells: ${checked - mismatches.length} exact, ${loop.length} Solar-loop cells within tolerance (largest gap $${worst.toFixed(2)})`);
  for (const k of ['Strategy comparison!F10', 'Strategy comparison!G11', 'Strategy comparison!I11', 'Strategy comparison!L11', 'DB comparison!F33', 'Roth comparison!G43', 'RMD Simulation!B22'])
    t.close(wb.num(k), cached[k], 1e-6, `${k} exact`);
});

suite('Excel replica: Solar sizing loops settle where the workbook formula says they should', (t) => {
  const wb = new Workbook(data);
  const loops = [
    ['Solar', 'E11', 'E5'], ['Solar & DB', 'E11', 'E5'], ['Solar & Roth', 'E11', 'E5'],
    ['Solar & Charitable', 'E43', 'E37'], ['Solar & Charitable & DB', 'E43', 'E37'], ['Solar & Charitable & Roth', 'E43', 'E37'],
  ];
  for (const [sheet, benefit, target] of loops) {
    const b = wb.num(`${sheet}!${benefit}`), tgt = wb.num(`${sheet}!${target}`);
    // The formula steps the contribution by 0.01% of the target once within $10,000, so it settles
    // within about one step (times the ~1.3 benefit-per-dollar slope) of the target.
    t.ok(Math.abs(b - tgt) <= 0.0001 * tgt * 1.5 + 1, `${sheet}: benefit ${b.toFixed(2)} vs target ${tgt.toFixed(2)}`);
  }
});
