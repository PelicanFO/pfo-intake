// Hand-calculated returns that check the corrected tax math against the 2026 rules.
// Each expected number is worked out in the comment beside it.
import { suite } from './harness.js';
import { computeReturn, emptySituation } from '../src/engine/taxReturn.js';
import { ALL_ON, ALL_OFF } from '../src/engine/rules.js';
import { bracketTax } from '../src/engine/brackets.js';
import { FEDERAL } from '../src/tables/federal.js';

function sit(over = {}) {
  const s = emptySituation();
  Object.assign(s, over, { income: { ...s.income, ...(over.income || {}) } });
  if (!over.ages) s.ages = { taxpayer: 50, spouse: 50 };
  return s;
}
const run = (s, rules = ALL_ON) => computeReturn(s, rules, { ledger: true });

suite('Tax law: 2026 brackets and standard deduction', (t) => {
  // $400,000 wages, joint, under 65: taxable 400,000 − 32,200 = 367,800;
  // tax = 35,932 + 24% × (367,800 − 211,400) = 73,468 (Rev. Proc. 2025-32 table 1).
  const r = run(sit({ income: { w2: 400000 } }));
  t.close(r.taxableIncome, 367800, 0.01, 'taxable income');
  t.close(r.totals.fedOrdinary, 73468, 0.01, 'federal tax');
  t.close(r.totals.payroll, 1350, 0.01, 'Additional Medicare 0.9% × 150,000');
  t.close(r.totals.state, 11227.5, 0.01, 'Louisiana 3% × (400,000 − 25,750)');
  t.close(r.totals.niit, 0, 0.01, 'no NIIT on wages');
  // Same couple at 65: + 2 × $1,650; senior deduction fully phased out (6% × 250,000 > 12,000).
  const r65 = run(sit({ income: { w2: 400000 }, ages: { taxpayer: 65, spouse: null } }));
  t.close(r65.taxableIncome, 364500, 0.01, 'taxable income with two 65+ add-ons');
  t.close(r65.seniorDeduction, 0, 0.01, 'senior deduction phased out');
  t.close(r65.totals.fedOrdinary, 72676, 0.01, 'federal tax at 65');
  // Every published bracket boundary: tax at the top of each bracket equals the IRS "plus" amount.
  const mfj = FEDERAL[2026].ordinaryBrackets.mfj;
  const plus = [2480, 11600, 35932, 82048, 116896, 206583.5];
  for (let i = 1; i < mfj.length; i++) t.close(bracketTax(mfj[i][0], mfj).tax, plus[i - 1], 0.001, `tax at ${mfj[i][0]}`);
  const single = FEDERAL[2026].ordinaryBrackets.single;
  t.close(bracketTax(201775, single).tax, 17966 + 0.24 * (201775 - 105700), 0.001, 'single 24% bracket top');
  const hoh = FEDERAL[2026].ordinaryBrackets.hoh;
  t.close(bracketTax(201750, hoh).tax, 39207, 0.001, 'head of household 24% bracket top');
});

suite('Tax law: capital gains stack on ordinary income', (t) => {
  // Single, $60,000 wages + $20,000 LTCG. Taxable 80,000 − 16,100 = 63,900; ordinary 43,900.
  // Ordinary tax 1,240 + 12% × 31,500 = 5,020. Gains fill 43,900 → 63,900: 5,550 at 0%
  // (up to 49,450) and 14,450 at 15% = 2,167.50.
  const s = sit({ filingStatus: 'single', income: { w2: 60000, ltcg: 20000 }, ages: { taxpayer: 40 } });
  const r = run(s);
  t.close(r.totals.fedOrdinary, 5020, 0.01, 'ordinary tax');
  t.close(r.totals.fedLtcg, 2167.5, 0.01, 'stacked capital-gains tax');
  t.close(r.totals.state, 2013.75, 0.01, 'Louisiana 3% × (80,000 − 12,875)');
  // Spreadsheet mode taxes the $20,000 on its own → all in the 0% bracket.
  const legacy = computeReturn(s, ALL_OFF, { ledger: false });
  t.close(legacy.totals.fedLtcg, 0, 0.01, 'spreadsheet: unstacked gains at 0%');
});

