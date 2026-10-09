// Connects the calculator's inputs (the model) to the workbook's yellow cells, and reads the
// workbook's comparison tables back in the same shape the engine produces.
import { STRATEGIES } from '../strategies/index.js';
import { federalTables } from '../tables/federal.js';
import { bracketTop } from '../engine/brackets.js';

export const COLUMNS = { none: 'F', film: 'G', solar: 'H', charitable: 'I', solarCharitable: 'J', leap: 'K', leapCharitable: 'L' };

const SHEETS = {
  film: ['Film', 'Film & DB', 'Film & Roth'],
  charitable: ['Charitable', 'Charitable & DB', 'Charitable & Roth'],
  solar: ['Solar', 'Solar & DB', 'Solar & Roth'],
  solarCharitable: ['Solar & Charitable', 'Solar & Charitable & DB', 'Solar & Charitable & Roth'],
  leap: ['LEAP', 'LEAP & DB', 'LEAP & Roth'],
  leapCharitable: ['LEAP & Charitable', 'LEAP & Charitable & DB', 'LEAP & Charitable & Roth'],
};

// Where each strategy's assumptions live on each sheet family.
const PARAM_CELLS = {
  film: { film: { offsetPct: 'D4', multiple: 'D7', riaDiscount: 'D12' } },
  charitable: { charitable: { offsetPct: 'D4', multiple: 'D7', riaDiscount: 'D12' } },
  solar: { solar: { equityPct: 'C16', creditPct: 'C17' } },
  solarCharitable: { charitable: { offsetPct: 'D7', multiple: 'D10', riaDiscount: 'D15' }, solar: { equityPct: 'C47', creditPct: 'C48' } },
  leap: { leap: { incomePct: 'D6', cgPct: 'E6', incomeMultiple: 'D9', cgMultiple: 'E9' } },
  leapCharitable: { leap: { incomePct: 'D6', cgPct: 'E6', incomeMultiple: 'D9', cgMultiple: 'E9' }, charitable: { offsetPct: 'D45', multiple: 'D48', riaDiscount: 'D53' } },
};
// Percentages the workbook hard-codes inside formulas; rewritten only if changed from the default.
const LEAP_FORMULA_PARAMS = {
  adminFeePct: ['D14', (x) => `=C23*${x}`], sopFeePct: ['E14', (x) => `=C24*${x}`],
  investIncomePct: ['D20', (x) => `=D12*${x}`], investCgPct: ['E20', (x) => `=E12*${x}`],
};

// Manual sizing inputs: block → scenario → strategy → field → cell.
const SIZING_CELLS = (() => {
  const sheet = { base: 'Strategy comparison', db: 'DB comparison', roth: 'Roth comparison' };
  const rows = { base: [18, 20, 22], db: [5, 7, 9], roth: [5, 7, 9] };
  const out = {};
  for (const b of ['base', 'db', 'roth']) {
    const [r1, r2, r3] = rows[b];
    const c = (col, row) => `${sheet[b]}!${col}${row}`;
    out[b] = {
      film: { film: { offset: c('G', r1) } },
      solar: { solar: { contribution: c('H', r1) } },
      charitable: { charitable: { donation: c('I', r1) } },
      solarCharitable: { charitable: { donation: c('J', r1) }, solar: { contribution: c('J', r2) } },
      leap: { leap: { incomeLoss: c('K', r1), cgLoss: c('K', r2) } },
      leapCharitable: { leap: { incomeLoss: c('L', r1), cgLoss: c('L', r2) }, charitable: { donation: c('L', r3) } },
    };
  }
  return out;
})();

const FILING = { mfj: 'Married-Joint', single: 'Single', hoh: 'Single' };

