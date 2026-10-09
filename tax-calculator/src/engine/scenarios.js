// Scenarios (columns of the comparison) and blocks (No DB / with DB plan / with Roth conversion),
// and the code that runs one scenario: build the client's situation, let each strategy in the
// scenario change it, then compute the return and the cash outlay.

import { computeReturn, emptySituation } from './taxReturn.js';
import { Ledger, money, pct } from './ledger.js';
import { normalizeRules } from './rules.js';
import { bracketTop } from './brackets.js';
import { federalTables } from '../tables/federal.js';
import { STRATEGIES } from '../strategies/index.js';

/** Columns of the comparison. Steps run in order; later strategies see the earlier ones' effects. */
export const SCENARIOS = [
  { id: 'none', label: 'No Planning', steps: [] },
  { id: 'film', label: 'Film', steps: [{ strategy: 'film' }] },
  { id: 'solar', label: 'Solar', steps: [{ strategy: 'solar' }] },
  { id: 'charitable', label: 'Charitable', steps: [{ strategy: 'charitable' }] },
  // As in the workbook: the gift only brings ordinary income down to the top of the 24% bracket,
  // then Solar is sized against what is left.
  { id: 'solarCharitable', label: 'Solar & Charitable', steps: [{ strategy: 'charitable', options: { capToBracket: 0.24 } }, { strategy: 'solar', options: { excelVariant: 'afterCharitable' } }] },
  { id: 'leap', label: 'LEAP', steps: [{ strategy: 'leap' }] },
  { id: 'leapCharitable', label: 'LEAP & Charitable', steps: [{ strategy: 'leap' }, { strategy: 'charitable' }] },
];

export const BLOCKS = [
  { id: 'base', label: 'Strategies', short: 'No DB', description: 'Each strategy on its own, compared with doing nothing.' },
  { id: 'db', label: 'With DB plan', short: 'DB', description: 'Same strategies after a defined benefit plan contribution. The contribution stays the client\'s money, so it is not a cost.' },
  { id: 'roth', label: 'With Roth conversion', short: 'Roth', description: 'Same strategies in a year with a Roth conversion, compared with not converting and paying tax on IRA withdrawals later.' },
];

export function scenarioById(id, custom = []) {
  return SCENARIOS.find((s) => s.id === id) || custom.find((s) => s.id === id);
}

/** The client's starting situation for a block, before any strategy. */
export function situationFor(model, blockId) {
  const p = model.profile;
  const s = emptySituation();
  s.year = model.year;
  s.filingStatus = p.filingStatus;
  s.state = p.state;
  s.stateCustom = p.stateCustom || null; // { rate, name } for CUSTOM / NONE
  s.ages = { taxpayer: p.age ?? null, spouse: p.spouseAge ?? null };
  s.income = {
    w2: +p.w2 || 0, business: +p.businessIncome || 0, stcg: +p.stcg || 0, ltcg: +p.ltcg || 0, interest: +p.interest || 0,
    qualifiedDividends: +p.qualifiedDividends || 0, nonqualifiedDividends: +p.nonqualifiedDividends || 0, otherOrdinary: 0,
  };
  if (+p.otherIncome) {
    s.income.otherOrdinary += +p.otherIncome;
    s.otherOrdinaryItems.push({ label: 'Other income (rental, royalties, etc.)', amount: +p.otherIncome });
  }
  s.propertyTax = +p.propertyTax || 0;
  s.otherItemized = +p.otherItemized || 0;
  s.businessType = p.businessType || 'passthrough';
  s.qbiType = p.qbiType || 'sstb';
  if (blockId === 'db') {
    const c = +model.db.contribution || 0;
    s.income.business -= c;
    s.businessIncomeAdjustments.push({ label: 'Less defined benefit plan contribution', amount: c, calc: 'reduces business income (spreadsheet: DB comparison!C2)' });
  }
  if (blockId === 'roth') {
    const c = +model.roth.conversion || 0;
    s.income.otherOrdinary += c;
    s.otherOrdinaryItems.push({ label: 'Roth conversion', amount: c });
  }
  return s;
}

export class ScenarioContext {
  constructor(sit, rules, log) {
    this.sit = sit;
    this.rules = rules;
    this.log = log;
    this.costs = [];
    this.warnings = [];
    this.lastSizing = '';
    this.T = federalTables(sit.year);
  }
  evaluate() { return computeReturn(this.sit, this.rules, { ledger: false }); }
  evaluateWith(mutate) {
    const s = JSON.parse(JSON.stringify(this.sit));
    mutate(s);
    return computeReturn(s, this.rules, { ledger: false });
  }
  /** Federal income tax that a general business credit could offset in this return. */
  creditCapacity(r) {
    const income = r.regularTax + r.amt;
    if (!this.rules.creditLimit) return income;
    const g = this.T.generalBusinessCredit;
    return Math.max(0, income - g.pct * Math.max(0, r.regularTax - g.floor));
  }
  bracketTop(rate) { return bracketTop(this.T.ordinaryBrackets[this.sit.filingStatus], rate); }
  warn(msg) { this.warnings.push(msg); this.log.note(msg, 'warn'); }
  clamp(v, what) {
    if (v < 0 && this.rules.clampNegative) {
      this.warn(`${what} came out negative (${money(v)}); set to $0 because the strategy does not apply.`);
      return 0;
    }
    if (v < 0) this.log.note(`${what} is negative (${money(v)}), which increases taxable income (spreadsheet behavior).`, 'warn');
    return v;
  }
  /**
   * Resolve a sizing input: a number (manual), { fillToBracket: rate } (bring taxable income down to
   * the top of that bracket), or null (the strategy's default rule).
   */
  size(spec, { what, auto, current, noFill }) {
    let amount, how;
    if (typeof spec === 'number') { amount = spec; how = 'manual input'; }
    else if (spec && spec.fillToBracket && !noFill) {
      const top = this.bracketTop(spec.fillToBracket);
      amount = current.taxableIncome - top;
      how = `taxable income ${money(current.taxableIncome)} − ${money(top)} (top of the ${pct(spec.fillToBracket, 0)} bracket)`;
    } else [amount, how] = auto();
    amount = this.clamp(amount, what);
    this.lastSizing = how;
    this.log.line(what, amount, { calc: how, kind: 'input' });
    return amount;
  }
  addBusinessLoss(x) { this.sit.businessLosses.push(x); }
  addCapitalLoss(x) { this.sit.capitalLosses.push(x); }
  addCharitable(x) { this.sit.charitable.push(x); }
  addCredit(x) { this.sit.credits.push(x); }
  addCost(c) { this.costs.push(c); }
}

