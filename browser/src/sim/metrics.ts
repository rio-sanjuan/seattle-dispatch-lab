// Evaluation metrics: every end-of-run number is defined here, once.
// A port of metrics.py; docs/metrics.md explains what each one rewards and misses.
//
// Two cohorts are used on purpose:
//
//   delivered   orders that reached the customer. Times and distances can only
//               be measured on these, so a policy that abandons its hardest
//               orders looks better here than it is.
//   due         orders whose promised time fell inside the run, delivered or
//               not. Lateness and fulfilment are measured on these, so an
//               abandoned order counts against the policy instead of vanishing.

import { IDLE, TO_RESTAURANT, type Order, type Simulation } from './sim';

const SEVERE_LATE_S = 20 * 60;
const MIN_SHIFT_H_FOR_FAIRNESS = 1.0;

export interface Metric {
  key: string;
  label: string;
  group: string;
  /** "low", "high", or "" when neither direction is simply good. */
  better: '' | 'low' | 'high';
  digits: number;
}

const m = (key: string, label: string, group: string, better: Metric['better'], digits = 1): Metric =>
  ({ key, label, group, better, digits }); // prettier-ignore

export const METRICS: Metric[] = [
  m('avg_delivery_min', 'Average delivery time (min)', 'Customer', 'low'),
  m('p90_delivery_min', '90th percentile delivery time (min)', 'Customer', 'low'),
  m('late_pct', 'Not delivered by the promised time (%)', 'Customer', 'low'),
  m('severe_late_pct', '20+ min past the promised time (%)', 'Customer', 'low'),
  m('unfulfilled_pct', 'Due but never delivered (%)', 'Customer', 'low', 2),
  m('food_wait_min', 'Food waits for a driver (min)', 'Customer', 'low'),
  m('ready_to_door_min', 'Food age at the door (min)', 'Customer', 'low'),
  m('promise_bias_min', 'Arrival vs. promise (min, negative = early)', 'Customer', ''),
  m('active_min_per_delivery', 'Driver time used per delivery (min)', 'Courier', 'low'),
  m('pickup_drive_min', 'Drive to restaurant (min)', 'Courier', 'low'),
  m('driver_wait_min', 'Driver waits at restaurant (min)', 'Courier', 'low'),
  m('km_per_delivery', 'Distance driven per delivery (km)', 'Courier', 'low'),
  m('deliveries_per_driver_hour', 'Deliveries per driver-hour', 'Courier', 'high', 2),
  m('driver_gini', 'Unevenness of work across drivers (Gini, 0-1)', 'Courier', 'low', 3),
  m('decline_pct', 'Offers declined (%)', 'Courier', 'low'),
  m('delivered', 'Orders delivered', 'Marketplace', 'high', 0),
  m('wait_for_assign_min', 'Order waits for a driver (min)', 'Marketplace', ''),
  m('utilization_pct', 'Driver time spent on deliveries (%)', 'Marketplace', ''),
  m('undersupplied_pct', 'Time with more waiting orders than free drivers (%)', 'Marketplace', 'low'),
  m('eta_error_min', 'Drive-time estimate error (min)', 'Estimates', 'low'),
  m('prep_error_min', 'Food-ready estimate error (min)', 'Estimates', ''),
]; // prettier-ignore

export type Summary = Record<string, number | string>;

/** 0 = everyone gets the same, 1 = one person gets everything. */
export function gini(values: number[]): number {
  const x = [...values].sort((a, b) => a - b);
  const n = x.length;
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    sum += x[i];
    weighted += (i + 1) * x[i];
  }
  if (n === 0 || sum === 0) return 0;
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

