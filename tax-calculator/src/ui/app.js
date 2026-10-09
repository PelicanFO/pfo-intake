// Calculator page: inputs on the left, comparison + audit on the right.
// All math lives in src/engine (corrected) and src/excel (workbook replica); this file only renders.
import { defaultModel, cloneModel } from '../engine/model.js';
import { runComparison } from '../engine/compare.js';
import { SCENARIOS, BLOCKS } from '../engine/scenarios.js';
import { CORRECTIONS, ALL_ON, ALL_OFF } from '../engine/rules.js';
import { reconcile } from '../engine/reconcile.js';
import { STRATEGIES } from '../strategies/index.js';
import { STATES } from '../tables/states/index.js';
import { money, pct } from '../engine/ledger.js';
import workbookData from '../excel/workbook-data.js';
import { Workbook } from '../excel/workbook.js';
import { applyModel, readGrid } from '../excel/mapping.js';
import { isError } from '../excel/formula.js';

const STORE_KEY = 'pfo-tax-calculator:v1';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ui = {
  model: load() || defaultModel(),
  mode: 'excel',          // excel (default for now) | compare | corrected
  tab: 'base',            // base | db | roth | projection | corrections
  selected: { block: 'base', scenario: 'film', row: 'savings' },
  auditView: null,        // corrected | excel | reconcile
  traceOpen: new Set(),
};
const wb = new Workbook(workbookData);
let engine, grid, excelWarnings = [];

// ------------------------------------------------------------------ persistence (per-browser convenience)
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const d = defaultModel();
    return { ...d, ...saved, profile: { ...d.profile, ...saved.profile }, roth: { ...d.roth, ...saved.roth },
      db: { ...d.db, ...saved.db }, params: mergeParams(d.params, saved.params), rules: { ...d.rules, ...saved.rules }, sizing: saved.sizing || d.sizing };
  } catch { return null; }
}
function mergeParams(d, s = {}) { const o = {}; for (const k of Object.keys(d)) o[k] = { ...d[k], ...(s[k] || {}) }; return o; }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(ui.model)); } catch { /* storage unavailable */ } }

// ------------------------------------------------------------------ model paths
const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ui.model);
function set(path, value) {
  const keys = path.split('.');
  let o = ui.model;
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
}

