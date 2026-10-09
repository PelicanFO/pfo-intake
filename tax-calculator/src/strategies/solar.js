import { money, pct } from '../engine/ledger.js';

// Solar equity investment: the client funds `equityPct` of a project's cost and receives the
// federal energy credit (creditPct of cost) plus first-year depreciation, net of the project's
// upfront electricity sale. Spreadsheet sheets: Solar (+ DB/Roth) and Solar & Charitable.
export default {
  id: 'solar',
  name: 'Solar',
  description: 'Equity in a solar project: investment tax credit plus first-year depreciation.',
  params: [
    { key: 'equityPct', label: 'Client equity (% of project cost)', type: 'pct', default: 0.36, excel: 'Solar!C16' },
    { key: 'creditPct', label: 'Federal credit (% of project cost)', type: 'pct', default: 0.40, excel: 'Solar!C17' },
  ],
  sizing: [
    { key: 'contribution', label: 'Equity contribution', excel: { base: 'Strategy comparison!H18', db: 'DB comparison!H5', roth: 'Roth comparison!H5' },
      autoLabel: 'Solve: the contribution whose credit uses up the federal income tax it is allowed to offset' },
  ],
  notes: [
    'Depreciable basis is reduced by half the credit (IRC §50(c)(3)); depreciation is taken in year 1 (100% bonus, restored by OBBBA).',
    'Not modeled: passive activity rules (credits and losses from a passive investment can only offset passive income), recapture, and the OBBBA construction-start deadlines for wind and solar.',
  ],

  mechanics(c, p) {
    const cost = c / p.equityPct;
    const credit = cost * p.creditPct;
    const basis = cost - credit / 2;
    const upfrontSale = cost - c;
    const netDepreciation = basis - upfrontSale;
    return { cost, credit, basis, upfrontSale, netDepreciation };
  },

  apply(ctx, p, sizing) {
    let contribution, how;
    if (typeof sizing.contribution === 'number') {
      contribution = ctx.clamp(sizing.contribution, 'Solar contribution');
      how = 'manual input';
    } else {
      contribution = this.solve(ctx, p);
      how = 'solved so the credit just uses up the federal income tax it can offset';
    }
    const m = this.mechanics(contribution, p);
    ctx.log.section('Solar sizing');
    ctx.log.line('Equity contribution', contribution, { calc: how, kind: 'input' });
    ctx.log.line('Project cost', m.cost, { calc: `${money(contribution)} ÷ ${pct(p.equityPct)}` });
    ctx.log.line('Federal energy credit', m.credit, { calc: `${pct(p.creditPct)} × ${money(m.cost)}`, source: 'IRC §48 / §48E' });
    ctx.log.line('Depreciable basis', m.basis, { calc: `${money(m.cost)} − ½ × ${money(m.credit)}`, source: 'IRC §50(c)(3)' });
    ctx.log.line('Upfront electricity sale', m.upfrontSale, { calc: `${money(m.cost)} − ${money(contribution)}` });
    ctx.log.line('Net first-year depreciation', m.netDepreciation, { calc: 'basis − upfront sale', kind: 'total' });
    ctx.addBusinessLoss({ id: 'solar', label: 'Solar net depreciation (K-1)', amount: m.netDepreciation, qbi: true, calc: 'depreciable basis − upfront electricity sale' });
    ctx.addCredit({ id: 'solar-itc', label: 'Solar energy credit', amount: m.credit, calc: `${pct(p.creditPct)} × ${money(m.cost)} project cost`, source: 'IRC §48 / §48E' });
    ctx.addCost({ kind: 'contribution', label: 'Solar equity contribution', amount: contribution, calc: how });
  },

  // The credit grows faster than the tax it can offset shrinks, so there is one crossing point.
  solve(ctx, p) {
    const capacity = (c) => {
      const m = this.mechanics(c, p);
      const r = ctx.evaluateWith((s) => {
        s.businessLosses.push({ id: 'solar', amount: m.netDepreciation, qbi: true });
      });
      return { credit: m.credit, limit: ctx.creditCapacity(r) };
    };
    const start = capacity(0);
    if (start.limit <= 0) return 0;
    let lo = 0, hi = start.limit * p.equityPct / p.creditPct;
    for (let i = 0; i < 60 && hi - lo > 0.005; i++) {
      const mid = (lo + hi) / 2;
      const r = capacity(mid);
      if (r.credit > r.limit) hi = mid; else lo = mid;
    }
    return lo;
  },
};
