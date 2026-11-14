"""Write the reference runs the browser simulator's tests replay.

    uv run python scripts/export_browser_fixtures.py

Two sets go to browser/test/fixtures/:

  grid/   a made-up 12 x 12 street grid; small, committed, needs no download
  real/   one Friday on the Seattle network; not committed (it is derived from
          OpenStreetMap data and is written only if `dispatch-lab setup` has run)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from seattle_dispatch_lab import browser_export as bx
from seattle_dispatch_lab.dispatch import DISPATCHERS
from seattle_dispatch_lab.network import NETWORK_PATH, RoadNetwork
from seattle_dispatch_lab.sim import SimConfig, Simulation
from tests.conftest import make_grid

OUT = ROOT / "browser" / "test" / "fixtures"


def dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


def main() -> None:
    names = list(DISPATCHERS)
    print("Assignment cases")
    dump(OUT / "assignment.json", bx.assignment_cases())

    print("Grid")
    grid = make_grid()
    cfg = SimConfig(
        seed=3, hours=3.0, start_hour=11.0, n_restaurants=20, n_drivers=18,
        peak_orders_per_hour=90.0, delivery_radius_m=2500.0,
    )  # fmt: skip
    dump(OUT / "grid" / "network.json", bx.network_json(grid))
    dump(OUT / "grid" / "run.json", bx.reference_run(cfg, grid, names))
    dump(OUT / "grid" / "routing.json", bx.routing_samples(Simulation(cfg, grid), 144, 25))

    if not NETWORK_PATH.exists():
        print("Seattle network not built; skipping the real fixtures.")
        return
    print("Seattle")
    net = RoadNetwork.load()
    cfg = SimConfig(seed=1)
    bx.write_data(ROOT / "browser" / "public" / "data", net)
    dump(OUT / "real" / "run.json", bx.reference_run(cfg, net, names))
    dump(OUT / "real" / "routing.json", bx.routing_samples(Simulation(cfg, net)))


if __name__ == "__main__":
    main()
