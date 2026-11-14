// Runs one simulation at a chosen speed and describes it to the page.
// The browser counterpart of server.py: no network, no DOM, so it can be
// tested in Node and run in a worker.

import { DISPATCHERS, DISPATCHER_LIST } from '../sim/dispatch';
import { TRAFFIC_CLASSES, type RoadNetwork } from '../sim/network';
import { OFFLINE, Simulation, makeConfig, type SimConfig } from '../sim/sim';
import { DAYS, type TrafficProfile } from '../sim/traffic';
import type { Command, Detail, Hello, Kpi, State } from './protocol';

export const SPEEDS = [1, 10, 30, 60, 120, 300, 900];
const MAX_STEP_S = 0.25; // a slow tick must not snowball into a bigger one

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Settings a visitor may change, cleaned up. Anything unusable keeps its old value. */
export function applyChanges(cfg: SimConfig, changes: Record<string, unknown>): SimConfig {
  const next = { ...cfg };
  const num = (key: keyof SimConfig, lo: number, hi: number, whole = false): void => {
    if (!(key in changes)) return;
    const v = Number(changes[key]);
    if (!Number.isFinite(v)) return;
    (next[key] as number) = clamp(whole ? Math.round(v) : v, lo, hi);
  };
  num('seed', 0, 2 ** 31 - 1, true);
  num('nDrivers', 1, 2000, true);
  num('peakOrdersPerHour', 1, 5000);
  num('startHour', 0, 23.5);
  num('hours', 0.5, 24);
  num('trafficScale', 0, 3);
  num('deliveryRadiusM', 300, 8000);
  if (typeof changes.startDay === 'string' && DAYS.includes(changes.startDay)) {
    next.startDay = changes.startDay;
  }
  if (typeof changes.dispatcher === 'string' && changes.dispatcher in DISPATCHERS) {
    next.dispatcher = changes.dispatcher;
  }
  return makeConfig(next);
}

export class LiveSim {
  sim: Simulation;
  generation = 0;
  playing = true;
  visible = true;
  speed = 60;
  private selected: number | null = null;
  private feedSeq = 0;
  private routeSeq = 0;
  private seriesN = 0;
  private kpiAt = -Infinity;
  private kpi: { hour: Kpi; all: Kpi } = {
    hour: { delivered: 0, placed: 0 },
    all: { delivered: 0, placed: 0 },
  };

  constructor(
    private readonly net: RoadNetwork,
    private readonly profile: TrafficProfile,
    config: Partial<SimConfig> = {},
  ) {
    this.sim = new Simulation(makeConfig(config), net, profile);
  }

  hello(): Hello {
    const sim = this.sim;
    return {
      type: 'hello',
      generation: this.generation,
      config: { ...sim.cfg },
      dispatchers: DISPATCHER_LIST,
      speeds: SPEEDS,
      trafficClasses: TRAFFIC_CLASSES,
      restaurants: sim.restaurants.map((r) => [r.id, r.lon, r.lat, r.name, Math.round(r.meanPrepS / 60)]),
    };
  }

  /** Advance the clock for `elapsedS` real seconds. */
  step(elapsedS: number): void {
    if (!this.playing || !this.visible || this.sim.finished) return;
    this.sim.runUntil(this.sim.now + this.speed * Math.min(elapsedS, MAX_STEP_S));
  }

  /** What changed since the last call, plus where everything is now. */
  state(wallMs: number): State {
    const sim = this.sim;
    if (wallMs - this.kpiAt > 500) {
      this.kpi = { hour: sim.kpis(3600), all: sim.kpis() };
      this.kpiAt = wallMs;
    }
    const drivers: State['drivers'] = [];
    for (const d of sim.drivers) {
      if (d.status === OFFLINE) continue;
      const [lon, lat] = sim.driverPosition(d);
      drivers.push([d.id, lon, lat, d.status, d.order]);
    }
    const orders: State['orders'] = [];
    for (const o of sim.active.values()) {
      orders.push([o.id, o.status, o.restaurant, o.lon, o.lat, o.placed, o.promised, o.driver]);
    }
    const routes: State['routes'] = {};
    for (const [did, version] of sim.routeVersion) {
      if (version > this.routeSeq) routes[did] = sim.drivers[did].route?.lonlat ?? null;
    }
    const msg: State = {
      type: 'state',
      generation: this.generation,
      t: sim.now,
      clock: sim.traffic.clock(sim.now),
      end: sim.endTime,
      finished: sim.finished,
      playing: this.playing,
      speed: this.speed,
      dispatcher: sim.dispatcher.name,
      traffic: sim.traffic.multipliers(sim.now),
      kpi: this.kpi,
      drivers,
      orders,
      routes,
      feed: sim.feed.filter((e) => e.seq > this.feedSeq),
      series: sim.series.slice(this.seriesN),
    };
    if (this.selected !== null && this.selected < sim.drivers.length) {
      msg.detail = this.driverDetail(this.selected);
    }
    this.feedSeq = sim.feedSeq;
    this.routeSeq = sim.routeSeq;
    this.seriesN = sim.series.length;
    return msg;
  }

  private driverDetail(did: number): Detail {
    const sim = this.sim;
    const d = sim.drivers[did];
    const o = sim.active.get(d.order);
    return {
      id: did,
      status: d.status,
      deliveries: d.deliveries,
      declines: d.declines,
      km: Math.round(d.meters / 100) / 10,
      shiftEnd: d.shiftEnd,
      order:
        o && d.status !== OFFLINE
          ? {
              id: o.id, restaurant: o.restaurant, placed: o.placed, estReady: o.estReady,
              promised: o.promised, lon: o.lon, lat: o.lat, status: o.status,
            } // prettier-ignore
          : null,
    };
  }

  /** Build a new day. Takes about a second on the Seattle network. */
  restart(changes: Record<string, unknown>): void {
    this.sim = new Simulation(applyChanges(this.sim.cfg, changes), this.net, this.profile);
    this.generation++;
    this.playing = true;
    this.selected = null;
    this.feedSeq = this.routeSeq = this.seriesN = 0;
    this.kpiAt = -Infinity;
  }

  handle(msg: Command): void {
    switch (msg.cmd) {
      case 'play':
        this.playing = Boolean(msg.on);
        break;
      case 'speed':
        if (SPEEDS.includes(msg.value)) this.speed = msg.value;
        break;
      case 'dispatcher':
        if (msg.name in DISPATCHERS) this.sim.setDispatcher(msg.name);
        break;
      case 'restart':
        this.restart(msg.config ?? {});
        break;
      case 'select':
        this.selected = Number.isInteger(msg.id) && msg.id >= 0 ? msg.id : null;
        break;
      case 'visible':
        this.visible = Boolean(msg.on);
        break;
    }
  }
}
