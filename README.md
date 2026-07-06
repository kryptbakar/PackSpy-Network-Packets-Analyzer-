# 🛰️ PackSpy — Real-time Network Packet Analyzer

**PackSpy visualises network traffic as cars on roads.** Each road is a
protocol, each car is a packet, and clicking a car opens a Wireshark-style
dissection of every layer. It runs entirely in the browser as a synthetic
simulation (zero setup, instant shareable link) and can also stream **real**
packets from a Python + pyshark capture backend.

> **Lane = protocol · Colour = protocol · Car length = packet bytes · Red pulse = security alert**

## ✨ Two ways to run

| Mode | What it is | Setup | Best for |
|------|-----------|-------|----------|
| **◆ Simulate** | Synthetic traffic generated in-browser, incl. attack scenarios | None — just open `index.html` | A recruiter-facing demo that works from a link in 5 seconds |
| **● Live capture** | Real packets off your NIC via pyshark → tshark (Wireshark's engine) | Run `backend/capture_server.py` | Showing genuine packet-analysis engineering in an interview |

Both modes push the **same packet shape** through the **same renderer**, so the
visualisation is identical — the frontend never knows if a car is real or fake.

## 🚀 Quick start (simulation — no backend)

It's a static site. Any static server works:

```bash
# from the repo root
python -m http.server 8080
# open http://localhost:8080
```

Or just open `index.html` directly in a browser. To publish, enable **GitHub
Pages** on this repo (Settings → Pages → deploy from branch) and share the link.

## 🔴 Live capture (real packets)

See [`backend/README.md`](backend/README.md). In short:

```bash
cd backend
pip install -r requirements.txt
sudo python capture_server.py --interface en0   # tshark -D lists interfaces
```

Then in the UI: **● Live capture → Connect** (`ws://localhost:8000/ws`).

## 🧠 What makes it read as a real analyzer

- **Protocol lanes** — HTTP, TLS/HTTPS, DNS, TCP, UDP, ICMP, each its own road.
- **Live dissection** — click any car for the Ethernet → IP → TCP/UDP → app
  layer breakdown, TCP flags decoded (`SYN, ACK`), ports resolved to services.
- **Rolling analytics** — packets/sec, throughput, protocol mix bar, top talkers.
- **Threat detection** — port-scan and SYN-flood scenarios (sim) and heuristics
  (live) flag suspicious packets as pulsing red cars with an alert banner.
- **Wireshark-grade parsing in live mode** — pyshark reuses Wireshark's own
  dissectors, so hundreds of protocols decode correctly with no reinvention.

## 🏗️ Architecture

```
                 ┌─────────────── Simulate (static, GitHub Pages) ───────────────┐
                 │  simulator.js  ──► onPacket() ──► Visualizer (canvas cars)     │
   ┌──────────┐  │                              └──► Inspector (dissection tree)  │
   │ Browser  │──┤                              └──► Stats (pps / mix / talkers)  │
   └──────────┘  │                                                                │
                 └──────────────────────────────────────────────────────────────┘
                 ┌─────────────────── Live capture (local) ─────────────────────┐
   NIC ──► tshark ──► pyshark ──► FastAPI WebSocket ──► onPacket() ──► same view  │
                 └──────────────────────────────────────────────────────────────┘
```

**Stack:** vanilla JS + Canvas 2D (frontend, dependency-free) · Python +
pyshark + FastAPI (backend). No build step, no framework — clone and open.

## 📁 Layout

```
index.html            # app shell
css/style.css         # NOC-style dark theme
js/
  protocols.js        # lanes, colours, ports, TCP flag decoding
  simulator.js        # synthetic traffic + attack scenarios
  visualizer.js       # canvas "cars on roads" renderer
  inspector.js        # packet list + layer dissection tree
  stats.js            # rolling analytics
  main.js             # orchestrator + UI controls
backend/
  capture_server.py   # pyshark → FastAPI WebSocket live capture
  requirements.txt
  README.md           # backend setup + threat heuristics
```

## 🛣️ Roadmap ideas

- Real `.pcap` upload + parse in-browser (drag a capture onto the road).
- 3D "city" view (Three.js) with IPs as buildings.
- Geo-IP colouring and a world-map overlay for top talkers.

---

Built as a portfolio piece to make packet analysis *legible at a glance*.
