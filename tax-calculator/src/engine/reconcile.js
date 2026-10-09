// Walks from the spreadsheet's answer to the corrected answer one step at a time:
//   Excel workbook → engine with every correction off (differences = spreadsheet mechanics,
//   e.g. Solar's iterative sizing) → each correction switched on in turn → corrected result.
// The steps add up exactly, so every dollar of difference is accounted for.
import { CORRECTIONS, ALL_OFF } from './rules.js';
import { runScenario, scenarioById } from './scenarios.js';
import { rothProjection } from './retirement.js';
import { cloneModel } from './model.js';

/** Savings and total tax for one scenario in one block under a given rule set. */
export function scenarioOutcome(model, blockId, scenario, rules) {
  const m = cloneModel(model);
  m.rules = rules;
  const res = runScenario(m, blockId, scenario);
  const none = scenarioById('none');
  const baseNone = runScenario(m, 'base', none);
  let baseline = baseNone.rows.totalOutlay;
  if (blockId === 'roth') {
    const rothNone = scenario.id === 'none' ? res : runScenario(m, 'roth', none);
    const conversionTax = rothNone.rows.totalTax - baseNone.rows.totalTax;
    baseline += rothProjection(m, rules, { conversionTax, strategySavings: 0, strategyLabel: '' }).pvRmdTax;
  }
  return { savings: baseline - res.rows.totalOutlay, totalTax: res.rows.totalTax, totalOutlay: res.rows.totalOutlay };
}

/**
 * @param excel { savings, totalTax } read from the Excel replica (totalTax = fed + LTCG + state rows)
 * @returns { steps: [{ id, label, savings, delta, detail }], excel, corrected }
 */
export function reconcile(model, blockId, scenarioId, excel) {
  const scenario = scenarioById(scenarioId);
  const steps = [];
  let rules = { ...ALL_OFF };
  let prev = scenarioOutcome(model, blockId, scenario, rules);
  if (excel) {
    steps.push({ id: 'excel', label: 'Excel workbook', savings: excel.savings, delta: null });
    steps.push({
      id: 'mechanics', label: 'Spreadsheet mechanics', savings: prev.savings, delta: prev.savings - excel.savings,
      detail: 'Same simplified tax rules, calculated directly. Differences come from the workbook\'s own mechanics: Solar\'s iterative sizing and its double-counted state benefit, LEAP\'s state-tax shortcut, and similar.',
    });
  } else {
    steps.push({ id: 'simplified', label: 'Simplified rules (all corrections off)', savings: prev.savings, delta: null });
  }
  for (const c of CORRECTIONS) {
    rules = { ...rules, [c.id]: true };
    const cur = scenarioOutcome(model, blockId, scenario, rules);
    steps.push({ id: c.id, label: c.label, savings: cur.savings, delta: cur.savings - prev.savings, detail: c.law, taxDelta: cur.totalTax - prev.totalTax });
    prev = cur;
  }
  return { steps, excel, corrected: prev };
}