/** Workbook cell values for a model. Returns { values: {ref: value}, warnings: [] }. */
export function modelToCells(model) {
  const p = model.profile, warnings = [];
  const v = {};
  if (p.filingStatus === 'hoh') warnings.push('The workbook has no head-of-household tables; the Excel replica uses Single.');
  if (p.state !== 'LA') warnings.push('The workbook only models Louisiana; the Excel replica still uses Louisiana\'s 3%.');
  Object.assign(v, {
    'Strategy comparison!C4': FILING[p.filingStatus],
    'Strategy comparison!C5': +p.w2 || 0,
    'Strategy comparison!C6': +p.businessIncome || null,
    'Strategy comparison!C7': +p.stcg || null,
    'Strategy comparison!C8': +p.ltcg || null,
    'Strategy comparison!C9': +p.interest || null,
    'Strategy comparison!C10': +p.qualifiedDividends || null,
    'Strategy comparison!C11': +p.nonqualifiedDividends || null,
    'Strategy comparison!C12': +p.planningFee || null,
    'DB comparison!C2': +model.db.contribution || null,
    'Roth comparison!C2': +model.roth.conversion || 0,
    'Roth comparison!C3': +p.age || 0,
    'Roth comparison!C4': +model.roth.retirementAge || 0,
    'Roth comparison!C5': +model.roth.minWithdrawalRate || 0,
    'Roth comparison!C7': model.roth.projectedTaxRate === null || model.roth.projectedTaxRate === '' ? null : +model.roth.projectedTaxRate,
    'Roth comparison!C9': +model.roth.discountRate || 0,
    'Roth comparison!C11': model.roth.strategyOverride ? labelOf(model.roth.strategyOverride) : null,
  });

  for (const [family, perStrategy] of Object.entries(PARAM_CELLS)) {
    for (const [sid, cells] of Object.entries(perStrategy)) {
      const params = { ...defaults(sid), ...(model.params?.[sid] || {}) };
      for (const sheet of SHEETS[family]) for (const [k, addr] of Object.entries(cells)) v[`${sheet}!${addr}`] = params[k];
      if (sid === 'leap') {
        const d = defaults('leap');
        for (const [k, [addr, f]] of Object.entries(LEAP_FORMULA_PARAMS)) {
          if (params[k] !== d[k]) for (const sheet of SHEETS[family]) v[`${sheet}!${addr}`] = f(params[k]);
        }
      }
    }
  }
  if (model.params?.charitable?.giftType === 'cash') warnings.push('Gift type only matters for the corrected deduction limits; the workbook has no limits.');

  const T = federalTables(model.year);
  const top = (rate) => bracketTop(T.ordinaryBrackets[p.filingStatus === 'mfj' ? 'mfj' : 'single'], rate);
  const incomeSum = { base: "SUM('Strategy comparison'!C5:C11)", db: "SUM('Strategy comparison'!C5:C11)-'DB comparison'!C2", roth: "SUM('Strategy comparison'!C5:C11)+'Roth comparison'!C2" };
  for (const [block, scen] of Object.entries(SIZING_CELLS)) {
    for (const [sc, perStrategy] of Object.entries(scen)) {
      for (const [sid, fields] of Object.entries(perStrategy)) {
        for (const [field, ref] of Object.entries(fields)) {
          const spec = model.sizing?.[block]?.[sc]?.[sid]?.[field];
          if (spec === undefined || spec === null || spec === '') v[ref] = null;
          else if (typeof spec === 'number') v[ref] = spec;
          else if (spec.fillToBracket) {
            if (sc === 'film' || sc === 'charitable') v[ref] = `=${incomeSum[block]}-${top(spec.fillToBracket)}`;
            else { v[ref] = null; warnings.push(`"Fill bracket" sizing for ${sc} has no workbook equivalent; the replica uses its default.`); }
          }
        }
      }
    }
  }
  return { values: v, warnings };
}

function defaults(sid) { return Object.fromEntries(STRATEGIES[sid].params.map((p) => [p.key, p.default])); }
function labelOf(id) {
  return { none: 'No Planning ', film: 'Film', solar: 'Solar', charitable: 'Charitable', solarCharitable: 'Solar & Charitable', leap: 'LEAP', leapCharitable: 'LEAP & Charitable' }[id] || id;
}

/** Push a model into a Workbook replica. */
export function applyModel(wb, model) {
  const { values, warnings } = modelToCells(model);
  wb.reset();
  wb.setMany(values);
  return warnings;
}

const ROWS = {
  base: { sheet: 'Strategy comparison', fedOrdinary: 4, fedLtcg: 5, state: 6, contribution: 7, investmentAccount: 8, fee: 9, totalOutlay: 10, savings: 11, effectiveRate: 12 },
  db: { sheet: 'DB comparison', retirementContribution: 25, fedOrdinary: 26, fedLtcg: 27, state: 28, contribution: 29, investmentAccount: 30, fee: 31, totalOutlay: 32, savings: 33, effectiveRate: 34 },
  roth: { sheet: 'Roth comparison', fedOrdinary: 28, fedLtcg: 29, state: 30, contribution: 31, investmentAccount: 32, fee: 33, totalOutlay: 34, savings: 35, effectiveRate: 36, netAdditionalSavings: 43 },
};

/** The workbook's comparison tables as { base|db|roth: { scenarioId: { rowKey: {value, ref} } } }. */
export function readGrid(wb) {
  const out = {};
  for (const [block, spec] of Object.entries(ROWS)) {
    out[block] = {};
    for (const [sid, col] of Object.entries(COLUMNS)) {
      const cells = {};
      for (const [k, row] of Object.entries(spec)) {
        if (k === 'sheet') continue;
        const ref = `${spec.sheet}!${col}${row}`;
        cells[k] = { value: wb.get(ref), ref };
      }
      out[block][sid] = cells;
    }
  }
  const R = (a) => ({ value: wb.get(`Roth comparison!${a}`), ref: `Roth comparison!${a}` });
  out.rothProjection = {
    conversionTax: R('O3'), netConversionTax: R('N3'), pvRmdTax: R('P3'),
    rothWithSavingsAt100: R('N5'), rothAt100: R('O5'), traditionalAt100: R('P5'),
    strategyUsed: R('C12'), strategySavings: R('C13'), effectiveRate: R('C6'), projectedRate: R('C8'),
  };
  return out;
}
