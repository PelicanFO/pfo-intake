// "Tax strategies" step for the intake site (beta).
// Builds a calculator model from the client's intake answers, runs every strategy, and renders
// a comparison and a Detailed Results page. All tax math lives in ../engine.
//
// The site starts from the spreadsheet method (the PFO Tax Strategy Calculator's own math) with these
// tax-law corrections (engine/rules.js): the standard deduction (federal, or itemized if larger, plus
// the 65+ and senior deductions, and the state's standard deduction); capital gains stacked on top of
// ordinary income; NIIT on investment income only, included in every total; the QBI deduction (with
// the W-2 wage limit when business wages are entered) and self-employment / Additional Medicare tax;
// charitable deduction limits with carryforward; RMD start age by birth year; and strategy amounts
// that would come out negative are set to $0 instead of raising taxes.

import { runComparison } from '../engine/compare.js';
import { SCENARIOS } from '../engine/scenarios.js';
import { defaultModel } from '../engine/model.js';
import { ALL_OFF, normalizeRules } from '../engine/rules.js';
import { computeReturn } from '../engine/taxReturn.js';
import { STRATEGIES, defaultParams } from '../strategies/index.js';
import { stateCodeFor } from '../tables/states/index.js';
import { money, pct } from '../engine/ledger.js';
import { augustaRule, familyPayroll, FOUNDATIONAL_PARAMS, entityOf } from './foundational.js';
import { planContext, computePlan, recommendedPlan, scenarioFor, attribution, prune, normalize } from './plan.js';
import { beforeAfter, short, investChart, realisticPath, lineChart } from './charts.js';

export const SITE_RULES = {
  ...ALL_OFF, clampNegative: true, standardDeduction: true, stateStandardDeduction: true,
  capitalGainsStacking: true, niit: true, qbi: true, medicareSurtax: true, charitableLimits: true, rmdStartAge: true,
};

// Specified service trades or businesses (§199A(d)(2)): guessed from the intake's industry text.
// Engineering and architecture are excluded by statute; real estate and insurance are not SSTBs.
const SSTB_RE = /medic|physician|doctor|dental|dentist|orthodont|health|clinic|hospital|chiropract|therap|pharma|veterinar|nurs|\blaw\b|legal|attorney|accountan|\bcpa\b|tax prep|bookkeep|consult|financ|wealth|invest|advis|brokerage|actuar|athlet|perform|music|entertain/i;
export const QBI_LABEL = { nonsstb: 'Not a specified service business', sstb: 'Specified service business', none: 'No QBI deduction' };

