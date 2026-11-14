"""Public transit: build a one-day Seattle timetable and plan trips on it.

A transit courier's trip is: walk to a stop, wait, ride, maybe transfer, walk
from a stop. The planner uses the Connection Scan Algorithm: sort every
stop-to-stop hop of the day by departure time, then sweep through them once,
keeping the earliest time each stop can be reached. One sweep answers "how
soon can I be at every stop?" for one starting point and start time.

Data: GTFS schedule feeds (the standard format agencies publish). They are
downloaded by `dispatch-lab setup-transit` and are not stored in this repo;
see docs/transit.md for sources and terms.

Simplifications, all stated in docs/transit.md:
  * Vehicles run exactly on schedule.
  * Walking follows the street network (no freeways) at 1.3 m/s; walk legs are
    drawn as straight lines on the map.
  * Rides are drawn as straight lines between consecutive stops.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
from numba import njit
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from .network import CLASS_ID, DATA_DIR, RoadNetwork, Route
from .traffic import DAYS

GTFS_DIR = DATA_DIR / "raw" / "gtfs"
FEEDS = {
    # Sound Transit retires this combined file at the end of 2026; after that,
    # list the per-agency feeds here instead (build() accepts several).
    "puget_sound": "https://gtfs.sound.obaweb.org/prod/gtfs_puget_sound_consolidated.zip",
}

WALK_MPS = 1.3
WALK_LIMIT_S = 1500.0  # the farthest a courier walks to or from a stop (25 min)
TRANSFER_M = 250.0  # stops this close (straight line) are a walking transfer
DETOUR = 1.3  # straight-line distance -> walking distance, for transfers
HORIZON_S = 2.5 * 3600  # give up on trips longer than this
BBOX_MARGIN_DEG = 0.004

ACCESS, FOOTPATH = -1, -2  # how a stop was reached, when not by a ride


def timetable_path(day: str) -> Path:
    return DATA_DIR / f"transit_{day}.npz"


# --------------------------------------------------------------------- build


def download() -> list[Path]:
    import httpx

    GTFS_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, url in FEEDS.items():
        path = GTFS_DIR / f"{name}.zip"
        print(f"Downloading {url} ...")
        with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
            r.raise_for_status()
            with path.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        paths.append(path)
    return paths


def _read(zf: zipfile.ZipFile, name: str, **kw):
    import pandas as pd

    if name not in zf.namelist():
        return None
    with zf.open(name) as f:
        return pd.read_csv(io.TextIOWrapper(f, encoding="utf-8-sig"), dtype=str, **kw)


def _seconds(col) -> np.ndarray:
    """'HH:MM:SS' (hours may pass 24) -> seconds after midnight; blank -> NaN."""
    parts = col.str.split(":", expand=True)
    ok = col.notna() & (col.str.len() > 0)
    out = np.full(len(col), np.nan)
    if not ok.any():
        return out
    p = parts[ok.values].astype(float)
    out[ok.values] = p[0] * 3600 + p[1] * 60 + p[2]
    return out


def _active_services(calendar, calendar_dates, on: date) -> set[str]:
    ymd = on.strftime("%Y%m%d")
    active: set[str] = set()
    if calendar is not None:
        weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        c = calendar[
            (calendar[weekday[on.weekday()]] == "1")
            & (calendar["start_date"] <= ymd)
            & (calendar["end_date"] >= ymd)
        ]
        active |= set(c["service_id"])
    if calendar_dates is not None:
        today = calendar_dates[calendar_dates["date"] == ymd]
        active |= set(today[today["exception_type"] == "1"]["service_id"])
        active -= set(today[today["exception_type"] == "2"]["service_id"])
    return active


def build(
    zips: list[Path],
    net: RoadNetwork,
    day: str = "Fri",
    on: date | None = None,
    out: Path | None = None,
) -> Path:
    """Turn GTFS feeds into one service day of stop-to-stop hops inside the city."""
    import pandas as pd

    lo = (net.node_lon.min() - BBOX_MARGIN_DEG, net.node_lat.min() - BBOX_MARGIN_DEG)
    hi = (net.node_lon.max() + BBOX_MARGIN_DEG, net.node_lat.max() + BBOX_MARGIN_DEG)
    stops_all, conns_all, trips_all, feeds = [], [], [], []

    for i, path in enumerate(zips):
        pre = f"{i}:"  # feeds reuse ids, so every id is prefixed by its feed
        with zipfile.ZipFile(path) as zf:
            calendar = _read(zf, "calendar.txt")
            calendar_dates = _read(zf, "calendar_dates.txt")
            trips = _read(zf, "trips.txt", usecols=["route_id", "trip_id", "service_id"])
            routes = _read(zf, "routes.txt")
            stops = _read(zf, "stops.txt")

            # Service day: the given date, or the busiest of the next five such weekdays
            # (which steps around holidays with reduced service).
            if on is None:
                first = date.today()
                first += timedelta(days=(DAYS.index(day) - first.weekday()) % 7)
                options = [first + timedelta(weeks=w) for w in range(5)]
            else:
                options = [on]
            counts = [
                int(trips["service_id"].isin(_active_services(calendar, calendar_dates, d)).sum())
                for d in options
            ]
            chosen = options[int(np.argmax(counts))]
            trips = trips[
                trips["service_id"].isin(_active_services(calendar, calendar_dates, chosen))
            ]

            stops["lon"] = stops["stop_lon"].astype(float)
            stops["lat"] = stops["stop_lat"].astype(float)
            inside = stops[stops["lon"].between(lo[0], hi[0]) & stops["lat"].between(lo[1], hi[1])]
            inside_ids = set(inside["stop_id"])
            active_trips = set(trips["trip_id"])

            chunks = []
            with zf.open("stop_times.txt") as f:
                reader = pd.read_csv(
                    io.TextIOWrapper(f, encoding="utf-8-sig"),
                    dtype=str,
                    chunksize=500_000,
                    usecols=[
                        "trip_id",
                        "stop_id",
                        "arrival_time",
                        "departure_time",
                        "stop_sequence",
                    ],
                )
                chunks = [c[c["trip_id"].isin(active_trips)] for c in reader]
            st = pd.concat(chunks, ignore_index=True)

        st["arr"] = _seconds(st["arrival_time"])
        st["dep"] = _seconds(st["departure_time"])
        st = st.dropna(subset=["arr", "dep"])  # stops without a scheduled time are skipped
        st["seq"] = st["stop_sequence"].astype(int)
        st = st.sort_values(["trip_id", "seq"], kind="stable").reset_index(drop=True)
        same = st["trip_id"].values[1:] == st["trip_id"].values[:-1]
        hops = pd.DataFrame(
            {
                "trip": st["trip_id"].values[:-1][same],
                "from": st["stop_id"].values[:-1][same],
                "to": st["stop_id"].values[1:][same],
                "dep": st["dep"].values[:-1][same],
                "arr": st["arr"].values[1:][same],
            }
        )
        hops = hops[hops["from"].isin(inside_ids) & hops["to"].isin(inside_ids)]
        hops = hops[hops["arr"] >= hops["dep"]]

        label = routes["route_short_name"].fillna("")
        label = label.where(label.str.len() > 0, routes["route_long_name"].fillna(""))
        routes = routes.assign(label=label)[["route_id", "label", "route_type"]]
        used = trips[trips["trip_id"].isin(set(hops["trip"]))].merge(routes, on="route_id")
        used_stops = inside[inside["stop_id"].isin(set(hops["from"]) | set(hops["to"]))]

        stops_all.append(used_stops.assign(stop_id=pre + used_stops["stop_id"]))
        conns_all.append(
            hops.assign(
                trip=pre + hops["trip"], **{"from": pre + hops["from"], "to": pre + hops["to"]}
            )
        )
        trips_all.append(used.assign(trip_id=pre + used["trip_id"]))
        feeds.append({"file": path.name, "service_date": chosen.isoformat(), "trips": len(used)})

    stops = pd.concat(stops_all, ignore_index=True)
    hops = pd.concat(conns_all, ignore_index=True).sort_values(["dep", "arr"], kind="stable")
    trips = pd.concat(trips_all, ignore_index=True)
    stop_index = {s: k for k, s in enumerate(stops["stop_id"])}
    trip_index = {t: k for k, t in enumerate(trips["trip_id"])}

    out = out or timetable_path(day)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        stop_lon=stops["lon"].values,
        stop_lat=stops["lat"].values,
        stop_name=np.array(stops["stop_name"].fillna("").tolist(), dtype=np.str_),
        dep_stop=hops["from"].map(stop_index).values.astype(np.int32),
        arr_stop=hops["to"].map(stop_index).values.astype(np.int32),
        dep_t=hops["dep"].values.astype(np.float64),
        arr_t=hops["arr"].values.astype(np.float64),
        trip=hops["trip"].map(trip_index).values.astype(np.int32),
        trip_label=np.array(trips["label"].fillna("").tolist(), dtype=np.str_),
        trip_type=trips["route_type"].astype(int).values.astype(np.int16),
        meta=np.array(json.dumps({"day": day, "feeds": feeds})),
    )
    print(
        f"Saved {len(stops):,} stops, {len(trips):,} trips and {len(hops):,} hops "
        f"for {day} ({', '.join(f['service_date'] for f in feeds)}) to {out}"
    )
    return out


# ------------------------------------------------------------------- planner


@njit(cache=True)
def _scan(dep_stop, arr_stop, dep_t, arr_t, trip, fp_ptr, fp_stop, fp_time,
          start, t_limit, ea, how, came_from, board):  # fmt: skip
    """Connection scan. `ea` enters holding the start times at the access stops."""
    for c in range(start, len(dep_t)):
        if dep_t[c] > t_limit:
            break
        t = trip[c]
        if board[t] >= 0 or ea[dep_stop[c]] <= dep_t[c]:
            if board[t] < 0:
                board[t] = c
            a = arr_stop[c]
            if arr_t[c] < ea[a]:
                ea[a] = arr_t[c]
                how[a] = c
                for k in range(fp_ptr[a], fp_ptr[a + 1]):
                    s2 = fp_stop[k]
                    t2 = arr_t[c] + fp_time[k]
                    if t2 < ea[s2]:
                        ea[s2] = t2
                        how[s2] = FOOTPATH
                        came_from[s2] = a


@dataclass
class Scan:
    t0: float
    ea: np.ndarray  # earliest arrival clock time at every stop
    how: np.ndarray
    came_from: np.ndarray
    board: np.ndarray


class TransitNetwork:
    def __init__(self, arrays: dict[str, np.ndarray], net: RoadNetwork):
        self.net = net
        self.stop_lon = arrays["stop_lon"].astype(np.float64)
        self.stop_lat = arrays["stop_lat"].astype(np.float64)
        self.stop_name = arrays["stop_name"]
        self.dep_stop = arrays["dep_stop"].astype(np.int32)
        self.arr_stop = arrays["arr_stop"].astype(np.int32)
        self.dep_t = arrays["dep_t"].astype(np.float64)
        self.arr_t = arrays["arr_t"].astype(np.float64)
        self.trip = arrays["trip"].astype(np.int32)
        self.trip_label = arrays["trip_label"]
        self.trip_type = arrays["trip_type"]
        self.meta = json.loads(str(arrays["meta"])) if "meta" in arrays else {}
        self.n_stops = len(self.stop_lon)
        self.n_trips = len(self.trip_label)
        assert (np.diff(self.dep_t) >= 0).all(), "hops must be sorted by departure"

        # Next hop of the same trip, to walk along a ride when drawing it.
        self.next_hop = np.full(len(self.trip), -1, dtype=np.int64)
        last: dict[int, int] = {}
        for c in range(len(self.trip) - 1, -1, -1):
            t = int(self.trip[c])
            self.next_hop[c] = last.get(t, -1)
            last[t] = c

        # Walking: the street network without freeways, usable in both directions.
        walkable = net.edge_class >= CLASS_ID["arterial"]
        u, v = net.edge_u[walkable].astype(np.int64), net.edge_v[walkable].astype(np.int64)
        seconds = net.edge_len[walkable].astype(np.float64) / WALK_MPS
        key = np.minimum(u, v) * net.n_nodes + np.maximum(u, v)  # one key per street segment
        order = np.lexsort((seconds, key))
        first = order[np.r_[True, np.diff(key[order]) > 0]]  # shortest edge per pair
        a, b, w = np.minimum(u, v)[first], np.maximum(u, v)[first], seconds[first]
        self.walk_graph = csr_matrix(
            (np.r_[w, w], (np.r_[a, b], np.r_[b, a])), shape=(net.n_nodes, net.n_nodes)
        )

        stop_xy = net.to_xy(np.column_stack([self.stop_lon, self.stop_lat]))
        self.stop_xy = stop_xy
        self.stop_node = net.nearest_node(np.column_stack([self.stop_lon, self.stop_lat]))

        # Walking transfers between nearby stops.
        pairs = cKDTree(stop_xy).query_pairs(TRANSFER_M, output_type="ndarray")
        a = np.r_[pairs[:, 0], pairs[:, 1]] if len(pairs) else np.zeros(0, dtype=np.int64)
        b = np.r_[pairs[:, 1], pairs[:, 0]] if len(pairs) else np.zeros(0, dtype=np.int64)
        order = np.argsort(a, kind="stable")
        a, b = a[order], b[order]
        self.fp_ptr = np.zeros(self.n_stops + 1, dtype=np.int64)
        np.cumsum(np.bincount(a, minlength=self.n_stops), out=self.fp_ptr[1:])
        self.fp_stop = b.astype(np.int32)
        self.fp_time = np.hypot(*(stop_xy[a] - stop_xy[b]).T) * DETOUR / WALK_MPS + 30.0

        self._near: dict[int, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}

    @classmethod
    def load(cls, net: RoadNetwork, day: str = "Fri") -> TransitNetwork:
        return _load(net, day)

    # -- walking ------------------------------------------------------------

    def _reach(self, node: int):
        """Everything within walking range of a node: (nodes, seconds, stops, seconds)."""
        hit = self._near.get(node)
        if hit is None:
            dist = dijkstra(self.walk_graph, directed=True, indices=node, limit=WALK_LIMIT_S)
            nodes = np.flatnonzero(np.isfinite(dist))
            to_stop = dist[self.stop_node]
            stops = np.flatnonzero(np.isfinite(to_stop))
            hit = (nodes, dist[nodes], stops, to_stop[stops])
            self._near[node] = hit
        return hit

    def near_stops(self, node: int) -> tuple[np.ndarray, np.ndarray]:
        hit = self._reach(node)
        return hit[2], hit[3]

    def walk_time(self, a: int, b: int) -> float:
        """Seconds on foot, or inf when farther than the walking limit."""
        nodes, seconds, _, _ = self._reach(a)
        k = int(np.searchsorted(nodes, b))
        return float(seconds[k]) if k < len(nodes) and nodes[k] == b else float("inf")

    def long_walk_time(self, a: int, b: int) -> float:
        """Seconds on foot with no limit (the fallback when transit cannot help)."""
        d = float(dijkstra(self.walk_graph, directed=True, indices=a)[b])
        if np.isfinite(d):
            return d
        return float(np.hypot(*(self.net.node_xy[a] - self.net.node_xy[b])) * DETOUR / WALK_MPS)

    # -- planning -----------------------------------------------------------

    def scan(self, node: int, t0: float) -> Scan:
        """Earliest arrival at every stop for someone leaving `node` at clock time t0."""
        stops, walk = self.near_stops(node)
        ea = np.full(self.n_stops, np.inf)
        ea[stops] = t0 + walk
        how = np.full(self.n_stops, ACCESS, dtype=np.int64)
        came_from = np.full(self.n_stops, -1, dtype=np.int64)
        board = np.full(self.n_trips, -1, dtype=np.int64)
        start = int(np.searchsorted(self.dep_t, t0))
        _scan(self.dep_stop, self.arr_stop, self.dep_t, self.arr_t, self.trip,
              self.fp_ptr, self.fp_stop, self.fp_time, start, t0 + HORIZON_S,
              ea, how, came_from, board)  # fmt: skip
        return Scan(t0, ea, how, came_from, board)

    def _best(self, scan: Scan, a: int, b: int) -> tuple[float, int]:
        """(arrival clock time at node b, egress stop or -1 for walking all the way)."""
        stops, walk = self.near_stops(b)
        best, stop = float("inf"), -1
        if len(stops):
            via = scan.ea[stops] + walk
            k = int(np.argmin(via))
            best, stop = float(via[k]), int(stops[k])
        direct = scan.t0 + self.walk_time(a, b)
        if direct <= best:
            best, stop = direct, -1
        if not np.isfinite(best):
            best, stop = scan.t0 + self.long_walk_time(a, b), -1
        return best, stop

    def times_from(self, node: int, t0: float, targets: list[int]) -> np.ndarray:
        """Door-to-door seconds from `node`, leaving at t0, to each target node."""
        scan = self.scan(node, t0)
        return np.array([self._best(scan, node, b)[0] - t0 for b in targets])

    def journey(self, a: int, b: int, t0: float) -> Route:
        """The fastest trip from node a to node b leaving at clock time t0, as a Route."""
        net = self.net
        scan = self.scan(a, t0)
        arrive, stop = self._best(scan, a, b)
        here, there = net.node_lonlat(a), net.node_lonlat(b)
        if stop < 0:
            return self._route([(t0, here), (arrive, there)], [(t0, "Walking")])

        def at(s: int) -> tuple[float, float]:
            return float(self.stop_lon[s]), float(self.stop_lat[s])

        # Follow the "how did I get here" pointers back from the last stop. Each
        # step yields one piece of the trip (points and a label, both in forward
        # order); the pieces come out last-first and are reversed at the end.
        ea = scan.ea
        pieces = [
            (
                [(float(ea[stop]), at(stop)), (arrive, there)],
                [(float(ea[stop]), "Walking from the stop")],
            )
        ]
        for _ in range(64):
            how = int(scan.how[stop])
            if how == ACCESS:
                label = f"Walking to {self.stop_name[stop]}"
                pieces.append(([(t0, here), (float(ea[stop]), at(stop))], [(t0, label)]))
                break
            if how == FOOTPATH:
                origin = int(scan.came_from[stop])
                label = f"Walking to {self.stop_name[stop]}"
                pieces.append(
                    ([(float(ea[origin]), at(origin)), (float(ea[stop]), at(stop))],
                     [(float(ea[origin]), label)])
                )  # fmt: skip
                stop = origin
                continue
            first = int(scan.board[self.trip[how]])
            board_stop = int(self.dep_stop[first])
            points = [
                (float(ea[board_stop]), at(board_stop)),
                (float(self.dep_t[first]), at(board_stop)),
            ]
            c = first
            while True:
                points.append((float(self.arr_t[c]), at(int(self.arr_stop[c]))))
                if c == how:
                    break
                c = int(self.next_hop[c])
                points.append(
                    (float(self.dep_t[c]), at(int(self.dep_stop[c])))
                )  # dwell at the stop
            labels = [
                (float(ea[board_stop]), f"Waiting at {self.stop_name[board_stop]}"),
                (float(self.dep_t[first]), f"Riding {self.trip_label[self.trip[how]]}"),
            ]
            pieces.append((points, labels))
            stop = board_stop
        pieces.reverse()
        return self._route(
            [p for points, _ in pieces for p in points], [leg for _, legs in pieces for leg in legs]
        )

    def _route(self, points, legs) -> Route:
        t = np.maximum.accumulate(np.array([p[0] for p in points]))
        lonlat = np.array([p[1] for p in points])
        meters = float(np.hypot(*np.diff(self.net.to_xy(lonlat), axis=0).T).sum())
        return Route(lonlat, t, meters, legs)

    def lines(self, max_m: float = 3500.0) -> list[list[list[float]]]:
        """Distinct stop-to-stop segments, for drawing the network on the map.

        Long express hops (across the lake, down the freeway) are left out: drawn
        as straight lines they clutter the map without showing where the bus runs.
        """
        pairs = np.unique(np.column_stack([self.dep_stop, self.arr_stop]), axis=0)
        length = np.hypot(*(self.stop_xy[pairs[:, 0]] - self.stop_xy[pairs[:, 1]]).T)
        lon, lat = np.round(self.stop_lon, 5), np.round(self.stop_lat, 5)
        return [
            [[float(lon[a]), float(lat[a])], [float(lon[b]), float(lat[b])]]
            for a, b in pairs[length <= max_m]
        ]


@lru_cache(maxsize=4)
def _load(net: RoadNetwork, day: str) -> TransitNetwork:
    path = timetable_path(day)
    if not path.exists():
        zips = sorted(GTFS_DIR.glob("*.zip"))
        if not zips:
            raise FileNotFoundError(
                "No transit timetable found. Run `uv run dispatch-lab setup-transit` first."
            )
        build(zips, net, day)
    with np.load(path) as data:
        return TransitNetwork({k: data[k] for k in data.files}, net)
