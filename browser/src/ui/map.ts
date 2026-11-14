// The map, drawn on two canvases with no map library and no tiles: streets
// underneath (redrawn only when the view, theme or traffic changes) and the
// moving things on top (redrawn every frame).

import type { RoadNetwork } from '../sim/network';
import type { Hello, State } from '../live/protocol';

export type Hit =
  | { kind: 'driver'; id: number; status: number; order: number }
  | { kind: 'order'; id: number; status: number; promised: number; late: boolean }
  | { kind: 'restaurant'; id: number; name: string; prep: number };

export interface MapHooks {
  onSelect(id: number | null): void;
  describe(hit: Hit): string;
}

export interface Focus {
  restaurant: [lon: number, lat: number];
  customer: [lon: number, lat: number];
}

interface DriverDot {
  from: [number, number];
  to: [number, number];
  at: [number, number];
  t0: number;
  status: number;
  order: number;
}

const FREEWAY_CLASSES = 7; // classes 0-6 are freeways; 7 is main streets, 8 side streets
const GLIDE_MS = 110; // a little longer than the gap between snapshots
// Slowdown -> colour on one red ramp. The severe end is the one that stands out
// from the map: darkest on the light map, brightest on the dark one.
const RAMP_LIGHT: [number, number[]][] = [[1.0, [176, 174, 168]], [1.25, [241, 185, 179]], [2.0, [208, 59, 59]], [3.2, [125, 23, 23]]]; // prettier-ignore
const RAMP_DARK: [number, number[]][] = [[1.0, [70, 68, 66]], [1.25, [112, 38, 38]], [2.0, [208, 59, 59]], [3.2, [255, 170, 160]]]; // prettier-ignore

