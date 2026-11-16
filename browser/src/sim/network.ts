// The street network and routing on it. Mirrors network.py: flat arrays, a
// shortest-path search over all of them, and routes as polylines with a clock
// time at every point.

export const TRAFFIC_CLASSES = [
  'I5_N', 'I5_S', 'I90_E', 'I90_W', 'SR520_E', 'SR520_W', 'freeway_other', 'arterial', 'local',
] as const; // prettier-ignore
export const CLASS_ID: Record<string, number> = Object.fromEntries(
  TRAFFIC_CLASSES.map((name, i) => [name, i]),
);

export interface NetworkArrays {
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  edgeU: Int32Array;
  edgeV: Int32Array;
  edgeLen: Float32Array;
  /** Free-flow seconds, as stored (32-bit). */
  edgeTime: Float32Array;
  edgeClass: Uint8Array;
  /** lon, lat, lon, lat, ... for every edge's shape, one edge after another. */
  geomXY: Float64Array;
  /** Edge e's shape is points geomOff[e] .. geomOff[e + 1]. */
  geomOff: Uint32Array;
  residentialNodes: Int32Array;
  /** The street node nearest each real food venue. */
  venueNodes: Int32Array;
}

/** A travelled path: a polyline with the time at which each point is reached. */
export class Route {
  constructor(
    readonly lonlat: Float64Array,
    readonly t: Float64Array,
    readonly meters: number,
  ) {}

  get start(): number {
    return this.t[0];
  }

  get end(): number {
    return this.t[this.t.length - 1];
  }

  position(now: number): [number, number] {
    const t = this.t;
    const p = this.lonlat;
    const n = t.length;
    if (now <= t[0]) return [p[0], p[1]];
    if (now >= t[n - 1]) return [p[2 * n - 2], p[2 * n - 1]];
    let lo = 0; // last index with t[i] <= now
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= now) lo = mid;
      else hi = mid - 1;
    }
    const span = t[lo + 1] - t[lo];
    const f = span <= 0 ? 0 : (now - t[lo]) / span;
    return [
      p[2 * lo] + f * (p[2 * lo + 2] - p[2 * lo]),
      p[2 * lo + 1] + f * (p[2 * lo + 3] - p[2 * lo + 1]),
    ];
  }
}

const CELL_M = 500;

export class RoadNetwork {
  readonly nNodes: number;
  readonly nEdges: number;
  readonly nodeLon: Float64Array;
  readonly nodeLat: Float64Array;
  readonly edgeU: Int32Array;
  readonly edgeV: Int32Array;
  readonly edgeLen: Float32Array;
  readonly edgeTime: Float64Array;
  readonly edgeClass: Uint8Array;
  readonly geomXY: Float64Array;
  readonly geomOff: Uint32Array;
  readonly residentialNodes: Int32Array;
  readonly venueNodes: Int32Array;
  /** Flat-earth meters, good to well under 1% across a city. */
  readonly kx: number;
  readonly ky = 110_540;
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;
  readonly bounds: [number, number, number, number];

  private readonly indptr: Int32Array;
  private readonly rIndptr: Int32Array;
  private readonly rSrc: Int32Array;
  private readonly rEdge: Int32Array;
  private readonly geomFrac: Float64Array;

  // Scratch space for the shortest-path search, reused between calls.
  private readonly dist: Float64Array;
  private readonly predEdge: Int32Array;
  private heapKey: Float64Array;
  private heapNode: Int32Array;

  // Spatial grid for "which nodes are within r meters".
  private readonly cellCols: number;
  private readonly cellRows: number;
  private readonly cellX0: number;
  private readonly cellY0: number;
  private readonly cellStart: Int32Array;
  private readonly cellNodes: Int32Array;

