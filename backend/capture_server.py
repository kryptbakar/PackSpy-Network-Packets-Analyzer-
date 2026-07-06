"""
PackSpy live-capture backend
============================

Streams REAL packets to the PackSpy frontend over a WebSocket. It uses pyshark
(a Python wrapper around Wireshark's `tshark` engine), so every packet is
dissected by Wireshark's own protocol parsers — the same dissectors that make
Wireshark valuable — and then flattened into the exact JSON shape the browser
simulator already produces. That shared shape is the whole trick: the frontend
cannot tell whether a car on the road came from `simulator.js` or from here.

    browser  <--- WebSocket (JSON packets) ---  FastAPI  <---  pyshark  <---  tshark  <---  NIC

Requirements
------------
    - Wireshark / tshark installed and on PATH   (brew install wireshark | apt install tshark)
    - pip install -r requirements.txt
    - Live capture needs raw-socket access:
          Linux/macOS : run with sudo, OR grant tshark capabilities:
                        sudo setcap cap_net_raw,cap_net_admin+eip $(which dumpcap)
          Windows     : install Npcap and run as Administrator

Run
---
    # Live capture from a real interface (find yours with `tshark -D`):
    python capture_server.py --interface en0

    # Or replay a capture file (no privileges needed — great for a recorded demo):
    python capture_server.py --pcap sample.pcap --loop

    # Then open the frontend, choose "Live capture", connect to ws://localhost:8000/ws
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import defaultdict, deque

import pyshark
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ---------------------------------------------------------------------------
# Config populated from CLI args in __main__.
# ---------------------------------------------------------------------------
CONFIG = {"interface": None, "pcap": None, "bpf": None, "loop": False, "local_prefixes": ("192.168.", "10.", "172.16.", "127.")}

app = FastAPI(title="PackSpy capture backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo convenience; tighten for anything real
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Lightweight SYN-flood / port-scan heuristics so the "alerts" counter and the
# red pulsing cars work with real traffic too, not just the simulator.
# ---------------------------------------------------------------------------
_syn_times: deque[float] = deque(maxlen=400)          # timestamps of recent bare-SYNs
_scan_ports: dict[str, set[int]] = defaultdict(set)   # src IP -> distinct dst ports hit


def _is_local(ip: str) -> bool:
    return any(ip.startswith(p) for p in CONFIG["local_prefixes"])


def _classify(pkt) -> str:
    """Map a pyshark packet to one of the frontend's lane ids."""
    layers = {l.layer_name.upper() for l in pkt.layers}
    if "ICMP" in layers or "ICMPV6" in layers:
        return "ICMP"
    if "DNS" in layers:
        return "DNS"
    if "TLS" in layers or "SSL" in layers:
        return "TLS"
    if "HTTP" in layers:
        return "HTTP"
    if "TCP" in layers:
        return "TCP"
    if "UDP" in layers:
        return "UDP"
    return "TCP"


def _tcp_flag_bits(tcp) -> int:
    bits = 0
    getb = lambda name: 1 if getattr(tcp, name, "0") in ("1", "True", True) else 0
    bits |= getb("flags_fin") << 0
    bits |= getb("flags_syn") << 1
    bits |= getb("flags_reset") << 2
    bits |= getb("flags_push") << 3
    bits |= getb("flags_ack") << 4
    bits |= getb("flags_urg") << 5
    return bits


