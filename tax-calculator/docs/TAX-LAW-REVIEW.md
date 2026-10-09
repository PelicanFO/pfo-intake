# Tax-law review of the workbook

This is where the PFO Tax Strategy Calculator workbook departs from 2026 tax law, what the corrected
engine does instead, and what that is worth for the workbook's sample client. Each correction is a
switch on the calculator page, and the **Corrections** tab shows its effect for any client.

**Sample client:** married filing jointly, $400,000 W-2 wages, age 65, Louisiana, $450,000 Roth
conversion.

**Numbers verified against:** Rev. Proc. 2025-32 (2026 inflation adjustments); the IRC as amended
by P.L. 119-21 (OBBBA); Louisiana R.S. 47:32 and 47:294 and LDR RIB 26-005.

## Headline effect for the sample client

| Strategies tab | Workbook savings | Corrected savings | Main reasons |
|---|---:|---:|---|
| Film | $15,582 | $14,911 | Standard deduction |
| Solar | $11,553 | $11,789 | Workbook sizing mechanics (+$3,856), standard deduction (−$1,617), credit limit (−$2,004) |
| Charitable | $7,772 | **−$17,505** | 30%-of-AGI limit (−$19,212; $80,000 carries forward); itemizing gives up the standard deduction (−$5,880) |
| Solar & Charitable | $9,156 | $11,789 | The charitable leg doesn't apply below the 24% bracket (workbook gives a negative gift) |
| LEAP | −$14,332 | $0 | Workbook's LEAP input goes negative with no business income; corrected sizes it at $0 and flags it |
| With Roth: Film | $65,448 | **−$4,535** | Excess business loss limit: the 100% offset of $850,000 exceeds the $512,000 limit (−$67,763; the rest becomes a loss carryforward) |

Baseline tax with no planning: corrected **$85,254** vs. workbook $93,195.

"This year's savings" leaves out carryforwards (unused credits, losses, and gifts over the AGI limit).
Those have future value, so the corrected savings are conservative. The page lists carryforward
amounts under each strategy.

## Corrections (in the order the reconciliation applies them)

| # | Workbook | Law (corrected engine) | Source |
|---|---|---|---|
| 1 | Federal tax on gross income, no deduction | Standard deduction ($32,200 joint / $16,100 single / $24,150 head of household) plus $1,650–$2,050 per person 65+; or itemized deductions (SALT to the $40,400 cap phasing down above $505,000, charitable gifts, other); plus the 2025–2028 $6,000 senior deduction | §§63, 151(d)(5), 164(b)(7) |
| 2 | Each bracket starts $1 above the prior top | Continuous brackets | §1(j) |
| 3 | 0/15/20% applied to gains alone, so gains get 0% at any income | Gains and qualified dividends stacked on ordinary taxable income; capital losses net, $3,000 against ordinary income, rest carried forward | §1(h), §1211 |
| 4 | NIIT = 3.8% × the *greater* of investment income or income over the threshold (so it taxes wages), then left out of the totals | 3.8% × the *lesser* of net investment income or MAGI over $250k/$200k, and included | §1411 |
| 5 | Not included | 0.9% Additional Medicare Tax; SE tax for Schedule C income | §§1401, 3101(b)(2) |
| 6 | Not included | 20% QBI deduction with the 2026 phase-in ($403,500 joint + $150,000 range). Defaults to specified-service treatment (conservative); strategy losses reduce QBI | §199A |
| 7 | Full donation deductible | 30% of AGI for appreciated property (60% cash), 0.5%-of-AGI floor, 5-year carryforward, 2/37 itemized limit in the 37% bracket | §170(b), §68 |
| 8 | Strategy losses offset unlimited wages | Excess business loss limit: $512,000 joint / $256,000 other; the excess becomes a loss carryforward | §461(l) |
| 9 | Not included | AMT (simplified: standard deduction and SALT added back; 2026 exemption and 50% phase-out) | §§55–56 |
| 10 | Solar credit treated as wiping out the full tax; the sizing target includes NIIT and state savings | Credit limited to tax above 25% of net regular tax over $25,000; unused credit carries back 1 year and forward 20; can't offset NIIT | §38(c), §39 |
| 11 | Louisiana 3% of gross income | Louisiana standard deduction ($25,750 joint / $12,875 single, provisional 2026 amounts) | La. R.S. 47:294 |
| 12 | Negative strategy amounts flow through (LEAP, Solar & Charitable) | Sized at $0 and flagged | Spreadsheet fix |
| 13 | RMDs start at 73 for everyone | 73 if born 1951–1959; 75 if born 1960+ | SECURE 2.0 §107 |
| 14 | First-year IRA withdrawal tax left out of the present value | Included | Spreadsheet fix |

