/*
 * visualizer.js
 * -------------
 * The "cars on roads" renderer. Pure Canvas 2D — no dependencies, so it drops
 * straight onto GitHub Pages and runs at 60fps for a few hundred live cars.
 *
 * Metaphor mapping (this is the part that makes it a real analyser, not decor):
 *   lane      = protocol            (one road per protocol)
 *   direction = which side of road  (outbound drives right, inbound drives left)
 *   colour    = protocol
 *   car length= packet byte length
 *   red pulse = flagged / suspicious packet
 * Clicking a car selects the underlying packet for the inspector panel.
 */

import { LANES, LANE_BY_ID } from './protocols.js';

const CAR_HEIGHT = 12;
const MIN_CAR_W = 16;
const MAX_CAR_W = 64;
const BASE_SPEED = 90; // px per second

export class Visualizer {
  constructor(canvas, { onSelect } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cars = [];
    this.onSelect = onSelect;
    this.selectedId = null;
    this.hoverId = null;
    this.paused = false;
    this.dash = 0; // animated road dash offset
    this.filter = null; // protocol id to isolate, or null

    this._resize();
    window.addEventListener('resize', () => this._resize());
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseleave', () => { this.hoverId = null; });
    canvas.addEventListener('click', (e) => this._onClick(e));

    this._last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layout();
  }

  // Compute vertical band for every lane based on current canvas height.
  _layout() {
    const top = 8;
    const usable = this.h - top - 8;
    const laneH = usable / LANES.length;
    this.laneGeom = {};
    LANES.forEach((lane, i) => {
      const y0 = top + i * laneH;
      this.laneGeom[lane.id] = {
        y0,
        cy: y0 + laneH / 2,
        h: laneH,
        outY: y0 + laneH * 0.34, // outbound sub-lane (drives right)
        inY: y0 + laneH * 0.66,  // inbound sub-lane (drives left)
      };
    });
  }

  setFilter(protocolId) { this.filter = protocolId; }
  setPaused(p) { this.paused = p; }
  clear() { this.cars = []; this.selectedId = null; }

  addPacket(pkt) {
    const geom = this.laneGeom[pkt.protocol];
    if (!geom) return;
    const w = Math.max(MIN_CAR_W, Math.min(MAX_CAR_W, MIN_CAR_W + pkt.length / 30));
    const out = pkt.direction === 'out';
    this.cars.push({
      pkt,
      x: out ? -w : this.w + w,
      y: out ? geom.outY : geom.inY,
      w,
      dir: out ? 1 : -1,
      speed: BASE_SPEED * (0.8 + Math.random() * 0.5),
      alpha: 0,
      born: performance.now(),
    });
    // Guard against runaway memory if a burst outpaces removal.
    if (this.cars.length > 900) this.cars.splice(0, this.cars.length - 900);
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
    // Iterate front-to-back (last drawn is on top).
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (
        x >= c.x - c.w / 2 - 3 && x <= c.x + c.w / 2 + 3 &&
        y >= c.y - CAR_HEIGHT / 2 - 4 && y <= c.y + CAR_HEIGHT / 2 + 4
      ) return c;
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
      // Drop cars that have driven off screen.
      this.cars = this.cars.filter((c) => c.x > -80 && c.x < this.w + 80);
    }
    this._draw();
    requestAnimationFrame((tt) => this._frame(tt));
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // Roads
    for (const lane of LANES) {
      const g = this.laneGeom[lane.id];
      const dim = this.filter && this.filter !== lane.id;
      // Asphalt
      ctx.fillStyle = dim ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, g.y0 + 4, this.w, g.h - 8);
      // Centre dashes
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

    // Cars
    const now = performance.now();
    for (const c of this.cars) {
      const lane = LANE_BY_ID[c.pkt.protocol];
      const dim = this.filter && this.filter !== c.pkt.protocol;
      const selected = c.pkt.id === this.selectedId;
      const hovered = c.pkt.id === this.hoverId;
      let color = lane.color;
      let alpha = c.alpha * (dim ? 0.15 : 1);

      ctx.save();
      ctx.globalAlpha = alpha;

      // Suspicious packets pulse red.
      if (c.pkt.suspicious) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 120);
        color = `rgb(255, ${Math.round(70 + pulse * 40)}, ${Math.round(70 + pulse * 30)})`;
        ctx.shadowColor = 'rgba(255,70,70,0.9)';
        ctx.shadowBlur = 16;
      } else {
        ctx.shadowColor = color;
        ctx.shadowBlur = selected ? 22 : hovered ? 14 : 8;
      }

      // Car body
      this._roundRect(c.x - c.w / 2, c.y - CAR_HEIGHT / 2, c.w, CAR_HEIGHT, 4);
      ctx.fillStyle = color;
      ctx.fill();

      // Windshield hint (a lighter nose in travel direction)
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const noseW = 4;
      const nx = c.dir === 1 ? c.x + c.w / 2 - noseW - 1 : c.x - c.w / 2 + 1;
      this._roundRect(nx, c.y - CAR_HEIGHT / 2 + 2, noseW, CAR_HEIGHT - 4, 2);
      ctx.fill();

      // Selection / hover ring
      if (selected || hovered) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = selected ? 2 : 1;
        this._roundRect(c.x - c.w / 2 - 2, c.y - CAR_HEIGHT / 2 - 2, c.w + 4, CAR_HEIGHT + 4, 5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
