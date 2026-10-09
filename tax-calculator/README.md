# PFO Tax Strategy Calculator

A code version of the **PFO Tax Strategy Calculator** Excel workbook. It is kept separate from the
main site (`/index.html`) until we decide to integrate it.

It does two things:

1. **Excel replica.** It recalculates the workbook's own 7,303 formulas for any inputs, including
   Excel's iterative Solar sizing loop. This proves we reproduce the spreadsheet, and you can click any
   number to see the formula chain behind it.
2. **Corrected engine.** It runs the same strategies through a 2026 tax calculation that fixes the
   workbook's departures from tax law. Every number comes with a line-by-line audit trail, and each
   fix can be switched off to see what it is worth. See [docs/TAX-LAW-REVIEW.md](docs/TAX-LAW-REVIEW.md).

## On the intake site (beta)

The main site (`/index.html`) uses this engine for its **Tax strategies** step, between the intake
and Priorities. The code is in `src/site/` (`tax-step.js`, `tax-step.css`).

- **Inputs come from the intake.** That covers filing status, state, ages, every prior-year income
  line, and retirement age. Optional inputs on the page (DB contribution, Roth conversion, planning
  fee, strategy assumptions) are saved with the client under `form_data.__tax`.
- **Calculation method:** the spreadsheet method, i.e. the workbook's math, with one fix. Strategy
  amounts that would come out negative are set to $0 (`SITE_RULES` in `tax-step.js`). Corrections
  can be turned on later by changing `SITE_RULES`.
- **States:** Louisiana; Texas and the other states with no wage tax (AK, FL, NV, NH, SD, TN, WY);
  any other state asks for one number, an approximate flat rate. That rate is pre-filled from the
  intake's prior-year state tax ÷ income when available.
- **Bypass:** users can skip the step from the step bar, or tick "Skip this beta step after the
  intake" (remembered per browser).
- **Detailed Results** shows each strategy without vs. with, how it's sized, its costs, the tax by
  bracket, and an expandable full calculation.

## Running it

