// Tax-law corrections the engine applies on top of the spreadsheet's simplified model.
// Turning every rule off reproduces the spreadsheet's tax math; turning them all on is the
// corrected calculation. The reconciliation view applies them one at a time, in this order,
// so you can see what each one is worth.

export const CORRECTIONS = [
  {
    id: 'standardDeduction',
    label: 'Standard or itemized deduction',
    excel: 'Federal tax is calculated on gross income with no deduction.',
    law: 'Taxable income is AGI minus the larger of the standard deduction ($32,200 joint / $16,100 single / $24,150 head of household in 2026, plus $1,650–$2,050 per person 65+) or itemized deductions (SALT up to the $40,400 cap, charitable gifts), less the 2025–2028 senior deduction.',
    source: 'IRC §§63, 151(d)(5), 164(b)(7); Rev. Proc. 2025-32 §3.14',
  },
  {
    id: 'continuousBrackets',
    label: 'Continuous tax brackets',
    excel: 'Each bracket starts $1 above the previous one, so $1 per bracket is never taxed.',
    law: 'Each rate applies to income above the prior bracket\'s top, with no gap.',
    source: 'IRC §1(j); Rev. Proc. 2025-32 §3.01',
  },
  {
    id: 'capitalGainsStacking',
    label: 'Capital gains stacked on ordinary income',
    excel: 'The 0%/15%/20% brackets are applied to gains by themselves, so gains get the 0% rate even at high incomes. Capital losses beyond gains are ignored.',
    law: 'Long-term gains and qualified dividends sit on top of ordinary taxable income when choosing their 0/15/20% rate. Capital losses net against gains, then up to $3,000 against ordinary income; the rest carries forward.',
    source: 'IRC §1(h), §1211(b); Qualified Dividends and Capital Gain Tax Worksheet',
  },
  {
    id: 'niit',
    label: 'Net investment income tax',
    excel: 'NIIT = 3.8% × the greater of investment income or income over $250k, which taxes wages; it is then left out of the comparison totals.',
    law: 'NIIT = 3.8% × the lesser of net investment income or modified AGI over $250,000 joint / $200,000 otherwise, and it is part of the tax bill.',
    source: 'IRC §1411',
  },
  {
    id: 'medicareSurtax',
    label: 'Additional Medicare and self-employment tax',
    excel: 'Not included.',
    law: '0.9% Additional Medicare Tax on wages and self-employment income above $250,000 joint / $200,000 otherwise; 15.3% self-employment tax on Schedule C income (Social Security part up to the $184,500 wage base, less W-2 wages).',
    source: 'IRC §§1401, 3101(b)(2), 1402',
  },
  {
    id: 'qbi',
    label: 'Qualified business income deduction',
    excel: 'Not included.',
    law: '20% deduction for pass-through business income, phased in above $403,500 joint / $201,750 otherwise. Defaults to the conservative specified-service treatment unless the business is marked otherwise. Strategy losses that come from a trade or business reduce qualified business income.',
    source: 'IRC §199A; Rev. Proc. 2025-32 §3.26',
  },
  {
    id: 'charitableLimits',
    label: 'Charitable deduction limits',
    excel: 'The full donation reduces taxable income dollar for dollar.',
    law: 'Gifts of appreciated property are deductible up to 30% of AGI (cash 60%); only the part above 0.5% of AGI counts (2026+); the excess carries forward 5 years. Itemized deductions are trimmed by 2/37 for income in the 37% bracket.',
    source: 'IRC §170(b), §68 (as amended by OBBBA)',
  },
  {
    id: 'excessBusinessLoss',
    label: 'Excess business loss limit',
    excel: 'Strategy losses offset any amount of wage income.',
    law: 'Business losses can offset non-business income (like wages) only up to $512,000 joint / $256,000 otherwise in 2026; the excess becomes a net operating loss carryforward.',
    source: 'IRC §461(l); Rev. Proc. 2025-32 §3.31',
  },
  {
    id: 'amt',
    label: 'Alternative minimum tax',
    excel: 'Not included.',
    law: 'Tentative minimum tax at 26%/28% on income above the exemption ($140,200 joint / $90,100 otherwise, phased out at 50% above $1,000,000 / $500,000); the standard deduction and SALT are added back. Simplified: no ISO, depreciation or other preference items.',
    source: 'IRC §§55–56; Rev. Proc. 2025-32 §3.10',
  },
  {
    id: 'creditLimit',
    label: 'Business credit limit (Solar)',
    excel: 'The solar credit is treated as wiping out the full federal tax bill, and the solar target includes NIIT and state savings.',
    law: 'The energy credit cannot reduce tax below 25% of net regular tax over $25,000; unused credit carries back 1 year and forward 20. Credits cannot offset NIIT.',
    source: 'IRC §38(c)(1), (c)(4); §39',
  },
  {
    id: 'stateStandardDeduction',
    label: 'State standard deduction',
    excel: 'Louisiana tax is 3% of total income with no deduction.',
    law: 'Louisiana allows a standard deduction ($25,750 joint / $12,875 single for 2026).',
    source: 'La. R.S. 47:294; LDR RIB 26-005',
  },
  {
    id: 'clampNegative',
    label: 'No negative strategy amounts',
    excel: 'Some inputs can go negative (e.g. LEAP\'s "business income − $100,800" with no business income, or the Solar & Charitable donation below the 24% bracket), which raises taxes.',
    law: 'A strategy that does not apply is sized at $0 and flagged instead.',
    source: 'Spreadsheet fix',
  },
  {
    id: 'rmdStartAge',
    label: 'RMD start age',
    excel: 'Required distributions start at 73 for everyone.',
    law: '73 if born 1951–1959; 75 if born 1960 or later.',
    source: 'SECURE 2.0 Act §107; IRC §401(a)(9)(C)',
  },
  {
    id: 'rmdFirstYearTax',
    label: 'First-year IRA withdrawal tax',
    excel: 'The tax on the first year\'s IRA withdrawal is left out of the present value of future taxes.',
    law: 'Every withdrawal is taxed, including the first one.',
    source: 'Spreadsheet fix',
  },
];

export const ALL_ON = Object.fromEntries(CORRECTIONS.map((c) => [c.id, true]));
export const ALL_OFF = Object.fromEntries(CORRECTIONS.map((c) => [c.id, false]));
export const PRESETS = { corrected: ALL_ON, spreadsheet: ALL_OFF };

export function normalizeRules(rules) {
  return { ...ALL_ON, ...(rules || {}) };
}