/** QBI treatment for the client's business: { type, guessed, why }. */
export function qbiTreatment(fd = {}) {
  const saved = fd.__tax || {};
  if (saved.qbiType && QBI_LABEL[saved.qbiType]) return { type: saved.qbiType, guessed: false, why: 'set under Strategy assumptions' };
  const entity = entityOf(fd);
  if (entity.kind === 'ccorp') return { type: 'none', guessed: true, why: 'C corp income does not qualify' };
  if (fd.business_sstb === 'Yes') return { type: 'sstb', guessed: false, why: 'intake: specified service field' };
  if (fd.business_sstb === 'No') return { type: 'nonsstb', guessed: false, why: 'intake: not a specified service field' };
  const ind = String(fd.business_industry || '').trim();
  if (ind && SSTB_RE.test(ind)) return { type: 'sstb', guessed: true, why: `industry "${ind}" looks like a specified service` };
  return { type: 'nonsstb', guessed: true, why: ind ? `industry "${ind}"` : 'no industry in the intake' };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const commas = (n) => (n ? Math.round(n).toLocaleString('en-US') : '');
const FILING = { 'Married filing jointly': 'mfj', 'Single': 'single', 'Head of household': 'hoh', 'Married filing separately': 'mfs' };
const FILING_LABEL = { mfj: 'Married filing jointly', single: 'Single', hoh: 'Head of household', mfs: 'Married filing separately' };
const STRATEGY_BLURB = {
  film: 'Film production investment that passes through a deduction of several times the contribution.',
  solar: 'Solar project equity: energy tax credit plus first-year depreciation.',
  charitable: 'Gift of property appraised above its cost, deducted as a charitable contribution.',
  solarCharitable: 'Charitable gift down to the 24% bracket, then Solar against the remaining tax.',
  leap: 'Leveraged entity ownership: a negative K-1 that offsets business income and gains.',
  leapCharitable: 'LEAP first, then a charitable gift against the remaining income.',
};
const BLOCK_LABEL = { base: 'On its own', db: 'With DB plan', roth: 'With Roth conversion' };

// Strategy groups on the tax page. Foundational strategies stand alone: the DB plan (which can also be
// combined with an advanced strategy), the Augusta Rule and Family Payroll (./foundational.js).
// A Roth conversion, alone or with the DB plan, is only offered combined with an advanced strategy
// (on its own it rarely helps). Dual advanced strategies pair two advanced strategies.
export const FOUNDATIONAL = ['db'];
export const FOUNDATION = {
  db: { label: 'Defined Benefit Plan', short: 'DB plan', blurb: 'Tax-deductible contribution to a defined benefit (cash balance) plan, funded from business income. The money stays the client\'s.' },
  roth: { label: 'Roth Conversion', short: 'Roth conversion', blurb: 'Moves pre-tax retirement money to a Roth: tax is paid now instead of on withdrawals later, and future growth is tax-free.' },
  augusta: { label: 'Augusta Rule', short: 'Augusta Rule', blurb: 'The business rents the client\'s home for business meetings, up to 14 days a year. The business deducts the rent, and the client receives it tax-free (IRC §280A(g)).' },
  payroll: { label: 'Family Payroll', short: 'Family payroll', blurb: 'The business pays the client\'s children reasonable wages for real work, up to the standard deduction, so the children owe no federal income tax and the business deducts the wages.' },
  ded: { label: 'Additional Deductions', short: 'Additional deductions', blurb: 'Deductions the advisor adds for this year, such as cost segregation or equipment purchases.' },
  dbRoth: { label: 'DB Plan + Roth Conversion', short: 'DB plan + Roth conversion', blurb: 'Both in the same year: the DB contribution lowers this year\'s income, so the Roth conversion is taxed at lower rates.' },
};
const hasDb = (b) => b === 'db' || b === 'dbRoth';
const hasRoth = (b) => b === 'roth' || b === 'dbRoth';
export const ADVANCED = ['film', 'charitable', 'solar', 'leap'];
export const COMBINED = ['leapCharitable', 'solarCharitable'];
const amountOf = (model, kind) => (kind === 'db' ? model.db.contribution : kind === 'roth' ? model.roth.conversion : model.db.contribution + model.roth.conversion);
const amountText = (model, kind) => (kind === 'dbRoth' ? `${money(model.db.contribution)} + ${money(model.roth.conversion)}` : money(amountOf(model, kind)));

/** A foundational strategy on its own: { kind, amount, savings, liability, baseline, pct }. */
export function foundationResult(cmp, model, kind) {
  const blk = cmp.blocks[kind];
  const r = blk.scenarios.none;
  return { kind, amount: amountOf(model, kind), savings: r.savings, liability: liabilityOf(r), baseline: blk.baseline, pct: blk.baseline > 0 ? r.savings / blk.baseline : 0 };
}

// ------------------------------------------------------------------ intake → model
export function intakeToModel(fd = {}) {
  const saved = fd.__tax || {};
  const notes = [];
  const m = defaultModel();
  const p = m.profile;

  let fs = FILING[fd.filing_status];
  if (!fs) {
    fs = fd.marital === 'Married' ? 'mfj' : 'single';
    notes.push({ text: `Filing status not entered — assumed ${FILING_LABEL[fs].toLowerCase()}.`, section: 'personal' });
  }
  p.filingStatus = fs;

  const stateName = String(fd.state || '').trim() || 'Louisiana';
  if (!fd.state) notes.push({ text: 'State not entered — assumed Louisiana.', section: 'personal' });
  const code = stateCodeFor(stateName);
  p.state = code;
  const income = num(fd.w2_income) + num(fd.business_income) + num(fd.st_cap_gains) + num(fd.lt_cap_gains)
    + num(fd.interest_income) + num(fd.qualified_dividends) + num(fd.nonqualified_dividends) + num(fd.other_income);
  let stateRate = null, stateRateSource = null;
  if (code === 'CUSTOM') {
    if (saved.stateRate !== undefined && saved.stateRate !== null && saved.stateRate !== '') {
      stateRate = +saved.stateRate; stateRateSource = 'entered';
    } else if (num(fd.state_tax_liability) > 0 && income > 0) {
      stateRate = num(fd.state_tax_liability) / income; stateRateSource = 'intake';
    }
    p.stateCustom = { rate: stateRate || 0, name: stateName };
  } else if (code === 'NONE') {
    p.stateCustom = { name: stateName };
  }

  p.age = num(fd.age) || null;
  p.spouseAge = fs === 'mfj' && num(fd.spouse_age) ? num(fd.spouse_age) : null;
  Object.assign(p, {
    w2: num(fd.w2_income), businessIncome: num(fd.business_income), stcg: num(fd.st_cap_gains), ltcg: num(fd.lt_cap_gains),
    interest: num(fd.interest_income), qualifiedDividends: num(fd.qualified_dividends), nonqualifiedDividends: num(fd.nonqualified_dividends),
    otherIncome: num(fd.other_income), planningFee: num(saved.planningFee),
  });
  // Business type: sole proprietors pay self-employment tax; QBI treatment from the intake or the advisor.
  p.businessType = entityOf(fd).kind === 'sole' ? 'scheduleC' : 'passthrough';
  const qbi = qbiTreatment(fd);
  p.qbiType = qbi.type;
  // Business W-2 wages (for the QBI wage limit): Strategy assumptions, else the intake; blank = limit not applied.
  const wagesSaved = saved.qbiWages !== undefined && saved.qbiWages !== null && saved.qbiWages !== '';
  p.qbiWages = wagesSaved ? num(saved.qbiWages) : num(fd.biz_w2_wages) > 0 ? num(fd.biz_w2_wages) : null;
  m.db.contribution = num(saved.dbContribution);
  m.roth.conversion = num(saved.rothConversion);
  m.roth.retirementAge = num(fd.retirement_target_age) || 65;
  // No age entered: left blank so the 65+ deductions aren't applied (the Roth projection assumes 65).
  if (!p.age) notes.push({ text: 'Age not entered — 65+ deductions not applied; the Roth projection assumes age 65.', section: 'personal' });
  const params = defaultParams();
  // The charitable gift is limited to 50% of AGI (v1.15.3; 30% before).
  params.charitable.giftType = 'property50';
  for (const [sid, vals] of Object.entries(saved.params || {})) if (params[sid]) Object.assign(params[sid], vals);
  m.params = params;
  m.rules = { ...SITE_RULES };
  // Film is sized to fill the 12% bracket in every block (the workbook's DB / Roth blocks default to a
  // 100% income offset, which over-sizes it once QBI and the standard deduction are counted).
  const fill12 = { film: { film: { offset: { fillToBracket: 0.12 } } } };
  m.sizing = { ...m.sizing, db: { ...fill12, ...(m.sizing.db || {}) }, roth: { ...fill12, ...(m.sizing.roth || {}) }, dbRoth: { ...fill12, ...(m.sizing.dbRoth || {}) } };
  return { model: m, notes, stateName, stateCode: code, stateRate, stateRateSource, income, qbi };
}

// ------------------------------------------------------------------ results
const cache = new Map(); // last few comparisons (existing clients' plans also run a 30%-charitable pass)
export function analyze(fd) {
  const built = intakeToModel(fd);
  const key = JSON.stringify(built.model);
  let value = cache.get(key);
  if (!value) {
    value = runComparison(built.model);
    cache.set(key, value);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
  }
  return { ...built, comparison: value };
}

function blocksFor(model) {
  const db = model.db.contribution > 0, roth = model.roth.conversion > 0;
  return ['base', ...(db ? ['db'] : []), ...(roth ? ['roth'] : []), ...(db && roth ? ['dbRoth'] : [])];
}

// "Total tax liability" = tax + strategy contribution (what the client pays out). The planning fee is
// kept out of it; it still reduces savings and is shown on its own when entered.
const liabilityOf = (r) => r.rows.totalOutlay - r.rows.fee;

function strategyRows(cmp, block) {
  const blk = cmp.blocks[block];
  const none = blk.scenarios.none;
  return SCENARIOS.filter((s) => s.id !== 'none').map((s) => {
    const r = blk.scenarios[s.id];
    // A strategy applies if it costs something or changes the tax (the planning fee alone doesn't count).
    const applies = Math.abs(r.rows.contribution) > 0.5 || Math.abs(r.rows.totalTax - none.rows.totalTax) > 0.5;
    return { id: s.id, label: s.label, r, applies, savings: r.savings, liability: liabilityOf(r), pct: blk.baseline > 0 ? r.savings / blk.baseline : 0 };
  }).sort((a, b) => (b.applies - a.applies) || (b.savings - a.savings));
}

// ------------------------------------------------------------------ suggestions (DB plan, Roth conversion)
/** Pre-tax retirement balance from the intake (financial statement rows, or the simplified-view field). */
export function taxDeferredBalance(fd = {}) {
  const sheet = Array.isArray(fd.nw_sheet) ? fd.nw_sheet : [];
  if (sheet.length && fd.nw_view !== 'simple') {
    const v = sheet.filter((r) => !/roth/i.test(r.label || '') && /pre-tax|401|403|457|\bira\b|deferred|\bsep\b/i.test(r.label || ''))
      .reduce((s, r) => s + num(r.value), 0);
    if (v > 0) return v;
  }
  return num(fd.nw_tax_deferred);
}

const bestSavings = (blk) => Math.max(0, ...SCENARIOS.filter((s) => s.id !== 'none').map((s) => blk.scenarios[s.id].savings));
const bestLabel = (blk) => SCENARIOS.filter((s) => s.id !== 'none').reduce((b, s) => (blk.scenarios[s.id].savings > blk.scenarios[b.id].savings ? s : b), SCENARIOS[1]).label;
const round = (x, step) => Math.round(x / step) * step;
const floorTo = (x, step) => Math.floor(x / step) * step;

// Sizing knobs for the suggestions. Amounts scale with the client; these only bound them.
export const SIZING = {
  // Largest first-year DB (cash balance) contribution for one participant, by age, with the funding
  // front-loaded (about 1.5× a level annual contribution under the 2026 §415(b) benefit limit).
  // Actual figures come from the plan actuary.
  dbMaxByAge: [[40, 150000], [45, 200000], [50, 260000], [55, 340000], [60, 430000], [65, 500000], [Infinity, 525000]],
  dbAgeUnknown: 55,          // size as if 50–54 when the intake has no age
  dbShareOfBusiness: 0.9,    // the plan is funded from business income
  dbMin: 25000,
  rothMin: 25000,
  rothYearCap: { floor: 1000000, incomeMultiple: 2 }, // one year's conversion: up to max($1M, 2× income)
  // Keep adding while each extra dollar still saves at least this much:
  dbMarginalFloor: 0.12,     // DB: 12¢ of tax per extra dollar contributed
  rothMarginalFloor: 0.05,   // Roth paired with a strategy: 5¢ per extra dollar converted
};

export function dbMaxForAge(age) {
  const a = num(age) || SIZING.dbAgeUnknown - 1;
  return SIZING.dbMaxByAge.find(([below]) => a < below)[1];
}

/**
 * Walks amounts upward and keeps the largest one that is still efficient: each added dollar must save
 * at least `floor` (the first pick is judged on its average rate). Returns { c, s } or null.
 */
function largestEfficient(amounts, savingsAt, floor) {
  let pick = null;
  for (const c of amounts) {
    const s = savingsAt(c);
    const rate = pick ? (s - pick.s) / (c - pick.c) : s / c;
    if (rate >= floor) pick = { c, s };
    else if (pick) break;
  }
  return pick;
}

let suggestCache = { key: null, value: null };

/**
 * When a DB plan contribution or Roth conversion looks worthwhile under the calculator's own model,
 * returns short suggestions: [{ kind: 'db'|'roth', amount, savings, text }]. Amounts scale with the
 * client and are as large as they stay efficient (see SIZING):
 *   DB plan: needs business income. Tries amounts up to the smaller of the front-loaded age-based limit
 *     and 90% of business income; keeps the largest amount where each extra dollar still saves 12¢. Shown
 *     when it lowers this year's tax by > $2,500.
 *   Roth conversion: needs a pre-tax retirement balance. Tries amounts up to the balance (one year
 *     capped at max($1M, 2× income)). Standalone, the best amount is the one that saves the most
 *     versus paying the projected rate on later withdrawals. Paired with a strategy, it is the
 *     largest amount where each extra dollar converted still adds 5¢. Suggests the paired amount when it
 *     saves more, and notes the standalone figure.
 */
/**
 * The suggested DB contribution { amount, savings, text } (as if none were entered), or null.
 * Sized as described above suggestions().
 */
export function dbSuggestion(fd = {}) {
  const saved = { ...(fd.__tax || {}), dbContribution: 0 };
  const base = analyze({ ...fd, __tax: saved });
  const p = base.model.profile;
  if (base.income <= 0 || p.businessIncome < 50000) return null;
  const baseTax = base.comparison.blocks.base.scenarios.none.rows.totalTax;
  const cap = floorTo(Math.min(dbMaxForAge(fd.age), p.businessIncome * SIZING.dbShareOfBusiness), 5000);
  const amounts = [];
  const dbStep = cap > 300000 ? 50000 : 25000;
  for (let c = SIZING.dbMin; c < cap; c += dbStep) amounts.push(c);
  if (cap >= SIZING.dbMin) amounts.push(cap);
  const pick = largestEfficient(amounts, (c) =>
    baseTax - analyze({ ...fd, __tax: { ...saved, dbContribution: c } }).comparison.blocks.db.scenarios.none.rows.totalTax, SIZING.dbMarginalFloor);
  if (!pick || pick.s <= 2500) return null;
  const has = fd.business_defined_benefit === 'Yes';
  return { amount: pick.c, savings: pick.s, text: has
    ? `Given the business's defined benefit plan, consider adding this year's contribution. About ${money(pick.c)} would lower tax by roughly ${money(pick.s)}.`
    : `Given ${money(p.businessIncome)} of business income, consider adding a defined benefit plan contribution. About ${money(pick.c)} would lower tax by roughly ${money(pick.s)}, and the money stays the client's.` };
}

let autoDbCache = { key: null, value: null };
/**
 * The DB plan is applied automatically: when no contribution has been entered (field never set),
 * the suggested amount is used. An entered amount, including 0 to turn it off, always wins.
 */
export function withAutoDb(fd = {}) {
  const saved = fd.__tax || {};
  if (saved.dbContribution !== undefined && saved.dbContribution !== null && saved.dbContribution !== '') return fd;
  const key = JSON.stringify(fd);
  if (autoDbCache.key !== key) autoDbCache = { key, value: dbSuggestion(fd) };
  const s = autoDbCache.value;
  return s ? { ...fd, __tax: { ...saved, dbContribution: s.amount, dbAuto: true } } : fd;
}

export function suggestions(fd = {}) {
  const key = JSON.stringify(fd);
  if (suggestCache.key === key) return suggestCache.value;
  const value = computeSuggestions(fd);
  suggestCache = { key, value };
  return value;
}

function computeSuggestions(fd) {
  const saved = fd.__tax || {};
  const base = analyze(fd);
  if (base.income <= 0) return [];
  const out = [];
  const p = base.model.profile;

  if (!num(saved.dbContribution)) {
    const db = dbSuggestion(fd);
    if (db) out.push({ kind: 'db', ...db });
  }

  const balance = taxDeferredBalance(fd);
  if (!num(saved.rothConversion) && balance >= 25000) {
    const yearCap = Math.max(SIZING.rothYearCap.floor, base.income * SIZING.rothYearCap.incomeMultiple);
    const top = Math.min(balance, yearCap);
    const step = top > 2000000 ? 50000 : top > 500000 ? 25000 : 5000;
    const amounts = [...new Set([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
      .map((f) => (f === 1 ? floorTo(top, 5000) : round(top * f, step))))].filter((c) => c >= SIZING.rothMin);
    // With a DB plan in place, size the conversion on top of it (DB + Roth vs. DB alone).
    const withDb = num(saved.dbContribution) > 0;
    const rb = withDb ? 'dbRoth' : 'roth';
    const ref = base.comparison.blocks[withDb ? 'db' : 'base'];
    const refBest = bestSavings(ref);
    const refAlone = ref.baseline - ref.scenarios.none.rows.totalTax;
    const runs = new Map();
    const at = (c) => {
      if (!runs.has(c)) {
        const a = analyze({ ...fd, __tax: { ...saved, rothConversion: c } });
        const blk = a.comparison.blocks[rb];
        runs.set(c, { c, alone: blk.baseline - blk.scenarios.none.rows.totalTax - refAlone, paired: bestSavings(blk) - refBest, label: bestLabel(blk), rate: a.model.roth.projectedTaxRate });
      }
      return runs.get(c);
    };
    const alone = amounts.map(at).reduce((b, t) => (t.alone > b.alone ? t : b), at(amounts[0]));
    const pairedPick = largestEfficient(amounts, (c) => at(c).paired, SIZING.rothMarginalFloor);
    const paired = pairedPick && at(pairedPick.c);
    const later = (c) => (balance - c >= SIZING.rothMin ? ` That leaves ${money(balance - c)} to convert in later years.` : '');
    if (paired && paired.paired > 5000 && paired.paired > alone.alone + 1000) {
      const solo = alone.alone > 2000 ? ` On its own, ${money(alone.c)} is the most efficient conversion (saves about ${money(alone.alone)} versus paying ${pct(alone.rate, 0)} on withdrawals later).` : '';
      out.push({ kind: 'roth', amount: paired.c, savings: paired.paired, text: `Given ${money(balance)} in pre-tax retirement accounts, consider a Roth conversion paired with ${paired.label}${withDb ? ' on top of the DB plan' : ''}. Converting about ${money(paired.c)} this year would add roughly ${money(paired.paired)} in savings versus not converting${withDb ? ' (beyond the DB plan with ' + paired.label + ')' : ''}.${solo}${later(paired.c)}` });
    } else if (alone.alone > 2000) {
      out.push({ kind: 'roth', amount: alone.c, savings: alone.alone, text: `Given ${money(balance)} in pre-tax retirement accounts, consider adding a Roth conversion. Converting about ${money(alone.c)} this year would save roughly ${money(alone.alone)} versus paying ${pct(alone.rate, 0)} on those withdrawals later.${later(alone.c)}` });
    }
  }
  return out;
}
/**
 * Compact summary for the internal email and the priorities prompt. Null without income.
 * strategies: foundational (on their own, when an amount is entered), then advanced, then combined;
 * each row has a `group`. scenarios: the best advanced strategy combined with each foundational one.
 */
export function taxSummary(fd = {}) {
  fd = withAutoDb(fd);
  const a = analyze(fd);
  if (a.income <= 0) return null;
  const cmp = a.comparison;
  const base = strategyRows(cmp, 'base').filter((r) => r.applies);
  const found = blocksFor(a.model).filter((b) => FOUNDATIONAL.includes(b)).map((b) => {
    const f = foundationResult(cmp, a.model, b);
    return { group: 'Foundational', label: `${FOUNDATION[b].label} (${amountText(a.model, b)})`, savings: f.savings, pct: f.pct, liabilityAfter: f.liability };
  });
  for (const x of [augustaRule(fd, a.model, fd.__tax || {}), familyPayroll(fd, a.model, fd.__tax || {})]) {
    if (!x.applies) continue;
    const label = x.id === 'augusta' ? `Augusta Rule (${x.days} days × ${money(x.rate)})` : `Family Payroll (${x.count} × ${money(x.wage)})`;
    found.push({ group: 'Foundational', label, savings: x.savings, pct: x.savings / Math.max(1, x.before), liabilityAfter: x.before - x.savings });
  }
  const row = (group) => (r) => ({ group, label: r.label, savings: r.savings, pct: r.pct, liabilityAfter: r.liability });
  const scenarios = blocksFor(a.model).filter((b) => b !== 'base').map((b) => {
    const r = strategyRows(cmp, b).find((x) => x.applies);
    return r ? { label: `${FOUNDATION[b].short} (${amountText(a.model, b)}) combined with ${r.label}`, strategy: r.label, savings: r.savings, pct: r.pct } : null;
  }).filter(Boolean);
  const top = base.find((r) => r.savings > 0.5);
  const P = planFor(fd);
  // Nothing selected yet: the recommended plan (computed here, so the email never shows "no plan" just
  // because no one has picked strategies on the tax page).
  const useRec = P.mode === 'none';
  const pSel = useRec ? P.rec : P.sel, pPlan = useRec ? P.recPlan : P.plan;
  const planNamesList = planNames(pSel);
  return {
    plan: planNamesList.length && pPlan.savings > 0.5 ? { label: planNamesList.join(' + '), savings: pPlan.savings, pct: pPlan.savings / Math.max(1, pPlan.baseline), custom: P.mode === 'custom' } : null,
    liability: cmp.blocks.base.baseline,
    strategies: [
      ...found,
      ...base.filter((r) => ADVANCED.includes(r.id)).map(row('Advanced')),
      ...base.filter((r) => COMBINED.includes(r.id)).map(row('Dual Advanced')),
    ],
    best: top ? { label: top.label, savings: top.savings, pct: top.pct } : null,
    scenarios,
    suggestions: suggestions(fd).map((s) => s.text),
  };
}

// ------------------------------------------------------------------ the client's plan
const labelOfScenario = (id) => (SCENARIOS.find((s) => s.id === id) || {}).label || id;
const ADV_LABEL = { film: 'Film', solar: 'Solar', charitable: 'Charitable', leap: 'LEAP' };

export const EMPTY_SEL = Object.freeze({ ded: false, db: false, augusta: false, payroll: false, roth: false, adv: [] });
const sameSel = (x, y) => ['ded', 'db', 'augusta', 'payroll', 'roth'].every((k) => !!x[k] === !!y[k]) && [...x.adv].sort().join() === [...y.adv].sort().join();
const isEmptySel = (x) => !x.ded && !x.db && !x.augusta && !x.payroll && !x.roth && !x.adv.length;

/**
 * The tax plan for the page: the strategies the advisor selected (saved.plan; nothing until they pick
 * or choose the recommended plan), plus the recommended mix (every foundational strategy that applies
 * plus the advanced mix that saves the most) and, for every strategy, what it adds to the selection.
 * mode: 'none' (nothing selected), 'recommended' (selection = recommended plan) or 'custom'.
 * fd should already have the automatic DB plan applied (withAutoDb).
 */
export function planFor(fd) {
  const a = analyze(fd);
  const saved = fd.__tax || {};
  const aug = augustaRule(fd, a.model, saved), pay = familyPayroll(fd, a.model, saved);
  const rows = strategyRows(a.comparison, 'base');
  const appliesSet = new Set(rows.filter((r) => r.applies && r.savings > 0.5).map((r) => r.id));
  const ctx = planContext(fd, a, aug, pay, appliesSet);
  // No saved selection: new clients (selectMode, set when created after v1.15.0) start empty; earlier
  // clients keep the recommended plan they have always shown. That plan is still picked with the 30%
  // charitable limit it was built with, so the 50% limit (v1.15.3) changes its figures, not its strategies.
  const legacy = !saved.plan && !saved.selectMode;
  const rec = legacy ? legacyRecommended(fd) : recommendedPlan(ctx);
  // Anything that doesn't lower the overall tax liability is left out, even if it was selected.
  const sel = saved.plan ? prune(ctx, saved.plan) : saved.selectMode ? normalize(ctx, EMPTY_SEL) : rec;
  const plan = computePlan(ctx, sel);
  const shares = attribution(ctx, sel).map((s) => ({ ...s, label: partLabel(s.key, sel) }));
  const recPlan = computePlan(ctx, rec);
  const mode = isEmptySel(sel) ? 'none' : sameSel(sel, rec) ? 'recommended' : 'custom';
  const P = { a, aug, pay, rows, ctx, rec, sel, plan, shares, steps: shares, recPlan, mode, custom: mode === 'custom' };
  P.choices = choicesFor(P);
  return P;
}

// The recommended plan as picked before v1.15.3, with the charitable gift limited to 30% of AGI.
function legacyRecommended(fd) {
  const saved = fd.__tax || {};
  const params = { ...(saved.params || {}), charitable: { giftType: 'property', ...(saved.params?.charitable || {}) } };
  const f = { ...fd, __tax: { ...saved, params } };
  const a = analyze(f);
  const aug = augustaRule(f, a.model, f.__tax), pay = familyPayroll(f, a.model, f.__tax);
  const rows = strategyRows(a.comparison, 'base');
  const appliesSet = new Set(rows.filter((r) => r.applies && r.savings > 0.5).map((r) => r.id));
  return recommendedPlan(planContext(f, a, aug, pay, appliesSet));
}

/**
 * Every strategy that can be selected, with what it's worth given the current selection:
 * selected → its share of the plan's savings; not selected → the savings it would add (with the swap
 * when it can't be paired with the selected advanced strategy). Computed up front, so a figure is
 * always shown. [{ key, id, group, label, on, amount, ok, inRec, hint }]
 */
function choicesFor(P) {
  const { ctx, sel, plan, shares, rec } = P;
  const shareOf = (k) => { const x = shares.find((y) => y.key === k); return x ? x.amount : 0; };
  const gain = (next) => computePlan(ctx, normalize(ctx, next)).savings - plan.savings;
  const out = [];
  if (ctx.avail.ded) {
    const on = sel.ded;
    out.push({ key: 'ded', group: 'Deductions', label: FOUNDATION.ded.label, on, amount: on ? shareOf('ded') : gain({ ...sel, ded: true }), ok: true, inRec: rec.ded });
  }
  for (const k of ['db', 'augusta', 'payroll']) {
    if (!ctx.avail[k]) continue;
    const on = sel[k];
    out.push({ key: k, group: 'Foundational', label: FOUNDATION[k].label, on, amount: on ? shareOf(k) : gain({ ...sel, [k]: true }), ok: true, inRec: rec[k] });
  }
  for (const id of ctx.advAvail) {
    const on = sel.adv.includes(id);
    const fits = on || ctx.setOk([...sel.adv, id]);
    const next = fits ? [...sel.adv, id] : [id];
    out.push({ key: `adv:${id}`, id, group: 'Advanced', label: ADV_LABEL[id], on, ok: true, inRec: rec.adv.includes(id),
      amount: on ? (sel.adv.length === 1 ? shareOf('adv') : null) : gain({ ...sel, adv: next }),
      hint: fits ? '' : `Replaces ${sel.adv.map((x) => ADV_LABEL[x]).join(' & ')}` });
  }
  if (ctx.avail.roth) {
    const on = sel.roth;
    const ok = sel.adv.length > 0;
    out.push({ key: 'roth', group: 'Foundational', label: FOUNDATION.roth.label, on, ok, inRec: rec.roth,
      amount: on ? shareOf('roth') : ok ? gain({ ...sel, roth: true }) : null, hint: ok ? '' : 'Needs an advanced strategy' });
  }
  return out;
}

const partLabel = (key, sel) => (key === 'adv' ? labelOfScenario(scenarioFor(sel.adv)) : FOUNDATION[key].label);

/** Names of the strategies in a plan selection. */
export function planNames(sel) {
  const out = [];
  if (sel.ded) out.push(FOUNDATION.ded.label);
  if (sel.db) out.push(FOUNDATION.db.label);
  if (sel.augusta) out.push(FOUNDATION.augusta.label);
  if (sel.payroll) out.push(FOUNDATION.payroll.label);
  if (sel.adv.length) out.push(labelOfScenario(scenarioFor(sel.adv)));
  if (sel.roth) out.push(FOUNDATION.roth.label);
  return out;
}

// Client-facing descriptions (second person). CLIENT_BLURB: detail pages; ONE_LINE: the plan summary.
const CLIENT_BLURB = {
  db: 'A pension-style retirement plan funded by your business. Contributions are deductible and the money stays yours.',
  augusta: 'Your business rents your home for business meetings, up to 14 days a year. The business deducts the rent and you receive it tax-free (IRC §280A(g)).',
  payroll: 'Your business pays your children fair wages for real work. Up to the standard deduction they owe no federal income tax, and the business deducts the wages.',
  roth: 'Moves pre-tax retirement money to a Roth: tax is paid now, at lower rates, and future growth and withdrawals are tax-free.',
};
const ONE_LINE = {
  db: 'Business-funded retirement plan. Contributions are deductible and stay yours.',
  augusta: 'Your business rents your home for meetings. Deductible to it, tax-free to you.',
  payroll: 'Your business pays your children for real work. Their wages are largely untaxed.',
  roth: 'Converts pre-tax IRA money to a Roth while the other deductions keep the rate low.',
  ded: 'Deductions for this year, such as cost segregation, taken against your income.',
  film: 'Film production investment with a deduction several times the amount invested.',
  solar: 'Solar project equity: an energy tax credit plus depreciation.',
  charitable: 'A gift of property, deducted at its appraised value.',
  leap: 'Entity investment whose K-1 loss offsets business income and gains.',
  leapCharitable: 'LEAP, then a charitable gift against the income that remains.',
  solarCharitable: 'A charitable gift, then solar credits against the remaining tax.',
};

const yearsToRetire = (fd) => {
  const age = num(fd.age), ret = num(fd.retirement_target_age);
  return age && ret > age ? Math.max(5, Math.min(30, ret - age)) : 15;
};
const IRA_LIMIT = 7500; // 2026 IRA contribution limit (under 50)

/** Plain steps for the walkthrough, with the client's numbers (from the plan's own calculation). */
function walkSteps(key, P, fd) {
  const { a, aug, pay, plan, sel } = P;
  const m = a.model;
  const retAge = num(fd.retirement_target_age);
  if (key === 'ded') return P.ctx.ded.map((d) => `${d.label || (d.kind === 'business' ? 'Business deduction' : 'Personal deduction')}: ${money(d.amount)} deducted from ${d.kind === 'business' ? (aug.entity.kind === 'ccorp' ? 'the corporation\'s income' : 'business income') : 'your ordinary income'}.`);
  if (key === 'db') return [
    `Your business contributes ${money(m.db.contribution)} to your defined benefit plan.`,
    'The contribution is deducted from business income.',
    `The money stays in your account, invested${retAge ? ` for retirement at ${retAge}` : ''}.`];
  if (key === 'augusta') return [
    `Your ${aug.entity.label} rents your home for ${aug.days} meeting days at ${money(aug.rate)} a day.`,
    `The business deducts the ${money(aug.rent)} of rent.`,
    'You receive the rent tax-free (IRC §280A(g)).'];
  if (key === 'payroll') return [
    `Your business pays ${pay.count === 1 ? 'your child' : `your ${pay.count} children`} ${money(pay.wage)}${pay.count === 1 ? '' : ' each'} for real work.`,
    `The ${money(pay.wages)} of wages is deducted by the business.`,
    pay.wage <= pay.stdSingle ? 'The wages fall within each child\'s standard deduction: no federal income tax.' : 'Wages above the standard deduction are taxed at the child\'s low rates.',
    `Each child can put up to ${money(Math.min(pay.wage, IRA_LIMIT))} a year in a Roth IRA.`];
  if (key === 'roth') return [
    `You convert ${money(m.roth.conversion)} of pre-tax retirement savings to a Roth.`,
    `${labelOfScenario(scenarioFor(sel.adv))} offsets much of the added income, so it's taxed at lower rates.`,
    'Future growth and withdrawals are tax-free.'];
  // Advanced strategy (or pair): from the plan's own return.
  const r = plan.res, sit = r.situation;
  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
  const losses = sum(sit.businessLosses) + sum(sit.capitalLosses);
  const gifts = sum(sit.charitable);
  const credit = r.return.creditAllowed || 0;
  const acct = r.rows.investmentAccount;
  const lossWord = sel.adv.includes('leap') ? 'K-1 loss' : sel.adv.includes('film') ? 'deduction' : 'depreciation';
  return [
    r.rows.contribution > 0.5 ? `You put in ${money(r.rows.contribution)}, including fees.` : '',
    losses > 0.5 ? `A ${money(losses)} ${lossWord} passes through against your income.` : '',
    gifts > 0.5 ? `A charitable gift is deducted at its appraised ${money(gifts)}.` : '',
    credit > 0.5 ? `A ${money(credit)} energy credit lowers tax dollar for dollar.` : '',
    acct > 0.5 ? `${money(acct)} stays ${sel.adv.includes('leap') ? 'in your Asset Management LLC account' : 'in an investment account in your name'}.` : '',
  ].filter(Boolean);
}

/** Where a plan part's detail page is. */
function detailAttrs(key, P) {
  const { sel, plan } = P;
  if (key === 'ded') return '';
  if (key === 'db') return 'data-tx-detail="none" data-tx-detail-block="db"';
  if (key === 'augusta' || key === 'payroll') return `data-tx-detail="${key}" data-tx-detail-block="base"`;
  return `data-tx-detail="${scenarioFor(sel.adv)}" data-tx-detail-block="${plan.block}"`;
}

// ------------------------------------------------------------------ step page
/**
 * @param root     container element
 * @param fd       intake form data (read-only here; tax inputs are saved via handlers.save)
 * @param handlers { save(taxInputs), editIntake(sectionId), openDetail(scenarioId, block), clientName }
 */
export function renderTaxStep(root, fd, handlers) {
  const saved = { ...(fd.__tax || {}) };
  root.innerHTML = `<div id="tx-head"></div><div class="tx-layout"><div id="tx-results"></div><aside class="tx-aside"><div id="tx-builder"></div><div id="tx-options"></div></aside></div>`;
  const headEl = root.querySelector('#tx-head');
  const resultsEl = root.querySelector('#tx-results');
  const builderEl = root.querySelector('#tx-builder');
  const optionsEl = root.querySelector('#tx-options');

  const effective = () => withAutoDb({ ...fd, __tax: saved });
  const draw = () => {
    const f = effective();
    const a = analyze(f);
    headEl.innerHTML = docHeadHTML(a, handlers.clientName);
    if (a.income <= 0) {
      resultsEl.innerHTML = `<section class="tx-card tx-empty"><h3>No income entered yet</h3>
        <p>Add the client's prior-year income in the intake to build the tax plan.</p>
        <button type="button" class="btn btn-primary btn-sm" data-tx-edit="income">Go to Income</button></section>`;
      builderEl.innerHTML = '';
      return;
    }
    const P = planFor(f);
    const tips = suggestions(f);
    resultsEl.innerHTML = resultsHTML(P, tips, f);
    builderEl.innerHTML = builderHTML(P, tips);
  };
  const drawOptions = () => { const f = effective(); optionsEl.innerHTML = optionsHTML(intakeToModel(f), f.__tax || {}, fd); };
  const built = intakeToModel(effective());
  drawOptions();
  draw();

  let t;
  optionsEl.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.txDed) {
      const [i, field] = el.dataset.txDed.split(':');
      const list = saved.deductions = (saved.deductions || []).map((d) => ({ ...d }));
      if (!list[+i]) return;
      list[+i][field] = field === 'amount' ? num(el.value) : el.value;
      clearTimeout(t);
      t = setTimeout(() => { draw(); handlers.save({ ...saved }); }, 250);
      return;
    }
    const key = el.dataset.tax;
    if (!key) return;
    if (key.startsWith('param:')) {
      const [, sid, pk, kind] = key.split(':');
      saved.params = saved.params || {};
      saved.params[sid] = saved.params[sid] || {};
      if (el.value === '') delete saved.params[sid][pk];
      else saved.params[sid][pk] = kind === 'pct' ? num(el.value) / 100 : num(el.value);
    } else if (key === 'stateRate') {
      saved.stateRate = el.value === '' ? null : num(el.value) / 100;
    } else if (key === 'qbiType') {
      if (el.value) saved.qbiType = el.value; else delete saved.qbiType;
    } else if (['augustaDays', 'augustaRate', 'payrollKids', 'payrollWage', 'qbiWages'].includes(key) && el.value.trim() === '') {
      delete saved[key]; // blank = estimated from the intake
    } else {
      saved[key] = num(el.value);
    }
    clearTimeout(t);
    t = setTimeout(() => { draw(); handlers.save({ ...saved }); }, 250);
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('[data-tx-plan]')) {
      const P = planFor(effective());
      const sel = { ...P.sel, adv: [...P.sel.adv] };
      const k = el.dataset.txPlan;
      if (k.startsWith('adv:')) {
        const id = k.slice(4);
        if (el.checked) sel.adv = P.ctx.setOk([...sel.adv, id]) ? [...sel.adv, id] : [id];
        else sel.adv = sel.adv.filter((x) => x !== id);
      } else sel[k] = el.checked;
      saved.plan = sel;
      draw(); handlers.save({ ...saved });
      return;
    }
    if (el.matches('[data-tx-aml]')) { setAml(el); draw(); }
  });
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-tx-detail]')) { e.preventDefault(); e.target.click(); }
  });
  root.onclick = (e) => {
    if (e.target.closest('label, input, textarea, summary')) return;
    const g = e.target.closest('[data-tx-gtab]');
    if (g) { growthTab = g.dataset.txGtab; draw(); return; }
    if (e.target.closest('[data-tx-recommended]')) { const P = planFor(effective()); saved.plan = { ...P.rec, adv: [...P.rec.adv] }; draw(); handlers.save({ ...saved }); return; }
    if (e.target.closest('[data-tx-clear]')) { saved.plan = { ...EMPTY_SEL, adv: [] }; draw(); handlers.save({ ...saved }); return; }
    const add = e.target.closest('[data-tx-add]');
    if (add) {
      const P = planFor(effective());
      const sel = { ...P.sel, adv: [...P.sel.adv] };
      const k = add.dataset.txAdd;
      if (k.startsWith('adv:')) { const id = k.slice(4); sel.adv = P.ctx.setOk([...sel.adv, id]) ? [...sel.adv, id] : [id]; } else sel[k] = true;
      saved.plan = sel; draw(); handlers.save({ ...saved }); return;
    }
    const ap = e.target.closest('[data-tx-apply]');
    if (ap) {
      const [kind, amount] = ap.dataset.txApply.split(':');
      const key = kind === 'db' ? 'dbContribution' : 'rothConversion';
      saved[key] = +amount;
      if (saved.plan) saved.plan = { ...saved.plan, [kind]: true };
      const input = optionsEl.querySelector(`[data-tax="${key}"]`);
      if (input) input.value = commas(+amount);
      draw(); handlers.save({ ...saved });
      return;
    }
    if (e.target.closest('[data-tx-ded-add]')) {
      saved.deductions = [...(saved.deductions || []), { kind: 'business', label: '', amount: 0 }];
      // Entered deductions go in the plan (a client with no saved plan and no selection yet starts one).
      if (saved.plan) saved.plan = { ...saved.plan, ded: true };
      else if (saved.selectMode) saved.plan = { ...EMPTY_SEL, adv: [], ded: true };
      drawOptions(); draw(); handlers.save({ ...saved });
      const rows = optionsEl.querySelectorAll('[data-tx-ded$=":label"]');
      if (rows.length) rows[rows.length - 1].focus();
      return;
    }
    const del = e.target.closest('[data-tx-ded-del]');
    if (del) {
      saved.deductions = (saved.deductions || []).filter((_, i) => i !== +del.dataset.txDedDel);
      if (!saved.deductions.length) delete saved.deductions;
      drawOptions(); draw(); handlers.save({ ...saved }); return;
    }
    if (e.target.closest('[data-tx-autodb]')) { delete saved.dbContribution; drawOptions(); draw(); handlers.save({ ...saved }); return; }
    const d = e.target.closest('[data-tx-detail]');
    if (d) { handlers.openDetail(d.dataset.txDetail, d.dataset.txDetailBlock || 'base'); return; }
    const ed = e.target.closest('[data-tx-edit]');
    if (ed) { handlers.editIntake(ed.dataset.txEdit); return; }
    const reset = e.target.closest('[data-tx-reset]');
    if (reset) {
      delete saved.params;
      delete saved.planningFee;
      for (const k of ['augustaDays', 'augustaRate', 'payrollKids', 'payrollWage', 'qbiType', 'qbiWages']) delete saved[k];
      drawOptions();
      draw(); handlers.save({ ...saved });
    }
  };
  return { hasResults: built.income > 0 };
}