// ------------------------------------------------------------------ input definitions
const F = (path, label, type, extra = {}) => ({ path, label, type, ...extra });
const GROUPS = () => [
  {
    title: 'Client', open: true, note: 'Yellow-edged fields are the workbook\'s yellow input cells.',
    fields: [
      F('profile.filingStatus', 'Filing status', 'select', { yellow: 'Strategy comparison!C4', options: [['mfj', 'Married filing jointly'], ['single', 'Single'], ['hoh', 'Head of household'], ['mfs', 'Married filing separately']] }),
      F('profile.state', 'State', 'select', { options: Object.entries(STATES).map(([k, s]) => [k, k === 'CUSTOM' ? 'Other state (enter a rate)' : s.name]) }),
      F('profile.stateCustom.rate', 'Other state: flat rate', 'pct', { nullable: true }),
      F('profile.w2', 'W-2 wages', 'money', { yellow: 'Strategy comparison!C5' }),
      F('profile.businessIncome', 'Business income', 'money', { yellow: 'Strategy comparison!C6' }),
      F('profile.stcg', 'Short-term capital gains', 'money', { yellow: 'Strategy comparison!C7' }),
      F('profile.ltcg', 'Long-term capital gains', 'money', { yellow: 'Strategy comparison!C8' }),
      F('profile.interest', 'Interest', 'money', { yellow: 'Strategy comparison!C9' }),
      F('profile.qualifiedDividends', 'Qualified dividends', 'money', { yellow: 'Strategy comparison!C10' }),
      F('profile.nonqualifiedDividends', 'Non-qualified dividends', 'money', { yellow: 'Strategy comparison!C11' }),
      F('profile.planningFee', 'Planning fee', 'money', { yellow: 'Strategy comparison!C12' }),
      F('profile.age', 'Client age', 'number', { yellow: 'Roth comparison!C3' }),
      F('profile.spouseAge', 'Spouse age (blank = same)', 'number', { nullable: true }),
    ],
  },
  {
    title: 'DB plan and Roth conversion', open: true,
    fields: [
      F('db.contribution', 'DB plan contribution', 'money', { yellow: 'DB comparison!C2' }),
      F('roth.conversion', 'Roth conversion amount', 'money', { yellow: 'Roth comparison!C2' }),
      F('roth.retirementAge', 'Retirement age', 'number', { yellow: 'Roth comparison!C4' }),
      F('roth.minWithdrawalRate', 'Minimum withdrawal rate', 'pct', { yellow: 'Roth comparison!C5' }),
      F('roth.projectedTaxRate', 'Projected tax rate (blank = this year\'s)', 'pct', { yellow: 'Roth comparison!C7', nullable: true }),
      F('roth.discountRate', 'Growth / discount rate', 'pct', { yellow: 'Roth comparison!C9' }),
      F('roth.strategyOverride', 'Strategy used for projection', 'select', { yellow: 'Roth comparison!C11', nullable: true, options: [['', 'Best savings (automatic)'], ...SCENARIOS.map((s) => [s.id, s.label])] }),
    ],
  },
  {
    title: 'Strategy assumptions',
    note: 'Per-strategy inputs from the strategy sheets. They apply to every block.',
    strategies: true,
  },
  {
    title: 'Optional detail (corrected math only)',
    note: 'Defaults are chosen so the client doesn\'t need to answer these. Change them only if you know.',
    fields: [
      F('profile.propertyTax', 'Property tax paid (for SALT)', 'money'),
      F('profile.otherItemized', 'Other itemized deductions', 'money'),
      F('profile.businessType', 'Business income is', 'select', { options: [['passthrough', 'K-1 pass-through (no SE tax)'], ['scheduleC', 'Schedule C (SE tax)']] }),
      F('profile.qbiType', 'QBI treatment', 'select', { options: [['sstb', 'Specified service (conservative)'], ['nonsstb', 'Other business (wage limit not binding)'], ['none', 'No QBI deduction']] }),
    ],
  },
  { title: 'Tax-law corrections', corrections: true, open: true },
];

