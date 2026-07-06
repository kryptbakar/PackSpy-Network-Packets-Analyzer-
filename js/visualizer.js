/*
 * visualizer.js  —  SIDE-VIEW traffic engine
 * -------------------------------------------
 * You're standing on a building at dusk, looking across a stack of neon-lit
 * elevated highways. Each highway is a protocol; each car is a packet driving
 * past in side profile. Pure Canvas 2D, no dependencies.
 *
 * Metaphor mapping:
 *   deck (road) = protocol           colour = protocol
 *   direction   = travel direction   car length = packet byte length
 *   red hazard  = flagged packet
 * Click a car to dissect the underlying packet.
 *
 * Animation: spinning wheels, suspension bob, scrolling road ticks, parallax
 * city skyline, twinkling stars, headlight/taillight glow, entry pop.
 *
 * Performance: each car *body* variant is pre-rendered once to an offscreen
 * sprite (cached) and blitted; only the wheels + effects are drawn live. Left-
 * bound cars reuse the right-bound sprite via a horizontal flip. Comfortably
 * holds 60fps with a couple hundred cars.
 */

import { LANES, LANE_BY_ID } from './protocols.js';

const BASE_SPEED = 118;   // px/s — a bit brisk for drama; spacing math depends on it
const BODY_TYPES = ['sedan', 'hatch', 'coupe', 'van'];

