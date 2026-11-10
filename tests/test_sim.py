from itertools import pairwise

import numpy as np
import pytest

from seattle_dispatch_lab.dispatch import DISPATCHERS
from seattle_dispatch_lab.sim import SimConfig, Simulation
from seattle_dispatch_lab.traffic import Traffic

from .conftest import EDGE_S, GRID


def small(dispatcher="matching_jit", **kw) -> SimConfig:
    base = {
        "seed": 3,
        "hours": 3.0,
        "start_hour": 11.0,
        "n_restaurants": 20,
        "n_drivers": 18,
        "peak_orders_per_hour": 90.0,
        "delivery_radius_m": 2500.0,
        "dispatcher": dispatcher,
    }
    return SimConfig(**{**base, **kw})


def test_route_time_and_position(grid):
    g = grid.graph(grid.edge_time)
    route = grid.route(g, 0, GRID * GRID - 1, depart=100.0)
    blocks = 2 * (GRID - 1)
    assert route.end - route.start == pytest.approx(blocks * EDGE_S)
    assert route.position(100.0) == pytest.approx(grid.node_lonlat(0))
    assert route.position(1e9) == pytest.approx(grid.node_lonlat(GRID * GRID - 1))
    # Halfway along the first block after half its travel time.
    lon, lat = route.position(100.0 + EDGE_S / 2)
    a, b = route.lonlat[0], route.lonlat[1]
    assert (lon, lat) == pytest.approx(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))


def test_times_to_and_from_agree_with_routes(grid):
    g = grid.graph(grid.edge_time)
    targets = np.array([5, 77])
    to = grid.times_to(g, targets)
    frm = grid.times_from(g, targets)
    for i, t in enumerate(targets):
        r = grid.route(g, 30, int(t), 0.0)
        assert to[i, 30] == pytest.approx(r.end)
        assert frm[i, 30] == pytest.approx(r.end)  # the grid is symmetric


@pytest.mark.parametrize("name", sorted(DISPATCHERS))
def test_every_order_follows_the_lifecycle(grid, name):
    sim = Simulation(small(name), grid).run()
    assert len(sim.done) > 50
    assert len(sim.done) + len(sim.active) == sim.n_placed == sim.n_scheduled
    for o in sim.done:
        assert o.placed <= o.assigned <= o.at_restaurant <= o.picked_up <= o.delivered
        assert o.picked_up >= o.ready  # nobody leaves before the food exists
        assert o.picked_up >= o.at_restaurant + o.pickup_overhead_s - 1e-6
        assert o.driver not in o.declined
    # A driver is only ever on one order at a time.
    by_driver: dict[int, list] = {}
    for o in sim.done:
        by_driver.setdefault(o.driver, []).append((o.assigned, o.delivered))
    for spans in by_driver.values():
        spans.sort()
        assert all(a[1] <= b[0] for a, b in pairwise(spans))


def test_same_seed_same_result(grid):
    a = Simulation(small(), grid).run().summary()
    b = Simulation(small(), grid).run().summary()
    assert a == b


def test_dispatchers_face_the_same_world(grid):
    worlds = []
    for name in DISPATCHERS:
        sim = Simulation(small(name), grid)
        orders = sorted((e[3] for e in sim._events if e[2] == "order"), key=lambda o: o.id)
        worlds.append([(o.placed, o.restaurant, o.customer_node, o.ready) for o in orders])
    assert worlds[0] == worlds[1] == worlds[2]


def test_run_until_is_incremental(grid):
    whole = Simulation(small(), grid).run()
    stepped = Simulation(small(), grid)
    while not stepped.finished:
        stepped.run_until(stepped.now + 7.3)
        stepped.snapshot()  # reading the state must not change it
    assert stepped.summary() == whole.summary()


def test_traffic_profile_is_sane():
    friday_5pm = Traffic(4 * 86400 + 17 * 3600)
    sunday_5am = Traffic(6 * 86400 + 5 * 3600)
    assert (friday_5pm.table >= 1.0).all()
    rush, quiet = friday_5pm.multipliers(0.0), sunday_5am.multipliers(0.0)
    assert (rush >= quiet).all()
    assert rush[1] > 2.0  # I-5 southbound on a Friday evening
    assert friday_5pm.clock(90 * 60) == "Fri 18:30"
    assert (Traffic(0.0, scale=0.0).table == 1.0).all()
