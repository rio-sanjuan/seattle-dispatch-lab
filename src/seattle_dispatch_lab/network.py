"""Seattle road network: build from OpenStreetMap, then route on it.

The network is stored as flat numpy arrays (not a networkx graph) so that
shortest-path queries run in compiled scipy code. A route query on the whole
city takes a few milliseconds.

Build once with `dispatch-lab setup`; everything else calls `RoadNetwork.load()`.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

PLACE = "Seattle, Washington, USA"
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
NETWORK_PATH = DATA_DIR / "network.npz"

# Traffic classes. Each road segment belongs to one; the traffic model gives
# every class its own slowdown curve over the week. The six named freeway
# classes are the ones the loop-detector dataset measures directly.
TRAFFIC_CLASSES = [
    "I5_N",
    "I5_S",
    "I90_E",
    "I90_W",
    "SR520_E",
    "SR520_W",
    "freeway_other",
    "arterial",
    "local",
]
CLASS_ID = {name: i for i, name in enumerate(TRAFFIC_CLASSES)}

# OpenStreetMap gives speed limits, but nobody averages the speed limit on a
# city street: signals, stop signs and turns eat a large share. These factors
# turn a limit into a realistic uncongested average. They are assumptions, not
# measurements. Change them here and re-run setup to see how much they matter.
EFFECTIVE_SPEED_FACTOR = {"freeway": 1.0, "arterial": 0.62, "local": 0.50}

_FREEWAY = {"motorway", "motorway_link", "trunk", "trunk_link"}
_ARTERIAL = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
}
_RESIDENTIAL = {"residential", "living_street"}


def _first(value):
    return value[0] if isinstance(value, list) else value


def _traffic_class(highway: str, ref, bearing: float) -> tuple[int, str]:
    """Map an OSM road to (traffic class id, speed-factor group)."""
    if highway in _FREEWAY:
        parts = ref if isinstance(ref, list) else [ref]
        refs = {r.strip() for p in parts for r in str(p or "").split(";")}
        north = bearing < 90 or bearing >= 270
        east = bearing < 180
        if highway.startswith("motorway"):
            # "I 5 Express" is the reversible express roadway; it follows the
            # I-5 curve for whichever way the segment points.
            if refs & {"I 5", "I 5 Express"}:
                return CLASS_ID["I5_N" if north else "I5_S"], "freeway"
            if "I 90" in refs:
                return CLASS_ID["I90_E" if east else "I90_W"], "freeway"
            if refs & {"SR 520", "WA 520"}:
                return CLASS_ID["SR520_E" if east else "SR520_W"], "freeway"
        return CLASS_ID["freeway_other"], "freeway"
    if highway in _ARTERIAL:
        return CLASS_ID["arterial"], "arterial"
    return CLASS_ID["local"], "local"


def build(path: Path = NETWORK_PATH) -> Path:
    """Download Seattle's drivable streets and food venues, save compact arrays."""
    import osmnx as ox

    ox.settings.cache_folder = str(DATA_DIR / "osm_cache")
    ox.settings.use_cache = True

    print(f"Downloading the drivable street network for {PLACE} ...")
    g = ox.graph_from_place(PLACE, network_type="drive")
    g = ox.truncate.largest_component(g, strongly=True)
    g = ox.routing.add_edge_speeds(g)
    g = ox.bearing.add_edge_bearings(g)

    node_ids = list(g.nodes)
    index = {osm_id: i for i, osm_id in enumerate(node_ids)}
    node_lon = np.array([g.nodes[n]["x"] for n in node_ids], dtype=np.float64)
    node_lat = np.array([g.nodes[n]["y"] for n in node_ids], dtype=np.float64)

    # Keep the fastest edge for each (from, to) pair; drop self-loops.
    best: dict[tuple[int, int], dict] = {}
    residential = np.zeros(len(node_ids), dtype=bool)
    for u, v, data in g.edges(data=True):
        highway = str(_first(data.get("highway", "")))
        if highway in _RESIDENTIAL:
            residential[index[u]] = residential[index[v]] = True
        if u == v:
            continue
        cls, group = _traffic_class(highway, data.get("ref", ""), float(data.get("bearing", 0.0)))
        speed_ms = float(data["speed_kph"]) / 3.6 * EFFECTIVE_SPEED_FACTOR[group]
        length = float(data["length"])
        seconds = max(length / speed_ms, 0.2)
        if "geometry" in data:
            coords = np.asarray(data["geometry"].coords, dtype=np.float64)
        else:
            coords = np.array(
                [[g.nodes[u]["x"], g.nodes[u]["y"]], [g.nodes[v]["x"], g.nodes[v]["y"]]]
            )
        key = (index[u], index[v])
        if key not in best or seconds < best[key]["seconds"]:
            best[key] = {
                "seconds": seconds,
                "length": length,
                "cls": cls,
                "coords": coords,
            }

    keys = sorted(best)  # sorted by (u, v): this is CSR order
    edge_u = np.array([k[0] for k in keys], dtype=np.int32)
    edge_v = np.array([k[1] for k in keys], dtype=np.int32)
    edge_len = np.array([best[k]["length"] for k in keys], dtype=np.float32)
    edge_time = np.array([best[k]["seconds"] for k in keys], dtype=np.float32)
    edge_class = np.array([best[k]["cls"] for k in keys], dtype=np.uint8)
    geom_off = np.zeros(len(keys) + 1, dtype=np.int64)
    geom_off[1:] = np.cumsum([len(best[k]["coords"]) for k in keys])
    geom_xy = np.concatenate([best[k]["coords"] for k in keys]).astype(np.float64)

    print("Downloading food venue locations ...")
    venues = ox.features_from_place(PLACE, tags={"amenity": ["restaurant", "fast_food", "cafe"]})
    centroids = venues.geometry.to_crs(32610).centroid.to_crs(4326)
    venue_lonlat = np.column_stack([centroids.x.values, centroids.y.values])

    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        node_lon=node_lon,
        node_lat=node_lat,
        edge_u=edge_u,
        edge_v=edge_v,
        edge_len=edge_len,
        edge_time=edge_time,
        edge_class=edge_class,
        geom_xy=geom_xy,
        geom_off=geom_off,
        residential_nodes=np.flatnonzero(residential).astype(np.int32),
        venue_lonlat=venue_lonlat,
    )
    print(
        f"Saved {len(node_ids):,} intersections, {len(keys):,} road segments and "
        f"{len(venue_lonlat):,} food venues to {path}"
    )
    return path


