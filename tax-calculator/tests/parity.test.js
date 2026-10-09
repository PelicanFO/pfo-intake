// Two independent implementations must agree: the Excel replica (the workbook's own formulas)
// and the engine with every correction switched off. Checked on the workbook's sample client and
// on randomly generated clients (single/joint, business income, gains, dividends, DB, conversions,
// different strategy assumptions and manual sizing).
//
// Known, documented exceptions (they come from the workbook's mechanics, not the tax rules):
//   • Solar and Solar & Charitable agree to within Excel's iteration step (Excel stops its ±0.01%
//     search near the target; the engine solves the same equation exactly).
//   • LEAP state tax — the workbook reduces Louisiana income by all business income and gains
//     regardless of the K-1 amounts; the engine uses the K-1 amounts (equal when sized at 100%).
//   • Roth conversion tax when there are long-term gains or qualified dividends — the workbook's
//     RMD sheet taxes them as ordinary income when measuring the conversion's tax. This feeds the
//     Roth block's savings only when the projected tax rate is left blank.
//   • A $0 conversion with a blank projected rate — the workbook shows #DIV/0!.
//   • The Roth projection when the best strategy is Solar (Solar sizing, above).
import { suite } from './harness.js';
import data from '../src/excel/workbook-data.js';
import { Workbook } from '../src/excel/workbook.js';
import { applyModel, readGrid } from '../src/excel/mapping.js';
import { defaultModel } from '../src/engine/model.js';
import { runComparison } from '../src/engine/compare.js';
import { ALL_OFF } from '../src/engine/rules.js';

const COMPARED = ['none', 'film', 'solar', 'charitable', 'solarCharitable', 'leap', 'leapCharitable'];
// Excel's Solar loop stops within one ±0.01% step of its target, so Solar values agree to within that step.
const tolFor = (sid, x) => (sid.startsWith('solar') ? Math.max(100, Math.abs(x) * 1e-3) : 0.01);
const ROWS = ['fedOrdinary', 'fedLtcg', 'state', 'contribution', 'savings'];

function compareModel(wb, model, t, tag) {
  applyModel(wb, model);
  const grid = readGrid(wb);
  const m = { ...model, rules: ALL_OFF };
  const eng = runComparison(m);
  let checks = 0;
  const fails = [];
  const p = model.profile;
  const blankRate = model.roth.projectedTaxRate === null;
  const rmdSheetDiffers = blankRate && (p.ltcg || p.qualifiedDividends);
  // Excel's Solar loop only settles when its target is big enough relative to its step size; for
  // small targets it is still far away after thousands of iterations (and Excel only runs 100 per
  // recalc). Those are spreadsheet artifacts, so we only compare Solar where the loop settled.
  const settled = (sheet, b, tgt) => Math.abs(wb.num(`${sheet}!${b}`) - wb.num(`${sheet}!${tgt}`)) <= wb.num(`${sheet}!${tgt}`) * 1.5e-4 + 1;
  const SOLAR_SHEETS = { base: ['Solar', 'Solar & Charitable'], db: ['Solar & DB', 'Solar & Charitable & DB'], roth: ['Solar & Roth', 'Solar & Charitable & Roth'] };
  for (const block of ['base', 'db', 'roth']) {
    if (block === 'roth' && (rmdSheetDiffers || (blankRate && !model.roth.conversion))) continue;
    const solarOk = { solar: settled(SOLAR_SHEETS[block][0], 'E11', 'E5'), solarCharitable: settled(SOLAR_SHEETS[block][1], 'E43', 'E37') };
    for (const sid of COMPARED) {
      if (sid in solarOk && !solarOk[sid]) continue;
      const e = eng.blocks[block].scenarios[sid];
      for (const row of ROWS) {
        const ev = row === 'savings' ? e.savings : e.rows[row];
        const xv = grid[block][sid][row].value;
        checks++;
        if (typeof xv !== 'number' || Math.abs(ev - xv) > tolFor(sid, xv)) fails.push(`${tag} ${block}/${sid}/${row}: engine ${ev?.toFixed?.(2)} vs Excel ${xv} (${grid[block][sid][row].ref})`);
      }
    }
  }
  const x = grid.rothProjection;
  const solarPick = /^Solar/.test(String(x.strategyUsed.value));
  if (!p.ltcg && !p.qualifiedDividends && !(blankRate && !model.roth.conversion)) {
    const pairs = [['conversionTax', eng.roth.conversionTax], ['pvRmdTax', eng.roth.pvRmdTax], ['traditionalAt100', eng.roth.at100.traditionalAfterTax],
      ['rothAt100', eng.roth.at100.roth], ['rothWithSavingsAt100', eng.roth.at100.rothWithSavings], ['strategySavings', eng.roth.strategySavings]];
    for (const [k, ev] of pairs) {
      checks++;
      const tol = solarPick && /Savings/.test(k) ? Math.max(60, Math.abs(x[k].value) * 5e-4) : 0.01;
      if (Math.abs(ev - x[k].value) > tol) fails.push(`${tag} roth/${k}: engine ${ev.toFixed(2)} vs Excel ${x[k].value}`);
    }
  }
  t.ok(fails.length === 0, `${fails.length} differences:\n  ${fails.slice(0, 12).join('\n  ')}`);
  return checks;
}

