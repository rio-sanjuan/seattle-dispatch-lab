import { describe, expect, it } from 'vitest';
import { LiveSim, applyChanges } from '../src/live/controller';
import { makeConfig } from '../src/sim/sim';
import { gridNetwork, profile } from './helpers';

const config = {
  seed: 3, hours: 3, startHour: 11, nRestaurants: 20, nDrivers: 18,
  peakOrdersPerHour: 90, deliveryRadiusM: 2500,
}; // prettier-ignore

describe('live controller', () => {
  const live = () => new LiveSim(gridNetwork(), profile(), config);

  it('advances at the chosen speed and stops when paused or hidden', () => {
    const l = live();
    l.step(0.1);
    expect(l.sim.now).toBeCloseTo(6, 9); // 60x for a tenth of a second
    l.handle({ cmd: 'speed', value: 300 });
    l.step(0.1);
    expect(l.sim.now).toBeCloseTo(36, 9);
    l.step(5); // a stalled tick is capped at a quarter of a second
    expect(l.sim.now).toBeCloseTo(36 + 75, 9);
    l.handle({ cmd: 'play', on: false });
    l.step(0.1);
    l.handle({ cmd: 'play', on: true });
    l.handle({ cmd: 'visible', on: false });
    l.step(0.1);
    expect(l.sim.now).toBeCloseTo(111, 9);
    l.handle({ cmd: 'speed', value: 7 }); // not an offered speed
    expect(l.speed).toBe(300);
  });

  it('sends each feed line, sample and route once', () => {
    const l = live();
    l.handle({ cmd: 'speed', value: 900 });
    const seen = { feed: 0, series: 0, routes: 0, lastSeq: 0 };
    for (let i = 0; i < 60; i++) {
      l.step(0.25);
      const s = l.state(i * 250);
      for (const e of s.feed) {
        expect(e.seq).toBeGreaterThan(seen.lastSeq);
        seen.lastSeq = e.seq;
      }
      seen.feed += s.feed.length;
      seen.series += s.series.length;
      seen.routes += Object.values(s.routes).filter(Boolean).length;
      for (const [, lon, lat] of s.drivers) {
        expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
      }
    }
    expect(l.sim.finished).toBe(true);
    expect(seen.series).toBe(l.sim.series.length);
    expect(seen.feed).toBe(l.sim.feedSeq);
    expect(seen.routes).toBeGreaterThan(50);
    expect(l.state(1e9).kpi.all.delivered).toBe(l.sim.done.length);
  });

  it('describes a selected driver and switches dispatcher mid-run', () => {
    const l = live();
    l.handle({ cmd: 'speed', value: 900 });
    for (let i = 0; i < 12; i++) l.step(0.25);
    const busy = l.sim.drivers.find((d) => d.order >= 0)!;
    l.handle({ cmd: 'select', id: busy.id });
    const detail = l.state(0).detail!;
    expect(detail.id).toBe(busy.id);
    expect(detail.order?.id).toBe(busy.order);
    l.handle({ cmd: 'dispatcher', name: 'nearest' });
    expect(l.state(1).dispatcher).toBe('nearest');
    l.handle({ cmd: 'select', id: -1 });
    expect(l.state(2).detail).toBeUndefined();
  });

  it('restarts with cleaned-up settings', () => {
    const l = live();
    l.step(0.2);
    l.handle({ cmd: 'restart', config: { nDrivers: '40', startDay: 'Sat', trafficScale: 99, seed: 'x' } });
    expect(l.generation).toBe(1);
    expect(l.sim.now).toBe(0);
    expect(l.sim.drivers.length).toBe(40);
    expect(l.hello().config).toMatchObject({ startDay: 'Sat', trafficScale: 3, seed: 3 });
    const cfg = applyChanges(makeConfig(), { deliveryRadiusM: 10, startDay: 'Someday', dispatcher: 'best' });
    expect(cfg).toMatchObject({ deliveryRadiusM: 300, startDay: 'Fri', dispatcher: 'matching_jit' });
  });
});

describe('re-running a day', () => {
  it('gives the same result under the same dispatcher, whenever it is asked', () => {
    const l = new LiveSim(gridNetwork(), profile(), config);
    l.handle({ cmd: 'speed', value: 900 });
    for (let i = 0; i < 20; i++) l.step(0.25); // part-way through the day
    const early = l.compareUnder('matching_jit');
    while (!l.sim.finished) l.step(0.25);
    const whole = l.sim.summary();
    expect(early).toEqual(whole);
    expect(l.compareUnder('matching_jit')).toEqual(whole);
  });

  it('keeps the world and changes only the dispatcher', () => {
    const l = new LiveSim(gridNetwork(), profile(), config);
    const base = l.sim;
    const other = base.fresh('nearest');
    other.runUntil(1e9);
    base.runUntil(1e9);
    const world = (sim: typeof base) =>
      [...sim.done, ...sim.active.values()]
        .sort((a, b) => a.id - b.id)
        .map((o) => [o.placed, o.restaurant, o.customerNode, o.ready, o.promised]);
    expect(world(other)).toEqual(world(base));
    expect(other.summary().dispatcher).toBe('nearest');
    expect(other.summary().avg_delivery_min).not.toBe(base.summary().avg_delivery_min);
    // Switching dispatcher mid-day on screen does not change what a comparison runs.
    l.handle({ cmd: 'dispatcher', name: 'nearest' });
    expect(l.compareUnder('matching').dispatcher).toBe('matching');
  });

  it('sends the full report about once a second', () => {
    const l = new LiveSim(gridNetwork(), profile(), config);
    expect(l.state(0).report).toBeDefined();
    expect(l.state(400).report).toBeUndefined();
    expect(l.state(1100).report?.placed).toBe(l.sim.nPlaced);
  });

  it('checks settings that arrive from a link', () => {
    const l = new LiveSim(gridNetwork(), profile(), config, { nDrivers: '9999', startDay: 'Tue', seed: 'abc' });
    expect(l.hello().config).toMatchObject({ nDrivers: 2000, startDay: 'Tue', seed: 3, nRestaurants: 20 });
  });
});
