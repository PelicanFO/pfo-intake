// Strategy registry. To add a strategy:
//   1. Create src/strategies/<id>.js following the shape of film.js (id, name, params, sizing, apply).
//   2. Import and list it below.
//   3. Add it to a scenario in src/engine/scenarios.js (or build a custom scenario in the UI).
//   4. Add a test in tests/strategies.test.js.
// A strategy's apply() changes the client's "situation" through ctx (losses, gifts, credits, income)
// and records what it costs; the engine does all the tax math and the audit trail.
import film from './film.js';
import solar from './solar.js';
import charitable from './charitable.js';
import leap from './leap.js';

export const STRATEGIES = { film, solar, charitable, leap };

export function defaultParams() {
  const out = {};
  for (const s of Object.values(STRATEGIES)) out[s.id] = Object.fromEntries(s.params.map((p) => [p.key, p.default]));
  return out;
}