export class MapView {
  private readonly base: HTMLCanvasElement;
  private readonly top: HTMLCanvasElement;
  private readonly hover: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];

  private lonC = 0;
  private latC = 0;
  private kx = 1;
  private ky = 1;
  private worldW = 1;
  private worldH = 1;
  private local: Path2D | null = null;
  private major: Path2D | null = null;
  private freeways: Path2D[] = [];

  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 0.02; // pixels per meter
  private cx = 0; // view centre, meters from the middle of the city
  private cy = 0;
  private userMoved = false;

  private restaurants: { id: number; x: number; y: number; name: string; prep: number }[] = [];
  private readonly drivers = new Map<number, DriverDot>();
  private orders: { id: number; status: number; x: number; y: number; promised: number; late: boolean }[] = [];
  private readonly routes = new Map<number, Float32Array>();
  private traffic: number[] = [];
  private selected: number | null = null;
  private focus: Focus | null = null;

  private colors = {
    map: '#f1f0ec', street: '#ddd', major: '#bbb', ink: '#000', surface: '#fff', muted: '#888',
    critical: '#d03b3b', status: [] as string[], dark: false,
  }; // prettier-ignore
  private baseDirty = true;
  private active = false;
  private raf = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragged = 0;

  constructor(
    private readonly root: HTMLElement,
    container: HTMLElement,
    private readonly hooks: MapHooks,
    private readonly wheelZoom: 'always' | 'modifier',
  ) {
    this.base = container.querySelector('[data-el="base"]') as HTMLCanvasElement;
    this.top = container.querySelector('[data-el="top"]') as HTMLCanvasElement;
    this.hover = container.querySelector('[data-el="hover"]') as HTMLElement;
    this.refreshColors();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.listen();
  }

  // ------------------------------------------------------------------ data

  setNetwork(net: RoadNetwork): void {
    const [lon0, lat0, lon1, lat1] = net.bounds;
    this.lonC = (lon0 + lon1) / 2;
    this.latC = (lat0 + lat1) / 2;
    this.kx = net.kx;
    this.ky = net.ky;
    this.worldW = (lon1 - lon0) * net.kx;
    this.worldH = (lat1 - lat0) * net.ky;

    // A two-way street is stored once per direction; draw it once.
    const seen = new Set<number>();
    for (let e = 0; e < net.nEdges; e++) seen.add(net.edgeU[e] * 65536 + net.edgeV[e]);
    this.local = new Path2D();
    this.major = new Path2D();
    this.freeways = Array.from({ length: FREEWAY_CLASSES }, () => new Path2D());
    for (let e = 0; e < net.nEdges; e++) {
      const u = net.edgeU[e];
      const v = net.edgeV[e];
      if (u > v && seen.has(v * 65536 + u)) continue;
      const cls = net.edgeClass[e];
      const path = cls < FREEWAY_CLASSES ? this.freeways[cls] : cls === FREEWAY_CLASSES ? this.major : this.local;
      for (let p = net.geomOff[e]; p < net.geomOff[e + 1]; p++) {
        const x = (net.geomXY[2 * p] - this.lonC) * this.kx;
        const y = -(net.geomXY[2 * p + 1] - this.latC) * this.ky;
        if (p === net.geomOff[e]) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    }
    this.fit();
  }

  setWorld(hello: Hello): void {
    this.restaurants = hello.restaurants.map(([id, lon, lat, name, prep]) => {
      const [x, y] = this.project(lon, lat);
      return { id, x, y, name, prep };
    });
    this.drivers.clear();
    this.routes.clear();
    this.orders = [];
    this.selected = null;
    this.focus = null;
    this.baseDirty = true;
  }

  setState(s: State): void {
    const t0 = performance.now();
    const seen = new Set<number>();
    for (const [id, lon, lat, status, order] of s.drivers) {
      seen.add(id);
      const to = this.project(lon, lat);
      const d = this.drivers.get(id);
      if (d) {
        d.from = d.at;
        d.to = to;
        d.t0 = t0;
        d.status = status;
        d.order = order;
      } else {
        this.drivers.set(id, { from: to, to, at: to, t0, status, order });
      }
    }
    for (const id of this.drivers.keys()) {
      if (!seen.has(id)) {
        this.drivers.delete(id);
        this.routes.delete(id);
      }
    }
    for (const [key, lonlat] of Object.entries(s.routes)) {
      const id = Number(key);
      if (!lonlat) {
        this.routes.delete(id);
        continue;
      }
      const xy = new Float32Array(lonlat.length);
      for (let i = 0; i < lonlat.length; i += 2) {
        xy[i] = (lonlat[i] - this.lonC) * this.kx;
        xy[i + 1] = -(lonlat[i + 1] - this.latC) * this.ky;
      }
      this.routes.set(id, xy);
    }
    this.orders = s.orders.map(([id, status, , lon, lat, , promised]) => {
      const [x, y] = this.project(lon, lat);
      return { id, status, x, y, promised, late: s.t > promised };
    });
    if (s.traffic.some((m, i) => Math.abs(m - (this.traffic[i] ?? 0)) > 0.005)) {
      this.traffic = s.traffic;
      this.baseDirty = true;
    }
  }

  setSelection(id: number | null, focus: Focus | null): void {
    this.selected = id;
    this.focus = focus;
  }

  /** Stop drawing while the widget is off screen. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.raf = requestAnimationFrame(this.frame);
    else cancelAnimationFrame(this.raf);
  }

  /** Re-read the colours after the page's theme changed. */
  refreshColors(): void {
    const style = getComputedStyle(this.root);
    const v = (name: string): string => style.getPropertyValue(name).trim();
    const idle = v('--sdl-idle');
    this.colors = {
      map: v('--sdl-map'), street: v('--sdl-street'), major: v('--sdl-street-major'),
      ink: v('--sdl-ink'), surface: v('--sdl-surface'), muted: v('--sdl-muted'),
      critical: v('--sdl-critical'),
      status: [idle, idle, idle, v('--sdl-to-restaurant'), v('--sdl-at-restaurant'), v('--sdl-delivering'), v('--sdl-delivering')],
      dark: luminance(v('--sdl-map')) < 0.4,
    }; // prettier-ignore
    this.baseDirty = true;
  }

  get rampCss(): { gradient: string; label: string } {
    const ramp = this.colors.dark ? RAMP_DARK : RAMP_LIGHT;
    return {
      gradient: `linear-gradient(90deg, ${ramp.slice(1).map((s) => `rgb(${s[1]})`).join(', ')})`,
      label: `Freeway slowdown (${this.colors.dark ? 'brighter' : 'darker'} = slower)`,
    };
  }

  destroy(): void {
    this.setActive(false);
    this.observer.disconnect();
    for (const undo of this.cleanup) undo();
  }

  // ------------------------------------------------------------------ view

  private project(lon: number, lat: number): [number, number] {
    return [(lon - this.lonC) * this.kx, -(lat - this.latC) * this.ky];
  }

  private fitScale(): number {
    return Math.min((this.w - 24) / this.worldW, (this.h - 24) / this.worldH);
  }

  /** Show the whole city. */
  fit(): void {
    if (this.w === 0 || this.h === 0) return;
    this.scale = Math.max(this.fitScale(), 1e-4);
    this.cx = this.cy = 0;
    this.userMoved = false;
    this.baseDirty = true;
  }

  zoomBy(factor: number, sx = this.w / 2, sy = this.h / 2): void {
    const min = this.fitScale() * 0.8;
    const next = Math.min(Math.max(this.scale * factor, min), 1.5);
    const wx = this.cx + (sx - this.w / 2) / this.scale;
    const wy = this.cy + (sy - this.h / 2) / this.scale;
    this.scale = next;
    this.cx = wx - (sx - this.w / 2) / next;
    this.cy = wy - (sy - this.h / 2) / next;
    this.userMoved = true;
    this.clampCentre();
    this.baseDirty = true;
  }

  private clampCentre(): void {
    this.cx = Math.min(Math.max(this.cx, -this.worldW / 2), this.worldW / 2);
    this.cy = Math.min(Math.max(this.cy, -this.worldH / 2), this.worldH / 2);
  }

  private resize(): void {
    const box = this.top.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    this.w = box.width;
    this.h = box.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.base, this.top]) {
      canvas.width = Math.round(this.w * this.dpr);
      canvas.height = Math.round(this.h * this.dpr);
    }
    // Keep the whole city in view until the visitor pans or zooms for themselves.
    if (!this.userMoved) this.fit();
    this.baseDirty = true;
    if (!this.active) this.draw(performance.now());
  }

  // --------------------------------------------------------------- drawing

  private frame = (now: number): void => {
    this.draw(now);
    if (this.active) this.raf = requestAnimationFrame(this.frame);
  };

  private toView(ctx: CanvasRenderingContext2D): void {
    const s = this.dpr * this.scale;
    ctx.setTransform(s, 0, 0, s, this.dpr * (this.w / 2 - this.cx * this.scale), this.dpr * (this.h / 2 - this.cy * this.scale));
  }

  private slowColor(x: number): string {
    const stops = this.colors.dark ? RAMP_DARK : RAMP_LIGHT;
    if (!(x > stops[0][0])) return `rgb(${stops[0][1]})`;
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        const f = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
        return `rgb(${stops[i][1].map((v, k) => Math.round(stops[i - 1][1][k] + f * (v - stops[i - 1][1][k])))})`;
      }
    }
    return `rgb(${stops[stops.length - 1][1]})`;
  }

  private drawBase(): void {
    const ctx = this.base.getContext('2d');
    if (!ctx) return;
    const c = this.colors;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.map;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    if (!this.local || !this.major) return;
    // How far in the view is zoomed, 0 (whole city) to 1 (a few blocks).
    const zoom = Math.min(Math.max(Math.log2(this.scale / 0.02) / 5, 0), 1);
    this.toView(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = c.street;
    ctx.lineWidth = (0.6 + 1.4 * zoom) / this.scale;
    ctx.stroke(this.local);
    ctx.strokeStyle = c.major;
    ctx.lineWidth = (0.9 + 2.6 * zoom) / this.scale;
    ctx.stroke(this.major);
    ctx.lineWidth = (1.8 + 4 * zoom) / this.scale;
    this.freeways.forEach((path, cls) => {
      ctx.strokeStyle = this.slowColor(this.traffic[cls] ?? 1);
      ctx.stroke(path);
    });
    ctx.fillStyle = c.muted;
    ctx.globalAlpha = 0.8;
    const r = (1.5 + 2.5 * zoom) / this.scale;
    ctx.beginPath();
    for (const p of this.restaurants) {
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private draw(now: number): void {
    if (this.baseDirty) {
      this.drawBase();
      this.baseDirty = false;
    }
    const ctx = this.top.getContext('2d');
    if (!ctx) return;
    const c = this.colors;
    const px = 1 / this.scale; // one screen pixel, in meters
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);
    this.toView(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Routes in progress, faint, coloured by what the driver is doing.
    ctx.lineWidth = 1.5 * px;
    ctx.globalAlpha = 0.3;
    for (const [id, xy] of this.routes) {
      if (id === this.selected) continue;
      ctx.strokeStyle = c.status[this.drivers.get(id)?.status ?? 3] ?? c.muted;
      this.strokeLine(ctx, xy);
    }
    ctx.globalAlpha = 1;

    // Customers waiting: a ring, filled red once the promised time has passed.
    for (const o of this.orders) {
      ctx.beginPath();
      ctx.arc(o.x, o.y, 4.5 * px, 0, 2 * Math.PI);
      if (o.late) {
        ctx.fillStyle = c.critical;
        ctx.fill();
      }
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = o.late ? c.critical : c.ink;
      ctx.stroke();
    }

    // The selected driver's route, restaurant and customer.
    if (this.selected !== null) {
      const route = this.routes.get(this.selected);
      if (route) {
        ctx.lineWidth = 3.5 * px;
        ctx.strokeStyle = c.ink;
        ctx.globalAlpha = 0.9;
        this.strokeLine(ctx, route);
        ctx.globalAlpha = 1;
      }
      if (this.focus) {
        ctx.lineWidth = 2.5 * px;
        ctx.strokeStyle = c.ink;
        for (const [lon, lat] of [this.focus.restaurant, this.focus.customer]) {
          const [x, y] = this.project(lon, lat);
          ctx.beginPath();
          ctx.arc(x, y, 8 * px, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
    }

    // Drivers, gliding from where they were drawn to where they are now.
    for (const [id, d] of this.drivers) {
      const f = Math.min(1, (now - d.t0) / GLIDE_MS);
      d.at = [d.from[0] + f * (d.to[0] - d.from[0]), d.from[1] + f * (d.to[1] - d.from[1])];
      const r = (id === this.selected ? 8 : 5.5) * px;
      ctx.beginPath();
      ctx.arc(d.at[0], d.at[1], r, 0, 2 * Math.PI);
      ctx.fillStyle = c.status[d.status] ?? c.muted;
      ctx.fill();
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = c.surface;
      ctx.stroke();
    }
  }

  private strokeLine(ctx: CanvasRenderingContext2D, xy: Float32Array): void {
    ctx.beginPath();
    ctx.moveTo(xy[0], xy[1]);
    for (let i = 2; i < xy.length; i += 2) ctx.lineTo(xy[i], xy[i + 1]);
    ctx.stroke();
  }

  // ----------------------------------------------------------- interaction

  /** What is under a point on screen: a driver first, then a customer, then a restaurant. */
  private hit(sx: number, sy: number): Hit | null {
    const x = this.cx + (sx - this.w / 2) / this.scale;
    const y = this.cy + (sy - this.h / 2) / this.scale;
    const within = (px: number, py: number, pixels: number): number => {
      const d = Math.hypot(px - x, py - y) * this.scale;
      return d <= pixels ? d : Infinity;
    };
    let best: Hit | null = null;
    let bestD = Infinity;
    for (const [id, d] of this.drivers) {
      const dist = within(d.at[0], d.at[1], 9);
      if (dist < bestD) [best, bestD] = [{ kind: 'driver', id, status: d.status, order: d.order }, dist];
    }
    if (best) return best;
    for (const o of this.orders) {
      const dist = within(o.x, o.y, 8);
      if (dist < bestD) [best, bestD] = [{ kind: 'order', id: o.id, status: o.status, promised: o.promised, late: o.late }, dist];
    }
    if (best) return best;
    for (const r of this.restaurants) {
      const dist = within(r.x, r.y, 6);
      if (dist < bestD) [best, bestD] = [{ kind: 'restaurant', id: r.id, name: r.name, prep: r.prep }, dist];
    }
    return best;
  }

  private on<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.top.addEventListener(type, handler, options);
    this.cleanup.push(() => this.top.removeEventListener(type, handler, options));
  }

  private at(e: MouseEvent): [number, number] {
    const box = this.top.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  }

  private showHover(e: PointerEvent): void {
    const [sx, sy] = this.at(e);
    const hit = this.hit(sx, sy);
    this.top.classList.toggle('sdl-pointing', hit !== null);
    if (!hit) {
      this.hover.style.display = 'none';
      return;
    }
    this.hover.textContent = this.hooks.describe(hit);
    this.hover.style.display = 'block';
    const width = this.hover.offsetWidth;
    this.hover.style.left = `${Math.min(Math.max(sx + 12, 4), this.w - width - 4)}px`;
    this.hover.style.top = `${Math.max(sy - 34, 4)}px`;
  }

  private listen(): void {
    this.on('pointerdown', (e) => {
      this.top.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragged = 0;
      this.hover.style.display = 'none';
    });
    this.on('pointermove', (e) => {
      const was = this.pointers.get(e.pointerId);
      if (!was) {
        if (e.pointerType === 'mouse') this.showHover(e);
        return;
      }
      const dx = e.clientX - was.x;
      const dy = e.clientY - was.y;
      if (this.pointers.size === 2) {
        // Two fingers: the gap between them sets the zoom, their middle the pan.
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
        const before = Math.hypot(was.x - other.x, was.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        const box = this.top.getBoundingClientRect();
        if (before > 0) this.zoomBy(after / before, (e.clientX + other.x) / 2 - box.left, (e.clientY + other.y) / 2 - box.top);
        this.cx -= dx / 2 / this.scale;
        this.cy -= dy / 2 / this.scale;
      } else {
        this.cx -= dx / this.scale;
        this.cy -= dy / this.scale;
      }
      this.dragged += Math.abs(dx) + Math.abs(dy);
      if (this.dragged > 4) {
        this.userMoved = true;
        this.top.classList.add('sdl-dragging');
      }
      this.clampCentre();
      this.baseDirty = true;
      was.x = e.clientX;
      was.y = e.clientY;
    });
    const end = (e: PointerEvent): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.top.classList.remove('sdl-dragging');
      if (e.type === 'pointerup' && this.pointers.size === 0 && this.dragged <= 4) {
        const hit = this.hit(...this.at(e));
        this.hooks.onSelect(hit?.kind === 'driver' ? hit.id : null);
      }
    };
    this.on('pointerup', end);
    this.on('pointercancel', end);
    this.on('pointerleave', () => {
      this.hover.style.display = 'none';
    });
    this.on('dblclick', (e) => this.zoomBy(1.8, ...this.at(e)));
    this.on(
      'wheel',
      (e) => {
        // Inside an article a plain scroll should move the page, not the map.
        if (this.wheelZoom !== 'always' && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomBy(Math.exp(-step * (e.ctrlKey ? 0.01 : 0.0018)), ...this.at(e));
      },
      { passive: false },
    );
  }
}

/** Rough brightness (0 dark to 1 light) of any CSS colour. */
function luminance(color: string): number {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = color || '#fff';
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
