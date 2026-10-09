import { money, pct } from '../engine/ledger.js';

// Leveraged entity ownership (LEAP / "SOP"): a contribution buys an interest that passes through a
// negative K-1 against business income (multiple × contribution) and against long-term gains.
// Spreadsheet sheets: LEAP, LEAP & Charitable (+ DB/Roth).
export default {
  id: 'leap',
  name: 'LEAP',
  description: 'Leveraged entity ownership: a negative K-1 that offsets business income and long-term gains.',
  params: [
    { key: 'incomePct', label: 'Business income offset (%)', type: 'pct', default: 1, excel: 'LEAP!D6', help: 'Used when no K-1 amount is entered.' },
    { key: 'cgPct', label: 'Long-term gain offset (%)', type: 'pct', default: 1, excel: 'LEAP!E6' },
    { key: 'incomeMultiple', label: 'Business-income K-1 per $1 contributed', type: 'number', default: 8, excel: 'LEAP!D9' },
    { key: 'cgMultiple', label: 'Capital-gain K-1 per $1 contributed', type: 'number', default: 10, excel: 'LEAP!E9' },
    { key: 'adminFeePct', label: 'Admin fee (% of business K-1)', type: 'pct', default: 0.05, excel: 'LEAP!D14' },
    { key: 'sopFeePct', label: 'SOP fee (% of capital-gain K-1)', type: 'pct', default: 0.05, excel: 'LEAP!E14' },
    { key: 'investIncomePct', label: 'Kept in investment account (% of business contribution)', type: 'pct', default: 0.6, excel: 'LEAP!D20' },
    { key: 'investCgPct', label: 'Kept in investment account (% of capital-gain contribution)', type: 'pct', default: 0.5, excel: 'LEAP!E20' },
  ],
  sizing: [
    { key: 'incomeLoss', label: 'Negative K-1 vs. business income', excel: { base: 'Strategy comparison!K18', db: 'DB comparison!K5', roth: 'Roth comparison!K5' } },
    { key: 'cgLoss', label: 'Negative K-1 vs. long-term gains', excel: { base: 'Strategy comparison!K20', db: 'DB comparison!K7', roth: 'Roth comparison!K7' } },
  ],
  notes: [
    'The investment-account balance is shown but, as in the spreadsheet, not counted as savings.',
    'A capital loss beyond capital gains only offsets $3,000 of ordinary income per year when the capital-gains correction is on.',
  ],

  apply(ctx, p, sizing) {
    const cur = ctx.evaluate();
    const biz = ctx.sit.income.business;
    const incomeLoss = ctx.size(sizing.incomeLoss, {
      what: 'LEAP business-income K-1', current: cur, noFill: true,
      auto: () => [biz * p.incomePct, `${pct(p.incomePct, 0)} × ${money(biz)} business income`],
    });
    const incomeHow = ctx.lastSizing;
    const ltcg = ctx.sit.income.ltcg;
    const cgLoss = ctx.size(sizing.cgLoss, {
      what: 'LEAP capital-gain K-1', current: cur, noFill: true,
      auto: () => [ltcg * p.cgPct, `${pct(p.cgPct, 0)} × ${money(ltcg)} long-term gains`],
    });
    const cgHow = ctx.lastSizing;
    if (incomeLoss) ctx.addBusinessLoss({ id: 'leap', label: 'LEAP negative K-1 (business income)', amount: incomeLoss, qbi: true, calc: incomeHow });
    if (cgLoss) ctx.addCapitalLoss({ id: 'leap-cg', label: 'LEAP negative K-1 (long-term capital loss)', amount: cgLoss, calc: cgHow });

    if (!incomeLoss && !cgLoss) ctx.warn('LEAP does not apply: no business income or long-term gains to offset.');
    const incContrib = incomeLoss / p.incomeMultiple, cgContrib = cgLoss / p.cgMultiple;
    if (incomeLoss) {
      ctx.addCost({ kind: 'contribution', label: 'Required contribution (business income)', amount: incContrib, calc: `${money(incomeLoss)} ÷ ${p.incomeMultiple}` });
      ctx.addCost({ kind: 'contribution', label: 'Admin fee', amount: incomeLoss * p.adminFeePct, calc: `${pct(p.adminFeePct)} × ${money(incomeLoss)}` });
    }
    if (cgLoss) {
      ctx.addCost({ kind: 'contribution', label: 'Required contribution (capital gains)', amount: cgContrib, calc: `${money(cgLoss)} ÷ ${p.cgMultiple}` });
      ctx.addCost({ kind: 'contribution', label: 'SOP fee', amount: cgLoss * p.sopFeePct, calc: `${pct(p.sopFeePct)} × ${money(cgLoss)}` });
    }
    if (incomeLoss || cgLoss) ctx.addCost({
      kind: 'asset', label: 'Investment account balance (not counted as savings)',
      amount: incContrib * p.investIncomePct + cgContrib * p.investCgPct,
      calc: `${pct(p.investIncomePct, 0)} × ${money(incContrib)} + ${pct(p.investCgPct, 0)} × ${money(cgContrib)}`,
    });
  },
};
