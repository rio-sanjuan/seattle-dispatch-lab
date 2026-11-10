import io
import zipfile
from datetime import date

import numpy as np
import pytest

from seattle_dispatch_lab import transit
from seattle_dispatch_lab.sim import Simulation
from seattle_dispatch_lab.transit import WALK_MPS, TransitNetwork

from .conftest import BLOCK_M, GRID
from .test_sim import small

WALK_BLOCK_S = BLOCK_M / WALK_MPS  # about 308 s: walking one block
RIDE_S = 30.0  # a bus covers one block in 30 s
HEADWAY_S = 600.0
T0 = 12 * 3600.0


def node(row: int, col: int) -> int:
    return row * GRID + col


def bus_network(grid) -> TransitNetwork:
    """Line A runs east along row 0; line B runs north up the last column.

    Each has a stop at every intersection and a bus every 10 minutes, all day.
    They meet at the corner (row 0, last column).
    """
    stops = [node(0, c) for c in range(GRID)] + [node(r, GRID - 1) for r in range(1, GRID)]
    index = {n: i for i, n in enumerate(stops)}
    hops, labels = [], []
    for line, path in (
        ("A", [node(0, c) for c in range(GRID)]),
        ("B", [node(r, GRID - 1) for r in range(GRID)]),
    ):
        for k in range(100):
            start = 6 * 3600 + k * HEADWAY_S + (0 if line == "A" else 120)
            trip = len(labels)
            labels.append(line)
            for i in range(len(path) - 1):
                hops.append(
                    (
                        start + i * RIDE_S,
                        start + (i + 1) * RIDE_S,
                        index[path[i]],
                        index[path[i + 1]],
                        trip,
                    )
                )
    hops.sort()
    return TransitNetwork(
        {
            "stop_lon": grid.node_lon[stops],
            "stop_lat": grid.node_lat[stops],
            "stop_name": np.array([f"stop {n}" for n in stops]),
            "dep_t": np.array([h[0] for h in hops]),
            "arr_t": np.array([h[1] for h in hops]),
            "dep_stop": np.array([h[2] for h in hops], dtype=np.int32),
            "arr_stop": np.array([h[3] for h in hops], dtype=np.int32),
            "trip": np.array([h[4] for h in hops], dtype=np.int32),
            "trip_label": np.array(labels),
            "trip_type": np.full(len(labels), 3, dtype=np.int16),
        },
        grid,
    )


@pytest.fixture(scope="module")
def buses(grid) -> TransitNetwork:
    return bus_network(grid)


def test_walking_uses_the_street_grid(buses):
    assert buses.walk_time(node(3, 3), node(3, 4)) == pytest.approx(WALK_BLOCK_S)
    assert buses.walk_time(node(3, 3), node(5, 4)) == pytest.approx(3 * WALK_BLOCK_S)
    assert buses.walk_time(node(0, 0), node(11, 11)) == float("inf")  # beyond the walking limit
    assert buses.long_walk_time(node(0, 0), node(11, 11)) == pytest.approx(22 * WALK_BLOCK_S)


def test_ride_waits_for_the_next_bus(buses):
    # Standing at the first stop at 12:01: the 12:00 bus has gone, the next is 12:10.
    route = buses.journey(node(0, 0), node(0, 8), T0 + 60)
    assert route.end == pytest.approx(T0 + HEADWAY_S + 8 * RIDE_S)
    assert [label for _, label in route.legs][-3:-1] == ["Waiting at stop 0", "Riding A"]
    # One minute earlier and the courier is on the 12:00 bus: ten minutes saved.
    earlier = buses.journey(node(0, 0), node(0, 8), T0)
    assert route.end - earlier.end == pytest.approx(HEADWAY_S)


def test_short_trips_are_walked(buses):
    # One block, well away from both lines: no bus can beat walking it.
    route = buses.journey(node(5, 5), node(5, 6), T0 + 60)
    assert route.end - route.start == pytest.approx(WALK_BLOCK_S)
    assert route.legs == [(T0 + 60, "Walking")]


def test_transfer_between_lines(buses):
    # East on A to the corner, then north on B, which leaves the corner 2 minutes after
    # A's first departure plus 0 s travel: B passes the corner at start + 0.
    route = buses.journey(node(0, 0), node(6, GRID - 1), T0)
    riding = [label for _, label in route.legs if label.startswith("Riding")]
    assert riding == ["Riding A", "Riding B"]
    a_arrives = T0 + (GRID - 1) * RIDE_S  # 12:05:30 at the corner
    b_leaves = T0 + HEADWAY_S + 120  # the 12:02 B has gone; next is 12:12
    assert a_arrives < b_leaves
    assert route.end == pytest.approx(b_leaves + 6 * RIDE_S)
    assert (np.diff(route.t) >= 0).all()
    assert route.position(route.end) == pytest.approx(buses.net.node_lonlat(node(6, GRID - 1)))


