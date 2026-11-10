/* Live view for Seattle Dispatch Lab. Plain JavaScript, no build step.
   The server sends a "hello" (static world) and then ~10 "state" messages a
   second; this file draws them on the map and in the side panel. */
"use strict";

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dark = matchMedia("(prefers-color-scheme: dark)");
dark.addEventListener("change", () => location.reload());

// Driver states: 0 offline, 1 idle, 2 offered, 3 to_restaurant, 4 at_restaurant, 5 to_customer, 6 at_door
const DRIVER_LABEL = ["Off shift", "Free", "Deciding on an offer", "Heading to restaurant",
  "Waiting at restaurant", "Delivering", "At the customer's door"];
const ORDER_LABEL = ["Waiting for a driver", "Offered to a driver", "Driver on the way to restaurant",
  "Driver at restaurant", "On the way to customer", "Delivered"];
const DRIVER_COLOR = () => [css("--idle"), css("--idle"), css("--idle"), css("--to-restaurant"),
  css("--at-restaurant"), css("--delivering"), css("--delivering")];
const TRAFFIC_NAME = { I5_N: "I-5 northbound", I5_S: "I-5 southbound", arterial: "Main city streets (estimated)",
  local: "Side streets (estimated)" };

let meta = null, last = null, ws = null, mapReady = false, selected = null;
let series = [], feed = [];
const drivers = new Map();   // id -> {from, to, t0, status, order}
const routes = new Map();    // id -> [[lon, lat], ...]
let routesDirty = false, trafficKey = "";

// ------------------------------------------------------------------ map

const map = new maplibregl.Map({
  container: "map",
  style: `https://tiles.openfreemap.org/styles/${dark.matches ? "dark" : "positron"}`,
  center: [-122.335, 47.61], zoom: 11.3, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
const fc = (features) => ({ type: "FeatureCollection", features });
const point = (lon, lat, properties) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } });
const line = (coords, properties) => ({ type: "Feature", properties, geometry: { type: "LineString", coordinates: coords } });

