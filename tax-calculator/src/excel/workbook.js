// A small spreadsheet engine that recalculates the exported PFO workbook exactly as Excel does,
// including Excel's iterative calculation for the self-referencing Solar sizing cells.
//
//   const wb = new Workbook(workbookData);
//   wb.set("Strategy comparison!C5", 500000);
//   wb.get("Strategy comparison!G11");          // → Film savings
//   wb.trace("Strategy comparison!G11", 3);     // → formula tree for the audit view

import { parseFormula, collectRefs, XlError, isError, parseAddr, numToCol } from './formula.js';

export const EMPTY = Symbol('empty');
const ERR = (code) => new XlError(code);
class Thrown { constructor(err) { this.err = err; } }
const raise = (code) => { throw new Thrown(ERR(code)); };

const key = (sheet, col, row) => `${sheet}!${numToCol(col)}${row}`;
export function splitRef(ref) {
  const i = ref.lastIndexOf('!');
  return { sheet: ref.slice(0, i), addr: ref.slice(i + 1).replace(/\$/g, '') };
}

export class Workbook {
  constructor(data) {
    this.data = data;
    this.overrides = new Map();
    this.astCache = new Map();
    this.colIndex = new Map();
    this.iterateCount = Math.max(data.meta.iterateCount || 100, 100);
    this.iterateDelta = data.meta.iterateDelta || 0.001;
    this.maxIterations = 20000; // Excel re-iterates on every recalc; we iterate until settled.
    this.recalc();
  }

  recalc() {
    this.memo = new Map();
    this.taintSrc = new Map();
    this.inProgress = new Set();
    this.prev = new Map(Object.entries(this.data.init || {}));
    this.frames = [];
    this.iterationLog = [];
  }

  /** Set a cell to a number, string, null (blank) or a formula string beginning with "=". */
  set(ref, value) {
    const { sheet, addr } = splitRef(ref);
    if (!this.data.sheets[sheet]) throw new Error(`Unknown sheet ${sheet}`);
    this.overrides.set(`${sheet}!${addr}`, value === undefined ? null : value);
    this.recalc();
  }
  setMany(map) {
    for (const [ref, v] of Object.entries(map)) {
      const { sheet, addr } = splitRef(ref);
      if (!this.data.sheets[sheet]) throw new Error(`Unknown sheet ${sheet}`);
      this.overrides.set(`${sheet}!${addr}`, v === undefined ? null : v);
    }
    this.recalc();
  }
  reset() { this.overrides.clear(); this.recalc(); }

  raw(sheet, addr) {
    const k = `${sheet}!${addr}`;
    if (this.overrides.has(k)) return this.overrides.get(k);
    const v = this.data.sheets[sheet] ? this.data.sheets[sheet][addr] : undefined;
    return v === undefined ? null : v;
  }
  formulaOf(ref) {
    const { sheet, addr } = splitRef(ref);
    const r = this.raw(sheet, addr);
    return typeof r === 'string' && r.startsWith('=') ? r : null;
  }
  ast(formula) {
    let a = this.astCache.get(formula);
    if (!a) { a = parseFormula(formula); this.astCache.set(formula, a); }
    return a;
  }

  /** Value of a cell: number | string | boolean | XlError. Blank cells read as 0 only inside formulas. */
  get(ref) {
    const { sheet, addr } = splitRef(ref);
    const v = this.cell(sheet, addr);
    return v === EMPTY ? null : v;
  }
  num(ref) {
    const v = this.get(ref);
    return typeof v === 'number' ? v : (v === null ? 0 : v);
  }

  cell(sheet, addr) {
    const k = `${sheet}!${addr}`;
    const frame = this.frames[this.frames.length - 1];
    if (this.memo.has(k)) {
      const src = this.taintSrc.get(k);
      if (frame && src) for (const s of src) if (this.inProgress.has(s)) frame.sources.add(s);
      return this.memo.get(k);
    }
    const raw = this.raw(sheet, addr);
    if (!(typeof raw === 'string' && raw.startsWith('='))) return raw === null ? EMPTY : raw;
    if (this.inProgress.has(k)) {
      // Circular reference: Excel's iterative calculation reads the previous iteration's value.
      frame.sources.add(k);
      return this.prev.has(k) ? this.prev.get(k) : 0;
    }
    return this.compute(sheet, k, raw);
  }

