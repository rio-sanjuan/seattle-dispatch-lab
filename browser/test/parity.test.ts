// The port is checked by replaying days the Python simulator built and ran.
// Given the same world and the same driver decisions, the browser code must
// reach the same results: every delivery by the same driver at the same second.

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/sim';
import {
  Replay, configFrom, fixture, gridNetwork, hasSeattle, profile, readJSON, seattleNetwork,
  type Reference,
} from './helpers'; // prettier-ignore

function replay(net: ReturnType<typeof gridNetwork>, ref: Reference, name: string): void {
  const want = ref.runs[name];
  const draws = new Replay(want.behaviour);
  const sim = new Simulation(configFrom(ref.config, name), net, profile(), {
    world: ref.world,
    behaviour: draws,
  }).run();

  // Every random draw the Python drivers made was used, in the same order.
  expect(draws.used).toBe(want.behaviour.length);

  // Each order: same driver, same times, in the same order of completion.
  expect(sim.done.length).toBe(want.orders.length);
  sim.done.forEach((o, i) => {
    const [id, driver, assigned, atRestaurant, pickedUp, delivered] = want.orders[i];
    expect(o.id).toBe(id);
    expect(o.driver).toBe(driver);
    expect(o.assigned).toBeCloseTo(assigned, 6);
    expect(o.atRestaurant).toBeCloseTo(atRestaurant, 6);
    expect(o.pickedUp).toBeCloseTo(pickedUp, 6);
    expect(o.delivered).toBeCloseTo(delivered, 6);
  });

  // The five-minute samples behind the live charts.
  expect(sim.series.length).toBe(want.series.length);
  sim.series.forEach((p, i) => {
    const w = want.series[i];
    for (const key of ['t', 'open', 'active', 'online', 'busy'] as const) expect(p[key]).toBe(w[key]);
    for (const key of ['avg_min', 'late_pct'] as const) {
      if (w[key] === null) expect(p[key]).toBeNull();
      else expect(p[key]).toBeCloseTo(w[key] as number, 8);
    }
  });

  // Every end-of-run metric.
  const got = sim.summary();
  for (const [key, value] of Object.entries(want.summary)) {
    if (typeof value === 'number') expect(got[key], key).toBeCloseTo(value, 8);
    else if (value === null) expect(got[key], key).toBeNaN();
    else expect(got[key], key).toBe(value);
  }
}

describe('replaying a Python day on the test grid', () => {
  const ref = readJSON<Reference>(fixture('grid/run.json'));
  for (const name of Object.keys(ref.runs)) {
    it(name, () => replay(gridNetwork(), ref, name));
  }
});

describe.skipIf(!hasSeattle())('replaying a Python day on the Seattle network', () => {
  const ref = hasSeattle() ? readJSON<Reference>(fixture('real/run.json')) : null;
  const net = hasSeattle() ? seattleNetwork() : null;
  for (const name of ['nearest', 'matching', 'matching_jit']) {
    it(name, () => replay(net!, ref!, name));
  }
});
