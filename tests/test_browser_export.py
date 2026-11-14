import json
import struct

import numpy as np

from seattle_dispatch_lab import browser_export as bx
from seattle_dispatch_lab.sim import Simulation

from .test_sim import small


def read_header(blob: bytes) -> tuple[dict, int]:
    assert blob[:4] == bx.MAGIC
    version, length = struct.unpack("<II", blob[4:12])
    assert version == bx.VERSION
    return json.loads(blob[12 : 12 + length]), 12 + length


def test_network_file_keeps_times_and_lengths_exactly(grid):
    blob = bx.network_bin(grid)
    header, base = read_header(blob)
    arrays = {a["name"]: a for a in header["arrays"]}
    assert header["n_nodes"] == grid.n_nodes and header["n_edges"] == grid.n_edges

    def read(name, dtype):
        a = arrays[name]
        return np.frombuffer(blob, dtype=dtype, count=a["length"], offset=base + a["offset"])

    assert np.array_equal(read("edge_time", "<f4"), grid.edge_time.astype("<f4"))
    assert np.array_equal(read("edge_len", "<f4"), grid.edge_len)
    assert np.array_equal(read("edge_u", "<u2"), grid.edge_u)
    assert np.array_equal(read("edge_class", "u1"), grid.edge_class)
    # Every edge keeps at least its two ends, and coordinates survive to about a meter.
    counts = read("geom_count", "<u2")
    assert (counts >= 2).all() and counts.sum() * 2 == arrays["geom_q"]["length"]
    lon0, _, lon1, _ = header["bbox"]
    q = read("node_q", "<u2").reshape(-1, 2)
    lon = lon0 + q[:, 0] / 65535 * (lon1 - lon0)
    assert (
        np.abs(grid.to_xy(np.column_stack([lon, grid.node_lat]))[:, 0] - grid.node_xy[:, 0]).max()
        < 1
    )


def test_simplify_keeps_the_shape_within_tolerance():
    x = np.linspace(0, 100, 51)
    wiggle = np.column_stack([x, 0.3 * np.sin(x)])  # under the 1.5 m tolerance: a straight line
    assert bx._simplify(wiggle, 1.5).sum() == 2
    corner = np.array([[0, 0], [50, 0], [50, 50.0]])
    assert bx._simplify(corner, 1.5).all()


def test_reference_run_can_be_replayed(grid):
    ref = bx.reference_run(small(), grid, ["nearest", "matching_jit"])
    sim = Simulation(small(), grid)
    assert len(ref["world"]["orders"]) == sim.n_scheduled
    assert len(ref["world"]["drivers"]) == len(sim.drivers)
    run = ref["runs"]["matching_jit"]
    # One draw for each offer's reply delay, one for each reply that happened.
    offers = run["summary"]["offers"]
    assert offers <= len(run["behaviour"]) <= 2 * offers
    assert run["summary"]["delivered"] == len(run["orders"])
    json.dumps(ref, allow_nan=False)  # nothing JavaScript cannot read