map.on("load", () => {
  const colors = DRIVER_COLOR();
  const byStatus = ["match", ["get", "status"], 3, colors[3], 4, colors[4], 5, colors[5], 6, colors[6], colors[1]];
  for (const id of ["transit", "freeways", "routes", "restaurants", "orders", "focus", "drivers"]) {
    map.addSource(id, { type: "geojson", data: fc([]) });
  }
  map.addLayer({ id: "freeways", type: "line", source: "freeways",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": css("--muted"), "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4], "line-opacity": 0.85 } });
  map.addLayer({ id: "transit", type: "line", source: "transit",
    paint: { "line-color": css("--ink-2"), "line-width": 1, "line-opacity": 0.28 } }, "freeways");
  map.addLayer({ id: "routes", type: "line", source: "routes",
    paint: { "line-color": byStatus, "line-width": 1.5, "line-opacity": 0.3 } });
  map.addLayer({ id: "restaurants", type: "circle", source: "restaurants",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 3.5], "circle-color": css("--muted"), "circle-opacity": 0.75 } });
  map.addLayer({ id: "orders", type: "circle", source: "orders",
    paint: { "circle-radius": 4.5, "circle-color": ["case", ["get", "late"], css("--critical"), "rgba(0,0,0,0)"],
      "circle-stroke-width": 2, "circle-stroke-color": ["case", ["get", "late"], css("--critical"), css("--ink")] } });
  map.addLayer({ id: "focus-line", type: "line", source: "focus", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": css("--ink"), "line-width": 3.5, "line-opacity": 0.9 } });
  map.addLayer({ id: "focus-pt", type: "circle", source: "focus", filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": 8, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5, "circle-stroke-color": css("--ink") } });
  map.addLayer({ id: "drivers", type: "circle", source: "drivers",
    paint: { "circle-radius": ["case", ["get", "sel"], 8, 5.5], "circle-color": byStatus,
      "circle-stroke-width": ["case", ["get", "transit"], 2.5, 2],
      "circle-stroke-color": ["case", ["get", "transit"], css("--ink"), css("--surface")] } });

  const hover = (layer, text) => {
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const node = document.createElement("div");
      node.textContent = text(e.features[0].properties);
      popup.setLngLat(e.lngLat).setDOMContent(node).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
  };
  hover("drivers", (p) => `Driver ${p.id}${p.transit ? " (public transit)" : ""}: ${DRIVER_LABEL[p.status]}${p.order >= 0 ? `, order #${p.order}` : ""}`);
  hover("orders", (p) => `Order #${p.id}: ${ORDER_LABEL[p.status]}. Promised by ${clock(p.promised)}${p.late ? " (late)" : ""}`);
  hover("restaurants", (p) => `${p.name} (food usually ready in ${p.prep} min)`);
  map.on("click", (e) => {
    const hit = map.queryRenderedFeatures(
      [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["drivers"] });
    select(hit.length ? hit[0].properties.id : null);
  });
  mapReady = true;
  if (meta) applyMeta();
  requestAnimationFrame(frame);
});

function applyMeta() {
  map.getSource("restaurants").setData(fc(meta.restaurants.map(([id, lon, lat, name, prep]) => point(lon, lat, { id, name, prep }))));
  map.getSource("freeways").setData(fc(meta.freeways.flatMap((f) => f.lines.map((c) => line(c, { cls: f.cls })))));
  map.getSource("transit").setData(fc(meta.transit_lines.map((c) => line(c, {}))));
  for (const n of document.querySelectorAll(".transit-only")) n.hidden = meta.config.courier_mode === "car";
  fitCity();
  trafficKey = "";
}

// Keep the whole city in view until the user pans or zooms for themselves.
let userMoved = false;
function fitCity() {
  if (!meta || userMoved) return;
  const b = meta.bounds;
  map.resize();
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 24, duration: 0 });
}
for (const type of ["dragstart", "zoomstart"]) map.on(type, (e) => { if (e.originalEvent) userMoved = true; });
new ResizeObserver(() => { if (mapReady) fitCity(); }).observe($("map"));

// Slowdown multiplier -> colour on a single red ramp. The severe end is the one
// that stands out from the basemap: darkest on the light map, brightest on the dark one.
const RAMP = dark.matches
  ? [[1.0, [70, 68, 66]], [1.25, [112, 38, 38]], [2.0, [208, 59, 59]], [3.2, [255, 170, 160]]]
  : [[1.0, [176, 174, 168]], [1.25, [241, 185, 179]], [2.0, [208, 59, 59]], [3.2, [125, 23, 23]]];
$("ramp").style.background = `linear-gradient(90deg, ${RAMP.slice(1).map((s) => `rgb(${s[1]})`).join(", ")})`;
$("ramp-label").textContent = `Freeway slowdown (${dark.matches ? "brighter" : "darker"} = slower)`;
function slowColor(x) {
  const stops = RAMP;
  if (x <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const f = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return `rgb(${stops[i][1].map((v, k) => Math.round(stops[i - 1][1][k] + f * (v - stops[i - 1][1][k])))})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}

function frame() {
  const now = performance.now(), feats = [];
  for (const [id, d] of drivers) {
    const f = Math.min(1, (now - d.t0) / 110);
    const lon = d.from[0] + f * (d.to[0] - d.from[0]), lat = d.from[1] + f * (d.to[1] - d.from[1]);
    d.at = [lon, lat];
    feats.push(point(lon, lat, { id, status: d.status, order: d.order, transit: d.transit, sel: id === selected }));
  }
  map.getSource("drivers").setData(fc(feats));
  requestAnimationFrame(frame);
}

function select(id) {
  selected = id;
  ws?.send(JSON.stringify({ cmd: "select", id: id ?? -1 }));
  if (id === null) { $("detail").hidden = true; map.getSource("focus").setData(fc([])); }
}

// ------------------------------------------------------------- helpers

function clock(simSeconds) {
  const h = meta.config.start_hour + simSeconds / 3600;
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60 + 1e-6);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
const fmt = (v, digits = 0) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(digits));
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function setValue(id, main, unit) {
  const n = $(id);
  n.textContent = main;
  if (unit) n.append(el("small", ` ${unit}`));
}

// ------------------------------------------------------------- messages

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") onHello(msg); else if (msg.type === "state" && meta) onState(msg);
  };
  ws.onclose = () => { $("run-state").textContent = "Disconnected. Retrying…"; setTimeout(connect, 1000); };
}

function onHello(msg) {
  meta = msg; series = []; feed = []; drivers.clear(); routes.clear(); routesDirty = true;
  selected = null; $("detail").hidden = true; $("feed").replaceChildren();
  const sel = $("dispatcher"); sel.replaceChildren();
  for (const d of msg.dispatchers) { const o = el("option", d.label); o.value = d.name; sel.append(o); }
  const seg = $("speeds"); seg.replaceChildren();
  for (const s of msg.speeds) {
    const b = el("button", `${s}×`); b.dataset.speed = s; b.title = `${s} simulated seconds per second`;
    b.onclick = () => ws.send(JSON.stringify({ cmd: "speed", value: s }));
    seg.append(b);
  }
  const day = $("f-day"); day.replaceChildren();
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) { const o = el("option", d); o.value = d; day.append(o); }
  const c = msg.config;
  $("f-drivers").value = c.n_drivers; $("f-orders").value = c.peak_orders_per_hour; day.value = c.start_day;
  $("f-start").value = c.start_hour; $("f-traffic").value = c.traffic_scale; $("f-seed").value = c.seed;
  $("f-mode").value = c.courier_mode; $("f-radius").value = c.delivery_radius_m / 1000;
  if (mapReady) applyMeta();
}

function onState(s) {
  last = s;
  $("clock").textContent = s.clock;
  $("progress").firstElementChild.style.width = `${(100 * s.t / s.end).toFixed(1)}%`;
  $("run-state").textContent = s.busy ? "Building a new day…" : s.finished ? "Day finished" : s.playing ? `Running at ${s.speed}×` : "Paused";
  $("play").textContent = s.finished ? "Finished" : s.playing ? "Pause" : "Play";
  $("play").disabled = s.finished;
  for (const b of $("speeds").children) b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === s.speed));
  if (document.activeElement !== $("dispatcher")) $("dispatcher").value = s.dispatcher;
  $("banner").style.display = s.busy ? "block" : "none";
  $("banner").textContent = "Building a new day…";

  // Drivers: remember where each one is drawn now and where it should go.
  const t0 = performance.now(), seen = new Set();
  for (const [id, lon, lat, status, order, onTransit] of s.drivers) {
    seen.add(id);
    const d = drivers.get(id);
    if (d) { d.from = d.at ?? d.to; d.to = [lon, lat]; d.t0 = t0; d.status = status; d.order = order; }
    else drivers.set(id, { from: [lon, lat], to: [lon, lat], t0, status, order, transit: onTransit === 1 });
  }
  for (const id of drivers.keys()) if (!seen.has(id)) { drivers.delete(id); routes.delete(id); routesDirty = true; }

  for (const [id, coords] of Object.entries(s.routes)) {
    if (coords) routes.set(Number(id), coords); else routes.delete(Number(id));
    routesDirty = true;
  }

  let open = 0, late = 0;
  const orderFeats = s.orders.map(([id, status, rest, lon, lat, placed, promised, driver]) => {
    if (status <= 1) open++;
    const isLate = s.t > promised;
    if (isLate) late++;
    return point(lon, lat, { id, status, rest, promised, driver, late: isLate });
  });

  if (mapReady) {
    map.getSource("orders").setData(fc(orderFeats));
    if (routesDirty) {
      map.getSource("routes").setData(fc([...routes].map(([id, c]) => line(c, { id, status: drivers.get(id)?.status ?? 3 }))));
      routesDirty = false;
    }
    const key = s.traffic.join();
    if (key !== trafficKey) {
      trafficKey = key;
      const expr = ["match", ["get", "cls"]];
      meta.traffic_classes.forEach((cls, i) => expr.push(cls, slowColor(s.traffic[i])));
      expr.push(css("--muted"));
      map.setPaintProperty("freeways", "line-color", expr);
    }
  }

  // Headline tiles
  const k = s.kpi.hour, online = s.drivers.length, busy = s.drivers.filter((d) => d[3] >= 3).length;
  setValue("k-avg", fmt(k.avg_delivery_min), "min");
  setValue("k-late", fmt(k.late_pct), "%");
  setValue("k-open", String(open));
  $("k-open-sub").textContent = late ? `right now · ${late} active order${late === 1 ? "" : "s"} past the promised time` : "right now";
  setValue("k-busy", String(busy), `of ${online}`);
  $("k-busy-sub").textContent = `right now · ${s.kpi.all.delivered ?? 0} delivered today`;

  // Traffic strip
  const tr = $("traffic"); tr.replaceChildren();
  meta.traffic_classes.forEach((cls, i) => {
    if (!TRAFFIC_NAME[cls]) return;
    tr.append(el("div", TRAFFIC_NAME[cls], "name"), el("div", `×${s.traffic[i].toFixed(2)}`, "x"));
  });

  if (s.series.length) { series.push(...s.series); drawCharts(); }
  if (s.feed.length) addFeed(s.feed);
  if (s.detail && selected !== null) showDetail(s.detail);
}

function addFeed(items) {
  const ul = $("feed");
  for (const e of items) {
    if (e.kind === "order" || e.kind === "pickup") continue; // keep the list to decisions and outcomes
    const li = el("li", null, e.kind);
    li.append(el("time", clock(e.t)), el("span", e.text));
    ul.prepend(li);
  }
  while (ul.children.length > 60) ul.lastElementChild.remove();
}

function showDetail(d) {
  const box = $("detail"); box.hidden = false; box.replaceChildren();
  const head = el("div", null, "head"); head.append(el("span", `Driver ${d.id}`));
  const close = el("button", "Close"); close.onclick = () => select(null); head.append(close);
  box.append(head);
  const row = (a, b) => { const r = el("div", null, "row"); r.append(el("span", a), el("span", b)); box.append(r); };
  row("Travels by", d.mode === "transit" ? "Public transit" : "Car");
  row("Doing now", DRIVER_LABEL[d.status]);
  if (d.leg) row("This minute", d.leg);
  row("Deliveries so far", String(d.deliveries));
  row("Offers declined", String(d.declines));
  row("Distance driven", `${d.km} km`);
  row("Shift ends", clock(d.shift_end));
  const focus = [];
  if (d.order) {
    const r = meta.restaurants[d.order.restaurant];
    row("Order", `#${d.order.id} from ${r[3]}`);
    row("Ordered at", clock(d.order.placed));
    row("Food expected ready", clock(d.order.est_ready));
    row("Promised to customer by", clock(d.order.promised));
    focus.push(point(r[1], r[2], {}), point(d.order.lon, d.order.lat, {}));
  }
  if (routes.has(d.id)) focus.push(line(routes.get(d.id), {}));
  if (mapReady) map.getSource("focus").setData(fc(focus));
}

// --------------------------------------------------------------- charts

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
const CHARTS = [
  { id: "c-open", unit: "", lines: [{ key: "open", label: "Waiting for a driver", color: "--ink" }] },
  { id: "c-drivers", unit: "", lines: [{ key: "online", label: "On shift", color: "--muted" }, { key: "busy", label: "On a delivery", color: "--to-restaurant" }] },
  { id: "c-avg", unit: " min", digits: 1, lines: [{ key: "avg_min", label: "Average delivery time", color: "--ink" }] },
];
let hoverIndex = null;

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function drawCharts() {
  if (!meta) return;
  const end = meta.config.hours * 3600;
  for (const ch of CHARTS) {
    const svg = $(ch.id), W = svg.clientWidth || 340, H = 86, L = 26, R = 6, T = 6, B = 16;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    const max = niceMax(Math.max(...ch.lines.flatMap((l) => series.map((p) => p[l.key] ?? 0)), 0));
    const x = (t) => L + (t / end) * (W - L - R), y = (v) => T + (1 - v / max) * (H - T - B);
    for (const v of [0, max / 2, max]) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: css(v === 0 ? "--axis" : "--grid"), "stroke-width": 1 }));
      const t = svgEl("text", { x: L - 5, y: y(v) + 3.5, "text-anchor": "end" }); t.textContent = String(v); svg.append(t);
    }
    const hours = meta.config.hours, step = hours <= 6 ? 1 : hours <= 12 ? 2 : 4;
    for (let h = 0; h <= hours + 1e-9; h += step) {
      const t = svgEl("text", { x: x(h * 3600), y: H - 3, "text-anchor": h === 0 ? "start" : h >= hours ? "end" : "middle" });
      t.textContent = clock(h * 3600); svg.append(t);
    }
    for (const l of ch.lines) {
      const pts = series.filter((p) => p[l.key] != null);
      if (!pts.length) continue;
      svg.append(svgEl("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[l.key]).toFixed(1)}`).join(""),
        fill: "none", stroke: css(l.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    if (hoverIndex != null && series[hoverIndex]) {
      const p = series[hoverIndex];
      svg.append(svgEl("line", { x1: x(p.t), x2: x(p.t), y1: T, y2: H - B, stroke: css("--ink-2"), "stroke-width": 1 }));
      for (const l of ch.lines) if (p[l.key] != null)
        svg.append(svgEl("circle", { cx: x(p.t), cy: y(p[l.key]), r: 4, fill: css(l.color), stroke: css("--surface"), "stroke-width": 2 }));
    }
    svg.onpointermove = (e) => {
      if (!series.length) return;
      const box = svg.getBoundingClientRect();
      const t = ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * end;
      let best = 0;
      series.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(series[best].t - t)) best = i; });
      hoverIndex = best; drawCharts(); showTip(e, ch, series[best]);
    };
    svg.onpointerleave = () => { hoverIndex = null; $("tip").style.display = "none"; drawCharts(); };
  }
  if (!$("table-wrap").hidden) drawTable();
}