function fieldHTML(f) {
  const v = get(f.path);
  const id = `f-${f.path.replace(/\./g, '-')}`;
  const ref = f.yellow ? `<span class="cell-ref">${esc(f.yellow)}</span>` : '';
  const cls = f.yellow ? 'yellow' : '';
  let control;
  if (f.type === 'select') {
    control = `<select id="${id}" data-path="${f.path}" data-type="select" class="${cls}">${f.options.map(([k, l]) => `<option value="${esc(k)}" ${String(v ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (f.type === 'pct') {
    const shown = v === null || v === undefined || v === '' ? '' : +(v * 100).toFixed(4);
    control = `<span class="suffix" data-suffix="%"><input id="${id}" data-path="${f.path}" data-type="pct" ${f.nullable ? 'data-nullable="1"' : ''} type="number" step="any" inputmode="decimal" value="${shown}" class="${cls}"></span>`;
  } else {
    const shown = v === null || v === undefined ? '' : v;
    control = `<input id="${id}" data-path="${f.path}" data-type="${f.type}" ${f.nullable ? 'data-nullable="1"' : ''} type="number" step="any" inputmode="decimal" value="${esc(shown)}" class="${cls}">`;
  }
  return `<div class="field"><label for="${id}">${esc(f.label)}${ref}</label>${control}</div>`;
}

function renderInputs() {
  const html = GROUPS().map((g) => {
    let body = '';
    if (g.fields) body = g.fields.map(fieldHTML).join('');
    if (g.strategies) {
      body = Object.values(STRATEGIES).map((s) => `<div class="strategy-title">${esc(s.name)}</div>` + s.params.map((p) => fieldHTML({
        path: `params.${s.id}.${p.key}`, label: p.label, type: p.type === 'pct' ? 'pct' : p.type === 'choice' ? 'select' : 'number',
        options: p.choices, yellow: /!(D4|D7|D12|C16|C17|D6|E6|D9|E9)$/.test(p.excel || '') ? p.excel : null,
      })).join('')).join('');
    }
    if (g.corrections) {
      body = `<p class="group-note">Each switch fixes one way the workbook departs from 2026 tax law. All off = the workbook's own math.</p>
        <div class="row-actions"><button type="button" class="ghost" data-rules="on">All on</button><button type="button" class="ghost" data-rules="off">All off</button></div>` +
        CORRECTIONS.map((c) => `<label class="toggle"><input type="checkbox" data-rule="${c.id}" ${ui.model.rules[c.id] ? 'checked' : ''}>
          <span><span class="t-label">${esc(c.label)}</span><br><span class="t-detail">${esc(c.law)}</span></span></label>`).join('');
    }
    return `<details class="group" ${g.open ? 'open' : ''}><summary>${esc(g.title)}</summary>${g.note ? `<p class="group-note">${esc(g.note)}</p>` : ''}${body}</details>`;
  }).join('');
  $('#inputs').innerHTML = html;
}

// ------------------------------------------------------------------ compute
function recompute() {
  engine = runComparison(ui.model);
  excelWarnings = applyModel(wb, ui.model);
  grid = readGrid(wb);
  save();
  renderResults();
}

// ------------------------------------------------------------------ results
const ENGINE_ROWS = [
  { key: 'retirementContribution', label: 'DB plan contribution (stays the client\'s)', info: true, blocks: ['db'] },
  { key: 'fedOrdinary', label: 'Federal income tax' },
  { key: 'fedLtcg', label: 'Federal tax on gains & qualified dividends' },
  { key: 'amt', label: 'Alternative minimum tax', hideIfZero: true },
  { key: 'niit', label: 'Net investment income tax', hideIfZero: true },
  { key: 'payroll', label: 'Additional Medicare / SE tax', hideIfZero: true },
  { key: 'state', label: 'State income tax' },
  { key: 'contribution', label: 'Strategy contribution' },
  { key: 'fee', label: 'Planning fee', hideIfZero: true },
  { key: 'totalOutlay', label: 'Total cash outlay', strong: true, sep: true },
  { key: 'savings', label: 'Savings', strong: true, accent: true },
  { key: 'effectiveRate', label: 'Outlay as % of income', fmt: 'pct' },
  { key: 'netAdditionalSavings', label: 'Extra savings vs. no conversion', blocks: ['roth'] },
  { key: 'investmentAccount', label: 'Investment account (kept, not counted)', info: true, hideIfZero: true, sep: true },
  { key: 'creditCarryforward', label: 'Unused credit carried over', info: true, hideIfZero: true },
  { key: 'nolCarryforward', label: 'Loss carried forward (NOL)', info: true, hideIfZero: true },
  { key: 'charitableCarryforward', label: 'Charitable carryforward', info: true, hideIfZero: true },
];
const EXCEL_ROWS = [
  { key: 'retirementContribution', label: 'DB contribution', blocks: ['db'] },
  { key: 'fedOrdinary', label: 'Fed ordinary income tax' },
  { key: 'fedLtcg', label: 'Fed LTCG tax' },
  { key: 'state', label: 'State tax' },
  { key: 'contribution', label: 'Strategy contribution' },
  { key: 'investmentAccount', label: 'Investment account' },
  { key: 'fee', label: 'Fee' },
  { key: 'totalOutlay', label: 'Total cash outlay', strong: true, sep: true },
  { key: 'savings', label: 'Savings', strong: true, accent: true },
  { key: 'effectiveRate', label: 'Effective tax rate', fmt: 'pct' },
  { key: 'netAdditionalSavings', label: 'Net additional savings', blocks: ['roth'] },
];

function engineValue(block, sid, key) {
  const r = engine.blocks[block].scenarios[sid];
  if (key === 'savings' || key === 'effectiveRate' || key === 'netAdditionalSavings') return r[key];
  return r.rows[key];
}
function excelValue(block, sid, key) {
  const c = grid[block]?.[sid]?.[key];
  return c ? c.value : undefined;
}
function fmt(v, kind) {
  if (v === undefined) return '';
  if (isError(v)) return v.code;
  if (typeof v !== 'number') return esc(v ?? '');
  if (kind === 'pct') return pct(v, 1);
  return money(v);
}
const sign = (v) => (typeof v === 'number' && Math.abs(v) >= 0.5 ? (v > 0 ? 'pos' : 'neg') : '');

function renderResults() {
  const tabs = [...BLOCKS.map((b) => [b.id, b.label]), ['projection', 'Roth projection'], ['corrections', 'Corrections']];
  let body = '';
  if (ui.tab === 'projection') body = renderProjection();
  else if (ui.tab === 'corrections') body = renderCorrections();
  else body = renderBlock(ui.tab);
  $('#results').innerHTML = `<nav class="tabs" role="tablist">${tabs.map(([id, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${ui.tab === id}">${esc(l)}</button>`).join('')}</nav>${body}`;
  document.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === ui.mode)));
}

function renderBlock(block) {
  const b = BLOCKS.find((x) => x.id === block);
  const banners = [];
  if (ui.mode !== 'corrected' && excelWarnings.length) banners.push(...excelWarnings.map((w) => `<div class="banner warn">${esc(w)}</div>`));
  if (ui.mode === 'excel') banners.push('<div class="banner info">Excel replica: these are the workbook\'s own formulas, recalculated for the inputs on the left. Click any number to see the formulas behind it.</div>');
  if (ui.mode === 'compare') banners.push('<div class="banner info">Corrected values with the workbook\'s value underneath. Click any number for the line-by-line calculation and the reconciliation.</div>');
  const rows = (ui.mode === 'excel' ? EXCEL_ROWS : ENGINE_ROWS).filter((r) => !r.blocks || r.blocks.includes(block));
  const visible = rows.filter((r) => !r.hideIfZero || SCENARIOS.some((s) => Math.abs(engineValue(block, s.id, r.key) || 0) >= 0.5));
  const head = SCENARIOS.map((s) => {
    const w = engine.blocks[block].scenarios[s.id].warnings;
    const steps = s.steps.map((st) => STRATEGIES[st.strategy].name).join(' → ');
    return `<th scope="col">${esc(s.label)}${w.length && ui.mode !== 'excel' ? `<span class="warn-dot" title="${esc(w.join('\n'))}">⚠</span>` : ''}<span class="col-sub">${esc(steps || '—')}</span></th>`;
  }).join('');
  const bodyRows = visible.map((r) => {
    const cls = [r.strong && 'strong', r.accent && 'accent', r.info && 'info', r.sep && 'sep'].filter(Boolean).join(' ');
    const label = typeof r.label === 'function' ? r.label() : r.label;
    const cells = SCENARIOS.map((s) => {
      const sel = ui.selected.block === block && ui.selected.scenario === s.id && ui.selected.row === r.key ? ' selected' : '';
      const ev = ui.mode === 'excel' ? excelValue(block, s.id, r.key) : engineValue(block, s.id, r.key);
      let inner = `<span class="${r.accent ? sign(ev) : ''}">${fmt(ev, r.fmt)}</span>`;
      if (ui.mode === 'compare' && !r.info) {
        const xv = excelValue(block, s.id, r.key);
        if (xv !== undefined) {
          inner += `<span class="excel">Excel ${fmt(xv, r.fmt)}</span>`;
          if (r.key === 'savings' && typeof xv === 'number') {
            const d = ev - xv;
            if (Math.abs(d) >= 1) inner += `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${money(d)}</span>`;
          }
        }
      }
      return `<td class="num cell${sel}" data-block="${block}" data-scenario="${s.id}" data-row="${r.key}" tabindex="0">${inner}</td>`;
    }).join('');
    return `<tr class="${cls}"><th scope="row">${esc(label)}</th>${cells}</tr>`;
  }).join('');
  return `<p class="block-intro">${esc(b.description)}</p>${banners.join('')}
    ${renderSizing(block)}
    <div class="card table-wrap"><table class="grid"><thead><tr><th scope="col">${ui.mode === 'excel' ? 'Workbook row' : ''}</th>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>
    ${ui.selected.block === block ? renderAudit() : ''}
    <p class="footnote">Savings compare total cash outlay (tax + strategy contributions + fees) with No Planning${block === 'roth' ? ' plus the present value of tax on future IRA withdrawals' : ''}. Carryforwards (unused credits, losses, gifts over the AGI limit) have future value but are not counted, so this year's savings are conservative.</p>`;
}

// Sizing controls: the workbook's "Manual Inputs" area for this block.
function renderSizing(block) {
  const items = [];
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      const strat = STRATEGIES[step.strategy];
      for (const f of strat.sizing) {
        const path = `sizing.${block}.${s.id}.${strat.id}.${f.key}`;
        const v = get(path);
        const mode = typeof v === 'number' ? 'manual' : v && v.fillToBracket ? `fill:${v.fillToBracket}` : 'auto';
        const fillOk = f.allowFill && s.steps.length === 1;
        const ref = f.excel?.[block];
        const autoLabel = f.autoLabel ? 'Solve' : step.options?.capToBracket ? 'Default (capped at 24%)' : 'Default rule';
        items.push(`<div class="s-item"><span class="s-label">${esc(s.label)} · ${esc(f.label)}${ref ? ` <span class="cell-ref">${esc(ref)}</span>` : ''}</span>
          <span class="s-controls"><select data-sizing="${path}" aria-label="${esc(`${s.label} ${f.label} sizing`)}">
            <option value="auto" ${mode === 'auto' ? 'selected' : ''}>${autoLabel}</option>
            ${fillOk ? [0.12, 0.22, 0.24, 0.32].map((r) => `<option value="fill:${r}" ${mode === `fill:${r}` ? 'selected' : ''}>Fill to ${r * 100}% bracket</option>`).join('') : ''}
            <option value="manual" ${mode === 'manual' ? 'selected' : ''}>Amount</option></select>
          ${mode === 'manual' ? `<input type="number" step="any" class="yellow" data-sizing-amount="${path}" value="${v}" aria-label="${esc(`${s.label} ${f.label} amount`)}">` : ''}</span></div>`);
      }
    }
  }
  return `<details class="card sizing" ${ui.sizingOpen ? 'open' : ''} data-sizing-panel><summary class="sizing-title">Strategy sizing (workbook "Manual Inputs")</summary>${items.join('')}</details>`;
}

