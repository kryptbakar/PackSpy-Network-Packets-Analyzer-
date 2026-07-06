/*
 * stats.js
 * --------
 * Rolling analytics for the top bar: packets/sec, throughput, protocol mix, and
 * a "top talkers" table. Everything is computed over a sliding window so the
 * numbers feel live rather than cumulative-since-load.
 */

import { LANES, LANE_BY_ID } from './protocols.js';

export class Stats {
  constructor(els) {
    this.els = els; // { pps, bps, total, alerts, mix, talkers }
    this.window = [];       // recent packets (timestamps + size) for rate calc
    this.total = 0;
    this.alerts = 0;
    this.protoCount = {};
    this.talkers = new Map(); // "ip" -> bytes
    LANES.forEach((l) => (this.protoCount[l.id] = 0));
    setInterval(() => this._render(), 250);
  }

  add(pkt) {
    this.total++;
    if (pkt.suspicious) this.alerts++;
    this.protoCount[pkt.protocol] = (this.protoCount[pkt.protocol] || 0) + 1;
    this.window.push({ ts: pkt.ts, len: pkt.length });

    const key = pkt.direction === 'out' ? pkt.dstIP : pkt.srcIP;
    this.talkers.set(key, (this.talkers.get(key) || 0) + pkt.length);
  }

  reset() {
    this.window = [];
    this.total = 0;
    this.alerts = 0;
    this.talkers.clear();
    LANES.forEach((l) => (this.protoCount[l.id] = 0));
  }

  _render() {
    const now = Date.now();
    // Trim window to last 2 seconds.
    this.window = this.window.filter((p) => now - p.ts < 2000);
    const secs = 2;
    const pps = Math.round(this.window.length / secs);
    const bytes = this.window.reduce((s, p) => s + p.len, 0);
    const bps = (bytes * 8) / secs; // bits per second over the window

    this.els.pps.textContent = pps;
    this.els.bps.textContent = fmtRate(bps);
    this.els.total.textContent = this.total.toLocaleString();
    this.els.alerts.textContent = this.alerts;
    this.els.alerts.parentElement.classList.toggle('has-alerts', this.alerts > 0);

    this._renderMix();
    this._renderTalkers();
  }

  _renderMix() {
    const total = Object.values(this.protoCount).reduce((s, v) => s + v, 0) || 1;
    let html = '';
    for (const lane of LANES) {
      const pct = (this.protoCount[lane.id] / total) * 100;
      if (pct < 0.5) continue;
      html += `<div class="mix-seg" style="width:${pct}%;background:${lane.color}" title="${lane.id} ${pct.toFixed(1)}%"></div>`;
    }
    this.els.mix.innerHTML = html;
  }

  _renderTalkers() {
    const top = [...this.talkers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let html = '';
    const max = top.length ? top[0][1] : 1;
    for (const [ip, bytes] of top) {
      const pct = (bytes / max) * 100;
      html += `<div class="talker">
        <span class="talker-ip">${ip}</span>
        <span class="talker-bar"><span style="width:${pct}%"></span></span>
        <span class="talker-val">${fmtBytes(bytes)}</span>
      </div>`;
    }
    this.els.talkers.innerHTML = html || '<div class="empty small">No traffic yet.</div>';
  }
}

function fmtRate(bps) {
  if (bps > 1e9) return (bps / 1e9).toFixed(2) + ' Gb/s';
  if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mb/s';
  if (bps > 1e3) return (bps / 1e3).toFixed(1) + ' Kb/s';
  return Math.round(bps) + ' b/s';
}

function fmtBytes(b) {
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b > 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}
