import { money, pct } from '../engine/ledger.js';

// Leveraged charitable gift: the client buys property for 1/`multiple` of its appraised value and
// donates it, deducting the appraised value as an itemized deduction.
// Spreadsheet sheets: Charitable (+ DB/Roth), and the charitable half of the combination sheets.
export default {
  id: 'charitable',
  name: 'Charitable',
  description: 'Donation of property appraised at several times its cost, deducted as an itemized charitable gift.',
  params: [
    { key: 'offsetPct', label: 'Donation (% of income)', type: 'pct', default: 0.5, excel: 'Charitable!D4', help: 'Used when no donation amount is entered.' },
    { key: 'multiple', label: 'Deduction per $1 contributed', type: 'number', default: 5, excel: 'Charitable!D7' },
    { key: 'riaDiscount', label: 'RIA discount', type: 'pct', default: 0, excel: 'Charitable!D12' },
    { key: 'giftType', label: 'Gift type (sets the AGI limit)', type: 'choice', default: 'property',
      choices: [['property', 'Appreciated property — 30% of AGI'], ['cash', 'Cash — 60% of AGI']],
      help: 'Only applies when the charitable-limits correction is on.' },
  ],
  sizing: [
    { key: 'donation', label: 'Charitable donation', excel: { base: 'Strategy comparison!I18', db: 'DB comparison!I5', roth: 'Roth comparison!I5' }, allowFill: true },
  ],
  notes: [
    'Property must be held more than a year for the appraised value to be deductible; otherwise the deduction is limited to cost.',
    'Louisiana does not allow itemized deductions, so there is no state benefit.',
  ],

  /** options.capToBracket (e.g. 0.24): don't give more than it takes to bring ordinary income to the top of that bracket. */
  apply(ctx, p, sizing, options = {}) {
    const cur = ctx.evaluate();
    const donation = ctx.size(sizing.donation, {
      what: 'Charitable donation',
      current: cur,
      auto: () => {
        let amt = cur.agi * p.offsetPct;
        let how = `${pct(p.offsetPct, 0)} × ${money(cur.agi)} income`;
        if (options.capToBracket) {
          const top = ctx.bracketTop(options.capToBracket);
          const cap = cur.ordTI - top;
          if (cap < amt) { amt = cap; how = `ordinary taxable income ${money(cur.ordTI)} − ${money(top)} top of the ${pct(options.capToBracket, 0)} bracket (smaller than ${how})`; }
        }
        return [amt, how];
      },
    });
    const limitPct = p.giftType === 'cash' ? 0.6 : 0.3;
    ctx.addCharitable({ id: 'charitable', label: 'Charitable gift (appraised value)', amount: donation, limitPct, calc: ctx.lastSizing });
    const contribution = donation / p.multiple * (1 - p.riaDiscount);
    ctx.addCost({
      kind: 'contribution', label: 'Cost of donated property', amount: contribution,
      calc: `${money(donation)} ÷ ${p.multiple}${p.riaDiscount ? ` × (1 − ${pct(p.riaDiscount)} RIA discount)` : ''}`,
    });
  },
};