@dataclass
class Route:
    """A travelled path: a polyline with the clock time at which each point is reached."""

    lonlat: np.ndarray  # (P, 2)
    t: np.ndarray  # (P,) absolute sim seconds, non-decreasing
    meters: float
    # Transit trips only: (start time, what the courier is doing), in order.
    legs: list[tuple[float, str]] | None = None

    def leg_at(self, now: float) -> str | None:
        if not self.legs:
            return None
        current = self.legs[0][1]
        for start, label in self.legs:
            if start <= now:
                current = label
        return current

    @property
    def start(self) -> float:
        return float(self.t[0])

    @property
    def end(self) -> float:
        return float(self.t[-1])

    def position(self, now: float) -> tuple[float, float]:
        if now <= self.t[0]:
            return float(self.lonlat[0, 0]), float(self.lonlat[0, 1])
        if now >= self.t[-1]:
            return float(self.lonlat[-1, 0]), float(self.lonlat[-1, 1])
        i = int(np.searchsorted(self.t, now, side="right")) - 1
        span = self.t[i + 1] - self.t[i]
        f = 0.0 if span <= 0 else (now - self.t[i]) / span
        p = self.lonlat[i] + f * (self.lonlat[i + 1] - self.lonlat[i])
        return float(p[0]), float(p[1])


