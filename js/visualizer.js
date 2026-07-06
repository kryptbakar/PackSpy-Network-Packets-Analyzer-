/*
 * visualizer.js
 * -------------
 * The "cars on roads" renderer. Pure Canvas 2D — no dependencies, so it drops
 * straight onto GitHub Pages. Each packet is drawn as a little top-down car
 * (body + cream roof + glass + wheels + head/tail lights + drop shadow) in the
 * spirit of a toy-traffic illustration.
 *
 * Metaphor mapping (this is what makes it a real analyser, not decor):
 *   lane      = protocol            (one road per protocol)
 *   direction = which side of road  (outbound drives right, inbound drives left)
 *   colour    = protocol
 *   car length= packet byte length
 *   red glow  = flagged / suspicious packet
 * Clicking a car selects the underlying packet for the inspector panel.
 *
 * Performance: every car body is identical for a given (palette, length-step,
 * direction), so we pre-render each variant once to an offscreen sprite and just
 * blit it. That keeps hundreds of detailed cars comfortably at 60fps.
 */

import { LANES, LANE_BY_ID } from './protocols.js';

const CAR_H = 20;          // car body height in css px
const MIN_CAR_W = 34;
const MAX_CAR_W = 78;
const BASE_SPEED = 84;     // px per second
const PAD = 7;             // sprite padding for wheels / shadow overhang

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
function buildPalette(hex, glow) {
  const rgb = hexToRgb(hex);
  return {
    body: shade(rgb, 0),
    roof: shade(rgb, 0.55),   // pastel cream-tinted roof like the reference
    hi: 'rgba(255,255,255,0.16)',
    glass: 'rgba(22,28,48,0.92)',
    wheel: '#0a0d16',
    light: '#fff2c0',         // warm headlights
    tail: '#ff6a6a',          // red tail-lights
    glow,                     // optional baked halo (used for alerts)
  };
}