  compute(sheet, k, raw) {
    this.inProgress.add(k);
    this.frames.push({ sources: new Set() });
    let v;
    try {
      v = this.evalNode(this.ast(raw), sheet);
      if (v === EMPTY) v = 0;
      if (v && v.range) v = this.scalar(v);
    } catch (e) {
      if (e instanceof Thrown) v = e.err; else throw new Error(`${k}: ${e.message}`);
    }
    const frame = this.frames.pop();
    this.inProgress.delete(k);
    this.memo.set(k, v);
    if (frame.sources.size) {
      // This cell read a value that is still being calculated (a circular chain).
      this.taintSrc.set(k, frame.sources);
      const pending = [...frame.sources].filter((s) => this.inProgress.has(s));
      const parent = this.frames[this.frames.length - 1];
      if (parent) pending.forEach((s) => parent.sources.add(s));
      if (frame.sources.has(k) && pending.length === 0 && !this.iterating) return this.iterate(sheet, k, raw, v);
    }
    return v;
  }

  // Fixed-point iteration over a circular chain, mirroring Excel's iterative calculation.
  // Excel runs 100 iterations per recalc and every edit triggers another recalc, so a saved
  // workbook has usually settled. We iterate until values stop changing or start to oscillate
  // (the Solar sizing formula steps up and down around its target once it is close).
  iterate(sheet, k, raw, first) {
    this.iterating = true;
    let value = first, steps = 0;
    const history = [];
    for (;;) {
      steps++;
      let maxChange = 0;
      for (const t of this.taintSrc.keys()) {
        const v = this.memo.get(t), before = this.prev.get(t);
        if (typeof v === 'number' && typeof before === 'number') maxChange = Math.max(maxChange, Math.abs(v - before));
        else if (v !== before) maxChange = Infinity;
        this.prev.set(t, v);
      }
      if (maxChange < this.iterateDelta || steps >= this.maxIterations) break;
      if (history.length >= 2 && history[history.length - 2] === value) break;
      history.push(value);
      for (const t of this.taintSrc.keys()) this.memo.delete(t);
      this.taintSrc = new Map();
      value = this.compute(sheet, k, raw);
    }
    this.iterationLog.push({ cell: k, iterations: steps });
    this.taintSrc = new Map();
    this.iterating = false;
    return value;
  }

