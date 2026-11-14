"""The simulated world: restaurants, customers, drivers, and a clock.

The engine is event-driven. Things that happen at a known future time (an order
is placed, a driver arrives, the dispatcher wakes up) sit in a priority queue;
`run_until(t)` pops and handles them in order. Driver positions between events
are interpolated along their route, so the engine never steps frame by frame.

Everything the dispatcher is *not* told (true food-ready times, true drive
times, who will decline) is decided here. The dispatcher only gets estimates.
"""

from __future__ import annotations

import heapq
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .dispatch import DISPATCHERS, DROPOFF_OVERHEAD_S, OFFER_REPLY_S, DispatchView
from .names import restaurant_names
from .network import CLASS_ID, RoadNetwork, Route
from .traffic import DAYS, Traffic

# Driver states
OFFLINE, IDLE, OFFERED, TO_RESTAURANT, AT_RESTAURANT, TO_CUSTOMER, AT_DOOR = range(7)
DRIVER_STATES = [
    "offline", "idle", "offered", "to_restaurant", "at_restaurant",
    "to_customer", "at_door",
]  # fmt: skip
# Order states
OPEN, O_OFFERED, ASSIGNED, COLLECTING, EN_ROUTE, DELIVERED = range(6)
ORDER_STATES = ["open", "offered", "assigned", "collecting", "en_route", "delivered"]


COURIER_MODES = ["car", "transit", "mixed"]


@dataclass
class SimConfig:
    seed: int = 7
    start_day: str = "Fri"
    start_hour: float = 10.0
    hours: float = 12.0
    n_restaurants: int = 250
    n_drivers: int = 220
    peak_orders_per_hour: float = 400.0
    delivery_radius_m: float = 4500.0
    promise_slack_min: float = 10.0
    traffic_scale: float = 1.0
    dispatcher: str = "matching_jit"
    jit_buffer_s: float = 240.0  # how early matching_jit is willing to send a driver
    # "What if the estimates were perfect?" switches. They hand the dispatcher
    # the true food-ready time and/or the true drive times under traffic.
    know_prep: bool = False
    know_drive: bool = False
    # Who delivers: "car", "transit" (walk + bus + rail, on the real timetable),
    # or "mixed" (transit_share of couriers use transit, the rest drive).
    courier_mode: str = "car"
    transit_share: float = 0.5

    def __post_init__(self):
        self.hours = float(min(max(self.hours, 0.5), 24.0))
        if self.start_day not in DAYS:
            raise ValueError(f"start_day must be one of {DAYS}")
        if self.dispatcher not in DISPATCHERS:
            raise ValueError(f"dispatcher must be one of {sorted(DISPATCHERS)}")
        if self.courier_mode not in COURIER_MODES:
            raise ValueError(f"courier_mode must be one of {COURIER_MODES}")


@dataclass
class Restaurant:
    id: int
    name: str
    node: int
    lon: float
    lat: float
    mean_prep_s: float  # the dispatcher knows this average, not each order's draw


@dataclass
class Order:
    id: int
    restaurant: int
    customer_node: int
    lon: float
    lat: float
    placed: float
    ready: float  # truth, hidden from the dispatcher
    est_ready: float
    promised: float
    dropoff_ff_s: float  # free-flow drive restaurant -> customer
    pickup_overhead_s: float
    dropoff_overhead_s: float
    dropoff_transit_s: float = np.nan  # by transit, leaving when the food should be ready
    status: int = OPEN
    driver: int = -1
    declined: set[int] = field(default_factory=set)
    offers: int = 0
    assigned: float = np.nan
    at_restaurant: float = np.nan
    picked_up: float = np.nan
    delivered: float = np.nan
    est_pickup_drive: float = np.nan
    true_pickup_drive: float = np.nan
    est_dropoff_drive: float = np.nan
    true_dropoff_drive: float = np.nan


@dataclass
class Driver:
    id: int
    node: int
    shift_start: float
    shift_end: float
    accept_base: float
    mode: str = "car"
    status: int = OFFLINE
    order: int = -1
    route: Route | None = None
    leaving: bool = False
    since: float = 0.0
    seconds: list[float] = field(default_factory=lambda: [0.0] * 7)
    deliveries: int = 0
    declines: int = 0
    meters: float = 0.0


