// "Tax strategies" step for the intake site (beta).
// Builds a calculator model from the client's intake answers, runs every strategy, and renders
// a comparison and a Detailed Results page. All tax math lives in ../engine.
//
// The site uses the spreadsheet method (the PFO Tax Strategy Calculator's own math) with one
// fix: strategy amounts that would come out negative are set to $0 instead of raising taxes.

import { runComparison } from '../engine/compare.js';
import { SCENARIOS } from '../engine/scenarios.js';
import { defaultModel } from '../engine/model.js';
import { ALL_OFF } from '../engine/rules.js';
import { STRATEGIES, defaultParams } from '../strategies/index.js';
import { stateCodeFor } from '../tables/states/index.js';
import { money, pct } from '../engine/ledger.js';

export const SITE_RULES = { ...ALL_OFF, clampNegative: true };

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

// Strategy groups on the tax page. The DB plan is the foundational strategy: it stands alone and can
// be combined with an advanced strategy. A Roth conversion is only offered combined with an advanced
// strategy (on its own it rarely helps). Combined strategies pair two advanced strategies.
export const FOUNDATIONAL = ['db', 'dbRoth'];
export const FOUNDATION = {
  db: { label: 'Defined Benefit Plan', short: 'DB plan', blurb: 'Tax-deductible contribution to a defined benefit (cash balance) plan, funded from business income. The money stays the client\'s.' },
  roth: { label: 'Roth Conversion', short: 'Roth conversion', blurb: 'Moves pre-tax retirement money to a Roth: tax is paid now instead of on withdrawals later, and future growth is tax-free.' },
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
  m.db.contribution = num(saved.dbContribution);
  m.roth.conversion = num(saved.rothConversion);
  m.roth.retirementAge = num(fd.retirement_target_age) || 65;
  if (!p.age) p.age = 65; // only used by the Roth projection when no age is given
  const params = defaultParams();
  for (const [sid, vals] of Object.entries(saved.params || {})) if (params[sid]) Object.assign(params[sid], vals);
  m.params = params;
  m.rules = { ...SITE_RULES };
  return { model: m, notes, stateName, stateCode: code, stateRate, stateRateSource, income };
}

// ------------------------------------------------------------------ results
let cache = { key: null, value: null };
export function analyze(fd) {
  const built = intakeToModel(fd);
  const key = JSON.stringify(built.model);
  if (cache.key !== key) cache = { key, value: runComparison(built.model) };
  return { ...built, comparison: cache.value };
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
  const row = (group) => (r) => ({ group, label: r.label, savings: r.savings, pct: r.pct, liabilityAfter: r.liability });
  const scenarios = blocksFor(a.model).filter((b) => b !== 'base').map((b) => {
    const r = strategyRows(cmp, b).find((x) => x.applies);
    return r ? { label: `${FOUNDATION[b].short} (${amountText(a.model, b)}) combined with ${r.label}`, strategy: r.label, savings: r.savings, pct: r.pct } : null;
  }).filter(Boolean);
  const top = base.find((r) => r.savings > 0.5);
  return {
    liability: cmp.blocks.base.baseline,
    strategies: [
      ...found,
      ...base.filter((r) => ADVANCED.includes(r.id)).map(row('Advanced')),
      ...base.filter((r) => COMBINED.includes(r.id)).map(row('Combined')),
    ],
    best: top ? { label: top.label, savings: top.savings, pct: top.pct } : null,
    scenarios,
    suggestions: suggestions(fd).map((s) => s.text),
  };
}

// ------------------------------------------------------------------ step page
/**
 * @param root     container element
 * @param fd       intake form data (read-only here; tax inputs are saved via handlers.save)
 * @param handlers { save(taxInputs), editIntake(sectionId), openDetail(scenarioId, block) }
 */
