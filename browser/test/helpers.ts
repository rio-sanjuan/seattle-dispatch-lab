import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RoadNetwork } from '../src/sim/network';
import { makeConfig, type Behaviour, type SimConfig, type WorldData } from '../src/sim/sim';
import type { TrafficProfile } from '../src/sim/traffic';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
export const fixture = (name: string): string => here(`./fixtures/${name}`);
export const hasFixture = (name: string): boolean => existsSync(fixture(name));
export const readJSON = <T = any>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export const profile = (): TrafficProfile => readJSON(here('../../data/traffic_profile.json'));
export const gridNetwork = (): RoadNetwork =>
  RoadNetwork.fromJSON(readJSON(fixture('grid/network.json')));
export const NETWORK_BIN = here('../public/data/network.bin');
export const hasSeattle = (): boolean => existsSync(NETWORK_BIN) && hasFixture('real/run.json');
export function seattleNetwork(): RoadNetwork {
  const file = readFileSync(NETWORK_BIN);
  return RoadNetwork.fromBinary(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
}

/** A reference run written by scripts/export_browser_fixtures.py. */
export interface Reference {
  config: Record<string, any>;
  world: WorldData;
  runs: Record<
    string,
    {
      behaviour: number[];
      summary: Record<string, number | string | null>;
      series: Record<string, number | null>[];
      /** id, driver, assigned, at_restaurant, picked_up, delivered */
      orders: number[][];
    }
  >;
}

/** The Python simulator's settings, in this port's names. */
export function configFrom(py: Record<string, any>, dispatcher: string): SimConfig {
  return makeConfig({
    seed: py.seed,
    startDay: py.start_day,
    startHour: py.start_hour,
    hours: py.hours,
    nRestaurants: py.n_restaurants,
    nDrivers: py.n_drivers,
    peakOrdersPerHour: py.peak_orders_per_hour,
    deliveryRadiusM: py.delivery_radius_m,
    promiseSlackMin: py.promise_slack_min,
    trafficScale: py.traffic_scale,
    jitBufferS: py.jit_buffer_s,
    knowPrep: py.know_prep,
    dispatcher,
  });
}

/** Hands back, in order, the random draws the Python drivers made. */
export class Replay implements Behaviour {
  used = 0;
  constructor(private readonly draws: number[]) {}
  private next(): number {
    if (this.used >= this.draws.length) throw new Error('ran out of recorded draws');
    return this.draws[this.used++];
  }
  uniform(): number {
    return this.next();
  }
  random(): number {
    return this.next();
  }
}
