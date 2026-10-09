// Progressive bracket math with a per-bracket breakdown for the audit trail.
import { money, pct } from './ledger.js';

/**
 * Tax on `income` using [threshold, rate] brackets.
 * legacyGaps reproduces the spreadsheet, where each bracket starts $1 above the previous top
 * (e.g. 12% from $24,801), so $1 per bracket goes untaxed.
 */
export function bracketTax(income, brackets, { legacyGaps = false } = {}) {
  const rows = [];
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [threshold, rate] = brackets[i];
    const lo = legacyGaps && i > 0 ? threshold + 1 : threshold;
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    const amount = Math.max(0, Math.min(income, hi) - lo);
    if (amount <= 0) continue;
    const t = amount * rate;
    tax += t;
    rows.push({ from: lo, to: Math.min(income, hi), rate, amount, tax: t });
  }
  return { tax, rows };
}

export const describeRows = (rows) => rows.map((r) => `${pct(r.rate, 0)} × ${money(r.amount)}`).join(' + ') || '$0';

/** Rate that applies to the next dollar of income. */
export function marginalRate(income, brackets) {
  let rate = brackets[0][1];
  for (const [threshold, r] of brackets) if (income > threshold) rate = r;
  return rate;
}

/** Taxable income at which the bracket with `rate` ends (e.g. 0.12 → $100,800 joint). */
export function bracketTop(brackets, rate) {
  const i = brackets.findIndex(([, r]) => Math.abs(r - rate) < 1e-9);
  if (i < 0) throw new Error(`No ${pct(rate)} bracket`);
  return i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
}

/**
 * Preferential-rate tax on long-term gains and qualified dividends.
 * Stacked: gains occupy taxable income from `ordinaryBase` up, and each slice takes the
 * 0/15/20% rate for where it falls (Qualified Dividends and Capital Gain Tax Worksheet).
 * Unstacked (spreadsheet): the 0/15/20% brackets are applied to the gains alone.
 */
export function capitalGainsTax(gains, ordinaryBase, cg, { stacked = true, legacyGaps = false } = {}) {
  if (gains <= 0) return { tax: 0, rows: [] };
  if (!stacked) return bracketTax(gains, [[0, 0], [cg.zeroMax, 0.15], [cg.fifteenMax, 0.20]], { legacyGaps });
  const bands = [[0, cg.zeroMax, 0], [cg.zeroMax, cg.fifteenMax, 0.15], [cg.fifteenMax, Infinity, 0.20]];
  const start = ordinaryBase, end = ordinaryBase + gains;
  const rows = [];
  let tax = 0;
  for (const [lo, hi, rate] of bands) {
    const amount = Math.max(0, Math.min(end, hi) - Math.max(start, lo));
    if (amount <= 0) continue;
    tax += amount * rate;
    rows.push({ from: Math.max(start, lo), to: Math.min(end, hi), rate, amount, tax: amount * rate });
  }
  return { tax, rows };
}
