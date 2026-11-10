"""Run the evaluation experiments and write small result files to results/.

    uv run python scripts/export_results.py            # 10 days per variant, ~4 min
    uv run python scripts/export_results.py --days 3   # quick check

Writes:
  results/days.csv       one row per simulated day: experiment, scenario, variant, seed, metrics
  results/summary.json   per-experiment means, 95% intervals and paired differences from the
                         baseline, plus the metric registry and how the files were produced

Experiments:
  dispatchers   nearest vs matching vs matching_jit, at normal and busy demand
  information   matching_jit with estimated vs perfect food-ready and drive times
  jit_buffer    matching_jit hold buffer from 0 s to 900 s, against plain matching
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path

from seattle_dispatch_lab.cli import INFORMATION, JIT_BUFFERS_S
from seattle_dispatch_lab.dispatch import DISPATCHERS
from seattle_dispatch_lab.experiments import run_many, summarize_variants
from seattle_dispatch_lab.metrics import METRICS
from seattle_dispatch_lab.sim import SimConfig

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results"
SCENARIOS = {"normal": {"peak_orders_per_hour": 400.0}, "busy": {"peak_orders_per_hour": 520.0}}


def experiments() -> list[dict]:
    dispatchers = {name: {"dispatcher": name} for name in DISPATCHERS}
    buffers = {
        f"{b}s": {"dispatcher": "matching_jit", "jit_buffer_s": float(b)} for b in JIT_BUFFERS_S
    }
    buffers["no_hold"] = {"dispatcher": "matching"}
    jit = {"dispatcher": "matching_jit"}
    return [
        {"name": "dispatchers", "scenario": "normal", "baseline": "matching", "variants": dispatchers},
        {"name": "dispatchers", "scenario": "busy", "baseline": "matching", "variants": dispatchers},
        {
            "name": "information",
            "scenario": "normal",
            "baseline": "estimates",
            "variants": {k: {**jit, **v} for k, v in INFORMATION.items()},
        },
        {"name": "jit_buffer", "scenario": "normal", "baseline": "no_hold", "variants": buffers},
    ]  # fmt: skip


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=False
    ).stdout.strip()


def clean(value):
    """JSON has no NaN; write null instead."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, float) and math.isnan(value):
        return None
    return round(value, 4) if isinstance(value, float) else value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("--seed", type=int, default=1, help="first day's seed")
    args = parser.parse_args()
    seeds = [args.seed + i for i in range(args.days)]
    base = SimConfig()

    # Several experiments share variants (plain matching appears in three), so
    # collect every distinct config and run each exactly once.
    plan, unique = [], {}
    for exp in experiments():
        for variant, overrides in exp["variants"].items():
            for seed in seeds:
                cfg = replace(base, seed=seed, **SCENARIOS[exp["scenario"]], **overrides)
                key = tuple(sorted(asdict(cfg).items()))
                unique.setdefault(key, cfg)
                plan.append((exp, variant, key))
    print(f"{len(plan)} runs planned, {len(unique)} distinct. Running ...")
    results = dict(zip(unique, run_many(list(unique.values())), strict=True))

    OUT.mkdir(exist_ok=True)
    keys = [m.key for m in METRICS]
    with (OUT / "days.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["experiment", "scenario", "variant", "seed", *keys])
        for exp, variant, key in plan:
            r = results[key]
            row = [f"{r[k]:.4f}" if k in r and not math.isnan(r[k]) else "" for k in keys]
            writer.writerow([exp["name"], exp["scenario"], variant, r["seed"], *row])

    summary = []
    for exp in experiments():
        runs = {
            variant: [results[k] for e, v, k in plan if e["name"] == exp["name"] and e["scenario"] == exp["scenario"] and v == variant]
            for variant in exp["variants"]
        }  # fmt: skip
        summary.append(
            {
                "experiment": exp["name"],
                "scenario": exp["scenario"],
                "variants": exp["variants"],
                **summarize_variants(runs, exp["baseline"]),
            }
        )

    dirty = bool(git("status", "--porcelain", "--", "src", "scripts", "data/traffic_profile.json"))
    meta = {
        "generated": date.today().isoformat(),
        "repo": "rio-sanjuan/seattle-dispatch-lab",
        "commit": git("rev-parse", "HEAD"),
        "uncommitted_code_changes": dirty,
        "command": f"uv run python scripts/export_results.py --days {args.days} --seed {args.seed}",
        "seeds": seeds,
        "base_config": asdict(base),
        "scenarios": SCENARIOS,
        "interval": "half_width is half of a 95% Student-t confidence interval over days; "
        "vs_baseline is the per-day paired difference (variant minus baseline)",
    }
    registry = [asdict(m) for m in METRICS]
    (OUT / "summary.json").write_text(
        json.dumps(clean({"meta": meta, "metrics": registry, "experiments": summary}), indent=1)
        + "\n"
    )
    print(f"Wrote {OUT / 'days.csv'} and {OUT / 'summary.json'}")
    if dirty:
        print("Note: code has uncommitted changes, so the recorded commit is not exact.")


if __name__ == "__main__":
    main()
