// Tables for the results sheet: every metric for one day, and the same day
// under each dispatcher side by side.

import { METRICS, type Metric, type Summary } from '../sim/metrics';

const GROUPS = [...new Set(METRICS.map((m) => m.group))];

function cell<K extends 'td' | 'th'>(tag: K, text: string, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function show(summary: Summary | undefined, m: Metric): string {
  const v = summary?.[m.key];
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(m.digits) : '–';
}

/** Index of the single best value, or -1 when the metric has no better direction or there is a tie. */
function best(values: (number | undefined)[], better: Metric['better']): number {
  if (!better || values.some((v) => v === undefined || !Number.isFinite(v))) return -1;
  const nums = values as number[];
  const target = better === 'low' ? Math.min(...nums) : Math.max(...nums);
  const hits = nums.flatMap((v, i) => (v === target ? [i] : []));
  return hits.length === 1 ? hits[0] : -1;
}

/**
 * One row per metric, one column per run. With several finished runs, the
 * better value in each row is marked (in bold, and named for screen readers).
 */
export function resultsTable(columns: string[], summaries: (Summary | undefined)[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'sdl-results';
  const head = table.createTHead().insertRow();
  head.append(cell('th', 'Metric'));
  for (const label of columns) {
    const th = cell('th', label);
    th.scope = 'col';
    head.append(th);
  }
  const compare = summaries.length > 1 && summaries.every(Boolean);
  const body = table.createTBody();
  for (const group of GROUPS) {
    const row = body.insertRow();
    const th = cell('th', group, 'sdl-group');
    th.colSpan = columns.length + 1;
    th.scope = 'colgroup';
    row.append(th);
    for (const m of METRICS.filter((x) => x.group === group)) {
      const tr = body.insertRow();
      const name = cell('th', m.label);
      name.scope = 'row';
      tr.append(name);
      const winner = compare ? best(summaries.map((s) => s?.[m.key] as number | undefined), m.better) : -1;
      summaries.forEach((s, i) => {
        const td = cell('td', s ? show(s, m) : '…', i === winner ? 'sdl-best' : undefined);
        if (i === winner) {
          const note = document.createElement('span');
          note.className = 'sdl-sr';
          note.textContent = ' (best)';
          td.append(note);
        }
        tr.append(td);
      });
    }
  }
  return table;
}