/** Run one scenario in one block. Returns the return, the costs and the audit ledger. */
export function runScenario(model, blockId, scenario) {
  const rules = normalizeRules(model.rules);
  const sit = situationFor(model, blockId);
  const log = new Ledger(`${scenario.label} — ${BLOCKS.find((b) => b.id === blockId)?.label || blockId}`);
  const ctx = new ScenarioContext(sit, rules, log);
  log.section('Strategy sizing', scenario.steps.length ? scenario.steps.map((s) => STRATEGIES[s.strategy].name).join(' → ') : 'No strategies');
  if (blockId === 'db') log.line('Defined benefit plan contribution', +model.db.contribution || 0, { kind: 'input', excel: 'DB comparison!C2' });
  if (blockId === 'roth') log.line('Roth conversion', +model.roth.conversion || 0, { kind: 'input', excel: 'Roth comparison!C2' });
  for (const step of scenario.steps) {
    const strat = STRATEGIES[step.strategy];
    const params = { ...Object.fromEntries(strat.params.map((p) => [p.key, p.default])), ...(model.params?.[strat.id] || {}) };
    const sizing = model.sizing?.[blockId]?.[scenario.id]?.[strat.id] || {};
    strat.apply(ctx, params, sizing, step.options || {});
  }
  // The planning fee applies to every planned scenario (the spreadsheet charges it in the DB and
  // Roth "no planning" columns too, but not in the base No Planning column).
  const fee = +model.profile.planningFee || 0;
  if (fee && !(blockId === 'base' && scenario.id === 'none')) ctx.addCost({ kind: 'fee', label: 'Planning fee', amount: fee, excel: 'Strategy comparison!C12' });
  if (blockId === 'db' && +model.db.contribution) ctx.addCost({ kind: 'retirement', label: 'DB plan contribution (stays in the plan)', amount: +model.db.contribution });

  const r = computeReturn(sit, rules, { ledger: true });
  const cf = r.carryforwards;
  if (cf.credit > 1) ctx.warnings.push(`${money(cf.credit)} of credit is more than this year's tax can absorb. It carries back 1 year / forward 20 and is not counted in these savings.`);
  if (cf.nol > 1) ctx.warnings.push(`${money(cf.nol)} of strategy losses exceed the excess business loss limit. It becomes a net operating loss carryforward and is not counted in these savings.`);
  if (cf.charitable > 1) ctx.warnings.push(`${money(cf.charitable)} of the donation is over the AGI limit. It carries forward up to 5 years and is not counted in these savings.`);
  if (cf.capitalLoss > 1) ctx.warnings.push(`${money(cf.capitalLoss)} of capital loss carries forward to future years and is not counted in these savings.`);
  const costOf = (k) => ctx.costs.filter((c) => c.kind === k).reduce((s, c) => s + c.amount, 0);
  const rows = {
    fedOrdinary: r.totals.fedOrdinary,
    fedLtcg: r.totals.fedLtcg,
    amt: r.totals.amt,
    niit: r.totals.niit,
    payroll: r.totals.payroll,
    state: r.totals.state,
    totalTax: r.totals.total,
    contribution: costOf('contribution'),
    fee: costOf('fee'),
    investmentAccount: costOf('asset'),
    retirementContribution: costOf('retirement'),
    creditCarryforward: r.carryforwards.credit,
    nolCarryforward: r.carryforwards.nol,
    charitableCarryforward: r.carryforwards.charitable,
  };
  rows.totalOutlay = rows.totalTax + rows.contribution + rows.fee;

  const costLedger = new Ledger();
  costLedger.section('Cash outlay');
  costLedger.line('Total tax', rows.totalTax);
  for (const c of ctx.costs) {
    costLedger.line(c.label, c.amount, { calc: c.calc, excel: c.excel, kind: c.kind === 'asset' || c.kind === 'retirement' ? 'info' : 'calc' });
  }
  costLedger.line('Total cash outlay (tax + contributions + fees)', rows.totalOutlay, { kind: 'total', calc: 'investment-account and plan balances stay with the client and are not counted' });

  const ledger = new Ledger(log.title);
  ledger.append(log);
  ledger.append(r.ledger);
  ledger.append(costLedger);
  return { blockId, scenarioId: scenario.id, label: scenario.label, return: r, costs: ctx.costs, warnings: ctx.warnings, rows, ledger, situation: sit };
}