ES modules need a web server (opening the file directly won't work). From the repo root:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/tax-calculator/> (and `/tax-calculator/tests/` for the tests).

Tests from a terminal, using macOS's built-in JavaScript engine (no Node or npm needed):

```bash
sh tax-calculator/tests/run-cli.sh
```

## Using the page

- **Excel replica / Side by side / Corrected**: choose which numbers the table shows (Excel replica is the default for now). Side by side
  shows the corrected value with the workbook's value and the difference underneath.
- **Tabs**: Strategies, With DB plan, With Roth conversion, Roth projection, and Corrections (the
  dollar effect of every fix on every strategy).
- **Click any number** for its audit:
  - *Line-by-line calculation*: income → AGI → deductions → bracket-by-bracket tax → credits →
    NIIT → state → costs → savings, each line with its arithmetic and its source (IRC section,
    Revenue Procedure, or workbook cell). You can also download it as a CSV.
  - *Workbook formulas*: the Excel formula tree for that cell, expandable down to the yellow inputs.
  - *Reconcile with Excel*: the workbook's number, then each correction in turn. The steps add up
    exactly to the corrected number.
- **Inputs** on the left mirror the workbook's yellow cells (each shows its cell reference). The
  *Strategy sizing* panel above each table is the workbook's "Manual Inputs" area: default rule,
  "fill to the top of a bracket", or a fixed amount.
- Inputs are remembered in this browser only. Nothing is sent anywhere.

## How it's organized

```
tax-calculator/
  index.html                  the calculator page
  src/
    engine/
      taxReturn.js            one federal + state return, with the audit ledger
      brackets.js             bracket math, capital-gains stacking
      rules.js                the tax-law corrections (each switchable)
      scenarios.js            scenario columns, DB/Roth blocks, running a scenario
      compare.js              all scenarios × blocks, savings (the comparison sheets)
      retirement.js           Roth vs. traditional IRA projection (RMD Simulation sheet)
      reconcile.js            Excel → corrected walk
      ledger.js               audit-trail lines, CSV export
      model.js                the input set and the sample client
    strategies/               one file per strategy: film, solar, charitable, leap
    tables/
      federal.js              2026 federal numbers (Rev. Proc. 2025-32 / OBBBA), RMD table
      states/index.js         state tables (Louisiana, Texas, no-income-tax states, custom flat rate)
    excel/
      workbook-data.js        GENERATED: the workbook's formulas and inputs
      workbook.js             spreadsheet engine that recalculates them
      formula.js              Excel formula parser
      mapping.js              calculator inputs ↔ workbook cells
    ui/                       standalone calculator page
    site/                     the intake site's Tax strategies step (beta)
  tests/                      browser runner (index.html), CLI runner, test files
  tools/export_workbook.py    regenerates workbook-data.js from an .xlsx
```

The math has no dependencies on the page, so the same modules can be dropped into the main site
later.

## How we know it's right

`tests/` (190 checks):

- **Replica = Excel.** Every formula cell in the workbook is recalculated from scratch and compared
  with the value Excel saved. All of them match exactly, except the Solar sizing loop. Excel saved
  that loop mid-search (its saved cells aren't even consistent with each other), so for those cells
  we check that the loop settles where its own formula says it should.
- **Engine (corrections off) = replica.** Two independent implementations are compared on the sample
  client and on 60 random clients: single/joint, business income, gains, dividends, DB plans,
  conversions, different strategy assumptions and manual sizing. They agree to the cent, except for
  the documented workbook mechanics listed in `tests/parity.test.js`.
- **Hand-calculated 2026 returns.** Brackets at every IRS boundary, capital-gain stacking, NIIT,
  SALT cap and phase-down, charitable limits, the 2/37 itemized limit, excess business loss, QBI
  phase-in, capital-loss limit, SE tax, AMT, and the business-credit limit. Each expected number is
  worked out in a comment.
- **Strategy behavior.** Solar's credit exactly uses the allowed tax, fill-to-bracket lands on the
  bracket, the reconciliation steps add up, and the RMD table matches the workbook's.

## Adding a strategy

1. Copy `src/strategies/film.js` to `src/strategies/<name>.js`. Fill in `params` (its assumptions),
   `sizing` (what the user can type in), `notes`, and `apply(ctx, params, sizing)`. In `apply`,
   describe what the strategy does through `ctx`:
   - `ctx.addBusinessLoss`: an ordinary deduction from a trade or business (subject to the
     excess-loss limit)
   - `ctx.addCapitalLoss`
   - `ctx.addCharitable`: an itemized gift, with its AGI limit
   - `ctx.addCredit`: a general business credit
   - `ctx.addCost`: a contribution, fee, or kept asset

   The engine does the tax math and the audit trail; use `ctx.log` for sizing lines.
2. Register it in `src/strategies/index.js`.
3. Add a column in `SCENARIOS` (`src/engine/scenarios.js`). Steps run in order, so a combination is
   just a list, e.g. `[{ strategy: 'leap' }, { strategy: 'charitable' }]`.
4. Add a test in `tests/strategies.test.js`.

New strategies only exist in the corrected engine. The Excel replica only covers what the workbook
has.

## Updating for a new tax year

1. Add a `2027` block in `src/tables/federal.js` (copy 2026, update every number from that year's
   Revenue Procedure) and a `2027` entry for each state in `src/tables/states/index.js`.
2. Set `year` in `src/engine/model.js`.
3. Add 2027 hand-calculated cases to `tests/tax-law.test.js`.

## Adding a state

Add an entry to `src/tables/states/index.js`: brackets per filing status, standard deduction,
whether itemized deductions are allowed, and notes on anything not modeled. States that start from
federal AGI need only data. States with unusual rules (e.g. their own capital-gain treatment) need
a few lines in `computeState` in `src/engine/taxReturn.js`.

## When the workbook changes

```bash
python3 tax-calculator/tools/export_workbook.py "path/to/PFO Tax Strategy Calculator.xlsx"
sh tax-calculator/tests/run-cli.sh
```

The exporter (needs `pip install openpyxl`) rewrites `src/excel/workbook-data.js` and the saved-value
fixture. If a sheet was added or a formula's meaning changed, the parity tests will show where the
engine needs updating. The RGP Income Fund sheets are excluded (not linked to the comparison).
