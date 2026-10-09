// Runs every scenario in every block and works out savings, mirroring the workbook's
// "Strategy comparison", "DB comparison" and "Roth comparison" sheets.
import { SCENARIOS, BLOCKS, runScenario } from './scenarios.js';
import { normalizeRules } from './rules.js';
import { rothProjection } from './retirement.js';
import { Ledger, money, pct } from './ledger.js';

export function grossIncome(p) {
  return (+p.w2 || 0) + (+p.businessIncome || 0) + (+p.stcg || 0) + (+p.ltcg || 0) + (+p.interest || 0)
    + (+p.qualifiedDividends || 0) + (+p.nonqualifiedDividends || 0) + (+p.otherIncome || 0);
}

/**
 * @returns {{ blocks: {base, db, roth}: { scenarios: {id: result}, baseline }, roth: projection, scenarios }}
 * Each result gets .savings, .effectiveRate and (Roth block) .netAdditionalSavings.
 */
export function runComparison(model, { scenarios = SCENARIOS } = {}) {
  const rules = normalizeRules(model.rules);
  const blocks = {};
  for (const b of BLOCKS) {
    blocks[b.id] = { ...b, scenarios: {} };
    for (const s of scenarios) blocks[b.id].scenarios[s.id] = runScenario(model, b.id, s);
  }
  const baseNone = blocks.base.scenarios.none.rows.totalOutlay;
  const income = grossIncome(model.profile);
  const conversion = +model.roth.conversion || 0;

  // Roth: conversion tax with no strategy, then the PV of taxes if the money stayed in the IRA.
  const conversionTax = blocks.roth.scenarios.none.rows.totalTax - blocks.base.scenarios.none.rows.totalTax;
  const preliminary = rothProjection(model, rules, { conversionTax, strategySavings: 0, strategyLabel: '' });

  const baselines = { base: baseNone, db: baseNone, roth: baseNone + preliminary.pvRmdTax };
  const denominators = { base: income, db: income, roth: income + conversion };
  for (const b of BLOCKS) {
    const blk = blocks[b.id];
    blk.baseline = baselines[b.id];
    for (const s of scenarios) {
      const res = blk.scenarios[s.id];
      res.savings = blk.baseline - res.rows.totalOutlay;
      res.effectiveRate = denominators[b.id] ? res.rows.totalOutlay / denominators[b.id] : 0;
      if (b.id === 'roth') res.netAdditionalSavings = res.savings - blocks.base.scenarios[s.id].savings;
      appendSavings(res, b, blk.baseline, denominators[b.id], b.id === 'roth' ? preliminary.pvRmdTax : 0, blocks.base.scenarios[s.id]);
    }
  }

  // Strategy used for the Roth projection: largest savings in the conversion year (Roth comparison!C12).
  let pick = model.roth.strategyOverride && scenarios.find((s) => s.id === model.roth.strategyOverride || s.label === model.roth.strategyOverride);
  if (!pick) {
    let best = -Infinity;
    for (const s of scenarios) { const v = blocks.roth.scenarios[s.id].savings; if (v > best) { best = v; pick = s; } }
  }
  const roth = rothProjection(model, rules, {
    conversionTax,
    strategySavings: blocks.roth.scenarios[pick.id].netAdditionalSavings,
    strategyLabel: pick.label,
  });
  roth.strategyId = pick.id;
  return { blocks, roth, scenarios, rules, model };
}

function appendSavings(res, block, baseline, denom, pvRmdTax, baseResult) {
  const L = new Ledger();
  L.section('Savings', block.id === 'roth'
    ? 'Compared with not converting: no-planning tax this year plus the present value of tax on future IRA withdrawals'
    : 'Compared with No Planning (no DB contribution, no conversion)');
  if (block.id === 'roth') {
    L.line('No-planning cash outlay without a conversion', baseline - pvRmdTax);
    L.line('Plus present value of future IRA withdrawal tax', pvRmdTax, { excel: 'RMD Simulation!B22' });
  }
  L.line('Baseline cash outlay', baseline, { kind: 'calc' });
  L.line('This scenario\'s cash outlay', res.rows.totalOutlay);
  L.line('Savings', res.savings, { kind: 'total', calc: `${money(baseline)} − ${money(res.rows.totalOutlay)}` });
  L.line('Cash outlay as % of income', res.effectiveRate, { kind: 'info', calc: `${money(res.rows.totalOutlay)} ÷ ${money(denom)} income${block.id === 'roth' ? ' incl. conversion' : ''}` });
  if (block.id === 'roth') L.line('Extra savings vs. the same strategy without a conversion', res.netAdditionalSavings, { kind: 'info', calc: `${money(res.savings)} − ${money(baseResult.savings)}` });
  res.ledger.append(L);
}
