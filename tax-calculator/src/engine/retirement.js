// Roth conversion vs. keeping the money in a traditional IRA (the workbook's "RMD Simulation").
// The converted amount is followed from today to age 100 three ways:
//   traditional IRA — withdrawals taxed at the projected rate;
//   Roth, no strategy — the conversion tax comes out of the account up front;
//   Roth, with strategy — the strategy's extra savings are added to the Roth.
// Withdrawals each year are the larger of the RMD percentage and the minimum withdrawal rate,
// starting at retirement age, and everything left is withdrawn at 100.
import { Ledger, money, pct } from './ledger.js';
import { UNIFORM_LIFETIME, rmdStartAge } from '../tables/federal.js';

export function rothProjection(model, rules, { conversionTax, strategySavings, strategyLabel }) {
  const r = model.roth;
  const age = Math.round(+model.profile.age || 0);
  const conversion = +r.conversion || 0;
  const g = +r.discountRate || 0;
  const birthYear = model.year - age;
  const startAge = rules.rmdStartAge ? rmdStartAge(birthYear) : 73;
  const effectiveRate = conversion ? conversionTax / conversion : 0;
  const rate = r.projectedTaxRate === null || r.projectedTaxRate === undefined || r.projectedTaxRate === '' ? effectiveRate : +r.projectedTaxRate;

  const rows = [];
  let trad = conversion, roth = conversion - conversionTax, rothPlus = conversion - conversionTax + strategySavings;
  let pv = 0, tradTaxable = 0, rothTaxable = 0, rothPlusTaxable = 0;
  for (let a = age; a <= 100; a++) {
    if (a > age) { trad *= 1 + g; roth *= 1 + g; rothPlus *= 1 + g; }
    const rmdPct = a >= startAge ? 1 / (UNIFORM_LIFETIME[Math.min(a, 105)] || 6.4) : 0;
    const w = a < (+r.retirementAge || 0) ? 0 : a === 100 ? 1 : Math.max(rmdPct, +r.minWithdrawalRate || 0);
    const tradW = trad * w, rothW = roth * w, rothPlusW = rothPlus * w;
    const tax = tradW * rate;
    const t = a - age;
    if (t > 0 || rules.rmdFirstYearTax) pv += tax / Math.pow(1 + g, t);
    tradTaxable = tradTaxable * (1 + g) + (tradW - tax);
    rothTaxable = rothTaxable * (1 + g) + rothW;
    rothPlusTaxable = rothPlusTaxable * (1 + g) + rothPlusW;
    rows.push({ age: a, rmdPct, withdrawalRate: w, traditionalBalance: trad, traditionalWithdrawal: tradW, tax, traditionalAfterTax: tradW - tax,
      rothBalance: roth, rothWithdrawal: rothW, rothPlusBalance: rothPlus, rothPlusWithdrawal: rothPlusW });
    trad -= tradW; roth -= rothW; rothPlus -= rothPlusW;
  }
  const last = rows[rows.length - 1];

  const L = new Ledger('Roth conversion projection');
  L.section('Conversion', `Converting ${money(conversion)} at age ${age}`);
  L.line('Tax on the conversion this year', conversionTax, { calc: 'total tax with the conversion − total tax without it (no strategy)', excel: 'Roth comparison!O3' });
  L.line('Effective rate on the conversion', effectiveRate, { kind: 'info', calc: `${money(conversionTax)} ÷ ${money(conversion)}`, excel: 'Roth comparison!C6' });
  L.line(`Extra savings from ${strategyLabel} in the conversion year`, strategySavings, { excel: 'Roth comparison!C13' });
  L.line('Conversion tax net of strategy savings', conversionTax - strategySavings, { kind: 'total', excel: 'Roth comparison!N3' });
  L.section('If the money stays in a traditional IRA');
  L.line('Projected tax rate on withdrawals', rate, { kind: 'input', calc: r.projectedTaxRate === null || r.projectedTaxRate === undefined ? 'this year\'s effective rate on the conversion' : 'input', excel: 'Roth comparison!C8' });
  L.line('Growth and discount rate', g, { kind: 'input', excel: 'Roth comparison!C9' });
  L.line('RMDs begin at age', startAge, { kind: 'info', calc: rules.rmdStartAge ? `born ${birthYear}` : 'spreadsheet: 73 for everyone', source: rules.rmdStartAge ? 'SECURE 2.0 §107' : undefined });
  L.line('Present value of taxes on future withdrawals', pv, { kind: 'total', calc: `each year's withdrawal × ${pct(rate)}, discounted at ${pct(g)}${rules.rmdFirstYearTax ? '' : ' (first year left out, as in the spreadsheet)'}`, excel: 'Roth comparison!P3' });
  L.section('Value left at age 100');
  L.line('Roth, with strategy savings added', last.rothPlusBalance, { excel: 'Roth comparison!N5' });
  L.line('Roth, no strategy', last.rothBalance, { excel: 'Roth comparison!O5' });
  L.line('Traditional IRA, after tax', last.traditionalAfterTax, { excel: 'Roth comparison!P5' });
  L.section('Withdrawals reinvested in a taxable account, value at 100');
  L.line('Traditional IRA', tradTaxable, { excel: 'RMD Simulation!B23' });
  L.line('Roth, no strategy', rothTaxable);
  L.line('Roth, with strategy savings', rothPlusTaxable, { excel: 'RMD Simulation!B29' });

  return {
    conversion, conversionTax, effectiveRate, projectedRate: rate, rmdStartAge: startAge, pvRmdTax: pv,
    strategySavings, strategyLabel, netConversionTax: conversionTax - strategySavings,
    at100: { rothWithSavings: last.rothPlusBalance, roth: last.rothBalance, traditionalAfterTax: last.traditionalAfterTax },
    reinvestedAt100: { traditional: tradTaxable, roth: rothTaxable, rothWithSavings: rothPlusTaxable },
    rows, ledger: L,
  };
}
