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
const BLOCK_LABEL = { base: 'Strategies alone', db: 'With DB plan', roth: 'With Roth conversion' };

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
  return ['base', ...(model.db.contribution > 0 ? ['db'] : []), ...(model.roth.conversion > 0 ? ['roth'] : [])];
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

/**
 * When a DB plan contribution or Roth conversion looks worthwhile under the calculator's own model,
 * returns short suggestions: [{ kind: 'db'|'roth', amount, savings, text }].
 *   DB plan: needs business income (a DB plan is funded from it). Suggested size is half of business
 *     income, capped at $150,000, in $10,000 steps; shown when it lowers this year's tax by > $2,500.
 *   Roth conversion: needs a pre-tax retirement balance. Tries converting 25%, 50% and 100% of it
 *     (capped at $1,000,000). Suggests the amount that saves the most on its own versus paying tax
 *     on later withdrawals at the assumed future rate; if a conversion only pays off when paired
 *     with a strategy, says so.
 */
export function suggestions(fd = {}) {
  const saved = fd.__tax || {};
  const base = analyze(fd);
  if (base.income <= 0) return [];
  const out = [];
  const p = base.model.profile;
  const baseTax = base.comparison.blocks.base.scenarios.none.rows.totalTax;

  if (!num(saved.dbContribution) && p.businessIncome >= 50000) {
    const c = Math.max(25000, Math.floor(Math.min(150000, p.businessIncome * 0.5) / 10000) * 10000);
    const a = analyze({ ...fd, __tax: { ...saved, dbContribution: c } });
    const s = baseTax - a.comparison.blocks.db.scenarios.none.rows.totalTax;
    if (s > 2500) {
      const has = fd.business_defined_benefit === 'Yes';
      out.push({ kind: 'db', amount: c, savings: s, text: has
        ? `Given the business's defined benefit plan, consider adding this year's contribution. About ${money(c)} would lower tax by roughly ${money(s)}.`
        : `Given ${money(p.businessIncome)} of business income, consider adding a defined benefit plan contribution. About ${money(c)} would lower tax by roughly ${money(s)}, and the money stays the client's.` });
    }
  }

  const balance = taxDeferredBalance(fd);
  if (!num(saved.rothConversion) && balance >= 25000) {
    const amounts = [...new Set([0.25, 0.5, 1].map((f) => round(Math.min(balance * f, 1000000), 5000)))].filter((c) => c >= 10000);
    const baseBest = bestSavings(base.comparison.blocks.base);
    const tries = amounts.map((c) => {
      const a = analyze({ ...fd, __tax: { ...saved, rothConversion: c } });
      const blk = a.comparison.blocks.roth;
      return { c, alone: blk.baseline - blk.scenarios.none.rows.totalTax, paired: bestSavings(blk) - baseBest, label: bestLabel(blk), rate: a.model.roth.projectedTaxRate };
    });
    const alone = tries.reduce((b, t) => (t.alone > b.alone ? t : b), tries[0]);
    const paired = tries.find((t) => t.c === round(Math.min(balance * 0.5, 1000000), 5000)) || tries[0];
    if (alone && alone.alone > 2000) {
      out.push({ kind: 'roth', amount: alone.c, savings: alone.alone, text: `Given ${money(balance)} in pre-tax retirement accounts, consider adding a Roth conversion. Converting about ${money(alone.c)} this year would save roughly ${money(alone.alone)} versus paying ${pct(alone.rate, 0)} on those withdrawals later${alone.paired > alone.alone + 1000 ? `, or ${money(alone.paired)} paired with ${alone.label}` : ''}.` });
    } else if (paired && paired.paired > 5000) {
      out.push({ kind: 'roth', amount: paired.c, savings: paired.paired, text: `Given ${money(balance)} in pre-tax retirement accounts, consider adding a Roth conversion paired with ${paired.label}. Converting about ${money(paired.c)} would add roughly ${money(paired.paired)} in savings versus not converting.` });
    }
  }
  return out;
}