export function renderTaxStep(root, fd, handlers) {
  const saved = { ...(fd.__tax || {}) };
  root.innerHTML = `<div class="tx-layout"><div id="tx-results"></div><aside id="tx-options"></aside></div>`;
  const resultsEl = root.querySelector('#tx-results');
  const optionsEl = root.querySelector('#tx-options');

  const effective = () => withAutoDb({ ...fd, __tax: saved });
  const draw = () => {
    const f = effective();
    const tips = suggestions(f);
    resultsEl.innerHTML = resultsHTML(analyze(f), saved, tips, f);
  };
  const drawOptions = () => { const f = effective(); optionsEl.innerHTML = optionsHTML(intakeToModel(f), f.__tax || {}, fd); };
  const built = intakeToModel(effective());
  drawOptions();
  draw();
  // Remember whether the Combined Strategies dropdown is open across redraws.
  resultsEl.addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('.tx-combined')) combinedOpen = e.target.open; }, true);

  let t;
  optionsEl.addEventListener('input', (e) => {
    const el = e.target;
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
    } else {
      saved[key] = num(el.value);
    }
    clearTimeout(t);
    t = setTimeout(() => { draw(); handlers.save({ ...saved }); }, 250);
  });
  root.onclick = (e) => {
    const g = e.target.closest('[data-tx-rate]');
    if (g) { growthRate = +g.dataset.txRate; draw(); return; }
    const b = e.target.closest('[data-tx-block]');
    if (b) { saved.block = b.dataset.txBlock; draw(); handlers.save({ ...saved }); return; }
    const ap = e.target.closest('[data-tx-apply]');
    if (ap) {
      const [kind, amount] = ap.dataset.txApply.split(':');
      const key = kind === 'db' ? 'dbContribution' : 'rothConversion';
      saved[key] = +amount;
      saved.block = kind === 'roth' && num(effective().__tax.dbContribution) > 0 ? 'dbRoth' : kind;
      const input = optionsEl.querySelector(`[data-tax="${key}"]`);
      if (input) input.value = commas(+amount);
      draw(); handlers.save({ ...saved });
      return;
    }
    if (e.target.closest('[data-tx-autodb]')) { delete saved.dbContribution; drawOptions(); draw(); handlers.save({ ...saved }); return; }
    const d = e.target.closest('[data-tx-detail]');
    if (d) { handlers.openDetail(d.dataset.txDetail, d.dataset.txDetailBlock || saved.block || 'base'); return; }
    const ed = e.target.closest('[data-tx-edit]');
    if (ed) { handlers.editIntake(ed.dataset.txEdit); return; }
    const reset = e.target.closest('[data-tx-reset]');
    if (reset) {
      delete saved.params;
      delete saved.planningFee;
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
  ].filter(([, v]) => typeof v === 'string' || v);
  return chips.map(([k, v]) => `<div class="tx-chip"><span>${esc(k)}</span><b>${typeof v === 'number' ? money(v) : esc(v)}</b></div>`).join('');
}

const pctOf = (x) => `${(Math.round(x * 1000) / 10).toFixed(1).replace(/\.0$/, '')}%`;

let combinedOpen = false;

