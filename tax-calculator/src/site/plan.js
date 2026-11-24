// The client's tax plan: a mix of strategies computed together, not added up.
//
// Order of operations (each sees the effect of the ones before it):
//   1. Augusta Rule rent and Family Payroll wages (plus employer payroll tax) come out of business
//      income. For a C corp they're deducted by the corporation instead (21%), so the owner's
//      return is unchanged.
//   2. The DB plan contribution comes out of the (now lower) business income.
//   3. The Roth conversion, if any, is added to income.
//   4. The advanced strategy (or permitted pair) is sized against what's left.
// Additional deductions the advisor enters (e.g. cost segregation) come out first, with step 1:
// business ones from business income (the corporation's, for a C corp), personal ones from ordinary income.
// Savings = the block's no-planning baseline (from the client's own numbers; with a Roth
// conversion that includes tax on future IRA withdrawals) − the plan's total outlay
// (tax + strategy contributions + fees + payroll taxes + the children's own tax).
// With only one foundational strategy selected, the result equals that strategy on its own.

import { runComparison } from '../engine/compare.js';
import { cloneModel } from '../engine/model.js';

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const CORPORATE_RATE = 0.21;

/** The advisor's additional deductions (saved.deductions), cleaned: [{ kind, label, amount }]. */
export function deductionsOf(saved = {}) {
  return (Array.isArray(saved.deductions) ? saved.deductions : [])
    .map((d) => ({ kind: d.kind === 'personal' ? 'personal' : 'business', label: String(d.label || '').trim(), amount: Math.max(0, num(d.amount)) }))
    .filter((d) => d.amount > 0.5);
}

/** Advanced strategies that can be combined, keyed by their sorted ids → scenario id. */
const ADV_SETS = { '': 'none', film: 'film', solar: 'solar', charitable: 'charitable', leap: 'leap', 'charitable+leap': 'leapCharitable', 'charitable+solar': 'solarCharitable' };
const keyOf = (adv) => [...adv].sort().join('+');
export const scenarioFor = (adv) => (keyOf(adv) in ADV_SETS ? ADV_SETS[keyOf(adv)] : null);
export const ADV_ORDER = ['leap', 'charitable', 'solar', 'film'];
export const VALID_SETS = Object.keys(ADV_SETS).filter(Boolean).map((k) => k.split('+'));

const blockFor = (sel) => (sel.db && sel.roth ? 'dbRoth' : sel.db ? 'db' : sel.roth ? 'roth' : 'base');

let cmpCache = new Map();
function comparisonFor(model) {
  const key = JSON.stringify(model);
  if (!cmpCache.has(key)) {
    if (cmpCache.size > 12) cmpCache = new Map();
    cmpCache.set(key, runComparison(model));
  }
  return cmpCache.get(key);
}

/**
 * Everything the plan needs from the page: the analysis (a), the standalone Augusta / Payroll results,
 * and which advanced scenarios apply on their own (Set of scenario ids).
 */
export function planContext(fd, a, aug, pay, appliesSet) {
  const m = a.model;
  const entity = aug.entity;
  const profit = entity.kind === 'ccorp' ? Math.max(num(fd.biz_net_profit), +m.profile.businessIncome || 0) : +m.profile.businessIncome || 0;
  const ded = deductionsOf(fd.__tax || {});
  const avail = {
    ded: ded.length > 0,
    db: m.db.contribution > 0,
    augusta: !!aug.applies,
    payroll: !!pay.applies,
    roth: m.roth.conversion > 0,
  };
  const advAvail = ADV_ORDER.filter((id) => appliesSet.has(id));
  const setOk = (adv) => { const sc = scenarioFor(adv); return sc !== null && (sc === 'none' || appliesSet.has(sc)); };
  return { fd, a, aug, pay, entity, profit, avail, advAvail, setOk, ded };
}

