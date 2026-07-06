/*
 * protocols.js
 * ------------
 * Protocol metadata for PackSpy. This is the single source of truth for how a
 * packet is coloured, which "road" (lane) it drives on, and which application
 * it is mapped to. Keeping this in one place is what lets the visualiser stay
 * dumb: it just reads packet.protocol and looks the rest up here.
 */

// Each lane is a road. Order top -> bottom on screen.
export const LANES = [
  { id: 'HTTP', label: 'HTTP  ·  :80',        color: '#4ea1ff', desc: 'Plain-text web traffic' },
  { id: 'TLS',  label: 'TLS / HTTPS  ·  :443', color: '#38d9a9', desc: 'Encrypted web traffic' },
  { id: 'DNS',  label: 'DNS  ·  :53',          color: '#ffd43b', desc: 'Name resolution' },
  { id: 'TCP',  label: 'TCP  (other)',         color: '#9775fa', desc: 'Generic TCP streams' },
  { id: 'UDP',  label: 'UDP  (other)',         color: '#ff922b', desc: 'Generic UDP datagrams' },
  { id: 'ICMP', label: 'ICMP  ·  ping',        color: '#ff6b9d', desc: 'Control / diagnostics' },
];

// Quick lookup: protocol id -> lane definition.
export const LANE_BY_ID = Object.fromEntries(LANES.map((l) => [l.id, l]));

// Well-known ports we resolve into a friendly application label in the inspector.
export const WELL_KNOWN_PORTS = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 110: 'POP3',
  123: 'NTP', 143: 'IMAP', 161: 'SNMP', 443: 'HTTPS', 445: 'SMB',
  587: 'SMTP', 993: 'IMAPS', 995: 'POP3S', 3306: 'MySQL',
  3389: 'RDP', 5432: 'PostgreSQL', 6379: 'Redis', 8080: 'HTTP-alt',
  8443: 'HTTPS-alt',
};

// TCP flag bit map, used to render the flags nicely (e.g. "SYN, ACK").
export const TCP_FLAGS = [
  { bit: 0x01, name: 'FIN' },
  { bit: 0x02, name: 'SYN' },
  { bit: 0x04, name: 'RST' },
  { bit: 0x08, name: 'PSH' },
  { bit: 0x10, name: 'ACK' },
  { bit: 0x20, name: 'URG' },
];

export function decodeTcpFlags(flags) {
  const set = TCP_FLAGS.filter((f) => (flags & f.bit) !== 0).map((f) => f.name);
  return set.length ? set.join(', ') : 'none';
}

export function portName(port) {
  return WELL_KNOWN_PORTS[port] || `${port}`;
}

// Transport layer for a given lane. HTTP/TLS/TCP ride on TCP; DNS/UDP on UDP.
export function transportFor(laneId) {
  if (laneId === 'UDP' || laneId === 'DNS') return 'UDP';
  if (laneId === 'ICMP') return 'ICMP';
  return 'TCP';
}
