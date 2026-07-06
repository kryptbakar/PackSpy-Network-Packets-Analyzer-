/*
 * inspector.js
 * ------------
 * The right-hand analysis pane. Two parts:
 *   1. A live packet list (like Wireshark's top pane) — the last N packets.
 *   2. A dissection tree for the selected packet (like Wireshark's middle pane),
 *      broken down Ethernet -> IP -> TCP/UDP/ICMP -> Application.
 *
 * The dissection is reconstructed from the packet's summary fields. It is not a
 * byte-accurate decode (we don't ship raw bytes in sim mode), but it mirrors the
 * layer structure a recruiter/engineer expects to see.
 */

import { decodeTcpFlags, portName } from './protocols.js';

export class Inspector {
  constructor(listEl, detailEl) {
    this.listEl = listEl;
    this.detailEl = detailEl;
    this.rows = [];
    this.max = 120;
    this.selectedId = null;
    this.onSelect = null;
    this.autoscroll = true;

    listEl.addEventListener('scroll', () => {
      // Pause autoscroll if the user scrolls up to read history.
      const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      this.autoscroll = nearBottom;
    });
  }

  add(pkt) {
    this.rows.push(pkt);
    if (this.rows.length > this.max) this.rows.shift();
    this._renderRow(pkt);
    if (this.autoscroll) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  clear() {
    this.rows = [];
    this.listEl.innerHTML = '';
    this.detailEl.innerHTML = '<div class="empty">Click a packet — in the road or the list — to dissect it.</div>';
    this.selectedId = null;
  }

  _renderRow(pkt) {
    const row = document.createElement('div');
    row.className = 'pkt-row' + (pkt.suspicious ? ' suspicious' : '');
    row.dataset.id = pkt.id;
    const t = new Date(pkt.ts);
    const time = `${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
    row.innerHTML = `
      <span class="c-no">${pkt.id}</span>
      <span class="c-time">${time}</span>
      <span class="c-proto proto-${pkt.protocol}">${pkt.protocol}</span>
      <span class="c-src">${pkt.srcIP}</span>
      <span class="c-dst">${pkt.dstIP}</span>
      <span class="c-len">${pkt.length}</span>
      <span class="c-info">${escapeHtml(pkt.info || '')}</span>`;
    row.addEventListener('click', () => {
      if (this.onSelect) this.onSelect(pkt);
    });
    this.listEl.appendChild(row);
    // Trim DOM to match the ring buffer.
    while (this.listEl.children.length > this.max) this.listEl.removeChild(this.listEl.firstChild);
  }

  select(pkt) {
    this.selectedId = pkt.id;
    for (const el of this.listEl.querySelectorAll('.pkt-row')) {
      el.classList.toggle('selected', el.dataset.id === String(pkt.id));
    }
    this._renderDetail(pkt);
  }

  _renderDetail(pkt) {
    const layers = buildLayers(pkt);
    let html = '';
    if (pkt.suspicious && pkt.threat) {
      html += `<div class="threat-banner">⚠ Security alert · ${escapeHtml(pkt.threat)}</div>`;
    }
    html += `<div class="frame-head">Frame ${pkt.id} · ${pkt.length} bytes on wire · ${pkt.direction === 'out' ? 'outbound ↑' : 'inbound ↓'}</div>`;
    for (const layer of layers) {
      html += `<details open class="layer"><summary>${escapeHtml(layer.title)}</summary><div class="fields">`;
      for (const [k, v] of layer.fields) {
        html += `<div class="field"><span class="fk">${escapeHtml(k)}</span><span class="fv">${escapeHtml(String(v))}</span></div>`;
      }
      html += `</div></details>`;
    }
    this.detailEl.innerHTML = html;
  }
}

/** Reconstruct the OSI-ish layer stack for the dissection tree. */
export function buildLayers(pkt) {
  const layers = [];

  // L2 — Ethernet (synthetic MACs derived from the last IP octet for realism).
  layers.push({
    title: 'Ethernet II',
    fields: [
      ['Source MAC', macFromIp(pkt.srcIP)],
      ['Destination MAC', macFromIp(pkt.dstIP)],
      ['Type', pkt.srcIP.includes(':') ? 'IPv6 (0x86dd)' : 'IPv4 (0x0800)'],
    ],
  });

  // L3 — IP
  layers.push({
    title: `Internet Protocol Version 4, ${pkt.srcIP} → ${pkt.dstIP}`,
    fields: [
      ['Source', `${pkt.srcIP}  (${pkt.srcHost})`],
      ['Destination', `${pkt.dstIP}  (${pkt.dstHost})`],
      ['Protocol', pkt.transport],
      ['Time to live', pkt.ttl],
      ['Total length', pkt.length],
    ],
  });

  // L4 — transport
  if (pkt.transport === 'TCP') {
    layers.push({
      title: `Transmission Control Protocol, ${pkt.srcPort} → ${pkt.dstPort}`,
      fields: [
        ['Source port', `${pkt.srcPort} (${portName(pkt.srcPort)})`],
        ['Destination port', `${pkt.dstPort} (${portName(pkt.dstPort)})`],
        ['Flags', `0x${pkt.tcpFlags.toString(16).padStart(3, '0')}  [${decodeTcpFlags(pkt.tcpFlags)}]`],
        ['Window', 64240],
      ],
    });
  } else if (pkt.transport === 'UDP') {
    layers.push({
      title: `User Datagram Protocol, ${pkt.srcPort} → ${pkt.dstPort}`,
      fields: [
        ['Source port', `${pkt.srcPort} (${portName(pkt.srcPort)})`],
        ['Destination port', `${pkt.dstPort} (${portName(pkt.dstPort)})`],
        ['Length', Math.max(8, pkt.length - 28)],
      ],
    });
  } else if (pkt.transport === 'ICMP') {
    layers.push({
      title: 'Internet Control Message Protocol',
      fields: [
        ['Type', pkt.direction === 'out' ? '8 (Echo request)' : '0 (Echo reply)'],
        ['Code', 0],
      ],
    });
  }

  // L7 — application, when we can name it.
  const app = appLayer(pkt);
  if (app) layers.push(app);

  return layers;
}

function appLayer(pkt) {
  switch (pkt.protocol) {
    case 'DNS':
      return { title: 'Domain Name System', fields: [['Query', pkt.info]] };
    case 'HTTP':
      return { title: 'Hypertext Transfer Protocol', fields: [['Message', pkt.info]] };
    case 'TLS':
      return { title: 'Transport Layer Security', fields: [['Record', pkt.info || 'Application Data']] };
    default:
      return null;
  }
}

function macFromIp(ip) {
  // Deterministic pseudo-MAC so the same host keeps the same address.
  let h = 0;
  for (const ch of ip) h = (h * 31 + ch.charCodeAt(0)) & 0xffffff;
  const b = [(h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff];
  return `02:1a:2b:${b.map((x) => x.toString(16).padStart(2, '0')).join(':')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
