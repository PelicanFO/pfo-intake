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
        brackets: { mfj: [[0, 0.03]], single: [[0, 0.03]], hoh: [[0, 0.03]] },
        // LDR emergency rule / RIB 26-005 (Jan 2026): $12,875 single, $25,750 joint & head of household.
        // LDR notes the final 2026 amounts may differ slightly once 2025 CPI-U is published.
        standardDeduction: { mfj: 25750, single: 12875, hoh: 25750 },
        sources: ['La. R.S. 47:32 (flat 3%)', 'La. R.S. 47:294 (standard deduction, CPI-indexed)', 'LDR RIB 26-005'],
      },
    },
  },
  NONE: {
    name: 'No state income tax',
    startingPoint: 'federalAGI',
    allowsItemized: false,
    notes: ['For clients in states without a wage income tax. Check local rules for other taxes (e.g. WA capital gains).'],
    years: { 2026: { brackets: { mfj: [[0, 0]], single: [[0, 0]], hoh: [[0, 0]] }, standardDeduction: { mfj: 0, single: 0, hoh: 0 }, sources: [] } },
  },
};

export function stateTables(code, year) {
  const s = STATES[code];
  if (!s) throw new Error(`No tax tables for state ${code}`);
  const y = s.years[year];
  if (!y) throw new Error(`No ${s.name} tax tables for ${year}`);
  return { code, ...s, ...y };
}
