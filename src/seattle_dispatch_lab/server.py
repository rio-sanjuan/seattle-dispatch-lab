"""Live view: runs the simulation and streams it to a browser over a WebSocket.

One simulation is shared by every connected browser tab. The loop below
advances the simulated clock by `speed` seconds for each real second and sends
each tab a snapshot about ten times a second.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .dispatch import DISPATCHERS
from .network import CLASS_ID, TRAFFIC_CLASSES, RoadNetwork
from .sim import DRIVER_STATES, OFFLINE, ORDER_STATES, SimConfig, Simulation

WEB_DIR = Path(__file__).parent / "web"
TICK_S = 0.1
log = logging.getLogger(__name__)
SPEEDS = [1, 10, 30, 60, 120, 300]
FREEWAY_CLASSES = TRAFFIC_CLASSES[: CLASS_ID["arterial"]]


class Client:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.generation = -1
        self.feed_seq = 0
        self.route_seq = 0
        self.series_n = 0
        self.selected: int | None = None


class LiveSim:
    def __init__(self, cfg: SimConfig):
        self.net = RoadNetwork.load()
        self.sim = Simulation(cfg, self.net)
        self.generation = 0
        self.playing = True
        self.speed = 60
        self.clients: list[Client] = []
        self.busy = False  # True while a restart is rebuilding the world
        self._kpi_at = -1.0
        self._kpi: dict = {}
        self._freeways = self._freeway_lines()

    # ---- payloads

    def _freeway_lines(self) -> list[dict]:
        """Freeway geometry by traffic class, so the map can colour live congestion."""
        net, out = self.net, []
        for cls in range(len(FREEWAY_CLASSES)):
            lines = [
                np.round(net.geom_xy[net.geom_off[e] : net.geom_off[e + 1]], 5).tolist()
                for e in np.flatnonzero(net.edge_class == cls)
            ]
            out.append({"cls": TRAFFIC_CLASSES[cls], "lines": lines})
        return out

    def hello(self) -> dict:
        sim = self.sim
        return {
            "type": "hello",
            "generation": self.generation,
            "config": asdict(sim.cfg),
            "dispatchers": [{"name": n, "label": c.label} for n, c in DISPATCHERS.items()],
            "speeds": SPEEDS,
            "driver_states": DRIVER_STATES,
            "order_states": ORDER_STATES,
            "traffic_classes": TRAFFIC_CLASSES,
            "traffic_source": sim.traffic.source,
            "freeways": self._freeways,
            "transit_lines": sim.transit.lines() if sim.transit is not None else [],
            "restaurants": [
                [r.id, round(r.lon, 5), round(r.lat, 5), r.name, round(r.mean_prep_s / 60)]
                for r in sim.restaurants
            ],
            "bounds": [
                float(self.net.node_lon.min()), float(self.net.node_lat.min()),
                float(self.net.node_lon.max()), float(self.net.node_lat.max()),
            ],
        }  # fmt: skip

    def kpis(self) -> dict:
        if time.monotonic() - self._kpi_at > 0.5:
            self._kpi = {"hour": self.sim.kpis(3600.0), "all": self.sim.kpis()}
            self._kpi_at = time.monotonic()
        return self._kpi

    def state_for(self, c: Client) -> dict:
        sim = self.sim
        msg = sim.snapshot()
        msg.update(
            type="state",
            playing=self.playing,
            speed=self.speed,
            busy=self.busy,
            dispatcher=sim.dispatcher.name,
            traffic=[round(float(m), 2) for m in sim.traffic.multipliers(sim.now)],
            kpi=self.kpis(),
            feed=[e for e in sim.feed if e["seq"] > c.feed_seq],
            series=sim.series[c.series_n :],
        )
        routes = {}
        for did, version in sim.route_version.items():
            if version > c.route_seq:
                r = sim.drivers[did].route
                routes[did] = None if r is None else np.round(r.lonlat, 5).tolist()
        msg["routes"] = routes
        if c.selected is not None and c.selected < len(sim.drivers):
            msg["detail"] = self.driver_detail(c.selected)
        c.feed_seq, c.route_seq, c.series_n = sim.feed_seq, sim.route_seq, len(sim.series)
        return msg

    def driver_detail(self, did: int) -> dict:
        sim = self.sim
        d = sim.drivers[did]
        out = {
            "id": did, "status": d.status, "mode": d.mode,
            "leg": d.route.leg_at(sim.now) if d.route is not None else None,
            "deliveries": d.deliveries, "declines": d.declines,
            "km": round(d.meters / 1000, 1),
            "shift_end": d.shift_end, "order": None,
        }  # fmt: skip
        o = sim.active.get(d.order)
        if o is not None and d.status != OFFLINE:
            out["order"] = {
                "id": o.id, "restaurant": o.restaurant, "placed": o.placed,
                "est_ready": o.est_ready, "promised": o.promised,
                "lon": o.lon, "lat": o.lat, "status": o.status,
            }  # fmt: skip
        return out

    # ---- control

    async def restart(self, changes: dict) -> None:
        allowed = {
            "seed": int, "start_day": str, "start_hour": float, "hours": float,
            "n_drivers": int, "peak_orders_per_hour": float, "traffic_scale": float,
            "dispatcher": str, "courier_mode": str, "delivery_radius_m": float,
        }  # fmt: skip
        try:
            clean = {k: allowed[k](v) for k, v in changes.items() if k in allowed}
            cfg = replace(self.sim.cfg, **clean)
        except (TypeError, ValueError):
            log.warning("ignored a restart with invalid settings: %r", changes)
            return
        cfg.delivery_radius_m = float(np.clip(cfg.delivery_radius_m, 300, 8000))
        cfg.n_drivers = int(np.clip(cfg.n_drivers, 1, 2000))
        cfg.peak_orders_per_hour = float(np.clip(cfg.peak_orders_per_hour, 1, 5000))
        cfg.start_hour = float(np.clip(cfg.start_hour, 0, 23.5))
        cfg.traffic_scale = float(np.clip(cfg.traffic_scale, 0, 3))
        self.busy = True
        try:
            self.sim = await asyncio.to_thread(Simulation, cfg, self.net)
            self.generation += 1
            self._kpi_at = -1.0
        except FileNotFoundError as exc:  # transit asked for, but no timetable downloaded
            log.warning("restart skipped: %s", exc)
        finally:
            self.busy = False

    async def handle(self, c: Client, msg: dict) -> None:
        cmd = msg.get("cmd")
        if cmd == "play":
            self.playing = bool(msg.get("on", True))
        elif cmd == "speed" and msg.get("value") in SPEEDS:
            self.speed = msg["value"]
        elif cmd == "dispatcher" and msg.get("name") in DISPATCHERS:
            self.sim.set_dispatcher(msg["name"])
        elif cmd == "restart" and not self.busy:
            await self.restart(msg.get("config", {}))
            self.playing = True
        elif cmd == "select":
            did = msg.get("id")
            c.selected = did if isinstance(did, int) and did >= 0 else None

    async def loop(self) -> None:
        last = time.monotonic()
        while True:
            await asyncio.sleep(TICK_S)
            now = time.monotonic()
            # Cap the step so a slow tick does not snowball into a bigger one.
            elapsed, last = min(now - last, 0.25), now
            if self.playing and not self.busy and not self.sim.finished:
                self.sim.run_until(self.sim.now + self.speed * elapsed)
            for c in list(self.clients):
                try:
                    if c.generation != self.generation:
                        c.generation = self.generation
                        c.feed_seq = c.route_seq = c.series_n = 0
                        c.selected = None
                        await c.ws.send_json(self.hello())
                    await c.ws.send_json(self.state_for(c))
                except Exception as exc:
                    if not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                        log.exception("dropping a browser connection")
                    if c in self.clients:
                        self.clients.remove(c)


def create_app(cfg: SimConfig | None = None) -> FastAPI:
    live = LiveSim(cfg or SimConfig())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(live.loop())
        yield
        task.cancel()

    app = FastAPI(title="Seattle Dispatch Lab", lifespan=lifespan)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})

    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        await socket.accept()
        client = Client(socket)
        live.clients.append(client)
        try:
            while True:
                await live.handle(client, await socket.receive_json())
        except WebSocketDisconnect:
            pass
        finally:
            if client in live.clients:
                live.clients.remove(client)

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
