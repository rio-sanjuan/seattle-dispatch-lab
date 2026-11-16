// Traffic: how much slower each kind of road is at each time of the week.
// The profile is data/traffic_profile.json, the same file the Python version reads.

import { TRAFFIC_CLASSES, type RoadNetwork } from './network';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEK = 7 * 86400;

export interface TrafficProfile {
  bucket_minutes: number;
  source: string;
  multiplier: Record<string, number[]>;
}

export class Traffic {
  readonly source: string;
  private readonly bucket: number;
  private readonly table: Float64Array[]; // one row per traffic class

  /** `weekOffset` is where in the week (seconds after Monday 00:00) the run starts. */
  constructor(
    readonly weekOffset: number,
    profile: TrafficProfile,
    scale = 1,
  ) {
    this.bucket = profile.bucket_minutes * 60;
    this.source = profile.source;
    // `scale` exaggerates (>1) or flattens (<1) congestion for what-if runs.
    this.table = TRAFFIC_CLASSES.map((name) =>
      Float64Array.from(profile.multiplier[name], (m) => 1.0 + scale * (m - 1.0)),
    );
  }

  slot(simTime: number): number {
    return Math.floor(((this.weekOffset + simTime) % WEEK) / this.bucket);
  }

  /** One multiplier per traffic class. */
  multipliers(simTime: number): number[] {
    const slot = this.slot(simTime);
    return this.table.map((row) => row[slot]);
  }

  multiplier(simTime: number, classId: number): number {
    return this.table[classId][this.slot(simTime)];
  }

  /** Current travel time of every road segment. */
  edgeSeconds(net: RoadNetwork, simTime: number, out: Float64Array): Float64Array {
    const m = this.multipliers(simTime);
    for (let e = 0; e < net.nEdges; e++) out[e] = net.edgeTime[e] * m[net.edgeClass[e]];
    return out;
  }

  clock(simTime: number): string {
    const t = Math.floor((this.weekOffset + simTime) % WEEK);
    const day = Math.floor(t / 86400);
    const rest = t % 86400;
    const hh = String(Math.floor(rest / 3600)).padStart(2, '0');
    const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, '0');
    return `${DAYS[day]} ${hh}:${mm}`;
  }
}