def test_times_from_matches_journey(buses):
    targets = [node(0, 8), node(4, GRID - 1), node(2, 2), node(0, 1)]
    times = buses.times_from(node(1, 0), T0 + 30, targets)
    for target, seconds in zip(targets, times, strict=True):
        route = buses.journey(node(1, 0), target, T0 + 30)
        assert seconds == pytest.approx(route.end - route.start)


@pytest.mark.parametrize("mode", ["transit", "mixed"])
def test_simulation_with_transit_couriers(grid, buses, mode):
    sim = Simulation(small(courier_mode=mode, n_drivers=30), grid, transit=buses).run()
    modes = {d.mode for d in sim.drivers}
    assert modes == ({"transit"} if mode == "transit" else {"car", "transit"})
    assert len(sim.done) > 30
    for o in sim.done:
        assert o.placed <= o.assigned <= o.at_restaurant <= o.picked_up <= o.delivered
        assert o.picked_up >= o.ready
    s = sim.summary()
    assert s["transit_delivery_share_pct"] > 0
    if mode == "mixed":
        assert s["avg_delivery_min_car"] < s["avg_delivery_min_transit"]


def test_fleet_mix_does_not_change_the_orders(grid, buses):
    def world(mode):
        sim = Simulation(small(courier_mode=mode), grid, transit=buses)
        orders = sorted((e[3] for e in sim._events if e[2] == "order"), key=lambda o: o.id)
        return [(o.placed, o.restaurant, o.customer_node, o.ready) for o in orders]

    assert world("car") == world("mixed") == world("transit")


def gtfs_zip(path):
    files = {
        "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n"
        "a,Stop A,47.6000,-122.3500\nb,Stop B,47.6040,-122.3500\nc,Stop C,47.6080,-122.3500\nfar,Far away,48.5,-121.0\n",
        "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,10,,3\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "wk,1,1,1,1,1,0,0,20260101,20261231\nsat,0,0,0,0,0,1,0,20260101,20261231\n",
        "calendar_dates.txt": "service_id,date,exception_type\nholiday,20261120,1\nwk,20261127,2\n",
        "trips.txt": "route_id,trip_id,service_id\nr1,t1,wk\nr1,t2,wk\nr1,t3,sat\nr1,t4,holiday\n",
        "stop_times.txt": "trip_id,stop_id,arrival_time,departure_time,stop_sequence\n"
        "t1,a,08:00:00,08:00:00,1\nt1,b,08:05:00,08:05:30,2\nt1,c,08:10:00,08:10:00,3\nt1,far,09:00:00,09:00:00,4\n"
        "t2,a,25:00:00,25:00:00,1\nt2,b,,,2\nt2,c,25:10:00,25:10:00,3\n"
        "t3,a,10:00:00,10:00:00,1\nt3,b,10:05:00,10:05:00,2\n"
        "t4,a,12:00:00,12:00:00,1\nt4,b,12:05:00,12:05:00,2\n",
    }
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, io.StringIO(text).getvalue())
    return path


def test_build_reads_one_service_day(grid, tmp_path):
    feed = gtfs_zip(tmp_path / "feed.zip")
    out = transit.build([feed], grid, "Fri", on=date(2026, 11, 20), out=tmp_path / "fri.npz")
    with np.load(out) as data:
        t = TransitNetwork({k: data[k] for k in data.files}, grid)
    # Friday 20 Nov: weekday trips t1 and t2, plus the one-day "holiday" trip t4. Not Saturday's t3.
    # t1 has two hops inside the area (the hop to the far stop is dropped); t2 skips the
    # untimed middle stop and becomes one hop; t4 has one hop.
    assert sorted(t.dep_t.tolist()) == [8 * 3600, 8 * 3600 + 330, 12 * 3600, 25 * 3600]
    assert t.n_stops == 3 and t.n_trips == 3
    assert set(t.trip_label.tolist()) == {"10"}
    assert t.meta["feeds"][0]["service_date"] == "2026-11-20"

    # The following Friday the weekday service is cancelled by calendar_dates.
    out = transit.build([feed], grid, "Fri", on=date(2026, 11, 27), out=tmp_path / "off.npz")
    with np.load(out) as data:
        assert len(data["dep_t"]) == 0
