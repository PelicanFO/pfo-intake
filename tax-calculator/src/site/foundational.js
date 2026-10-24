// Foundational strategies that come from the intake rather than the workbook: the Augusta Rule and
// hiring the client's children (Family Payroll). Each is measured on its own against no planning,
// using the same tax engine and rules as the rest of the tax page.
//
// Augusta Rule — IRC §280A(g): when a home is rented out for fewer than 15 days in a year, the rent
//   is excluded from the owner's income. The client's business rents the home for business meetings
//   at a fair rental rate and deducts the rent (§162). The business must be a separate taxpayer
//   (S corp, partnership, C corp); a sole proprietor or single-member LLC would be paying rent to
//   themselves, so it doesn't apply.
// Family Payroll — the business pays each child reasonable wages for real work, up to the 2026
//   single standard deduction ($16,100, IRC §63(c); a dependent's standard deduction is earned
//   income + $450, capped at that amount, §63(c)(5)), so the child owes no federal income tax and
//   the business deducts the wages. Payroll taxes:
//     · sole proprietorship / single-member LLC owned by a parent (and a partnership owned only by
//       the parents): no Social Security or Medicare for a child under 18 (§3121(b)(3)(A)) and no
//       FUTA under 21 (§3306(c)(5));
//     · S corp, C corp or other partnership: FICA (7.65% employee + 7.65% employer, §§3101, 3111)
//       and FUTA (0.6% of the first $7,000 after the state credit, §3301) apply at any age.
//   The child's state income tax on the wages is counted as a cost.
// Money paid to the client's own household (rent, wages) stays in the family, so it isn't a cost;
// savings = the household's lower tax, less payroll taxes and the child's own tax.

import { runScenario, SCENARIOS } from '../engine/scenarios.js';
import { cloneModel, defaultModel } from '../engine/model.js';
import { federalTables } from '../tables/federal.js';

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const NONE = SCENARIOS.find((s) => s.id === 'none');
const has = (v) => v !== undefined && v !== null && v !== '';

export const FOUNDATIONAL_PARAMS = {
  augustaMaxDays: 14,          // "fewer than 15 days" (§280A(g))
  augustaRateOfValue: 0.001,   // estimated daily rate: 0.1% of the home's value…
  augustaRateCap: 3000,        // …capped at $3,000 a day, rounded to $50
  corporateRate: 0.21,         // C corp (§11(b))
  ficaRate: 0.0765,            // each side: 6.2% Social Security + 1.45% Medicare
  futaRate: 0.006, futaBase: 7000,
  childMinAge: 7, childMaxAge: 24,
};
const P = FOUNDATIONAL_PARAMS;

/** How the business is organized, from the intake. */
export function entityOf(fd = {}) {
  const e = String(fd.business_entity || '').trim();
  if (e === 'Sole proprietorship' || e === 'LLC (single member)') return { kind: 'sole', label: e, known: true };
  if (e === 'C-Corp') return { kind: 'ccorp', label: 'C corp', known: true };
  if (e === 'Partnership' || e === 'LLC (multi-member)') return { kind: 'partnership', label: e === 'Partnership' ? 'partnership' : 'multi-member LLC', known: true };
  if (e === 'S-Corp') return { kind: 'scorp', label: 'S corp', known: true };
  return { kind: 'scorp', label: 'S corp', known: false }; // not entered / Other: treated as an S corp
}

/** Primary home value from the intake (financial statement row, or the simplified-view field). */
export function homeValue(fd = {}) {
  const sheet = Array.isArray(fd.nw_sheet) ? fd.nw_sheet : [];
  if (fd.nw_view !== 'simple') {
    const row = sheet.find((r) => r.g === 're' && /primary home/i.test(r.label || ''));
    if (row && num(row.value) > 0) return num(row.value);
  }
  return num(fd.nw_real_estate);
}

