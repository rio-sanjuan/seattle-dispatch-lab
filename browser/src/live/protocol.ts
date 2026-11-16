// Messages between the page and the worker that runs the simulation.

import type { Summary } from '../sim/metrics';
import type { FeedItem, Sample, SimConfig } from '../sim/sim';
import type { TrafficProfile } from '../sim/traffic';

export type Command =
  | { cmd: 'play'; on: boolean }
  | { cmd: 'speed'; value: number }
  | { cmd: 'dispatcher'; name: string }
  | { cmd: 'restart'; config: Partial<Record<keyof SimConfig, unknown>> }
  | { cmd: 'select'; id: number }
  /** Run this same day from the start under every dispatcher. */
  | { cmd: 'compare' }
  /** The page is hidden or scrolled away: stop the clock until it is back. */
  | { cmd: 'visible'; on: boolean };

export type ToWorker =
  | {
      type: 'init';
      network: ArrayBuffer;
      profile: TrafficProfile;
      /** Settings chosen by the page's author. */
      config?: Partial<SimConfig>;
      /** Settings from a visitor's link: checked and clamped before use. */
      changes?: Record<string, unknown>;
    }
  | ({ type: 'cmd' } & Command);

/** Sent once per world: everything that does not change while a day runs. */
export interface Hello {
  type: 'hello';
  generation: number;
  config: SimConfig;
  dispatchers: { name: string; label: string }[];
  speeds: number[];
  trafficClasses: readonly string[];
  /** id, lon, lat, name, usual prep minutes */
  restaurants: [number, number, number, string, number][];
}

export interface Kpi {
  delivered: number;
  placed: number;
  avg_delivery_min?: number;
  late_pct?: number;
}

export interface Detail {
  id: number;
  status: number;
  deliveries: number;
  declines: number;
  km: number;
  shiftEnd: number;
  order: null | {
    id: number;
    restaurant: number;
    placed: number;
    estReady: number;
    promised: number;
    lon: number;
    lat: number;
    status: number;
  };
}

/** Sent about ten times a second while the page is visible. */
export interface State {
  type: 'state';
  generation: number;
  t: number;
  clock: string;
  end: number;
  finished: boolean;
  playing: boolean;
  speed: number;
  dispatcher: string;
  /** Slowdown per traffic class. */
  traffic: number[];
  kpi: { hour: Kpi; all: Kpi };
  /** id, lon, lat, status, order */
  drivers: [number, number, number, number, number][];
  /** id, status, restaurant, lon, lat, placed, promised, driver */
  orders: [number, number, number, number, number, number, number, number][];
  /** Routes that changed since the last message: lon, lat, lon, lat, ... or null when it ended. */
  routes: Record<number, Float64Array | null>;
  feed: FeedItem[];
  series: Sample[];
  detail?: Detail;
  /** Every end-of-run metric for the day so far. Sent about once a second. */
  report?: Summary;
}

/** The same day under each dispatcher: first progress, then the results. */
export interface Comparison {
  type: 'comparison';
  generation: number;
  dispatchers: { name: string; label: string }[];
  /** How many of the runs have finished. */
  done: number;
  /** One summary per finished run, in the order of `dispatchers`. */
  summaries: Summary[];
}

export type FromWorker =
  | Hello
  | State
  | Comparison
  | { type: 'busy' }
  | { type: 'error'; message: string };