/** Selection with anything unavailable or not permitted removed. */
export function normalize(ctx, sel = {}) {
  const adv = (Array.isArray(sel.adv) ? sel.adv : []).filter((id) => ctx.advAvail.includes(id));
  const advOk = ctx.setOk(adv) ? adv : [];
  return {
    ded: !!sel.ded && ctx.avail.ded,
    db: !!sel.db && ctx.avail.db,
    augusta: !!sel.augusta && ctx.avail.augusta,
    payroll: !!sel.payroll && ctx.avail.payroll,
    roth: !!sel.roth && ctx.avail.roth && advOk.length > 0, // a Roth conversion only alongside an advanced strategy
    adv: ADV_ORDER.filter((id) => advOk.includes(id)),
  };
}

/** Runs a plan. Returns { sel, block, scenario, res, baseline, savings, liability, rent, payDeduction, payrollCost, corpSavings }. */
export function computePlan(ctx, sel) {
  const { a, aug, pay, entity } = ctx;
  const m = cloneModel(a.model);
  const rent = sel.augusta ? aug.rent : 0;
  const payDeduction = sel.payroll ? Math.min(pay.wages + pay.employerTax, Math.max(0, ctx.profit - rent)) : 0;
  const payrollCost = sel.payroll ? pay.employerTax + pay.employeeTax + pay.childTax : 0;
  let corpSavings = 0;
  const ded = sel.ded ? ctx.ded : [];
  const bizDed = ded.filter((d) => d.kind === 'business').reduce((s, d) => s + d.amount, 0);
  if (ded.length) m.profile.extraDeductions = entity.kind === 'ccorp' ? ded.filter((d) => d.kind === 'personal') : ded;
  if (entity.kind === 'ccorp') corpSavings = (rent + payDeduction + Math.min(bizDed, Math.max(0, ctx.profit - rent - payDeduction))) * CORPORATE_RATE;
  else {
    m.profile.businessIncome = (+m.profile.businessIncome || 0) - rent - payDeduction;
    // Children's wages count toward the business's W-2 wages for the QBI wage limit (when known).
    if (sel.payroll && m.profile.qbiWages !== null && m.profile.qbiWages !== undefined) m.profile.qbiWages = +m.profile.qbiWages + Math.min(pay.wages, payDeduction);
  }
  const block = blockFor(sel);
  const scenario = scenarioFor(sel.adv) || 'none';
  const cmp = comparisonFor(m);
  const res = cmp.blocks[block].scenarios[scenario];
  const baseline = a.comparison.blocks[block].baseline;
  const outlay = res.rows.totalOutlay + payrollCost - corpSavings;
  const savings = baseline - outlay;
  // Liability shown to the client: tax + strategy contributions + payroll costs (fee kept apart, as elsewhere).
  const liability = outlay - res.rows.fee;
  return { sel, block, scenario, res, baseline, savings, liability, rent, payDeduction, payrollCost, corpSavings,
    businessIncomeLeft: (+a.model.profile.businessIncome || 0) - (entity.kind === 'ccorp' ? 0 : rent + payDeduction) };
}

/** The suggested plan: every foundational strategy that applies, plus the advanced mix that saves the most. */
export function recommendedPlan(ctx) {
  const base = { ded: ctx.avail.ded, db: ctx.avail.db, augusta: ctx.avail.augusta, payroll: ctx.avail.payroll, roth: false, adv: [] };
  let best = computePlan(ctx, base);
  for (const adv of VALID_SETS) {
    if (!ctx.setOk(adv) || !adv.every((id) => ctx.advAvail.includes(id))) continue;
    for (const roth of ctx.avail.roth ? [false, true] : [false]) {
      const p = computePlan(ctx, normalize(ctx, { ...base, adv, roth }));
      if (p.savings > best.savings + 0.5) best = p;
    }
  }
  return prune(ctx, best.sel);
}

export const STEP_LABEL = { ded: 'Additional deductions', db: 'DB plan', augusta: 'Augusta Rule', payroll: 'Family Payroll', roth: 'Roth conversion' };

/**
 * How much each part of the plan adds, in order: DB plan, Augusta Rule, Family Payroll, the advanced
 * strategy, then the Roth conversion. Steps sum to the plan's savings.
 */