  // ---- evaluation -------------------------------------------------------------------------
  evalNode(n, sheet) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': raise(n.v); break;
      case 'missing': return EMPTY;
      case 'ref':
        if (n.b) return { range: true, ...this.rangeOf(n, sheet) };
        return this.cell(n.sheet || sheet, `${numToCol(n.a.col)}${n.a.row}`);
      case 'colrange': return { range: true, sheet: n.sheet || sheet, c1: n.c1, c2: n.c2, r1: 1, r2: Infinity };
      case 'un': {
        const a = this.toNum(this.scalar(this.evalNode(n.a, sheet)));
        return n.op === '-' ? -a : a;
      }
      case 'pct': return this.toNum(this.scalar(this.evalNode(n.a, sheet))) / 100;
      case 'bin': return this.binary(n, sheet);
      case 'fn': return this.call(n, sheet);
    }
    throw new Error(`Unknown node ${n.t}`);
  }

  rangeOf(n, sheet) {
    return {
      sheet: n.sheet || sheet,
      c1: Math.min(n.a.col, n.b.col), c2: Math.max(n.a.col, n.b.col),
      r1: Math.min(n.a.row, n.b.row), r2: Math.max(n.a.row, n.b.row),
    };
  }

  // Cells of a range in row-major order. Whole-column ranges only visit populated rows.
  *rangeCells(r) {
    if (r.r2 === Infinity) {
      for (let c = r.c1; c <= r.c2; c++) {
        for (const row of this.populatedRows(r.sheet, c)) yield { sheet: r.sheet, col: c, row };
      }
      return;
    }
    for (let row = r.r1; row <= r.r2; row++) for (let c = r.c1; c <= r.c2; c++) yield { sheet: r.sheet, col: c, row };
  }
  populatedRows(sheet, col) {
    const k = `${sheet}|${col}`;
    if (!this.colIndex.has(k)) {
      const letters = numToCol(col);
      const rows = Object.keys(this.data.sheets[sheet] || {})
        .filter((a) => a.replace(/\d+$/, '') === letters)
        .map((a) => Number(a.slice(letters.length))).sort((x, y) => x - y);
      this.colIndex.set(k, rows);
    }
    return this.colIndex.get(k);
  }
  rangeValues(r) {
    const out = [];
    for (const c of this.rangeCells(r)) out.push(this.cell(c.sheet, `${numToCol(c.col)}${c.row}`));
    return out;
  }

  scalar(v) {
    if (v && v.range) {
      if (v.r1 === v.r2 && v.c1 === v.c2) return this.cell(v.sheet, `${numToCol(v.c1)}${v.r1}`);
      raise('#VALUE!');
    }
    if (isError(v)) throw new Thrown(v);
    return v;
  }
  toNum(v) {
    if (isError(v)) throw new Thrown(v);
    if (v === EMPTY || v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
      raise('#VALUE!');
    }
    raise('#VALUE!');
  }
  toBool(v) {
    if (isError(v)) throw new Thrown(v);
    if (v === EMPTY || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      if (v.toUpperCase() === 'TRUE') return true;
      if (v.toUpperCase() === 'FALSE') return false;
    }
    raise('#VALUE!');
  }
  toStr(v) {
    if (isError(v)) throw new Thrown(v);
    if (v === EMPTY || v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }

  // Excel comparison: blank adapts to the other side; numbers < text < booleans; text is case-insensitive.
  compare(a, b) {
    if (a === EMPTY && b === EMPTY) return 0;
    if (a === EMPTY) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === EMPTY) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    const rank = (x) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (typeof a === 'boolean') { a = a ? 1 : 0; b = b ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  binary(n, sheet) {
    const a = this.scalar(this.evalNode(n.a, sheet));
    const b = this.scalar(this.evalNode(n.b, sheet));
    switch (n.op) {
      case '+': return this.toNum(a) + this.toNum(b);
      case '-': return this.toNum(a) - this.toNum(b);
      case '*': return this.toNum(a) * this.toNum(b);
      case '/': { const d = this.toNum(b); if (d === 0) raise('#DIV/0!'); return this.toNum(a) / d; }
      case '^': return Math.pow(this.toNum(a), this.toNum(b));
      case '&': return this.toStr(a) + this.toStr(b);
      case '=': return this.compare(a, b) === 0;
      case '<>': return this.compare(a, b) !== 0;
      case '<': return this.compare(a, b) < 0;
      case '>': return this.compare(a, b) > 0;
      case '<=': return this.compare(a, b) <= 0;
      case '>=': return this.compare(a, b) >= 0;
    }
    throw new Error(`Unknown operator ${n.op}`);
  }

  // Numbers from arguments the way SUM/MIN/MAX/NPV see them: references skip text, blanks and booleans.
  numbersFrom(args, sheet) {
    const out = [];
    for (const a of args) {
      if (a.t === 'missing') continue;
      if (a.t === 'ref' || a.t === 'colrange') {
        const v = this.evalNode(a, sheet);
        const vals = v && v.range ? this.rangeValues(v) : [v];
        for (const x of vals) {
          if (isError(x)) throw new Thrown(x);
          if (typeof x === 'number') out.push(x);
        }
      } else {
        out.push(this.toNum(this.scalar(this.evalNode(a, sheet))));
      }
    }
    return out;
  }

  call(n, sheet) {
    const A = n.args;
    const val = (i) => this.scalar(this.evalNode(A[i], sheet));
    switch (n.name) {
      case 'IF': {
        const c = this.toBool(val(0));
        if (c) return A.length > 1 ? this.evalNode(A[1], sheet) : true;
        return A.length > 2 ? this.evalNode(A[2], sheet) : false;
      }
      case 'IFERROR': {
        try {
          const v = this.evalNode(A[0], sheet);
          return v && v.range ? this.scalar(v) : v;
        } catch (e) {
          if (e instanceof Thrown) return this.evalNode(A[1], sheet);
          throw e;
        }
      }
      case 'SUM': return this.numbersFrom(A, sheet).reduce((s, x) => s + x, 0);
      case 'MIN': { const xs = this.numbersFrom(A, sheet); return xs.length ? Math.min(...xs) : 0; }
      case 'MAX': { const xs = this.numbersFrom(A, sheet); return xs.length ? Math.max(...xs) : 0; }
      case 'ABS': return Math.abs(this.toNum(val(0)));
      case 'NPV': {
        const rate = this.toNum(val(0));
        return this.numbersFrom(A.slice(1), sheet).reduce((s, x, i) => s + x / Math.pow(1 + rate, i + 1), 0);
      }
      case 'FV': {
        const rate = this.toNum(val(0)), nper = this.toNum(val(1));
        const pmt = A[2] ? this.toNum(val(2)) : 0, pv = A[3] ? this.toNum(val(3)) : 0;
        const type = A[4] ? this.toNum(val(4)) : 0;
        if (rate === 0) return -(pv + pmt * nper);
        const g = Math.pow(1 + rate, nper);
        return -(pv * g + pmt * (1 + rate * type) * (g - 1) / rate);
      }
      case 'XLOOKUP': {
        const needle = val(0);
        const look = this.evalNode(A[1], sheet), ret = this.evalNode(A[2], sheet);
        if (!look.range || !ret.range) raise('#VALUE!');
        const lc = [...this.rangeCells(look)], rc = [...this.rangeCells(ret)];
        for (let i = 0; i < lc.length; i++) {
          const v = this.cell(lc[i].sheet, `${numToCol(lc[i].col)}${lc[i].row}`);
          if (isError(v) || v === EMPTY) continue;
          if (typeof v === typeof needle && this.compare(v, needle) === 0) {
            // Whole-column lookups pair by row; bounded ranges pair by position.
            const target = look.r2 === Infinity
              ? { sheet: ret.sheet, col: ret.c1, row: lc[i].row }
              : rc[i];
            if (!target) raise('#N/A');
            return this.cell(target.sheet, `${numToCol(target.col)}${target.row}`);
          }
        }
        if (A.length > 3 && A[3].t !== 'missing') return this.evalNode(A[3], sheet);
        raise('#N/A');
      }
    }
    raise('#NAME?');
  }

  // ---- audit helpers ------------------------------------------------------------------------
  /** Nearest text to the left (row label) and above (column header), for readable traces. */
  label(ref) {
    const { sheet, addr } = splitRef(ref);
    const { col, row } = parseAddr(addr);
    const cells = this.data.sheets[sheet] || {};
    const text = (c, r) => { const v = cells[`${numToCol(c)}${r}`]; return typeof v === 'string' && !v.startsWith('=') ? v.trim() : null; };
    let rowLabel = null, colLabel = null;
    for (let c = col - 1; c >= 1 && !rowLabel; c--) rowLabel = text(c, row);
    for (let r = row - 1; r >= Math.max(1, row - 30) && !colLabel; r--) colLabel = text(col, r);
    return { rowLabel, colLabel };
  }

  precedents(ref) {
    const f = this.formulaOf(ref);
    if (!f) return [];
    const { sheet } = splitRef(ref);
    const out = [];
    for (const r of collectRefs(this.ast(f))) {
      const s = r.sheet || sheet;
      if (r.t === 'colrange') { out.push(`${s}!${numToCol(r.c1)}:${numToCol(r.c2)}`); continue; }
      if (!r.b) { out.push(`${s}!${numToCol(r.a.col)}${r.a.row}`); continue; }
      const rg = this.rangeOf(r, sheet);
      const n = (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
      if (n <= 12) for (const c of this.rangeCells(rg)) out.push(key(c.sheet, c.col, c.row));
      else out.push(`${s}!${numToCol(rg.c1)}${rg.r1}:${numToCol(rg.c2)}${rg.r2}`);
    }
    return [...new Set(out)];
  }

  /** Formula tree for a cell, `depth` levels deep, with labels and values. */
  trace(ref, depth = 2, seen = new Set()) {
    const { sheet, addr } = splitRef(ref);
    const isRange = addr.includes(':');
    const node = {
      ref, sheet, addr,
      ...(isRange ? {} : this.label(ref)),
      formula: isRange ? null : this.formulaOf(ref),
      value: isRange ? null : this.get(ref),
      input: !isRange && (this.data.inputs[sheet] || []).includes(addr),
      children: [],
    };
    if (depth > 0 && node.formula && !seen.has(ref)) {
      seen.add(ref);
      node.children = this.precedents(ref).map((p) => (p.includes(':') && !/\d/.test(p.split('!')[1])
        ? { ref: p, formula: null, value: null, children: [] }
        : this.trace(p, depth - 1, seen)));
    }
    return node;
  }
}
