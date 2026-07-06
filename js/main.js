/*
 * main.js
 * -------
 * Orchestrator. Owns the three data sources (simulate / replay / live), the
 * shared Visualizer + Inspector + Stats, and all the UI controls. A packet from
 * ANY source flows through the same pipe:
 *
 *     source -> onPacket(pkt) -> visualizer + inspector + stats
 *
 * so the "cars on roads" view is identical whether traffic is synthetic or a
 * real capture streamed from the Python backend.
 */

import { Visualizer } from './visualizer.js';
import { Inspector } from './inspector.js';
import { Stats } from './stats.js';
import { Simulator, SCENARIOS } from './simulator.js';
import { LANES } from './protocols.js';

const $ = (sel) => document.querySelector(sel);

// ---- Wire up the three consumers -----------------------------------------
const viz = new Visualizer($('#road'), {
  onSelect: (pkt) => inspector.select(pkt),
});
const inspector = new Inspector($('#pkt-list'), $('#pkt-detail'));
inspector.onSelect = (pkt) => {
  viz.selectedId = pkt.id;
  inspector.select(pkt);
};
const stats = new Stats({
  pps: $('#stat-pps'),
  bps: $('#stat-bps'),
  total: $('#stat-total'),
  alerts: $('#stat-alerts'),
  mix: $('#mix-bar'),
  talkers: $('#talkers'),
});

// The one function every source calls.
function onPacket(pkt) {
  viz.addPacket(pkt);
  inspector.add(pkt);
  stats.add(pkt);
}

// ---- Source: simulator ----------------------------------------------------
const sim = new Simulator();
let live = null; // WebSocket to backend when in live mode
let running = true;

function startSim() {
  stopLive();
  sim.stop();
  sim.start(onPacket);
}

// ---- Source: live backend (pyshark over WebSocket) ------------------------
function startLive(url) {
  sim.stop();
  setStatus('connecting', 'Connecting to capture backend…');
  try {
    live = new WebSocket(url);
  } catch (e) {
    setStatus('error', 'Bad WebSocket URL');
    return;
  }
  live.onopen = () => setStatus('live', 'Live capture connected');
  live.onmessage = (ev) => {
    try {
      const pkt = JSON.parse(ev.data);
      onPacket(pkt);
    } catch { /* ignore malformed frames */ }
  };
  live.onerror = () => setStatus('error', 'Backend not reachable — start capture_server.py');
  live.onclose = () => { if (mode === 'live') setStatus('error', 'Capture backend disconnected'); };
}
function stopLive() {
  if (live) { try { live.close(); } catch {} live = null; }
}

function setStatus(cls, text) {
  const el = $('#conn-status');
  el.className = 'conn ' + cls;
  el.textContent = text;
}

// ---- Mode switching -------------------------------------------------------
let mode = 'sim';
function setMode(next) {
  mode = next;
  $('#live-config').classList.toggle('hidden', next !== 'live');
  $('#scenario-wrap').classList.toggle('hidden', next === 'live');
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.classList.toggle('active', b.dataset.mode === next);
  }
  viz.clear();
  inspector.clear();
  stats.reset();
  if (next === 'sim') { setStatus('sim', 'Simulating synthetic traffic'); startSim(); }
  else if (next === 'live') { stopLive(); setStatus('idle', 'Enter backend URL and connect'); }
}

// ---- Build the protocol legend + filter chips -----------------------------
function buildLegend() {
  const el = $('#legend');
  el.innerHTML = '';
  const chips = [{ id: null, label: 'All', color: '#cbd5e1' }, ...LANES];
  for (const c of chips) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (c.id === null ? ' active' : '');
    chip.dataset.proto = c.id === null ? '' : c.id;
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.id || c.label}`;
    chip.addEventListener('click', () => {
      for (const x of el.querySelectorAll('.chip')) x.classList.remove('active');
      chip.classList.add('active');
      viz.setFilter(c.id);
    });
    el.appendChild(chip);
  }
}

// ---- Scenario dropdown ----------------------------------------------------
function buildScenarios() {
  const sel = $('#scenario');
  for (const [key, s] of Object.entries(SCENARIOS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    sim.setScenario(sel.value);
    const isAttack = !!SCENARIOS[sel.value].attack;
    $('#road-wrap').classList.toggle('alert-mode', isAttack);
  });
}

// ---- Controls -------------------------------------------------------------
function wireControls() {
  $('#btn-pause').addEventListener('click', (e) => {
    running = !running;
    viz.setPaused(!running);
    if (running) { if (mode === 'sim') sim.start(onPacket); }
    else { sim.stop(); }
    e.currentTarget.textContent = running ? '⏸ Pause' : '▶ Resume';
  });

  $('#btn-clear').addEventListener('click', () => {
    viz.clear(); inspector.clear(); stats.reset();
  });

  const speed = $('#speed');
  speed.addEventListener('input', () => {
    sim.setSpeed(parseFloat(speed.value));
    $('#speed-val').textContent = parseFloat(speed.value).toFixed(1) + '×';
  });

  for (const b of document.querySelectorAll('.mode-btn')) {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  }

  $('#btn-connect').addEventListener('click', () => {
    startLive($('#ws-url').value.trim());
  });
}

// ---- Boot -----------------------------------------------------------------
buildLegend();
buildScenarios();
wireControls();
inspector.clear();
setMode('sim');
