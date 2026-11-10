"""Traffic: how much slower each kind of road is at each time of the week.

The profile in data/traffic_profile.json comes from real 2015 freeway sensor
data for I-5, I-90 and SR-520 (see scripts/build_traffic_profile.py). Surface
streets have no public sensor data, so their curve is an assumed, damped copy
of the freeway average. The JSON file says which classes are measured.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .network import DATA_DIR, TRAFFIC_CLASSES, RoadNetwork

PROFILE_PATH = DATA_DIR / "traffic_profile.json"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEK = 7 * 86400


class Traffic:
    """Looks up slowdown multipliers by sim time.

    Sim time is seconds since the run started; `week_offset` is where in the
    week (seconds after Monday 00:00) the run starts.
    """

    def __init__(self, week_offset: float, path: Path = PROFILE_PATH, scale: float = 1.0):
        raw = json.loads(path.read_text())
        self.bucket = raw["bucket_minutes"] * 60
        table = np.array([raw["multiplier"][name] for name in TRAFFIC_CLASSES])
        # `scale` exaggerates (>1) or flattens (<1) congestion for what-if runs.
        self.table = 1.0 + scale * (table - 1.0)
        self.week_offset = week_offset
        self.source = raw["source"]

    def slot(self, sim_time: float) -> int:
        return int(((self.week_offset + sim_time) % WEEK) // self.bucket)

    def multipliers(self, sim_time: float) -> np.ndarray:
        """One multiplier per traffic class, in TRAFFIC_CLASSES order."""
        return self.table[:, self.slot(sim_time)]

    def edge_seconds(self, net: RoadNetwork, sim_time: float) -> np.ndarray:
        """Current travel time of every road segment."""
        return net.edge_time * self.multipliers(sim_time)[net.edge_class]

    def clock(self, sim_time: float) -> str:
        t = (self.week_offset + sim_time) % WEEK
        day, rest = divmod(int(t), 86400)
        return f"{DAYS[day]} {rest // 3600:02d}:{rest % 3600 // 60:02d}"
