// The simulated world: restaurants, customers, drivers, and a clock.
// A port of sim.py (car couriers only).
//
// The engine is event-driven. Things that happen at a known future time (an
// order is placed, a driver arrives, the dispatcher wakes up) sit in a priority
// queue; runUntil(t) pops and handles them in order. Driver positions between
// events are interpolated along their route.
//
// Everything the dispatcher is *not* told (true food-ready times, true drive
// times, who will decline) is decided here. The dispatcher only gets estimates.

import {
  DISPATCHERS, DROPOFF_OVERHEAD_S, type DispatchView, type Dispatcher,
} from './dispatch'; // prettier-ignore
import { summarize, type Summary } from './metrics';
import { restaurantNames } from './names';
import { CLASS_ID, type RoadNetwork, type Route } from './network';
import { Rng, cumulative } from './rng';
import { DAYS, Traffic, type TrafficProfile } from './traffic';

// Driver states
export const OFFLINE = 0, IDLE = 1, OFFERED = 2, TO_RESTAURANT = 3, AT_RESTAURANT = 4,
  TO_CUSTOMER = 5, AT_DOOR = 6; // prettier-ignore
// Order states
export const OPEN = 0, O_OFFERED = 1, ASSIGNED = 2, COLLECTING = 3, EN_ROUTE = 4, DELIVERED = 5; // prettier-ignore

export interface SimConfig {
  seed: number;
  startDay: string;
  startHour: number;
  hours: number;
  nRestaurants: number;
  nDrivers: number;
  peakOrdersPerHour: number;
  deliveryRadiusM: number;
  promiseSlackMin: number;
  trafficScale: number;
  dispatcher: string;
  /** How early matching_jit is willing to send a driver. */
  jitBufferS: number;
  /** Hand the dispatcher the true food-ready times. */
  knowPrep: boolean;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 7,
  startDay: 'Fri',
  startHour: 10,
  hours: 12,
  nRestaurants: 250,
  nDrivers: 220,
  peakOrdersPerHour: 400,
  deliveryRadiusM: 4500,
  promiseSlackMin: 10,
  trafficScale: 1,
  dispatcher: 'matching_jit',
  jitBufferS: 240,
  knowPrep: false,
};

export function makeConfig(changes: Partial<SimConfig> = {}): SimConfig {
  const cfg = { ...DEFAULT_CONFIG, ...changes };
  cfg.hours = Math.min(Math.max(cfg.hours, 0.5), 24);
  if (!DAYS.includes(cfg.startDay)) throw new Error(`startDay must be one of ${DAYS.join(', ')}`);
  if (!(cfg.dispatcher in DISPATCHERS)) throw new Error(`unknown dispatcher "${cfg.dispatcher}"`);
  return cfg;
}

export interface Restaurant {
  id: number;
  name: string;
  node: number;
  lon: number;
  lat: number;
  /** The dispatcher knows this average, not each order's draw. */
  meanPrepS: number;
}

export interface Order {
  id: number;
  restaurant: number;
  customerNode: number;
  lon: number;
  lat: number;
  placed: number;
  /** Truth, hidden from the dispatcher. */
  ready: number;
  estReady: number;
  promised: number;
  /** Free-flow drive restaurant -> customer. */
  dropoffFfS: number;
  pickupOverheadS: number;
  dropoffOverheadS: number;
  status: number;
  driver: number;
  declined: Set<number>;
  offers: number;
  assigned: number;
  atRestaurant: number;
  pickedUp: number;
  delivered: number;
  estPickupDrive: number;
  truePickupDrive: number;
  estDropoffDrive: number;
  trueDropoffDrive: number;
}

export interface Driver {
  id: number;
  node: number;
  shiftStart: number;
  shiftEnd: number;
  acceptBase: number;
  status: number;
  order: number;
  route: Route | null;
  leaving: boolean;
  since: number;
  /** Seconds spent in each state. */
  seconds: number[];
  deliveries: number;
  declines: number;
  meters: number;
}

