// The combined tax plan (src/site/plan.js): strategies computed together.
import { suite } from './harness.js';
import { analyze, planFor, withAutoDb, foundationResult } from '../src/site/tax-step.js';
import { computePlan, normalize, planSteps } from '../src/site/plan.js';

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
  t.equal(normalize(P.ctx, { adv: ['charitable', 'leap'] }).adv.join(','), 'leap,charitable', 'LEAP & Charitable is permitted');
  const c = planFor(client({ business_entity: 'C-Corp', biz_net_profit: '850000' }));
  const aug = computePlan(c.ctx, { ...none, augusta: true });
  t.close(aug.savings, aug.rent * 0.21, 0.01, 'C corp: Augusta rent deducted at 21% by the corporation');
  const noKids = planFor(client({ children: 'No', children_count: '', children_ages: '' }));
  t.equal(noKids.ctx.avail.payroll, false, 'no children: Family Payroll not offered');
  t.equal(noKids.sel.payroll, false, 'and not in the plan');
  const custom = planFor(client({ __tax: { ...client().__tax, plan: { db: true, augusta: false, payroll: true, adv: ['film'] } } }));
  t.ok(custom.custom && !custom.sel.augusta && custom.sel.adv[0] === 'film' || !custom.ctx.advAvail.includes('film'), 'a saved custom selection is used');
});