function profileChips(a) {
  const p = a.model.profile;
  const chips = [
    ['Filing status', FILING_LABEL[p.filingStatus]],
    ['State', a.stateName],
    ['W-2 income', p.w2], ['Business income', p.businessIncome], ['Short-term gains', p.stcg], ['Long-term gains', p.ltcg],
    ['Interest', p.interest], ['Qualified dividends', p.qualifiedDividends], ['Non-qualified dividends', p.nonqualifiedDividends],
    ['Other income', p.otherIncome],
    ['QBI', p.businessIncome > 0 ? QBI_LABEL[p.qbiType] : ''], ['Business W-2 wages', p.businessIncome > 0 && p.qbiType !== 'none' ? p.qbiWages || 0 : 0],
  ].filter(([, v]) => v);
  return chips.map(([k, v]) => `<div class="tx-chip"><span>${esc(k)}</span><b>${typeof v === 'number' ? money(v) : esc(v)}</b></div>`).join('');
}

const pctOf = (x) => `${(Math.round(x * 1000) / 10).toFixed(1).replace(/\.0$/, '')}%`;
let growthTab = null;

/** What the Augusta Rule / Family Payroll need in practice (detail page). */
function extraRequirements(x) {
  const ent = x.entity.known ? '' : ' Entity type not entered — treated as an S corp.';
  return x.id === 'augusta'
    ? `Needs real business meetings at the home on each rental day, a written rental agreement and minutes, and rent at a fair local rate (comparable venue or short-term rental quotes). Must be rented fewer than 15 days in total for the year.${ent}`
    : `Needs real, age-appropriate work, a reasonable wage for it, timesheets, and wages paid through payroll with a W-2. Children aged ${FOUNDATIONAL_PARAMS.childMinAge}–${FOUNDATIONAL_PARAMS.childMaxAge} from the intake; assumes they have no other income. They can put the wages in a Roth IRA.${ent}`;
}

