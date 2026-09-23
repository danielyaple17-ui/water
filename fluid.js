/*
 * 2D particle fluid: "Particle-based Viscoelastic Fluid Simulation"
 * (Clavet, Beaudoin, Poulin 2005) — double density relaxation + pairwise viscosity.
 *
 * Units: lengths are in interaction radii (h = 1), time in seconds.
 * The solver runs at a fixed time step (Fluid.DT); stiffness constants are tuned for it.
 * y points down (screen convention).
 */
(function (global) {
  'use strict';

  var DT = 1 / 240;

  var DEFAULTS = {
    spacing: 0.42,        // rest spacing of particles (fraction of h)
    stiffness: 0.1,       // pressure displacement per unit relative density error per step
    nearStiffness: 0.25,  // near-pressure (anti-clustering)
    viscLinear: 0.03,     // linear viscosity (per step, dimensionless)
    viscQuad: 0.004,      // quadratic viscosity (per step, per h/s)
    wallMargin: 0.12,     // how close particles may get to a wall (h)
    maxStepMove: 0.45,    // velocity clamp: max travel per step (h)
    airDrag: 0.05         // 1/s, tiny damping so flat-phone drift settles
  };

  // Rest density of a hexagonal lattice with the given spacing, using the (1 - q)^2 kernel.
  function latticeDensity(s) {
    var rho = 0, rowH = s * Math.sqrt(3) / 2;
    var nr = Math.ceil(1 / rowH) + 1, nc = Math.ceil(1 / s) + 2;
    for (var r = -nr; r <= nr; r++) {
      var off = (r & 1) ? s / 2 : 0;
      for (var c = -nc; c <= nc; c++) {
        var x = c * s + off, y = r * rowH;
        var d = Math.sqrt(x * x + y * y);
        if (d > 1e-9 && d < 1) rho += (1 - d) * (1 - d);
      }
    }
    return rho;
  }

  function Fluid(count, width, height, params) {
    var p = {};
    for (var k in DEFAULTS) p[k] = DEFAULTS[k];
    if (params) for (k in params) p[k] = params[k];
    this.p = p;
    this.restDensity = latticeDensity(p.spacing);

    this.n = count;
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    this.px = new Float64Array(count);
    this.py = new Float64Array(count);
    this.rho = new Float64Array(count);
    this.rhoNear = new Float64Array(count);
    this.press = new Float64Array(count);
    this.pressNear = new Float64Array(count);
    this.sorted = new Int32Array(count);

    this.maxPairs = count * 40;
    this.pairI = new Int32Array(this.maxPairs);
    this.pairJ = new Int32Array(this.maxPairs);
    this.pairQ = new Float64Array(this.maxPairs);
    this.pairNx = new Float64Array(this.maxPairs);
    this.pairNy = new Float64Array(this.maxPairs);
    this.pairCount = 0;

    this.gx = 0;
    this.gy = 0;
    // Pointer interaction (in h units / h per second)
    this.pointer = { active: false, x: 0, y: 0, vx: 0, vy: 0, radius: 2.5 };

    this.resize(width, height, false);
    this.reset();
  }

  Fluid.DT = DT;
  Fluid.defaults = DEFAULTS;
  Fluid.latticeDensity = latticeDensity;

  Fluid.prototype.resize = function (width, height, rescale) {
    var oldW = this.w, oldH = this.h;
    this.w = width;
    this.h = height;
    this.cols = Math.max(1, Math.ceil(width));
    this.rows = Math.max(1, Math.ceil(height));
    var cells = this.cols * this.rows;
    if (!this.cellStart || this.cellStart.length < cells + 1) {
      this.cellStart = new Int32Array(cells + 1);
      this.cellCount = new Int32Array(cells);
    }
    if (rescale && oldW > 0 && oldH > 0) {
      var sx = width / oldW, sy = height / oldH;
      for (var i = 0; i < this.n; i++) {
        this.x[i] *= sx; this.y[i] *= sy;
      }
      this.clampToWalls();
    }
  };

  // Fill the bottom of the container with a hexagonal block of particles.
  Fluid.prototype.reset = function () {
    var s = this.p.spacing, m = this.p.wallMargin + 0.05;
    var rowH = s * Math.sqrt(3) / 2;
    var perRow = Math.max(1, Math.floor((this.w - 2 * m - s / 2) / s) + 1);
    for (var i = 0; i < this.n; i++) {
      var r = Math.floor(i / perRow), c = i % perRow;
      var jitter = ((i * 2654435761) % 1000) / 1000 * 0.01;
      this.x[i] = m + c * s + ((r & 1) ? s / 2 : 0) + jitter;
      this.y[i] = this.h - m - r * rowH;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
    this.clampToWalls();
  };

  Fluid.prototype.clampToWalls = function () {
    var m = this.p.wallMargin, x0 = m, y0 = m, x1 = this.w - m, y1 = this.h - m;
    var x = this.x, y = this.y;
    for (var i = 0; i < this.n; i++) {
      if (x[i] < x0) x[i] = x0; else if (x[i] > x1) x[i] = x1;
      if (y[i] < y0) y[i] = y0; else if (y[i] > y1) y[i] = y1;
    }
  };

  Fluid.prototype.cellOf = function (x, y) {
    var cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cx + cy * this.cols;
  };

  // Counting sort into a uniform grid of cell size h, then collect all pairs (i < j) with r < h.
  Fluid.prototype.findPairs = function () {
    var n = this.n, x = this.x, y = this.y;
    var cols = this.cols, rows = this.rows, cells = cols * rows;
    var start = this.cellStart, count = this.cellCount, sorted = this.sorted;
    var i, c;

    count.fill(0, 0, cells);
    for (i = 0; i < n; i++) count[this.cellOf(x[i], y[i])]++;
    start[0] = 0;
    for (c = 0; c < cells; c++) start[c + 1] = start[c] + count[c];
    count.fill(0, 0, cells);
    for (i = 0; i < n; i++) {
      c = this.cellOf(x[i], y[i]);
      sorted[start[c] + count[c]++] = i;
    }

    var pI = this.pairI, pJ = this.pairJ, pQ = this.pairQ, pNx = this.pairNx, pNy = this.pairNy;
    var maxPairs = this.maxPairs, np = 0;

    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var cell = cx + cy * cols;
        var aStart = start[cell], aEnd = start[cell + 1];
        if (aStart === aEnd) continue;
        // Visit this cell and the 4 "forward" neighbours so every cell pair is seen once.
        for (var k = 0; k < 5; k++) {
          var ox, oy;
          if (k === 0) { ox = 0; oy = 0; }
          else if (k === 1) { ox = 1; oy = 0; }
          else if (k === 2) { ox = -1; oy = 1; }
          else if (k === 3) { ox = 0; oy = 1; }
          else { ox = 1; oy = 1; }
          var nx = cx + ox, ny = cy + oy;
          if (nx < 0 || nx >= cols || ny >= rows) continue;
          var other = nx + ny * cols;
          var bStart = start[other], bEnd = start[other + 1];
          for (var a = aStart; a < aEnd; a++) {
            var ia = sorted[a], xa = x[ia], ya = y[ia];
            for (var b = (k === 0 ? a + 1 : bStart); b < bEnd; b++) {
              var ib = sorted[b];
              var dx = x[ib] - xa, dy = y[ib] - ya;
              var r2 = dx * dx + dy * dy;
              if (r2 >= 1) continue;
              if (np >= maxPairs) { this.pairCount = np; return; }
              var r = Math.sqrt(r2), ux, uy;
              if (r > 1e-6) { ux = dx / r; uy = dy / r; }
              else {
                // Coincident particles: separate them along a deterministic pseudo-random direction.
                var ang = (ia * 7.13 + ib * 3.71) % 6.283185307;
                ux = Math.cos(ang); uy = Math.sin(ang); r = 0;
              }
              pI[np] = ia; pJ[np] = ib; pQ[np] = r; pNx[np] = ux; pNy[np] = uy;
              np++;
            }
          }
        }
      }
    }
    this.pairCount = np;
  };

  Fluid.prototype.relax = function () {
    var n = this.n, np = this.pairCount;
    var rho = this.rho, rhoN = this.rhoNear, P = this.press, PN = this.pressNear;
    var pI = this.pairI, pJ = this.pairJ, pQ = this.pairQ, pNx = this.pairNx, pNy = this.pairNy;
    var x = this.x, y = this.y;
    var k = this.p.stiffness, kn = this.p.nearStiffness, rho0 = this.restDensity;
    var i, e;

    rho.fill(0); rhoN.fill(0);
    for (e = 0; e < np; e++) {
      var t = 1 - pQ[e], t2 = t * t, t3 = t2 * t;
      rho[pI[e]] += t2; rho[pJ[e]] += t2;
      rhoN[pI[e]] += t3; rhoN[pJ[e]] += t3;
    }
    // Pressure is normalised by the rest density so stiffness is independent of spacing.
    for (i = 0; i < n; i++) {
      P[i] = k * (rho[i] - rho0) / rho0;
      PN[i] = kn * rhoN[i] / rho0;
    }
    for (e = 0; e < np; e++) {
      var a = pI[e], b = pJ[e], t1 = 1 - pQ[e];
      var d = 0.5 * ((P[a] + P[b]) * t1 + (PN[a] + PN[b]) * t1 * t1) * 0.5;
      var dx = d * pNx[e], dy = d * pNy[e];
      x[a] -= dx; y[a] -= dy;
      x[b] += dx; y[b] += dy;
    }
  };

  Fluid.prototype.viscosity = function () {
    var np = this.pairCount, sig = this.p.viscLinear, bet = this.p.viscQuad;
    var pI = this.pairI, pJ = this.pairJ, pQ = this.pairQ, pNx = this.pairNx, pNy = this.pairNy;
    var vx = this.vx, vy = this.vy;
    for (var e = 0; e < np; e++) {
      var a = pI[e], b = pJ[e];
      var nx = pNx[e], ny = pNy[e];
      var u = (vx[a] - vx[b]) * nx + (vy[a] - vy[b]) * ny; // inward radial velocity
      if (u <= 0) continue;
      var imp = (1 - pQ[e]) * (sig * u + bet * u * u);
      if (imp > u) imp = u; // never reverse the relative velocity
      var ix = 0.5 * imp * nx, iy = 0.5 * imp * ny;
      vx[a] -= ix; vy[a] -= iy;
      vx[b] += ix; vy[b] += iy;
    }
  };

  Fluid.prototype.step = function () {
    var n = this.n, dt = DT;
    var x = this.x, y = this.y, vx = this.vx, vy = this.vy, px = this.px, py = this.py;
    var gx = this.gx, gy = this.gy;
    var drag = Math.max(0, 1 - this.p.airDrag * dt);
    var vmax = this.p.maxStepMove / dt, vmax2 = vmax * vmax;
    var ptr = this.pointer, pr = ptr.radius, pr2 = pr * pr;
    var i;

    for (i = 0; i < n; i++) {
      var ax = vx[i] + gx * dt, ay = vy[i] + gy * dt;
      if (ptr.active) {
        var dx = x[i] - ptr.x, dy = y[i] - ptr.y, d2 = dx * dx + dy * dy;
        if (d2 < pr2) {
          var d = Math.sqrt(d2), w = 1 - d / pr;
          // Drag the water along with the finger, and push it out from under the fingertip.
          var blend = Math.min(1, 12 * dt) * w;
          ax += (ptr.vx - ax) * blend;
          ay += (ptr.vy - ay) * blend;
          if (d > 1e-6) {
            var push = 60 * w * w * dt;
            ax += dx / d * push;
            ay += dy / d * push;
          }
        }
      }
      ax *= drag; ay *= drag;
      var s2 = ax * ax + ay * ay;
      if (s2 > vmax2) { var sc = vmax / Math.sqrt(s2); ax *= sc; ay *= sc; }
      vx[i] = ax; vy[i] = ay;
      px[i] = x[i]; py[i] = y[i];
      x[i] += ax * dt; y[i] += ay * dt;
    }

    this.clampToWalls();
    this.findPairs();
    this.relax();
    this.clampToWalls();

    var inv = 1 / dt;
    for (i = 0; i < n; i++) {
      vx[i] = (x[i] - px[i]) * inv;
      vy[i] = (y[i] - py[i]) * inv;
    }
    this.viscosity();

    // Pressure corrections can inject large velocities under violent motion; cap them.
    for (i = 0; i < n; i++) {
      var v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > vmax2) { var f = vmax / Math.sqrt(v2); vx[i] *= f; vy[i] *= f; }
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Fluid;
  else global.Fluid = Fluid;
})(this);