// ------------------------------------------------------------------ audit drawer
function renderAudit() {
  const { block, scenario, row } = ui.selected;
  const res = engine.blocks[block].scenarios[scenario];
  const views = ui.mode === 'excel' ? ['excel'] : ui.mode === 'corrected' ? ['corrected', 'reconcile'] : ['corrected', 'excel', 'reconcile'];
  if (!views.includes(ui.auditView)) ui.auditView = views[0];
  const names = { corrected: 'Line-by-line calculation', excel: 'Workbook formulas', reconcile: 'Reconcile with Excel' };
  let content = '';
  if (ui.auditView === 'corrected') {
    content = (res.warnings.length ? `<ul class="warnings">${res.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '')
      + renderLedger(res.ledger)
      + `<p class="small muted">Assumptions behind each strategy: ${res.label === 'No Planning' ? 'none.' : ''}</p>`
      + SCENARIOS.find((s) => s.id === scenario).steps.map((st) => `<p class="small muted"><b>${esc(STRATEGIES[st.strategy].name)}:</b> ${STRATEGIES[st.strategy].notes.map(esc).join(' ')}</p>`).join('');
  } else if (ui.auditView === 'excel') {
    const ref = grid[block]?.[scenario]?.[row]?.ref;
    content = ref ? renderTrace(ref) : '<p class="muted">This row has no workbook equivalent.</p>';
  } else {
    content = renderReconcile(block, scenario);
  }
  const blockLabel = BLOCKS.find((b) => b.id === block).label;
  return `<section class="card audit" aria-label="Audit">
    <div class="audit-head"><h2>${esc(res.label)} <span class="sec-note">${esc(blockLabel)}</span></h2>
      <span>${ui.auditView === 'corrected' ? '<button type="button" class="ghost" data-export>Download audit (CSV)</button>' : ''}</span></div>
    ${views.length > 1 ? `<div class="sub-tabs">${views.map((v) => `<button type="button" data-audit="${v}" aria-selected="${ui.auditView === v}">${names[v]}</button>`).join('')}</div>` : ''}
    ${content}</section>`;
}

function renderLedger(ledger) {
  return ledger.sections.filter((s) => s.lines.length).map((s) => `<h3>${esc(s.title)}${s.note ? `<span class="sec-note">${esc(s.note)}</span>` : ''}</h3>
    <table class="ledger"><tbody>${s.lines.map((l) => {
      const amount = l.amount === null || l.amount === undefined ? '' : (Math.abs(l.amount) < 1.5 && l.amount !== 0 && !Number.isInteger(l.amount) && /rate|%|limit$/i.test(l.label + (l.calc || '')) ? pct(l.amount, 2) : money(l.amount));
      return `<tr class="${l.kind || ''}"><td class="l">${esc(l.label)}</td><td class="c">${esc(l.calc || '')}</td><td class="num">${amount}</td><td class="s">${esc(l.source || l.excel || '')}</td></tr>`;
    }).join('')}</tbody></table>`).join('');
}

function renderTrace(ref) {
  const node = (n, depth) => {
    const open = ui.traceOpen.has(n.ref) || depth === 0;
    const kids = open && n.formula ? wb.trace(n.ref, 1).children : [];
    const label = [n.rowLabel, n.colLabel].filter(Boolean).join(' · ');
    const val = n.value === null || n.value === undefined ? '' : isError(n.value) ? n.value.code : typeof n.value === 'number' ? (Math.abs(n.value) < 2 && !Number.isInteger(n.value) ? n.value.toFixed(4) : money(n.value)) : esc(n.value);
    return `<li><div class="node">${n.formula ? `<button type="button" class="tog" data-trace="${esc(n.ref)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>` : '<span></span>'}
      <span class="ref">${esc(n.ref)}${n.input ? '<span class="inp">input</span>' : ''}</span>
      <span class="lbl">${esc(label)}${n.formula ? `<span class="f">${esc(n.formula)}</span>` : ''}</span>
      <span class="val num">${val}</span></div>
      ${kids.length ? `<ul>${kids.map((k) => node(k, depth + 1)).join('')}</ul>` : ''}</li>`;
  };
  const root = wb.trace(ref, 0);
  return `<div class="trace"><p class="small muted">Click ▸ to open the cells a formula uses. Yellow "input" cells are the workbook's inputs.</p><ul>${node(root, 0)}</ul></div>`;
}

function renderReconcile(block, scenario) {
  const xs = excelValue(block, scenario, 'savings');
  const rec = reconcile(ui.model, block, scenario, typeof xs === 'number' ? { savings: xs } : null);
  const maxAbs = Math.max(1, ...rec.steps.map((s) => Math.abs(s.delta ?? s.savings)));
  const rows = rec.steps.map((s) => {
    const isBase = s.delta === null;
    const v = isBase ? s.savings : s.delta;
    const w = Math.min(100, Math.abs(v) / maxAbs * 100);
    const on = ui.model.rules[s.id];
    return `<tr class="${isBase ? 'total' : ''}"><td class="l">${esc(s.label)}${!isBase && s.id !== 'mechanics' && on === false ? ' <span class="muted small">(switched off on the left)</span>' : ''}${s.detail ? `<div class="step-detail">${esc(s.detail)}</div>` : ''}</td>
      <td class="num ${isBase ? '' : sign(v)}">${isBase ? money(v) : Math.abs(v) < 0.5 ? '—' : `${v > 0 ? '+' : ''}${money(v)}`}</td>
      <td class="bar"><div class="wbar ${isBase ? 'base' : v < 0 ? 'down' : ''}" style="width:${w}%"></div></td></tr>`;
  }).join('');
  return `<p class="small muted">Starts from the workbook's savings for this cell, then switches each correction on in turn. The steps add up exactly to the corrected savings.</p>
    <table class="ledger waterfall"><tbody>${rows}
    <tr class="total"><td class="l">Corrected savings (all corrections on)</td><td class="num">${money(rec.corrected.savings)}</td><td></td></tr></tbody></table>`;
}

// ------------------------------------------------------------------ Roth projection tab
function renderProjection() {
  const r = engine.roth, x = grid.rothProjection;
  const xv = (k) => (x[k] ? fmt(x[k].value) : '');
  const stat = (k, label, v, xk) => `<div class="card stat"><div class="k">${esc(label)}</div><div class="v">${money(v)}</div>${ui.mode !== 'corrected' ? `<div class="x">Excel ${xv(xk)}</div>` : ''}</div>`;
  const yrs = r.rows.filter((y) => y.withdrawalRate > 0 || y.age === r.rows[0].age);
  return `<p class="block-intro">Converting ${money(r.conversion)} now vs. leaving it in a traditional IRA. Strategy savings come from <b>${esc(r.strategyLabel)}</b> in the conversion year${ui.model.roth.strategyOverride ? ' (chosen on the left)' : ' (the largest savings)'}.</p>
    <div class="stats">
      ${stat('a', 'Tax on the conversion', r.conversionTax, 'conversionTax')}
      ${stat('b', 'Net of strategy savings', r.netConversionTax, 'netConversionTax')}
      ${stat('c', 'PV of tax if left in the IRA', r.pvRmdTax, 'pvRmdTax')}
      ${stat('d', 'Roth + savings at 100', r.at100.rothWithSavings, 'rothWithSavingsAt100')}
      ${stat('e', 'Roth at 100', r.at100.roth, 'rothAt100')}
      ${stat('f', 'Traditional IRA at 100 (after tax)', r.at100.traditionalAfterTax, 'traditionalAt100')}
    </div>
    <div class="card audit">${renderLedger(r.ledger)}</div>
    <div class="card table-wrap" style="margin-top:14px"><table class="grid years"><thead><tr><th>Age</th><th>RMD %</th><th>Withdrawal rate</th><th>Traditional withdrawal</th><th>Tax</th><th>After tax</th><th>Roth withdrawal</th><th>Roth + savings withdrawal</th></tr></thead>
    <tbody>${yrs.map((y) => `<tr><th>${y.age}</th><td class="num">${y.rmdPct ? pct(y.rmdPct, 2) : '—'}</td><td class="num">${pct(y.withdrawalRate, 2)}</td><td class="num">${money(y.traditionalWithdrawal)}</td><td class="num">${money(y.tax)}</td><td class="num">${money(y.traditionalAfterTax)}</td><td class="num">${money(y.rothWithdrawal)}</td><td class="num">${money(y.rothPlusWithdrawal)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------------ corrections tab
function renderCorrections() {
  const block = ui.corrBlock || 'base';
  const recs = SCENARIOS.map((s) => {
    const xs = excelValue(block, s.id, 'savings');
    return reconcile(ui.model, block, s.id, typeof xs === 'number' ? { savings: xs } : null);
  });
  const stepIds = recs[0].steps.map((s) => s.id);
  const rows = stepIds.map((id, i) => {
    const step = recs[0].steps[i];
    const isBase = step.delta === null;
    const c = CORRECTIONS.find((x) => x.id === id);
    return `<tr class="${isBase ? 'strong' : ''}"><th scope="row" title="${esc(c ? `${c.excel}\n→ ${c.law}` : step.detail || '')}">${esc(step.label)}</th>${recs.map((r) => {
      const st = r.steps[i];
      const v = isBase ? st.savings : st.delta;
      return `<td class="num ${isBase ? '' : sign(v)}">${isBase ? money(v) : Math.abs(v) < 0.5 ? '—' : `${v > 0 ? '+' : ''}${money(v)}`}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const total = `<tr class="strong accent sep"><th scope="row">Corrected savings</th>${recs.map((r) => `<td class="num ${sign(r.corrected.savings)}">${money(r.corrected.savings)}</td>`).join('')}</tr>`;
  const list = CORRECTIONS.map((c) => `<tr><th scope="row">${esc(c.label)}</th><td>${esc(c.excel)}</td><td>${esc(c.law)}</td><td class="small muted">${esc(c.source)}</td></tr>`).join('');
  return `<p class="block-intro">How each correction changes savings, applied one after another from the workbook's answer. Hover a row for what the workbook does vs. the law.</p>
    <div class="sub-tabs">${BLOCKS.map((b) => `<button type="button" data-corr-block="${b.id}" aria-selected="${block === b.id}">${esc(b.label)}</button>`).join('')}</div>
    <div class="card table-wrap"><table class="grid"><thead><tr><th>Step</th>${SCENARIOS.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${rows}${total}</tbody></table></div>
    <h3 style="font:600 18px var(--serif);color:var(--navy);margin:22px 0 8px">What each correction fixes</h3>
    <div class="card table-wrap"><table class="grid"><thead><tr><th>Correction</th><th style="text-align:left">Workbook</th><th style="text-align:left">Tax law</th><th style="text-align:left">Source</th></tr></thead><tbody>${list}</tbody></table></div>`;
}

// ------------------------------------------------------------------ events
let timer;
function schedule() { clearTimeout(timer); timer = setTimeout(recompute, 120); }

$('#inputs').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.path) {
    const t = el.dataset.type;
    let v = el.value;
    if (t === 'select') v = v === '' && el.closest('.field') ? null : v;
    else if (v === '' || v === null) v = el.dataset.nullable ? null : 0;
    else v = t === 'pct' ? +v / 100 : +v;
    if (t === 'select' && v === '') v = null;
    set(el.dataset.path, v);
    schedule();
  }
});
$('#inputs').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.rule) { ui.model.rules[el.dataset.rule] = el.checked; recompute(); }
});
$('#inputs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rules]');
  if (!b) return;
  ui.model.rules = { ...(b.dataset.rules === 'on' ? ALL_ON : ALL_OFF) };
  renderInputs();
  recompute();
});