const section = (title, body, opts = {}) => `<section class="tx-card tx-group ${opts.cls || ''}">
  <div class="tx-card-head"><h3>${esc(title)}</h3>${opts.right || ''}</div>${body}</section>`;

function docHeadHTML(a, clientName) {
  const p = a.model.profile;
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const notes = a.notes.map((n) => `<li>${esc(n.text)} <button type="button" class="tx-link" data-tx-edit="${n.section}">Edit</button></li>`).join('');
  return `<header class="tx-doc">
    <div class="tx-doc-top">
      <div><div class="tx-doc-eyebrow">Pelican Family Office</div>
        <h2 class="tx-doc-title">Tax Plan</h2>
        <div class="tx-doc-meta">${clientName ? `<span>Prepared for <b>${esc(clientName)}</b></span>` : ''}<span>${esc(date)}</span><span>${esc(FILING_LABEL[p.filingStatus])}</span><span>${esc(a.stateName)}</span></div></div>
      <details class="tx-doc-profile"><summary>Inputs</summary>
        <div class="tx-chips">${profileChips(a)}</div>
        <button type="button" class="tx-link" data-tx-edit="income">Edit income</button>
      </details>
    </div>
    ${notes ? `<ul class="tx-notes">${notes}</ul>` : ''}
    ${a.stateCode === 'CUSTOM' && !a.stateRate ? `<p class="tx-warn">Enter ${esc(a.stateName)}'s income tax rate under Scenario options to include state tax.</p>` : ''}
  </header>`;
}

// Visuals used on the Augusta / Family Payroll detail pages.
function augustaVisual(x) {
  const cells = Array.from({ length: 14 }, (_, i) => `<i class="${i < x.days ? 'on' : ''}"></i>`).join('');
  return `<div class="tx-viz tx-viz-aug"><div class="tx-cal" role="img" aria-label="${x.days} of 14 days">${cells}</div>
    <div class="tx-flow"><span class="fl-node">Your business</span><span class="fl-arrow">${money(x.rent)} rent →<small>deductible</small></span><span class="fl-node fl-you">You<small>tax-free</small></span></div></div>`;
}
function payrollVisual(x) {
  const kids = Array.from({ length: x.count }, (_, i) => {
    const pc = x.perChild ? x.perChild[i] : null;
    return `<div class="tx-kid"><span class="tx-kid-ic" aria-hidden="true">${pc && pc.age !== null ? pc.age : '?'}</span><div><b>${money(x.wage)}</b><small>${pc && pc.age !== null ? `age ${pc.age}` : 'age not entered'} · $0 federal tax</small></div></div>`;
  }).join('');
  return `<div class="tx-viz tx-kids">${kids}</div>`;
}

/** Two bars: the tax liability before and after the plan. */
function liabilityBars(plan, roth) {
  const w = (v) => `${Math.max(0.5, Math.max(0, v) / Math.max(1, plan.baseline) * 100)}%`;
  return `<div class="tx-lbars" role="img" aria-label="Tax liability ${money(plan.baseline)} before, ${money(plan.liability)} after">
      <div class="tx-lbr"><span>${roth ? 'Without converting' : 'Current liability'}</span><div class="tx-lbr-track"><i class="lb-before" style="width:${w(plan.baseline)}"></i></div><b>${money(plan.baseline)}</b></div>
      <div class="tx-lbr"><span>With the plan</span><div class="tx-lbr-track"><i class="lb-after" style="width:${w(plan.liability)}"></i></div><b>${money(plan.liability)}</b></div>
    </div>`;
}

function resultsHTML(P, tips, fd) {
  const { a, aug, pay, rows, sel, plan, shares } = P;
  const { model, comparison: cmp } = a;
  const roth = hasRoth(plan.block);
  const hasPlan = shares.length > 0 && plan.savings > 0.5;

  if (!hasPlan && P.recPlan.savings > 0.5) return pickHTML(P);
  if (!hasPlan) {
    return `<section class="tx-hero tx-hero-none"><div><div class="tx-hero-label">Estimated tax savings</div>
        <div class="tx-hero-value">—</div><div class="tx-hero-sub">None of the modeled strategies lower the tax liability at this income.</div></div>
        <div class="tx-hero-side"><div><span>Tax liability</span><b>${money(cmp.blocks.base.baseline)}</b></div></div></section>`;
  }

  // ---- Plan summary: the number, the bar, and one line per strategy.
  const effBefore = plan.baseline / a.income, effAfter = plan.liability / a.income;
  const red = plan.savings / Math.max(1, plan.baseline);
  const hero = `<section class="tx-hero tx-plan-hero">
      <div class="tx-plan-top">
        <div><div class="tx-hero-label">Estimated tax savings · ${model.year}</div>
          <div class="tx-hero-value">${money(plan.savings)}</div>
          <div class="tx-hero-red">${pctOf(red)} lower tax liability</div></div>
        ${roth ? '' : `<div class="tx-hero-stats"><div><span>Effective rate</span><b>${pctOf(effBefore)} → ${pctOf(effAfter)}</b></div></div>`}
      </div>
      ${liabilityBars(plan, roth)}
    </section>`;
  const summary = section('Your strategies', `<div class="tx-sumlist">
      <div class="tx-sum tx-sum-head"><span>Strategy</span><span></span><span class="tx-sum-h">Savings</span><span></span></div>
      ${shares.map((s) => `<div class="tx-sum${s.key === 'ded' ? ' tx-static' : ''}" ${s.key === 'ded' ? '' : `role="button" tabindex="0" ${detailAttrs(s.key, P)}`}>
        <b class="tx-sum-name">${esc(s.label)}</b>
        <span class="tx-sum-desc">${esc(ONE_LINE[s.key === 'adv' ? scenarioFor(sel.adv) : s.key])}</span>
        <b class="tx-sum-amt">${money(s.amount)}</b><span class="tx-sum-go" aria-hidden="true">${s.key === 'ded' ? '' : '›'}</span></div>`).join('')}
      <div class="tx-sum tx-sum-total"><b class="tx-sum-name">Total savings</b><span class="tx-sum-desc">${roth ? 'Compared with not converting, including tax on future IRA withdrawals.' : ''}</span><b class="tx-sum-amt">${money(plan.savings)}</b><span></span></div>
    </div>`, { cls: 'tx-summary', right: '<span class="tx-card-sub">Click a strategy for the full calculation</span>' });

  // ---- Walkthrough: how each one works, with the client's numbers.
  const walk = section('How it works', `<div class="tx-walk">${shares.map((s) => `<div class="tx-step${s.key === 'ded' ? ' tx-static' : ''}" ${s.key === 'ded' ? '' : `role="button" tabindex="0" ${detailAttrs(s.key, P)}`}>
      <div class="tx-step-head"><b>${esc(s.label)}</b><span>${money(s.amount)}</span></div>
      <ol>${walkSteps(s.key, P, fd).map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>`).join('')}</div>`);

  // ---- Also considered: strategies that help on their own but aren't in the plan.
  const planSc = scenarioFor(sel.adv);
  const alt = [];
  const db = foundationResult(cmp, model, 'db');
  if (!sel.db && db.amount > 0 && db.savings > 0.5) alt.push({ name: FOUNDATION.db.label, key: 'db', sav: db.savings, attrs: 'data-tx-detail="none" data-tx-detail-block="db"' });
  if (!sel.augusta && aug.applies) alt.push({ name: FOUNDATION.augusta.label, key: 'augusta', sav: aug.savings, attrs: 'data-tx-detail="augusta" data-tx-detail-block="base"' });
  if (!sel.payroll && pay.applies) alt.push({ name: FOUNDATION.payroll.label, key: 'payroll', sav: pay.savings, attrs: 'data-tx-detail="payroll" data-tx-detail-block="base"' });
  for (const r of rows) {
    if (!r.applies || r.savings <= 0.5 || r.id === planSc || !(ADVANCED.includes(r.id) || COMBINED.includes(r.id))) continue;
    alt.push({ name: r.label, key: r.id, sav: r.savings, attrs: `data-tx-detail="${r.id}" data-tx-detail-block="base"` });
  }
  alt.sort((x, y) => y.sav - x.sav);
  const also = alt.length ? section('Also considered', `<div class="tx-sumlist tx-alt"><div class="tx-sum tx-sum-head"><span>Strategy</span><span></span><span class="tx-sum-h">Savings on its own</span><span></span></div>${alt.map((x) => `<div class="tx-sum" role="button" tabindex="0" ${x.attrs}>
      <b class="tx-sum-name">${esc(x.name)}</b><span class="tx-sum-desc">${esc(ONE_LINE[x.key])}</span><b class="tx-sum-amt">${money(x.sav)}</b><span class="tx-sum-go" aria-hidden="true">›</span></div>`).join('')}</div>`) : '';

  return `${hero}${summary}${walk}${growthSectionHTML(P, fd)}${also}
    <p class="tx-foot">${model.year} federal rates with the standard deduction, capital gains stacking, NIIT, QBI, self-employment tax and charitable limits. Each strategy's amount is its share of the combined savings, averaged over every order the strategies could be applied in. Estimates for discussion, not tax advice; growth figures are illustrations, not guarantees.</p>`;
}