suite('Tax law: NIIT uses the lesser of investment income or excess MAGI', (t) => {
  // Joint, $300k wages, $50k interest, $100k LTCG → AGI 450,000. NII 150,000; MAGI over $250k = 200,000.
  // NIIT = 3.8% × 150,000 = 5,700. Taxable 417,800 (ordinary 317,800): ordinary tax
  // 35,932 + 24% × 106,400 = 61,468; gains all in the 15% band = 15,000.
  const r = run(sit({ income: { w2: 300000, interest: 50000, ltcg: 100000 } }));
  t.close(r.totals.niit, 5700, 0.01, 'NIIT');
  t.close(r.totals.fedOrdinary, 61468, 0.01, 'ordinary tax');
  t.close(r.totals.fedLtcg, 15000, 0.01, 'capital-gains tax');
  t.close(r.totals.amt, 0, 0.01, 'no AMT');
  t.close(r.totals.payroll, 450, 0.01, 'Additional Medicare on $50k of wages over $250k');
  // Wages only: no NIIT, even far above the threshold (the spreadsheet charged 3.8% here).
  t.close(run(sit({ income: { w2: 900000 } })).totals.niit, 0, 0.01, 'no NIIT on wages');
});

suite('Tax law: itemized deductions, SALT cap and charitable limits', (t) => {
  // Joint, $500k wages, $15k property tax, $200k gift of appreciated property.
  // LA tax 3% × (500,000 − 25,750) = 14,227.50 → SALT 29,227.50 (under the $40,400 cap).
  // Gift limited to 30% × 500,000 = 150,000, less 0.5% floor 2,500 = 147,500; 50,000 carries forward.
  // Itemized 176,727.50 → taxable 323,272.50 → tax 35,932 + 24% × 111,872.50 = 62,781.40.
  const r = run(sit({ income: { w2: 500000 }, propertyTax: 15000, charitable: [{ id: 'g', label: 'gift', amount: 200000, limitPct: 0.3 }] }));
  t.close(r.deduction, 176727.5, 0.01, 'itemized deductions');
  t.close(r.carryforwards.charitable, 50000, 0.01, 'charitable carryforward');
  t.close(r.totals.fedOrdinary, 62781.4, 0.01, 'federal tax');
  // SALT phase-down: $600k wages + $30k property tax. Cap 40,400 − 30% × 95,000 = 11,900,
  // so the standard deduction wins: tax 116,896 + 35% × (567,800 − 512,450) = 136,268.50.
  const r2 = run(sit({ income: { w2: 600000 }, propertyTax: 30000 }));
  t.ok(r2.usedStandard, 'standard deduction beats capped SALT');
  t.close(r2.totals.fedOrdinary, 136268.5, 0.01, 'federal tax with SALT phase-down');
  // 2/37 limit: joint, $1.2M wages, $100k cash gift. Itemized = 100,000 − 6,000 floor + 10,000 SALT floor
  // (cap 40,400 − 30% × 695,000 < 10,000) = 104,000; reduction 2/37 × min(104,000, 1,200,000 − 768,700) = 5,621.62.
  const r3 = run(sit({ income: { w2: 1200000 }, charitable: [{ id: 'g', label: 'gift', amount: 100000, limitPct: 0.6 }] }));
  t.close(r3.deduction, 104000 - 104000 * 2 / 37, 0.01, 'itemized after the 2/37 limit');
});

suite('Tax law: excess business loss, QBI, capital losses', (t) => {
  // $1M wages, $700k strategy loss, joint: only $512,000 is allowed; $188,000 becomes an NOL.
  const r = run(sit({ income: { w2: 1000000 }, businessLosses: [{ id: 'x', label: 'loss', amount: 700000 }] }));
  t.close(r.agi, 488000, 0.01, 'AGI after the $512,000 limit');
  t.close(r.carryforwards.nol, 188000, 0.01, 'NOL carryforward');
  // QBI, specified service: joint, $450k K-1 income. Taxable before QBI 417,800 is 14,300 over
  // the 403,500 threshold → 1 − 14,300/150,000 = 90.4667% of 20% × 450,000 = 81,420.
  const q = run(sit({ income: { business: 450000 }, qbiType: 'sstb' }));
  t.close(q.qbiDeduction, 81420, 0.01, 'QBI deduction with phase-in');
  t.close(q.taxableIncome, 417800 - 81420, 0.01, 'taxable income after QBI');
  const q2 = run(sit({ income: { business: 450000 }, qbiType: 'nonsstb' }));
  t.close(q2.qbiDeduction, 83560, 0.01, 'non-SSTB: 20% × 450,000 = 90,000 capped at 20% × 417,800');
  // Capital loss: single, $100k wages, $10k LTCG, $20k LEAP capital loss → net −10,000:
  // $3,000 deducted, $7,000 carried forward.
  const c = run(sit({ filingStatus: 'single', income: { w2: 100000, ltcg: 10000 }, capitalLosses: [{ id: 'l', label: 'loss', amount: 20000 }] }));
  t.close(c.agi, 97000, 0.01, 'AGI with $3,000 capital loss');
  t.close(c.carryforwards.capitalLoss, 7000, 0.01, 'capital loss carryforward');
});

