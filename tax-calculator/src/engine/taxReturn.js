// Computes one tax return (federal + state) for a "situation": the client's income plus whatever
// deductions, losses and credits the strategies in a scenario have added. Every step is written
// to a Ledger so the result can be audited line by line.
//
// Each tax-law correction in rules.js can be switched off; with all of them off this reproduces
// the spreadsheet's simplified math (no deduction, unstacked capital gains, $1 bracket gaps…).

import { Ledger, money, pct } from './ledger.js';
import { bracketTax, capitalGainsTax, describeRows } from './brackets.js';
import { federalTables } from '../tables/federal.js';
import { stateTables } from '../tables/states/index.js';
import { normalizeRules } from './rules.js';

const sum = (xs, f = (x) => x.amount) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const pos = (x) => Math.max(0, x);
const FS_LABEL = { mfj: 'married filing jointly', single: 'single', hoh: 'head of household', mfs: 'married filing separately' };

export function emptySituation() {
  return {
    year: 2026, filingStatus: 'mfj', state: 'LA',
    ages: { taxpayer: null, spouse: null },
    income: { w2: 0, business: 0, stcg: 0, ltcg: 0, interest: 0, qualifiedDividends: 0, nonqualifiedDividends: 0, otherOrdinary: 0 },
    otherOrdinaryItems: [],   // e.g. Roth conversion (included in income.otherOrdinary)
    businessIncomeAdjustments: [], // e.g. DB contribution (already reflected in income.business)
    businessLosses: [],       // ordinary trade/business losses from strategies: { id, label, amount, qbi }
    capitalLosses: [],        // long-term capital losses from strategies: { id, label, amount }
    charitable: [],           // { id, label, amount, limitPct }
    credits: [],              // general business credits: { id, label, amount }
    propertyTax: 0, otherItemized: 0,
    businessType: 'passthrough', // 'passthrough' (K-1, no SE tax) | 'scheduleC'
    qbiType: 'sstb',             // 'sstb' (conservative) | 'nonsstb' | 'none'
  };
}

/**
 * @returns {{ federal, state, totals, carryforwards, ledger }}
 *   totals: { fedOrdinary, fedLtcg, amt, niit, payroll, state, total }
 */