// One palette per protocol lane, plus a red "suspicious" palette with a glow.
const PALETTES = {};
for (const lane of LANES) PALETTES[lane.id] = buildPalette(lane.color);
PALETTES.SUS = buildPalette('#ff4d5e', '#ff2a3d');

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw one top-down car centred at (cx, cy). */
function drawCar(ctx, cx, cy, w, h, dir, pal) {
  const left = cx - w / 2, top = cy - h / 2;

  // Drop shadow (offset down-right).
  ctx.fillStyle = 'rgba(0,0,0,0.33)';
  roundRectPath(ctx, left + 3, top + 5, w, h, 7);
  ctx.fill();

  // Wheels — dark tabs peeking past the top & bottom edges.
  ctx.fillStyle = pal.wheel;
  const ww = Math.min(11, w * 0.16), wh = 4;
  for (const fx of [0.24, 0.76]) {
    const wx = left + w * fx - ww / 2;
    roundRectPath(ctx, wx, top - 2, ww, wh, 2); ctx.fill();
    roundRectPath(ctx, wx, top + h - 2, ww, wh, 2); ctx.fill();
  }

  // Body — with an optional baked glow for alert cars.
  if (pal.glow) { ctx.shadowColor = pal.glow; ctx.shadowBlur = 14; }
  ctx.fillStyle = pal.body;
  roundRectPath(ctx, left, top, w, h, 7);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Sun highlight along the top of the body.
  ctx.fillStyle = pal.hi;
  roundRectPath(ctx, left + 2, top + 2, w - 4, h * 0.34, 5);
  ctx.fill();

  // Roof / cabin.
  const insetX = Math.min(w * 0.28, 18);
  const rL = left + insetX, rW = w - insetX * 2, rT = top + 3, rH = h - 6;
  ctx.fillStyle = pal.roof;
  roundRectPath(ctx, rL, rT, rW, rH, 5);
  ctx.fill();

  // Windshield + rear window (glass), oriented by travel direction.
  ctx.fillStyle = pal.glass;
  const gW = Math.max(4, rW * 0.30);
  const frontX = dir === 1 ? rL + rW - gW - 2 : rL + 2;
  const rearW = gW * 0.8;
  const rearX = dir === 1 ? rL + 2 : rL + rW - rearW - 2;
  roundRectPath(ctx, frontX, rT + 2, gW, rH - 4, 3); ctx.fill();
  roundRectPath(ctx, rearX, rT + 2, rearW, rH - 4, 3); ctx.fill();

  // Head- & tail-lights.
  const fx = dir === 1 ? left + w - 2.5 : left + 2.5;
  const bx = dir === 1 ? left + 2.5 : left + w - 2.5;
  ctx.fillStyle = pal.light;
  for (const yy of [0.3, 0.7]) { ctx.beginPath(); ctx.arc(fx, top + h * yy, 2.1, 0, 7); ctx.fill(); }
  ctx.fillStyle = pal.tail;
  for (const yy of [0.3, 0.7]) { ctx.beginPath(); ctx.arc(bx, top + h * yy, 2.1, 0, 7); ctx.fill(); }
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
    this.dash = 0;
    this.filter = null;
    this.dpr = window.devicePixelRatio || 1;
    this.spriteCache = new Map(); // key -> { canvas, sw, sh }
    this.tails = {};              // lane:dir -> trailing edge of last spawned car (for spacing)

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
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._layout();
  }

  _layout() {
    const top = 8;
    const usable = this.h - top - 8;
    const laneH = usable / LANES.length;
    this.laneGeom = {};
    LANES.forEach((lane, i) => {
      const y0 = top + i * laneH;
      this.laneGeom[lane.id] = {
        y0, cy: y0 + laneH / 2, h: laneH,
        outY: y0 + laneH * 0.34, // outbound sub-lane (drives right)
        inY: y0 + laneH * 0.66,  // inbound sub-lane (drives left)
      };
    });
  }

  setFilter(protocolId) { this.filter = protocolId; }
  setPaused(p) { this.paused = p; }
  clear() { this.cars = []; this.selectedId = null; this.tails = {}; }

  // Choose a spawn centre that keeps a gap behind the previous car in the same
  // lane+direction so cars flow as spaced traffic. Returns null when the lane is
  // saturated — the packet still counts in the stats/list, we just don't draw a
  // car for it (visualisation sampling), which keeps a bounded, on-screen queue.
  _spawnCenter(key, w, dir) {
    const gap = 16, half = w / 2, now = performance.now();
    const buffer = 140; // max off-screen queue length before we start dropping
    const rec = this.tails[key];
    if (dir === 1) { // enter from left, drive right
      let prevTrail = Infinity; // no previous car -> spawn at the edge
      if (rec) prevTrail = rec.edge + BASE_SPEED * (now - rec.t) / 1000;
      const rightEdge = Math.min(-6, prevTrail - gap);
      if (rightEdge < -buffer) return null; // lane full
      const center = rightEdge - half;
      this.tails[key] = { edge: center - half, t: now };
      return center;
    } else {         // enter from right, drive left
      let prevTrail = -Infinity; // no previous car -> spawn at the edge
      if (rec) prevTrail = rec.edge - BASE_SPEED * (now - rec.t) / 1000;
      const leftEdge = Math.max(this.w + 6, prevTrail + gap);
      if (leftEdge > this.w + buffer) return null; // lane full
      const center = leftEdge + half;
      this.tails[key] = { edge: center + half, t: now };
      return center;
    }
  }

  // Build (or fetch) the offscreen sprite for a car variant.
  _sprite(paletteKey, w, dir) {
    const key = `${paletteKey}:${w}:${dir}`;
    let s = this.spriteCache.get(key);
    if (s) return s;
    const pal = PALETTES[paletteKey];
    const sw = w + PAD * 2, sh = CAR_H + PAD * 2;
    const cv = document.createElement('canvas');
    cv.width = Math.round(sw * this.dpr);
    cv.height = Math.round(sh * this.dpr);
    const c = cv.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawCar(c, sw / 2, sh / 2, w, CAR_H, dir, pal);
    s = { canvas: cv, sw, sh };
    this.spriteCache.set(key, s);
    return s;
  }

  addPacket(pkt) {
    const geom = this.laneGeom[pkt.protocol];
    if (!geom) return;
    const rawW = MIN_CAR_W + pkt.length / 26;
    const w = Math.max(MIN_CAR_W, Math.min(MAX_CAR_W, Math.round(rawW / 4) * 4)); // quantise for sprite reuse
    const out = pkt.direction === 'out';
    const dir = out ? 1 : -1;
    const x = this._spawnCenter(`${pkt.protocol}:${dir}`, w, dir);
    if (x === null) return; // lane saturated — sample this packet out of the animation
    this.cars.push({
      pkt, w, dir, x,
      y: out ? geom.outY : geom.inY,
      speed: BASE_SPEED,
      alpha: 0,
      paletteKey: pkt.suspicious ? 'SUS' : pkt.protocol,
    });
    if (this.cars.length > 850) this.cars.splice(0, this.cars.length - 850);
  }

  _onMove(e) {
    const p = this._pos(e);
    const hit = this._hitTest(p.x, p.y);
    this.hoverId = hit ? hit.pkt.id : null;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
  }
  _onClick(e) {
    const p = this._pos(e);
    const hit = this._hitTest(p.x, p.y);
    if (hit) {
      this.selectedId = hit.pkt.id;
      if (this.onSelect) this.onSelect(hit.pkt);
    }
  }
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _hitTest(x, y) {
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (x >= c.x - c.w / 2 - 3 && x <= c.x + c.w / 2 + 3 &&
          y >= c.y - CAR_H / 2 - 5 && y <= c.y + CAR_H / 2 + 5) return c;
    }
    return null;
  }

  _frame(t) {
    const dt = Math.min(0.05, (t - this._last) / 1000);
    this._last = t;
    if (!this.paused) {
      this.dash = (this.dash + dt * 60) % 24;
      for (const c of this.cars) {
        c.x += c.dir * c.speed * dt;
        c.alpha = Math.min(1, c.alpha + dt * 4);
      }
      this.cars = this.cars.filter((c) => c.x > -100 && c.x < this.w + 100);
    }
    this._draw();
    requestAnimationFrame((tt) => this._frame(tt));
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // Roads.
    for (const lane of LANES) {
      const g = this.laneGeom[lane.id];
      const dim = this.filter && this.filter !== lane.id;
      ctx.fillStyle = dim ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, g.y0 + 4, this.w, g.h - 8);
      ctx.strokeStyle = dim ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([12, 12]);
      ctx.lineDashOffset = -this.dash;
      ctx.beginPath();
      ctx.moveTo(0, g.cy);
      ctx.lineTo(this.w, g.cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Cars.
    const now = performance.now();
    for (const c of this.cars) {
      const dim = this.filter && this.filter !== c.pkt.protocol;
      const selected = c.pkt.id === this.selectedId;
      const hovered = c.pkt.id === this.hoverId;
      let alpha = c.alpha * (dim ? 0.14 : 1);
      if (c.pkt.suspicious) alpha *= 0.72 + 0.28 * Math.sin(now / 150); // gentle pulse

      const s = this._sprite(c.paletteKey, c.w, c.dir);
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.canvas, c.x - s.sw / 2, c.y - s.sh / 2, s.sw, s.sh);
      ctx.globalAlpha = 1;

      if (selected || hovered) {
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = selected ? 2 : 1.25;
        roundRectPath(ctx, c.x - c.w / 2 - 3, c.y - CAR_H / 2 - 3, c.w + 6, CAR_H + 6, 8);
        ctx.stroke();
      }
    }
  }
}