export function planSteps(ctx, sel, labelOf) {
  const steps = [];
  let cur = { ded: false, db: false, augusta: false, payroll: false, roth: false, adv: [] };
  let prev = 0;
  const add = (key, label, next) => {
    const s = computePlan(ctx, next).savings;
    steps.push({ key, label, amount: s - prev });
    prev = s; cur = next;
  };
  for (const k of ['ded', 'db', 'augusta', 'payroll']) if (sel[k]) add(k, STEP_LABEL[k], { ...cur, [k]: true });
  if (sel.adv.length) add('adv', labelOf(scenarioFor(sel.adv)), { ...cur, adv: sel.adv });
  if (sel.roth) add('roth', STEP_LABEL.roth, { ...cur, roth: true });
  return steps;
}

/** Whether `id` can be ticked given the current advanced selection, and why not. */
export function advToggleState(ctx, sel, id, labelOf) {
  if (sel.adv.includes(id)) return { ok: true };
  const next = [...sel.adv, id];
  if (ctx.setOk(next)) return { ok: true };
  // A pair that isn't permitted: suggest swapping instead.
  const others = sel.adv.map((x) => labelOf(x)).join(' & ');
  return { ok: true, swap: true, why: `Replaces ${others}` };
}

// ------------------------------------------------------------------ attribution and pruning
const PLAYERS = ['ded', 'db', 'augusta', 'payroll', 'adv', 'roth'];
const membersOf = (sel) => PLAYERS.filter((k) => (k === 'adv' ? sel.adv.length > 0 : sel[k]));
const subsetSel = (sel, keys) => ({ ded: keys.includes('ded'), db: keys.includes('db'), augusta: keys.includes('augusta'), payroll: keys.includes('payroll'), roth: keys.includes('roth'), adv: keys.includes('adv') ? sel.adv : [] });

/**
 * Each strategy's share of the plan's savings, independent of the order they're applied in: its added
 * savings averaged over every order (Shapley value; the Roth conversion always after the advanced strategy). The shares add up to the plan's savings.
 * Returns [{ key, amount }] largest first.
 */
export function attribution(ctx, sel) {
  const keys = membersOf(sel);
  const memo = new Map();
  const S = (ks) => { const k = [...ks].sort().join(','); if (!memo.has(k)) memo.set(k, ks.length ? computePlan(ctx, subsetSel(sel, ks)).savings : 0); return memo.get(k); };
  const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  // A Roth conversion only counts alongside an advanced strategy, so it always comes after it.
  const all = perms(keys).filter((p) => !p.includes('roth') || p.indexOf('roth') > p.indexOf('adv'));
  const total = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const p of all) {
    const cur = [];
    for (const k of p) { const before = S(cur); cur.push(k); total[k] += S(cur) - before; }
  }
  return keys.map((k) => ({ key: k, amount: total[k] / all.length })).sort((a, b) => b.amount - a.amount);
}

/** Savings with vs. without one part of the plan (its effect on the overall tax liability). */
export function marginal(ctx, sel, key) {
  const keys = membersOf(sel);
  const without = keys.filter((k) => k !== key);
  return computePlan(ctx, normalize(ctx, subsetSel(sel, [...without, key]))).savings - computePlan(ctx, normalize(ctx, subsetSel(sel, without))).savings;
}

/** Drops any part of the plan that doesn't lower the overall tax liability (worst first, repeated). */
export function prune(ctx, sel) {
  let cur = normalize(ctx, sel);
  for (;;) {
    const parts = membersOf(cur).map((k) => ({ k, m: marginal(ctx, cur, k) })).filter((x) => x.m <= 0.5);
    if (!parts.length) return cur;
    const worst = parts.reduce((a, b) => (b.m < a.m ? b : a));
    cur = normalize(ctx, worst.k === 'adv' ? { ...cur, adv: [] } : { ...cur, [worst.k]: false });
  }
}

/** Whether toggling `key` (or advanced id) on would lower the overall tax liability. */
export function helps(ctx, sel, key, advId = null) {
  if (key === 'adv') {
    const next = ctx.setOk([...sel.adv, advId]) ? [...sel.adv, advId] : [advId];
    const with_ = computePlan(ctx, normalize(ctx, { ...sel, adv: next })).savings;
    const without = computePlan(ctx, normalize(ctx, { ...sel, adv: [] })).savings;
    return with_ > without + 0.5;
  }
  return marginal(ctx, { ...sel, [key]: true }, key) > 0.5;
}