// ---- colour helpers --------------------------------------------------------
function hexToRgb(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function shade(rgb, amt) {
  let [r, g, b] = rgb;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { const k = 1 + amt; r *= k; g *= k; b *= k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
function buildPalette(hex, hazard) {
  const rgb = hexToRgb(hex);
  return {
    hex,
    top: shade(rgb, 0.28), mid: shade(rgb, 0.02), bot: shade(rgb, -0.30),
    trim: shade(rgb, -0.5),
    rim: '#dfe4ee', rimDark: '#7f8aa0', tire: '#0a0c12',
    head: '#fff3bf', tail: '#ff5252',
    glassA: 'rgba(226,238,255,0.95)', glassB: 'rgba(120,150,190,0.85)',
    spec: 'rgba(255,255,255,0.55)',
    hazard, // red glow for alerts
  };
}
const PALETTES = {};
for (const lane of LANES) PALETTES[lane.id] = buildPalette(lane.color);
PALETTES.SUS = buildPalette('#ff4d5e', '#ff2a3d');

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- side-profile car sprite ----------------------------------------------
// Drawn facing RIGHT, centred at (0,0). Returns the canvas plus wheel geometry.
function buildCarSprite(pal, W, H, type, dpr) {
  const padX = 10, padY = 8;
  const sw = W + padX * 2, sh = H * 1.7 + padY * 2;
  const cv = document.createElement('canvas');
  cv.width = Math.round(sw * dpr);
  cv.height = Math.round(sh * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(sw / 2, sh / 2);

  const hw = W / 2;
  const beltTop = -H * 0.26;   // top of lower body
  const bodyBot = H * 0.34;    // bottom of body (above wheels)
  const roofY = -H * 0.60;     // roof line
  const wheelR = H * 0.30;
  const axleY = H * 0.34;
  const frontX = W * 0.31, rearX = -W * 0.31;

  // Cabin silhouette by body type (fractions of W). base = at beltTop, top = at roofY.
  const cab = {
    sedan: { rb: -0.24, rf: 0.28, tb: -0.12, tf: 0.14 },
    hatch: { rb: -0.30, rf: 0.24, tb: -0.26, tf: 0.10 },
    coupe: { rb: -0.16, rf: 0.30, tb: -0.02, tf: 0.12 },
    van:   { rb: -0.32, rf: 0.30, tb: -0.30, tf: 0.24 },
  }[type];

  // --- wheel arches (dark recesses; wheels drawn live on top) ---
  ctx.fillStyle = '#05060a';
  for (const wx of [frontX, rearX]) {
    ctx.beginPath();
    ctx.arc(wx, axleY, wheelR * 1.06, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- lower body with vertical gradient ---
  const bg = ctx.createLinearGradient(0, beltTop, 0, bodyBot);
  bg.addColorStop(0, pal.top);
  bg.addColorStop(0.45, pal.mid);
  bg.addColorStop(1, pal.bot);
  ctx.fillStyle = bg;
  rr(ctx, -hw, beltTop, W, bodyBot - beltTop, H * 0.20);
  ctx.fill();

  // --- cabin / greenhouse ---
  ctx.fillStyle = pal.top;
  ctx.beginPath();
  ctx.moveTo(W * cab.rb, beltTop + 2);
  ctx.quadraticCurveTo(W * cab.rb, roofY, W * cab.tb, roofY);
  ctx.lineTo(W * cab.tf, roofY);
  ctx.quadraticCurveTo(W * cab.rf, roofY, W * cab.rf, beltTop + 2);
  ctx.closePath();
  ctx.fill();

  // --- windows (glass) split by a B-pillar ---
  const glassTop = roofY + H * 0.10;
  const glassBot = beltTop - H * 0.02;
  const gL = W * (cab.tb + 0.03), gR = W * (cab.rf - 0.04);
  const gg = ctx.createLinearGradient(0, glassTop, 0, glassBot);
  gg.addColorStop(0, pal.glassA);
  gg.addColorStop(1, pal.glassB);
  ctx.fillStyle = gg;
  const pillar = (gR - gL) * 0.52 + gL; // B-pillar x
  // rear window
  ctx.beginPath();
  ctx.moveTo(gL + 3, glassBot);
  ctx.lineTo(W * (cab.tb + 0.05), glassTop);
  ctx.lineTo(pillar - 2, glassTop);
  ctx.lineTo(pillar - 2, glassBot);
  ctx.closePath(); ctx.fill();
  // windshield
  ctx.beginPath();
  ctx.moveTo(pillar + 2, glassBot);
  ctx.lineTo(pillar + 2, glassTop);
  ctx.lineTo(W * (cab.tf - 0.02), glassTop);
  ctx.lineTo(gR, glassBot);
  ctx.closePath(); ctx.fill();
  // glass sheen
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(gL + 4, glassBot); ctx.lineTo(W * (cab.tb + 0.06), glassTop);
  ctx.lineTo(W * (cab.tb + 0.14), glassTop); ctx.lineTo(gL + 12, glassBot);
  ctx.closePath(); ctx.fill();

  // --- specular highlight streak along the shoulder ---
  ctx.strokeStyle = pal.spec;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-hw + H * 0.18, beltTop + H * 0.05);
  ctx.lineTo(hw - H * 0.18, beltTop + H * 0.05);
  ctx.stroke();

  // --- rocker shadow ---
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rr(ctx, -hw + 3, bodyBot - H * 0.10, W - 6, H * 0.10, 3);
  ctx.fill();

  // --- lights with glow ---
  // headlight (front)
  const hlx = hw - H * 0.10, hly = beltTop + H * 0.16;
  let glow = ctx.createRadialGradient(hlx, hly, 0, hlx, hly, H * 0.42);
  glow.addColorStop(0, 'rgba(255,243,191,0.6)');
  glow.addColorStop(1, 'rgba(255,243,191,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(hlx - H * 0.42, hly - H * 0.42, H * 0.84, H * 0.84);
  ctx.fillStyle = pal.head;
  rr(ctx, hlx - H * 0.12, hly - H * 0.09, H * 0.16, H * 0.18, 2); ctx.fill();
  // taillight (rear)
  const tlx = -hw + H * 0.10, tly = beltTop + H * 0.16;
  glow = ctx.createRadialGradient(tlx, tly, 0, tlx, tly, H * 0.42);
  glow.addColorStop(0, 'rgba(255,60,60,0.8)');
  glow.addColorStop(1, 'rgba(255,60,60,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(tlx - H * 0.42, tly - H * 0.42, H * 0.84, H * 0.84);
  ctx.fillStyle = pal.tail;
  rr(ctx, tlx - H * 0.05, tly - H * 0.08, H * 0.12, H * 0.16, 2); ctx.fill();

  // --- hazard outline for suspicious cars ---
  if (pal.hazard) {
    ctx.strokeStyle = pal.hazard;
    ctx.lineWidth = 1.5;
    rr(ctx, -hw, beltTop, W, bodyBot - beltTop, H * 0.20);
    ctx.stroke();
  }

  return {
    canvas: cv, sw, sh,
    frontX, rearX, axleY, wheelR,
    contactOffsetY: axleY + wheelR,   // centre -> ground contact
    topOffsetY: -roofY + H * 0.06,    // centre -> top (for hit testing)
  };
}

function drawWheel(ctx, cx, cy, r, rot, pal) {
  ctx.save();
  ctx.translate(cx, cy);
  // tire
  ctx.fillStyle = pal.tire;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  // rim
  ctx.fillStyle = pal.rim;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.56, 0, Math.PI * 2); ctx.fill();
  // spokes (spin)
  ctx.rotate(rot);
  ctx.strokeStyle = pal.rimDark;
  ctx.lineWidth = Math.max(1, r * 0.14);
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(i * 1.2566) * r * 0.5, Math.sin(i * 1.2566) * r * 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = pal.rimDark;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export class Visualizer {
  constructor(canvas, { onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cars = [];
    this.onSelect = onSelect;
    this.selectedId = null;
    this.hoverId = null;
    this.paused = false;
    this.filter = null;
    this.dpr = window.devicePixelRatio || 1;
    this.spriteCache = new Map();
    this.tails = {};
    this.scroll = 0;      // road-tick scroll
    this.parallax = 0;    // skyline drift
    this.stars = [];
    this.buildings = [];

    this._resize();
    window.addEventListener('resize', () => this._resize());
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseleave', () => { this.hoverId = null; });
    canvas.addEventListener('click', (e) => this._onClick(e));

    this._last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _resize() {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.spriteCache.clear();
    this._layout();
    this._buildBackdrop();
  }

  _layout() {
    this.skyH = Math.max(70, this.h * 0.20);
    const area = this.h - this.skyH;
    const n = LANES.length;
    const dh = area / n;
    this.deckH = dh;
    this.carH = Math.min(46, Math.max(22, dh * 0.44));
    this.laneGeom = {};
    LANES.forEach((lane, i) => {
      const top = this.skyH + i * dh;
      this.laneGeom[lane.id] = {
        top, bottom: top + dh,
        nearY: top + dh * 0.82,   // outbound lane (front, larger)
        farY: top + dh * 0.52,    // inbound lane (back, smaller/dimmer)
        midY: top + dh * 0.66,    // centre divider
      };
    });
  }

  // Pre-generate stars + skyline once (positions), redrawn cheaply each frame.
  _buildBackdrop() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push({ x: Math.random() * this.w, y: Math.random() * this.skyH * 0.9, r: Math.random() * 1.2 + 0.3, ph: Math.random() * 6.28 });
    }
    this.buildings = [];
    let x = -40;
    const base = this.skyH;
    while (x < this.w + 60) {
      const bw = 24 + Math.random() * 46;
      const bh = base * (0.35 + Math.random() * 0.6);
      this.buildings.push({ x, w: bw, h: bh, lit: Math.random() });
      x += bw + 6 + Math.random() * 10;
    }
  }

  setFilter(id) { this.filter = id; }
  setPaused(p) { this.paused = p; }
  clear() { this.cars = []; this.selectedId = null; this.tails = {}; }

  _spawnCenter(key, w, dir) {
    const gap = 26, half = w / 2, now = performance.now();
    const buffer = 180;
    const rec = this.tails[key];
    if (dir === 1) {
      let prevTrail = Infinity;
      if (rec) prevTrail = rec.edge + BASE_SPEED * (now - rec.t) / 1000;
      const rightEdge = Math.min(-10, prevTrail - gap);
      if (rightEdge < -buffer) return null;
      const center = rightEdge - half;
      this.tails[key] = { edge: center - half, t: now };
      return center;
    } else {
      let prevTrail = -Infinity;
      if (rec) prevTrail = rec.edge - BASE_SPEED * (now - rec.t) / 1000;
      const leftEdge = Math.max(this.w + 10, prevTrail + gap);
      if (leftEdge > this.w + buffer) return null;
      const center = leftEdge + half;
      this.tails[key] = { edge: center + half, t: now };
      return center;
    }
  }

  _sprite(paletteKey, w, type) {
    const key = `${paletteKey}:${w}:${type}`;
    let s = this.spriteCache.get(key);
    if (s) return s;
    s = buildCarSprite(PALETTES[paletteKey], w, this.carH, type, this.dpr);
    this.spriteCache.set(key, s);
    return s;
  }

  addPacket(pkt) {
    const geom = this.laneGeom[pkt.protocol];
    if (!geom) return;
    const H = this.carH;
    const rawW = H * 1.9 + pkt.length / 22;
    const w = Math.max(Math.round(H * 1.8), Math.min(Math.round(H * 3.4), Math.round(rawW / 4) * 4));
    const out = pkt.direction === 'out';
    const dir = out ? 1 : -1;
    const x = this._spawnCenter(`${pkt.protocol}:${dir}`, w, dir);
    if (x === null) return;
    const type = BODY_TYPES[(pkt.id + pkt.srcPort) % BODY_TYPES.length];
    const s = this._sprite(pkt.suspicious ? 'SUS' : pkt.protocol, w, type);
    const near = out;                         // outbound = near lane, inbound = far lane
    const depth = near ? 1 : 0.78;
    const roadY = near ? geom.nearY : geom.farY;
    this.cars.push({
      pkt, w, dir, x, type, depth, near,
      roadY,
      y: roadY - s.contactOffsetY * depth,
      speed: BASE_SPEED, rot: Math.random() * 6.28,
      bobPh: Math.random() * 6.28,
      alpha: 0, scale: 0.8,
      paletteKey: pkt.suspicious ? 'SUS' : pkt.protocol,
    });
    if (this.cars.length > 600) this.cars.splice(0, this.cars.length - 600);
  }

  _onMove(e) { const p = this._pos(e); const hit = this._hitTest(p.x, p.y); this.hoverId = hit ? hit.pkt.id : null; this.canvas.style.cursor = hit ? 'pointer' : 'default'; }
  _onClick(e) { const p = this._pos(e); const hit = this._hitTest(p.x, p.y); if (hit) { this.selectedId = hit.pkt.id; if (this.onSelect) this.onSelect(hit.pkt); } }
  _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _hitTest(x, y) {
    // Near-lane cars first (drawn on top), then far lane.
    for (const nearPass of [true, false]) {
      for (let i = this.cars.length - 1; i >= 0; i--) {
        const c = this.cars[i];
        if (c.near !== nearPass) continue;
        const s = this._sprite(c.paletteKey, c.w, c.type);
        const d = c.depth, halfW = c.w / 2 * d + 3;
        if (x >= c.x - halfW && x <= c.x + halfW &&
            y >= c.y - s.topOffsetY * d - 2 && y <= c.roadY + 3) return c;
      }
    }
    return null;
  }

  _frame(t) {
    const dt = Math.min(0.05, (t - this._last) / 1000);
    this._last = t;
    if (!this.paused) {
      this.scroll = (this.scroll + dt * BASE_SPEED) % 44;
      this.parallax = (this.parallax + dt * 6) % this.w;
      for (const c of this.cars) {
        c.x += c.dir * c.speed * dt;
        c.rot += (c.speed * dt) / (this.carH * 0.30);
        c.alpha = Math.min(1, c.alpha + dt * 5);
        c.scale = Math.min(1, c.scale + dt * 2);
      }
      this.cars = this.cars.filter((c) => c.x > -140 && c.x < this.w + 140);
    }
    this._draw(t);
    requestAnimationFrame((tt) => this._frame(tt));
  }

  _draw(t) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this._drawSky(t);
    this._drawDecks();
    this._drawCars();
    this._drawLabels();
  }

  _drawSky(t) {
    const ctx = this.ctx;
    // dusk gradient
    const sky = ctx.createLinearGradient(0, 0, 0, this.skyH + this.deckH);
    sky.addColorStop(0, '#0a0e1c');
    sky.addColorStop(0.55, '#1b2140');
    sky.addColorStop(0.8, '#3a2c52');
    sky.addColorStop(1, '#7a3f52');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, this.skyH + 4);
    // sun glow
    const sun = ctx.createRadialGradient(this.w * 0.8, this.skyH, 0, this.w * 0.8, this.skyH, this.skyH * 1.6);
    sun.addColorStop(0, 'rgba(255,150,90,0.35)');
    sun.addColorStop(1, 'rgba(255,150,90,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, this.w, this.skyH + 20);
    // twinkling stars
    for (const s of this.stars) {
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(t / 900 + s.ph));
      ctx.fillStyle = '#dfe8ff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.28); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // parallax skyline (two passes so it wraps)
    for (const off of [-this.parallax, this.w - this.parallax]) {
      for (const b of this.buildings) {
        const bx = b.x + off;
        if (bx > this.w || bx + b.w < 0) continue;
        ctx.fillStyle = 'rgba(10,12,24,0.85)';
        ctx.fillRect(bx, this.skyH - b.h, b.w, b.h);
        // lit windows
        ctx.fillStyle = 'rgba(255,210,140,0.5)';
        for (let wy = this.skyH - b.h + 6; wy < this.skyH - 4; wy += 8) {
          for (let wx = bx + 4; wx < bx + b.w - 4; wx += 8) {
            if ((wx + wy + (b.lit * 10 | 0)) % 3 === 0) ctx.fillRect(wx, wy, 3, 4);
          }
        }
      }
    }
  }

  _drawDecks() {
    const ctx = this.ctx;
    for (const lane of LANES) {
      const g = this.laneGeom[lane.id];
      const dim = this.filter && this.filter !== lane.id;
      const laneCol = LANE_BY_ID[lane.id].color;

      // deck surface
      const grd = ctx.createLinearGradient(0, g.top, 0, g.bottom);
      grd.addColorStop(0, dim ? '#0b0e17' : '#151a26');
      grd.addColorStop(0.7, dim ? '#080a11' : '#0d111b');
      grd.addColorStop(1, '#05060c');
      ctx.fillStyle = grd;
      ctx.fillRect(0, g.top, this.w, g.bottom - g.top);

      // neon top edge (protocol colour)
      ctx.save();
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.shadowColor = laneCol; ctx.shadowBlur = 12;
      ctx.strokeStyle = laneCol; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, g.top + 1); ctx.lineTo(this.w, g.top + 1); ctx.stroke();
      ctx.restore();

      // far lane edge
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, g.farY + this.carH * 0.22); ctx.lineTo(this.w, g.farY + this.carH * 0.22); ctx.stroke();
      // centre divider — dashed + scrolling (the motion cue)
      ctx.strokeStyle = dim ? 'rgba(255,255,255,0.06)' : 'rgba(255,214,120,0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([22, 22]); ctx.lineDashOffset = -this.scroll;
      ctx.beginPath(); ctx.moveTo(0, g.midY); ctx.lineTo(this.w, g.midY); ctx.stroke();
      ctx.setLineDash([]);
      // near lane edge (kerb)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, g.nearY + this.carH * 0.30); ctx.lineTo(this.w, g.nearY + this.carH * 0.30); ctx.stroke();
    }
  }

  // Drawn after the cars so labels stay legible on top of traffic.
  _drawLabels() {
    const ctx = this.ctx;
    ctx.font = '700 11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    for (const lane of LANES) {
      const g = this.laneGeom[lane.id];
      const y = g.top + 15;
      const wText = ctx.measureText(lane.id).width;
      ctx.fillStyle = 'rgba(5,7,14,0.75)';
      rr(ctx, 8, y - 10, 26 + wText, 20, 6); ctx.fill();
      ctx.fillStyle = LANE_BY_ID[lane.id].color;
      ctx.beginPath(); ctx.arc(19, y, 4, 0, 6.28); ctx.fill();
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(lane.id, 28, y);
    }
  }

  _drawCars() {
    const now = performance.now();
    // Two passes so the far (inbound) lane is drawn behind the near (outbound) lane.
    for (const c of this.cars) if (!c.near) this._drawCar(c, now);
    for (const c of this.cars) if (c.near) this._drawCar(c, now);
  }

  _drawCar(c, now) {
    const ctx = this.ctx;
    const dim = this.filter && this.filter !== c.pkt.protocol;
    const selected = c.pkt.id === this.selectedId;
    const hovered = c.pkt.id === this.hoverId;
    const s = this._sprite(c.paletteKey, c.w, c.type);
    const pal = PALETTES[c.paletteKey];
    const d = c.depth;
    const bob = Math.sin(now / 140 + c.bobPh) * 1.3 * d;
    let alpha = c.alpha * (dim ? 0.12 : 1) * (c.near ? 1 : 0.82); // far lane slightly dimmer
    if (c.pkt.suspicious) alpha *= 0.7 + 0.3 * Math.sin(now / 130);

    // contact shadow on the road
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(c.x, c.roadY + this.carH * 0.16 * d, c.w * 0.44 * d, this.carH * 0.10 * d, 0, 0, 6.28);
    ctx.fill();

    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(c.x, c.y + bob);
    ctx.scale(c.dir * c.scale * d, c.scale * d);
    ctx.drawImage(s.canvas, -s.sw / 2, -s.sh / 2, s.sw, s.sh);
    drawWheel(ctx, s.frontX, s.axleY, s.wheelR, c.rot, pal);
    drawWheel(ctx, s.rearX, s.axleY, s.wheelR, c.rot, pal);
    ctx.restore();
    ctx.globalAlpha = 1;

    if (selected || hovered) {
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = selected ? 2 : 1.25;
      const hw = (c.w / 2 + 4) * d, ht = s.topOffsetY * d, hb = s.contactOffsetY * d;
      rr(ctx, c.x - hw, c.y + bob - ht - 2, hw * 2, ht + hb + 6, 8);
      ctx.stroke();
    }
  }
}
