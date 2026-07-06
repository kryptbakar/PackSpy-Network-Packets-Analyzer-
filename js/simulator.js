/*
 * simulator.js
 * ------------
 * Generates synthetic-but-realistic packets so PackSpy can run with zero
 * backend (perfect for a static GitHub Pages demo). Each "scenario" changes the
 * protocol mix and arrival rate, and the attack scenarios inject packets that
 * the analyser will flag as suspicious — which is what turns a cute animation
 * into something that reads as a real security tool.
 *
 * The packet shape produced here is deliberately identical to what the live
 * pyshark backend emits over the WebSocket, so the rest of the app never has to
 * know whether traffic is real or simulated.
 */

import { transportFor, portName } from './protocols.js';

let seq = 1;

// Pools of plausible addresses. "local" = our host / LAN, "remote" = internet.
const LOCAL_HOSTS = ['192.168.1.24', '192.168.1.31', '10.0.0.5'];
const REMOTE_HOSTS = [
  { ip: '142.250.72.14', name: 'google.com' },
  { ip: '151.101.1.140', name: 'reddit.com' },
  { ip: '104.16.132.229', name: 'cloudflare.com' },
  { ip: '13.107.42.14', name: 'microsoft.com' },
  { ip: '31.13.72.36', name: 'facebook.com' },
  { ip: '140.82.113.4', name: 'github.com' },
  { ip: '199.232.68.133', name: 'fastly-cdn.net' },
];

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];

// Scenario definitions. `weights` is the relative chance of each lane; `pps` is
// the approximate packet-per-second budget; `attack` tags the scenario so the
// UI can surface it.
export const SCENARIOS = {
  mixed: {
    label: 'Mixed traffic',
    pps: 22,
    weights: { HTTP: 1, TLS: 6, DNS: 2, TCP: 2, UDP: 1.5, ICMP: 0.4 },
  },
  browsing: {
    label: 'Web browsing',
    pps: 30,
    weights: { HTTP: 2, TLS: 9, DNS: 3, TCP: 1, UDP: 0.5, ICMP: 0.1 },
  },
  streaming: {
    label: 'Video streaming',
    pps: 48,
    weights: { TLS: 4, UDP: 9, TCP: 1, DNS: 0.5, HTTP: 0.3, ICMP: 0.1 },
  },
  portscan: {
    label: '⚠ Port scan (attack)',
    pps: 40,
    weights: { TCP: 9, TLS: 1, DNS: 0.5, HTTP: 0.3 },
    attack: 'portscan',
  },
  synflood: {
    label: '⚠ SYN flood (attack)',
    pps: 70,
    weights: { TCP: 10, TLS: 0.5 },
    attack: 'synflood',
  },
};

function weightedLane(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [lane, w] of entries) {
    if ((r -= w) <= 0) return lane;
  }
  return entries[0][0];
}

// Length distributions differ by protocol; DNS/ICMP are small, streaming is big.
function lengthFor(lane) {
  switch (lane) {
    case 'DNS': return randInt(60, 180);
    case 'ICMP': return randInt(64, 98);
    case 'HTTP': return Math.random() < 0.5 ? randInt(120, 500) : randInt(500, 1500);
    case 'TLS': return Math.random() < 0.4 ? randInt(80, 300) : randInt(600, 1500);
    case 'UDP': return randInt(200, 1400);
    default: return randInt(54, 1200);
  }
}

/**
 * Build one packet. `attack` (optional) overrides fields to create suspicious
 * traffic so the analyser has something to flag.
 */