## Workbook mechanics (not tax law, but they change numbers)

These are reproduced exactly by the Excel replica and fixed by the engine. They show up as the
"Spreadsheet mechanics" step in the reconciliation.

- **Solar sizing is an iterative circular reference.** Each recalculation moves the contribution 1%
  (or 0.01%) of the target, so after big input changes the workbook can be several recalcs from
  settled. The saved file was mid-search: Strategy comparison and DB comparison show $11,545 and
  $11,553 for the same Solar scenario. The target also counts NIIT and the state benefit, which
  credits can't offset. The engine solves the sizing directly.
- **Solar & Roth "Fed Taxes Remaining"** compares against the no-conversion federal tax. This only
  matters with a manual contribution.
- **Solar & Charitable** NIIT uses the single-filer threshold for everyone (`D6` instead of `C6` in
  J46).
- **LEAP state tax** subtracts all business income and gains, whatever the K-1 amounts.
- **The workbook's LEAP input** for the sample (`K18 = business income − 100,800`) is negative when
  there's no business income, which *adds* $100,800 of income.
- **Roth projection** measures the conversion's tax treating gains and dividends as ordinary
  income. With a $0 conversion and no projected rate it shows `#DIV/0!`.
- **Film & DB / Film & Roth** default to a 100% income offset (their manual inputs are blank), while
  the base Film column uses "fill the 12% bracket". This is why the DB block's Film savings ($8,985)
  differ from the base block's ($15,582) even with a $0 DB contribution.

## Not modeled (judgment calls; flagged on the page where relevant)

- **Strategy compliance.** Passive-activity and at-risk rules (§§469, 465) for Film, Solar and LEAP
  losses and credits; holding-period and appraisal rules for the leveraged charitable gift; listed-
  transaction reporting; OBBBA wind/solar construction deadlines. The engine assumes the strategies
  work as marketed, as you asked.
- **Louisiana** age-65 retirement income exclusion ($12,000 per person, indexed); final 2026
  standard deduction (LDR may adjust the provisional $12,875 / $25,750).
- **Other states.** The state layer is data-driven; only Louisiana and "no income tax" are loaded.
- **Itemized deductions** beyond state income tax, property tax and the strategy gift come from an
  optional "other itemized" input. Mortgage interest and similar aren't asked for.
- **AMT preferences** (ISOs, private-activity bond interest, depreciation adjustments) aren't
  included.
- **IRMAA** (Medicare premium surcharges two years after a large conversion) isn't included. This is
  worth adding for Roth conversions at 63+.

## Choices made to avoid asking the client more questions

| Question | Default | Why |
|---|---|---|
| Spouse's age | Same as the client | Common case; only affects 65+ deductions |
| Property tax | $0 | Only matters if the client itemizes |
| Business income type | K-1 pass-through (no SE tax) | Matches the DB/LEAP planning use case |
| QBI treatment | Specified service business | Conservative: no deduction above the phase-in range |
| Charitable gift type | Appreciated property (30% limit) | Matches the leveraged-gift structure |
