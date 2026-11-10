"""A small made-up street grid, so tests run without downloading Seattle."""

import numpy as np
import pytest

from seattle_dispatch_lab.network import CLASS_ID, RoadNetwork

GRID = 12  # 12 x 12 intersections
BLOCK_M = 400.0
EDGE_S = 40.0  # every block takes 40 s at free flow


@pytest.fixture(scope="session")
def grid() -> RoadNetwork:
    lon0, lat0 = -122.35, 47.60
    dlon = BLOCK_M / (111_320.0 * np.cos(np.radians(lat0)))
    dlat = BLOCK_M / 110_540.0
    idx = lambda r, c: r * GRID + c
    node_lon = np.array([lon0 + c * dlon for r in range(GRID) for c in range(GRID)])
    node_lat = np.array([lat0 + r * dlat for r in range(GRID) for c in range(GRID)])
    edges = set()
    for r in range(GRID):
        for c in range(GRID):
            if c + 1 < GRID:
                edges |= {(idx(r, c), idx(r, c + 1)), (idx(r, c + 1), idx(r, c))}
            if r + 1 < GRID:
                edges |= {(idx(r, c), idx(r + 1, c)), (idx(r + 1, c), idx(r, c))}
    edges = sorted(edges)
    u = np.array([e[0] for e in edges], dtype=np.int32)
    v = np.array([e[1] for e in edges], dtype=np.int32)
    geom = np.empty((2 * len(edges), 2))
    geom[0::2] = np.column_stack([node_lon[u], node_lat[u]])
    geom[1::2] = np.column_stack([node_lon[v], node_lat[v]])
    return RoadNetwork(
        {
            "node_lon": node_lon,
            "node_lat": node_lat,
            "edge_u": u,
            "edge_v": v,
            "edge_len": np.full(len(edges), BLOCK_M, dtype=np.float32),
            "edge_time": np.full(len(edges), EDGE_S, dtype=np.float32),
            "edge_class": np.full(len(edges), CLASS_ID["arterial"], dtype=np.uint8),
            "geom_xy": geom,
            "geom_off": np.arange(0, 2 * len(edges) + 1, 2, dtype=np.int64),
            "residential_nodes": np.arange(GRID * GRID, dtype=np.int32),
            "venue_lonlat": np.column_stack([node_lon, node_lat])[::3],
        }
    )