/** Nothing selected yet: each strategy's savings on its own, and the recommended plan one click away. */
function pickHTML(P) {
  const { recPlan, rec } = P;
  const hero = `<section class="tx-hero tx-pick-hero"><div>
      <div class="tx-hero-label">Current tax liability</div>
      <div class="tx-hero-value">${money(recPlan.baseline)}</div>
      <div class="tx-hero-sub">Recommended plan: ${esc(planNames(rec).join(' + '))}</div>
      <button type="button" class="btn btn-sm tx-hero-btn" data-tx-recommended>Use recommended plan</button></div></section>`;
  const list = P.choices.filter((c) => c.ok && c.amount !== null && c.amount > 0.5).sort((x, y) => y.amount - x.amount);
  const body = `<div class="tx-sumlist tx-pick-list"><div class="tx-sum tx-sum-head"><span>Strategy</span><span></span><span class="tx-sum-h">Savings on its own</span><span></span></div>
    ${list.map((c) => `<div class="tx-sum">
      <b class="tx-sum-name">${esc(c.label)}</b>
      <span class="tx-sum-desc">${esc(ONE_LINE[c.id || c.key] || '')}</span>
      <b class="tx-sum-amt">${money(c.amount)}</b>
      <button type="button" class="btn btn-sm tx-add-btn" data-tx-add="${c.key}" aria-label="Add ${esc(c.label)}">+ Add</button></div>`).join('')}</div>`;
  return `${hero}${section('Available strategies', body)}
    <p class="tx-foot">Estimates for discussion, not tax advice.</p>`;
}

// ------------------------------------------------------------------ plan builder (right column)
function builderHTML(P, tips) {
  const { ctx, sel, plan, mode, recPlan } = P;
  const fig = (c) => {
    if (c.on) return c.amount === null ? '' : `<b>${short(c.amount)}</b>`;
    if (!c.ok || c.amount === null) return '';
    if (c.amount > 0.5) return `<b class="inc">+${short(c.amount)}</b>`;
    return c.hint && c.amount < -0.5 ? `<b class="muted">${short(c.amount)}</b>` : '<b class="muted">no added savings</b>';
  };
  const check = (c) => {
    // A swap (advanced strategy that can't be paired) stays selectable even when it saves less.
    const off = !c.on && (!c.ok || c.amount === null || (c.amount <= 0.5 && !(c.hint && c.amount < -0.5)));
    return `<label class="tx-check${off ? ' is-off' : ''}">
      <input type="checkbox" data-tx-plan="${c.key}"${c.on ? ' checked' : ''}${off ? ' disabled' : ''}>
      <span class="tx-check-box" aria-hidden="true"></span><span class="tx-check-label">${esc(c.label)}${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</span>${fig(c)}</label>`;
  };
  const ded = P.choices.filter((c) => c.group === 'Deductions').map(check);
  const found = P.choices.filter((c) => c.group === 'Foundational').map(check);
  const adv = P.choices.filter((c) => c.group === 'Advanced').map(check);
  const rothTip = !ctx.avail.roth && tips.find((t) => t.kind === 'roth');
  const pairShare = sel.adv.length > 1 ? (P.shares.find((x) => x.key === 'adv') || {}).amount : null;
  const badge = mode === 'recommended' ? '<span class="tx-badge">Recommended</span>' : mode === 'custom' ? '<span class="tx-badge custom">Custom</span>' : '<span class="tx-badge none">Nothing selected</span>';
  const total = mode === 'none'
    ? `<div class="tx-builder-total"><b>$0</b><small>Current liability ${money(recPlan.baseline)}</small></div>`
    : `<div class="tx-builder-total"><b>${money(Math.max(0, plan.savings))}</b><small>${money(plan.baseline)} → ${money(plan.liability)}</small></div>`;
  return `<section class="tx-card tx-builder">
    <div class="tx-builder-head"><h3>Select strategies</h3>${badge}</div>
    ${total}
    <p class="tx-builder-sub">Selected: share of the plan's savings. Not selected: what it would add.</p>
    ${ded.length ? `<div class="tx-bgroup">Deductions</div>${ded.join('')}` : ''}
    ${found.length ? `<div class="tx-bgroup">Foundational</div>${found.join('')}` : ''}
    ${rothTip ? `<button type="button" class="tx-addline" data-tx-apply="roth:${Math.round(rothTip.amount)}">+ Add a ${short(rothTip.amount)} Roth conversion</button>` : ''}
    ${adv.length ? `<div class="tx-bgroup">Advanced${pairShare != null ? ` <span>${esc(labelOfScenario(scenarioFor(sel.adv)))} <b>${short(pairShare)}</b></span>` : ''}</div>${adv.join('')}` : ''}
    <div class="tx-builder-actions">
      ${mode !== 'recommended' && recPlan.savings > 0.5 ? `<button type="button" class="btn btn-sm btn-primary" data-tx-recommended>Use recommended plan</button>` : ''}
      ${mode !== 'none' ? '<button type="button" class="btn btn-sm" data-tx-clear>Clear</button>' : ''}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ growth over time
// One contribution this year (no repeats) and the tax it saves, both invested at a steady 6%, 7% or 8% a year.
const GROUP_CLS = ['ic-a', 'ic-b', 'ic-c'];

function investBlock({ years, groups, xLabel = null }) {
  const gs = groups.filter((g) => g.amount > 0.5).map((g, i) => ({ ...g, cls: GROUP_CLS[i] }));
  if (!gs.length) return '';
  const lab = xLabel || ((t) => (t ? `${t} yrs` : 'Today'));
  const ms = [...new Set([Math.round(years / 2), years])];
  const at = (g, r, t) => g.amount * realisticPath(r, years)[t];
  const cell = (g, t) => `<td><b>${money(at(g, 0.07, t))}</b><small>${short(at(g, 0.06, t))}–${short(at(g, 0.08, t))}</small></td>`;
  return `<div class="tx-gwrap"><div class="tx-gchart">${investChart({ years, groups: gs, xLabel: lab })}
      <div class="gc-legend">${gs.map((g) => `<span><i class="ic-key ${g.cls}"></i>${esc(g.label)}</span>`).join('')}<span class="ic-note">Line 7% · band 6–8%</span></div></div>
    <div class="tx-table-wrap tx-gtable"><table class="tx-compare tx-growth tx-itable"><thead><tr><th></th><th>Today</th>${ms.map((t) => `<th>${esc(lab(t))}</th>`).join('')}</tr></thead><tbody>
      ${gs.map((g) => `<tr><th scope="row"><i class="ic-key ${g.cls}"></i>${esc(g.label)}</th><td><b>${money(g.amount)}</b></td>${ms.map((t) => cell(g, t)).join('')}</tr>`).join('')}
      ${gs.length > 1 ? `<tr class="sub"><th scope="row">Together</th><td><b>${money(gs.reduce((s, g) => s + g.amount, 0))}</b></td>${ms.map((t) => `<td><b>${money(gs.reduce((s, g) => s + at(g, 0.07, t), 0))}</b></td>`).join('')}</tr>` : ''}
    </tbody></table></div></div>`;
}

const kidsRothOnce = (pay) => Math.min(pay.wage, IRA_LIMIT) * pay.count;

/** The growth views for a plan: [{ id, label, sub, html }]. share(key) = that strategy's tax savings. */
function growthViews(P, fd, share = (k) => { const s = (P.shares || []).find((x) => x.key === k); return s ? s.amount : 0; }) {
  const { a, sel, plan, pay } = P;
  const model = a.model;
  const out = [];
  const age = num(fd.age), retAge = num(fd.retirement_target_age);
  const toRet = age && retAge > age ? Math.max(10, Math.min(30, retAge - age)) : 20;
  const ageLabel = age ? (t) => (t ? `Age ${age + t}` : 'Today') : null;
  const view = (id, label, sub, years, groups, xl = null) => out.push({ id, label, sub, html: investBlock({ years, groups, xLabel: xl }) });
  const custom = (id, label, sub, html) => out.push({ id, label, sub, html, own: true });
  if (sel.db) {
    const c = model.db.contribution, s = share('db');
    view('db', 'Owner\'s benefit plan', `${money(c)} contributed once this year by your business (a deductible expense), plus the ${money(s)} it saves in tax, both invested${retAge ? ` to age ${retAge}` : ''}.`, toRet,
      [{ label: 'Plan contribution', amount: c }, { label: 'Tax savings', amount: s }], ageLabel);
  }
  const lf = sel.adv.includes('leap') && plan.res && plan.res.situation ? leapFacts(plan.res, a) : null;
  if (lf && lf.acct > 0.5) {
    const g = amlGrowth({ ...lf, savings: share('adv') });
    custom('leap', 'LEAP', g.sub, g.html);
  }
  if (sel.roth) {
    view('roth', 'Roth conversion', `${money(model.roth.conversion)} converted once this year and growing tax-free, plus the ${money(share('roth'))} of tax savings.`, 20,
      [{ label: 'Roth account', amount: model.roth.conversion }, { label: 'Tax savings', amount: share('roth') }]);
  }
  if (sel.payroll) {
    view('kids', 'Children\'s Roth IRAs', `${money(Math.min(pay.wage, IRA_LIMIT))} per child put in a Roth IRA once this year, plus the ${money(share('payroll'))} of tax savings.`, 20,
      [{ label: 'Children\'s Roth IRAs', amount: kidsRothOnce(pay) }, { label: 'Tax savings', amount: share('payroll') }]);
  }
  if (plan.savings > 0.5 && P.shares) {
    view('savings', 'Total tax savings', `This year's ${money(plan.savings)} of tax savings, invested once.`, toRet, [{ label: 'Tax savings', amount: plan.savings }], ageLabel);
  }
  return out;
}

function growthSectionHTML(P, fd) {
  const views = growthViews(P, fd);
  if (!views.length) return '';
  const v = views.find((x) => x.id === growthTab) || views[0];
  const tabs = views.length > 1 ? `<div class="tx-gtabs" role="tablist">${views.map((x) => `<button type="button" role="tab" data-tx-gtab="${x.id}" aria-selected="${x.id === v.id}">${esc(x.label)}</button>`).join('')}</div>` : '';
  return section('Growth over time', `<p class="tx-gsub">${esc(v.sub)}</p>${v.html}
    <p class="tx-gnote">${v.own ? 'Illustration at a steady return. Actual returns will vary.' : 'Illustration at a steady 6%, 7% (line) and 8% a year. Actual returns will vary.'}</p>`, { cls: 'tx-growth-card', right: tabs });
}

function naReason(r) {
  if (r.id.startsWith('leap')) return 'No business income or long-term gains to offset.';
  if (r.id === 'film') return 'Taxable income is already within the 12% bracket.';
  if (r.id.startsWith('solar')) return 'No federal tax to offset.';
  return '';
}

function simplifyWarning(w) {
  if (/Charitable donation came out negative/.test(w)) return 'Charitable portion doesn\'t apply below the 24% bracket.';
  if (/credit is more than/.test(w)) return 'Part of the credit carries forward to future years.';
  if (/over the AGI limit/.test(w)) return 'Part of the gift carries forward to future years.';
  if (/LEAP does not apply/.test(w)) return 'LEAP portion doesn\'t apply: no business income or long-term gains.';
  if (/LEAP business-income K-1 came out negative/.test(w)) return 'LEAP portion doesn\'t apply.';
  return w;
}