export interface Sample {
  t: number;
  open: number;
  active: number;
  online: number;
  busy: number;
  avg_min: number | null;
  late_pct: number | null;
}

export interface FeedItem {
  seq: number;
  t: number;
  kind: string;
  text: string;
  order: number;
  driver: number;
}

/** A world built elsewhere (by the Python simulator), for replaying in tests. */
export interface WorldData {
  restaurants: [node: number, name: string, meanPrepS: number][];
  /** restaurant, customer_node, placed, ready, est_ready, promised, dropoff_ff_s, pickup_overhead_s, dropoff_overhead_s */
  orders: number[][];
  /** node, shift_start, shift_end, accept_base */
  drivers: number[][];
}

/** The random stream for what drivers do: how long they take to answer, and whether they say yes. */
export interface Behaviour {
  uniform(low: number, high: number): number;
  random(): number;
}

export interface SimOptions {
  world?: WorldData;
  behaviour?: Behaviour;
}

type EventKind =
  | 'order' | 'shift_start' | 'shift_end' | 'sample' | 'dispatch' | 'reply'
  | 'arrive_restaurant' | 'pickup' | 'arrive_customer' | 'delivered'; // prettier-ignore

interface Event {
  t: number;
  seq: number;
  kind: EventKind;
  /** A driver id, or an order for "order" events. */
  arg: number | Order;
  order: number;
  est: number;
}

/** Relative order rate by hour of day, peaking at 1.0 around dinner. */
export function demandShape(hour: number): number {
  hour = hour % 24;
  const lunch = 0.55 * Math.exp(-0.5 * ((hour - 12.3) / 0.9) ** 2);
  const dinner = 1.0 * Math.exp(-0.5 * ((hour - 18.7) / 1.3) ** 2);
  const base = hour >= 8 && hour <= 23 ? 0.1 : 0.03;
  return (base + lunch + dinner) / 1.1;
}

export class Simulation {
  readonly cfg: SimConfig;
  readonly endTime: number;
  readonly traffic: Traffic;
  dispatcher: Dispatcher;
  now = 0;

  restaurants: Restaurant[] = [];
  drivers: Driver[] = [];
  readonly done: Order[] = [];
  readonly active = new Map<number, Order>();
  readonly series: Sample[] = [];
  readonly feed: FeedItem[] = [];
  feedSeq = 0;
  routeSeq = 0;
  readonly routeVersion = new Map<number, number>();
  nPlaced = 0;
  nOffers = 0;
  nDeclines = 0;
  nScheduled = 0;

  /** Free-flow seconds from every node to each restaurant, one row per restaurant. */
  private ffToRest: Float32Array[] = [];
  /** Free-flow seconds from each restaurant to every node (only for browser-built worlds). */
  private ffFromRest: Float32Array[] = [];
  private readonly events: Event[] = [];
  private seq = 0;
  private graphSlot = -1;
  private readonly graph: Float64Array;
  private readonly behave: Behaviour;

  constructor(
    cfg: SimConfig,
    readonly net: RoadNetwork,
    profile: TrafficProfile,
    options: SimOptions = {},
  ) {
    this.cfg = { ...cfg };
    this.endTime = cfg.hours * 3600.0;
    const weekOffset = DAYS.indexOf(cfg.startDay) * 86400 + cfg.startHour * 3600;
    this.traffic = new Traffic(weekOffset, profile, cfg.trafficScale);
    this.dispatcher = this.makeDispatcher(cfg.dispatcher);
    this.graph = new Float64Array(net.nEdges);

    // Two random streams: the world (identical across dispatchers for a given
    // seed, so comparisons are like-for-like) and driver behaviour.
    this.behave = options.behaviour ?? new Rng(cfg.seed + 10_000);
    if (options.world) {
      this.loadWorld(options.world);
    } else {
      const world = new Rng(cfg.seed);
      this.buildRestaurants(world);
      this.buildOrders(world);
      this.buildDrivers(world);
    }
    this.push(0.0, 'dispatch', -1);
    this.push(0.0, 'sample', -1);
  }

