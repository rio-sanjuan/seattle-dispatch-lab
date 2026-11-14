"""Command line entry point: `uv run dispatch-lab <command>`."""

from __future__ import annotations

import argparse
import math
import time
from dataclasses import fields

import numpy as np

from .dispatch import DISPATCHERS
from .experiments import paired_difference, run_variants
from .metrics import GROUPS, METRICS
from .sim import COURIER_MODES, SimConfig, Simulation

JIT_BUFFERS_S = [0, 60, 120, 240, 480, 900]
INFORMATION = {
    "estimates": {},
    "perfect_prep": {"know_prep": True},
    "perfect_drive": {"know_drive": True},
    "perfect_both": {"know_prep": True, "know_drive": True},
}


def _config(args: argparse.Namespace, **overrides) -> SimConfig:
    values = {f.name: getattr(args, f.name) for f in fields(SimConfig) if hasattr(args, f.name)}
    values.update(overrides)
    return SimConfig(**values)


def _add_world_args(p: argparse.ArgumentParser, days: bool = False) -> None:
    d = SimConfig()
    p.add_argument("--seed", type=int, default=d.seed, help="first day's random seed")
    if days:
        p.add_argument("--days", type=int, default=10, help="simulated days per policy")
    p.add_argument("--start-day", default=d.start_day, help="Mon..Sun (default Fri)")
    p.add_argument("--start-hour", type=float, default=d.start_hour)
    p.add_argument("--hours", type=float, default=d.hours)
    p.add_argument("--n-restaurants", type=int, default=d.n_restaurants)
    p.add_argument("--n-drivers", type=int, default=d.n_drivers)
    p.add_argument("--peak-orders-per-hour", type=float, default=d.peak_orders_per_hour)
    p.add_argument("--traffic-scale", type=float, default=d.traffic_scale,
                   help="0 = no congestion, 1 = measured, 2 = twice the slowdown")  # fmt: skip
    p.add_argument("--delivery-radius-m", type=float, default=d.delivery_radius_m)
    p.add_argument("--courier-mode", default=d.courier_mode, choices=COURIER_MODES,
                   help="car, transit (walk + bus + rail), or mixed")  # fmt: skip
    p.add_argument("--transit-share", type=float, default=d.transit_share,
                   help="share of couriers on transit when --courier-mode mixed")  # fmt: skip


def _add_dispatcher_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument("--dispatcher", default=SimConfig().dispatcher, choices=sorted(DISPATCHERS))


def _fmt(value: float | None, digits: int) -> str:
    return "-" if value is None or math.isnan(value) else f"{value:.{digits}f}"


def print_report(runs: dict[str, list[dict]], baseline: str | None = None) -> None:
    """Mean of every metric per variant, then per-day differences from the baseline."""
    names = list(runs)
    days = len(runs[names[0]])
    width = max(len(m.label) for m in METRICS) + 2
    cell = max(12, *(len(n) for n in names)) + 2
    print(
        f"{'Mean over ' + str(days) + ' day(s)':{width}}" + "".join(f"{n:>{cell}}" for n in names)
    )
    for group in GROUPS:
        print(group)
        for m in (m for m in METRICS if m.group == group):
            means = [sum(r.get(m.key, float("nan")) for r in runs[n]) / days for n in names]
            print(
                f"  {m.label:{width - 2}}" + "".join(f"{_fmt(v, m.digits):>{cell}}" for v in means)
            )
    if baseline is None or days < 2:
        if baseline is not None:
            print("\nOne day cannot tell a real difference from luck; use --days 5 or more.")
        return

    others = [n for n in names if n != baseline]
    print(f"\nDifference from '{baseline}' on the same days: mean ± 95% interval, verdict")
    print(f"{'':{width}}" + "".join(f"  {n:<37}" for n in others))
    for m in METRICS:
        cells = []
        for n in others:
            d = paired_difference(runs[n], runs[baseline], m.key)
            digits = max(m.digits, 1) + 1
            text = f"{d['mean']:+.{digits}f} ± {d['half_width']:.{digits}f}"
            cells.append(f"  {text:>17} {d['verdict']:<19}")
        print(f"  {m.label:{width - 2}}" + "".join(cells))


def cmd_setup(args: argparse.Namespace) -> None:
    from . import network

    network.build()


