"""Turn the Seattle freeway loop-detector dataset into a small traffic profile.

Input:  speed_matrix_2015_1mph (274 MB pickle) from
        https://zenodo.org/records/3258904  (UW STAR Lab / WSDOT, CC-BY-4.0)
Output: data/traffic_profile.json, a slowdown multiplier for each traffic
        class and each 15-minute slot of a typical week.

You only need to run this to regenerate the profile; the output is committed.

    curl -L -o data/raw/loop/speed_matrix_2015_1mph.pkl \
        https://zenodo.org/api/records/3258904/files/speed_matrix_2015_1mph/content
    uv run python -I scripts/build_traffic_profile.py data/raw/loop/speed_matrix_2015_1mph.pkl
"""

from __future__ import annotations

import json
import pickletools
import sys
import warnings
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[1] / "data" / "traffic_profile.json"
BUCKET_MIN = 15

# Sensor name = direction (i = increasing milepost, d = decreasing) + route +
# "es" + milepost x100. Milepost ranges keep the stretch inside (or feeding
# directly into) Seattle city limits.
CORRIDORS = {
    "I5_N": ("i005es", 157.0, 175.0),
    "I5_S": ("d005es", 157.0, 175.0),
    "I90_E": ("i090es", 2.5, 6.0),
    "I90_W": ("d090es", 2.5, 6.0),
    "SR520_E": ("i520es", 0.0, 4.0),
    "SR520_W": ("d520es", 0.0, 4.0),
}

# No public sensor data covers Seattle's surface streets, so their slowdown is
# ASSUMED to be a damped copy of the average freeway slowdown:
#   multiplier = 1 + share * (freeway_average - 1)
SURFACE_SHARE = {"arterial": 0.5, "local": 0.2}

# A pickle can run code when loaded. Refuse anything that references more than
# the pandas/numpy constructors a plain DataFrame needs.
ALLOWED_PICKLE_NAMES = {
    "pandas.core.frame",
    "pandas.core.internals.managers",
    "pandas.core.indexes.base",
    "numpy.core.multiarray",
    "numpy",
    "builtins",
    "DataFrame",
    "BlockManager",
    "_new_Index",
    "Index",
    "_reconstruct",
    "ndarray",
    "dtype",
    "slice",
}


def check_pickle(path: Path) -> None:
    recent: list[str] = []
    with path.open("rb") as f:
        for op, arg, _ in pickletools.genops(f):
            if op.name in ("GLOBAL", "INST"):
                names = set(str(arg).split())
            elif op.name == "STACK_GLOBAL":
                names = set(recent[-2:])
            else:
                if isinstance(arg, str):
                    recent = (recent + [arg])[-2:]
                continue
            if not names <= ALLOWED_PICKLE_NAMES:
                sys.exit(f"Refusing to load {path}: it references {sorted(names)}")


def main(path: Path) -> None:
    check_pickle(path)
    import pandas as pd

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        df = pd.read_pickle(path)
    when = pd.to_datetime(df.index)
    slot = (
        when.day_of_week.values * 24 * 60 + when.hour.values * 60 + when.minute.values
    ) // BUCKET_MIN  # 0 = Monday 00:00
    n_slots = 7 * 24 * 60 // BUCKET_MIN

    profile: dict[str, list[float]] = {}
    sensors_used: dict[str, int] = {}
    for name, (prefix, lo, hi) in CORRIDORS.items():
        cols = [c for c in df.columns if c[:6] == prefix and lo <= int(c[6:]) / 100 <= hi]
        speed = df[cols].to_numpy(dtype=np.float64)
        free_flow = np.percentile(speed, 85, axis=0)
        # Time to cross the corridor relative to free flow, each 5 minutes.
        slowdown = (free_flow / np.maximum(speed, 3.0)).mean(axis=1)
        typical = np.array([np.median(slowdown[slot == s]) for s in range(n_slots)])
        profile[name] = np.maximum(typical, 1.0).round(3).tolist()
        sensors_used[name] = len(cols)

    freeway_avg = np.mean([profile[k] for k in CORRIDORS], axis=0)
    profile["freeway_other"] = freeway_avg.round(3).tolist()
    for name, share in SURFACE_SHARE.items():
        profile[name] = (1 + share * (freeway_avg - 1)).round(3).tolist()

    OUT.write_text(
        json.dumps(
            {
                "description": "Travel-time multiplier vs. free flow, per traffic "
                "class, for each 15-minute slot of a typical week.",
                "source": "Freeway Inductive Loop Detector Dataset (2015), UW STAR "
                "Lab / WSDOT, https://zenodo.org/records/3258904, CC-BY-4.0",
                "bucket_minutes": BUCKET_MIN,
                "first_slot": "Monday 00:00 local time",
                "measured": sorted(CORRIDORS),
                "assumed": {
                    "freeway_other": "mean of the six measured corridors",
                    **{
                        k: f"1 + {v} * (freeway mean - 1); no sensor data"
                        for k, v in SURFACE_SHARE.items()
                    },
                },
                "sensors_used": sensors_used,
                "multiplier": profile,
            },
            indent=1,
        )
    )
    print(f"Wrote {OUT}")
    for name, values in profile.items():
        v = np.array(values)
        peak = int(v.argmax())
        day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][peak // 96]
        hhmm = f"{(peak % 96) // 4:02d}:{(peak % 96) % 4 * 15:02d}"
        print(f"  {name:14s} mean {v.mean():.2f}  worst {v.max():.2f} ({day} {hhmm})")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