$('#results').addEventListener('click', (e) => {
  const t = e.target;
  const tab = t.closest('[data-tab]');
  if (tab) { ui.tab = tab.dataset.tab; if (BLOCKS.some((b) => b.id === ui.tab)) ui.selected.block = ui.tab; renderResults(); return; }
  const cell = t.closest('td.cell');
  if (cell) {
    ui.selected = { block: cell.dataset.block, scenario: cell.dataset.scenario, row: cell.dataset.row };
    ui.traceOpen.clear();
    renderResults();
    $('.audit')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const av = t.closest('[data-audit]');
  if (av) { ui.auditView = av.dataset.audit; renderResults(); return; }
  const tr = t.closest('[data-trace]');
  if (tr) { const r = tr.dataset.trace; if (ui.traceOpen.has(r)) ui.traceOpen.delete(r); else ui.traceOpen.add(r); renderResults(); return; }
  const cb = t.closest('[data-corr-block]');
  if (cb) { ui.corrBlock = cb.dataset.corrBlock; renderResults(); return; }
  if (t.closest('[data-export]')) exportCSV();
});
$('#results').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td.cell')) { e.preventDefault(); e.target.click(); }
});
$('#results').addEventListener('toggle', (e) => {
  if (e.target.matches('[data-sizing-panel]')) ui.sizingOpen = e.target.open;
}, true);
$('#results').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.sizing) {
    const path = t.dataset.sizing;
    const v = t.value;
    if (v === 'auto') set(path, null);
    else if (v === 'manual') set(path, typeof get(path) === 'number' ? get(path) : 0);
    else set(path, { fillToBracket: +v.split(':')[1] });
    recompute();
  } else if (t.dataset.sizingAmount) {
    set(t.dataset.sizingAmount, t.value === '' ? 0 : +t.value);
    recompute();
  }
});

document.querySelector('.segmented').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  ui.mode = b.dataset.mode;
  ui.auditView = null;
  renderResults();
});
$('#reset').addEventListener('click', () => {
  ui.model = defaultModel();
  renderInputs();
  recompute();
});

function exportCSV() {
  const { block, scenario } = ui.selected;
  const res = engine.blocks[block].scenarios[scenario];
  const blob = new Blob([res.ledger.toCSV()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tax-audit-${scenario}-${block}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

renderInputs();
recompute();
