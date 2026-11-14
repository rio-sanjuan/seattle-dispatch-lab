// Dispatchers: the policies that decide which driver gets which order.
// Mirrors dispatch.py. Every dispatcher sees the same view (open orders, free
// drivers, and *estimates* of travel and food-prep times) and returns offers.

import { linearSumAssignment } from './assignment';

// What the dispatcher assumes about steps it cannot observe in advance.
export const OFFER_REPLY_S = 15.0; // a driver takes about this long to answer an offer
export const PICKUP_OVERHEAD_S = 120.0; // park, walk in, collect the bag
export const DROPOFF_OVERHEAD_S = 105.0; // park, walk to the door, hand over

/** Everything a dispatcher may look at. Times in seconds; matrices are O x D, row by row. */
export interface DispatchView {
  now: number;
  driverIds: Int32Array;
  orderIds: Int32Array;
  /** Estimated trip from each driver to the restaurant. */
  pickup: Float64Array;
  /** Estimated trip restaurant -> customer. */
  dropoff: Float64Array;
  placed: Float64Array;
  estReady: Float64Array;
  promised: Float64Array;
  /** 1 where this driver already said no to this order. */
  declined: Uint8Array;
}

export type Offers = [driver: number, order: number][];

export interface Dispatcher {
  readonly name: string;
  readonly label: string;
  /** Seconds between decisions. */
  readonly interval: number;
  buffer?: number;
  decide(v: DispatchView): Offers;
}

/** Greedy baseline: first come, first served, closest free driver. */
export class NearestDriver implements Dispatcher {
  readonly name = 'nearest';
  readonly label = 'Nearest free driver';
  readonly interval = 5.0;

  decide(v: DispatchView): Offers {
    const O = v.orderIds.length;
    const D = v.driverIds.length;
    const offers: Offers = [];
    const taken = new Uint8Array(D);
    const oldestFirst = Array.from({ length: O }, (_, i) => i).sort(
      (a, b) => v.placed[a] - v.placed[b],
    );
    for (const o of oldestFirst) {
      let best = -1;
      let bestDrive = Infinity;
      for (let d = 0; d < D; d++) {
        if (taken[d] || v.declined[o * D + d]) continue;
        if (v.pickup[o * D + d] < bestDrive) {
          bestDrive = v.pickup[o * D + d];
          best = d;
        }
      }
      if (best < 0) continue;
      taken[best] = 1;
      offers.push([v.driverIds[best], v.orderIds[o]]);
    }
    return offers;
  }
}

/**
 * Solve all open orders and free drivers together, once per cycle.
 *
 * Cost of giving order o to driver d (seconds, lower is better):
 *
 *     time from now until delivery
 *   + wLate  * how far past the promised time it would land
 *   + wDrive * the drive to the restaurant
 *   - wAge   * how long the order has already been waiting
 */
export class BatchedMatching implements Dispatcher {
  readonly name: string = 'matching';
  readonly label: string = 'Batched matching';
  readonly interval = 30.0;
  wLate = 2.0;
  wDrive = 0.5;
  wAge = 1.5;

  /** Whether order o joins this cycle's matching. `atCounter` is O x D. */
  protected eligible(_v: DispatchView, _atCounter: Float64Array, _o: number): boolean {
    return true;
  }

  decide(v: DispatchView): Offers {
    const O = v.orderIds.length;
    const D = v.driverIds.length;
    if (O === 0 || D === 0) return [];
    const cost = new Float64Array(O * D);
    const atCounter = new Float64Array(O * D);
    const base = v.now + OFFER_REPLY_S;
    for (let o = 0; o < O; o++) {
      const age = this.wAge * (v.now - v.placed[o]);
      for (let d = 0; d < D; d++) {
        const k = o * D + d;
        const arrive = base + v.pickup[k] + PICKUP_OVERHEAD_S;
        atCounter[k] = arrive;
        const deliver = Math.max(arrive, v.estReady[o]) + v.dropoff[k] + DROPOFF_OVERHEAD_S;
        cost[k] =
          deliver - v.now +
          this.wLate * Math.max(0.0, deliver - v.promised[o]) +
          this.wDrive * v.pickup[k] -
          age;
      }
    }
    const rows: number[] = [];
    for (let o = 0; o < O; o++) if (this.eligible(v, atCounter, o)) rows.push(o);
    if (rows.length === 0) return [];
    const sub = new Float64Array(rows.length * D);
    rows.forEach((o, i) => {
      for (let d = 0; d < D; d++) sub[i * D + d] = v.declined[o * D + d] ? 1e9 : cost[o * D + d];
    });
    const pairs = linearSumAssignment(sub, rows.length, D);
    const offers: Offers = [];
    for (let k = 0; k < pairs.rows.length; k++) {
      const o = rows[pairs.rows[k]];
      const d = pairs.cols[k];
      if (!v.declined[o * D + d]) offers.push([v.driverIds[d], v.orderIds[o]]);
    }
    return offers;
  }
}

/**
 * Batched matching that waits when sending a driver now would be too early.
 * An order joins the matching only once the closest free driver, sent right
 * now, would reach the counter within `buffer` seconds of the food being ready.
 */
export class JustInTimeMatching extends BatchedMatching {
  override readonly name = 'matching_jit';
  override readonly label = 'Matching + just-in-time';
  buffer = 240.0;

  protected override eligible(v: DispatchView, atCounter: Float64Array, o: number): boolean {
    const D = v.driverIds.length;
    let soonest = Infinity;
    for (let d = 0; d < D; d++) {
      if (!v.declined[o * D + d] && atCounter[o * D + d] < soonest) soonest = atCounter[o * D + d];
    }
    return soonest + this.buffer >= v.estReady[o];
  }
}

export const DISPATCHERS: Record<string, () => Dispatcher> = {
  nearest: () => new NearestDriver(),
  matching: () => new BatchedMatching(),
  matching_jit: () => new JustInTimeMatching(),
};

export const DISPATCHER_LIST = Object.keys(DISPATCHERS).map((name) => ({
  name,
  label: DISPATCHERS[name]().label,
}));
