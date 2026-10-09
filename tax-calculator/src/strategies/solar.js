import { money, pct } from '../engine/ledger.js';
import { bracketTax, capitalGainsTax } from '../engine/brackets.js';

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

  apply(ctx, p, sizing, options = {}) {
    let contribution, how;
    if (typeof sizing.contribution === 'number') {
      contribution = ctx.clamp(sizing.contribution, 'Solar contribution');
      how = 'manual input';
    } else if (!ctx.rules.creditLimit) {
      contribution = this.solveSpreadsheet(ctx, p, options);
      how = options.excelVariant === 'afterCharitable'
        ? 'spreadsheet sizing: credit + federal depreciation benefit = remaining federal tax incl. NIIT (Solar & Charitable!C49)'
        : 'spreadsheet sizing: credit + depreciation benefit (federal + state) = federal tax incl. NIIT (Solar!C18)';
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
    if (!ctx.rules.creditLimit && this.spreadsheet && this.spreadsheet.benefitOf) {
      // The workbook reduces federal tax by the whole benefit (credit + federal AND state depreciation
      // savings) and treats anything under $1,000 left over as zero (Solar!C20). Reproduce that.
      const benefit = this.spreadsheet.benefitOf(contribution);
      const r = ctx.evaluate(); // depreciation is already on the return; regular tax is before credits
      const engineCreditNeeded = r.regularTax;
      const fb = this.spreadsheet.federalBefore;
      let remaining = fb - Math.max(Math.min(benefit, fb), 0);
      if (Math.abs(remaining) <= 1000) remaining = 0;
      const extra = Math.max(0, Math.min(engineCreditNeeded - remaining, engineCreditNeeded) - m.credit);
      if (extra > 0.005) {
        ctx.addCredit({ id: 'solar-spreadsheet', label: 'Spreadsheet adjustment: state saving also counted against federal tax', amount: extra,
          calc: 'the workbook subtracts the full solar benefit (incl. state savings) from federal tax and zeroes remainders under $1,000', source: 'Solar!C20' });
      }
    }
    this.spreadsheet = null;
    ctx.addCost({ kind: 'contribution', label: 'Solar equity contribution', amount: contribution, calc: how });
  },

  // The workbook's sizing rule (spreadsheet mode). Excel finds it with an iterative ±step search;
  // we solve it directly. Target: federal ordinary + LTCG tax + the workbook's NIIT figure.
  // Benefit: credit + federal tax saved by the depreciation (+ state tax saved, standalone only).
  solveSpreadsheet(ctx, p, options) {
    const cur = ctx.evaluate();
    const s = ctx.sit, fs = s.filingStatus, inc = s.income;
    const T = ctx.T;
    const gaps = { legacyGaps: !ctx.rules.continuousBrackets };
    const ordTax = (x) => bracketTax(x, T.ordinaryBrackets[fs], gaps).tax;
    const nii = inc.stcg + inc.interest + inc.qualifiedDividends + inc.nonqualifiedDividends + inc.ltcg;
    const thr = T.niit.threshold[fs] === undefined ? 200000 : T.niit.threshold[fs];
    let niit;
    if (options.excelVariant === 'afterCharitable') {
      // Solar & Charitable!J46: the comparison uses the right threshold, the amount always uses $200,000.
      const gifts = s.charitable.reduce((a, c) => a + c.amount, 0);
      niit = cur.agi - gifts - thr > nii ? (cur.agi - gifts - 200000) * T.niit.rate : nii * T.niit.rate;
    } else {
      niit = cur.agi - thr > nii ? (cur.agi - thr) * T.niit.rate : nii * T.niit.rate;
    }
    // Solar!O28 (single filers) taxes long-term gains without qualified dividends (P22 = C13).
    let fedLtcg = cur.totals.fedLtcg;
    if (fs !== 'mfj' && options.excelVariant !== 'afterCharitable' && !ctx.rules.capitalGainsStacking) {
      fedLtcg = capitalGainsTax(inc.ltcg, 0, T.capitalGains[fs], { stacked: false, ...gaps }).tax;
    }
    const target = cur.totals.fedOrdinary + fedLtcg + niit;
    const federalBefore = cur.totals.fedOrdinary + cur.totals.fedLtcg;
    this.spreadsheet = { benefitOf: null, federalBefore };
    if (target <= 0) return 0;
    const withState = options.excelVariant !== 'afterCharitable';
    const benefit = (c) => {
      const m = this.mechanics(c, p);
      let b = m.credit + ordTax(cur.ordTI) - ordTax(cur.ordTI - m.netDepreciation);
      if (withState) {
        const r = ctx.evaluateWith((x) => { x.businessLosses.push({ id: 'solar', amount: m.netDepreciation }); });
        b += cur.totals.state - r.totals.state;
      }
      return b;
    };
    let lo = 0, hi = target * p.equityPct / p.creditPct;
    for (let i = 0; i < 80 && hi - lo > 0.0005; i++) {
      const mid = (lo + hi) / 2;
      if (benefit(mid) > target) hi = mid; else lo = mid;
    }
    this.spreadsheet.benefitOf = benefit;
    ctx.log.line('Sizing target (federal tax incl. NIIT)', target, { kind: 'info', calc: `federal tax ${money(cur.totals.fedOrdinary + cur.totals.fedLtcg)} + NIIT as the workbook computes it ${money(niit)}`, excel: withState ? 'Solar!E5' : 'Solar & Charitable!E37' });
    return (lo + hi) / 2;
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
