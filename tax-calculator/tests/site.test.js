// The intake site's tax step: intake mapping, suggestions and the Review & Share summary.
import { suite } from './harness.js';
import { analyze, suggestions, taxSummary, taxDeferredBalance, futureValue, futureValueOfAnnual, dbMaxForAge, foundationResult, ADVANCED, COMBINED } from '../src/site/tax-step.js';

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
  t.ok(db && db.amount >= 200000 && db.amount <= 270000 && db.savings > 30000, `business owner gets a DB suggestion (${db && db.amount}, ${db && Math.round(db.savings)})`);
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

suite('Site: DB and Roth suggestions scale with the client', (t) => {
  const dbAt = (fd) => (suggestions(fd).find((x) => x.kind === 'db') || {}).amount || 0;
  t.equal(dbMaxForAge('45'), 260000, 'front-loaded DB limit (45–49)');
  t.equal(dbMaxForAge(''), 340000, 'no age: sized as 50–54');
  t.ok(dbAt({ ...LA, age: '45', business_income: '150000' }) <= 150000 * 0.9, 'DB stays within 90% of business income');
  const mid = dbAt({ ...LA, age: '58', business_income: '1000000' });
  const big = dbAt({ ...LA, age: '62', business_income: '3000000' });
  t.ok(mid > 300000 && big > mid && big <= dbMaxForAge('62'), `larger, older owners get larger DB contributions (${mid}, ${big})`);
  const rothAt = (fd) => (suggestions(fd).find((x) => x.kind === 'roth') || {}).amount || 0;
  const r1 = rothAt({ ...LA, age: '60', w2_income: '900000', nw_view: 'simple', nw_tax_deferred: '600000' });
  const r2 = rothAt({ ...LA, age: '60', w2_income: '2000000', nw_view: 'simple', nw_tax_deferred: '5000000' });
  t.ok(r2 > 1000000 && r2 > r1, `Roth conversions go past $1M for large clients (${r1}, ${r2})`);
  t.ok(r2 <= 4000000, 'one year is capped at 2× income');
});

suite('Site: LEAP growth projection', (t) => {
  t.close(futureValue(10000, 0.07, 10), 19671.51, 0.01, '$10,000 at 7% for 10 years');
  t.close(futureValueOfAnnual(10000, 0.06, 20), 367855.91, 0.01, '$10,000 a year at 6% for 20 years');
  const a = analyze({ ...LA, business_income: '300000' });
  t.ok(a.comparison.blocks.base.scenarios.leap.rows.investmentAccount > 0, 'LEAP has an investment account to project');
});

suite('Site: foundational, advanced and combined strategy groups', (t) => {
  t.equal(ADVANCED.join(','), 'film,charitable,solar,leap', 'advanced strategies');
  t.equal(COMBINED.join(','), 'leapCharitable,solarCharitable', 'combined strategies');
  const fd = { ...LA, age: '58', business_income: '1000000', nw_view: 'simple', nw_tax_deferred: '2000000', __tax: { dbContribution: 300000, rothConversion: 500000 } };
  const a = analyze(fd);
  const db = foundationResult(a.comparison, a.model, 'db');
  t.ok(db.amount === 300000 && db.savings > 50000, `DB plan stands alone (${Math.round(db.savings)})`);
  t.close(db.savings, a.comparison.blocks.base.baseline - a.comparison.blocks.db.scenarios.none.rows.totalOutlay, 0.01, 'DB alone = tax saved by the contribution');
  const film = a.comparison.blocks.db.scenarios.film.savings;
  t.ok(film > db.savings, 'Film combined with the DB plan saves more than the DB plan alone');
  const s = taxSummary(fd);
  t.equal(s.strategies.map((r) => r.group).filter((g, i, xs) => xs.indexOf(g) === i).join(','), 'Foundational,Advanced,Combined', 'summary is grouped foundational → advanced → combined');
  t.ok(/^Defined Benefit Plan/.test(s.strategies[0].label) && s.strategies[1].group === 'Advanced', 'DB plan is the only foundational row (Roth is offered combined only)');
  t.ok(s.scenarios.length === 2 && /combined with/.test(s.scenarios[0].label), 'pairings listed');
});
