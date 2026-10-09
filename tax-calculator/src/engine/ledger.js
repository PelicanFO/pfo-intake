// The audit trail. Every number the engine produces is written here as a line with a label,
// the arithmetic that produced it, and where the rule comes from.

export const money = (x) => {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  const r = Math.round(x);
  return (r < 0 ? '−$' : '$') + String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
export const pct = (x, digits = 1) => `${(x * 100).toFixed(digits).replace(/\.0+$/, '')}%`;

export class Ledger {
  constructor(title) {
    this.title = title;
    this.sections = [];
    this.current = null;
  }
  section(title, note) {
    this.current = { title, note, lines: [] };
    this.sections.push(this.current);
    return this;
  }
  /**
   * @param {string} label   what this number is
   * @param {number} amount  the value
   * @param {object} [opts]  { calc: 'how it was computed', source: 'IRC §…', kind: 'input'|'calc'|'total'|'info'|'warn', excel: 'Sheet!A1' }
   */
  line(label, amount, opts = {}) {
    if (!this.current) this.section('');
    const entry = { label, amount, ...opts };
    this.current.lines.push(entry);
    return amount;
  }
  note(text, kind = 'info') {
    if (!this.current) this.section('');
    this.current.lines.push({ label: text, amount: null, kind });
  }
  append(other, prefix) {
    for (const s of other.sections) this.sections.push({ ...s, title: prefix ? `${prefix} · ${s.title}` : s.title });
    return this;
  }
  toRows() {
    const rows = [];
    for (const s of this.sections) {
      rows.push({ section: s.title });
      for (const l of s.lines) rows.push({ section: s.title, ...l });
    }
    return rows;
  }
  toCSV() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const out = [['Section', 'Line', 'Amount', 'Calculation', 'Source'].map(esc).join(',')];
    for (const s of this.sections) for (const l of s.lines) {
      out.push([s.title, l.label, l.amount === null || l.amount === undefined ? '' : Math.round(l.amount * 100) / 100, l.calc || '', l.source || l.excel || ''].map(esc).join(','));
    }
    return out.join('\n');
  }
}
