# PackSpy live-capture backend

Streams **real** packets to the PackSpy frontend using
[pyshark](https://github.com/KimiNewt/pyshark) → `tshark` (Wireshark's engine).
Every packet is dissected by Wireshark's own protocol parsers, then flattened
into the same JSON shape the browser simulator produces, so the frontend renders
real and synthetic traffic identically.

## 1. Install Wireshark / tshark

`pyshark` is only a wrapper — it needs the real `tshark` binary on your `PATH`.

| OS | Command |
|----|---------|
| macOS | `brew install --cask wireshark` |
| Debian/Ubuntu | `sudo apt install tshark` |
| Windows | Install [Wireshark](https://www.wireshark.org/) **with Npcap** |

Verify: `tshark -v`

## 2. Install Python deps

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # optional
pip install -r requirements.txt
```

## 3. Run

Live capture needs raw-socket privileges. List interfaces first with `tshark -D`.

```bash
# Live capture (find your interface name with `tshark -D`)
sudo python capture_server.py --interface en0

# Filter to just web traffic
sudo python capture_server.py --interface en0 --bpf "tcp port 80 or tcp port 443"

# No privileges? Replay a capture file on a loop — perfect for a recorded demo
python capture_server.py --pcap sample.pcap --loop
```

On Linux/macOS you can avoid `sudo` by granting capture capabilities once:

```bash
sudo setcap cap_net_raw,cap_net_admin+eip $(which dumpcap)
```

## 4. Connect the frontend

Open `index.html`, click **● Live capture**, keep the URL `ws://localhost:8000/ws`,
and hit **Connect**. Cars now represent real packets off your NIC.

## Built-in threat heuristics

The backend flags packets so the red "alert" cars work on real traffic too:

- **Port scan** — >15 distinct destination ports from a single source IP.
- **SYN flood** — >60 bare SYNs/second (SYN set, ACK clear).

Flagged packets arrive with `suspicious: true` and a human-readable `threat`
string, which the frontend renders as a pulsing red car + an alert banner in the
dissection panel.