  // ------------------------------------------------------------------ setup

  private addRestaurant(node: number, name: string, meanPrepS: number): void {
    const id = this.restaurants.length;
    const lon = this.net.nodeLon[node];
    const lat = this.net.nodeLat[node];
    this.restaurants.push({ id, name, node, lon, lat, meanPrepS });
  }

  /**
   * Free-flow drive times to (and, when the world is built here, from) every
   * restaurant. The dispatcher's travel-time estimate is this free-flow time
   * scaled by one city-wide congestion factor: right on average, wrong in detail.
   */
  private buildEstimator(alsoFrom: boolean): void {
    const net = this.net;
    for (const r of this.restaurants) {
      const to = new Float32Array(net.nNodes);
      net.timesTo(net.edgeTime, r.node, to);
      this.ffToRest.push(to);
      if (alsoFrom) {
        const from = new Float32Array(net.nNodes);
        net.timesFrom(net.edgeTime, r.node, from);
        this.ffFromRest.push(from);
      }
    }
  }

  private newOrder(
    id: number, restaurant: number, customerNode: number, placed: number, ready: number,
    estReady: number, promised: number, dropoffFfS: number, pickupOverheadS: number,
    dropoffOverheadS: number,
  ): Order { // prettier-ignore
    return {
      id, restaurant, customerNode, placed, ready, estReady, promised, dropoffFfS,
      pickupOverheadS, dropoffOverheadS,
      lon: this.net.nodeLon[customerNode], lat: this.net.nodeLat[customerNode],
      status: OPEN, driver: -1, declined: new Set(), offers: 0,
      assigned: NaN, atRestaurant: NaN, pickedUp: NaN, delivered: NaN,
      estPickupDrive: NaN, truePickupDrive: NaN, estDropoffDrive: NaN, trueDropoffDrive: NaN,
    }; // prettier-ignore
  }

  private addDriver(node: number, shiftStart: number, shiftEnd: number, acceptBase: number): void {
    const id = this.drivers.length;
    this.drivers.push({
      id, node, shiftStart, shiftEnd, acceptBase, status: OFFLINE, order: -1, route: null,
      leaving: false, since: 0, seconds: [0, 0, 0, 0, 0, 0, 0], deliveries: 0, declines: 0,
      meters: 0,
    }); // prettier-ignore
    if (shiftEnd > 0) {
      this.push(Math.max(shiftStart, 0.0), 'shift_start', id);
      this.push(shiftEnd, 'shift_end', id);
    }
  }

