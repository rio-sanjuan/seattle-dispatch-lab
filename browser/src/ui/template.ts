// The widget's markup. Elements the code needs are marked with data-el.

export const TEMPLATE = /* html */ `
<div class="sdl-frame">
  <div class="sdl-map" data-el="map">
    <canvas class="sdl-base" data-el="base" aria-hidden="true"></canvas>
    <canvas class="sdl-top" data-el="top" role="img"
      aria-label="Map of Seattle showing drivers, restaurants and customers waiting for a delivery"></canvas>
    <div class="sdl-zoom" hidden data-el="zoom">
      <button type="button" data-el="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" data-el="zoom-out" aria-label="Zoom out">−</button>
      <button type="button" class="sdl-fit" data-el="zoom-fit" aria-label="Show the whole city">All</button>
    </div>
    <div class="sdl-banner" data-el="banner" role="status" hidden></div>
    <div class="sdl-hover" data-el="hover"></div>
    <details class="sdl-legend" data-el="legend" hidden>
      <summary>Map key</summary>
      <div class="sdl-items">
        <div class="sdl-item"><span class="sdl-dot" style="background:var(--sdl-idle)"></span>Driver, free</div>
        <div class="sdl-item"><span class="sdl-dot" style="background:var(--sdl-to-restaurant)"></span>Driver heading to restaurant</div>
        <div class="sdl-item"><span class="sdl-dot" style="background:var(--sdl-at-restaurant)"></span>Driver waiting at restaurant</div>
        <div class="sdl-item"><span class="sdl-dot" style="background:var(--sdl-delivering)"></span>Driver delivering</div>
        <div class="sdl-item"><span class="sdl-ring"></span>Customer waiting</div>
        <div class="sdl-item"><span class="sdl-ring sdl-late"></span>Customer, order running late</div>
        <div class="sdl-item"><span class="sdl-tiny"></span>Restaurant</div>
        <div class="sdl-item"><span class="sdl-ramp" data-el="ramp"></span><span data-el="ramp-label">Freeway slowdown</span></div>
      </div>
    </details>
    <div class="sdl-start" data-el="start">
      <button type="button" class="sdl-primary" data-el="start-button">Start the simulation</button>
      <p>Runs in your browser. Loads about 1 MB of Seattle street data.</p>
    </div>
  </div>

  <div class="sdl-panel">
    <section>
      <h2>Seattle Dispatch Lab</h2>
      <div class="sdl-clock-row">
        <div class="sdl-clock" data-el="clock">–</div>
        <div class="sdl-run-state" data-el="run-state" role="status">Not started</div>
      </div>
      <div class="sdl-progress" data-el="progress"><div></div></div>
    </section>

    <section class="sdl-controls">
      <button type="button" class="sdl-primary" data-el="play" style="min-width:84px" disabled>Pause</button>
      <div class="sdl-seg" data-el="speeds" role="group" aria-label="Simulation speed"></div>
      <div class="sdl-wide">
        <label data-for="dispatcher">Dispatcher (switches immediately)</label>
        <select data-el="dispatcher"></select>
      </div>
    </section>

    <section>
      <div class="sdl-tiles">
        <div class="sdl-tile"><div class="sdl-label">Average delivery time</div><div class="sdl-value" data-el="k-avg">–</div><div class="sdl-sub">last 60 min</div></div>
        <div class="sdl-tile"><div class="sdl-label">Delivered late</div><div class="sdl-value" data-el="k-late">–</div><div class="sdl-sub">last 60 min, vs. promised time</div></div>
        <div class="sdl-tile"><div class="sdl-label">Orders waiting for a driver</div><div class="sdl-value" data-el="k-open">–</div><div class="sdl-sub" data-el="k-open-sub">right now</div></div>
        <div class="sdl-tile"><div class="sdl-label">Drivers on a delivery</div><div class="sdl-value" data-el="k-busy">–</div><div class="sdl-sub" data-el="k-busy-sub">right now</div></div>
      </div>
    </section>

    <section>
      <h3>Traffic right now: travel time vs. an empty road</h3>
      <div class="sdl-traffic" data-el="traffic"></div>
      <p class="sdl-note">Freeways: measured by road sensors (typical 2015 week). City streets: estimated, no sensor data.</p>
    </section>

    <section>
      <div class="sdl-chart-head"><h3>The day so far</h3><button type="button" data-el="toggle-table" aria-pressed="false">Show as table</button></div>
      <div data-el="charts">
        <figure><figcaption>Orders waiting for a driver</figcaption><svg class="sdl-chart" data-el="c-open" role="img" aria-label="Orders waiting for a driver, over the day"></svg></figure>
        <figure><figcaption>Drivers<span class="sdl-keys"><span><i class="sdl-key" style="border-color:var(--sdl-to-restaurant)"></i>on a delivery</span><span><i class="sdl-key" style="border-color:var(--sdl-muted)"></i>on shift</span></span></figcaption><svg class="sdl-chart" data-el="c-drivers" role="img" aria-label="Drivers on shift and on a delivery, over the day"></svg></figure>
        <figure><figcaption>Average delivery time, minutes (trailing 30 min)</figcaption><svg class="sdl-chart" data-el="c-avg" role="img" aria-label="Average delivery time over the day"></svg></figure>
      </div>
      <div class="sdl-table" data-el="table" hidden></div>
    </section>

    <section class="sdl-detail" data-el="detail" hidden></section>

    <section>
      <h3>What just happened</h3>
      <ul class="sdl-feed" data-el="feed"></ul>
    </section>

    <details>
      <summary>Change the scenario and restart</summary>
      <div class="sdl-form">
        <div><label data-for="f-drivers">Drivers (whole day)</label><input data-el="f-drivers" type="number" min="1" max="2000"></div>
        <div><label data-for="f-orders">Orders per hour at peak</label><input data-el="f-orders" type="number" min="1" max="5000"></div>
        <div><label data-for="f-day">Day</label><select data-el="f-day"></select></div>
        <div><label data-for="f-start">Start hour (0–23)</label><input data-el="f-start" type="number" min="0" max="23" step="1"></div>
        <div><label data-for="f-traffic">Traffic (0 = none, 1 = measured)</label><input data-el="f-traffic" type="number" min="0" max="3" step="0.25"></div>
        <div><label data-for="f-radius">Delivery radius (km)</label><input data-el="f-radius" type="number" min="0.3" max="8" step="0.5"></div>
        <div class="sdl-wide"><label data-for="f-seed">Random seed (same seed, same day)</label><input data-el="f-seed" type="number" min="0"></div>
        <button type="button" class="sdl-wide" data-el="restart">Restart the day</button>
      </div>
    </details>

    <p class="sdl-credits">
      Drivers, customers, orders and restaurant names are simulated. Streets ©
      <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors.
      Freeway speeds: UW STAR Lab / WSDOT loop-detector dataset (CC-BY-4.0).
    </p>
  </div>
</div>
<div class="sdl-tip" data-el="tip"></div>
`;
