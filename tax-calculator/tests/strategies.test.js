// Strategy behavior in the corrected engine, the reconciliation walk, and the Roth projection.
import { suite } from './harness.js';
import data from '../src/excel/workbook-data.js';
import { defaultModel, cloneModel } from '../src/engine/model.js';
import { runScenario, scenarioById } from '../src/engine/scenarios.js';
import { runComparison } from '../src/engine/compare.js';
import { reconcile } from '../src/engine/reconcile.js';
import { ALL_ON, ALL_OFF, CORRECTIONS } from '../src/engine/rules.js';
import { UNIFORM_LIFETIME, rmdStartAge } from '../src/tables/federal.js';
import { Workbook } from '../src/excel/workbook.js';
import { applyModel, readGrid } from '../src/excel/mapping.js';

const run = (m, block, id) => runScenario(m, block, scenarioById(id));

suite('Strategies: Solar is sized so the credit exactly uses the allowed tax', (t) => {
  for (const rules of [ALL_ON, ALL_OFF]) {
    const m = { ...defaultModel(), rules };
    const r = run(m, 'base', 'solar');
    const ret = r.return;
    const limit = rules.creditLimit ? ret.regularTax + ret.amt - 0.25 * Math.max(0, ret.regularTax - 25000) : ret.regularTax + ret.amt;
    t.close(ret.creditAllowed, limit, 0.05, `credit used = limit (${rules === ALL_ON ? 'corrected' : 'spreadsheet rules'})`);
    t.close(ret.carryforwards.credit, 0, 0.05, 'no unused credit');
  }
  const m = defaultModel();
  m.sizing.base.solar = { solar: { contribution: 100000 } };
  const big = run(m, 'base', 'solar');
  t.ok(big.return.carryforwards.credit > 1000 && big.warnings.some((w) => /credit/.test(w)), 'oversized manual contribution leaves unused credit and warns');
});

suite('Strategies: fill-to-bracket sizing and negative amounts', (t) => {
  const m = defaultModel(); // Film: fill the 12% bracket
  m.profile.age = 50;
  const r = run(m, 'base', 'film');
  t.close(r.return.taxableIncome, 100800, 0.01, 'Film brings taxable income to the top of the 12% bracket');
  const m2 = defaultModel();
  m2.sizing.base.leap = { leap: { incomeLoss: -100800 } };
  const clamped = run(m2, 'base', 'leap');
  t.close(clamped.rows.contribution, 0, 0.001, 'negative LEAP input is set to $0 when the fix is on');
  t.ok(clamped.warnings.some((w) => /negative/.test(w)), 'and flagged');
  const off = run({ ...m2, rules: { ...ALL_ON, clampNegative: false } }, 'base', 'leap');
  t.close(off.rows.contribution, -17640, 0.01, 'spreadsheet behavior when the fix is off (Strategy comparison!K7)');
});

suite('Strategies: Charitable over the 30% limit carries forward', (t) => {
  const r = run(defaultModel(), 'base', 'charitable');
  // 50% × 400,000 = 200,000 gift; 30% limit = 120,000 → 80,000 carries forward.
  t.close(r.return.carryforwards.charitable, 80000, 0.01, 'carryforward');
  t.ok(r.warnings.some((w) => /carries forward/.test(w)), 'warned');
});

suite('Reconciliation: steps add up from the workbook to the corrected answer', (t) => {
  const wb = new Workbook(data);
  const m = defaultModel();
  applyModel(wb, m);
  const grid = readGrid(wb);
  for (const [block, sid] of [['base', 'film'], ['base', 'solar'], ['db', 'charitable'], ['roth', 'film']]) {
    const x = grid[block][sid];
    const rec = reconcile(m, block, sid, { savings: x.savings.value });
    const total = rec.steps.slice(1).reduce((s, st) => s + st.delta, 0);
    t.close(rec.excel.savings + total, rec.corrected.savings, 0.01, `${block}/${sid}: Excel + steps = corrected`);
    t.equal(rec.steps.length, CORRECTIONS.length + 2, `${block}/${sid}: one step per correction`);
    const full = runComparison(m).blocks[block].scenarios[sid].savings;
    t.close(rec.corrected.savings, full, 0.01, `${block}/${sid}: matches the comparison`);
  }
});

suite('Roth projection: RMD table and start age', (t) => {
  // The workbook's RMD % column (RMD Simulation!Q41:Q68, ages 73–100) is 1 ÷ the IRS Uniform Lifetime Table.
  const q = data.sheets['RMD Simulation'];
  for (let age = 73; age <= 100; age++) t.close(q[`Q${age - 32}`], 1 / UNIFORM_LIFETIME[age], 1e-12, `RMD % at ${age}`);
  t.equal(rmdStartAge(1955), 73, 'born 1955 → 73');
  t.equal(rmdStartAge(1961), 75, 'born 1961 → 75');
  // With every withdrawal taxed at 35% and growth = discount rate, the PV of the taxes is 35% of the
  // balance: 0.35 × 450,000 = 157,500 when the first year is included (the workbook leaves out
  // the first year's 6,300 → 151,200).
  t.close(runComparison(defaultModel()).roth.pvRmdTax, 157500, 0.01, 'corrected PV');
  t.close(runComparison({ ...defaultModel(), rules: ALL_OFF }).roth.pvRmdTax, 151200, 0.01, 'spreadsheet PV');
});
