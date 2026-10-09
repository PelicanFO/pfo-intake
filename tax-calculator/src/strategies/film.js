import { money, pct } from '../engine/ledger.js';

// Film investment: the client's contribution produces an ordinary deduction (passed through on a
// K-1) worth `multiple` × the contribution. Spreadsheet sheets: Film, Film & DB, Film & Roth.
export default {
  id: 'film',
  name: 'Film',
  description: 'Contribution to a film production that passes through an ordinary deduction of several times the contribution.',
  params: [
    { key: 'offsetPct', label: 'Income offset (% of income)', type: 'pct', default: 1, excel: 'Film!D4', help: 'Used when no offset amount is entered.' },
    { key: 'multiple', label: 'Deduction per $1 contributed', type: 'number', default: 4.75, excel: 'Film!D7' },
    { key: 'riaDiscount', label: 'RIA discount', type: 'pct', default: 0, excel: 'Film!D12' },
  ],
  sizing: [
    { key: 'offset', label: 'Income offset', excel: { base: 'Strategy comparison!G18', db: 'DB comparison!G5', roth: 'Roth comparison!G5' }, allowFill: true },
  ],
  notes: [
    'Assumes the deduction is a non-passive trade or business loss the client can use against wages (material participation and at-risk rules are not tested).',
    'Subject to the excess business loss limit when that correction is on.',
  ],

  apply(ctx, p, sizing) {
    const cur = ctx.evaluate();
    const offset = ctx.size(sizing.offset, {
      what: 'Film income offset',
      auto: () => [cur.agi * p.offsetPct, `${pct(p.offsetPct, 0)} × ${money(cur.agi)} income`],
      current: cur,
    });
    ctx.addBusinessLoss({ id: 'film', label: 'Film production deduction (K-1)', amount: offset, qbi: true, calc: ctx.lastSizing });
    const contribution = offset / p.multiple * (1 - p.riaDiscount);
    ctx.addCost({
      kind: 'contribution', label: 'Film contribution', amount: contribution,
      calc: `${money(offset)} ÷ ${p.multiple}${p.riaDiscount ? ` × (1 − ${pct(p.riaDiscount)} RIA discount)` : ''}`,
    });
  },
};