/** Percentile with straight-line interpolation between neighbours. */
export function percentile(values: number[], q: number): number {
  const x = [...values].sort((a, b) => a - b);
  const pos = ((x.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, x.length - 1);
  return x[lo] + (x[hi] - x[lo]) * (pos - lo);
}

const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;

export function summarize(sim: Simulation): Summary {
  const end = sim.now;
  const done = sim.done;
  const everyone: Order[] = [...done, ...sim.active.values()];
  const out: Summary = {
    dispatcher: sim.dispatcher.name,
    seed: sim.cfg.seed,
    placed: sim.nPlaced,
    delivered: done.length,
    offers: sim.nOffers,
    declines: sim.nDeclines,
    decline_pct: sim.nOffers ? (100 * sim.nDeclines) / sim.nOffers : 0,
  };

  // ---- due cohort: lateness and fulfilment, abandoned orders included
  let due = 0, late = 0, never = 0, severeDue = 0, severe = 0; // prettier-ignore
  for (const o of everyone) {
    const arrived = Number.isNaN(o.delivered) ? Infinity : o.delivered;
    if (o.promised <= end) {
      due++;
      if (arrived > o.promised) late++;
      if (arrived === Infinity) never++;
    }
    if (o.promised + SEVERE_LATE_S <= end) {
      severeDue++;
      if (arrived > o.promised + SEVERE_LATE_S) severe++;
    }
  }
  out.late_pct = due ? (late / due) * 100 : NaN;
  out.severe_late_pct = severeDue ? (severe / severeDue) * 100 : NaN;
  out.unfulfilled_pct = due ? (never / due) * 100 : NaN;

  // ---- delivered cohort: times and distances
  if (done.length) {
    const col = (f: (o: Order) => number): number[] => done.map(f);
    const total = col((o) => (o.delivered - o.placed) / 60);
    out.avg_delivery_min = mean(total);
    out.p90_delivery_min = percentile(total, 90);
    out.food_wait_min = mean(col((o) => o.pickedUp - o.ready)) / 60;
    out.ready_to_door_min = mean(col((o) => o.delivered - o.ready)) / 60;
    out.promise_bias_min = mean(col((o) => o.delivered - o.promised)) / 60;
    out.active_min_per_delivery = mean(col((o) => o.delivered - o.assigned)) / 60;
    out.pickup_drive_min = mean(col((o) => o.truePickupDrive)) / 60;
    out.driver_wait_min = mean(col((o) => Math.max(0, o.ready - o.atRestaurant))) / 60;
    out.wait_for_assign_min = mean(col((o) => o.assigned - o.placed)) / 60;
    out.eta_error_min =
      mean(
        col((o) =>
          Math.abs(o.estPickupDrive + o.estDropoffDrive - (o.truePickupDrive + o.trueDropoffDrive)),
        ),
      ) / 60;
    // What the dispatcher was told vs. what happened (zero when it is told the truth).
    out.prep_error_min = sim.cfg.knowPrep ? 0 : mean(col((o) => Math.abs(o.ready - o.estReady))) / 60;
  }

  // ---- drivers
  let onlineH = 0;
  let busyH = 0;
  let meters = 0;
  const rates: number[] = [];
  for (const d of sim.drivers) {
    const seconds = [...d.seconds];
    seconds[d.status] += end - d.since;
    let shift = 0;
    let busy = 0;
    for (let s = IDLE; s < seconds.length; s++) {
      shift += seconds[s];
      if (s >= TO_RESTAURANT) busy += seconds[s];
    }
    onlineH += shift / 3600;
    busyH += busy / 3600;
    meters += d.meters;
    if (shift / 3600 >= MIN_SHIFT_H_FOR_FAIRNESS) rates.push(d.deliveries / (shift / 3600));
  }
  out.driver_hours = onlineH;
  out.utilization_pct = onlineH ? (busyH / onlineH) * 100 : 0;
  out.deliveries_per_driver_hour = onlineH ? done.length / onlineH : 0;
  out.km_per_delivery = meters / 1000 / Math.max(done.length, 1);
  out.driver_gini = gini(rates);

  // ---- marketplace: was there a free driver for every waiting order?
  if (sim.series.length) {
    const short = sim.series.filter((p) => p.open > p.online - p.busy).length;
    out.undersupplied_pct = (short / sim.series.length) * 100;
  }
  return out;
}