def _to_json(pkt) -> dict | None:
    """Flatten a pyshark packet into PackSpy's wire shape. Returns None to skip."""
    try:
        proto = _classify(pkt)
        ip = getattr(pkt, "ip", None) or getattr(pkt, "ipv6", None)
        if ip is None:
            return None
        src = ip.src
        dst = ip.dst
        length = int(getattr(pkt, "length", 0) or getattr(pkt.frame_info, "len", 0) or 0)
        ttl = int(getattr(ip, "ttl", 0) or 0)

        transport = "TCP" if proto in ("TCP", "TLS", "HTTP") else ("UDP" if proto in ("UDP", "DNS") else "ICMP")
        src_port = dst_port = 0
        tcp_flags = 0
        info = ""
        suspicious = False
        threat = None

        if hasattr(pkt, "tcp"):
            src_port = int(pkt.tcp.srcport)
            dst_port = int(pkt.tcp.dstport)
            tcp_flags = _tcp_flag_bits(pkt.tcp)
            # Bare SYN (SYN set, ACK clear) feeds the flood/scan heuristics.
            if (tcp_flags & 0x02) and not (tcp_flags & 0x10):
                now = time.time()
                _syn_times.append(now)
                recent = sum(1 for t in _syn_times if now - t < 1.0)
                _scan_ports[src].add(dst_port)
                if recent > 60:
                    suspicious, threat = True, f"High-rate bare SYNs ({recent}/s) — possible SYN flood"
                elif len(_scan_ports[src]) > 15:
                    suspicious, threat = True, f"{len(_scan_ports[src])} distinct ports from {src} — possible port scan"
        elif hasattr(pkt, "udp"):
            src_port = int(pkt.udp.srcport)
            dst_port = int(pkt.udp.dstport)

        # A few friendly per-protocol info strings pulled from the dissection.
        if proto == "DNS" and hasattr(pkt, "dns"):
            qry = getattr(pkt.dns, "qry_name", "")
            info = f"DNS query {qry}" if qry else "DNS"
        elif proto == "HTTP" and hasattr(pkt, "http"):
            info = getattr(pkt.http, "request_line", None) or getattr(pkt.http, "response_line", "") or "HTTP"
        elif proto == "TLS":
            info = "TLS record"
        elif proto == "ICMP":
            info = "ICMP"
        else:
            info = f"{src_port} → {dst_port}"

        outbound = _is_local(src)
        return {
            "id": int(pkt.number),
            "ts": int(float(pkt.frame_info.time_epoch) * 1000),
            "protocol": proto,
            "transport": transport,
            "direction": "out" if outbound else "in",
            "srcIP": src,
            "dstIP": dst,
            "srcHost": "this-host" if outbound else src,
            "dstHost": dst if outbound else "this-host",
            "srcPort": src_port,
            "dstPort": dst_port,
            "length": length,
            "ttl": ttl,
            "tcpFlags": tcp_flags,
            "info": info,
            "suspicious": suspicious,
            "threat": threat,
        }
    except Exception:
        # Malformed / truncated packet — skip rather than kill the stream.
        return None


async def _packet_stream(ws: WebSocket):
    """Open a capture and forward each dissected packet to the WebSocket."""
    if CONFIG["pcap"]:
        cap = pyshark.FileCapture(CONFIG["pcap"], display_filter=CONFIG["bpf"] or None, keep_packets=False)
    else:
        cap = pyshark.LiveCapture(interface=CONFIG["interface"], bpf_filter=CONFIG["bpf"] or None)

    try:
        while True:
            for pkt in cap.sniff_continuously() if not CONFIG["pcap"] else cap:
                data = _to_json(pkt)
                if data is not None:
                    await ws.send_text(json.dumps(data))
                # Yield to the event loop so FastAPI stays responsive.
                await asyncio.sleep(0)
            if CONFIG["pcap"] and CONFIG["loop"]:
                cap.close()
                cap = pyshark.FileCapture(CONFIG["pcap"], display_filter=CONFIG["bpf"] or None, keep_packets=False)
                continue
            break
    finally:
        try:
            cap.close()
        except Exception:
            pass


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        await _packet_stream(ws)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # surface capture errors to the client, then close
        try:
            await ws.send_text(json.dumps({"error": str(exc)}))
        except Exception:
            pass


@app.get("/health")
async def health():
    return {"status": "ok", "mode": "pcap" if CONFIG["pcap"] else "live", "interface": CONFIG["interface"]}


def main():
    ap = argparse.ArgumentParser(description="PackSpy live-capture backend (pyshark + FastAPI)")
    ap.add_argument("--interface", "-i", help="Network interface to capture (e.g. en0, eth0). See `tshark -D`.")
    ap.add_argument("--pcap", help="Replay a .pcap/.pcapng file instead of live capture.")
    ap.add_argument("--bpf", help="BPF / display filter (e.g. 'tcp port 443').")
    ap.add_argument("--loop", action="store_true", help="Loop the pcap file forever (nice for demos).")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if not args.interface and not args.pcap:
        ap.error("provide --interface for live capture or --pcap to replay a file")

    CONFIG.update(interface=args.interface, pcap=args.pcap, bpf=args.bpf, loop=args.loop)
    print(f"[PackSpy] backend on ws://{args.host}:{args.port}/ws  "
          f"({'pcap ' + args.pcap if args.pcap else 'live ' + str(args.interface)})")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