// Small deterministic random generator so failures are reproducible.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

export function randomModel(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const amt = (max, p = 0.6) => (r() < p ? Math.round(r() * max / 100) * 100 : 0);
  const m = defaultModel();
  const biz = amt(600000, 0.5);
  Object.assign(m.profile, {
    filingStatus: pick(['mfj', 'single']),
    w2: amt(900000, 0.9), businessIncome: biz, stcg: amt(60000, 0.3), ltcg: amt(400000, 0.5),
    interest: amt(50000, 0.4), qualifiedDividends: amt(60000, 0.4), nonqualifiedDividends: amt(20000, 0.3),
    planningFee: pick([0, 0, 5000, 12500]), age: 50 + Math.floor(r() * 20),
  });
  m.db.contribution = biz ? Math.round(biz * r() * 0.5 / 100) * 100 : 0;
  Object.assign(m.roth, {
    conversion: amt(700000, 0.9), retirementAge: 60 + Math.floor(r() * 10), minWithdrawalRate: pick([0.03, 0.04, 0.05]),
    projectedTaxRate: pick([0.35, 0.3, null]), discountRate: pick([0.05, 0.07]),
  });
  m.params.film = { offsetPct: pick([1, 0.8, 0.5]), multiple: pick([4.75, 4, 5.5]), riaDiscount: pick([0, 0.1]) };
  m.params.charitable = { ...m.params.charitable, offsetPct: pick([0.5, 0.3, 0.6]), multiple: pick([5, 4]), riaDiscount: pick([0, 0.05]) };
  m.params.leap = { ...m.params.leap, incomeMultiple: pick([8, 6]), cgMultiple: pick([10, 7]), adminFeePct: pick([0.05, 0.04]), investIncomePct: pick([0.6, 0.5]) };
  m.sizing = { base: {}, db: {}, roth: {} };
  for (const b of ['base', 'db', 'roth']) {
    const choice = pick(['auto', 'fill', 'manual']);
    if (choice === 'fill') m.sizing[b].film = { film: { offset: { fillToBracket: pick([0.12, 0.22, 0.24]) } } };
    if (choice === 'manual') m.sizing[b].film = { film: { offset: amt(300000, 1) } };
    if (r() < 0.3) m.sizing[b].charitable = { charitable: { donation: amt(150000, 1) } };
  }
  return m;
}

suite('Parity: engine (corrections off) = Excel replica, workbook sample client', (t) => {
  const wb = new Workbook(data);
  const n = compareModel(wb, defaultModel(), t, 'sample');
  t.ok(n > 70, `compared ${n} values`);
});

suite('Parity: the workbook\'s LEAP input (business income − $100,800) differs only by its state-tax shortcut', (t) => {
  const wb = new Workbook(data);
  const m = defaultModel();
  m.sizing.base.leap = { leap: { incomeLoss: -100800 } }; // as typed in Strategy comparison!K18 for this client
  applyModel(wb, m);
  const x = readGrid(wb).base.leap;
  const e = runComparison({ ...m, rules: ALL_OFF }).blocks.base.scenarios.leap;
  t.close(e.rows.fedOrdinary, x.fedOrdinary.value, 0.01, 'federal tax matches (the −$100,800 "loss" adds income)');
  t.close(e.rows.contribution, x.contribution.value, 0.01, 'contribution matches (negative, as in the workbook)');
  // The workbook's LEAP state tax subtracts business income + gains (here $0) instead of the K-1,
  // so it ignores the extra $100,800; the engine taxes it: 3% × 100,800 = $3,024.
  t.close(e.rows.state - x.state.value, 3024, 0.01, 'state differs by exactly 3% × $100,800');
});

suite('Parity: engine (corrections off) = Excel replica, 60 random clients', (t) => {
  const wb = new Workbook(data);
  let n = 0;
  for (let seed = 1; seed <= 60; seed++) n += compareModel(wb, randomModel(seed), t, `seed ${seed}`);
  t.ok(n > 4000, `compared ${n} values`);
});