export function makePacket(scenario) {
  const attack = scenario.attack;
  let lane = weightedLane(scenario.weights);
  const outbound = Math.random() < 0.5;
  const local = pick(LOCAL_HOSTS);
  const remote = pick(REMOTE_HOSTS);
  const transport = transportFor(lane);

  let srcPort, dstPort, tcpFlags = 0, info = '', suspicious = false, threat = null;

  const dstServicePort = {
    HTTP: 80, TLS: 443, DNS: 53, ICMP: 0,
    TCP: pick([22, 3306, 6379, 5432, 8080]),
    UDP: pick([123, 161, 5353, 443]),
  }[lane];

  if (outbound) {
    srcPort = randInt(49152, 65535); // ephemeral
    dstPort = dstServicePort;
  } else {
    srcPort = dstServicePort;
    dstPort = randInt(49152, 65535);
  }

  // Attack overrides -------------------------------------------------------
  if (attack === 'portscan') {
    lane = 'TCP';
    dstPort = randInt(1, 1024);           // sweeping low ports
    srcPort = randInt(40000, 65535);
    tcpFlags = 0x02;                      // SYN only, no handshake completion
    suspicious = true;
    threat = `TCP SYN to port ${dstPort} — sequential port sweep`;
    info = `${srcPort} → ${dstPort} [SYN]  scan probe`;
  } else if (attack === 'synflood') {
    lane = 'TCP';
    dstPort = 80;
    srcPort = randInt(1024, 65535);
    tcpFlags = 0x02;                      // flood of half-open SYNs
    suspicious = true;
    threat = 'High-rate SYN with no ACK — half-open connection flood';
    info = `${srcPort} → 80 [SYN]  flood`;
  }

  // Normal per-protocol info strings --------------------------------------
  if (!suspicious) {
    if (lane === 'TCP' || lane === 'HTTP' || lane === 'TLS') {
      tcpFlags = pick([0x02, 0x12, 0x10, 0x10, 0x18, 0x11]); // SYN/SYN-ACK/ACK/PSH-ACK/FIN-ACK
    }
    if (lane === 'DNS') {
      info = outbound ? `Standard query A ${remote.name}` : `Response A ${remote.name}`;
    } else if (lane === 'HTTP') {
      info = outbound ? `GET / HTTP/1.1  Host: ${remote.name}` : `HTTP/1.1 200 OK`;
    } else if (lane === 'TLS') {
      info = outbound ? `Client Hello (SNI: ${remote.name})` : `Application Data`;
    } else if (lane === 'ICMP') {
      info = outbound ? 'Echo (ping) request' : 'Echo (ping) reply';
    } else {
      info = `${portName(srcPort)} → ${portName(dstPort)}`;
    }
  }

  return {
    id: seq++,
    ts: Date.now(),
    protocol: lane,
    transport,
    direction: outbound ? 'out' : 'in',
    srcIP: outbound ? local : remote.ip,
    dstIP: outbound ? remote.ip : local,
    srcHost: outbound ? 'this-host' : remote.name,
    dstHost: outbound ? remote.name : 'this-host',
    srcPort,
    dstPort,
    length: lengthFor(lane),
    ttl: randInt(52, 64),
    tcpFlags,
    info,
    suspicious,
    threat,
  };
}

/**
 * Simulator drives makePacket() on a Poisson-ish schedule so bursts look
 * natural. Call start(onPacket); it returns a handle with stop() and
 * setScenario().
 */
export class Simulator {
  constructor() {
    this.scenarioKey = 'mixed';
    this.speed = 1;
    this._timer = null;
    this._onPacket = null;
  }

  get scenario() { return SCENARIOS[this.scenarioKey]; }

  setScenario(key) { if (SCENARIOS[key]) this.scenarioKey = key; }
  setSpeed(mult) { this.speed = Math.max(0.1, mult); }

  start(onPacket) {
    this._onPacket = onPacket;
    this._tick();
  }

  _tick() {
    const pps = this.scenario.pps * this.speed;
    // Emit a small burst per tick, then schedule the next tick with jitter.
    const burst = Math.max(1, Math.round(pps / 10 * rand(0.5, 1.5)));
    for (let i = 0; i < burst; i++) this._onPacket(makePacket(this.scenario));
    const delay = 1000 / (pps / burst);
    this._timer = setTimeout(() => this._tick(), Math.max(40, delay));
  }

  stop() { clearTimeout(this._timer); this._timer = null; }
}
