// Small inline-SVG charts for the tax plan (no libraries). Colors come from the site's CSS
// variables through classes in tax-step.css, so they follow the page's palette.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** $1.2M / $340K / $950 */
export function short(n) {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return `${s}$${Math.round(a)}`;
}
const full = (n) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Waterfall for the plan summary (drawn on the dark hero): the starting liability, a falling bar per
 * strategy, and the liability with the plan.
 * steps: [{ label, amount }] (amount = savings; negative = adds cost)
 */
export function waterfall({ start, steps, endLabel = 'With your plan', startLabel = 'Today' }) {
  const n = steps.length + 2;
  const W = 640, H = 230, top = 26, bottom = 46, left = 8, right = 8;
  const plotH = H - top - bottom;
  let level = start, maxLevel = start;
  const bars = [{ label: startLabel, from: 0, to: start, kind: 'start', value: start }];
  for (const s of steps) {
    const next = level - s.amount;
    bars.push({ label: s.label, from: next, to: level, kind: s.amount >= 0 ? 'down' : 'up', value: s.amount });
    level = next; maxLevel = Math.max(maxLevel, level);
  }
  bars.push({ label: endLabel, from: 0, to: level, kind: 'end', value: level });
  const max = niceMax(maxLevel);
  const slot = (W - left - right) / n;
  const bw = Math.min(70, slot * 0.62);
  const y = (v) => top + plotH - (v / max) * plotH;
  const parts = bars.map((b, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const y1 = y(Math.max(b.from, b.to)), y2 = y(Math.min(b.from, b.to));
    const h = Math.max(2, y2 - y1);
    const val = b.kind === 'down' ? `−${short(b.value)}` : b.kind === 'up' ? `+${short(-b.value)}` : short(b.value);
    const connector = i < bars.length - 1 ? `<line class="wf-link" x1="${x + bw}" x2="${x + slot}" y1="${y(b.kind === 'start' ? b.to : b.from)}" y2="${y(b.kind === 'start' ? b.to : b.from)}"/>` : '';
    const words = String(b.label).split(' ');
    const l1 = words.length > 1 && b.label.length > 11 ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : b.label;
    const l2 = l1 === b.label ? '' : words.slice(Math.ceil(words.length / 2)).join(' ');
    return `<g><title>${esc(b.label)}: ${full(b.kind === 'up' ? -b.value : b.value)}</title>
      <rect class="wf-${b.kind}" x="${x}" y="${y1}" width="${bw}" height="${h}" rx="3"/>
      <text class="wf-val wf-val-${b.kind}" x="${x + bw / 2}" y="${y1 - 7}" text-anchor="middle">${val}</text>
      <text class="wf-lab" x="${x + bw / 2}" y="${H - bottom + 17}" text-anchor="middle">${esc(l1)}</text>
      ${l2 ? `<text class="wf-lab" x="${x + bw / 2}" y="${H - bottom + 31}" text-anchor="middle">${esc(l2)}</text>` : ''}
      ${connector}</g>`;
  }).join('');
  return `<div class="tx-chart-wrap"><svg class="tx-wf" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tax liability today ${full(start)}, with the plan ${full(level)}">
    <line class="wf-base" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>${parts}</svg></div>`;
}

export const RATES = [0.06, 0.07, 0.08];
const RATE_CLASS = ['g6', 'g7', 'g8'];

/**
 * Growth at 6%, 7% and 8% a year. valueAt(rate, year) → balance at the end of that year.
 * contribAt(year) → total put in by then (drawn as bars), optional.
 * extra: [{ label, valueAt(year), cls }] dashed reference lines, optional.
 */
