// Excel formula parser for the subset of Excel used by the PFO workbook.
// Produces a small AST that src/excel/workbook.js evaluates. Supported: numbers, strings,
// booleans, error literals, cell refs, ranges, whole-column ranges, cross-sheet refs,
// arithmetic (+ - * / ^ %), concatenation (&), comparisons, and function calls.

export class XlError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
export const isError = (v) => v instanceof XlError;

const ERRORS = ['#REF!', '#N/A', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#NULL!'];

export function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function parseAddr(addr) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(addr);
  if (!m) throw new Error(`Bad cell address ${addr}`);
  return { col: colToNum(m[1]), row: Number(m[2]) };
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const re = {
    ws: /\s+/y,
    num: /(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/y,
    fn: /([A-Za-z_][A-Za-z0-9_.]*)\(/y,
    sheetQ: /'((?:[^']|'')+)'!/y,
    sheet: /([A-Za-z_][A-Za-z0-9_.]*)!/y,
    range: /\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/y,
    colRange: /\$?([A-Z]{1,3}):\$?([A-Z]{1,3})(?![A-Za-z0-9])/y,
    bool: /(TRUE|FALSE)(?![A-Za-z0-9_(])/y,
    op: /<>|<=|>=|[-+*/^&=<>%(),]/y,
  };
  const at = (r) => { r.lastIndex = i; const m = r.exec(src); if (m) i = r.lastIndex; return m; };
  while (i < src.length) {
    let m;
    if (at(re.ws)) continue;
    if (src[i] === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length) throw new Error(`Unterminated string in ${src}`);
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (src[i] === '#') {
      const e = ERRORS.find((code) => src.startsWith(code, i));
      if (!e) throw new Error(`Unknown error literal in ${src}`);
      toks.push({ t: 'err', v: e }); i += e.length; continue;
    }
    if ((m = at(re.num))) { toks.push({ t: 'num', v: Number(m[0]) }); continue; }
    if ((m = at(re.fn))) { toks.push({ t: 'fn', v: m[1].toUpperCase().replace(/^_XLFN\./, '') }); continue; }
    let sheet = null;
    if ((m = at(re.sheetQ))) sheet = m[1].replace(/''/g, "'");
    else if ((m = at(re.sheet))) sheet = m[1];
    if (sheet !== null && src[i] === '#') {
      // e.g. Sheet!#REF!
      const e = ERRORS.find((code) => src.startsWith(code, i));
      toks.push({ t: 'err', v: e }); i += e.length; continue;
    }
    if ((m = at(re.colRange))) { toks.push({ t: 'colrange', sheet, c1: colToNum(m[1]), c2: colToNum(m[2]) }); continue; }
    if ((m = at(re.range))) {
      const a = { col: colToNum(m[1]), row: Number(m[2]) };
      const b = m[3] ? { col: colToNum(m[3]), row: Number(m[4]) } : null;
      toks.push({ t: 'ref', sheet, a, b }); continue;
    }
    if (sheet !== null) throw new Error(`Expected reference after sheet name in ${src}`);
    if ((m = at(re.bool))) { toks.push({ t: 'bool', v: m[1] === 'TRUE' }); continue; }
    if ((m = at(re.op))) { toks.push({ t: 'op', v: m[0] }); continue; }
    throw new Error(`Cannot tokenize "${src.slice(i, i + 20)}" in ${src}`);
  }
  return toks;
}

// Precedence (low → high): comparison, &, + -, * /, ^, unary, %
export function parseFormula(formula) {
  const src = formula.startsWith('=') ? formula.slice(1) : formula;
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}" in ${formula}`); p++; };

  function binary(next, ops) {
    return () => {
      let a = next();
      while (peek() && peek().t === 'op' && ops.includes(peek().v)) {
        const op = toks[p++].v;
        a = { t: 'bin', op, a, b: next() };
      }
      return a;
    };
  }
  function primary() {
    const tok = toks[p++];
    if (!tok) throw new Error(`Unexpected end of ${formula}`);
    switch (tok.t) {
      case 'num': case 'str': case 'bool': case 'err': return tok;
      case 'ref': case 'colrange': return tok;
      case 'fn': {
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            if (isOp(',')) { args.push({ t: 'missing' }); p++; continue; }
            args.push(comparison());
            if (isOp(',')) { p++; if (isOp(')')) args.push({ t: 'missing' }); continue; }
            break;
          }
        }
        expect(')');
        return { t: 'fn', name: tok.v, args };
      }
      case 'op':
        if (tok.v === '(') { const e = comparison(); expect(')'); return e; }
        if (tok.v === '-' || tok.v === '+') return { t: 'un', op: tok.v, a: unary() };
    }
    throw new Error(`Unexpected token ${JSON.stringify(tok)} in ${formula}`);
  }
  function percent() {
    let a = primary();
    while (isOp('%')) { p++; a = { t: 'pct', a }; }
    return a;
  }
  function unary() {
    if (isOp('-') || isOp('+')) { const op = toks[p++].v; return { t: 'un', op, a: unary() }; }
    return percent();
  }
  const power = binary(unary, ['^']);
  const mult = binary(power, ['*', '/']);
  const add = binary(mult, ['+', '-']);
  const concat = binary(add, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);

  const ast = comparison();
  if (p !== toks.length) throw new Error(`Trailing tokens in ${formula}`);
  return ast;
}

// Direct references used by a formula (for audit traces). Ranges are returned as ranges.
export function collectRefs(ast, out = []) {
  if (!ast || typeof ast !== 'object') return out;
  if (ast.t === 'ref' || ast.t === 'colrange') out.push(ast);
  for (const k of ['a', 'b']) if (ast[k] && ast[k].t) collectRefs(ast[k], out);
  if (ast.args) ast.args.forEach((x) => collectRefs(x, out));
  return out;
}
