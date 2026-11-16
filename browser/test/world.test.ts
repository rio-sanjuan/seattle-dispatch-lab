// Worlds built in the browser (its own random numbers, so not the same days as
// Python's): the rules every run must obey, and a check that a browser-built
// Friday lands near the Python simulator's ten-day averages.

import { describe, expect, it } from 'vitest';
import { DISPATCHERS } from '../src/sim/dispatch';
import { Simulation, makeConfig, type SimConfig } from '../src/sim/sim';
import { gridNetwork, hasSeattle, profile, seattleNetwork } from './helpers';

const small = (changes: Partial<SimConfig> = {}): SimConfig =>
  makeConfig({
    seed: 3, hours: 3, startHour: 11, nRestaurants: 20, nDrivers: 18,
    peakOrdersPerHour: 90, deliveryRadiusM: 2500, ...changes,
  }); // prettier-ignore

describe('a browser-built world on the test grid', () => {
  const net = gridNetwork();

  for (const name of Object.keys(DISPATCHERS)) {
    it(`every order follows the lifecycle under ${name}`, () => {
      const sim = new Simulation(small({ dispatcher: name }), net, profile()).run();
      expect(sim.done.length).toBeGreaterThan(30);
      for (const o of sim.done) {
        expect(o.placed).toBeLessThanOrEqual(o.assigned);
        expect(o.assigned).toBeLessThanOrEqual(o.atRestaurant);
        expect(o.atRestaurant).toBeLessThanOrEqual(o.pickedUp);
        expect(o.pickedUp).toBeLessThanOrEqual(o.delivered);
        expect(o.pickedUp).toBeGreaterThanOrEqual(o.ready);
      }
      const s = sim.summary();
      expect(s.delivered).toBe(sim.done.length);
      expect(s.placed).toBe(sim.done.length + sim.active.size);
    });
  }

  it('gives the same result for the same seed', () => {
    const a = new Simulation(small(), net, profile()).run().summary();
    const b = new Simulation(small(), net, profile()).run().summary();
    expect(a).toEqual(b);
    const c = new Simulation(small({ seed: 4 }), net, profile()).run().summary();
    expect(c.avg_delivery_min).not.toBe(a.avg_delivery_min);
  });

  it('gives every dispatcher the same world', () => {
    const world = (name: string) => {
      const sim = new Simulation(small({ dispatcher: name }), net, profile());
      sim.runUntil(1e9);
      const orders = [...sim.done, ...sim.active.values()].sort((a, b) => a.id - b.id);
      return {
        orders: orders.map((o) => [o.placed, o.restaurant, o.customerNode, o.ready, o.promised]),
        shifts: sim.drivers.map((d) => [d.shiftStart, d.shiftEnd, d.acceptBase]),
      };
    };
    expect(world('nearest')).toEqual(world('matching'));
    expect(world('matching')).toEqual(world('matching_jit'));
  });

  it('can be advanced in steps', () => {
    const whole = new Simulation(small(), net, profile()).run();
    const stepped = new Simulation(small(), net, profile());
    for (let t = 0; t <= 3 * 3600; t += 7) stepped.runUntil(t);
    stepped.runUntil(3 * 3600);
    expect(stepped.summary()).toEqual(whole.summary());
  });
});

// Python, ten Fridays (results/summary.json): the averages a browser-built
// Friday should land near. Loose bounds: this is a different draw of the day.
describe.skipIf(!hasSeattle())('a browser-built Friday in Seattle', () => {
  it('lands near the Python averages', () => {
    const net = seattleNetwork();
    const runs = [1, 2].map((seed) => {
      const started = performance.now();
      const s = new Simulation(makeConfig({ seed }), net, profile()).run().summary();
      console.log(
        `seed ${seed}: ${((performance.now() - started) / 1000).toFixed(1)} s, ${s.placed} orders, ` +
          `${(s.avg_delivery_min as number).toFixed(1)} min average, ${(s.late_pct as number).toFixed(1)}% late`,
      );
      return s;
    });
    const avg = (key: string) => runs.reduce((a, s) => a + (s[key] as number), 0) / runs.length;
    expect(avg('placed')).toBeGreaterThan(1850); // Python: about 2,060
    expect(avg('placed')).toBeLessThan(2250);
    expect(Math.abs(avg('avg_delivery_min') - 26.9)).toBeLessThan(2.5);
    expect(Math.abs(avg('active_min_per_delivery') - 22.2)).toBeLessThan(2.0);
    expect(Math.abs(avg('prep_error_min') - 4.1)).toBeLessThan(0.5);
    expect(avg('late_pct')).toBeLessThan(18); // Python: 7.3
    expect(avg('unfulfilled_pct')).toBeLessThan(1);
  });
});
