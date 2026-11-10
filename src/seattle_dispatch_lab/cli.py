"""Command line entry point: `uv run dispatch-lab <command>`."""

from __future__ import annotations

import argparse
import time
from dataclasses import fields

from .dispatch import DISPATCHERS
from .sim import SimConfig, Simulation

ROWS = [
    ("delivered", "Orders delivered", "{:.0f}"),
    ("undelivered", "Still undelivered at the end", "{:.0f}"),
    ("avg_delivery_min", "Average delivery time (min)", "{:.1f}"),
    ("p90_delivery_min", "90th percentile delivery time (min)", "{:.1f}"),
    ("late_pct", "Late vs. promised time (%)", "{:.1f}"),
    ("avg_late_min", "Average lateness when late (min)", "{:.1f}"),
    ("wait_for_assign_min", "Order waits for a driver (min)", "{:.1f}"),
    ("driver_wait_min", "Driver waits at restaurant (min)", "{:.1f}"),
    ("food_wait_min", "Food waits for driver (min)", "{:.1f}"),
    ("pickup_drive_min", "Drive to restaurant (min)", "{:.1f}"),
    ("dropoff_drive_min", "Drive to customer (min)", "{:.1f}"),
    ("km_per_delivery", "Distance driven per delivery (km)", "{:.1f}"),
    ("utilization_pct", "Driver time spent on deliveries (%)", "{:.1f}"),
    ("deliveries_per_driver_hour", "Deliveries per driver-hour", "{:.2f}"),
    ("declines", "Offers declined", "{:.0f}"),
    ("eta_error_min", "Drive-time estimate error (min)", "{:.1f}"),
]


def _config(args: argparse.Namespace, **overrides) -> SimConfig:
    values = {f.name: getattr(args, f.name) for f in fields(SimConfig) if hasattr(args, f.name)}
    values.update(overrides)
    return SimConfig(**values)


def _add_world_args(p: argparse.ArgumentParser) -> None:
    d = SimConfig()
    p.add_argument("--seed", type=int, default=d.seed)
    p.add_argument("--start-day", default=d.start_day, help="Mon..Sun (default Fri)")
    p.add_argument("--start-hour", type=float, default=d.start_hour)
    p.add_argument("--hours", type=float, default=d.hours)
    p.add_argument("--n-restaurants", type=int, default=d.n_restaurants)
    p.add_argument("--n-drivers", type=int, default=d.n_drivers)
    p.add_argument("--peak-orders-per-hour", type=float, default=d.peak_orders_per_hour)
    p.add_argument("--traffic-scale", type=float, default=d.traffic_scale,
                   help="0 = no congestion, 1 = measured, 2 = twice the slowdown")  # fmt: skip


def print_table(results: list[dict]) -> None:
    width = max(len(label) for _, label, _ in ROWS)
    names = [r["dispatcher"] for r in results]
    print(f"{'':{width}}  " + "  ".join(f"{n:>13}" for n in names))
    for key, label, fmt in ROWS:
        cells = [fmt.format(r[key]) if key in r else "-" for r in results]
        print(f"{label:{width}}  " + "  ".join(f"{c:>13}" for c in cells))


def cmd_setup(args: argparse.Namespace) -> None:
    from . import network

    network.build()


def cmd_run(args: argparse.Namespace) -> None:
    started = time.time()
    sim = Simulation(_config(args)).run()
    print_table([sim.summary()])
    print(f"\n{sim.cfg.hours:g} simulated hours in {time.time() - started:.1f} s")


def cmd_compare(args: argparse.Namespace) -> None:
    from .network import RoadNetwork

    net = RoadNetwork.load()
    results = []
    for name in DISPATCHERS:
        started = time.time()
        sim = Simulation(_config(args, dispatcher=name), net).run()
        results.append(sim.summary())
        print(f"  ran {name} in {time.time() - started:.1f} s")
    print()
    print_table(results)


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .server import create_app

    print(f"Live map: http://{args.host}:{args.port}")
    uvicorn.run(create_app(_config(args)), host=args.host, port=args.port, log_level="warning")


def main() -> None:
    parser = argparse.ArgumentParser(prog="dispatch-lab", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("setup", help="download Seattle's streets (once, ~4 min)")
    p.set_defaults(func=cmd_setup)

    p = sub.add_parser("run", help="run one simulated day and print the results")
    _add_world_args(p)
    p.add_argument("--dispatcher", default=SimConfig().dispatcher, choices=sorted(DISPATCHERS))
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("compare", help="run every dispatcher on the same day")
    _add_world_args(p)
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("serve", help="watch the dispatcher live in a browser")
    _add_world_args(p)
    p.add_argument("--dispatcher", default=SimConfig().dispatcher, choices=sorted(DISPATCHERS))
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)