  constructor(a: NetworkArrays) {
    this.nodeLon = a.nodeLon;
    this.nodeLat = a.nodeLat;
    this.edgeU = a.edgeU;
    this.edgeV = a.edgeV;
    this.edgeLen = a.edgeLen;
    this.edgeTime = Float64Array.from(a.edgeTime);
    this.edgeClass = a.edgeClass;
    this.geomXY = a.geomXY;
    this.geomOff = a.geomOff;
    this.residentialNodes = a.residentialNodes;
    this.venueNodes = a.venueNodes;
    const n = (this.nNodes = a.nodeLon.length);
    const m = (this.nEdges = a.edgeU.length);

    // Edges arrive sorted by from-node, then to-node: that is CSR order.
    this.indptr = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) this.indptr[a.edgeU[e] + 1]++;
    for (let i = 0; i < n; i++) this.indptr[i + 1] += this.indptr[i];

    // The same edges grouped by to-node, for searches towards a target.
    this.rIndptr = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) this.rIndptr[a.edgeV[e] + 1]++;
    for (let i = 0; i < n; i++) this.rIndptr[i + 1] += this.rIndptr[i];
    this.rSrc = new Int32Array(m);
    this.rEdge = new Int32Array(m);
    const fill = this.rIndptr.slice(0, n);
    for (let e = 0; e < m; e++) {
      const k = fill[a.edgeV[e]]++;
      this.rSrc[k] = a.edgeU[e];
      this.rEdge[k] = e;
    }

    let latSum = 0;
    let lon0 = Infinity, lon1 = -Infinity, lat0 = Infinity, lat1 = -Infinity; // prettier-ignore
    for (let i = 0; i < n; i++) {
      latSum += a.nodeLat[i];
      lon0 = Math.min(lon0, a.nodeLon[i]);
      lon1 = Math.max(lon1, a.nodeLon[i]);
      lat0 = Math.min(lat0, a.nodeLat[i]);
      lat1 = Math.max(lat1, a.nodeLat[i]);
    }
    this.bounds = [lon0, lat0, lon1, lat1];
    this.kx = 111_320 * Math.cos(((latSum / n) * Math.PI) / 180);
    this.nodeX = new Float64Array(n);
    this.nodeY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.nodeX[i] = a.nodeLon[i] * this.kx;
      this.nodeY[i] = a.nodeLat[i] * this.ky;
    }

    // Fraction of each edge's travel time spent before each shape point.
    const points = a.geomXY.length / 2;
    this.geomFrac = new Float64Array(points);
    for (let e = 0; e < m; e++) {
      const lo = a.geomOff[e];
      const hi = a.geomOff[e + 1];
      let total = 0;
      for (let p = lo + 1; p < hi; p++) {
        const dx = (a.geomXY[2 * p] - a.geomXY[2 * p - 2]) * this.kx;
        const dy = (a.geomXY[2 * p + 1] - a.geomXY[2 * p - 1]) * this.ky;
        total += Math.hypot(dx, dy);
        this.geomFrac[p] = total;
      }
      for (let p = lo; p < hi; p++) {
        this.geomFrac[p] = total > 0 ? this.geomFrac[p] / total : (p - lo) / (hi - lo - 1);
      }
    }

    this.dist = new Float64Array(n);
    this.predEdge = new Int32Array(n);
    this.heapKey = new Float64Array(m + n + 1);
    this.heapNode = new Int32Array(m + n + 1);

    const x0 = lon0 * this.kx;
    const y0 = lat0 * this.ky;
    this.cellX0 = x0;
    this.cellY0 = y0;
    this.cellCols = Math.floor((lon1 * this.kx - x0) / CELL_M) + 1;
    this.cellRows = Math.floor((lat1 * this.ky - y0) / CELL_M) + 1;
    const cells = this.cellCols * this.cellRows;
    this.cellStart = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c =
        Math.floor((this.nodeY[i] - y0) / CELL_M) * this.cellCols +
        Math.floor((this.nodeX[i] - x0) / CELL_M);
      cellOf[i] = c;
      this.cellStart[c + 1]++;
    }
    for (let c = 0; c < cells; c++) this.cellStart[c + 1] += this.cellStart[c];
    this.cellNodes = new Int32Array(n);
    const at = this.cellStart.slice(0, cells);
    for (let i = 0; i < n; i++) this.cellNodes[at[cellOf[i]]++] = i;
  }

  /** Read the file written by `dispatch-lab export-browser`. */
  static fromBinary(buf: ArrayBuffer): RoadNetwork {
    const view = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== 'SDLN') throw new Error('not a dispatch-lab network file');
    const version = view.getUint32(4, true);
    if (version !== 1) throw new Error(`unsupported network file version ${version}`);
    const headerLen = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, headerLen)));
    const base = 12 + headerLen;
    const bytes: Record<string, number> = { f4: 4, u2: 2, u1: 1 };
    const read = (name: string): ArrayBuffer => {
      const a = header.arrays.find((x: { name: string }) => x.name === name);
      if (!a) throw new Error(`network file has no "${name}"`);
      return buf.slice(base + a.offset, base + a.offset + a.length * bytes[a.dtype]);
    };
    const [lon0, lat0, lon1, lat1] = header.bbox as number[];
    const unpack = (q: Uint16Array): [Float64Array, Float64Array] => {
      const lon = new Float64Array(q.length / 2);
      const lat = new Float64Array(q.length / 2);
      for (let i = 0; i < lon.length; i++) {
        lon[i] = lon0 + (q[2 * i] / 65535) * (lon1 - lon0);
        lat[i] = lat0 + (q[2 * i + 1] / 65535) * (lat1 - lat0);
      }
      return [lon, lat];
    };
    const [nodeLon, nodeLat] = unpack(new Uint16Array(read('node_q')));
    const [gLon, gLat] = unpack(new Uint16Array(read('geom_q')));
    const geomXY = new Float64Array(2 * gLon.length);
    for (let i = 0; i < gLon.length; i++) {
      geomXY[2 * i] = gLon[i];
      geomXY[2 * i + 1] = gLat[i];
    }
    const counts = new Uint16Array(read('geom_count'));
    const geomOff = new Uint32Array(counts.length + 1);
    for (let e = 0; e < counts.length; e++) geomOff[e + 1] = geomOff[e] + counts[e];
    return new RoadNetwork({
      nodeLon,
      nodeLat,
      edgeU: Int32Array.from(new Uint16Array(read('edge_u'))),
      edgeV: Int32Array.from(new Uint16Array(read('edge_v'))),
      edgeLen: new Float32Array(read('edge_len')),
      edgeTime: new Float32Array(read('edge_time')),
      edgeClass: new Uint8Array(read('edge_class')),
      geomXY,
      geomOff,
      residentialNodes: Int32Array.from(new Uint16Array(read('residential_nodes'))),
      venueNodes: Int32Array.from(new Uint16Array(read('venue_node'))),
    });
  }

  /** Read the plain-JSON form used for the small test grid. */
  static fromJSON(o: Record<string, number[]>): RoadNetwork {
    return new RoadNetwork({
      nodeLon: Float64Array.from(o.node_lon),
      nodeLat: Float64Array.from(o.node_lat),
      edgeU: Int32Array.from(o.edge_u),
      edgeV: Int32Array.from(o.edge_v),
      edgeLen: Float32Array.from(o.edge_len),
      edgeTime: Float32Array.from(o.edge_time),
      edgeClass: Uint8Array.from(o.edge_class),
      geomXY: Float64Array.from(o.geom_xy),
      geomOff: Uint32Array.from(o.geom_off),
      residentialNodes: Int32Array.from(o.residential_nodes),
      venueNodes: Int32Array.from(o.venue_node),
    });
  }

  nodesWithin(node: number, meters: number): Int32Array {
    const x = this.nodeX[node];
    const y = this.nodeY[node];
    const c0 = Math.max(0, Math.floor((x - meters - this.cellX0) / CELL_M));
    const c1 = Math.min(this.cellCols - 1, Math.floor((x + meters - this.cellX0) / CELL_M));
    const r0 = Math.max(0, Math.floor((y - meters - this.cellY0) / CELL_M));
    const r1 = Math.min(this.cellRows - 1, Math.floor((y + meters - this.cellY0) / CELL_M));
    const out: number[] = [];
    const limit = meters * meters;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cellCols + c;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
          const i = this.cellNodes[k];
          const dx = this.nodeX[i] - x;
          const dy = this.nodeY[i] - y;
          if (dx * dx + dy * dy <= limit) out.push(i);
        }
      }
    }
    return Int32Array.from(out).sort();
  }

  // -- routing --------------------------------------------------------------

  private push(size: number, key: number, node: number): number {
    const keys = this.heapKey;
    const nodes = this.heapNode;
    let i = size;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      nodes[i] = nodes[parent];
      i = parent;
    }
    keys[i] = key;
    nodes[i] = node;
    return size + 1;
  }

  /** Removes the smallest entry; the caller reads heapKey[0] / heapNode[0] first. */
  private pop(size: number): number {
    const keys = this.heapKey;
    const nodes = this.heapNode;
    const last = size - 1;
    const key = keys[last];
    const node = nodes[last];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= key) break;
      keys[i] = keys[child];
      nodes[i] = nodes[child];
      i = child;
    }
    keys[i] = key;
    nodes[i] = node;
    return last;
  }

  /**
   * Shortest travel times from `origin` along the edges (or, with `reverse`,
   * towards it against them). Fills this.dist and this.predEdge. Stops early
   * once `stopAt` is settled.
   */
  private search(edgeSeconds: Float64Array, origin: number, reverse: boolean, stopAt = -1): void {
    const dist = this.dist;
    const pred = this.predEdge;
    dist.fill(Infinity);
    pred.fill(-1);
    dist[origin] = 0;
    let size = this.push(0, 0, origin);
    const ptr = reverse ? this.rIndptr : this.indptr;
    while (size > 0) {
      const d = this.heapKey[0];
      const u = this.heapNode[0];
      size = this.pop(size);
      if (d > dist[u]) continue; // a stale entry: u was already reached sooner
      if (u === stopAt) return;
      for (let k = ptr[u]; k < ptr[u + 1]; k++) {
        const e = reverse ? this.rEdge[k] : k;
        const v = reverse ? this.rSrc[k] : this.edgeV[k];
        const nd = d + edgeSeconds[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          pred[v] = e;
          size = this.push(size, nd, v);
        }
      }
    }
  }

  /** Seconds from `source` to every node. */
  timesFrom(edgeSeconds: Float64Array, source: number, out: Float32Array | Float64Array): void {
    this.search(edgeSeconds, source, false);
    out.set(this.dist);
  }

  /** Seconds from every node to `target`. */
  timesTo(edgeSeconds: Float64Array, target: number, out: Float32Array | Float64Array): void {
    this.search(edgeSeconds, target, true);
    out.set(this.dist);
  }

  /** Fastest path from src to dst, leaving at time `depart`. */
  route(edgeSeconds: Float64Array, src: number, dst: number, depart: number): Route {
    if (src === dst) {
      const lon = this.nodeLon[src];
      const lat = this.nodeLat[src];
      return new Route(Float64Array.of(lon, lat, lon, lat), Float64Array.of(depart, depart), 0);
    }
    this.search(edgeSeconds, src, false, dst);
    if (!Number.isFinite(this.dist[dst])) throw new Error(`no route from node ${src} to ${dst}`);
    const edges: number[] = [];
    for (let v = dst; v !== src; ) {
      const e = this.predEdge[v];
      edges.push(e);
      v = this.edgeU[e];
    }
    edges.reverse();

    let points = 1;
    for (const e of edges) points += this.geomOff[e + 1] - this.geomOff[e] - 1;
    const lonlat = new Float64Array(2 * points);
    const t = new Float64Array(points);
    let at = 0;
    let clock = depart;
    let meters = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const seconds = edgeSeconds[e];
      // Skip the first point of every edge but the first: it is the shared joint.
      for (let p = this.geomOff[e] + (i === 0 ? 0 : 1); p < this.geomOff[e + 1]; p++) {
        lonlat[2 * at] = this.geomXY[2 * p];
        lonlat[2 * at + 1] = this.geomXY[2 * p + 1];
        t[at++] = clock + seconds * this.geomFrac[p];
      }
      clock += seconds;
      meters += this.edgeLen[e];
    }
    return new Route(lonlat, t, meters);
  }
}