def demand_shape(hour: float) -> float:
    """Relative order rate by hour of day, peaking at 1.0 around dinner."""
    hour = hour % 24
    lunch = 0.55 * np.exp(-0.5 * ((hour - 12.3) / 0.9) ** 2)
    dinner = 1.0 * np.exp(-0.5 * ((hour - 18.7) / 1.3) ** 2)
    base = 0.10 if 8 <= hour <= 23 else 0.03
    return float((base + lunch + dinner) / 1.1)


class Simulation:
    def __init__(self, cfg: SimConfig, net: RoadNetwork | None = None, transit=None):
        self.cfg = cfg
        self.net = net or RoadNetwork.load()
        self.transit = transit
        if cfg.courier_mode != "car" and transit is None:
            from .transit import TransitNetwork

            self.transit = TransitNetwork.load(self.net, cfg.start_day)
        self.end_time = cfg.hours * 3600.0
        week_offset = DAYS.index(cfg.start_day) * 86400 + cfg.start_hour * 3600
        self.traffic = Traffic(week_offset, scale=cfg.traffic_scale)
        self.dispatcher = self._make_dispatcher(cfg.dispatcher)
        self.now = 0.0

        # Two random streams: the world (identical across dispatchers for a
        # given seed, so comparisons are like-for-like) and driver behaviour.
        self._world = np.random.default_rng(cfg.seed)
        self._behave = np.random.default_rng(cfg.seed + 10_000)

        self._events: list[tuple[float, int, str, object]] = []
        self._seq = 0
        self._graph_slot = -1
        self._graph = None
        self._true_rows: dict[int, tuple[np.ndarray, np.ndarray]] = {}

        self.feed: deque[dict] = deque(maxlen=500)
        self.feed_seq = 0
        self.route_seq = 0
        self.route_version: dict[int, int] = {}
        self.series: list[dict] = []
        self.done: list[Order] = []
        self.active: dict[int, Order] = {}
        self.n_placed = 0
        self.n_offers = 0
        self.n_declines = 0

        self._build_restaurants()
        self._build_estimator()
        self._build_orders()
        self._build_drivers()
        self._push(0.0, "dispatch", None)
        self._push(0.0, "sample", None)

    # ------------------------------------------------------------------ setup

    def _build_restaurants(self) -> None:
        net, rng = self.net, self._world
        pick = rng.choice(len(net.venue_lonlat), size=self.cfg.n_restaurants, replace=False)
        nodes = net.nearest_node(net.venue_lonlat[pick])
        names = restaurant_names(self.cfg.n_restaurants, rng)
        prep = rng.uniform(8, 22, size=self.cfg.n_restaurants) * 60
        self.restaurants = [
            Restaurant(i, names[i], int(n), *net.node_lonlat(int(n)), float(prep[i]))
            for i, n in enumerate(nodes)
        ]
        self.rest_nodes = nodes.astype(np.int64)
        # A few restaurants get most of the orders, as in real life.
        popularity = rng.lognormal(0.0, 0.8, size=self.cfg.n_restaurants)
        self.popularity = popularity / popularity.sum()

    def _build_estimator(self) -> None:
        """Free-flow drive times to and from every restaurant.

        The dispatcher's travel-time estimate is this free-flow time scaled by
        one city-wide congestion factor. It is right on average and wrong in
        detail (it cannot tell a jammed I-5 from a clear side street), which
        is the kind of error a real ETA model has to be trained out of.
        """
        g = self.net.graph(self.net.edge_time)
        self.ff_to_rest = self.net.times_to(g, self.rest_nodes).astype(np.float32)
        self.ff_from_rest = self.net.times_from(g, self.rest_nodes).astype(np.float32)

    def est_factor(self, t: float) -> float:
        return float(self.traffic.multipliers(t)[CLASS_ID["arterial"]])

    def clock(self, t: float) -> float:
        """Sim time -> seconds after midnight, the clock the transit timetable uses."""
        return self.cfg.start_hour * 3600.0 + t

    def _build_orders(self) -> None:
        cfg, net, rng = self.cfg, self.net, self._world
        peak_per_s = cfg.peak_orders_per_hour / 3600.0
        residential = np.zeros(net.n_nodes, dtype=bool)
        residential[net.residential_nodes] = True

        # Non-homogeneous Poisson arrivals by thinning.
        t, oid = 0.0, 0
        while True:
            t += rng.exponential(1.0 / peak_per_s)
            if t >= self.end_time:
                break
            hour = cfg.start_hour + t / 3600.0
            if rng.random() > demand_shape(hour):
                continue
            r = int(rng.choice(cfg.n_restaurants, p=self.popularity))
            rest = self.restaurants[r]
            near = net.nodes_within(rest.node, cfg.delivery_radius_m)
            near = near[residential[near] & np.isfinite(self.ff_from_rest[r, near])]
            if len(near) == 0:
                continue
            # Closer customers are more likely (most orders are short hops).
            d = np.hypot(*(net.node_xy[near] - net.node_xy[rest.node]).T)
            w = np.exp(-d / 2200.0)
            c = int(rng.choice(near, p=w / w.sum()))
            prep = float(rng.lognormal(np.log(rest.mean_prep_s) - 0.06, 0.35))
            drive_ff = float(self.ff_from_rest[r, c])
            est_ready = t + rest.mean_prep_s
            travel = drive_ff * self.est_factor(t)
            by_transit = float("nan")
            if self.transit is not None:
                by_transit = float(
                    self.transit.times_from(rest.node, self.clock(est_ready), [c])[0]
                )
                if cfg.courier_mode == "transit":
                    travel = by_transit  # an all-transit fleet quotes transit times
            promised = est_ready + travel + DROPOFF_OVERHEAD_S + cfg.promise_slack_min * 60
            order = Order(
                id=oid, restaurant=r, customer_node=c,
                lon=float(net.node_lon[c]), lat=float(net.node_lat[c]),
                placed=t, ready=t + prep, est_ready=est_ready, promised=promised,
                dropoff_ff_s=drive_ff, dropoff_transit_s=by_transit,
                pickup_overhead_s=float(rng.uniform(60, 180)),
                dropoff_overhead_s=float(rng.uniform(60, 150)),
            )  # fmt: skip
            self._push(t, "order", order)
            oid += 1
        self.n_scheduled = oid

    def _build_drivers(self) -> None:
        cfg, net, rng = self.cfg, self.net, self._world
        fleet = np.random.default_rng(cfg.seed + 20_000)  # separate stream: the world stays put
        self.drivers: list[Driver] = []
        for i in range(cfg.n_drivers):
            kind = rng.choice(3, p=[0.30, 0.45, 0.25])  # lunch, dinner, all day
            if kind == 0:
                start, length = rng.normal(10.75, 0.4), rng.uniform(3.0, 4.5)
            elif kind == 1:
                start, length = rng.normal(16.5, 0.5), rng.uniform(4.0, 5.5)
            else:
                start, length = rng.normal(10.5, 0.5), rng.uniform(9.0, 11.0)
            s = (start - cfg.start_hour) * 3600.0
            e = s + length * 3600.0
            # Drivers start their shift somewhere near a restaurant.
            anchor = self.restaurants[int(rng.integers(cfg.n_restaurants))].node
            near = net.nodes_within(anchor, 1200.0)
            near = near[np.isfinite(self.ff_to_rest[0, near])]
            node = int(rng.choice(near)) if len(near) else anchor
            d = Driver(i, node, s, e, accept_base=float(rng.uniform(0.82, 0.98)))
            on_transit = fleet.random() < cfg.transit_share
            if cfg.courier_mode == "transit" or (cfg.courier_mode == "mixed" and on_transit):
                d.mode = "transit"
            self.drivers.append(d)
            if e > 0:
                self._push(max(s, 0.0), "shift_start", i)
                self._push(e, "shift_end", i)

    # ------------------------------------------------------------- event loop

    def _push(self, t: float, kind: str, arg: object) -> None:
        self._seq += 1
        heapq.heappush(self._events, (t, self._seq, kind, arg))

    @property
    def finished(self) -> bool:
        return self.now >= self.end_time

    def run_until(self, t: float) -> None:
        t = min(t, self.end_time)
        while self._events and self._events[0][0] <= t:
            when, _, kind, arg = heapq.heappop(self._events)
            self.now = when
            getattr(self, "_on_" + kind)(arg)
        self.now = t

    def run(self) -> Simulation:
        self.run_until(self.end_time)
        return self

    def _make_dispatcher(self, name: str):
        dispatcher = DISPATCHERS[name]()
        if hasattr(dispatcher, "buffer"):
            dispatcher.buffer = self.cfg.jit_buffer_s
        return dispatcher

    def set_dispatcher(self, name: str) -> None:
        self.dispatcher = self._make_dispatcher(name)
        self.cfg.dispatcher = name
        self._log("system", f"Dispatcher switched to: {self.dispatcher.label}")

    # ---------------------------------------------------------------- helpers

    def _road_graph(self):
        slot = self.traffic.slot(self.now)
        if slot != self._graph_slot:
            self._graph = self.net.graph(self.traffic.edge_seconds(self.net, self.now))
            self._graph_slot = slot
            self._true_rows.clear()
        return self._graph

    def _true_drive(self, restaurant: int) -> tuple[np.ndarray, np.ndarray]:
        """True drive seconds (every node -> restaurant, restaurant -> every node) right now."""
        graph = self._road_graph()
        if restaurant not in self._true_rows:
            node = self.rest_nodes[restaurant : restaurant + 1]
            self._true_rows[restaurant] = (
                self.net.times_to(graph, node)[0],
                self.net.times_from(graph, node)[0],
            )
        return self._true_rows[restaurant]

    def _travel(self, d: Driver, src: int, dst: int) -> Route:
        """The trip this courier actually makes, starting now."""
        if d.mode == "transit":
            # The timetable runs on clock time; shift the trip so it starts exactly now.
            t0 = self.clock(self.now)
            trip = self.transit.journey(src, dst, t0)
            legs = [(self.now + (t - t0), label) for t, label in trip.legs or []]
            return Route(trip.lonlat, self.now + (trip.t - t0), trip.meters, legs)
        return self.net.route(self._road_graph(), src, dst, self.now)

    def _set_status(self, d: Driver, status: int) -> None:
        d.seconds[d.status] += self.now - d.since
        d.since = self.now
        d.status = status

    def _set_route(self, d: Driver, route: Route | None) -> None:
        d.route = route
        self.route_seq += 1
        self.route_version[d.id] = self.route_seq

    def _log(self, kind: str, text: str, order: int = -1, driver: int = -1) -> None:
        self.feed_seq += 1
        self.feed.append(
            {"seq": self.feed_seq, "t": self.now, "kind": kind, "text": text,
             "order": order, "driver": driver}
        )  # fmt: skip

    def _free_driver(self, d: Driver) -> None:
        d.order = -1
        self._set_route(d, None)
        if d.leaving or self.now >= d.shift_end:
            self._set_status(d, OFFLINE)
        else:
            self._set_status(d, IDLE)

    # ----------------------------------------------------------------- events

    def _on_order(self, o: Order) -> None:
        self.active[o.id] = o
        self.n_placed += 1
        self._log("order", f"Order #{o.id} placed at {self.restaurants[o.restaurant].name}", o.id)

    def _on_shift_start(self, i: int) -> None:
        d = self.drivers[i]
        d.since = self.now
        self._set_status(d, IDLE)

    def _on_shift_end(self, i: int) -> None:
        d = self.drivers[i]
        if d.status == IDLE:
            self._set_status(d, OFFLINE)
        elif d.status != OFFLINE:
            d.leaving = True

    def _on_sample(self, _) -> None:
        self.series.append(self._sample())
        self._push(self.now + 300.0, "sample", None)

    def _on_dispatch(self, _) -> None:
        self._push(self.now + self.dispatcher.interval, "dispatch", None)
        orders = [o for o in self.active.values() if o.status == OPEN]
        drivers = [d for d in self.drivers if d.status == IDLE]
        if not orders or not drivers:
            return
        factor = self.est_factor(self.now)
        rest = np.array([o.restaurant for o in orders])
        nodes = np.array([d.node for d in drivers])
        pickup = self.ff_to_rest[np.ix_(rest, nodes)].astype(np.float64) * factor
        dropoff = np.array([o.dropoff_ff_s for o in orders]) * factor
        if self.cfg.know_drive:
            for i, o in enumerate(orders):
                to_rest, from_rest = self._true_drive(o.restaurant)
                pickup[i] = to_rest[nodes]
                dropoff[i] = from_rest[o.customer_node]
        dropoff = np.repeat(dropoff[:, None], len(drivers), axis=1)
        riders = [j for j, d in enumerate(drivers) if d.mode == "transit"]
        if riders:
            # Transit couriers: read the timetable. One scan per courier gives
            # the door-to-door time to every restaurant with an open order.
            leave = self.clock(self.now) + OFFER_REPLY_S
            targets = sorted({self.restaurants[o.restaurant].node for o in orders})
            where = {n: k for k, n in enumerate(targets)}
            rows = np.array([where[self.restaurants[o.restaurant].node] for o in orders])
            for j in riders:
                pickup[:, j] = self.transit.times_from(drivers[j].node, leave, targets)[rows]
            dropoff[:, riders] = np.array([o.dropoff_transit_s for o in orders])[:, None]
        ready = [o.ready if self.cfg.know_prep else o.est_ready for o in orders]
        declined = np.zeros(pickup.shape, dtype=bool)
        col = {d.id: j for j, d in enumerate(drivers)}
        for i, o in enumerate(orders):
            for did in o.declined:
                if did in col:
                    declined[i, col[did]] = True
        view = DispatchView(
            now=self.now,
            driver_ids=np.array([d.id for d in drivers]),
            order_ids=np.array([o.id for o in orders]),
            pickup_drive=pickup,
            dropoff_drive=dropoff,
            placed=np.array([o.placed for o in orders]),
            est_ready=np.array(ready),
            promised=np.array([o.promised for o in orders]),
            declined=declined,
        )
        row = {o.id: i for i, o in enumerate(orders)}
        for did, oid in self.dispatcher.decide(view):
            d, o = self.drivers[did], self.active[oid]
            if d.status != IDLE or o.status != OPEN:
                continue  # a dispatcher bug should not corrupt the world
            self._set_status(d, OFFERED)
            d.order = oid
            o.status = O_OFFERED
            o.offers += 1
            self.n_offers += 1
            est = float(pickup[row[oid], col[did]])
            self._push(self.now + self._behave.uniform(5, 25), "reply", (did, oid, est))

    def _on_reply(self, arg) -> None:
        did, oid, est = arg
        d, o = self.drivers[did], self.active[oid]
        rest = self.restaurants[o.restaurant]
        # Couriers turn down long pickups more often. Transit couriers expect
        # longer trips, so their patience is doubled.
        patience = 2.0 if d.mode == "transit" else 1.0
        p = np.clip(d.accept_base - 0.025 / patience * max(0.0, est / 60 - 6 * patience), 0.25, 1.0)
        if self._behave.random() > p:
            o.status = OPEN
            o.declined.add(did)
            d.declines += 1
            self.n_declines += 1
            self._log(
                "decline", f"Driver {did} declined order #{oid} ({est / 60:.0f} min away)", oid, did
            )
            self._free_driver(d)
            return
        o.status, o.driver, o.assigned = ASSIGNED, did, self.now
        o.est_pickup_drive = est
        route = self._travel(d, d.node, rest.node)
        o.true_pickup_drive = route.end - route.start
        d.meters += route.meters
        self._set_status(d, TO_RESTAURANT)
        self._set_route(d, route)
        self._push(route.end, "arrive_restaurant", did)
        self._log(
            "assign",
            f"Driver {did} accepted order #{oid}, {o.true_pickup_drive / 60:.0f} min from {rest.name}",
            oid,
            did,
        )

    def _on_arrive_restaurant(self, did: int) -> None:
        d = self.drivers[did]
        o = self.active[d.order]
        d.node = self.restaurants[o.restaurant].node
        o.status, o.at_restaurant = COLLECTING, self.now
        self._set_status(d, AT_RESTAURANT)
        self._set_route(d, None)
        self._push(max(self.now + o.pickup_overhead_s, o.ready), "pickup", did)

    def _on_pickup(self, did: int) -> None:
        d = self.drivers[did]
        o = self.active[d.order]
        o.status, o.picked_up = EN_ROUTE, self.now
        route = self._travel(d, d.node, o.customer_node)
        o.true_dropoff_drive = route.end - route.start
        if d.mode == "transit":
            o.est_dropoff_drive = o.dropoff_transit_s
        elif self.cfg.know_drive:
            o.est_dropoff_drive = o.true_dropoff_drive
        else:
            o.est_dropoff_drive = o.dropoff_ff_s * self.est_factor(self.now)
        d.meters += route.meters
        self._set_status(d, TO_CUSTOMER)
        self._set_route(d, route)
        self._push(route.end, "arrive_customer", did)
        self._log("pickup", f"Driver {did} picked up order #{o.id}", o.id, did)

    def _on_arrive_customer(self, did: int) -> None:
        d = self.drivers[did]
        o = self.active[d.order]
        d.node = o.customer_node
        self._set_status(d, AT_DOOR)
        self._set_route(d, None)
        self._push(self.now + o.dropoff_overhead_s, "delivered", did)

    def _on_delivered(self, did: int) -> None:
        d = self.drivers[did]
        o = self.active.pop(d.order)
        o.status, o.delivered = DELIVERED, self.now
        d.deliveries += 1
        self.done.append(o)
        late = (o.delivered - o.promised) / 60
        took = (o.delivered - o.placed) / 60
        note = f"{late:.0f} min late" if late > 0 else "on time"
        self._log(
            "late" if late > 0 else "delivered",
            f"Order #{o.id} delivered in {took:.0f} min ({note})", o.id, did,
        )  # fmt: skip
        self._free_driver(d)

    # ---------------------------------------------------------------- metrics

    def _sample(self) -> dict:
        status = np.bincount([d.status for d in self.drivers], minlength=7)
        online = int(status[IDLE:].sum())
        recent = [o for o in self.done if o.delivered >= self.now - 1800]
        return {
            "t": self.now,
            "open": sum(o.status in (OPEN, O_OFFERED) for o in self.active.values()),
            "active": len(self.active),
            "online": online,
            "busy": int(status[TO_RESTAURANT:].sum()),
            "avg_min": float(np.mean([o.delivered - o.placed for o in recent]) / 60)
            if recent
            else None,
            "late_pct": float(np.mean([o.delivered > o.promised for o in recent]) * 100)
            if recent
            else None,
        }

    def kpis(self, window_s: float | None = None) -> dict:
        """Headline numbers, over the whole run or the trailing window."""
        done = self.done
        if window_s is not None:
            done = [o for o in done if o.delivered >= self.now - window_s]
        out: dict = {"delivered": len(done), "placed": self.n_placed}
        if not done:
            return out
        a = lambda f: np.array([f(o) for o in done], dtype=np.float64)
        total = a(lambda o: o.delivered - o.placed) / 60
        late = a(lambda o: o.delivered - o.promised) / 60
        out.update(
            avg_delivery_min=float(total.mean()),
            p50_delivery_min=float(np.percentile(total, 50)),
            p90_delivery_min=float(np.percentile(total, 90)),
            late_pct=float((late > 0).mean() * 100),
            avg_late_min=float(late[late > 0].mean()) if (late > 0).any() else 0.0,
            # Driver stood at the restaurant waiting for food (wasted driver time).
            driver_wait_min=float(a(lambda o: max(0.0, o.ready - o.at_restaurant)).mean() / 60),
            # Food sat on the counter waiting for the driver (cold food).
            food_wait_min=float(a(lambda o: o.picked_up - o.ready).mean() / 60),
            wait_for_assign_min=float(a(lambda o: o.assigned - o.placed).mean() / 60),
            pickup_drive_min=float(a(lambda o: o.true_pickup_drive).mean() / 60),
            dropoff_drive_min=float(a(lambda o: o.true_dropoff_drive).mean() / 60),
            eta_error_min=float(
                np.abs(
                    a(lambda o: o.est_pickup_drive + o.est_dropoff_drive)
                    - a(lambda o: o.true_pickup_drive + o.true_dropoff_drive)
                ).mean() / 60
            ),
        )  # fmt: skip
        return out

    def summary(self) -> dict:
        """End-of-run report. Every number is defined in metrics.py."""
        from .metrics import summarize

        return summarize(self)

    # ------------------------------------------------------- live UI snapshot

    def driver_position(self, d: Driver) -> tuple[float, float]:
        if d.route is not None:
            return d.route.position(self.now)
        return self.net.node_lonlat(d.node)

    def snapshot(self) -> dict:
        drivers = []
        for d in self.drivers:
            if d.status == OFFLINE:
                continue
            lon, lat = self.driver_position(d)
            transit = int(d.mode == "transit")
            drivers.append([d.id, round(lon, 5), round(lat, 5), d.status, d.order, transit])
        orders = [
            [o.id, o.status, o.restaurant, round(o.lon, 5), round(o.lat, 5),
             round(o.placed), round(o.promised), o.driver, round(o.est_ready)]
            for o in self.active.values()
        ]  # fmt: skip
        return {
            "t": round(self.now, 1),
            "clock": self.traffic.clock(self.now),
            "end": self.end_time,
            "finished": self.finished,
            "drivers": drivers,
            "orders": orders,
        }