function showTip(e, ch, p) {
  const tip = $("tip"); tip.replaceChildren(el("div", clock(p.t), "t"));
  for (const l of ch.lines) {
    const row = el("div"), key = el("i", null, "key"); key.style.borderColor = css(l.color);
    row.append(key, el("b", p[l.key] == null ? "–" : `${fmt(p[l.key], ch.digits ?? 0)}${ch.unit}`), ` ${l.label}`);
    tip.append(row);
  }
  tip.style.display = "block";
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - w - 8)}px`;
  tip.style.top = `${e.clientY - 12 - tip.offsetHeight}px`;
}

function drawTable() {
  const table = el("table"), head = el("tr");
  for (const h of ["Time", "Waiting", "On shift", "On delivery", "Avg min", "Late %"]) head.append(el("th", h));
  table.append(head);
  for (const p of [...series].reverse()) {
    const tr = el("tr");
    for (const v of [clock(p.t), p.open, p.online, p.busy, fmt(p.avg_min, 1), fmt(p.late_pct, 0)]) tr.append(el("td", String(v)));
    table.append(tr);
  }
  $("table-wrap").replaceChildren(table);
}

// -------------------------------------------------------------- controls

$("play").onclick = () => last && ws.send(JSON.stringify({ cmd: "play", on: !last.playing }));
$("dispatcher").onchange = (e) => ws.send(JSON.stringify({ cmd: "dispatcher", name: e.target.value }));
$("toggle-table").onclick = (e) => {
  const showTable = $("table-wrap").hidden;
  $("table-wrap").hidden = !showTable; $("charts").hidden = showTable;
  e.target.textContent = showTable ? "Show as charts" : "Show as table";
  e.target.setAttribute("aria-pressed", String(showTable));
  if (showTable) drawTable(); else drawCharts();
};
$("restart").onclick = () => ws.send(JSON.stringify({ cmd: "restart", config: {
  n_drivers: $("f-drivers").value, peak_orders_per_hour: $("f-orders").value, start_day: $("f-day").value,
  start_hour: $("f-start").value, traffic_scale: $("f-traffic").value, seed: $("f-seed").value,
  courier_mode: $("f-mode").value, delivery_radius_m: Number($("f-radius").value) * 1000,
  dispatcher: $("dispatcher").value } }));
addEventListener("resize", drawCharts);
connect();