export function growthChart({ years, valueAt, contribAt = null, contribLabel = 'Put in', extra = [], xLabel = (yr) => `Yr ${yr}` }) {
  const W = 640, H = 250, top = 18, bottom = 30, left = 54, right = 92;
  const plotW = W - left - right, plotH = H - top - bottom;
  const yrs = Array.from({ length: years + 1 }, (_, i) => i);
  const series = RATES.map((r) => yrs.map((t) => valueAt(r, t)));
  const extraSeries = extra.map((e) => yrs.map((t) => e.valueAt(t)));
  const max = niceMax(Math.max(1, ...series.flat(), ...extraSeries.flat(), ...(contribAt ? yrs.map(contribAt) : [0])));
  const x = (t) => left + (t / years) * plotW;
  const y = (v) => top + plotH - (v / max) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line class="gc-grid" x1="${left}" x2="${left + plotW}" y1="${y(max * f)}" y2="${y(max * f)}"/>
    <text class="gc-axis" x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${short(max * f)}</text>`).join('');
  const step = years <= 10 ? 1 : years <= 20 ? 5 : 5;
  const ticks = yrs.filter((t) => t === years || (t % step === 0 && years - t >= step * 0.6)).map((t) => `<text class="gc-axis" x="${x(t)}" y="${H - 10}" text-anchor="middle">${esc(xLabel(t))}</text>`).join('');
  const bw = Math.max(3, Math.min(16, plotW / (years + 1) * 0.55));
  const bars = contribAt ? yrs.filter((t) => t > 0).map((t) => { const v = contribAt(t); return `<rect class="gc-bar" x="${x(t) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" rx="1.5"><title>${esc(contribLabel)} by ${esc(xLabel(t))}: ${full(v)}</title></rect>`; }).join('') : '';
  const path = (vals) => vals.map((v, t) => `${t ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `<path class="gc-band" d="${path(series[2])}L${x(years)},${y(series[0][years])}${series[0].map((v, t) => `L${x(years - t).toFixed(1)},${y(series[0][years - t]).toFixed(1)}`).join('')}Z"/>`;
  // End labels, nudged apart so they don't overlap.
  const ends = series.map((s, i) => ({ i, y: y(s[years]), v: s[years] })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
  const labels = ends.map((e) => `<text class="gc-end ${RATE_CLASS[e.i]}" x="${x(years) + 8}" y="${e.y + 4}">${(RATES[e.i] * 100).toFixed(0)}% · ${short(e.v)}</text>`).join('');
  const lines = series.map((s, i) => `<path class="gc-line ${RATE_CLASS[i]}" d="${path(s)}"/><circle class="gc-dot ${RATE_CLASS[i]}" cx="${x(years)}" cy="${y(s[years])}" r="3.5"/>`).join('');
  const extraLines = extraSeries.map((s, i) => `<path class="gc-ref ${extra[i].cls || ''}" d="${path(s)}"><title>${esc(extra[i].label)}</title></path>`).join('');
  return `<div class="tx-chart-wrap"><svg class="tx-gc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Growth at 6, 7 and 8 percent over ${years} years: ${RATES.map((r, i) => `${(r * 100).toFixed(0)}% ${full(series[i][years])}`).join(', ')}">
    ${grid}${bars}${area}${extraLines}${lines}${labels}${ticks}</svg></div>`;
}

/** Legend for growthChart. */
export function growthLegend({ contribLabel = null, extra = [] } = {}) {
  return `<div class="gc-legend">${RATES.map((r, i) => `<span><i class="gc-key ${RATE_CLASS[i]}"></i>${(r * 100).toFixed(0)}% a year</span>`).join('')}
    ${contribLabel ? `<span><i class="gc-key gc-key-bar"></i>${esc(contribLabel)}</span>` : ''}
    ${extra.map((e) => `<span><i class="gc-key gc-key-ref ${e.cls || ''}"></i>${esc(e.label)}</span>`).join('')}</div>`;
}

/** Two horizontal bars: tax liability without and with a strategy. */
export function beforeAfter(before, after, labelAfter = 'With strategy') {
  const max = Math.max(1, before, after);
  const w = (v) => Math.max(1.5, (Math.max(0, v) / max) * 100);
  return `<div class="tx-ba" role="img" aria-label="Tax liability ${full(before)} without, ${full(after)} with">
    <div class="tx-ba-row"><span>Without</span><div class="tx-ba-track"><i class="ba-before" style="width:${w(before)}%"></i></div><b>${short(before)}</b></div>
    <div class="tx-ba-row"><span>${esc(labelAfter)}</span><div class="tx-ba-track"><i class="ba-after" style="width:${w(after)}%"></i><i class="ba-saved" style="width:${Math.max(0, w(before) - w(after))}%"></i></div><b>${short(after)}</b></div></div>`;
}

/** Donut of the plan's savings by strategy. parts: [{ label, amount }] */
export function donut(parts, centerTop, centerBottom) {
  const pos = parts.filter((p) => p.amount > 0.5);
  const total = pos.reduce((s, p) => s + p.amount, 0);
  const R = 46, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = total > 0 ? pos.map((p, i) => {
    const len = (p.amount / total) * C;
    const a = `<circle class="dn-arc dn-${i % 6}" r="${R}" cx="60" cy="60" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(p.label)}: ${full(p.amount)}</title></circle>`;
    off += len; return a;
  }).join('') : '';
  return `<svg class="tx-dn" viewBox="0 0 120 120" role="img" aria-label="Savings by strategy">
    <circle class="dn-track" r="${R}" cx="60" cy="60"/>${arcs}
    <text class="dn-top" x="60" y="58" text-anchor="middle">${esc(centerTop)}</text>
    <text class="dn-bottom" x="60" y="74" text-anchor="middle">${esc(centerBottom)}</text></svg>`;
}

// ------------------------------------------------------------------ one-time investment, realistic path
// Year-to-year deviations from the average return (a market-like sequence with down years). Each path
// is rescaled so it compounds to exactly the target rate at the horizon: same end value as a steady
// return, but with the ups and downs real portfolios have along the way.
const SWINGS = [0.11, -0.06, 0.08, 0.14, -0.17, 0.19, 0.05, 0.01, -0.09, 0.12, 0.09, -0.03, 0.16, 0.03, -0.12, 0.13, 0.07, 0.0, 0.1, -0.05, 0.08, 0.15, -0.08, 0.06, 0.11, -0.02, 0.09, 0.04, -0.1, 0.12];
const pathCache = new Map();
/** Growth factors by year (index 0 = 1) for a rate over a horizon. */
export function realisticPath(rate, years) {
  const key = `${rate}:${years}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const raw = Array.from({ length: years }, (_, i) => 1 + rate + SWINGS[i % SWINGS.length] * 0.8);
  const prod = raw.reduce((p, x) => p * x, 1);
  const adj = Math.pow(Math.pow(1 + rate, years) / prod, 1 / years);
  const out = [1];
  for (let i = 0; i < years; i++) out.push(out[i] * raw[i] * adj);
  pathCache.set(key, out);
  return out;
}

/**
 * groups: [{ label, amount, cls }] one-time amounts at year 0, each drawn as a 6–8% band with a 7% line.
 */
export function investChart({ years, groups, xLabel = (t) => `Yr ${t}` }) {
  const W = 560, H = 210, top = 16, bottom = 28, left = 52, right = 104;
  const plotW = W - left - right, plotH = H - top - bottom;
  const yrs = Array.from({ length: years + 1 }, (_, i) => i);
  const val = (g, r, t) => g.amount * realisticPath(r, years)[t];
  const max = niceMax(Math.max(1, ...groups.flatMap((g) => yrs.map((t) => val(g, 0.08, t)))));
  const x = (t) => left + (t / years) * plotW;
  const y = (v) => top + plotH - (v / max) * plotH;
  const grid = [0, 0.5, 1].map((f) => `<line class="gc-grid" x1="${left}" x2="${left + plotW}" y1="${y(max * f)}" y2="${y(max * f)}"/>
    <text class="gc-axis" x="${left - 8}" y="${y(max * f) + 4}" text-anchor="end">${short(max * f)}</text>`).join('');
  const step = years <= 12 ? 2 : 5;
  const ticks = yrs.filter((t) => t === 0 || t === years || (t % step === 0 && years - t >= step * 0.6)).map((t) => `<text class="gc-axis" x="${x(t)}" y="${H - 9}" text-anchor="middle">${esc(xLabel(t))}</text>`).join('');
  const path = (vals) => vals.map((v, t) => `${t ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ends = [];
  const body = groups.map((g) => {
    const hi = yrs.map((t) => val(g, 0.08, t)), lo = yrs.map((t) => val(g, 0.06, t)), mid = yrs.map((t) => val(g, 0.07, t));
    ends.push({ g, y: y(mid[years]), v: mid[years], lo: lo[years], hi: hi[years] });
    return `<path class="ic-band ${g.cls}" d="${path(hi)}${lo.map((v, t) => `L${x(years - t).toFixed(1)},${y(lo[years - t]).toFixed(1)}`).join('')}Z"/>
      <path class="ic-line ${g.cls}" d="${path(mid)}"/>
      <circle class="ic-dot ${g.cls}" cx="${x(0)}" cy="${y(g.amount)}" r="4"><title>${esc(g.label)}: ${full(g.amount)} today</title></circle>`;
  }).join('');
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 30) ends[k].y = ends[k - 1].y + 30;
  const labels = ends.map((e) => `<text class="ic-end ${e.g.cls}" x="${x(years) + 8}" y="${e.y}">${short(e.v)}</text>
    <text class="ic-range" x="${x(years) + 8}" y="${e.y + 13}">${short(e.lo)}–${short(e.hi)}</text>`).join('');
  return `<div class="tx-chart-wrap"><svg class="tx-gc tx-ic" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(groups.map((g) => `${g.label} ${full(g.amount)} today`).join(', '))}">
    ${grid}${body}${labels}${ticks}</svg></div>`;
}
