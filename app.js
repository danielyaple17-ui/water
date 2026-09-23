(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var FILL = 0.4;            // fraction of the screen covered by water at rest
  var MAX_STEPS = 8;         // solver steps per frame before we start dropping time
  var GRAVITY_TAU = 0.06;    // seconds; smooths sensor noise
  var SPLAT_RADIUS = 0.95;   // metaball radius, in h
  var SPLAT_AMP = 0.1;       // density contributed by one particle at its centre
  var TILE_PX = 44;          // background tile size, CSS px
  var THRESHOLD = 0.085;     // metaball iso-level (just below one lone particle's peak)

  var canvas = document.getElementById('c');
  var startEl = document.getElementById('start');
  var startBtn = document.getElementById('startBtn');
  var hud = document.getElementById('hud');
  var resetBtn = document.getElementById('resetBtn');
  var noteEl = document.getElementById('note');

  // ---------------------------------------------------------------- layout

  var cssW = 0, cssH = 0, dpr = 1;
  var hPx = 20;              // CSS pixels per simulation unit (interaction radius)
  var gravityScale = 100;    // |g| in h/s^2 when the screen is vertical
  var angle = screenAngle();
  var fluid = null;

  function screenAngle() {
    var a = 0;
    if (window.screen && screen.orientation && typeof screen.orientation.angle === 'number') {
      a = screen.orientation.angle;
    } else if (typeof window.orientation === 'number') {
      a = window.orientation;
    }
    return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
  }

  function measure() {
    cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
    cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  function createFluid() {
    measure();
    var area = cssW * cssH;
    var n = Math.round(Math.min(1600, Math.max(500, area / 260)));
    var s = Fluid.defaults.spacing;
    hPx = Math.sqrt(FILL * area / (n * s * s * Math.sqrt(3) / 2));
    fluid = new Fluid(n, cssW / hPx, cssH / hPx);
    updateGravityScale();
  }

  function updateGravityScale() {
    // Tied to the long side of the phone so the feel doesn't change when the screen rotates.
    gravityScale = 4 * Math.max(fluid.w, fluid.h);
  }

  // Rotate the water with the device when the browser switches between portrait and landscape.
  function rotateFluid(delta) {
    var W = fluid.w, H = fluid.h, x = fluid.x, y = fluid.y, vx = fluid.vx, vy = fluid.vy;
    for (var i = 0; i < fluid.n; i++) {
      var X = x[i], Y = y[i], VX = vx[i], VY = vy[i];
      if (delta === 90) { x[i] = Y; y[i] = W - X; vx[i] = VY; vy[i] = -VX; }
      else if (delta === 270) { x[i] = H - Y; y[i] = X; vx[i] = -VY; vy[i] = VX; }
      else { x[i] = W - X; y[i] = H - Y; vx[i] = -VX; vy[i] = -VY; }
    }
    var gx = grav.x, gy = grav.y;
    if (delta === 90) { grav.x = gy; grav.y = -gx; }
    else if (delta === 270) { grav.x = -gy; grav.y = gx; }
    else { grav.x = -gx; grav.y = -gy; }
    if (delta === 180) fluid.resize(W, H, false);
    else fluid.resize(H, W, false);
  }

  function syncSize() {
    var a = screenAngle();
    if (a !== angle) {
      rotateFluid((a - angle + 360) % 360);
      angle = a;
    }
    var oldW = cssW, oldH = cssH, oldDpr = dpr;
    measure();
    if (cssW !== oldW || cssH !== oldH || dpr !== oldDpr) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      renderer.resize();
    }
    var w = cssW / hPx, h = cssH / hPx;
    if (Math.abs(w - fluid.w) > 1e-6 || Math.abs(h - fluid.h) > 1e-6) {
      fluid.resize(w, h, true);
      updateGravityScale();
    }
  }

  // ---------------------------------------------------------------- gravity input

  var grav = { x: 0, y: 1 };         // smoothed, in units of g, screen coordinates (y down)
  var target = { x: 0, y: 1 };
  var sensor = { beta: null, gamma: null, seen: false };
  var keys = { left: false, right: false, up: false, down: false };

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!isFinite(e.beta) || !isFinite(e.gamma)) return;
    sensor.beta = e.beta;
    sensor.gamma = e.gamma;
    if (!sensor.seen) {
      sensor.seen = true;
      hideNote();
    }
  }

  function updateTarget() {
    if (sensor.seen) {
      // Direction of gravity in the device frame (x right, y up, z out of the screen),
      // from the W3C Z-X'-Y'' Euler angles: g = -(row 3 of Rz(alpha)Rx(beta)Ry(gamma)).
      var b = sensor.beta * DEG, g = sensor.gamma * DEG;
      var dx = Math.cos(b) * Math.sin(g);
      var dy = -Math.sin(b);
      // Rotate into screen axes (screen rotated `angle` degrees counter-clockwise from natural).
      var t = angle * DEG, c = Math.cos(t), s = Math.sin(t);
      var sx = dx * c - dy * s;
      var sUp = dx * s + dy * c;
      target.x = sx;
      target.y = -sUp;
    } else {
      var kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      var ky = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      if (kx === 0 && ky === 0) ky = 1;
      var len = Math.sqrt(kx * kx + ky * ky);
      target.x = kx / len;
      target.y = ky / len;
    }
  }

  var KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down'
  };
  window.addEventListener('keydown', function (e) {
    var k = KEYMAP[e.key];
    if (k) { keys[k] = true; e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'R') resetWater();
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYMAP[e.key];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', function () {
    keys.left = keys.right = keys.up = keys.down = false;
  });

  // ---------------------------------------------------------------- touch / mouse stirring

  var ptr = { id: null, x: 0, y: 0, ax: 0, ay: 0, t: 0, vx: 0, vy: 0, lastMove: 0 };

  function pointerPos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / hPx, y: (e.clientY - r.top) / hPx };
  }

  function bindPointer(cv) {
    cv.addEventListener('pointerdown', function (e) {
      if (ptr.id !== null) return;
      ptr.id = e.pointerId;
      var p = pointerPos(e);
      ptr.x = ptr.ax = p.x; ptr.y = ptr.ay = p.y; ptr.vx = 0; ptr.vy = 0;
      ptr.t = ptr.lastMove = e.timeStamp;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }
      e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) {
      if (e.pointerId !== ptr.id) return;
      var p = pointerPos(e);
      var dt = (e.timeStamp - ptr.t) / 1000;
      if (dt > 0.004) {
        // Velocity from the last anchor sample, lightly smoothed.
        var k = Math.min(1, dt / 0.03);
        ptr.vx += ((p.x - ptr.ax) / dt - ptr.vx) * k;
        ptr.vy += ((p.y - ptr.ay) / dt - ptr.vy) * k;
        ptr.ax = p.x; ptr.ay = p.y;
        ptr.t = e.timeStamp;
      }
      ptr.x = p.x; ptr.y = p.y;
      ptr.lastMove = e.timeStamp;
      e.preventDefault();
    });
    function endPointer(e) {
      if (e.pointerId !== ptr.id) return;
      ptr.id = null;
    }
    cv.addEventListener('pointerup', endPointer);
    cv.addEventListener('pointercancel', endPointer);
    cv.addEventListener('lostpointercapture', endPointer);
  }
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  function applyPointer(now) {
    var fp = fluid.pointer;
    fp.active = ptr.id !== null;
    if (!fp.active) return;
    if (now - ptr.lastMove > 50) { ptr.vx = 0; ptr.vy = 0; } // finger resting still
    var vmax = 80;
    var sp = Math.sqrt(ptr.vx * ptr.vx + ptr.vy * ptr.vy);
    var sc = sp > vmax ? vmax / sp : 1;
    fp.x = ptr.x; fp.y = ptr.y;
    fp.vx = ptr.vx * sc; fp.vy = ptr.vy * sc;
  }

  // ---------------------------------------------------------------- rendering

  var SPLAT_VS = [
    'attribute vec2 aCenter;',
    'attribute vec2 aCorner;',
    'attribute float aFoam;',
    'uniform vec2 uDomain;',
    'uniform float uRadius;',
    'varying vec2 vUv;',
    'varying float vFoam;',
    'void main() {',
    '  vec2 p = aCenter + aCorner * uRadius;',
    '  gl_Position = vec4(p.x / uDomain.x * 2.0 - 1.0, 1.0 - p.y / uDomain.y * 2.0, 0.0, 1.0);',
    '  vUv = aCorner;',
    '  vFoam = aFoam;',
    '}'
  ].join('\n');

  var SPLAT_FS = [
    'precision mediump float;',
    'uniform float uAmp;',
    'varying vec2 vUv;',
    'varying float vFoam;',
    'void main() {',
    '  float r2 = dot(vUv, vUv);',
    '  if (r2 >= 1.0) discard;',
    '  float w = 1.0 - r2;',
    '  w = w * w * uAmp;',
    '  gl_FragColor = vec4(w, w * vFoam, 0.0, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_FS = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uTexel;',       // one density texel, in uv
    'uniform vec2 uDepthR;',      // depth-probe radius, in uv
    'uniform float uThreshold;',
    'uniform vec2 uLight;',       // 2D direction light comes from (against gravity), y up
    'uniform float uPxScale;',    // device pixels -> tile units
    'varying vec2 vUv;',
    '',
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    '',
    // Slate tiles behind the glass: gives the water something to refract.
    'vec3 background(vec2 p) {',
    '  vec2 cell = floor(p);',
    '  vec2 f = fract(p) - 0.5;',
    '  float edge = max(abs(f.x), abs(f.y));',
    '  float grout = smoothstep(0.44, 0.48, edge);',
    '  float tone = 0.9 + 0.2 * hash(cell);',
    '  vec3 tile = vec3(0.075, 0.09, 0.125) * tone;',
    '  tile *= 1.0 - 0.18 * smoothstep(0.3, 0.44, edge);', // bevel shading
    '  return mix(tile, vec3(0.03, 0.035, 0.05), grout);',
    '}',
    '',
    'void main() {',
    '  vec2 px = gl_FragCoord.xy * uPxScale;',
    '  float vignette = 1.0 - 0.45 * dot(vUv - 0.5, vUv - 0.5);',
    '  vec4 s = texture2D(uTex, vUv);',
    '  float d = s.r;',
    '  float a = smoothstep(uThreshold - 0.012, uThreshold + 0.012, d);',
    '  if (a <= 0.0) { gl_FragColor = vec4(background(px) * vignette, 1.0); return; }',
    '',
    '  vec2 o = uTexel * 3.0;',
    '  vec2 grad = vec2(',
    '    texture2D(uTex, vUv + vec2(o.x, 0.0)).r - texture2D(uTex, vUv - vec2(o.x, 0.0)).r,',
    '    texture2D(uTex, vUv + vec2(0.0, o.y)).r - texture2D(uTex, vUv - vec2(0.0, o.y)).r);',
    // Distance from the surface: how much of a ring around this pixel is also water.
    '  float ring = 0.0;',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 0.55 * vec2( 1.0,  0.0)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 0.55 * vec2(-1.0,  0.0)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 0.55 * vec2( 0.0,  1.0)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 0.55 * vec2( 0.0, -1.0)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 1.2 * vec2( 0.7,  0.7)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 1.2 * vec2(-0.7,  0.7)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 1.2 * vec2( 0.7, -0.7)).r);',
    '  ring += smoothstep(0.0, uThreshold + 0.25, texture2D(uTex, vUv + uDepthR * 1.2 * vec2(-0.7, -0.7)).r);',
    '  float band = 1.0 - smoothstep(uThreshold - 0.05, uThreshold + 0.35, d);',
    '  band *= band;',
    '  grad *= band;', // interior gradients are just 8-bit noise from individual particles
    '  float edgeThin = smoothstep(uThreshold, uThreshold + 0.18, d);',
    '  float depth = edgeThin * (0.3 + 0.7 * smoothstep(3.0, 7.8, ring));',
    '',
    // Refraction: bend the tiles behind the water along the surface slope.
    '  vec3 behind = background(px - grad * 6.0);',
    '  vec3 absorb = exp(-vec3(2.6, 0.9, 0.45) * (0.25 + 1.6 * depth));',
    '  vec3 scatter = mix(vec3(0.10, 0.52, 0.86), vec3(0.015, 0.14, 0.40), depth);',
    '  vec3 col = scatter + behind * absorb * 2.4;',
    '',
    // Lighting from a slightly tilted height field.
    '  vec3 n = normalize(vec3(-grad * 9.0, 1.0));',
    '  vec3 L = normalize(vec3(uLight, 0.75));',
    '  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 10.0);',
    '  float fresnel = pow(1.0 - n.z, 2.0);',
    '  col += fresnel * vec3(0.25, 0.45, 0.6);',
    '  col += spec * vec3(0.75, 0.9, 1.0) * 0.32;',
    // Lit meniscus on the side of the surface facing the light.
    '  float facing = clamp(dot(normalize(-grad + 1e-5), normalize(uLight + 1e-5)), 0.0, 1.0);',
    '  float lip = 1.0 - smoothstep(uThreshold, uThreshold + 0.05, d);',
    '  col += lip * lip * (0.1 + 0.5 * facing) * vec3(0.6, 0.85, 1.0);',
    '',
    '  float foam = clamp(s.g / max(d, 0.001), 0.0, 1.0);',
    '  col = mix(col, vec3(0.86, 0.95, 1.0), foam * 0.3);',
    '',
    '  gl_FragColor = vec4(mix(background(px), col, a) * vignette, 1.0);',
    '}'
  ].join('\n');

  function foamOf(vx, vy) {
    var v = Math.sqrt(vx * vx + vy * vy) / gravityScale * 4; // ~1 at "fast" speeds
    v = (v - 1.0) / 1.2;
    return v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
  }

  function WebGLRenderer(cv) {
    var gl = cv.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false
    }) || cv.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.lost = false;
    var self = this;
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); self.lost = true; });
    cv.addEventListener('webglcontextrestored', function () {
      self.lost = false;
      self.init();
    });
    this.init();
  }

  WebGLRenderer.prototype.compile = function (vsSrc, fsSrc) {
    var gl = this.gl;
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getShaderInfoLog(s));
      }
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    var info = { program: p, attr: {}, uni: {} };
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) || 0;
    for (var i = 0; i < na; i++) {
      var a = gl.getActiveAttrib(p, i);
      info.attr[a.name] = gl.getAttribLocation(p, a.name);
    }
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (i = 0; i < nu; i++) {
      var u = gl.getActiveUniform(p, i);
      info.uni[u.name] = gl.getUniformLocation(p, u.name);
    }
    return info;
  };

  WebGLRenderer.prototype.init = function () {
    var gl = this.gl;
    this.splat = this.compile(SPLAT_VS, SPLAT_FS);
    this.comp = this.compile(COMPOSITE_VS, COMPOSITE_FS);

    this.capacity = 0;
    this.cornerBuf = gl.createBuffer();
    this.dataBuf = gl.createBuffer();
    this.indexBuf = gl.createBuffer();
    this.ensureCapacity(fluid.n);

    this.triBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.tex = gl.createTexture();
    this.fbo = gl.createFramebuffer();
    this.fbW = this.fbH = 0;
    this.resize();
  };

  WebGLRenderer.prototype.ensureCapacity = function (n) {
    if (n <= this.capacity) return;
    var gl = this.gl;
    this.capacity = n;
    var corners = new Float32Array(n * 8), idx = new Uint16Array(n * 6);
    for (var i = 0; i < n; i++) {
      corners.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      var v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.data = new Float32Array(n * 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  };

  WebGLRenderer.prototype.resize = function () {
    if (this.lost) return;
    var gl = this.gl;
    // The density field is smooth, so a reduced-resolution buffer is plenty.
    var scale = Math.min(1, 560 / Math.max(cssW, cssH));
    var w = Math.max(1, Math.round(cssW * scale)), h = Math.max(1, Math.round(cssH * scale));
    if (w === this.fbW && h === this.fbH) return;
    this.fbW = w; this.fbH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error('Framebuffer incomplete: ' + status);
    }
  };

  WebGLRenderer.prototype.draw = function () {
    if (this.lost) return;
    var gl = this.gl, n = fluid.n, d = this.data;
    var x = fluid.x, y = fluid.y, vx = fluid.vx, vy = fluid.vy;
    for (var i = 0, o = 0; i < n; i++) {
      var f = foamOf(vx[i], vy[i]);
      for (var k = 0; k < 4; k++) { d[o++] = x[i]; d[o++] = y[i]; d[o++] = f; }
    }

    // Pass 1: accumulate the metaball field.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    var sp = this.splat;
    gl.useProgram(sp.program);
    gl.uniform2f(sp.uni.uDomain, fluid.w, fluid.h);
    gl.uniform1f(sp.uni.uRadius, SPLAT_RADIUS);
    gl.uniform1f(sp.uni.uAmp, SPLAT_AMP);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(sp.attr.aCorner);
    gl.vertexAttribPointer(sp.attr.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dataBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 12));
    gl.enableVertexAttribArray(sp.attr.aCenter);
    gl.vertexAttribPointer(sp.attr.aCenter, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(sp.attr.aFoam);
    gl.vertexAttribPointer(sp.attr.aFoam, 1, gl.FLOAT, false, 12, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(sp.attr.aCorner);
    gl.disableVertexAttribArray(sp.attr.aCenter);
    gl.disableVertexAttribArray(sp.attr.aFoam);
    gl.disable(gl.BLEND);

    // Pass 2: threshold + shade to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    var cp = this.comp;
    gl.useProgram(cp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(cp.uni.uTex, 0);
    gl.uniform2f(cp.uni.uTexel, 1 / this.fbW, 1 / this.fbH);
    // Probe ~1.6 interaction radii into the water to judge depth.
    gl.uniform2f(cp.uni.uDepthR, 1.6 * hPx / cssW, 1.6 * hPx / cssH);
    gl.uniform1f(cp.uni.uPxScale, 1 / (dpr * TILE_PX));
    gl.uniform1f(cp.uni.uThreshold, THRESHOLD);
    // Light comes from "above" in the real world, i.e. against gravity.
    gl.uniform2f(cp.uni.uLight, -grav.x * 0.6, grav.y * 0.6);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.enableVertexAttribArray(cp.attr.aPos);
    gl.vertexAttribPointer(cp.attr.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(cp.attr.aPos);
  };

  function Canvas2DRenderer(cv) {
    this.ctx = cv.getContext('2d');
    if (!this.ctx) throw new Error('2D canvas unavailable');
  }
  Canvas2DRenderer.prototype.resize = function () {};
  Canvas2DRenderer.prototype.draw = function () {
    var ctx = this.ctx, s = dpr * hPx, r = 0.36 * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e16';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var x = fluid.x, y = fluid.y, vx = fluid.vx, vy = fluid.vy;
    for (var pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass ? '#cfeaff' : '#1f7fe0';
      ctx.beginPath();
      for (var i = 0; i < fluid.n; i++) {
        if ((foamOf(vx[i], vy[i]) > 0.5) !== (pass === 1)) continue;
        ctx.moveTo(x[i] * s + r, y[i] * s);
        ctx.arc(x[i] * s, y[i] * s, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  };

  function createRenderer() {
    try {
      return new WebGLRenderer(canvas);
    } catch (err) {
      if (window.console) console.warn('Falling back to 2D canvas:', err);
      // A canvas that already has a WebGL context can't give a 2D one; swap in a fresh element.
      var fresh = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(fresh, canvas);
      canvas = fresh;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      return new Canvas2DRenderer(canvas);
    }
  }

  // ---------------------------------------------------------------- UI

  var noteTimer = 0;
  function showNote(text, ms) {
    noteEl.textContent = text;
    noteEl.classList.remove('faded');
    clearTimeout(noteTimer);
    if (ms) noteTimer = setTimeout(hideNote, ms);
  }
  function hideNote() {
    clearTimeout(noteTimer);
    noteEl.classList.add('faded');
  }

  function resetWater() {
    fluid.reset();
  }
  resetBtn.addEventListener('click', resetWater);

  var wakeLock = null, started = false;
  function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }).catch(function () { /* optional */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (started && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) {
      requestWakeLock();
    }
  });

  function listenForSensor() {
    window.addEventListener('deviceorientation', onOrientation);
    setTimeout(function () {
      if (!sensor.seen && window.isSecureContext) {
        showNote('No tilt sensor detected. Use the arrow keys to tilt, and drag to stir.', 7000);
      }
    }, 1500);
  }

  startBtn.addEventListener('click', function () {
    startEl.classList.add('hidden');
    hud.classList.remove('hidden');
    started = true;

    if (!window.isSecureContext) {
      showNote('Tilt sensors only work over HTTPS. Open this page from an https:// address.', 9000);
    }

    var DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      // iOS 13+: must be requested directly inside the tap handler.
      DOE.requestPermission().then(function (state) {
        if (state === 'granted') listenForSensor();
        else showNote('Motion access was denied. Close and reopen the page (or check Safari settings) to allow it.', 9000);
      }).catch(function () {
        showNote('Could not get motion access. Make sure the page is served over HTTPS.', 9000);
      });
    } else {
      listenForSensor();
      // On Android, go fullscreen and lock portrait so the screen doesn't spin while tilting.
      var el = document.documentElement;
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (coarse && el.requestFullscreen) {
        try {
          var p = el.requestFullscreen({ navigationUI: 'hide' });
          if (p && p.then) {
            p.then(function () {
              if (screen.orientation && screen.orientation.lock) {
                return screen.orientation.lock('portrait');
              }
            }).catch(function () { /* optional */ });
          }
        } catch (err) { /* optional */ }
      }
    }
    requestWakeLock();
  });

  // ---------------------------------------------------------------- main loop

  createFluid();
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  var renderer = createRenderer();
  bindPointer(canvas);

  var last = 0, acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = last ? (now - last) / 1000 : 0;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1; // returning from a background tab

    try {
      syncSize();
    } catch (err) {
      if (window.console) console.error(err);
    }

    updateTarget();
    var k = 1 - Math.exp(-dt / GRAVITY_TAU);
    grav.x += (target.x - grav.x) * k;
    grav.y += (target.y - grav.y) * k;
    fluid.gx = grav.x * gravityScale;
    fluid.gy = grav.y * gravityScale;
    applyPointer(performance.now());

    acc += dt;
    var steps = 0;
    while (acc >= Fluid.DT && steps < MAX_STEPS) {
      fluid.step();
      acc -= Fluid.DT;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0; // device can't keep up: run in slow motion rather than spiral

    renderer.draw();
  }
  requestAnimationFrame(frame);

  // Exposed for debugging / automated tests.
  window.tiltWater = { get fluid() { return fluid; }, grav: grav, target: target, sensor: sensor };
})();
