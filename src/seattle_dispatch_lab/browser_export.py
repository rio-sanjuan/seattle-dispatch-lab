"""Export data for the browser simulator in `browser/`.

The browser version is a TypeScript port of the simulator. It needs two things
from Python:

  * the street network as one compact binary file (`network_bin`), and
  * reference runs to check the port against (`reference_run`): a day's world
    (restaurants, orders, driver shifts), every random draw the drivers made,
    and the results Python got. Replaying that world in the browser code must
    give the same results.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .network import RoadNetwork
from .sim import SimConfig, Simulation
from .traffic import PROFILE_PATH

MAGIC = b"SDLN"
VERSION = 1
SIMPLIFY_M = 1.5  # road shapes are simplified to within this many meters


def _simplify(xy: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker: which points of a polyline (in meters) to keep."""
    n = len(xy)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, d = xy[a + 1 : b], xy[b] - xy[a]
        length = float(np.hypot(d[0], d[1]))
        if length == 0:
            dist = np.hypot(*(p - xy[a]).T)
        else:
            dist = np.abs(d[0] * (p[:, 1] - xy[a, 1]) - d[1] * (p[:, 0] - xy[a, 0])) / length
        i = int(dist.argmax())
        if dist[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return keep


def network_bin(net: RoadNetwork, simplify_m: float = SIMPLIFY_M) -> bytes:
    """The street network as bytes: a JSON header, then flat arrays.

    Coordinates are stored as 16-bit steps across the bounding box (about
    0.3 m). Travel times and lengths are kept exactly, so routing in the
    browser gives the same times as routing here; only the drawn shape of a
    road is approximate.
    """
    if net.n_nodes >= 65536:
        raise ValueError("the browser format stores node numbers in 16 bits")
    lon0, lon1 = float(net.geom_xy[:, 0].min()), float(net.geom_xy[:, 0].max())
    lat0, lat1 = float(net.geom_xy[:, 1].min()), float(net.geom_xy[:, 1].max())
    lon0, lon1 = min(lon0, float(net.node_lon.min())), max(lon1, float(net.node_lon.max()))
    lat0, lat1 = min(lat0, float(net.node_lat.min())), max(lat1, float(net.node_lat.max()))

    def quantize(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        q = np.empty(2 * len(lon), dtype=np.uint16)
        q[0::2] = np.round((lon - lon0) / (lon1 - lon0) * 65535)
        q[1::2] = np.round((lat - lat0) / (lat1 - lat0) * 65535)
        return q

    geom_m = net.to_xy(net.geom_xy)
    keep = np.ones(len(geom_m), dtype=bool)
    if simplify_m > 0:
        for e in range(net.n_edges):
            a, b = int(net.geom_off[e]), int(net.geom_off[e + 1])
            if b - a > 2:
                keep[a:b] = _simplify(geom_m[a:b], simplify_m)
    counts = np.add.reduceat(keep, net.geom_off[:-1]).astype(np.uint16)
    venue_node = net.nearest_node(net.venue_lonlat)

    arrays = [
        ("edge_len", net.edge_len.astype("<f4")),
        ("edge_time", net.edge_time.astype("<f4")),
        ("node_q", quantize(net.node_lon, net.node_lat).astype("<u2")),
        ("edge_u", net.edge_u.astype("<u2")),
        ("edge_v", net.edge_v.astype("<u2")),
        ("geom_count", counts.astype("<u2")),
        ("geom_q", quantize(net.geom_xy[keep, 0], net.geom_xy[keep, 1]).astype("<u2")),
        ("residential_nodes", net.residential_nodes.astype("<u2")),
        ("venue_node", venue_node.astype("<u2")),
        ("edge_class", net.edge_class.astype("u1")),
    ]
    index, offset, blobs = [], 0, []
    for name, a in arrays:
        raw = a.tobytes()
        raw += b"\0" * (-len(raw) % 4)
        index.append({"name": name, "dtype": a.dtype.str[1:], "length": len(a), "offset": offset})
        blobs.append(raw)
        offset += len(raw)
    header = json.dumps(
        {
            "version": VERSION,
            "n_nodes": net.n_nodes,
            "n_edges": net.n_edges,
            "bbox": [lon0, lat0, lon1, lat1],
            "arrays": index,
            "attribution": "Street data (c) OpenStreetMap contributors, ODbL",
        }
    ).encode()
    header += b" " * (-len(header) % 4)
    return MAGIC + struct.pack("<II", VERSION, len(header)) + header + b"".join(blobs)


def network_json(net: RoadNetwork) -> dict:
    """A small network as plain JSON (used for the made-up test grid)."""
    return {
        "node_lon": net.node_lon.tolist(),
        "node_lat": net.node_lat.tolist(),
        "edge_u": net.edge_u.tolist(),
        "edge_v": net.edge_v.tolist(),
        "edge_len": [float(x) for x in net.edge_len],
        "edge_time": [float(x) for x in net.edge_time],
        "edge_class": net.edge_class.tolist(),
        "geom_xy": net.geom_xy.ravel().tolist(),
        "geom_off": net.geom_off.tolist(),
        "residential_nodes": net.residential_nodes.tolist(),
        "venue_node": net.nearest_node(net.venue_lonlat).tolist(),
    }


def _clean(value):
    """JSON has no NaN; send it as null."""
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_clean(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class _Recorder:
    """Stands in for the driver-behaviour random stream and keeps every draw."""

    def __init__(self, rng: np.random.Generator):
        self.rng = rng
        self.draws: list[float] = []

    def uniform(self, low: float, high: float) -> float:
        x = float(self.rng.uniform(low, high))
        self.draws.append(x)
        return x

    def random(self) -> float:
        x = float(self.rng.random())
        self.draws.append(x)
        return x


def world_json(sim: Simulation) -> dict:
    """The world a fresh simulation is about to play out (call before running it)."""
    orders = sorted((e[3] for e in sim._events if e[2] == "order"), key=lambda o: o.id)
    return {
        "restaurants": [[r.node, r.name, r.mean_prep_s] for r in sim.restaurants],
        "order_fields": [
            "restaurant",
            "customer_node",
            "placed",
            "ready",
            "est_ready",
            "promised",
            "dropoff_ff_s",
            "pickup_overhead_s",
            "dropoff_overhead_s",
        ],
        "orders": [
            [
                o.restaurant,
                o.customer_node,
                o.placed,
                o.ready,
                o.est_ready,
                o.promised,
                o.dropoff_ff_s,
                o.pickup_overhead_s,
                o.dropoff_overhead_s,
            ]
            for o in orders
        ],
        "driver_fields": ["node", "shift_start", "shift_end", "accept_base"],
        "drivers": [[d.node, d.shift_start, d.shift_end, d.accept_base] for d in sim.drivers],
    }


def reference_run(cfg: SimConfig, net: RoadNetwork, dispatchers: list[str]) -> dict:
    """One world, run under each dispatcher, with everything needed to replay it."""
    out: dict = {"runs": {}}
    for name in dispatchers:
        run_cfg = SimConfig(**{**asdict(cfg), "dispatcher": name})
        sim = Simulation(run_cfg, net)
        if "world" not in out:
            out["config"] = asdict(run_cfg)
            out["world"] = world_json(sim)
        recorder = _Recorder(sim._behave)
        sim._behave = recorder
        sim.run()
        out["runs"][name] = {
            "behaviour": recorder.draws,
            "summary": sim.summary(),
            "series": sim.series,
            "orders": [
                [o.id, o.driver, o.assigned, o.at_restaurant, o.picked_up, o.delivered]
                for o in sim.done
            ],
        }
    return _clean(out)


def routing_samples(sim: Simulation, n_nodes: int = 300, n_routes: int = 25) -> dict:
    """Spot values of the travel-time tables and a few full routes under traffic."""
    net, rng = sim.net, np.random.default_rng(0)
    nodes = rng.choice(net.n_nodes, size=min(n_nodes, net.n_nodes), replace=False)
    rests = list(range(min(5, len(sim.restaurants))))
    routes = []
    for _ in range(n_routes):
        src, dst = (int(x) for x in rng.choice(net.n_nodes, size=2, replace=False))
        t = float(rng.uniform(0, sim.end_time))
        graph = net.graph(sim.traffic.edge_seconds(net, t))
        r = net.route(graph, src, dst, t)
        routes.append({"src": src, "dst": dst, "depart": t, "end": r.end, "meters": r.meters})
    return _clean(
        {
            "restaurants": rests,
            "nodes": nodes.tolist(),
            "to_rest": [[float(x) for x in sim.ff_to_rest[r, nodes]] for r in rests],
            "from_rest": [[float(x) for x in sim.ff_from_rest[r, nodes]] for r in rests],
            "routes": routes,
        }
    )


def assignment_cases(n: int = 60) -> list[dict]:
    """Cost matrices and scipy's answer, for checking the ported assignment solver."""
    from scipy.optimize import linear_sum_assignment

    rng, cases = np.random.default_rng(11), []
    for k in range(n):
        nr, nc = (int(x) for x in rng.integers(1, 13, size=2))
        if k % 3 == 0:  # small whole numbers: many ties
            cost = rng.integers(0, 4, size=(nr, nc)).astype(float)
        else:
            cost = rng.uniform(0, 2000, size=(nr, nc))
        if k % 4 == 1:  # some pairs blocked, as declined offers are
            cost = np.where(rng.random((nr, nc)) < 0.3, 1e9, cost)
        rows, cols = linear_sum_assignment(cost)
        cases.append(
            {"nr": nr, "nc": nc, "cost": cost.ravel().tolist(),
             "rows": rows.tolist(), "cols": cols.tolist()}
        )  # fmt: skip
    return cases


def write_data(out_dir: Path, net: RoadNetwork | None = None) -> None:
    """Write what the browser needs to run: the network and the traffic profile."""
    net = net or RoadNetwork.load()
    out_dir.mkdir(parents=True, exist_ok=True)
    blob = network_bin(net)
    (out_dir / "network.bin").write_bytes(blob)
    (out_dir / "traffic_profile.json").write_text(PROFILE_PATH.read_text())
    print(f"Wrote {out_dir / 'network.bin'} ({len(blob) / 1e6:.2f} MB) and traffic_profile.json")