export function computeReturn(sit, rulesIn, { ledger = true } = {}) {
  const R = normalizeRules(rulesIn);
  const T = federalTables(sit.year);
  const S = stateTables(sit.state, sit.year, sit.stateCustom);
  const fs = sit.filingStatus;
  const L = ledger ? new Ledger('Tax return') : new NullLedger();
  const inc = sit.income;
  const legacyGaps = !R.continuousBrackets;

  // ---------------------------------------------------------------- income
  L.section('Income', `${sit.year} tax year, ${FS_LABEL[fs]}`);
  L.line('W-2 wages', inc.w2, { kind: 'input' });
  for (const a of sit.businessIncomeAdjustments) L.line(a.label, -a.amount, { calc: a.calc, kind: 'calc' });
  L.line('Business income', inc.business, { kind: 'input', calc: sit.businessIncomeAdjustments.length ? 'after the adjustments above' : undefined });
  if (inc.stcg) L.line('Short-term capital gains (taxed as ordinary income)', inc.stcg, { kind: 'input' });
  if (inc.interest) L.line('Interest', inc.interest, { kind: 'input' });
  if (inc.nonqualifiedDividends) L.line('Non-qualified dividends', inc.nonqualifiedDividends, { kind: 'input' });
  for (const o of sit.otherOrdinaryItems) L.line(o.label, o.amount, { kind: 'input', calc: o.calc });
  if (inc.ltcg) L.line('Long-term capital gains', inc.ltcg, { kind: 'input' });
  if (inc.qualifiedDividends) L.line('Qualified dividends', inc.qualifiedDividends, { kind: 'input' });

  // ---------------------------------------------------------------- self-employment tax (needed before AGI)
  let seTax = 0, halfSe = 0, netEarnings = 0;
  const preDbBusiness = inc.business + sum(sit.businessIncomeAdjustments);
  if (R.medicareSurtax && sit.businessType === 'scheduleC' && preDbBusiness > 0) {
    const se = T.selfEmployment;
    netEarnings = preDbBusiness * se.netEarningsFactor;
    const ssBase = Math.min(netEarnings, pos(se.wageBase - inc.w2));
    seTax = ssBase * se.ssRate + netEarnings * se.medicareRate;
    halfSe = seTax / 2;
    L.section('Self-employment tax', 'Schedule SE');
    L.line('Net earnings from self-employment', netEarnings, { calc: `${money(preDbBusiness)} × 92.35%`, source: 'IRC §1402(a)(12)' });
    L.line('Self-employment tax', seTax, { calc: `12.4% × ${money(ssBase)} (wage base ${money(se.wageBase)} less W-2 wages) + 2.9% × ${money(netEarnings)}`, source: 'IRC §1401' });
  }

  // ---------------------------------------------------------------- capital gains and losses
  const capLossTotal = sum(sit.capitalLosses);
  let netST = inc.stcg, netLT = inc.ltcg - capLossTotal, capLossDeduction = 0, capLossCarry = 0;
  if (capLossTotal) {
    L.section('Capital gains and losses');
    for (const c of sit.capitalLosses) L.line(c.label, -c.amount, { calc: c.calc, source: c.source });
  }
  if (R.capitalGainsStacking) {
    if (netLT < 0) {
      const combined = netST + netLT;
      if (combined < 0) {
        capLossDeduction = Math.min(T.capitalLossLimit, -combined);
        capLossCarry = -combined - capLossDeduction;
        netST = 0;
      } else netST = combined;
      netLT = 0;
    }
    if (capLossTotal) {
      L.line('Net long-term capital gain', netLT, { calc: 'long-term gains less long-term losses' });
      if (capLossDeduction) L.line('Capital loss deducted against ordinary income', -capLossDeduction, { calc: `limited to ${money(T.capitalLossLimit)}`, source: 'IRC §1211(b)' });
      if (capLossCarry) L.line('Capital loss carried forward', capLossCarry, { kind: 'info', source: 'IRC §1212(b)' });
    }
  } else if (capLossTotal) {
    L.line('Long-term gains after losses (spreadsheet: losses beyond gains are ignored)', netLT, { calc: `${money(inc.ltcg)} − ${money(capLossTotal)}` });
  }

  // ---------------------------------------------------------------- business losses (excess business loss limit)
  const lossTotal = sum(sit.businessLosses);
  let allowedLoss = lossTotal, eblDisallowed = 0;
  if (lossTotal) {
    L.section('Strategy losses');
    for (const b of sit.businessLosses) L.line(b.label, -b.amount, { calc: b.calc, source: b.source });
    if (R.excessBusinessLoss) {
      const threshold = T.excessBusinessLoss[fs];
      const bizDeductions = lossTotal + pos(-inc.business);
      const bizIncome = pos(inc.business);
      const ebl = pos(bizDeductions - bizIncome - threshold);
      eblDisallowed = Math.min(lossTotal, ebl);
      allowedLoss = lossTotal - eblDisallowed;
      L.line('Excess business loss limit', threshold, { kind: 'info', calc: `business losses may offset business income (${money(bizIncome)}) plus ${money(threshold)} of other income`, source: 'IRC §461(l); Rev. Proc. 2025-32 §3.31' });
      if (eblDisallowed) {
        L.line('Loss disallowed this year (becomes a net operating loss carryforward)', eblDisallowed, { kind: 'warn', calc: `${money(bizDeductions)} − ${money(bizIncome)} − ${money(threshold)}` });
      }
      L.line('Strategy losses allowed this year', -allowedLoss, { kind: 'total' });
    }
  }

  // ---------------------------------------------------------------- AGI, split into ordinary and preferential parts
  const ordinaryIncome = inc.w2 + inc.business + netST + inc.interest + inc.nonqualifiedDividends + inc.otherOrdinary;
  const prefIncome = netLT + inc.qualifiedDividends; // may be negative only in spreadsheet mode
  const ordinaryAgi = ordinaryIncome - allowedLoss - capLossDeduction - halfSe;
  const agi = ordinaryAgi + (R.capitalGainsStacking ? pos(prefIncome) : prefIncome);
  L.section('Adjusted gross income');
  L.line('Ordinary income', ordinaryIncome, { calc: 'wages + business + short-term gains + interest + non-qualified dividends + other' });
  if (allowedLoss) L.line('Less strategy losses', -allowedLoss);
  if (capLossDeduction) L.line('Less capital loss deduction', -capLossDeduction);
  if (halfSe) L.line('Less deductible half of self-employment tax', -halfSe, { source: 'IRC §164(f)' });
  L.line('Long-term gains + qualified dividends', prefIncome);
  L.line('Adjusted gross income (AGI)', agi, { kind: 'total', source: 'IRC §62' });

  // ---------------------------------------------------------------- state tax (Louisiana starts from federal AGI)
  const state = computeState(sit, agi, R, S, L);

  // ---------------------------------------------------------------- deductions
  L.section('Deductions');
  const people = fs === 'mfj' ? [sit.ages.taxpayer, sit.ages.spouse ?? sit.ages.taxpayer] : [sit.ages.taxpayer];
  const seniors = people.filter((a) => a !== null && a !== undefined && a >= 65).length;

  // Charitable gifts
  const gifts = sum(sit.charitable);
  let charitableAllowed = gifts, charitableCarry = 0;
  if (gifts) {
    for (const c of sit.charitable) L.line(c.label, c.amount, { calc: c.calc });
    if (R.charitableLimits) {
      let room60 = T.charitable.cashLimitPct * pos(agi), allowed = 0;
      for (const c of sit.charitable) {
        const lim = Math.min((c.limitPct ?? T.charitable.propertyLimitPct) * pos(agi), room60);
        const a = Math.min(c.amount, lim);
        allowed += a; room60 -= a;
        if (c.amount > a) L.line(`Limited to ${pct(c.limitPct ?? T.charitable.propertyLimitPct, 0)} of AGI`, a, { calc: `${pct(c.limitPct ?? 0.3, 0)} × ${money(agi)}`, source: 'IRC §170(b)(1)' });
      }
      charitableCarry = gifts - allowed;
      const floor = T.charitable.agiFloorPct * pos(agi);
      charitableAllowed = pos(allowed - floor);
      L.line('Less 0.5%-of-AGI floor', -Math.min(allowed, floor), { calc: `0.5% × ${money(agi)}`, source: 'IRC §170(b)(1)(I) (2026+)' });
      if (charitableCarry) L.line('Charitable carryforward (usable over the next 5 years)', charitableCarry, { kind: 'info', source: 'IRC §170(d)' });
    }
    L.line('Charitable deduction', charitableAllowed, { kind: 'calc' });
  }

  let deduction, deductionLabel, saltAllowed = 0, itemized = charitableAllowed, usedStandard = false;
  let seniorDeduction = 0, standard = 0, limitReduction = 0;
  if (R.standardDeduction) {
    const married = fs === 'mfj' || fs === 'mfs';
    standard = T.standardDeduction[fs] + seniors * (married ? T.agedDeduction.married : T.agedDeduction.unmarried);
    L.line('Standard deduction', standard, {
      calc: `${money(T.standardDeduction[fs])}${seniors ? ` + ${seniors} × ${money(married ? T.agedDeduction.married : T.agedDeduction.unmarried)} (age 65+)` : ''}`,
      source: 'IRC §63(c), (f); Rev. Proc. 2025-32 §3.14',
    });
    const saltPaid = state.tax + (sit.propertyTax || 0);
    const cap = Math.max(T.salt.floor[fs], T.salt.cap[fs] - T.salt.rate * pos(agi - T.salt.threshold[fs]));
    saltAllowed = Math.min(saltPaid, cap);
    itemized = charitableAllowed + saltAllowed + (sit.otherItemized || 0);
    L.line('Itemized: state & local taxes', saltAllowed, { calc: `lesser of ${money(saltPaid)} paid (state income tax${sit.propertyTax ? ' + property tax' : ''}) or the ${money(cap)} cap`, source: 'IRC §164(b)(7)' });
    if (sit.otherItemized) L.line('Itemized: other', sit.otherItemized, { kind: 'input' });
    if (R.charitableLimits && itemized > 0) {
      const top37 = T.ordinaryBrackets[fs][T.ordinaryBrackets[fs].length - 1][0];
      limitReduction = T.itemizedLimitFraction * Math.min(itemized, pos(agi - top37));
      if (limitReduction > 0.5) L.line('Itemized deduction limit for the 37% bracket', -limitReduction, { calc: `2/37 × lesser of ${money(itemized)} or ${money(pos(agi - top37))} of income above ${money(top37)}`, source: 'IRC §68 (OBBBA)' });
      itemized -= limitReduction;
    }
    L.line('Total itemized deductions', itemized);
    usedStandard = standard >= itemized;
    deduction = Math.max(standard, itemized);
    deductionLabel = usedStandard ? 'Deduction taken: standard' : 'Deduction taken: itemized';
    if (seniors && T.seniorDeduction.threshold[fs] !== null) {
      const sd = T.seniorDeduction;
      seniorDeduction = pos(seniors * sd.perPerson - sd.rate * pos(agi - sd.threshold[fs]));
      L.line('Senior deduction (age 65+, 2025–2028)', seniorDeduction, { calc: `${seniors} × ${money(sd.perPerson)} less 6% × (${money(agi)} − ${money(sd.threshold[fs])})`, source: 'IRC §151(d)(5)(C) (OBBBA §70103)' });
    }
  } else {
    deduction = charitableAllowed;
    deductionLabel = gifts ? 'Deduction taken (spreadsheet method: charitable gift only)' : 'No deduction (spreadsheet method)';
  }
  L.line(deductionLabel, deduction, { kind: 'total' });

  // ---------------------------------------------------------------- QBI deduction
  let qbiDeduction = 0;
  const preQbiDeductions = deduction + seniorDeduction;
  if (R.qbi && sit.qbiType !== 'none') {
    const strategyQbiLoss = sum(sit.businessLosses.filter((b) => b.qbi)) * (lossTotal ? allowedLoss / lossTotal : 0);
    const qbi = inc.business - halfSe - strategyQbiLoss;
    const tiBefore = pos(agi - preQbiDeductions);
    const Q = T.qbi;
    if (inc.business > 0 || strategyQbiLoss > 0) {
      L.section('Qualified business income deduction', 'IRC §199A');
      L.line('Qualified business income', qbi, { calc: `business income${halfSe ? ' − ½ SE tax' : ''}${strategyQbiLoss ? ` − ${money(strategyQbiLoss)} strategy business losses` : ''}` });
      if (qbi > 0) {
        let applicable = 1;
        const thr = Q.threshold[fs], range = Q.phaseInRange[fs];
        if (tiBefore > thr) {
          if (sit.qbiType === 'sstb') applicable = pos(1 - (tiBefore - thr) / range);
        }
        let d = Q.rate * qbi * applicable;
        const cap = Q.rate * pos(tiBefore - pos(prefIncome));
        d = Math.min(d, cap);
        if (qbi >= Q.minimumQbi) d = Math.max(d, Math.min(Q.minimumDeduction, tiBefore));
        qbiDeduction = d;
        L.line('Taxable income before QBI deduction', tiBefore, { kind: 'info' });
        if (applicable < 1) L.line('Specified-service phase-out applied', applicable, { kind: 'info', calc: `1 − (${money(tiBefore)} − ${money(thr)}) ÷ ${money(range)} = ${pct(applicable)} of the deduction remains`, source: 'IRC §199A(d)(3); default assumption: specified service business' });
        if (sit.qbiType === 'nonsstb' && tiBefore > thr) L.note('Assumes W-2 wage / property limits do not bind (non-specified-service business).', 'warn');
        L.line('QBI deduction', qbiDeduction, { kind: 'total', calc: `20% × ${money(qbi)}${applicable < 1 ? ` × ${pct(applicable)}` : ''}, capped at 20% of taxable income less net capital gain` });
      } else L.note('No QBI deduction: qualified business income is not positive (a loss carries forward).');
    }
  }

  // ---------------------------------------------------------------- taxable income and regular tax
  const D = deduction + seniorDeduction + qbiDeduction;
  const ordTI = pos(ordinaryAgi - D);
  const prefTI = pos(prefIncome - pos(D - ordinaryAgi));
  const taxableIncome = ordTI + prefTI;
  L.section('Taxable income');
  L.line('AGI', agi);
  L.line('Less deductions', -D, { calc: [deduction && 'standard/itemized', seniorDeduction && 'senior', qbiDeduction && 'QBI'].filter(Boolean).join(' + ') || 'none' });
  L.line('Taxable income', taxableIncome, { kind: 'total', source: 'IRC §63' });
  L.line('  of which ordinary', ordTI);
  L.line('  of which long-term gains & qualified dividends', prefTI);

  const brackets = T.ordinaryBrackets[fs];
  const ord = bracketTax(ordTI, brackets, { legacyGaps });
  const cg = capitalGainsTax(prefTI, ordTI, T.capitalGains[fs], { stacked: R.capitalGainsStacking, legacyGaps });
  L.section('Federal income tax', `${sit.year} ${FS_LABEL[fs]} rates (Rev. Proc. 2025-32)`);
  for (const r of ord.rows) L.line(`${pct(r.rate, 0)} on ${money(r.from)} – ${money(r.to)}`, r.tax, { calc: `${pct(r.rate, 0)} × ${money(r.amount)}` });
  L.line('Tax on ordinary income', ord.tax, { kind: 'calc', calc: describeRows(ord.rows), source: legacyGaps ? 'Spreadsheet brackets ($1 gaps)' : 'IRC §1(j)' });
  for (const r of cg.rows) L.line(`${pct(r.rate, 0)} on gains ${R.capitalGainsStacking ? `stacked at ${money(r.from)} – ${money(r.to)}` : `${money(r.from)} – ${money(r.to)}`}`, r.tax, { calc: `${pct(r.rate, 0)} × ${money(r.amount)}` });
  if (prefTI) L.line('Tax on long-term gains & qualified dividends', cg.tax, { kind: 'calc', source: R.capitalGainsStacking ? 'IRC §1(h); Capital Gain Tax Worksheet' : 'Spreadsheet: gains taxed on their own' });
  const regularTax = ord.tax + cg.tax;
  L.line('Regular income tax', regularTax, { kind: 'total' });

  // ---------------------------------------------------------------- AMT
  let amt = 0;
  if (R.amt) {
    const A = T.amt;
    const addBack = (usedStandard ? deduction : saltAllowed) + seniorDeduction;
    const amti = taxableIncome + (R.standardDeduction ? addBack : 0);
    const exemption = pos(A.exemption[fs] - A.phaseoutRate * pos(amti - A.phaseoutStart[fs]));
    const base = pos(amti - exemption);
    const amtPref = Math.min(pos(prefIncome), base); // Form 6251 Part III: net capital gain + qualified dividends, limited to the AMT base
    const amtOrd = base - amtPref;
    const t28 = A.rate28Threshold[fs];
    const tmtOrd = 0.26 * Math.min(amtOrd, t28) + 0.28 * pos(amtOrd - t28);
    const tmtCg = capitalGainsTax(amtPref, amtOrd, T.capitalGains[fs], { stacked: true }).tax;
    const tmt = tmtOrd + tmtCg;
    amt = pos(tmt - regularTax);
    L.section('Alternative minimum tax', 'Simplified Form 6251');
    L.line('Alternative minimum taxable income', amti, { calc: `taxable income + ${money(R.standardDeduction ? addBack : 0)} (${usedStandard ? 'standard' : 'SALT'}${seniorDeduction ? ' + senior' : ''} deduction not allowed)` });
    L.line('Exemption', exemption, { calc: `${money(A.exemption[fs])} less 50% of AMTI over ${money(A.phaseoutStart[fs])}`, source: 'IRC §55(d); Rev. Proc. 2025-32 §3.10' });
    L.line('Tentative minimum tax', tmt, { calc: `26%/28% on ${money(amtOrd)} + capital-gain rates on ${money(amtPref)}` });
    L.line('AMT (excess over regular tax)', amt, { kind: 'total' });
  }

  // ---------------------------------------------------------------- credits
  const creditTotal = sum(sit.credits);
  let creditAllowed = 0, creditCarry = 0;
  if (creditTotal) {
    L.section('Credits');
    for (const c of sit.credits) L.line(c.label, c.amount, { calc: c.calc, source: c.source });
    const netIncomeTax = regularTax + amt;
    let limit = netIncomeTax;
    if (R.creditLimit) {
      const gbc = T.generalBusinessCredit;
      const floorTax = gbc.pct * pos(regularTax - gbc.floor);
      limit = pos(netIncomeTax - floorTax);
      L.line('Credit limit', limit, { calc: `${money(netIncomeTax)} income tax − 25% × (${money(regularTax)} − ${money(gbc.floor)})`, source: 'IRC §38(c)(1), (c)(4)(B)' });
    }
    creditAllowed = Math.min(creditTotal, limit);
    creditCarry = creditTotal - creditAllowed;
    L.line('Credit used this year', -creditAllowed, { kind: 'total' });
    if (creditCarry > 0.5) L.line('Unused credit (carry back 1 year / forward 20 years)', creditCarry, { kind: 'warn', source: 'IRC §39' });
  }
  // Credits reduce ordinary tax first, then the capital-gains tax, then AMT (matches the spreadsheet's allocation).
  let left = creditAllowed;
  const take = (x) => { const t = Math.min(x, left); left -= t; return x - t; };
  const fedOrdinary = take(ord.tax), fedLtcg = take(cg.tax), amtNet = take(amt);

  // ---------------------------------------------------------------- NIIT and Medicare
  let niit = 0;
  const nii = inc.interest + inc.qualifiedDividends + inc.nonqualifiedDividends + pos(netST + netLT);
  if (R.niit) {
    const thr = T.niit.threshold[fs];
    niit = T.niit.rate * Math.min(nii, pos(agi - thr));
    L.section('Net investment income tax', 'IRC §1411');
    L.line('Net investment income', nii, { calc: 'interest + dividends + net capital gains' });
    L.line('Modified AGI over threshold', pos(agi - thr), { calc: `${money(agi)} − ${money(thr)}` });
    L.line('NIIT', niit, { kind: 'total', calc: `3.8% × lesser of the two` });
  }
  let addlMedicare = 0;
  if (R.medicareSurtax) {
    const thr = T.additionalMedicare.threshold[fs];
    addlMedicare = T.additionalMedicare.rate * (pos(inc.w2 - thr) + pos(netEarnings - pos(thr - inc.w2)));
    if (addlMedicare || seTax) {
      L.section('Payroll taxes on the return');
      if (addlMedicare) L.line('Additional Medicare Tax', addlMedicare, { calc: `0.9% × wages${netEarnings ? ' and SE earnings' : ''} over ${money(thr)}`, source: 'IRC §3101(b)(2), §1401(b)(2); Form 8959' });
      if (seTax) L.line('Self-employment tax', seTax);
      L.note('Not changed by the strategies; included so the total bill is complete.');
    }
  }

  const fedTotal = fedOrdinary + fedLtcg + amtNet + niit + addlMedicare + seTax;
  const totals = {
    fedOrdinary, fedLtcg, amt: amtNet, niit, payroll: addlMedicare + seTax, state: state.tax,
    federal: fedTotal, total: fedTotal + state.tax,
  };
  L.section('Total tax');
  L.line('Federal income tax (ordinary rates, after credits)', fedOrdinary);
  L.line('Federal tax on long-term gains & qualified dividends', fedLtcg);
  if (R.amt) L.line('AMT', amtNet);
  if (R.niit) L.line('Net investment income tax', niit);
  if (R.medicareSurtax) L.line('Additional Medicare / self-employment tax', addlMedicare + seTax);
  L.line(`${S.name} income tax`, state.tax);
  L.line('Total tax', totals.total, { kind: 'total' });

  return {
    agi, ordinaryAgi, prefIncome, taxableIncome, ordTI, prefTI, deduction, usedStandard, seniorDeduction, qbiDeduction,
    regularTax, ordinaryTax: ord.tax, capitalGainsTax: cg.tax, amt, creditAllowed, niit, nii,
    state, totals,
    carryforwards: { credit: creditCarry, nol: eblDisallowed, charitable: charitableCarry, capitalLoss: capLossCarry },
    ledger: ledger ? L : null,
  };
}

function computeState(sit, fedAgi, R, S, L) {
  const fs = sit.filingStatus;
  L.section(`${S.name} income tax`, S.sources.join('; '));
  const stateAgi = fedAgi;
  L.line('Starting point: federal AGI', stateAgi);
  const std = R.stateStandardDeduction ? S.standardDeduction[fs] : 0;
  if (R.stateStandardDeduction && std) L.line(`${S.name} standard deduction`, -std, { source: S.sources[1] });
  if (!S.allowsItemized && sit.charitable.length) L.note(`${S.name} does not allow federal itemized deductions, so charitable gifts do not reduce state tax.`);
  const taxable = pos(stateAgi - std);
  const t = bracketTax(taxable, S.brackets[fs], { legacyGaps: !R.continuousBrackets });
  L.line(`${S.name} taxable income`, taxable);
  L.line(`${S.name} tax`, t.tax, { kind: 'total', calc: describeRows(t.rows) });
  return { agi: stateAgi, deduction: std, taxable, tax: t.tax };
}

class NullLedger {
  section() { return this; }
  line(label, amount) { return amount; }
  note() {}
}