def cmd_run(args: argparse.Namespace) -> None:
    started = time.time()
    sim = Simulation(_config(args)).run()
    print_report({sim.dispatcher.name: [sim.summary()]})
    print(f"\n{sim.cfg.hours:g} simulated hours in {time.time() - started:.1f} s")


def cmd_compare(args: argparse.Namespace) -> None:
    variants = {name: {"dispatcher": name} for name in DISPATCHERS}
    print_report(run_variants(_config(args), variants, args.days), args.baseline)


def cmd_information(args: argparse.Namespace) -> None:
    print(f"Dispatcher: {args.dispatcher}. What if its estimates were perfect?\n")
    print_report(run_variants(_config(args), INFORMATION, args.days), "estimates")


def cmd_sweep(args: argparse.Namespace) -> None:
    variants = {f"{b}s": {"dispatcher": "matching_jit", "jit_buffer_s": b} for b in JIT_BUFFERS_S}
    variants["no hold"] = {"dispatcher": "matching"}
    print("matching_jit with different hold buffers; 'no hold' is plain matching.\n")
    print_report(run_variants(_config(args), variants, args.days), "no hold")


FLEET_EXTRAS = [
    ("transit_delivery_share_pct", "Deliveries made by transit couriers (%)", 1),
    ("avg_delivery_min_car", "Average delivery time, car couriers (min)", 1),
    ("avg_delivery_min_transit", "Average delivery time, transit couriers (min)", 1),
    ("deliveries_per_driver_hour_car", "Deliveries per hour, car couriers", 2),
    ("deliveries_per_driver_hour_transit", "Deliveries per hour, transit couriers", 2),
]


def fleet_variants(n_drivers: int) -> dict[str, dict]:
    return {
        "car": {"courier_mode": "car"},
        "mixed": {"courier_mode": "mixed", "transit_share": 0.5},
        "transit": {"courier_mode": "transit"},
        "transit x2": {"courier_mode": "transit", "n_drivers": 2 * n_drivers},
    }


def cmd_setup_transit(args: argparse.Namespace) -> None:
    from . import transit
    from .network import RoadNetwork

    transit.build(transit.download(), RoadNetwork.load(), args.start_day)


def cmd_fleet(args: argparse.Namespace) -> None:
    cfg = _config(args)
    runs = run_variants(cfg, fleet_variants(cfg.n_drivers), args.days)
    print(
        f"Couriers by car, by transit, or half and half. Delivery radius {cfg.delivery_radius_m:g} m."
    )
    print("'transit x2' doubles the number of couriers.\n")
    print_report(runs, "car")
    print("\nBy courier type")
    width = max(len(m.label) for m in METRICS) + 2
    for key, label, digits in FLEET_EXTRAS:
        means = []
        for rs in runs.values():
            values = [r[key] for r in rs if key in r and not math.isnan(r[key])]
            means.append(float(np.mean(values)) if values else float("nan"))
        print(f"  {label:{width - 2}}" + "".join(f"{_fmt(v, digits):>14}" for v in means))


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
    _add_dispatcher_arg(p)
    p.add_argument("--know-prep", action="store_true", help="dispatcher sees true food-ready times")
    p.add_argument("--know-drive", action="store_true", help="dispatcher sees true drive times")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("compare", help="run every dispatcher on the same days")
    _add_world_args(p, days=True)
    p.add_argument("--baseline", default="matching", choices=sorted(DISPATCHERS))
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("information", help="how much do perfect estimates help a dispatcher?")
    _add_world_args(p, days=True)
    _add_dispatcher_arg(p)
    p.set_defaults(func=cmd_information)

    p = sub.add_parser("sweep", help="trade speed against driver time (just-in-time buffer)")
    _add_world_args(p, days=True)
    p.set_defaults(func=cmd_sweep)

    p = sub.add_parser(
        "setup-transit", help="download the transit schedule (36 MB) and build a timetable"
    )
    p.add_argument("--start-day", default=SimConfig().start_day, help="Mon..Sun (default Fri)")
    p.set_defaults(func=cmd_setup_transit)

    p = sub.add_parser("fleet", help="couriers by car vs. public transit vs. a mix")
    _add_world_args(p, days=True)
    p.set_defaults(func=cmd_fleet)

    p = sub.add_parser("serve", help="watch the dispatcher live in a browser")
    _add_world_args(p)
    _add_dispatcher_arg(p)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)