/** Ages of the client's children from the intake ("8, 14, 22"); null when only a count is given. */
export function childAges(fd = {}) {
  if (fd.children !== 'Yes' && !num(fd.children_count) && !String(fd.children_ages || '').trim()) return [];
  const ages = (String(fd.children_ages || '').match(/\d+(\.\d+)?/g) || []).map(Number);
  if (ages.length) return ages;
  return num(fd.children_count) > 0 ? null : [];
}

const taxOf = (model) => runScenario(model, 'base', NONE).rows.totalTax;

/** Household tax with business income lowered by `deduction` (pass-through entities). */
function householdTaxAfter(model, deduction) {
  const m = cloneModel(model);
  m.profile.businessIncome = (+m.profile.businessIncome || 0) - deduction;
  return taxOf(m);
}

/** The business profit the deduction comes out of (pass-through income, or a C corp's net profit). */
function businessProfit(fd, model, entity) {
  return entity.kind === 'ccorp' ? Math.max(num(fd.biz_net_profit), +model.profile.businessIncome || 0) : +model.profile.businessIncome || 0;
}

// ------------------------------------------------------------------ Augusta Rule
export function augustaRule(fd, model, saved = {}) {
  const entity = entityOf(fd);
  const value = homeValue(fd);
  const days = Math.max(0, Math.min(P.augustaMaxDays, has(saved.augustaDays) ? num(saved.augustaDays) : P.augustaMaxDays));
  const estRate = Math.min(P.augustaRateCap, Math.round(value * P.augustaRateOfValue / 50) * 50);
  const rate = has(saved.augustaRate) ? num(saved.augustaRate) : estRate;
  const base = { id: 'augusta', entity, homeValue: value, days, rate, rateEstimated: !has(saved.augustaRate), estRate };
  const profit = businessProfit(fd, model, entity);
  if (entity.kind === 'sole') return { ...base, applies: false, why: `A ${entity.label.toLowerCase()} would be paying rent to the owner, so there is no deduction. Needs an S corp, partnership or C corp.` };
  if (!(profit > 0)) return { ...base, applies: false, why: 'Needs business profit to pay the rent from; none in the intake.' };
  if (!(rate > 0)) return { ...base, applies: false, why: 'No primary home value in the intake. Enter a daily rental rate under Scenario options.' };
  if (!(days > 0)) return { ...base, applies: false, why: 'Rental days set to 0.' };
  const rent = Math.min(days * rate, profit);
  const before = taxOf(model);
  let after, savings;
  if (entity.kind === 'ccorp') {
    after = before;
    savings = rent * P.corporateRate;
  } else {
    after = householdTaxAfter(model, rent);
    savings = before - after;
  }
  return { ...base, applies: savings > 0.5, why: savings > 0.5 ? '' : 'No tax to offset.', rent, before, after, savings,
    lines: [
      ['Rent paid by the business', `${days} day${days === 1 ? '' : 's'} × $${Math.round(rate).toLocaleString('en-US')}${base.rateEstimated ? ' (estimated)' : ''}`, rent],
      entity.kind === 'ccorp'
        ? ['Corporate tax saved', `21% × rent (deducted by the C corp)`, savings]
        : ['Household tax', 'with business income lowered by the rent', after - before],
      ['Tax on the rent received', 'excluded: rented fewer than 15 days (§280A(g))', 0],
    ] };
}

