// The full set of inputs the calculator works from (the yellow cells of the workbook, plus a few
// optional fields the corrected tax math can use). defaultModel() is the workbook's sample client.
import { defaultParams } from '../strategies/index.js';
import { ALL_ON } from './rules.js';

export function defaultModel() {
  return {
    year: 2026,
    profile: {
      filingStatus: 'mfj',          // 'mfj' | 'single' | 'hoh'
      state: 'LA',
      w2: 400000,
      businessIncome: 0,
      stcg: 0,
      ltcg: 0,
      interest: 0,
      qualifiedDividends: 0,
      nonqualifiedDividends: 0,
      planningFee: 0,               // "Consulting Fee" (Strategy comparison!C12)
      age: 65,                      // Roth comparison!C3 (also used for 65+ deductions and RMD age)
      spouseAge: null,              // blank = same as client
      // Optional — only used by the corrected tax math; defaults avoid asking the client.
      propertyTax: 0,
      otherItemized: 0,
      businessType: 'passthrough',  // 'passthrough' (K-1, no SE tax) | 'scheduleC'
      qbiType: 'sstb',              // 'sstb' (conservative) | 'nonsstb' | 'none'
    },
    db: { contribution: 0 },
    roth: {
      conversion: 450000,
      retirementAge: 65,
      minWithdrawalRate: 0.04,
      projectedTaxRate: 0.35,       // blank → use this year's effective rate on the conversion
      discountRate: 0.07,           // also the growth rate, as in the workbook
      strategyOverride: null,       // blank → the strategy with the largest conversion-year savings
    },
    params: defaultParams(),
    // Manual sizing per block → scenario → strategy → field. A number is a manual amount,
    // { fillToBracket: 0.12 } brings taxable income down to the top of that bracket, and a missing
    // entry uses the strategy's default rule. The workbook's Film input is "income − $100,800",
    // i.e. fill the 12% bracket.
    sizing: {
      base: { film: { film: { offset: { fillToBracket: 0.12 } } } },
      db: {},
      roth: {},
    },
    rules: { ...ALL_ON },
  };
}

export function cloneModel(m) { return JSON.parse(JSON.stringify(m)); }