class RoadNetwork:
    def __init__(self, arrays: dict[str, np.ndarray]):
        self.node_lon = arrays["node_lon"]
        self.node_lat = arrays["node_lat"]
        self.edge_u = arrays["edge_u"]
        self.edge_v = arrays["edge_v"]
        self.edge_len = arrays["edge_len"]
        self.edge_time = arrays["edge_time"].astype(np.float64)  # free-flow seconds
        self.edge_class = arrays["edge_class"]
        self.geom_xy = arrays["geom_xy"]
        self.geom_off = arrays["geom_off"]
        self.residential_nodes = arrays["residential_nodes"]
        self.venue_lonlat = arrays["venue_lonlat"]
        self.n_nodes = len(self.node_lon)
        self.n_edges = len(self.edge_u)

        # CSR layout (edges are already sorted by from-node, then to-node).
        self._indptr = np.zeros(self.n_nodes + 1, dtype=np.int32)
        np.cumsum(np.bincount(self.edge_u, minlength=self.n_nodes), out=self._indptr[1:])
        self._indices = self.edge_v.astype(np.int32)

        # Flat-earth projection in meters, good to well under 1% across a city.
        self._lat0 = float(self.node_lat.mean())
        self._kx = 111_320.0 * np.cos(np.radians(self._lat0))
        self._ky = 110_540.0
        self.node_xy = np.column_stack([self.node_lon * self._kx, self.node_lat * self._ky])
        self._tree = cKDTree(self.node_xy)

        # Fraction of each edge's travel time spent before each geometry point.
        self._geom_frac = np.zeros(len(self.geom_xy))
        gx = self.geom_xy[:, 0] * self._kx
        gy = self.geom_xy[:, 1] * self._ky
        seg = np.hypot(np.diff(gx), np.diff(gy))
        for e in range(self.n_edges):
            a, b = self.geom_off[e], self.geom_off[e + 1]
            cum = np.concatenate([[0.0], np.cumsum(seg[a : b - 1])])
            self._geom_frac[a:b] = cum / cum[-1] if cum[-1] > 0 else np.linspace(0, 1, b - a)

    @classmethod
    def load(cls, path: Path = NETWORK_PATH) -> RoadNetwork:
        if not path.exists():
            raise FileNotFoundError(
                f"{path} not found. Run `uv run dispatch-lab setup` first to "
                "download the Seattle street network."
            )
        with np.load(path) as data:
            return cls({k: data[k] for k in data.files})

    # -- geometry -----------------------------------------------------------

    def to_xy(self, lonlat: np.ndarray) -> np.ndarray:
        lonlat = np.atleast_2d(lonlat)
        return np.column_stack([lonlat[:, 0] * self._kx, lonlat[:, 1] * self._ky])

    def nearest_node(self, lonlat: np.ndarray) -> np.ndarray:
        return self._tree.query(self.to_xy(lonlat))[1]

    def nodes_within(self, node: int, meters: float) -> np.ndarray:
        return np.asarray(self._tree.query_ball_point(self.node_xy[node], meters))

    def node_lonlat(self, node: int) -> tuple[float, float]:
        return float(self.node_lon[node]), float(self.node_lat[node])

    # -- routing ------------------------------------------------------------

    def graph(self, edge_seconds: np.ndarray) -> csr_matrix:
        return csr_matrix(
            (edge_seconds, self._indices, self._indptr),
            shape=(self.n_nodes, self.n_nodes),
        )

    def times_from(self, graph: csr_matrix, sources: np.ndarray) -> np.ndarray:
        """Seconds from each source node to every node. Shape (len(sources), N)."""
        return dijkstra(graph, directed=True, indices=sources)

    def times_to(self, graph: csr_matrix, targets: np.ndarray) -> np.ndarray:
        """Seconds from every node to each target node. Shape (len(targets), N)."""
        return dijkstra(graph.T.tocsr(), directed=True, indices=targets)

    def route(self, graph: csr_matrix, src: int, dst: int, depart: float) -> Route:
        """Fastest path from src to dst on `graph`, leaving at time `depart`."""
        if src == dst:
            p = np.array([self.node_lonlat(src)] * 2)
            return Route(p, np.array([depart, depart]), 0.0)
        dist, pred = dijkstra(graph, directed=True, indices=src, return_predecessors=True)
        if not np.isfinite(dist[dst]):
            raise ValueError(f"no route from node {src} to node {dst}")
        nodes = [dst]
        while nodes[-1] != src:
            nodes.append(int(pred[nodes[-1]]))
        nodes.reverse()

        pts, times, meters, clock = [], [], 0.0, depart
        for u, v in pairwise(nodes):
            lo, hi = self._indptr[u], self._indptr[u + 1]
            e = lo + int(np.searchsorted(self._indices[lo:hi], v))
            a, b = self.geom_off[e], self.geom_off[e + 1]
            seconds = float(graph.data[e])
            first = 0 if not pts else 1  # skip the shared joint between edges
            pts.append(self.geom_xy[a + first : b])
            times.append(clock + seconds * self._geom_frac[a + first : b])
            clock += seconds
            meters += float(self.edge_len[e])
        return Route(np.concatenate(pts), np.concatenate(times), meters)