// ------------------------------------------------------------------ Family Payroll (hiring your children)
export function familyPayroll(fd, model, saved = {}) {
  const entity = entityOf(fd);
  const T = federalTables(model.year);
  const stdSingle = T.standardDeduction.single;
  const ages = childAges(fd);
  const eligible = ages === null ? null : ages.filter((a) => a >= P.childMinAge && a <= P.childMaxAge);
  const intakeCount = eligible === null ? num(fd.children_count) : eligible.length;
  const count = Math.max(0, Math.round(has(saved.payrollKids) ? num(saved.payrollKids) : intakeCount));
  const wage = has(saved.payrollWage) ? num(saved.payrollWage) : stdSingle;
  // Ages of the children employed: the oldest eligible first; unknown ages count as under 18.
  const kidAges = (eligible || []).slice().sort((a, b) => b - a).slice(0, count);
  while (kidAges.length < count) kidAges.push(null);
  const base = { id: 'payroll', entity, count, wage, stdSingle, ages, eligibleCount: intakeCount, wageDefault: !has(saved.payrollWage) };
  const profit = businessProfit(fd, model, entity);
  if (!(profit > 0)) return { ...base, applies: false, why: 'Needs a business to pay the wages; no business income in the intake.' };
  if (!count) {
    const why = ages && ages.length ? `No children aged ${P.childMinAge}–${P.childMaxAge} in the intake.` : 'No children in the intake. Enter the number to employ under Scenario options.';
    return { ...base, applies: false, why: has(saved.payrollKids) ? 'Children employed set to 0.' : why };
  }
  if (!(wage > 0)) return { ...base, applies: false, why: 'Wage per child set to 0.' };

  // Payroll taxes per child.
  const exemptEntity = entity.kind === 'sole';
  const perChild = kidAges.map((age) => {
    const ficaExempt = exemptEntity && (age === null || age < 18);
    const futaExempt = exemptEntity && (age === null || age < 21);
    return {
      age,
      fica: ficaExempt ? 0 : wage * P.ficaRate,            // each side
      futa: futaExempt ? 0 : Math.min(wage, P.futaBase) * P.futaRate,
    };
  });
  const wages = wage * count;
  const employerTax = perChild.reduce((s, c) => s + c.fica + c.futa, 0);
  const employeeTax = perChild.reduce((s, c) => s + c.fica, 0);
  const deduction = Math.min(wages + employerTax, profit);

  // Each child's own income tax on the wages (single filer, no other income).
  const child = defaultModel();
  Object.assign(child.profile, { filingStatus: 'single', state: model.profile.state, stateCustom: model.profile.stateCustom || null,
    age: null, spouseAge: null, w2: wage, businessIncome: 0, stcg: 0, ltcg: 0, interest: 0, qualifiedDividends: 0, nonqualifiedDividends: 0, otherIncome: 0, planningFee: 0 });
  child.db.contribution = 0; child.roth.conversion = 0;
  child.rules = { ...model.rules };
  const childTax = taxOf(child) * count;

  const before = taxOf(model);
  let after, taxSaved;
  if (entity.kind === 'ccorp') {
    after = before;
    taxSaved = deduction * P.corporateRate;
  } else {
    after = householdTaxAfter(model, deduction);
    taxSaved = before - after;
  }
  const savings = taxSaved - employerTax - employeeTax - childTax;
  const ficaNote = exemptEntity
    ? (perChild.some((c) => c.fica) ? 'children 18+ pay Social Security and Medicare' : `no Social Security or Medicare for children under 18 in a ${entity.label.toLowerCase()} (§3121(b)(3)(A))`)
    : `7.65% employee + 7.65% employer (FICA applies at any age in ${entity.kind === 'scorp' ? 'an S corp' : entity.kind === 'ccorp' ? 'a C corp' : 'a ' + entity.label})`;
  return { ...base, applies: savings > 0.5, why: savings > 0.5 ? '' : 'Payroll taxes outweigh the tax saved.', wages, deduction, before, after, taxSaved, employerTax, employeeTax, childTax, savings, perChild,
    lines: [
      ['Wages paid to children', `${count} × $${Math.round(wage).toLocaleString('en-US')}${base.wageDefault ? ' (2026 standard deduction)' : ''}`, wages],
      entity.kind === 'ccorp'
        ? ['Corporate tax saved', `21% × wages and employer payroll tax`, taxSaved]
        : ['Household tax saved', 'business income lowered by wages and employer payroll tax', taxSaved],
      ['Payroll taxes', ficaNote, -(employerTax + employeeTax)],
      ['Children\'s income tax', wage <= stdSingle ? 'no federal tax up to the standard deduction; state tax as applicable' : 'wages above the standard deduction are taxed', -childTax],
    ] };
}
