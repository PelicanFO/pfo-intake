// The intake site's tax step: intake mapping, suggestions and the Review & Share summary.
import { suite } from './harness.js';
import { analyze, suggestions, taxSummary, taxDeferredBalance } from '../src/site/tax-step.js';

const LA = { filing_status: 'Married filing jointly', state: 'Louisiana' };

suite('Site: intake answers drive the workbook-method results', (t) => {
  const a = analyze({ ...LA, age: '65', w2_income: '400,000' });
  t.close(a.comparison.blocks.base.scenarios.film.savings, 15582.07, 0.01, 'Film savings match the workbook (Strategy comparison!G11)');
  t.close(a.comparison.blocks.base.baseline, 93195.42, 0.01, 'current tax liability matches the workbook (F10)');
  const s = taxSummary({ ...LA, age: '65', w2_income: '400000' });
  t.equal(s.best.label, 'Film', 'summary picks Film as best');
  t.close(s.best.pct, 15582.07 / 93195.42, 1e-6, 'savings as a share of tax liability');
  t.equal(taxSummary({ ...LA }), null, 'no summary without income');
});

suite('Site: pre-tax retirement balance ignores Roth accounts', (t) => {
  const sheet = [
    { label: 'Roth retirement accounts', value: '300,000' },
    { label: 'Pre-tax retirement accounts (401k, IRA)', value: '500,000' },
    { label: 'Old SEP IRA', value: '40,000' },
  ];
  t.close(taxDeferredBalance({ nw_sheet: sheet }), 540000, 0.01, 'statement rows');
  t.close(taxDeferredBalance({ nw_view: 'simple', nw_tax_deferred: '250,000', nw_sheet: sheet }), 250000, 0.01, 'simplified view field');
});

suite('Site: DB plan and Roth conversion suggestions', (t) => {
  const kinds = (fd) => suggestions(fd).map((x) => x.kind).join(',');
  t.equal(kinds({ ...LA, w2_income: '400000' }), '', 'W-2 only, no retirement balance: nothing to suggest');
  const db = suggestions({ ...LA, business_income: '300,000' }).find((x) => x.kind === 'db');
  t.ok(db && db.amount === 150000 && db.savings > 30000, `business owner gets a DB suggestion (${db && db.amount}, ${db && Math.round(db.savings)})`);
  t.equal(kinds({ ...LA, business_income: '300000', __tax: { dbContribution: 100000 } }), '', 'no DB suggestion once a contribution is entered');
  t.equal(kinds({ ...LA, business_income: '30000' }), '', 'small business income: no DB suggestion');
  // Retiree in a low bracket with a large IRA: converting on its own beats 35% on later withdrawals.
  const r = suggestions({ ...LA, age: '68', interest_income: '40000', qualified_dividends: '80000', nw_view: 'simple', nw_tax_deferred: '1,000,000' }).find((x) => x.kind === 'roth');
  t.ok(r && /Converting about/.test(r.text) && r.savings > 2000, `retiree gets a standalone Roth suggestion (${r && r.text})`);
  // High earner: a conversion only helps when paired with a strategy.
  const h = suggestions({ ...LA, age: '55', w2_income: '900000', nw_view: 'simple', nw_tax_deferred: '600000' }).find((x) => x.kind === 'roth');
  t.ok(h && /paired with/.test(h.text), `high earner gets a paired Roth suggestion (${h && h.text})`);
  t.equal(kinds({ ...LA, w2_income: '400000', nw_view: 'simple', nw_tax_deferred: '10000' }), '', 'tiny balance: no Roth suggestion');
});