function resultsHTML(a, saved, tips = [], fd = {}) {
  const { model, comparison: cmp } = a;
  const blocks = blocksFor(model);
  const block = blocks.includes(saved.block) ? saved.block : 'base';
  const notes = a.notes.map((n) => `<li>${esc(n.text)} <button type="button" class="tx-link" data-tx-edit="${n.section}">Edit</button></li>`).join('');
  const profile = `<section class="tx-card tx-profile">
      <div class="tx-card-head"><h3>From the intake</h3><button type="button" class="tx-link" data-tx-edit="income">Edit income</button></div>
      <div class="tx-chips">${profileChips(a)}</div>
      ${notes ? `<ul class="tx-notes">${notes}</ul>` : ''}
      ${a.stateCode === 'CUSTOM' && !a.stateRate ? `<p class="tx-warn">Enter ${esc(a.stateName)}'s income tax rate on the right to include state tax.</p>` : ''}
    </section>`;

  if (a.income <= 0) {
    return `${profile}<section class="tx-card tx-empty"><h3>No income entered yet</h3>
      <p>Add the client's prior-year income in the intake to compare strategies.</p>
      <button type="button" class="btn btn-primary btn-sm" data-tx-edit="income">Go to Income</button></section>`;
  }

  const blk = cmp.blocks[block];
  const pairing = block === 'base' ? null : FOUNDATION[block];
  const withPair = (label) => (pairing ? `${label} + ${pairing.short}` : label);
  const rows = strategyRows(cmp, block);
  const shown = rows.filter((r) => ADVANCED.includes(r.id) || COMBINED.includes(r.id));
  const best = shown.find((r) => r.applies && r.savings > 0.5);
  const pairBase = pairing ? foundationResult(cmp, model, block) : null;

  // ---- hero: the best advanced / combined strategy (with the chosen foundational strategy, if any)
  const heroLabel = hasRoth(block) ? 'Estimated savings vs. not converting' : 'Estimated tax savings this year';
  const liabLabel = hasRoth(block) ? 'Tax liability without converting' : 'Current tax liability';
  const hero = best
    ? `<section class="tx-hero">
        <div><div class="tx-hero-label">${heroLabel}</div>
          <div class="tx-hero-value">${money(best.savings)}</div>
          <div class="tx-hero-sub">with <b>${esc(withPair(best.label))}</b> · ${pctOf(best.pct)} of total tax liability</div></div>
        <div class="tx-hero-side">
          <div><span>${liabLabel}</span><b>${money(blk.baseline)}</b></div>
          <div><span>Tax liability with ${esc(withPair(best.label))}</span><b>${money(best.liability)}</b></div>
        </div></section>`
    : `<section class="tx-hero tx-hero-none"><div><div class="tx-hero-label">${heroLabel}</div>
        <div class="tx-hero-value">—</div><div class="tx-hero-sub">None of the modeled strategies lower this client's tax liability at this income.</div></div>
        <div class="tx-hero-side"><div><span>${liabLabel}</span><b>${money(blk.baseline)}</b></div></div></section>`;

  const valueHTML = (savings, pctV, maxSav) => {
    const neg = savings < 0;
    const w = Math.max(2, Math.abs(savings) / maxSav * 100);
    return `<div class="tx-row-value"><div class="tx-sav-label">${neg ? 'Added cost' : 'Savings'}</div>
        <div class="tx-sav ${neg ? 'neg' : ''}">${money(Math.abs(savings))}</div>
        <div class="tx-bar" role="img" aria-label="${neg ? 'Added cost' : 'Savings'} ${pctOf(Math.abs(pctV))} of tax liability"><i class="${neg ? 'neg' : ''}" style="width:${w}%"></i></div>
        <div class="tx-row-pct">${pctOf(Math.abs(pctV))} of tax liability</div>`;
  };

  // ---- foundational strategies: each on its own, with a switch to combine it with the advanced ones
  const tipFor = (kind) => tips.find((t) => t.kind === kind);
  const foundRows = FOUNDATIONAL.filter((kind) => kind === 'db' || blocks.includes(kind)).map((kind) => foundationResult(cmp, model, kind));
  const foundMax = Math.max(1, ...foundRows.filter((f) => f.amount > 0).map((f) => Math.abs(f.savings)));
  const foundCard = (f) => {
    const F = FOUNDATION[f.kind];
    if (!(f.amount > 0)) {
      const tip = tipFor(f.kind);
      if (tip) {
        return `<div class="tx-row tx-found tx-found-empty"><div class="tx-row-main"><div class="tx-row-title">${esc(F.label)}</div>
          <div class="tx-row-desc">${esc(F.blurb)}</div><p class="tx-found-tip">${esc(tip.text)}</p></div>
          <div class="tx-row-value"><button type="button" class="btn btn-sm btn-gold" data-tx-apply="${tip.kind}:${Math.round(tip.amount)}">Add ${money(tip.amount)}</button></div></div>`;
      }
      const why = f.kind === 'db'
        ? (model.profile.businessIncome > 0 ? 'Enter a contribution under Scenario options to model one.' : 'Funded from business income; none in the intake.')
        : (taxDeferredBalance(fd) > 0 ? 'Enter a conversion amount under Scenario options to model one.' : 'No pre-tax retirement balance in the intake. Enter an amount under Scenario options to model one.');
      return `<div class="tx-row tx-row-na tx-found"><div class="tx-row-main"><div class="tx-row-title">${esc(F.label)}</div>
        <div class="tx-row-desc">${esc(F.blurb)}</div></div><div class="tx-row-na-label">${esc(why)}</div></div>`;
    }
    const paired = block === f.kind;
    const facts = f.kind === 'db'
      ? `<span>Contribution ${money(f.amount)}${saved.dbContribution === undefined ? ' (suggested)' : ''}</span><span>Total tax liability ${money(f.baseline)} → ${money(f.liability)}</span>`
      : `<span>DB contribution ${money(model.db.contribution)} + Roth conversion ${money(model.roth.conversion)}</span><span>Tax liability without converting ${money(f.baseline)} → ${money(f.liability)}</span>`;
    const dbOnly = f.kind === 'dbRoth' ? foundRows.find((x) => x.kind === 'db') : null;
    const note = f.kind === 'dbRoth' && dbOnly
      ? `<div class="tx-row-facts"><span>${f.savings - dbOnly.savings >= 0 ? '+' : '−'}${money(Math.abs(f.savings - dbOnly.savings))} vs. the DB plan alone</span></div>${f.savings < dbOnly.savings ? '<div class="tx-row-note">Without an advanced strategy, the conversion tax outweighs what it saves later. Combine it with one below.</div>' : ''}`
      : '';
    return `<div class="tx-row tx-found${paired ? ' is-paired' : ''}"><div class="tx-row-main">
        <div class="tx-row-title">${esc(F.label)}</div>
        <div class="tx-row-desc">${esc(F.blurb)}</div>
        <div class="tx-row-facts">${facts}</div>${note}
        <div class="tx-found-actions">
          <button type="button" class="tx-pair" data-tx-block="${paired ? 'base' : f.kind}" aria-pressed="${paired}">${paired ? '✓ Combined with the advanced strategies below' : 'Combine with an advanced strategy'}</button>
          <button type="button" class="tx-link" data-tx-detail="none" data-tx-detail-block="${f.kind}">Details →</button>
        </div></div>
      ${valueHTML(f.savings, f.pct, foundMax)}</div></div>`;
  };
  const foundational = `<section class="tx-card tx-group"><div class="tx-card-head"><h3>Foundational Strategies</h3><span class="tx-card-sub">Stands on its own, or combine it with an advanced strategy</span></div>
      <div class="tx-list">${foundRows.map(foundCard).join('')}</div></section>`;

  // ---- advanced and combined strategies (with the chosen foundational strategy, if any)
  const maxSav = Math.max(1, ...shown.map((r) => Math.abs(r.savings)));
  const card = (r) => {
    if (!r.applies) {
      const why = naReason(r);
      return `<div class="tx-row tx-row-na"><div class="tx-row-main"><div class="tx-row-title">${esc(r.label)}</div>
        <div class="tx-row-desc">${esc(STRATEGY_BLURB[r.id])}</div></div><div class="tx-row-na-label">Not applicable${why ? `<br>${esc(why)}` : ''}</div></div>`;
    }
    const note = r.r.warnings.find((x) => /negative|carries|more than|does not apply/.test(x));
    const extra = pairBase ? r.savings - pairBase.savings : 0;
    return `<button type="button" class="tx-row" data-tx-detail="${r.id}">
      <div class="tx-row-main"><div class="tx-row-title">${esc(withPair(r.label))}${best && best.id === r.id ? '<span class="tx-best">Best</span>' : ''}</div>
        <div class="tx-row-desc">${esc(STRATEGY_BLURB[r.id])}</div>
        <div class="tx-row-facts"><span>Total tax liability ${money(blk.baseline)} → ${money(r.liability)}</span>${pairBase ? `<span>${extra >= 0 ? '+' : '−'}${money(Math.abs(extra))} vs. the ${esc(pairing.short)} alone</span>` : ''}</div>
        ${r.r.rows.investmentAccount > 0.5 ? `<div class="tx-row-growth">Investment account ${money(r.r.rows.investmentAccount)} → <b>${money(futureValue(r.r.rows.investmentAccount, growthRate, 20))}</b> in 20 years at ${pctOf(growthRate)}</div>` : ''}
        ${note ? `<div class="tx-row-note">${esc(simplifyWarning(note))}</div>` : ''}</div>
      ${valueHTML(r.savings, r.pct, maxSav)}
        <div class="tx-row-cta">Details →</div></div></button>`;
  };
  const available = blocks.filter((b) => b !== 'base');
  const pairSwitch = available.length
    ? `<div class="tx-pairbar"><span>Combine with</span><div class="tx-seg tx-seg-sm" role="tablist">${['base', ...available].map((b) => `<button type="button" role="tab" data-tx-block="${b}" aria-selected="${b === block}">${b === 'base' ? 'Nothing' : b === 'dbRoth' ? 'DB plan + Roth conversion' : `${esc(FOUNDATION[b].short)} · ${money(amountOf(model, b))}`}</button>`).join('')}</div></div>`
    : '<p class="tx-pairhint">Add a DB plan contribution or Roth conversion under Scenario options to combine it with these.</p>';
  const rothTip = !(model.roth.conversion > 0) && tipFor('roth');
  const rothAdd = rothTip ? `<div class="tx-roth-tip"><p><b>Roth conversion.</b> ${esc(rothTip.text)}</p>
      <button type="button" class="btn btn-sm btn-gold" data-tx-apply="roth:${Math.round(rothTip.amount)}">Combine a ${money(rothTip.amount)} Roth conversion${model.db.contribution > 0 ? ' with the DB plan' : ''}</button></div>` : '';
  const overDb = hasDb(block) && model.db.contribution > Math.max(0, model.profile.businessIncome);
  const dbText = `the ${money(model.db.contribution)} DB plan contribution (it stays the client's money, so it isn't part of the tax liability)`;
  const rothText = `Tax liability without converting includes ${money(cmp.roth.pvRmdTax)} (today's dollars) of tax on future IRA withdrawals.`;
  const context = (block === 'db' ? `Savings include ${dbText}.`
    : block === 'roth' ? `Savings include the ${money(model.roth.conversion)} Roth conversion. ${rothText}`
    : block === 'dbRoth' ? `Savings include ${dbText} and the ${money(model.roth.conversion)} Roth conversion. ${rothText}`
    : '') + (overDb ? ` Note: a DB contribution is funded from business income (${money(model.profile.businessIncome)}).` : '');
  const advRows = shown.filter((r) => ADVANCED.includes(r.id));
  const comboRows = shown.filter((r) => COMBINED.includes(r.id));
  const comboBest = comboRows.find((r) => r.applies && r.savings > 0.5);
  const advanced = `<section class="tx-card tx-group"><div class="tx-card-head"><h3>Advanced Strategies</h3><span class="tx-card-sub">Select a strategy for the detailed calculation</span></div>
      ${pairSwitch}${rothAdd}${context ? `<p class="tx-context">${esc(context)}</p>` : ''}
      <div class="tx-list">${advRows.map(card).join('')}</div>
      <details class="tx-combined"${combinedOpen ? ' open' : ''}><summary><span class="tx-combined-title">Combined Strategies</span>
        <span class="tx-card-sub">${comboRows.map((r) => esc(r.label)).join(' · ')}${comboBest ? ` · up to ${money(comboBest.savings)}` : ''}</span></summary>
        <div class="tx-list">${comboRows.map(card).join('')}</div></details>
    </section>`;

  return `${profile}${hero}${foundational}${advanced}`;
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
  html += `<details class="tx-assume"><summary>Strategy assumptions</summary>`;
  html += `<label class="tx-field tx-field-sm"><span>Planning fee</span><span class="tx-input tx-money"><input type="text" inputmode="decimal" data-tax="planningFee" data-money value="${esc(commas(m.profile.planningFee))}" placeholder="0"></span></label>`;
  html += `<small class="tx-assume-hint">Subtracted from each strategy's savings.</small>`;
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
    gifts || R.deduction ? line('Charitable deduction', N.deduction, R.deduction) : '',
    line('Taxable income', N.taxableIncome, R.taxableIncome, { cls: 'sub' }),
    line('Federal income tax before credits', N.regularTax, R.regularTax, { goodWhenDown: true }),
    credits ? line('Credits applied', 0, -credits, { goodWhenDown: true, hint: sit.credits.some((c) => c.id === 'solar-spreadsheet') ? 'energy credit, plus the spreadsheet\'s state-saving adjustment' : 'energy credit' }) : '',
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

  const pill = (id, b, label) => `<button type="button" data-tx-pick="${id}"${b ? ` data-tx-pick-block="${b}"` : ''} aria-selected="${id === scenario && (!b || b === block)}">${esc(label)}</button>`;
  const labelOf = (id) => SCENARIOS.find((s) => s.id === id).label;
  const pillGroups = [
    ['Foundational', blocks.filter((b) => FOUNDATIONAL.includes(b)).map((b) => pill('none', b, FOUNDATION[b].short))],
    ['Advanced', ADVANCED.map((id) => pill(id, null, labelOf(id)))],
    ['Combined', COMBINED.map((id) => pill(id, null, labelOf(id)))],
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
      <div class="tx-table-wrap"><table class="tx-compare"><thead><tr><th></th><th>No planning</th><th>${esc(strat.label)}</th><th>Change</th></tr></thead>
      <tbody>${rowsHTML}</tbody></table></div>
      <div class="tx-savings-line"><span>Estimated savings</span><b class="${res.savings < 0 ? 'down' : 'up'}">${money(res.savings)}</b></div>
    </section>
    ${growthHTML(res)}
    <section class="tx-card"><h3>How it's calculated</h3>
      ${sizingHTML ? `<h4>Sizing</h4>${sizingHTML}` : ''}
      ${costs ? `<h4>Contribution</h4><table class="tx-how">${costs}</table>` : ''}
      <h4>Tax · ${esc(FILING_LABEL[model.profile.filingStatus].toLowerCase())}, 2026 rates</h4><table class="tx-how">${taxLines(R)}</table>
      ${notes.length ? `<p class="tx-foot">${notes.map(esc).join(' ')}</p>` : ''}
      <details class="tx-full"><summary>Full calculation</summary>${fullLedger(res.ledger)}</details>
    </section>
    <p class="tx-foot">PFO Tax Strategy Calculator method, 2026 federal rates (Rev. Proc. 2025-32). Estimates for discussion, not tax advice.</p>`;

  root.onclick = (e) => {
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

// ------------------------------------------------------------------ growth over time (LEAP)
// LEAP keeps part of the contribution in an investment account. Show what it, and this year's tax
// savings, grow to if invested at 6–8% for 10/15/20 years (one-time amounts compounded annually),
// plus the value if the same savings repeat every year.
let growthRate = 0.07;
const GROWTH_RATES = [0.06, 0.07, 0.08];
const GROWTH_YEARS = [10, 15, 20];
export const futureValue = (amount, rate, years) => amount * Math.pow(1 + rate, years);
export const futureValueOfAnnual = (amount, rate, years) => (rate ? amount * (Math.pow(1 + rate, years) - 1) / rate : amount * years);

function growthHTML(res, opts = {}) {
  const account = res.rows.investmentAccount || 0;
  if (account <= 0.5) return '';
  const savings = Math.max(0, res.savings);
  const r = growthRate;
  const title = opts.title || 'Growth over time';
  const sub = opts.sub || `The LEAP investment account and this year's tax savings, invested at ${pctOf(r)} a year.`;
  const row = (label, today, fn, cls = '') => `<tr class="${cls}"><th scope="row">${esc(label)}</th><td>${today === null ? '' : money(today)}</td>${GROWTH_YEARS.map((y) => `<td>${money(fn(y))}</td>`).join('')}</tr>`;
  return `<section class="tx-card ${opts.cls || ''}"><div class="tx-card-head"><h3>${esc(title)}</h3>
      <div class="tx-pills tx-pills-sm">${GROWTH_RATES.map((g) => `<button type="button" data-tx-rate="${g}" aria-selected="${Math.abs(g - r) < 1e-9}">${pctOf(g)}</button>`).join('')}</div></div>
    <p class="tx-card-sub">${esc(sub)}</p>
    <div class="tx-table-wrap"><table class="tx-compare tx-growth"><thead><tr><th></th><th>Today</th>${GROWTH_YEARS.map((y) => `<th>${y} years</th>`).join('')}</tr></thead><tbody>
      ${row('Investment account', account, (y) => futureValue(account, r, y))}
      ${savings ? row('Tax savings, invested', savings, (y) => futureValue(savings, r, y)) : ''}
      ${row('Total', account + savings, (y) => futureValue(account + savings, r, y), 'sub')}
      ${savings ? row('If the tax savings repeat every year', null, (y) => futureValueOfAnnual(savings, r, y)) : ''}
    </tbody></table></div></section>`;
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
