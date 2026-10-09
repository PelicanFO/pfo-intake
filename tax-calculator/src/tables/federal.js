// Federal tax parameters by tax year. To add a year: copy the latest block, update every number
// from that year's IRS Revenue Procedure, and add a test case in tests/tax-law.test.js.
//
// Brackets are [threshold, rate] pairs: the rate applies to taxable income above the threshold.

export const FEDERAL = {
  2026: {
    year: 2026,
    sources: [
      'Rev. Proc. 2025-32 (2026 inflation adjustments)',
      'IRC as amended by P.L. 119-21 ("One Big Beautiful Bill Act", OBBBA)',
    ],
    ordinaryBrackets: {
      mfj: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24], [403550, 0.32], [512450, 0.35], [768700, 0.37]],
      single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
      hoh: [[0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24], [201750, 0.32], [256200, 0.35], [640600, 0.37]],
    },
    // Top of the 0% and 15% capital-gain rate brackets (Rev. Proc. 2025-32 §3.03).
    capitalGains: {
      mfj: { zeroMax: 98900, fifteenMax: 613700 },
      single: { zeroMax: 49450, fifteenMax: 545500 },
      hoh: { zeroMax: 66200, fifteenMax: 579600 },
    },
    standardDeduction: { mfj: 32200, single: 16100, hoh: 24150 },
    // Additional standard deduction per person 65 or older (§63(f)).
    agedDeduction: { married: 1650, unmarried: 2050 },
    // OBBBA §70103 deduction for seniors (2025–2028): $6,000 per person 65+, reduced by 6% of
    // MAGI over the threshold. Available whether or not the taxpayer itemizes.
    seniorDeduction: { perPerson: 6000, threshold: { mfj: 150000, single: 75000, hoh: 75000 }, rate: 0.06 },
    // State and local tax deduction cap (§164(b)(7) as amended by OBBBA): $40,400 for 2026,
    // reduced by 30% of MAGI over $505,000, but not below $10,000.
    salt: { cap: 40400, threshold: 505000, rate: 0.30, floor: 10000 },
    charitable: {
      agiFloorPct: 0.005,         // §170(b)(1)(I): only donations above 0.5% of AGI are deductible (2026+)
      cashLimitPct: 0.60,         // §170(b)(1)(G): cash to public charities
      propertyLimitPct: 0.30,     // §170(b)(1)(C): appreciated capital-gain property
      carryforwardYears: 5,
    },
    // §68 as amended by OBBBA: itemized deductions reduced by 2/37 of the lesser of itemized deductions
    // or taxable income (plus itemized deductions) above the start of the 37% bracket.
    itemizedLimitFraction: 2 / 37,
    niit: { rate: 0.038, threshold: { mfj: 250000, single: 200000, hoh: 200000 } },
    additionalMedicare: { rate: 0.009, threshold: { mfj: 250000, single: 200000, hoh: 200000 } },
    selfEmployment: { wageBase: 184500, ssRate: 0.124, medicareRate: 0.029, netEarningsFactor: 0.9235 },
    amt: {
      exemption: { mfj: 140200, single: 90100, hoh: 90100 },
      phaseoutStart: { mfj: 1000000, single: 500000, hoh: 500000 },
      phaseoutRate: 0.50,          // OBBBA: 50% for 2026 onward
      rate28Threshold: 244500,     // excess AMTI taxed at 28% above this
    },
    qbi: {
      rate: 0.20,
      threshold: { mfj: 403500, single: 201750, hoh: 201750 },
      phaseInRange: { mfj: 150000, single: 75000, hoh: 75000 },
      minimumDeduction: 400, minimumQbi: 1000,   // OBBBA §70105, 2026+
    },
    excessBusinessLoss: { mfj: 512000, single: 256000, hoh: 256000 },   // Rev. Proc. 2025-32 §3.31
    capitalLossLimit: 3000,
    // General business credit limitation (§38(c)(1)): credits can't reduce tax below 25% of
    // net regular tax over $25,000. The energy credit is a "specified credit", so the tentative
    // minimum tax prong is treated as zero (§38(c)(4)).
    generalBusinessCredit: { floor: 25000, pct: 0.25 },
  },
};

// IRS Uniform Lifetime Table (Treas. Reg. §1.401(a)(9)-9(c), effective 2022).
export const UNIFORM_LIFETIME = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
  81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
  90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
  100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6,
};

/** Required beginning age under SECURE 2.0 §107: 73 if born 1951–1959, 75 if born 1960 or later. */
export function rmdStartAge(birthYear) {
  if (birthYear <= 1949) return 70.5;
  if (birthYear <= 1950) return 72;
  if (birthYear <= 1959) return 73;
  return 75;
}

export function federalTables(year) {
  const t = FEDERAL[year];
  if (!t) throw new Error(`No federal tax tables for ${year}. Available: ${Object.keys(FEDERAL).join(', ')}`);
  return t;
}