  private loadWorld(world: WorldData): void {
    for (const [node, name, prep] of world.restaurants) this.addRestaurant(node, name, prep);
    this.buildEstimator(false);
    world.orders.forEach((o, id) => {
      const order = this.newOrder(id, o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7], o[8]);
      this.push(order.placed, 'order', order);
    });
    this.nScheduled = world.orders.length;
    for (const d of world.drivers) this.addDriver(d[0], d[1], d[2], d[3]);
  }

  private popularity: Float64Array = new Float64Array(0);

  private buildRestaurants(rng: Rng): void {
    const net = this.net;
    const n = Math.min(this.cfg.nRestaurants, net.venueNodes.length);
    const pick = rng.sample(net.venueNodes.length, n);
    const names = restaurantNames(n, rng);
    for (let i = 0; i < n; i++) {
      this.addRestaurant(net.venueNodes[pick[i]], names[i], rng.uniform(8, 22) * 60);
    }
    // A few restaurants get most of the orders, as in real life.
    this.popularity = cumulative(Array.from({ length: n }, () => rng.lognormal(0.0, 0.8)));
    this.buildEstimator(true);
  }

  private buildOrders(rng: Rng): void {
    const { cfg, net } = this;
    const peakPerS = cfg.peakOrdersPerHour / 3600.0;
    const residential = new Uint8Array(net.nNodes);
    for (const i of net.residentialNodes) residential[i] = 1;
    // Customers a restaurant can deliver to, with closer ones more likely
    // (most orders are short hops). Worked out once per restaurant.
    const reach = new Map<number, { near: Int32Array; weights: Float64Array }>();
    const reachOf = (r: number) => {
      let hit = reach.get(r);
      if (!hit) {
        const rest = this.restaurants[r];
        const from = this.ffFromRest[r];
        const near = net
          .nodesWithin(rest.node, cfg.deliveryRadiusM)
          .filter((i) => residential[i] === 1 && Number.isFinite(from[i]));
        const weights = cumulative(
          Array.from(near, (i) =>
            Math.exp(
              -Math.hypot(net.nodeX[i] - net.nodeX[rest.node], net.nodeY[i] - net.nodeY[rest.node]) /
                2200.0,
            ),
          ),
        );
        hit = { near, weights };
        reach.set(r, hit);
      }
      return hit;
    };

    // Arrivals at a rate that changes over the day, by thinning.
    let t = 0.0;
    let oid = 0;
    for (;;) {
      t += rng.exponential(1.0 / peakPerS);
      if (t >= this.endTime) break;
      const hour = cfg.startHour + t / 3600.0;
      if (rng.random() > demandShape(hour)) continue;
      const r = rng.pick(this.popularity);
      const rest = this.restaurants[r];
      const { near, weights } = reachOf(r);
      if (near.length === 0) continue;
      const c = near[rng.pick(weights)];
      const prep = rng.lognormal(Math.log(rest.meanPrepS) - 0.06, 0.35);
      const driveFf = this.ffFromRest[r][c];
      const estReady = t + rest.meanPrepS;
      const promised =
        estReady + driveFf * this.estFactor(t) + DROPOFF_OVERHEAD_S + cfg.promiseSlackMin * 60;
      const order = this.newOrder(
        oid, r, c, t, t + prep, estReady, promised, driveFf,
        rng.uniform(60, 180), rng.uniform(60, 150),
      ); // prettier-ignore
      this.push(t, 'order', order);
      oid++;
    }
    this.nScheduled = oid;
  }

  private buildDrivers(rng: Rng): void {
    const { cfg, net } = this;
    const kinds = cumulative([0.3, 0.45, 0.25]); // lunch, dinner, all day
    for (let i = 0; i < cfg.nDrivers; i++) {
      const kind = rng.pick(kinds);
      let start: number;
      let length: number;
      if (kind === 0) [start, length] = [rng.normal(10.75, 0.4), rng.uniform(3.0, 4.5)];
      else if (kind === 1) [start, length] = [rng.normal(16.5, 0.5), rng.uniform(4.0, 5.5)];
      else [start, length] = [rng.normal(10.5, 0.5), rng.uniform(9.0, 11.0)];
      const s = (start - cfg.startHour) * 3600.0;
      const e = s + length * 3600.0;
      // Drivers start their shift somewhere near a restaurant.
      const anchor = this.restaurants[rng.integers(this.restaurants.length)].node;
      const near = net.nodesWithin(anchor, 1200.0).filter((n) => Number.isFinite(this.ffToRest[0][n]));
      const node = near.length ? near[rng.integers(near.length)] : anchor;
      this.addDriver(node, s, e, rng.uniform(0.82, 0.98));
    }
  }

  // ------------------------------------------------------------- event loop

  private push(t: number, kind: EventKind, arg: number | Order, order = -1, est = 0): void {
    const ev: Event = { t, seq: ++this.seq, kind, arg, order, est };
    const heap = this.events;
    let i = heap.length;
    heap.push(ev);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent];
      if (p.t < t || (p.t === t && p.seq < ev.seq)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = ev;
  }

  private pop(): Event {
    const heap = this.events;
    const top = heap[0];
    const last = heap.pop() as Event;
    const n = heap.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        const right = child + 1;
        if (right < n) {
          const a = heap[child];
          const b = heap[right];
          if (b.t < a.t || (b.t === a.t && b.seq < a.seq)) child = right;
        }
        const c = heap[child];
        if (last.t < c.t || (last.t === c.t && last.seq < c.seq)) break;
        heap[i] = c;
        i = child;
      }
      heap[i] = last;
    }
    return top;
  }

  get finished(): boolean {
    return this.now >= this.endTime;
  }

  runUntil(t: number): void {
    t = Math.min(t, this.endTime);
    while (this.events.length > 0 && this.events[0].t <= t) {
      const ev = this.pop();
      this.now = ev.t;
      switch (ev.kind) {
        case 'order': this.onOrder(ev.arg as Order); break;
        case 'shift_start': this.onShiftStart(ev.arg as number); break;
        case 'shift_end': this.onShiftEnd(ev.arg as number); break;
        case 'sample': this.onSample(); break;
        case 'dispatch': this.onDispatch(); break;
        case 'reply': this.onReply(ev.arg as number, ev.order, ev.est); break;
        case 'arrive_restaurant': this.onArriveRestaurant(ev.arg as number); break;
        case 'pickup': this.onPickup(ev.arg as number); break;
        case 'arrive_customer': this.onArriveCustomer(ev.arg as number); break;
        case 'delivered': this.onDelivered(ev.arg as number); break;
      } // prettier-ignore
    }
    this.now = t;
  }

  run(): this {
    this.runUntil(this.endTime);
    return this;
  }

  private makeDispatcher(name: string): Dispatcher {
    const dispatcher = DISPATCHERS[name]();
    if (dispatcher.buffer !== undefined) dispatcher.buffer = this.cfg.jitBufferS;
    return dispatcher;
  }

  setDispatcher(name: string): void {
    this.dispatcher = this.makeDispatcher(name);
    this.cfg.dispatcher = name;
    this.log('system', `Dispatcher switched to: ${this.dispatcher.label}`);
  }

  // ---------------------------------------------------------------- helpers

  /** The dispatcher's one city-wide congestion factor. */
  estFactor(t: number): number {
    return this.traffic.multiplier(t, CLASS_ID.arterial);
  }

  /** True travel time of every road segment right now. */
  private roadGraph(): Float64Array {
    const slot = this.traffic.slot(this.now);
    if (slot !== this.graphSlot) {
      this.traffic.edgeSeconds(this.net, this.now, this.graph);
      this.graphSlot = slot;
    }
    return this.graph;
  }

  private setStatus(d: Driver, status: number): void {
    d.seconds[d.status] += this.now - d.since;
    d.since = this.now;
    d.status = status;
  }

  private setRoute(d: Driver, route: Route | null): void {
    d.route = route;
    this.routeVersion.set(d.id, ++this.routeSeq);
  }

  private log(kind: string, text: string, order = -1, driver = -1): void {
    this.feed.push({ seq: ++this.feedSeq, t: this.now, kind, text, order, driver });
    if (this.feed.length > 500) this.feed.shift();
  }

  private freeDriver(d: Driver): void {
    d.order = -1;
    this.setRoute(d, null);
    this.setStatus(d, d.leaving || this.now >= d.shiftEnd ? OFFLINE : IDLE);
  }

  // ----------------------------------------------------------------- events

  private onOrder(o: Order): void {
    this.active.set(o.id, o);
    this.nPlaced++;
    this.log('order', `Order #${o.id} placed at ${this.restaurants[o.restaurant].name}`, o.id);
  }

  private onShiftStart(i: number): void {
    const d = this.drivers[i];
    d.since = this.now;
    this.setStatus(d, IDLE);
  }

  private onShiftEnd(i: number): void {
    const d = this.drivers[i];
    if (d.status === IDLE) this.setStatus(d, OFFLINE);
    else if (d.status !== OFFLINE) d.leaving = true;
  }

  private onSample(): void {
    this.series.push(this.sample());
    this.push(this.now + 300.0, 'sample', -1);
  }

  private onDispatch(): void {
    this.push(this.now + this.dispatcher.interval, 'dispatch', -1);
    const orders: Order[] = [];
    for (const o of this.active.values()) if (o.status === OPEN) orders.push(o);
    const drivers = this.drivers.filter((d) => d.status === IDLE);
    const O = orders.length;
    const D = drivers.length;
    if (O === 0 || D === 0) return;

    const factor = this.estFactor(this.now);
    const view: DispatchView = {
      now: this.now,
      driverIds: Int32Array.from(drivers, (d) => d.id),
      orderIds: Int32Array.from(orders, (o) => o.id),
      pickup: new Float64Array(O * D),
      dropoff: new Float64Array(O * D),
      placed: Float64Array.from(orders, (o) => o.placed),
      estReady: Float64Array.from(orders, (o) => (this.cfg.knowPrep ? o.ready : o.estReady)),
      promised: Float64Array.from(orders, (o) => o.promised),
      declined: new Uint8Array(O * D),
    };
    const col = new Map<number, number>();
    drivers.forEach((d, j) => col.set(d.id, j));
    const row = new Map<number, number>();
    orders.forEach((o, i) => {
      row.set(o.id, i);
      const toRest = this.ffToRest[o.restaurant];
      const dropoff = o.dropoffFfS * factor;
      for (let j = 0; j < D; j++) {
        view.pickup[i * D + j] = toRest[drivers[j].node] * factor;
        view.dropoff[i * D + j] = dropoff;
      }
      for (const did of o.declined) {
        const j = col.get(did);
        if (j !== undefined) view.declined[i * D + j] = 1;
      }
    });

    for (const [did, oid] of this.dispatcher.decide(view)) {
      const d = this.drivers[did];
      const o = this.active.get(oid);
      if (!o || d.status !== IDLE || o.status !== OPEN) continue; // a dispatcher bug should not corrupt the world
      this.setStatus(d, OFFERED);
      d.order = oid;
      o.status = O_OFFERED;
      o.offers++;
      this.nOffers++;
      const est = view.pickup[(row.get(oid) as number) * D + (col.get(did) as number)];
      this.push(this.now + this.behave.uniform(5, 25), 'reply', did, oid, est);
    }
  }

  private onReply(did: number, oid: number, est: number): void {
    const d = this.drivers[did];
    const o = this.active.get(oid) as Order;
    const rest = this.restaurants[o.restaurant];
    // Drivers turn down long pickups more often.
    const p = Math.min(Math.max(d.acceptBase - 0.025 * Math.max(0.0, est / 60 - 6), 0.25), 1.0);
    if (this.behave.random() > p) {
      o.status = OPEN;
      o.declined.add(did);
      d.declines++;
      this.nDeclines++;
      this.log('decline', `Driver ${did} declined order #${oid} (${(est / 60).toFixed(0)} min away)`, oid, did); // prettier-ignore
      this.freeDriver(d);
      return;
    }
    o.status = ASSIGNED;
    o.driver = did;
    o.assigned = this.now;
    o.estPickupDrive = est;
    const route = this.net.route(this.roadGraph(), d.node, rest.node, this.now);
    o.truePickupDrive = route.end - route.start;
    d.meters += route.meters;
    this.setStatus(d, TO_RESTAURANT);
    this.setRoute(d, route);
    this.push(route.end, 'arrive_restaurant', did);
    this.log('assign', `Driver ${did} accepted order #${oid}, ${(o.truePickupDrive / 60).toFixed(0)} min from ${rest.name}`, oid, did); // prettier-ignore
  }

  private onArriveRestaurant(did: number): void {
    const d = this.drivers[did];
    const o = this.active.get(d.order) as Order;
    d.node = this.restaurants[o.restaurant].node;
    o.status = COLLECTING;
    o.atRestaurant = this.now;
    this.setStatus(d, AT_RESTAURANT);
    this.setRoute(d, null);
    this.push(Math.max(this.now + o.pickupOverheadS, o.ready), 'pickup', did);
  }

  private onPickup(did: number): void {
    const d = this.drivers[did];
    const o = this.active.get(d.order) as Order;
    o.status = EN_ROUTE;
    o.pickedUp = this.now;
    const route = this.net.route(this.roadGraph(), d.node, o.customerNode, this.now);
    o.trueDropoffDrive = route.end - route.start;
    o.estDropoffDrive = o.dropoffFfS * this.estFactor(this.now);
    d.meters += route.meters;
    this.setStatus(d, TO_CUSTOMER);
    this.setRoute(d, route);
    this.push(route.end, 'arrive_customer', did);
    this.log('pickup', `Driver ${did} picked up order #${o.id}`, o.id, did);
  }

  private onArriveCustomer(did: number): void {
    const d = this.drivers[did];
    const o = this.active.get(d.order) as Order;
    d.node = o.customerNode;
    this.setStatus(d, AT_DOOR);
    this.setRoute(d, null);
    this.push(this.now + o.dropoffOverheadS, 'delivered', did);
  }

  private onDelivered(did: number): void {
    const d = this.drivers[did];
    const o = this.active.get(d.order) as Order;
    this.active.delete(o.id);
    o.status = DELIVERED;
    o.delivered = this.now;
    d.deliveries++;
    this.done.push(o);
    const late = (o.delivered - o.promised) / 60;
    const took = (o.delivered - o.placed) / 60;
    const note = late > 0 ? `${late.toFixed(0)} min late` : 'on time';
    this.log(late > 0 ? 'late' : 'delivered', `Order #${o.id} delivered in ${took.toFixed(0)} min (${note})`, o.id, did); // prettier-ignore
    this.freeDriver(d);
  }

  // ---------------------------------------------------------------- metrics

  private sample(): Sample {
    let online = 0;
    let busy = 0;
    for (const d of this.drivers) {
      if (d.status >= IDLE) online++;
      if (d.status >= TO_RESTAURANT) busy++;
    }
    let open = 0;
    for (const o of this.active.values()) if (o.status === OPEN || o.status === O_OFFERED) open++;
    let n = 0;
    let total = 0;
    let late = 0;
    for (const o of this.done) {
      if (o.delivered < this.now - 1800) continue;
      n++;
      total += o.delivered - o.placed;
      if (o.delivered > o.promised) late++;
    }
    return {
      t: this.now,
      open,
      active: this.active.size,
      online,
      busy,
      avg_min: n ? total / n / 60 : null,
      late_pct: n ? (late / n) * 100 : null,
    };
  }

  /** Headline numbers for the live view, over the whole run or the trailing window. */
  kpis(windowS?: number): { delivered: number; placed: number; avg_delivery_min?: number; late_pct?: number } {
    let n = 0;
    let total = 0;
    let late = 0;
    for (const o of this.done) {
      if (windowS !== undefined && o.delivered < this.now - windowS) continue;
      n++;
      total += o.delivered - o.placed;
      if (o.delivered > o.promised) late++;
    }
    if (n === 0) return { delivered: 0, placed: this.nPlaced };
    return {
      delivered: n,
      placed: this.nPlaced,
      avg_delivery_min: total / n / 60,
      late_pct: (late / n) * 100,
    };
  }

  /** End-of-run report. Every number is defined in metrics.ts. */
  summary(): Summary {
    return summarize(this);
  }

  driverPosition(d: Driver): [number, number] {
    if (d.route !== null) return d.route.position(this.now);
    return [this.net.nodeLon[d.node], this.net.nodeLat[d.node]];
  }
}