function optionsHTML(built, saved, fd) {
  const m = built.model;
  const field = (key, label, value, hint, kind = 'money') => `<label class="tx-field"><span>${esc(label)}</span>
    <span class="tx-input tx-${kind}"><input type="text" inputmode="decimal" data-tax="${key}" ${kind === 'money' ? 'data-money' : ''} value="${esc(value)}" placeholder="0"></span>
    ${hint ? `<small>${hint}</small>` : ''}</label>`;
  const taxDeferred = taxDeferredBalance(fd);
  let html = `<section class="tx-card tx-options"><h3>Scenario options</h3>`;
  if (built.stateCode === 'CUSTOM') {
    const v = saved.stateRate !== undefined && saved.stateRate !== null ? +(saved.stateRate * 100).toFixed(3) : (built.stateRate ? +(built.stateRate * 100).toFixed(2) : '');
    html += field('stateRate', `${built.stateName} income tax rate`, v, built.stateRateSource === 'intake' ? 'Estimated from the prior-year state tax in the intake.' : 'Approximate flat rate on income.', 'pct');
  }
  const dbHint = saved.dbAuto ? 'Set automatically from business income and age. Change it, or enter 0 for none.'
    : m.profile.businessIncome > 0 ? `Foundational strategy. <button type="button" class="tx-link" data-tx-autodb>Use the suggested amount</button>` : 'Funded from business income; none in the intake.';
  html += field('dbContribution', 'DB plan contribution', commas(m.db.contribution), dbHint);
  html += field('rothConversion', 'Roth conversion', commas(m.roth.conversion), taxDeferred ? `Pre-tax retirement balance in the intake: ${money(taxDeferred)}.` : 'Foundational strategy; can be combined with an advanced strategy.');
  html += deductionsEditorHTML(saved);
  const aug = augustaRule(fd, m, saved);
  const pay = familyPayroll(fd, m, saved);
  const plain = (key, label, value, placeholder, hint, kind = '') => `<label class="tx-field tx-field-sm"><span>${esc(label)}</span>
    <span class="tx-input ${kind}"><input type="text" inputmode="decimal" data-tax="${key}" ${kind === 'tx-money' ? 'data-money' : ''} value="${esc(value)}" placeholder="${esc(placeholder)}"></span>
    ${hint ? `<small>${hint}</small>` : ''}</label>`;
  const set = (k) => saved[k] !== undefined && saved[k] !== null && saved[k] !== '';
  html += `<details class="tx-assume"><summary>Strategy assumptions</summary>`;
  html += `<label class="tx-field tx-field-sm"><span>Planning fee</span><span class="tx-input tx-money"><input type="text" inputmode="decimal" data-tax="planningFee" data-money value="${esc(commas(m.profile.planningFee))}" placeholder="0"></span></label>`;
  html += `<small class="tx-assume-hint">Subtracted from each strategy's savings.</small>`;
  if (m.profile.businessIncome > 0) {
    const q = built.qbi;
    html += `<div class="tx-assume-title">QBI deduction</div><label class="tx-field tx-field-sm"><span>Business type</span><span class="tx-input"><select data-tax="qbiType">
      <option value="">Auto: ${esc(QBI_LABEL[q.guessed ? q.type : qbiTreatment({ ...fd, __tax: {} }).type].toLowerCase())}</option>
      ${Object.entries(QBI_LABEL).map(([k, v]) => `<option value="${k}"${saved.qbiType === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}
    </select></span><small>Specified service = health, law, accounting, consulting, financial services, performing arts, athletics.</small></label>`;
    const intakeWages = num(fd.biz_w2_wages);
    html += plain('qbiWages', 'W-2 wages the business pays', saved.qbiWages !== undefined && saved.qbiWages !== null ? commas(saved.qbiWages) : '', intakeWages ? commas(intakeWages) : 'Not entered',
      intakeWages ? 'Blank = the amount in the intake.' : 'All W-2 payroll, including an S corp owner\'s salary. Blank = the wage limit is not applied.', 'tx-money');
  }
  html += `<div class="tx-assume-title">Augusta Rule</div>`;
  html += plain('augustaDays', 'Rental days', set('augustaDays') ? saved.augustaDays : '', String(FOUNDATIONAL_PARAMS.augustaMaxDays), 'Up to 14 a year.');
  html += plain('augustaRate', 'Daily rental rate', set('augustaRate') ? commas(saved.augustaRate) : '', aug.estRate ? commas(aug.estRate) : '0',
    aug.homeValue ? `Blank = estimated at 0.1% of the ${money(aug.homeValue)} home value (max $3,000).` : 'No home value in the intake; enter a rate.', 'tx-money');
  html += `<div class="tx-assume-title">Family Payroll</div>`;
  html += plain('payrollKids', 'Children employed', set('payrollKids') ? saved.payrollKids : '', String(pay.eligibleCount || 0), `Blank = children aged ${FOUNDATIONAL_PARAMS.childMinAge}–${FOUNDATIONAL_PARAMS.childMaxAge} in the intake.`);
  html += plain('payrollWage', 'Wages per child', set('payrollWage') ? commas(saved.payrollWage) : '', commas(pay.stdSingle), `Blank = the 2026 standard deduction (${money(pay.stdSingle)}).`, 'tx-money');
  for (const s of Object.values(STRATEGIES)) {
    html += `<div class="tx-assume-title">${esc(s.name)}</div>`;
    for (const p of s.params) {
      if (p.type === 'choice') continue;
      const v = m.params[s.id][p.key];
      html += `<label class="tx-field tx-field-sm"><span>${esc(p.label)}</span><span class="tx-input ${p.type === 'pct' ? 'tx-pct' : ''}"><input type="text" inputmode="decimal" data-tax="param:${s.id}:${p.key}:${p.type}" value="${p.type === 'pct' ? +(v * 100).toFixed(4) : v}"></span></label>`;
    }
  }
  html += `<button type="button" class="tx-link" data-tx-reset>Reset assumptions</button></details></section>`;
  return html;
}

/** Additional deductions (e.g. cost segregation): one row per deduction, business or personal. */
function deductionsEditorHTML(saved) {
  const list = Array.isArray(saved.deductions) ? saved.deductions : [];
  const rows = list.map((d, i) => `<div class="tx-ded-row">
      <span class="tx-input"><select data-tx-ded="${i}:kind" aria-label="Deduction type">
        <option value="business"${d.kind !== 'personal' ? ' selected' : ''}>Business</option><option value="personal"${d.kind === 'personal' ? ' selected' : ''}>Personal</option></select></span>
      <span class="tx-input"><input type="text" data-tx-ded="${i}:label" value="${esc(d.label || '')}" placeholder="e.g. Cost segregation" aria-label="Description"></span>
      <span class="tx-input tx-money"><input type="text" inputmode="decimal" data-money data-tx-ded="${i}:amount" value="${esc(commas(num(d.amount)))}" placeholder="0" aria-label="Amount"></span>
      <button type="button" class="tx-ded-del" data-tx-ded-del="${i}" aria-label="Remove deduction">×</button></div>`).join('');
  return `<div class="tx-ded"><div class="tx-ded-head"><span>Additional deductions</span><button type="button" class="tx-link" data-tx-ded-add>+ Add deduction</button></div>
    ${rows}<small>${list.length ? 'Business: lowers business income. Personal: lowers ordinary income (e.g. cost seg on a rental). Shown in the plan as Additional Deductions.' : 'This year\'s deductions such as cost segregation or equipment, added to the plan.'}</small></div>`;
}

// ------------------------------------------------------------------ Detailed Results page
/**
 * @param handlers { select(scenarioId, block) }
 */
export function renderTaxDetail(root, fd, { scenario = null, block = 'base' } = {}, handlers) {
  fd = withAutoDb(fd);
  const a = analyze(fd);
  const { model, comparison: cmp } = a;
  const blocks = blocksFor(model);
  if (!blocks.includes(block)) block = 'base';
  const strategies = SCENARIOS.filter((s) => s.id !== 'none');
  const extras = [augustaRule(fd, model, fd.__tax || {}), familyPayroll(fd, model, fd.__tax || {})].filter((x) => x.applies);
  const extra = extras.find((x) => x.id === scenario);
  if (extra) return renderExtraDetail(root, a, extra, extras, handlers);
  // scenario 'none' with block db/roth is a foundational strategy on its own.
  const foundationOnly = scenario === 'none' && FOUNDATIONAL.includes(block);
  if (!foundationOnly && !strategies.some((s) => s.id === scenario)) {
    const best = strategyRows(cmp, block).find((r) => r.applies);
    scenario = best ? best.id : strategies[0].id;
  }
  const none = cmp.blocks.base.scenarios.none;
  const res = cmp.blocks[block].scenarios[scenario];
  const sit = res.situation, nsit = none.situation;
  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
  const R = res.return, N = none.return;
  const pv = hasRoth(block) ? cmp.roth.pvRmdTax : 0;

  const line = (label, before, after, opts = {}) => {
    const diff = after - before;
    const showDiff = opts.diff !== false && Math.abs(diff) >= 0.5;
    return `<tr class="${opts.cls || ''}"><th scope="row">${esc(label)}${opts.hint ? `<small>${esc(opts.hint)}</small>` : ''}</th>
      <td>${opts.blankBefore ? '' : money(before)}</td><td>${money(after)}</td>
      <td class="${showDiff && opts.goodWhenDown ? (diff < 0 ? 'up' : 'down') : ''}">${showDiff ? `${diff > 0 ? '+' : '−'}${money(Math.abs(diff)).replace('−', '')}` : ''}</td></tr>`;
  };
  const extraIncome = hasRoth(block) ? model.roth.conversion : 0;
  const dbAdj = hasDb(block) ? model.db.contribution : 0;
  const losses = sum(sit.businessLosses) + sum(sit.capitalLosses);
  const gifts = sum(sit.charitable);
  const credits = R.creditAllowed;
  const rowsHTML = [
    line('Total income', a.income, a.income + extraIncome, { hint: hasRoth(block) ? 'includes the Roth conversion' : '' }),
    dbAdj ? line('DB plan contribution', 0, -dbAdj, { goodWhenDown: false }) : '',
    losses ? line('Strategy deductions & losses', 0, -losses, { hint: 'see how it is sized below' }) : '',
    line('Adjusted gross income', N.agi, R.agi, { cls: 'sub' }),
    line('Standard or itemized deduction', N.deduction + N.seniorDeduction, R.deduction + R.seniorDeduction, { hint: R.usedStandard ? 'standard deduction' : 'itemized, including the charitable gift' }),
    N.qbiDeduction || R.qbiDeduction ? line('QBI deduction', N.qbiDeduction, R.qbiDeduction, { hint: '20% of business income' }) : '',
    line('Taxable income', N.taxableIncome, R.taxableIncome, { cls: 'sub' }),
    line('Federal income tax before credits', N.regularTax, R.regularTax, { goodWhenDown: true }),
    credits ? line('Credits applied', 0, -credits, { goodWhenDown: true, hint: sit.credits.some((c) => c.id === 'solar-spreadsheet') ? 'energy credit, plus the spreadsheet\'s state-saving adjustment' : 'energy credit' }) : '',
    N.totals.niit || R.totals.niit ? line('Net investment income tax', N.totals.niit, R.totals.niit, { goodWhenDown: true, hint: '3.8% of investment income over the threshold' }) : '',
    N.totals.payroll || R.totals.payroll ? line('Self-employment / Additional Medicare tax', N.totals.payroll, R.totals.payroll, { goodWhenDown: true }) : '',
    line('State income tax', N.totals.state, R.totals.state, { goodWhenDown: true }),
    line('Total tax', none.rows.totalTax, res.rows.totalTax, { cls: 'sub', goodWhenDown: true }),
    line('Strategy contribution', 0, res.rows.contribution, { goodWhenDown: true }),
    pv ? line('Tax on future IRA withdrawals (present value)', pv, 0, { goodWhenDown: true, hint: 'avoided by converting' }) : '',
    line('Total tax liability', none.rows.totalOutlay + pv, liabilityOf(res), { cls: 'sub', goodWhenDown: true, hint: 'tax + strategy contribution' }),
    res.rows.fee ? line('Planning fee', 0, res.rows.fee, { goodWhenDown: true }) : '',
  ].join('');

  // How the strategy is sized: the "sizing" sections of the ledger.
  const sizing = res.ledger.sections.filter((s) => /sizing/i.test(s.title))
    .flatMap((s) => s.lines).filter((l) => l.amount !== null && l.label !== 'Defined benefit plan contribution' && l.label !== 'Roth conversion');
  const sizingHTML = sizing.length ? `<table class="tx-how">${sizing.map((l) => `<tr><th>${esc(l.label)}</th><td>${esc(l.calc || '')}</td><td>${fmtLine(l)}</td></tr>`).join('')}</table>` : '';
  const costs = res.costs.filter((c) => c.kind !== 'retirement' && Math.abs(c.amount) >= 0.5)
    .map((c) => `<tr><th>${esc(c.label)}</th><td>${esc(c.calc || '')}</td><td>${money(c.amount)}</td></tr>`).join('');

  const applies = new Set(strategyRows(cmp, 'base').filter((r) => r.applies && r.savings > 0.5).map((r) => r.id));
  const pill = (id, b, label) => `<button type="button" data-tx-pick="${id}"${b ? ` data-tx-pick-block="${b}"` : ''} aria-selected="${id === scenario && (!b || b === block)}">${esc(label)}</button>`;
  const labelOf = (id) => SCENARIOS.find((s) => s.id === id).label;
  const pillGroups = [
    ['Foundational', [...blocks.filter((b) => FOUNDATIONAL.includes(b)).map((b) => pill('none', b, FOUNDATION[b].short)), ...extras.map((x) => pill(x.id, 'base', FOUNDATION[x.id].label))]],
    ['Advanced', ADVANCED.filter((id) => applies.has(id) || id === scenario).map((id) => pill(id, null, labelOf(id)))],
    ['Dual Advanced', COMBINED.filter((id) => applies.has(id) || id === scenario).map((id) => pill(id, null, labelOf(id)))],
  ].filter(([, ps]) => ps.length);
  const tabs = `<div class="tx-pillgroups">${pillGroups.map(([g, ps]) => `<div class="tx-pillgroup"><span>${g}</span><div class="tx-pills">${ps.join('')}</div></div>`).join('')}</div>`;
  const blockTabs = !foundationOnly && blocks.length > 1 ? `<div class="tx-pairbar"><span>Combine with</span><div class="tx-seg tx-seg-sm">${blocks.map((b) => `<button type="button" data-tx-pick-block="${b}" aria-selected="${b === block}">${b === 'base' ? 'Nothing' : esc(FOUNDATION[b].short)}</button>`).join('')}</div></div>` : '';
  const baseStrat = SCENARIOS.find((s) => s.id === scenario);
  const stratLabel = foundationOnly ? FOUNDATION[block].label : block !== 'base' ? `${baseStrat.label} + ${FOUNDATION[block].short}` : baseStrat.label;
  const strat = { ...baseStrat, label: stratLabel };
  const notes = strat.steps.flatMap((st) => STRATEGIES[st.strategy].notes.slice(0, 1));
  const warnings = res.warnings.map(simplifyWarning);

  root.innerHTML = `${tabs}${blockTabs}
    <section class="tx-hero tx-hero-detail">
      <div><div class="tx-hero-label">${esc(strat.label)}</div>
        <div class="tx-hero-value ${res.savings < 0 ? 'neg' : ''}">${res.savings < 0 ? '−' : ''}${money(Math.abs(res.savings)).replace('−', '')}</div>
        <div class="tx-hero-sub">${hasRoth(block) ? 'estimated savings vs. not converting' : 'estimated tax savings this year'} · ${pctOf(Math.abs(res.savings) / Math.max(1, none.rows.totalOutlay + pv))} of total tax liability</div></div>
      <div class="tx-hero-side"><div><span>Total tax liability</span><b>${money(none.rows.totalOutlay + pv)} → ${money(liabilityOf(res))}</b></div></div>
    </section>
    ${warnings.length ? `<ul class="tx-warnlist">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <section class="tx-card"><h3>Without vs. with ${esc(strat.label)}</h3>
      <div class="tx-viz tx-viz-detail">${beforeAfter(none.rows.totalOutlay + pv, liabilityOf(res), 'With strategy')}</div>
      <div class="tx-table-wrap"><table class="tx-compare"><thead><tr><th></th><th>No planning</th><th>${esc(strat.label)}</th><th>Change</th></tr></thead>
      <tbody>${rowsHTML}</tbody></table></div>
      <div class="tx-savings-line"><span>Estimated savings</span><b class="${res.savings < 0 ? 'down' : 'up'}">${money(res.savings)}</b></div>
    </section>
    ${foundationOnly && hasDb(block) ? detailGrowthHTML('db', a, fd, { db: true }, res.savings) : growthHTML(res, { a, title: res.rows.investmentAccount > 0.5 ? 'LEAP growth over time' : '' })}
    <section class="tx-card"><h3>How it's calculated</h3>
      ${sizingHTML ? `<h4>Sizing</h4>${sizingHTML}` : ''}
      ${costs ? `<h4>Contribution</h4><table class="tx-how">${costs}</table>` : ''}
      <h4>Tax · ${esc(FILING_LABEL[model.profile.filingStatus].toLowerCase())}, 2026 rates</h4><table class="tx-how">${taxLines(R)}</table>
      ${notes.length ? `<p class="tx-foot">${notes.map(esc).join(' ')}</p>` : ''}
      <details class="tx-full"><summary>Full calculation</summary>${fullLedger(res.ledger)}</details>
    </section>
    <p class="tx-foot">PFO Tax Strategy Calculator method, 2026 federal rates (Rev. Proc. 2025-32). Estimates for discussion, not tax advice.</p>`;

  root.onclick = detailClick(scenario, block, foundationOnly, handlers);
  root.onchange = (e) => { if (e.target.matches('[data-tx-aml]')) { setAml(e.target); handlers.select(scenario, block); } };
}

function detailClick(scenario, block, foundationOnly, handlers) {
  return (e) => {
    const g = e.target.closest('[data-tx-rate]');
    if (g) { growthRate = +g.dataset.txRate; handlers.select(scenario, block); return; }
    const p = e.target.closest('[data-tx-pick]');
    if (p) {
      // Foundational pills carry their block; advanced/combined pills keep the current pairing.
      const nb = p.dataset.txPickBlock || (foundationOnly ? 'base' : block);
      handlers.select(p.dataset.txPick, nb);
      return;
    }
    const b = e.target.closest('[data-tx-pick-block]');
    if (b) handlers.select(scenario, b.dataset.txPickBlock);
  };
}

/** Detail page for the Augusta Rule / Family Payroll (outside the workbook engine). */
function renderExtraDetail(root, a, x, extras, handlers) {
  const { model } = a;
  const F = FOUNDATION[x.id];
  const pill = (id, b, label) => `<button type="button" data-tx-pick="${id}" data-tx-pick-block="${b}" aria-selected="${id === x.id}">${esc(label)}</button>`;
  const labelOf = (id) => SCENARIOS.find((s) => s.id === id).label;
  const applies = new Set(strategyRows(a.comparison, 'base').filter((r) => r.applies && r.savings > 0.5).map((r) => r.id));
  const pillGroups = [
    ['Foundational', [...(model.db.contribution > 0 ? [pill('none', 'db', FOUNDATION.db.short)] : []), ...extras.map((e) => pill(e.id, 'base', FOUNDATION[e.id].label))]],
    ['Advanced', ADVANCED.filter((id) => applies.has(id)).map((id) => pill(id, 'base', labelOf(id)))],
    ['Dual Advanced', COMBINED.filter((id) => applies.has(id)).map((id) => pill(id, 'base', labelOf(id)))],
  ].filter(([, ps]) => ps.length);
  const tabs = `<div class="tx-pillgroups">${pillGroups.map(([g, ps]) => `<div class="tx-pillgroup"><span>${g}</span><div class="tx-pills">${ps.join('')}</div></div>`).join('')}</div>`;
  const after = x.before - x.savings;
  const how = `<table class="tx-how">${x.lines.map(([l, c, v]) => `<tr><th>${esc(l)}</th><td>${esc(c)}</td><td>${v < 0 ? '−' : ''}${money(Math.abs(v))}</td></tr>`).join('')}
      <tr class="total"><th>Estimated savings</th><td></td><td>${money(x.savings)}</td></tr></table>`;
  const ccorp = x.entity.kind === 'ccorp';
  const biz = +model.profile.businessIncome || 0;
  const ded = x.id === 'augusta' ? x.rent : x.deduction;
  const line = (label, before, afterV, opts = {}) => {
    const d = afterV - before;
    return `<tr class="${opts.cls || ''}"><th scope="row">${esc(label)}${opts.hint ? `<small>${esc(opts.hint)}</small>` : ''}</th><td>${money(before)}</td><td>${money(afterV)}</td>
      <td class="${Math.abs(d) >= 0.5 && opts.good ? (d < 0 ? 'up' : 'down') : ''}">${Math.abs(d) >= 0.5 ? `${d > 0 ? '+' : '−'}${money(Math.abs(d)).replace('−', '')}` : ''}</td></tr>`;
  };
  const rowsHTML = [
    ccorp ? line('Business deduction (C corp)', 0, ded, { hint: x.id === 'augusta' ? 'rent' : 'wages + employer payroll tax' })
      : line('Business income on your return', biz, biz - ded, { hint: x.id === 'augusta' ? 'less the rent' : 'less wages and employer payroll tax' }),
    x.id === 'augusta' ? line('Rent you receive', 0, x.rent, { hint: 'tax-free: rented fewer than 15 days' }) : line('Wages paid to your children', 0, x.wages, { hint: 'stays in the family' }),
    ccorp ? line('Corporate tax', 0, -(x.id === 'augusta' ? x.savings : x.taxSaved), { good: true, hint: '21% of the deduction' }) : line('Your household tax', x.before, x.after, { good: true, cls: 'sub' }),
    x.id === 'payroll' ? line('Payroll taxes', 0, x.employerTax + x.employeeTax, { good: true }) : '',
    x.id === 'payroll' ? line('Children\'s income tax', 0, x.childTax, { good: true, hint: 'no federal tax up to the standard deduction' }) : '',
    line('Total tax liability', x.before, after, { good: true, cls: 'sub' }),
  ].join('');
  const visual = x.id === 'augusta'
    ? `<div class="tx-xvis">${augustaVisual(x)}<p class="tx-gsub">${x.days} of 14 permitted days at ${money(x.rate)} a day${x.rateEstimated ? ` (estimated at 0.1% of the ${money(x.homeValue)} home)` : ''}.</p></div>`
    : `<div class="tx-xvis">${payrollVisual(x)}</div>
       <div class="tx-table-wrap"><table class="tx-compare"><thead><tr><th>Child</th><th>Wages</th><th>Payroll tax</th><th>Federal income tax</th></tr></thead><tbody>
       ${x.perChild.map((c, i) => `<tr><th scope="row">${c.age !== null ? `Age ${c.age}` : `Child ${i + 1}`}</th><td>${money(x.wage)}</td><td>${money(c.fica * 2 + c.futa)}</td><td>${x.wage <= x.stdSingle ? '$0' : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  root.innerHTML = `${tabs}
    <section class="tx-hero tx-hero-detail">
      <div><div class="tx-hero-label">${esc(F.label)}</div>
        <div class="tx-hero-value">${money(x.savings)}</div>
        <div class="tx-hero-sub">estimated tax savings this year · ${pctOf(x.savings / Math.max(1, x.before))} of total tax liability</div></div>
      <div class="tx-hero-side"><div><span>Total tax liability</span><b>${money(x.before)} → ${money(after)}</b></div></div>
    </section>
    <section class="tx-card"><h3>How it works</h3><p class="tx-gsub">${esc(CLIENT_BLURB[x.id])}</p>${visual}</section>
    <section class="tx-card"><h3>Without vs. with ${x.id === 'augusta' ? 'the Augusta Rule' : 'Family Payroll'}</h3>
      <div class="tx-viz tx-viz-detail">${beforeAfter(x.before, after, 'With strategy')}</div>
      <div class="tx-table-wrap"><table class="tx-compare"><thead><tr><th></th><th>No planning</th><th>${esc(F.label)}</th><th>Change</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>
      <div class="tx-savings-line"><span>Estimated savings</span><b class="up">${money(x.savings)}</b></div>
    </section>
    ${x.id === 'payroll' ? detailGrowthHTML('kids', a, {}, { payroll: true }, x.savings, x) : growthHTML({ rows: {}, savings: x.savings })}
    <section class="tx-card"><h3>How it's calculated</h3>${how}
      <p class="tx-foot">${esc(extraRequirements(x))}</p>
    </section>
    <p class="tx-foot">PFO Tax Strategy Calculator method, 2026 federal rates (Rev. Proc. 2025-32). Estimates for discussion, not tax advice.</p>`;
  root.onclick = detailClick(x.id, 'base', true, handlers);
}

// ------------------------------------------------------------------ growth over time
// What this year's tax savings grow to if invested at 6–8% for 10/15/20 years (one-time amounts
// compounded annually), plus the value if the same savings repeat every year. LEAP also keeps part
// of the contribution in an investment account, shown with the savings.
let growthRate = 0.07;
export const futureValue = (amount, rate, years) => amount * Math.pow(1 + rate, years);
export const futureValueOfAnnual = (amount, rate, years) => (rate ? amount * (Math.pow(1 + rate, years) - 1) / rate : amount * years);

function growthHTML(res, opts = {}) {
  const account = Math.max(0, res.rows.investmentAccount || 0) > 0.5 ? res.rows.investmentAccount : 0;
  const savings = Math.max(0, res.savings) > 0.5 ? res.savings : 0;
  if (!account && !savings) return '';
  if (account && opts.a && res.situation) {
    const g = amlGrowth({ ...leapFacts(res, opts.a), savings });
    return `<section class="tx-card tx-growth-card"><div class="tx-card-head"><h3>${esc(opts.title || 'Growth over time')}</h3></div><p class="tx-gsub">${esc(g.sub)}</p>${g.html}
      <p class="tx-gnote">Illustration at a steady return. Actual returns will vary.</p></section>`;
  }
  return growthCard(opts.title || 'Growth over time', `This year's ${money(savings)} of tax savings, invested once.`, investBlock({ years: 20, groups: [{ label: 'Tax savings', amount: savings }] }));
}

// ------------------------------------------------------------------ LEAP: growth, recapture and breakeven
// The Asset Management LLC account grows at the chosen return less the share taken each year to service
// the DRO (default 4%, adjustable up to 10%); the tax savings (already net of the contribution and fees)
// grow at the chosen return. If the client unwinds, every LEAP K-1 loss taken is recaptured as
// long-term capital gain (20% + 3.8% NIIT + state, at this year's income). Breakeven: the first point
// where the account plus the invested tax savings cover that recapture tax, so the client is ahead
// even after unwinding.
export const AML = { rate: 0.07, dro: 0.04, rates: [0.06, 0.07, 0.08, 0.09, 0.1], dros: [0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1] };
function setAml(el) {
  const v = +el.value;
  if (!Number.isFinite(v)) return;
  if (el.dataset.txAml === 'rate') AML.rate = v; else if (el.dataset.txAml === 'dro') AML.dro = v;
}

/** Extra tax if `gain` of long-term capital gain is added to the client's no-planning return. */
export function recaptureTax(a, gain) {
  if (!(gain > 0.5)) return 0;
  const none = a.comparison.blocks.base.scenarios.none;
  const rules = normalizeRules(a.model.rules);
  const s = JSON.parse(JSON.stringify(none.situation));
  const before = computeReturn(JSON.parse(JSON.stringify(none.situation)), rules, { ledger: false }).totals.total;
  s.income.ltcg += gain;
  return Math.max(0, computeReturn(s, rules, { ledger: false }).totals.total - before);
}

/** LEAP's own figures in a result: K-1 losses, contribution + fees, account kept, and the recapture tax. */
export function leapFacts(res, a) {
  const add = (xs) => xs.reduce((t, x) => t + (+x.amount || 0), 0);
  const sit = res.situation;
  const k1 = add(sit.businessLosses.filter((x) => x.id === 'leap')) + add(sit.capitalLosses.filter((x) => x.id === 'leap-cg'));
  const leapCosts = res.costs.filter((c) => c.strategy === 'leap');
  return {
    k1,
    contribution: add(leapCosts.filter((c) => c.kind === 'contribution')),
    acct: add(leapCosts.filter((c) => c.kind === 'asset')),
    recapture: recaptureTax(a, k1),
  };
}

/** Where the client stands after unwinding at year t: invested savings + account − recapture tax. */
export const leapAhead = ({ acct, savings, recapture, rate = AML.rate, dro = AML.dro }, t) => savings * Math.pow(1 + rate, t) + acct * Math.pow(1 + rate - dro, t) - recapture;

/** When the account plus invested tax savings first cover the recapture tax (years, fractional), or null within 40 years. */
export function amlBreakeven({ acct, savings, recapture, rate = AML.rate, dro = AML.dro }) {
  const f = { acct, savings: Math.max(0, savings || 0), recapture, rate, dro };
  if (!(recapture > 0.5) || leapAhead(f, 0) >= 0) return 0;
  for (let t = 0; t < 40; t += 0.01) if (leapAhead(f, t + 0.01) >= 0) return t + 0.01;
  return null;
}

const yrsText = (be) => (be < 10 ? be.toFixed(1).replace(/\.0$/, '') : String(Math.round(be)));

/** "If you unwind after 1 year": tax saved − contribution + account + growth − recapture = where you stand. */
function unwindHTML({ acct, savings, recapture, contribution }) {
  const { rate, dro } = AML;
  const f = { acct, savings, recapture, rate, dro };
  const steps = [
    { label: 'Tax saved this year', v: savings + contribution },
    { label: 'Contribution & fees', v: -contribution },
    { label: 'Asset Management LLC account after 1 year', v: acct * (1 + rate - dro) },
    { label: `Tax savings invested for 1 year (${pctOf(rate)})`, v: savings * rate },
    { label: 'Recapture tax on unwinding', v: -recapture },
  ].filter((x) => Math.abs(x.v) > 0.5);
  const net = leapAhead(f, 1);
  let cum = 0;
  const pts = [0];
  const bars = steps.map((x) => { const from = cum; cum += x.v; pts.push(cum); return { ...x, from, to: cum }; });
  const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts), span = hi - lo;
  const pos = (v) => ((v - lo) / span) * 100;
  const bar = (from, to, cls) => `<i class="${cls}" style="left:${pos(Math.min(from, to)).toFixed(2)}%;width:${Math.max(0.4, Math.abs(to - from) / span * 100).toFixed(2)}%"></i>`;
  const row = (label, from, to, v, cls, strong) => `<div class="tx-wf-row${strong ? ' tx-wf-total' : ''}"><span>${esc(label)}</span><div class="tx-wf-track">${bar(from, to, cls)}</div><b class="${v < 0 ? 'down' : strong ? 'up' : ''}">${v < 0 ? '−' : strong ? '' : '+'}${money(Math.abs(v)).replace('−', '')}</b></div>`;
  const later = [1, 3, 5, 10].map((t) => { const v = leapAhead(f, t); return `<div><span>${t} yr${t > 1 ? 's' : ''}</span><b class="${v < 0 ? 'down' : 'up'}">${v < 0 ? '−' : ''}${money(Math.abs(v)).replace('−', '')}</b></div>`; }).join('');
  return `<div class="tx-unwind"><h4>If you unwind after 1 year</h4>
    <div class="tx-wf" role="img" aria-label="After unwinding at 1 year: ${net < 0 ? 'behind by' : 'ahead by'} ${money(Math.abs(net))}">
      ${bars.map((x) => row(x.label, x.from, x.to, x.v, x.v < 0 ? 'wf-neg' : 'wf-pos')).join('')}
      ${row(net < 0 ? 'Behind after unwinding' : 'Ahead after unwinding', 0, net, net, net < 0 ? 'wf-neg' : 'wf-net', true)}
    </div>
    <div class="tx-unwind-later"><span class="tx-unwind-k">Net if unwound after</span>${later}</div>
    <p class="tx-gnote">Recapture: the ${money(recapture)} is tax on the K-1 losses coming back as long-term capital gain (20% + 3.8% NIIT + state) at this year's income.</p></div>`;
}

function amlGrowth({ acct, savings, recapture, contribution }) {
  const { rate, dro } = AML;
  savings = Math.max(0, savings || 0);
  const be = amlBreakeven({ acct, savings, recapture });
  const years = be !== null && be > 17 ? Math.min(40, Math.ceil(be) + 3) : 20;
  const yrs = Array.from({ length: years + 1 }, (_, t) => t);
  const accVals = yrs.map((t) => acct * Math.pow(1 + rate - dro, t));
  const savVals = yrs.map((t) => savings * Math.pow(1 + rate, t));
  const totVals = yrs.map((t) => accVals[t] + savVals[t]);
  const series = [
    { label: 'Asset Management LLC account', cls: 'ic-a', vals: accVals },
    ...(savings > 0.5 ? [{ label: 'Tax savings', cls: 'ic-b', vals: savVals }, { label: 'Together', cls: 'ic-c', vals: totVals, kind: 'total' }] : []),
    ...(recapture > 0.5 ? [{ label: 'Recapture tax if unwound', vals: yrs.map(() => recapture), kind: 'ref' }] : []),
  ];
  const beText = be === null ? '' : be === 0 ? 'Ahead from day one' : `Breakeven · ${yrsText(be)} yrs`;
  const marker = be !== null && be > 0 ? { t: be, v: recapture, label: beText } : null;
  const opt = (list, cur) => list.map((x) => `<option value="${x}"${Math.abs(x - cur) < 1e-9 ? ' selected' : ''}>${Math.round(x * 100)}%</option>`).join('');
  const ctrl = `<div class="tx-aml-ctrl"><label>Return <select data-tx-aml="rate" aria-label="Annual return">${opt(AML.rates, rate)}</select></label>
    <label>DRO servicing <select data-tx-aml="dro" aria-label="Taken off the account each year to service the DRO">${opt(AML.dros, dro)}</select><span>a year off the account</span></label></div>`;
  const ms = [...new Set([Math.round(years / 2), years])];
  const row = (label, cls, vals, bold) => `<tr${bold ? ' class="sub"' : ''}><th scope="row">${cls ? `<i class="ic-key ${cls}"></i>` : ''}${esc(label)}</th><td><b>${money(vals[0])}</b></td>${ms.map((t) => `<td><b>${money(vals[t])}</b></td>`).join('')}</tr>`;
  const table = `<div class="tx-table-wrap tx-gtable"><table class="tx-compare tx-growth tx-itable"><thead><tr><th></th><th>Today</th>${ms.map((t) => `<th>${t} yrs</th>`).join('')}</tr></thead><tbody>
    ${row('Asset Management LLC account', 'ic-a', accVals)}
    ${savings > 0.5 ? row('Tax savings', 'ic-b', savVals) + row('Together', 'ic-c', totVals, true) : ''}
    ${recapture > 0.5 ? `<tr><th scope="row"><i class="ic-key lc-key-ref"></i>Recapture tax if unwound</th><td>${money(recapture)}</td>${ms.map(() => '<td></td>').join('')}</tr>` : ''}
  </tbody></table></div>`;
  const legend = `<div class="gc-legend">${series.map((x) => `<span><i class="ic-key ${x.kind === 'ref' ? 'lc-key-ref' : x.cls}"></i>${esc(x.label)}</span>`).join('')}</div>`;
  const beNote = recapture > 0.5 ? `<p class="tx-breakeven">${be === null
    ? `At ${pctOf(rate)} with ${pctOf(dro)} a year for the DRO, the account and invested tax savings don't cover the ${money(recapture)} recapture tax within 40 years.`
    : be === 0 ? `<b>Ahead from day one:</b> the account plus the tax savings already cover the ${money(recapture)} recapture tax, so the client is ahead even after unwinding.`
    : `<b>Breakeven in about ${yrsText(be)} years:</b> the account plus the invested tax savings pass the ${money(recapture)} recapture tax. From then on the client could unwind and still be ahead.`}</p>` : '';
  const sub = `${money(acct)} kept in the Asset Management LLC account (growing at ${pctOf(rate)} less ${pctOf(dro)} a year to service the DRO), plus the ${money(savings)} of tax savings (after the contribution and fees) invested at ${pctOf(rate)}.`;
  const unwind = recapture > 0.5 ? unwindHTML({ acct, savings, recapture, contribution }) : '';
  return { sub, html: `${ctrl}<div class="tx-gwrap"><div class="tx-gchart">${lineChart({ years, series, marker })}${legend}</div>${table}</div>${beNote}${unwind}` };
}
const growthCard = (title, sub, html) => `<section class="tx-card tx-growth-card"><div class="tx-card-head"><h3>${esc(title)}</h3></div><p class="tx-gsub">${esc(sub)}</p>${html}
  <p class="tx-gnote">Illustration at a steady 6%, 7% (line) and 8% a year. Actual returns will vary.</p></section>`;

/** A growth view on a detail page (DB plan, Family Payroll) with that strategy's own savings. */
function detailGrowthHTML(id, a, fd, sel, savings, pay = {}) {
  const v = growthViews({ a, sel: { db: false, payroll: false, roth: false, adv: [], ...sel }, plan: { res: { rows: {} }, savings: 0 }, pay }, fd, () => savings).find((x) => x.id === id);
  return v ? growthCard(v.label, v.sub, v.html) : '';
}

function fmtLine(l) {
  if (typeof l.amount !== 'number') return '';
  return money(l.amount);
}

function taxLines(R) {
  const out = [];
  const L = R.ledger;
  const find = (sec) => L.sections.find((s) => s.title === sec);
  const fed = find('Federal income tax');
  if (fed) {
    const ord = fed.lines.find((l) => l.label === 'Tax on ordinary income');
    if (ord) out.push(['Federal tax on ordinary income', ord.amount ? ord.calc : 'No taxable ordinary income', ord.amount]);
    const cg = fed.lines.find((l) => /^Tax on long-term/.test(l.label));
    if (cg && cg.amount) out.push(['Federal tax on gains & qualified dividends', fed.lines.filter((l) => /on gains/.test(l.label)).map((l) => l.calc).join(' + '), cg.amount]);
  }
  const st = L.sections.find((s) => / income tax$/.test(s.title) && s.title !== 'Federal income tax');
  if (st) { const l = st.lines.find((x) => / tax$/.test(x.label) && x.kind === 'total'); if (l) out.push([l.label, R.state.taxable > 0 ? `${l.calc || ''} of ${money(R.state.taxable)}` : 'No taxable income', l.amount]); }
  return out.map(([a, b, c]) => `<tr><th>${esc(a)}</th><td>${esc(b || '')}</td><td>${c === null ? '' : money(c)}</td></tr>`).join('');
}

const isRate = (l) => /%|rate/i.test(l.label) && Math.abs(l.amount) < 5;

function fullLedger(ledger) {
  return ledger.sections.map((s) => {
    const lines = s.lines.filter((l) => l.kind === 'warn' || (l.amount !== null && Math.abs(l.amount) >= 0.005) || l.kind === 'total');
    if (!lines.length) return '';
    return `<h4>${esc(s.title)}</h4><table class="tx-how">${lines.map((l) => `<tr class="${l.kind || ''}"><th>${esc(l.label)}</th><td>${esc(l.calc || '')}</td><td>${l.amount === null ? '' : isRate(l) ? pct(l.amount) : money(l.amount)}</td></tr>`).join('')}</table>`;
  }).join('');
}