/** Compact summary for Review & Share (PDF / email) and the priorities prompt. Null without income. */
export function taxSummary(fd = {}) {
  const a = analyze(fd);
  if (a.income <= 0) return null;
  const cmp = a.comparison;
  const rows = strategyRows(cmp, 'base').filter((r) => r.applies);
  const scenarios = blocksFor(a.model).filter((b) => b !== 'base').map((b) => {
    const r = strategyRows(cmp, b).find((x) => x.applies);
    return r ? { label: BLOCK_LABEL[b] + (b === 'db' ? ` (${money(a.model.db.contribution)})` : ` (${money(a.model.roth.conversion)})`), strategy: r.label, savings: r.savings, pct: r.pct } : null;
  }).filter(Boolean);
  return {
    liability: cmp.blocks.base.baseline,
    strategies: rows.map((r) => ({ label: r.label, savings: r.savings, pct: r.pct, liabilityAfter: r.liability })),
    best: rows.find((r) => r.savings > 0.5) ? { label: rows[0].label, savings: rows[0].savings, pct: rows[0].pct } : null,
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

  const draw = () => {
    const f = { ...fd, __tax: saved };
    const tips = suggestions(f);
    resultsEl.innerHTML = resultsHTML(analyze(f), saved, tips);
  };
  const built = intakeToModel({ ...fd, __tax: saved });
  optionsEl.innerHTML = optionsHTML(built, saved, fd);
  draw();

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
    const b = e.target.closest('[data-tx-block]');
    if (b) { saved.block = b.dataset.txBlock; draw(); handlers.save({ ...saved }); return; }
    const ap = e.target.closest('[data-tx-apply]');
    if (ap) {
      const [kind, amount] = ap.dataset.txApply.split(':');
      const key = kind === 'db' ? 'dbContribution' : 'rothConversion';
      saved[key] = +amount;
      saved.block = kind;
      const input = optionsEl.querySelector(`[data-tax="${key}"]`);
      if (input) input.value = commas(+amount);
      draw(); handlers.save({ ...saved });
      return;
    }
    const d = e.target.closest('[data-tx-detail]');
    if (d) { handlers.openDetail(d.dataset.txDetail, saved.block || 'base'); return; }
    const ed = e.target.closest('[data-tx-edit]');
    if (ed) { handlers.editIntake(ed.dataset.txEdit); return; }
    const reset = e.target.closest('[data-tx-reset]');
    if (reset) {
      delete saved.params;
      delete saved.planningFee;
      optionsEl.innerHTML = optionsHTML(intakeToModel({ ...fd, __tax: saved }), saved, fd);
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

function resultsHTML(a, saved, tips = []) {
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
  const rows = strategyRows(cmp, block);
  const best = rows.find((r) => r.applies && r.savings > 0.5);
  const maxSav = Math.max(1, ...rows.map((r) => Math.abs(r.savings)));

  const tabs = blocks.length > 1 ? `<div class="tx-seg" role="tablist">${blocks.map((b) => `<button type="button" role="tab" data-tx-block="${b}" aria-selected="${b === block}">${esc(BLOCK_LABEL[b])}${b === 'db' ? ` · ${money(model.db.contribution)}` : b === 'roth' ? ` · ${money(model.roth.conversion)}` : ''}</button>`).join('')}</div>` : '';

  const overDb = block === 'db' && model.db.contribution > Math.max(0, model.profile.businessIncome);
  const context = block === 'db'
    ? `With a ${money(model.db.contribution)} defined benefit plan contribution (it stays the client's money, so it isn't part of the tax liability).${overDb ? ` Note: a DB contribution is funded from business income (${money(model.profile.businessIncome)}).` : ''}`
    : block === 'roth'
      ? `With a ${money(model.roth.conversion)} Roth conversion. Tax liability without converting includes ${money(cmp.roth.pvRmdTax)} (today's dollars) of tax on future IRA withdrawals.`
      : '';

  const heroLabel = block === 'roth' ? 'Estimated savings vs. not converting' : 'Estimated tax savings this year';
  const liabLabel = block === 'roth' ? 'Tax liability without converting' : 'Current tax liability';
  const hero = best
    ? `<section class="tx-hero">
        <div><div class="tx-hero-label">${heroLabel}</div>
          <div class="tx-hero-value">${money(best.savings)}</div>
          <div class="tx-hero-sub">with <b>${esc(best.label)}</b> · ${pctOf(best.pct)} of total tax liability</div></div>
        <div class="tx-hero-side">
          <div><span>${liabLabel}</span><b>${money(blk.baseline)}</b></div>
          <div><span>Tax liability with ${esc(best.label)}</span><b>${money(best.liability)}</b></div>
        </div></section>`
    : `<section class="tx-hero tx-hero-none"><div><div class="tx-hero-label">${heroLabel}</div>
        <div class="tx-hero-value">—</div><div class="tx-hero-sub">None of the modeled strategies lower this client's tax liability at this income.</div></div>
        <div class="tx-hero-side"><div><span>${liabLabel}</span><b>${money(blk.baseline)}</b></div></div></section>`;

  const tipHTML = tips.map((s) => `<section class="tx-suggest"><p>${esc(s.text)}</p>
      <button type="button" class="btn btn-sm" data-tx-apply="${s.kind}:${Math.round(s.amount)}">Add ${s.kind === 'db' ? 'DB contribution' : 'Roth conversion'} of ${money(s.amount)}</button></section>`).join('');

  const cards = rows.map((r) => {
    if (!r.applies) {
      const why = naReason(r);
      return `<div class="tx-row tx-row-na"><div class="tx-row-main"><div class="tx-row-title">${esc(r.label)}</div>
        <div class="tx-row-desc">${esc(STRATEGY_BLURB[r.id])}</div></div><div class="tx-row-na-label">Not applicable${why ? `<br>${esc(why)}` : ''}</div></div>`;
    }
    const w = Math.max(2, Math.abs(r.savings) / maxSav * 100);
    const note = r.r.warnings.find((x) => /negative|carries|more than|does not apply/.test(x));
    const neg = r.savings < 0;
    return `<button type="button" class="tx-row" data-tx-detail="${r.id}">
      <div class="tx-row-main"><div class="tx-row-title">${esc(r.label)}${best && best.id === r.id ? '<span class="tx-best">Best</span>' : ''}</div>
        <div class="tx-row-desc">${esc(STRATEGY_BLURB[r.id])}</div>
        <div class="tx-row-facts"><span>Total tax liability ${money(blk.baseline)} → ${money(r.liability)}</span></div>
        ${note ? `<div class="tx-row-note">${esc(simplifyWarning(note))}</div>` : ''}</div>
      <div class="tx-row-value"><div class="tx-sav-label">${neg ? 'Added cost' : 'Savings'}</div>
        <div class="tx-sav ${neg ? 'neg' : ''}">${money(Math.abs(r.savings))}</div>
        <div class="tx-bar" role="img" aria-label="${neg ? 'Added cost' : 'Savings'} ${pctOf(Math.abs(r.pct))} of tax liability"><i class="${neg ? 'neg' : ''}" style="width:${w}%"></i></div>
        <div class="tx-row-pct">${pctOf(Math.abs(r.pct))} of tax liability</div>
        <div class="tx-row-cta">Details →</div></div></button>`;
  }).join('');

  return `${profile}${tabs}${context ? `<p class="tx-context">${esc(context)}</p>` : ''}${hero}${tipHTML}
    <section class="tx-card"><div class="tx-card-head"><h3>Strategy comparison</h3><span class="tx-card-sub">Select a strategy for the detailed calculation</span></div>
      <div class="tx-list">${cards}</div>
    </section>`;
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
  html += field('dbContribution', 'DB plan contribution', commas(m.db.contribution), m.profile.businessIncome > 0 ? 'Adds a "With DB plan" comparison.' : 'Funded from business income; none in the intake.');
  html += field('rothConversion', 'Roth conversion', commas(m.roth.conversion), taxDeferred ? `Pre-tax retirement balance in the intake: ${money(taxDeferred)}.` : 'Adds a "With Roth conversion" comparison.');
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
  const a = analyze(fd);
  const { model, comparison: cmp } = a;
  const blocks = blocksFor(model);
  if (!blocks.includes(block)) block = 'base';
  const strategies = SCENARIOS.filter((s) => s.id !== 'none');
  if (!strategies.some((s) => s.id === scenario)) {
    const best = strategyRows(cmp, block).find((r) => r.applies);
    scenario = best ? best.id : strategies[0].id;
  }
  const none = cmp.blocks.base.scenarios.none;
  const res = cmp.blocks[block].scenarios[scenario];
  const sit = res.situation, nsit = none.situation;
  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
  const R = res.return, N = none.return;
  const pv = block === 'roth' ? cmp.roth.pvRmdTax : 0;

  const line = (label, before, after, opts = {}) => {
    const diff = after - before;
    const showDiff = opts.diff !== false && Math.abs(diff) >= 0.5;
    return `<tr class="${opts.cls || ''}"><th scope="row">${esc(label)}${opts.hint ? `<small>${esc(opts.hint)}</small>` : ''}</th>
      <td>${opts.blankBefore ? '' : money(before)}</td><td>${money(after)}</td>
      <td class="${showDiff && opts.goodWhenDown ? (diff < 0 ? 'up' : 'down') : ''}">${showDiff ? `${diff > 0 ? '+' : '−'}${money(Math.abs(diff)).replace('−', '')}` : ''}</td></tr>`;
  };
  const extraIncome = block === 'roth' ? model.roth.conversion : 0;
  const dbAdj = block === 'db' ? model.db.contribution : 0;
  const losses = sum(sit.businessLosses) + sum(sit.capitalLosses);
  const gifts = sum(sit.charitable);
  const credits = R.creditAllowed;
  const rowsHTML = [
    line('Total income', a.income, a.income + extraIncome, { hint: block === 'roth' ? 'includes the Roth conversion' : '' }),
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

  const tabs = `<div class="tx-pills">${strategies.map((s) => `<button type="button" data-tx-pick="${s.id}" aria-selected="${s.id === scenario}">${esc(s.label)}</button>`).join('')}</div>`;
  const blockTabs = blocks.length > 1 ? `<div class="tx-seg">${blocks.map((b) => `<button type="button" data-tx-pick-block="${b}" aria-selected="${b === block}">${esc(BLOCK_LABEL[b])}</button>`).join('')}</div>` : '';
  const strat = SCENARIOS.find((s) => s.id === scenario);
  const notes = strat.steps.flatMap((st) => STRATEGIES[st.strategy].notes.slice(0, 1));
  const warnings = res.warnings.map(simplifyWarning);

  root.innerHTML = `${tabs}${blockTabs}
    <section class="tx-hero tx-hero-detail">
      <div><div class="tx-hero-label">${esc(strat.label)} · ${esc(BLOCK_LABEL[block])}</div>
        <div class="tx-hero-value ${res.savings < 0 ? 'neg' : ''}">${res.savings < 0 ? '−' : ''}${money(Math.abs(res.savings)).replace('−', '')}</div>
        <div class="tx-hero-sub">${block === 'roth' ? 'estimated savings vs. not converting' : 'estimated tax savings this year'} · ${pctOf(Math.abs(res.savings) / Math.max(1, none.rows.totalOutlay + pv))} of total tax liability</div></div>
      <div class="tx-hero-side"><div><span>Total tax liability</span><b>${money(none.rows.totalOutlay + pv)} → ${money(liabilityOf(res))}</b></div></div>
    </section>
    ${warnings.length ? `<ul class="tx-warnlist">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <section class="tx-card"><h3>Without vs. with ${esc(strat.label)}</h3>
      <div class="tx-table-wrap"><table class="tx-compare"><thead><tr><th></th><th>No planning</th><th>${esc(strat.label)}</th><th>Change</th></tr></thead>
      <tbody>${rowsHTML}</tbody></table></div>
      <div class="tx-savings-line"><span>Estimated savings</span><b class="${res.savings < 0 ? 'down' : 'up'}">${money(res.savings)}</b></div>
    </section>
    <section class="tx-card"><h3>How it's calculated</h3>
      ${sizingHTML ? `<h4>Sizing</h4>${sizingHTML}` : ''}
      ${costs ? `<h4>Contribution</h4><table class="tx-how">${costs}</table>` : ''}
      <h4>Tax · ${esc(FILING_LABEL[model.profile.filingStatus].toLowerCase())}, 2026 rates</h4><table class="tx-how">${taxLines(R)}</table>
      ${notes.length ? `<p class="tx-foot">${notes.map(esc).join(' ')}</p>` : ''}
      <details class="tx-full"><summary>Full calculation</summary>${fullLedger(res.ledger)}</details>
    </section>
    <p class="tx-foot">PFO Tax Strategy Calculator method, 2026 federal rates (Rev. Proc. 2025-32). Estimates for discussion, not tax advice.</p>`;

  root.onclick = (e) => {
    const p = e.target.closest('[data-tx-pick]');
    if (p) { handlers.select(p.dataset.txPick, block); return; }
    const b = e.target.closest('[data-tx-pick-block]');
    if (b) handlers.select(scenario, b.dataset.txPickBlock);
  };
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
