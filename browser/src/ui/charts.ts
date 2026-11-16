// Three small line charts of the day so far, drawn as SVG by hand.

import type { Sample } from '../sim/sim';

const NS = 'http://www.w3.org/2000/svg';
type Key = 'open' | 'online' | 'busy' | 'avg_min';
interface Line {
  key: Key;
  label: string;
  color: string;
}
interface Chart {
  el: string;
  unit: string;
  digits: number;
  lines: Line[];
}
const CHARTS: Chart[] = [
  { el: 'c-open', unit: '', digits: 0, lines: [{ key: 'open', label: 'Waiting for a driver', color: '--sdl-ink' }] },
  {
    el: 'c-drivers', unit: '', digits: 0,
    lines: [
      { key: 'online', label: 'On shift', color: '--sdl-muted' },
      { key: 'busy', label: 'On a delivery', color: '--sdl-to-restaurant' },
    ],
  },
  { el: 'c-avg', unit: ' min', digits: 1, lines: [{ key: 'avg_min', label: 'Average delivery time', color: '--sdl-ink' }] },
]; // prettier-ignore

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export const fmt = (v: number | null | undefined, digits = 0): string =>
  v == null || Number.isNaN(v) ? '–' : v.toFixed(digits);

export class Charts {
  series: Sample[] = [];
  private hours = 12;
  private hoverIndex: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly find: (name: string) => HTMLElement,
    private readonly clock: (simSeconds: number) => string,
  ) {
    for (const ch of CHARTS) {
      const svg = find(ch.el);
      svg.addEventListener('pointermove', (e) => this.onMove(e as PointerEvent, ch));
      svg.addEventListener('pointerleave', () => {
        this.hoverIndex = null;
        find('tip').style.display = 'none';
        this.draw();
      });
    }
  }

  reset(hours: number): void {
    this.series = [];
    this.hours = hours;
    this.hoverIndex = null;
    this.draw();
  }

  add(samples: Sample[]): void {
    this.series.push(...samples);
    this.draw();
  }

  private geometry(svg: Element) {
    const W = svg.clientWidth || 340;
    const [H, L, R, T, B] = [86, 26, 6, 6, 16];
    const end = this.hours * 3600;
    return { W, H, L, R, T, B, end, x: (t: number) => L + (t / end) * (W - L - R) };
  }

  draw(): void {
    const css = getComputedStyle(this.root);
    const color = (name: string): string => css.getPropertyValue(name).trim();
    for (const ch of CHARTS) {
      const svg = this.find(ch.el);
      const { W, H, L, R, T, B, x } = this.geometry(svg);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.replaceChildren();
      const max = niceMax(Math.max(0, ...ch.lines.flatMap((l) => this.series.map((p) => p[l.key] ?? 0))));
      const y = (v: number): number => T + (1 - v / max) * (H - T - B);
      for (const v of [0, max / 2, max]) {
        svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: color(v === 0 ? '--sdl-axis' : '--sdl-grid'), 'stroke-width': 1 }));
        const label = svgEl('text', { x: L - 5, y: y(v) + 3.5, 'text-anchor': 'end' });
        label.textContent = String(v);
        svg.append(label);
      }
      const step = this.hours <= 6 ? 1 : this.hours <= 12 ? 2 : 4;
      for (let h = 0; h <= this.hours + 1e-9; h += step) {
        const label = svgEl('text', { x: x(h * 3600), y: H - 3, 'text-anchor': h === 0 ? 'start' : h >= this.hours ? 'end' : 'middle' });
        label.textContent = this.clock(h * 3600);
        svg.append(label);
      }
      for (const l of ch.lines) {
        const pts = this.series.filter((p) => p[l.key] != null);
        if (!pts.length) continue;
        svg.append(
          svgEl('path', {
            d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[l.key] as number).toFixed(1)}`).join(''),
            fill: 'none', stroke: color(l.color), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }), // prettier-ignore
        );
      }
      const p = this.hoverIndex === null ? undefined : this.series[this.hoverIndex];
      if (p) {
        svg.append(svgEl('line', { x1: x(p.t), x2: x(p.t), y1: T, y2: H - B, stroke: color('--sdl-ink-2'), 'stroke-width': 1 }));
        for (const l of ch.lines) {
          const v = p[l.key];
          if (v != null) svg.append(svgEl('circle', { cx: x(p.t), cy: y(v), r: 4, fill: color(l.color), stroke: color('--sdl-surface'), 'stroke-width': 2 }));
        }
      }
    }
    if (!this.find('table').hidden) this.drawTable();
  }

  private onMove(e: PointerEvent, ch: Chart): void {
    if (!this.series.length) return;
    const svg = this.find(ch.el);
    const { W, L, R, end } = this.geometry(svg);
    const box = svg.getBoundingClientRect();
    const t = ((((e.clientX - box.left) / box.width) * W - L) / (W - L - R)) * end;
    let best = 0;
    this.series.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(this.series[best].t - t)) best = i;
    });
    this.hoverIndex = best;
    this.draw();

    const p = this.series[best];
    const tip = this.find('tip');
    const head = document.createElement('div');
    head.className = 'sdl-t';
    head.textContent = this.clock(p.t);
    tip.replaceChildren(head);
    const css = getComputedStyle(this.root);
    for (const l of ch.lines) {
      const row = document.createElement('div');
      const key = document.createElement('i');
      key.className = 'sdl-key';
      key.style.borderColor = css.getPropertyValue(l.color).trim();
      const value = document.createElement('b');
      value.textContent = p[l.key] == null ? '–' : `${fmt(p[l.key], ch.digits)}${ch.unit}`;
      row.append(key, value, ` ${l.label}`);
      tip.append(row);
    }
    tip.style.display = 'block';
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - 12 - tip.offsetHeight}px`;
  }

  drawTable(): void {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['Time', 'Waiting', 'On shift', 'On delivery', 'Avg min', 'Late %']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      head.append(th);
    }
    const body = table.createTBody();
    for (const p of [...this.series].reverse()) {
      const tr = body.insertRow();
      for (const v of [this.clock(p.t), p.open, p.online, p.busy, fmt(p.avg_min, 1), fmt(p.late_pct, 0)]) {
        tr.insertCell().textContent = String(v);
      }
    }
    this.find('table').replaceChildren(table);
  }
}