suite('Tax law: self-employment tax, AMT and the business credit limit', (t) => {
  // Single, $150k wages + $100k Schedule C. Net earnings 92,350; Social Security part only on
  // 184,500 − 150,000 = 34,500 → 4,278; Medicare 2.9% × 92,350 = 2,678.15. Additional Medicare:
  // 0.9% × (92,350 − (200,000 − 150,000)) = 381.15.
  const se = run(sit({ filingStatus: 'single', income: { w2: 150000, business: 100000 }, businessType: 'scheduleC' }));
  t.close(se.totals.payroll, 4278 + 2678.15 + 381.15, 0.01, 'SE tax + Additional Medicare');
  t.close(se.agi, 250000 - (4278 + 2678.15) / 2, 0.01, 'AGI after half of SE tax');
  // AMT from losing the standard deduction: joint, $2M of long-term gains, nothing else.
  // Regular: taxable 1,967,800, all gains: 15% × (613,700 − 98,900) + 20% × (1,967,800 − 613,700) = 348,040.
  // AMT: exemption fully phased out (140,200 − 50% × 1,000,000 < 0); gains 2,000,000:
  // 77,220 + 20% × 1,386,300 = 354,480 → AMT 6,440.
  const a = run(sit({ income: { ltcg: 2000000 } }));
  t.close(a.regularTax, 348040, 0.01, 'regular tax');
  t.close(a.amt, 6440, 0.01, 'AMT');
  // Credit limit: $400k wages, joint, 65+ → regular tax 72,676; a $100k credit is limited to
  // 72,676 − 25% × (72,676 − 25,000) = 60,757; 39,243 carries over.
  const c = run(sit({ income: { w2: 400000 }, ages: { taxpayer: 65, spouse: 65 }, credits: [{ id: 'itc', label: 'credit', amount: 100000 }] }));
  t.close(c.creditAllowed, 72676 - 0.25 * (72676 - 25000), 0.01, 'credit allowed');
  t.close(c.carryforwards.credit, 100000 - (72676 - 0.25 * (72676 - 25000)), 0.01, 'credit carryover');
});

suite('Tax law: spreadsheet mode reproduces the workbook\'s simplified math', (t) => {
  // No deduction, $1 bracket gaps: $400k joint → 81,195.42 (Strategy comparison!F4).
  const r = computeReturn(sit({ income: { w2: 400000 } }), ALL_OFF, { ledger: false });
  t.close(r.totals.fedOrdinary, 81195.42, 0.005, 'federal tax as in the workbook');
  t.close(r.totals.state, 12000, 0.001, 'Louisiana 3% of gross income');
  t.close(r.totals.niit + r.totals.payroll + r.totals.amt, 0, 0.001, 'NIIT, Medicare and AMT left out');
});

suite('Tax law: married filing separately, Texas and a custom state rate', (t) => {
  // MFS, $200k wages, Texas. Taxable 200,000 − 16,100 = 183,900;
  // tax 17,966 + 24% × (183,900 − 105,700) = 36,734. Additional Medicare 0.9% × (200,000 − 125,000) = 675.
  const r = run(sit({ filingStatus: 'mfs', state: 'TX', income: { w2: 200000 } }));
  t.close(r.totals.fedOrdinary, 36734, 0.01, 'MFS federal tax');
  t.close(r.totals.payroll, 675, 0.01, 'MFS Additional Medicare threshold $125,000');
  t.close(r.totals.state, 0, 0.001, 'Texas: no income tax');
  t.close(bracketTax(384350, FEDERAL[2026].ordinaryBrackets.mfs).tax, 103291.75, 0.001, 'MFS 37% bracket starts at $384,350');
  // Custom 5% state on $300k AGI (flat rate, no deduction).
  const c = run(sit({ state: 'CUSTOM', stateCustom: { rate: 0.05 }, income: { w2: 300000 } }));
  t.close(c.totals.state, 15000, 0.001, 'custom state 5% × 300,000');
});
