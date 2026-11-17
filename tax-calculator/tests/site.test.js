// The intake site's tax step: intake mapping, suggestions and the Review & Share summary.
import { suite } from './harness.js';
import { augustaRule, familyPayroll } from '../src/site/foundational.js';
import { planFor, analyze, suggestions, taxSummary, taxDeferredBalance, futureValue, futureValueOfAnnual, dbMaxForAge, foundationResult, ADVANCED, COMBINED, withAutoDb, dbSuggestion } from '../src/site/tax-step.js';

const LA = { filing_status: 'Married filing jointly', state: 'Louisiana' };

suite('Site: intake answers drive the results (spreadsheet method + standard deduction)', (t) => {
  // Workbook (no deductions): liability $93,195.42 (Strategy comparison!F10). The site adds the
  // standard deduction: federal $32,200 + 2 × $1,650 age 65+ = $35,500 at 24% = $8,520 (senior
  // deduction fully phased out at $400k), plus Louisiana's $25,750 at 3% = $772.50, plus the 0.9%
  // Additional Medicare Tax on $150,000 of wages over $250,000 = $1,350.
  const a = analyze({ ...LA, age: '65', w2_income: '400,000' });
  t.close(a.comparison.blocks.base.baseline, 93195.42 - 8520 - 772.5 + 1350, 0.01, 'liability = workbook − standard deductions + Additional Medicare');
  t.close(a.comparison.blocks.base.scenarios.none.rows.niit, 0, 0.01, 'no NIIT on wages');
  const film = a.comparison.blocks.base.scenarios.film.savings;
  t.ok(film > 10000 && film < 15582.07, `Film still saves, a little less than the workbook's $15,582 now that the first $35,500 isn't taxed (${Math.round(film)})`);
  const s = taxSummary({ ...LA, age: '65', w2_income: '400000' });
  t.equal(s.best.label, 'Film', 'summary picks Film as best');
  t.close(s.best.pct, film / a.comparison.blocks.base.baseline, 1e-6, 'savings as a share of tax liability');
  t.equal(taxSummary({ ...LA }), null, 'no summary without income');
  const young = analyze({ ...LA, w2_income: '400,000' }).comparison.blocks.base.baseline;
  t.close(young - a.comparison.blocks.base.baseline, 3300 * 0.24, 0.01, 'no age entered: no 65+ deduction');
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
  t.equal(s.strategies.map((r) => r.group).filter((g, i, xs) => xs.indexOf(g) === i).join(','), 'Foundational,Advanced,Dual Advanced', 'summary is grouped foundational → advanced → combined');
  t.equal(s.strategies.filter((r) => r.group === 'Foundational').map((r) => r.label.replace(/ \(.*/, '')).join(','), 'Defined Benefit Plan', 'foundational rows: DB plan only (no Roth or DB + Roth on their own)');
  t.ok(s.scenarios.length === 3 && s.scenarios.every((x) => /combined with/.test(x.label)), 'pairings listed (DB, Roth, DB + Roth)');
});

suite('Site: DB plan + Roth conversion in the same year', (t) => {
  const fd = { ...LA, age: '58', business_income: '1000000', nw_view: 'simple', nw_tax_deferred: '2000000', __tax: { dbContribution: 300000, rothConversion: 500000 } };
  const cmp = analyze(fd).comparison;
  const both = cmp.blocks.dbRoth.scenarios.none, db = cmp.blocks.db.scenarios.none, roth = cmp.blocks.roth.scenarios.none;
  t.close(both.return.agi, roth.return.agi - 300000, 0.01, 'DB contribution comes off the income that includes the conversion');
  t.ok(both.rows.totalTax < roth.rows.totalTax && both.rows.totalTax > db.rows.totalTax, 'tax falls between DB alone and Roth alone');
  t.close(cmp.blocks.dbRoth.baseline, cmp.blocks.roth.baseline, 0.01, 'measured against not converting, like the Roth comparison');
  t.ok(cmp.blocks.dbRoth.scenarios.none.savings > cmp.blocks.roth.scenarios.none.savings, 'adding the DB plan to a conversion saves more');
  // The conversion is taxed lower with the DB plan in place.
  const convTax = (blk, ref) => cmp.blocks[blk].scenarios.none.rows.totalTax - cmp.blocks[ref].scenarios.none.rows.totalTax;
  t.ok(convTax('dbRoth', 'db') < convTax('roth', 'base') + 0.01, `conversion tax with DB (${Math.round(convTax('dbRoth', 'db'))}) ≤ without (${Math.round(convTax('roth', 'base'))})`);
});

suite('Site: DB plan is applied automatically', (t) => {
  const fd = { ...LA, age: '58', business_income: '1000000' };
  const s = dbSuggestion(fd);
  const auto = withAutoDb(fd);
  t.ok(s && auto.__tax.dbContribution === s.amount && auto.__tax.dbAuto, `no amount entered: suggested ${s && s.amount} is used`);
  t.ok(/^Defined Benefit Plan/.test(taxSummary(fd).strategies[0].label), 'summary includes the DB plan without anything entered');
  t.equal(withAutoDb({ ...fd, __tax: { dbContribution: 0 } }).__tax.dbContribution, 0, 'an entered 0 turns it off');
  t.equal(withAutoDb({ ...fd, __tax: { dbContribution: 120000 } }).__tax.dbContribution, 120000, 'an entered amount wins');
  t.equal(withAutoDb({ ...LA, w2_income: '400000' }).__tax, undefined, 'no business income: nothing applied');
});

suite('Site: Augusta Rule and Family Payroll (hand-checked)', (t) => {
  // MFJ, Louisiana, age 50, $500,000 pass-through income: taxable $467,800 → 32% federal bracket + 3% LA.
  // QBI is switched off here so the hand checks isolate the rent and wage mechanics (QBI is tested below).
  const fd = (entity, extra = {}) => ({ ...LA, age: '50', business_income: '500000', has_business: 'Yes', business_entity: entity,
    nw_view: 'simple', nw_real_estate: '1,200,000', children: 'Yes', children_count: '2', children_ages: '10, 14', __tax: { qbiType: 'none' }, ...extra });
  const run = (f) => { const a = analyze(f); return { aug: augustaRule(f, a.model, f.__tax || {}), pay: familyPayroll(f, a.model, f.__tax || {}) }; };

  const s = run(fd('S-Corp'));
  t.equal(s.aug.rate, 1200, 'daily rate estimated at 0.1% of a $1.2M home');
  t.close(s.aug.rent, 16800, 0.01, '14 days × $1,200');
  t.close(s.aug.savings, 16800 * 0.35, 0.01, 'Augusta: rent deducted at 32% + 3%, tax-free to the owner');
  // Wages $32,200 + employer FICA $2,463.30 + FUTA $84 deducted at 35%; less FICA both sides, FUTA,
  // and each child's Louisiana tax: ($16,100 − $12,875) × 3% = $96.75.
  t.close(s.pay.deduction, 32200 + 2463.3 + 84, 0.01, 'S corp: wages + employer payroll tax deducted');
  t.close(s.pay.childTax, 2 * 96.75, 0.01, 'children owe no federal tax; Louisiana tax above its $12,875 deduction');
  t.close(s.pay.savings, 34747.3 * 0.35 - 2 * 2463.3 - 84 - 193.5, 0.01, `S corp family payroll savings (${Math.round(s.pay.savings)})`);

  const sole = run(fd('Sole proprietorship'));
  t.ok(!sole.aug.applies && /paying rent to the owner/.test(sole.aug.why), 'Augusta doesn\'t apply to a sole proprietorship');
  t.close(sole.pay.employerTax + sole.pay.employeeTax, 0, 0.01, 'sole proprietor: no FICA/FUTA for children under 18');
  // Sole proprietor: wages also cut self-employment tax. Net earnings fall 32,200 × 92.35% = 29,736.70:
  // Medicare 2.9% = 862.36 and Additional Medicare 0.9% = 267.63 (Social Security part stays at the wage
  // base). AGI falls 32,200 − ½ × 862.36 = 31,768.82, at 32% + 3%.
  t.close(sole.pay.savings, 0.029 * 29736.7 + 0.009 * 29736.7 + 0.35 * (32200 - 0.029 * 29736.7 / 2) - 193.5, 0.01, 'sole proprietor family payroll savings');

  const older = run(fd('Sole proprietorship', { children_ages: '19, 14' }));
  t.close(older.pay.employeeTax, 16100 * 0.0765, 0.01, 'a child 18+ pays FICA even in a sole proprietorship');

  const c = run(fd('C-Corp'));
  t.close(c.aug.savings, 16800 * 0.21, 0.01, 'C corp: rent deducted at the 21% corporate rate');

  const custom = run(fd('S-Corp', { __tax: { augustaDays: 20, augustaRate: 2000, payrollKids: 1, payrollWage: 10000 } }));
  t.equal(custom.aug.days, 14, 'rental days capped at 14 (fewer than 15, §280A(g))');
  t.close(custom.aug.rent, 28000, 0.01, 'entered daily rate used');
  t.equal(custom.pay.count, 1, 'entered number of children used');
  t.close(custom.pay.wages, 10000, 0.01, 'entered wage used');

  const young = run(fd('S-Corp', { children_ages: '3, 5' }));
  t.ok(!young.pay.applies && /aged 7–24/.test(young.pay.why), 'children under 7 aren\'t counted');
  const noBiz = run({ ...LA, w2_income: '300000', nw_view: 'simple', nw_real_estate: '900000', children: 'Yes', children_ages: '12' });
  t.ok(!noBiz.aug.applies && !noBiz.pay.applies, 'no business: neither applies');
});

suite('Site: QBI deduction, NIIT and RMD age (tax-law corrections)', (t) => {
  const TX = { filing_status: 'Married filing jointly', state: 'Texas', age: '55', has_business: 'Yes' };
  // $1.5M S corp income, no industry: assumed non-SSTB, wage limit not applied.
  // Taxable before QBI 1,500,000 − 32,200 = 1,467,800 → QBI deduction 20% × 1,467,800 = 293,560 (taxable-income cap).
  const a = analyze({ ...TX, business_income: '1500000', business_entity: 'S-Corp' });
  const none = a.comparison.blocks.base.scenarios.none;
  t.equal(a.model.profile.qbiType, 'nonsstb', 'no industry: not a specified service business');
  t.close(none.return.qbiDeduction, 293560, 0.01, 'QBI deduction in the baseline');
  // With $200k of business W-2 wages the deduction is limited to 50% × 200,000.
  const w = analyze({ ...TX, business_income: '1500000', business_entity: 'S-Corp', __tax: { qbiWages: 200000 } });
  t.close(w.comparison.blocks.base.scenarios.none.return.qbiDeduction, 100000, 0.01, 'W-2 wage limit');
  t.equal(analyze({ ...TX, business_income: '1500000', business_industry: 'Medical practice' }).model.profile.qbiType, 'sstb', 'medical practice: specified service');
  t.equal(analyze({ ...TX, business_income: '1500000', business_industry: 'Engineering' }).model.profile.qbiType, 'nonsstb', 'engineering: not a specified service');
  t.equal(analyze({ ...TX, business_income: '1500000', business_entity: 'C-Corp' }).model.profile.qbiType, 'none', 'C corp: no QBI');
  t.equal(analyze({ ...TX, business_income: '1500000', business_entity: 'Sole proprietorship' }).model.profile.businessType, 'scheduleC', 'sole proprietor pays SE tax');
  // The plan's strategies lower the QBI deduction (a deduction the client gets anyway).
  const fd = withAutoDb({ ...TX, business_income: '1500000', business_entity: 'S-Corp' });
  const P = planFor(fd);
  t.ok(P.plan.res.return.qbiDeduction < none.return.qbiDeduction, `the plan lowers the QBI deduction (${Math.round(none.return.qbiDeduction)} → ${Math.round(P.plan.res.return.qbiDeduction)})`);
  const P0 = planFor({ ...fd, __tax: { ...fd.__tax, qbiType: 'none' } });
  t.ok(P0.plan.savings > P.plan.savings, `QBI lowers the plan's savings (${Math.round(P.plan.savings)} vs ${Math.round(P0.plan.savings)} without QBI)`);
  // Intake questions: specified-service answer beats the industry guess; business W-2 wages feed the limit.
  t.equal(analyze({ ...TX, business_income: '1500000', business_industry: 'Medical practice', business_sstb: 'No' }).model.profile.qbiType, 'nonsstb', 'intake answer "No" overrides the industry guess');
  t.equal(analyze({ ...TX, business_income: '1500000', business_industry: 'Manufacturing', business_sstb: 'Yes' }).model.profile.qbiType, 'sstb', 'intake answer "Yes"');
  t.equal(analyze({ ...TX, business_income: '1500000', business_sstb: 'Not sure' }).model.profile.qbiType, 'nonsstb', '"Not sure" falls back to the industry guess');
  const iw = analyze({ ...TX, business_income: '1500000', business_entity: 'S-Corp', biz_w2_wages: '200,000' });
  t.close(iw.comparison.blocks.base.scenarios.none.return.qbiDeduction, 100000, 0.01, 'intake business W-2 wages apply the wage limit');
  t.close(analyze({ ...TX, business_income: '1500000', business_entity: 'S-Corp', biz_w2_wages: '200,000', __tax: { qbiWages: 400000 } }).comparison.blocks.base.scenarios.none.return.qbiDeduction, 200000, 0.01, 'Scenario options wages override the intake');
  // Solar in Texas with QBI: no spreadsheet "state saving" credit (there is no state tax).
  const sol = a.comparison.blocks.base.scenarios.solar;
  t.ok(!sol.situation.credits.some((c) => c.id === 'solar-spreadsheet'), 'Solar: no phantom credit in a no-tax state with QBI');
  // NIIT only on investment income: $600k wages + $100k interest → 3.8% × 100,000.
  t.close(analyze({ ...TX, w2_income: '600000', interest_income: '100000' }).comparison.blocks.base.scenarios.none.rows.niit, 3800, 0.01, 'NIIT = 3.8% × lesser of NII or MAGI over $250k');
  // Born 1971 (55 in 2026): RMDs start at 75.
  t.equal(a.comparison.roth.rmdStartAge, 75, 'RMDs start at 75 for anyone born 1960 or later');
});
