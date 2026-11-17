// The combined tax plan (src/site/plan.js): strategies computed together.
import { suite } from './harness.js';
import { analyze, planFor, withAutoDb, foundationResult } from '../src/site/tax-step.js';
import { computePlan, normalize, planSteps, attribution, prune, marginal, scenarioFor, ADV_ORDER } from '../src/site/plan.js';

const client = (extra = {}) => withAutoDb({
  filing_status: 'Married filing jointly', state: 'Louisiana', age: '52', w2_income: '150000', business_income: '850000', lt_cap_gains: '120000',
  has_business: 'Yes', business_entity: 'S-Corp', business_employees: '12', nw_view: 'simple', nw_real_estate: '1500000',
  children: 'Yes', children_count: '3', children_ages: '9, 14, 17', nw_tax_deferred: '900000', retirement_target_age: '62', ...extra,
});
const none = { db: false, augusta: false, payroll: false, roth: false, adv: [] };

suite('Plan: one strategy equals the strategy on its own', (t) => {
  const fd = client();
  const P = planFor(fd);
  t.close(computePlan(P.ctx, { ...none, augusta: true }).savings, P.aug.savings, 0.01, 'Augusta Rule alone');
  t.close(computePlan(P.ctx, { ...none, payroll: true }).savings, P.pay.savings, 0.01, 'Family Payroll alone');
  const db = foundationResult(analyze(fd).comparison, analyze(fd).model, 'db');
  t.close(computePlan(P.ctx, { ...none, db: true }).savings, db.savings, 0.01, 'DB plan alone');
  const leap = P.rows.find((r) => r.id === 'leap');
  t.close(computePlan(P.ctx, { ...none, adv: ['leap'] }).savings, leap.savings, 0.01, 'LEAP alone');
  t.close(computePlan(P.ctx, none).savings, 0, 0.01, 'empty plan saves nothing');
});

suite('Plan: strategies computed together', (t) => {
  const P = planFor(client());
  const all = { db: true, augusta: true, payroll: true, roth: false, adv: ['leap'] };
  const p = computePlan(P.ctx, all);
  const parts = [{ ...none, db: true }, { ...none, augusta: true }, { ...none, payroll: true }, { ...none, adv: ['leap'] }].map((s) => computePlan(P.ctx, s).savings);
  t.ok(p.savings > Math.max(...parts), `together (${Math.round(p.savings)}) beats any one (${Math.round(Math.max(...parts))})`);
  t.ok(p.savings < parts.reduce((s, x) => s + x, 0), 'together is less than the simple sum (no double counting)');
  const steps = planSteps(P.ctx, all, (id) => id);
  t.close(steps.reduce((s, x) => s + x.amount, 0), p.savings, 0.01, 'waterfall steps add up to the plan savings');
  t.equal(steps.map((s) => s.key).join(','), 'db,augusta,payroll,adv', 'steps in plan order');
  t.close(p.businessIncomeLeft, 850000 - p.rent - p.payDeduction, 0.01, 'rent and wages come out of business income first');
  t.ok(P.recPlan.savings >= p.savings - 0.01, 'recommended plan saves at least as much as the full manual mix');
});

suite('Plan: permitted combinations', (t) => {
  const P = planFor(client());
  t.equal(normalize(P.ctx, { roth: true, adv: [] }).roth, false, 'a Roth conversion needs an advanced strategy');
  t.equal(normalize(P.ctx, { adv: ['film', 'leap'] }).adv.length, 0, 'Film & LEAP is not a permitted pair');
  const open = { ...P.ctx, advAvail: ADV_ORDER, setOk: (adv) => scenarioFor(adv) !== null }; // every strategy available
  t.equal(normalize(open, { adv: ['charitable', 'leap'] }).adv.join(','), 'leap,charitable', 'LEAP & Charitable is permitted');
  const c = planFor(client({ business_entity: 'C-Corp', biz_net_profit: '850000' }));
  const aug = computePlan(c.ctx, { ...none, augusta: true });
  t.close(aug.savings, aug.rent * 0.21, 0.01, 'C corp: Augusta rent deducted at 21% by the corporation');
  const noKids = planFor(client({ children: 'No', children_count: '', children_ages: '' }));
  t.equal(noKids.ctx.avail.payroll, false, 'no children: Family Payroll not offered');
  t.equal(noKids.sel.payroll, false, 'and not in the plan');
  const custom = planFor(client({ __tax: { ...client().__tax, plan: { db: true, augusta: false, payroll: true, adv: ['film'] } } }));
  t.ok(custom.custom && !custom.sel.augusta && custom.sel.adv[0] === 'film' || !custom.ctx.advAvail.includes('film'), 'a saved custom selection is used');
});

suite('Plan: fair shares and nothing that hurts', (t) => {
  const P = planFor(client());
  const all = { db: true, augusta: true, payroll: true, roth: false, adv: ['leap'] };
  const sh = attribution(P.ctx, all);
  t.close(sh.reduce((s, x) => s + x.amount, 0), computePlan(P.ctx, all).savings, 0.01, 'shares add up to the plan savings');
  t.ok(sh.every((x, i) => i === 0 || sh[i - 1].amount >= x.amount), 'largest share first');
  const leap = sh.find((x) => x.key === 'adv').amount;
  const seq = planSteps(P.ctx, all, (id) => id).find((x) => x.key === 'adv').amount;
  t.ok(leap > seq, `LEAP's share (${Math.round(leap)}) isn't penalized for coming last (${Math.round(seq)})`);
  t.ok(P.shares.every((x) => x.amount > 0), 'every strategy in the recommended plan has a positive share');
  const rp = planFor(client({ __tax: { ...client().__tax, rothConversion: 900000, plan: { db: true, augusta: true, payroll: true, roth: true, adv: ['leap'] } } }));
  t.ok(rp.shares.every((x) => x.amount > 0), `with a Roth conversion every share is positive (${rp.shares.map((x) => x.key + ' ' + Math.round(x.amount)).join(', ')})`);
  const withRoth = client({ __tax: { ...client().__tax, rothConversion: 900000, plan: { db: true, roth: true, adv: [] } } });
  t.equal(planFor(withRoth).sel.roth, false, 'a Roth conversion without an advanced strategy is dropped');
  const p2 = prune(P.ctx, all);
  t.ok(['db', 'augusta', 'payroll', 'adv'].every((k) => !(k === 'adv' ? p2.adv.length : p2[k]) || marginal(P.ctx, p2, k) > 0.5), 'pruned plan: every part lowers the liability');
});
