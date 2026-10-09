// State income tax parameters. Each state is data, so adding one is usually just a new entry here.
//
// Fields:
//   name, years[year]: { brackets: {mfj, single, hoh}: [[threshold, rate], ...],
//                        standardDeduction: {mfj, single, hoh}, sources: [...] }
//   startingPoint: 'federalAGI' (most states) — state taxable income starts from federal AGI.
//   allowsItemized: whether federal itemized deductions (e.g. charitable) reduce state tax.
//   notes: anything the calculator does not model for this state.

export const STATES = {
  LA: {
    name: 'Louisiana',
    startingPoint: 'federalAGI',
    allowsItemized: false,
    notes: [
      'Flat 3% rate and standard deduction from Act 11 (2024 3rd Ex. Sess., HB 10), effective 2025.',
      'Not modeled: the age-65 retirement income exclusion ($12,000 per person, indexed) and other Louisiana-specific exclusions.',
    ],
    years: {
      2026: {
        brackets: { mfj: [[0, 0.03]], single: [[0, 0.03]], hoh: [[0, 0.03]], mfs: [[0, 0.03]] },
        // LDR emergency rule / RIB 26-005 (Jan 2026): $12,875 single & separate, $25,750 joint & head of household.
        // LDR notes the final 2026 amounts may differ slightly once 2025 CPI-U is published.
        standardDeduction: { mfj: 25750, single: 12875, hoh: 25750, mfs: 12875 },
        sources: ['La. R.S. 47:32 (flat 3%)', 'La. R.S. 47:294 (standard deduction, CPI-indexed)', 'LDR RIB 26-005'],
      },
    },
  },
  TX: {
    name: 'Texas',
    startingPoint: 'federalAGI',
    allowsItemized: false,
    notes: ['Texas has no personal income tax.'],
    years: { 2026: { brackets: { mfj: [[0, 0]], single: [[0, 0]], hoh: [[0, 0]], mfs: [[0, 0]] }, standardDeduction: { mfj: 0, single: 0, hoh: 0, mfs: 0 }, sources: ['Tex. Const. art. 8, §24-a'] } },
  },
  // Any other state: the user enters an approximate flat rate (see stateTables' `custom` argument).
  CUSTOM: {
    name: 'State income tax',
    startingPoint: 'federalAGI',
    allowsItemized: false,
    custom: true,
    notes: ['Approximated with a flat rate on federal AGI entered by the user.'],
    years: { 2026: { brackets: null, standardDeduction: { mfj: 0, single: 0, hoh: 0, mfs: 0 }, sources: ['Flat rate entered by the user'] } },
  },
  NONE: {
    name: 'No state income tax',
    startingPoint: 'federalAGI',
    allowsItemized: false,
    notes: ['For clients in states without a wage income tax. Check local rules for other taxes (e.g. WA capital gains).'],
    years: { 2026: { brackets: { mfj: [[0, 0]], single: [[0, 0]], hoh: [[0, 0]], mfs: [[0, 0]] }, standardDeduction: { mfj: 0, single: 0, hoh: 0, mfs: 0 }, sources: [] } },
  },
};

// States without a tax on wage income. Washington is left out on purpose: it taxes large
// long-term capital gains, so it goes through the "other state" rate prompt.
const NO_WAGE_TAX = ['Alaska', 'Florida', 'Nevada', 'New Hampshire', 'South Dakota', 'Tennessee', 'Wyoming'];

/** Map a state name (as entered in the intake) to a table code: LA, TX, NONE, or CUSTOM. */
export function stateCodeFor(name) {
  const n = String(name || '').trim();
  if (n === 'Louisiana') return 'LA';
  if (n === 'Texas') return 'TX';
  if (NO_WAGE_TAX.includes(n)) return 'NONE';
  return 'CUSTOM';
}

/** @param custom for CUSTOM: { rate, name } — a flat rate on federal AGI. */
export function stateTables(code, year, custom) {
  const s = STATES[code];
  if (!s) throw new Error(`No tax tables for state ${code}`);
  const y = s.years[year];
  if (!y) throw new Error(`No ${s.name} tax tables for ${year}`);
  const out = { code, ...s, ...y };
  if (s.custom) {
    const rate = Math.max(0, +(custom && custom.rate) || 0);
    out.brackets = { mfj: [[0, rate]], single: [[0, rate]], hoh: [[0, rate]], mfs: [[0, rate]] };
    if (custom && custom.name) out.name = custom.name;
  } else if (code === 'NONE' && custom && custom.name) out.name = custom.name;
  return out;
}
