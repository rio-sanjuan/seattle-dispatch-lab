import { describe, expect, it } from 'vitest';
import { Traffic } from '../src/sim/traffic';
import type { RoadNetwork } from '../src/sim/network';
import {
  fixture, gridNetwork, hasSeattle, profile, readJSON, seattleNetwork, type Reference,
} from './helpers'; // prettier-ignore

const GRID = 12;
const EDGE_S = 40;

interface Routing {
  restaurants: number[];
  nodes: number[];
  to_rest: number[][];
  from_rest: number[][];
  routes: { src: number; dst: number; depart: number; end: number; meters: number }[];
}

describe('street network (test grid)', () => {
  const net = gridNetwork();

  it('times a route and places the driver along it', () => {
    const route = net.route(net.edgeTime, 0, GRID * GRID - 1, 100);
    const blocks = 2 * (GRID - 1);
    expect(route.end - route.start).toBeCloseTo(blocks * EDGE_S, 9);
    expect(route.meters).toBeCloseTo(blocks * 400, 6);
    expect(route.position(50)).toEqual([net.nodeLon[0], net.nodeLat[0]]);
    expect(route.position(1e9)).toEqual([net.nodeLon[GRID * GRID - 1], net.nodeLat[GRID * GRID - 1]]);
    // Halfway along the first block.
    const [lon, lat] = route.position(100 + EDGE_S / 2);
    const moved = Math.hypot((lon - net.nodeLon[0]) * net.kx, (lat - net.nodeLat[0]) * net.ky);
    expect(Math.abs(moved - 200)).toBeLessThan(0.5);
    for (let i = 1; i < route.t.length; i++) expect(route.t[i]).toBeGreaterThanOrEqual(route.t[i - 1]);
  });

  it('agrees between "from", "to" and a full route', () => {
    const from = new Float64Array(net.nNodes);
    const to = new Float64Array(net.nNodes);
    net.timesFrom(net.edgeTime, 17, from);
    net.timesTo(net.edgeTime, 100, to);
    const route = net.route(net.edgeTime, 17, 100, 0);
    expect(from[100]).toBeCloseTo(route.end, 9);
    expect(to[17]).toBeCloseTo(route.end, 9);
    expect(from[17]).toBe(0);
  });

  it('finds the nodes within a radius', () => {
    for (const [node, radius] of [[0, 450], [65, 1000], [143, 2500]] as const) {
      const brute: number[] = [];
      for (let i = 0; i < net.nNodes; i++) {
        if (Math.hypot(net.nodeX[i] - net.nodeX[node], net.nodeY[i] - net.nodeY[node]) <= radius) brute.push(i);
      }
      expect(Array.from(net.nodesWithin(node, radius))).toEqual(brute);
    }
  });
});

function checkRouting(net: RoadNetwork, want: Routing, restaurantNodes: number[], startHour: number): void {
  // The travel-time tables behind the dispatcher's estimates, stored as 32-bit numbers.
  const row = new Float32Array(net.nNodes);
  want.restaurants.forEach((r, k) => {
    net.timesTo(net.edgeTime, restaurantNodes[r], row);
    want.nodes.forEach((n, i) => expect(row[n]).toBeCloseTo(want.to_rest[k][i], 3));
    net.timesFrom(net.edgeTime, restaurantNodes[r], row);
    want.nodes.forEach((n, i) => expect(row[n]).toBeCloseTo(want.from_rest[k][i], 3));
  });
  // Full routes at different times of a Friday.
  const traffic = new Traffic(4 * 86400 + startHour * 3600, profile());
  const seconds = new Float64Array(net.nEdges);
  for (const r of want.routes) {
    traffic.edgeSeconds(net, r.depart, seconds);
    const route = net.route(seconds, r.src, r.dst, r.depart);
    expect(route.end).toBeCloseTo(r.end, 6);
    expect(route.meters).toBeCloseTo(r.meters, 3);
  }
}

const restaurantNodes = (run: string): number[] =>
  readJSON<Reference>(fixture(run)).world.restaurants.map((r) => r[0]);

describe('routes under traffic match the Python simulator', () => {
  it('on the test grid', () => {
    checkRouting(gridNetwork(), readJSON(fixture('grid/routing.json')), restaurantNodes('grid/run.json'), 11);
  });

  it.skipIf(!hasSeattle())('on the Seattle network', () => {
    checkRouting(seattleNetwork(), readJSON(fixture('real/routing.json')), restaurantNodes('real/run.json'), 10);
  });
});
