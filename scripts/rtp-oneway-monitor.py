#!/usr/bin/env python3
"""
ShadowPBX RTP one-way audio monitor.

Passively watches the RTP that RTPEngine relays and logs when a call goes
one-way -- the box keeps SENDING audio to a remote endpoint but STOPS
RECEIVING from it (the classic "customer can hear us, we can't hear them"),
or when a leg's inbound RTP source ip:port migrates mid-call (mobile/carrier
NAT rebind), which is the usual root cause of that symptom on RTPEngine.

It never touches calls or RTPEngine. It runs tcpdump read-only and appends
findings to a logfile you can check after the fact. Pair it with the rolling
packet capture (shadowpbx-rtpcapture.service) so the raw pcap for the flagged
call is still on disk when you go looking.

Deps: python3 + tcpdump only. No pip packages.
Config is via environment (see the block below); systemd reads
/etc/default/shadowpbx-rtpmon if present.
"""
import os
import re
import sys
import time
import threading
import subprocess
import signal
from datetime import datetime

# ---- config (env-overridable) ----
IFACE       = os.environ.get("RTPMON_IFACE", "")  # empty = auto-detect the default-route NIC
PORT_MIN    = int(os.environ.get("RTPMON_PORT_MIN", "10000"))
PORT_MAX    = int(os.environ.get("RTPMON_PORT_MAX", "20000"))
BOX_IP      = os.environ.get("RTPMON_BOX_IP", "")           # auto-detected if empty
LOGFILE     = os.environ.get("RTPMON_LOG", "/var/log/shadowpbx/oneway-monitor.log")
SILENCE_SEC = float(os.environ.get("RTPMON_SILENCE_SEC", "4"))      # inbound quiet this long => suspect
OUT_ACTIVE  = float(os.environ.get("RTPMON_OUT_ACTIVE_SEC", "2"))   # still sending => call still up
MIN_PKTS    = int(os.environ.get("RTPMON_MIN_PKTS", "50"))          # leg must be established first (~1s of audio)
COOLDOWN    = float(os.environ.get("RTPMON_COOLDOWN_SEC", "30"))    # don't re-log the same leg for a while
IDLE_RESET  = float(os.environ.get("RTPMON_IDLE_RESET_SEC", "15"))  # forget a port after this idle (call ended / port reused)
SCAN_EVERY  = 1.0
REPLAY      = os.environ.get("RTPMON_SOURCE", "").lower() == "stdin"  # test mode: read tcpdump lines from stdin

LINE_RE = re.compile(
    r"^(\d+\.\d+) IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+): UDP"
)

lock = threading.Lock()
inbound = {}     # boxport -> {last, src, sources{(ip,port):last_ts}, count, primary}
outbound = {}    # boxport -> {last, dst, count}
last_event = {}  # boxport -> ts of last logged event (cooldown)
_CURRENT_TS = [0.0]  # replay clock


def detect_box_ip():
    if BOX_IP:
        return BOX_IP
    try:
        out = subprocess.check_output(["ip", "route", "get", "8.8.8.8"], text=True)
        m = re.search(r"src (\d+\.\d+\.\d+\.\d+)", out)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def detect_iface():
    # the NIC on the default route -- works on eth0 / enp1s0 / ens3 / etc.
    # 1) /proc/net/route needs no external binary
    try:
        with open("/proc/net/route") as f:
            for line in f.read().splitlines()[1:]:
                p = line.split()
                if len(p) > 1 and p[1] == "00000000":
                    return p[0]
    except Exception:
        pass
    # 2) fall back to `ip route`
    try:
        out = subprocess.check_output(["ip", "route", "get", "8.8.8.8"], text=True)
        m = re.search(r"\bdev (\S+)", out)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "eth0"


BOXIP = detect_box_ip()
if not IFACE:
    IFACE = detect_iface()


def clock():
    return _CURRENT_TS[0] if REPLAY else time.time()


def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOGFILE), exist_ok=True)
        with open(LOGFILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def scan():
    now = clock()
    with lock:
        # detect one-way / migration on legs the box is actively sending on
        for port, ob in list(outbound.items()):
            if now - ob["last"] > OUT_ACTIVE:
                continue  # box not sending -> call not up on this leg
            ib = inbound.get(port)
            # Only judge legs that actually ESTABLISHED two-way audio first. A leg the
            # box is merely sending on during call setup -- before RTPEngine has wired
            # the return path -- is NOT one-way; flagging it there was a false positive
            # at connect time. Require real inbound (primary source established).
            if not ib or ib["count"] < MIN_PKTS or ib["primary"] is None:
                continue
            if last_event.get(port, 0) and now - last_event[port] < COOLDOWN:
                continue

            remote = ob["dst"]
            if now - ib["last"] >= SILENCE_SEC:
                # inbound was established, then went silent while the box keeps sending
                silent = now - ib["last"]
                log(f"ONE-WAY  box:{port} still sending to {remote[0]}:{remote[1]} but "
                    f"INBOUND SILENT {silent:.1f}s after being established "
                    f"(was receiving from {ib['primary'][0]}:{ib['primary'][1]}).")
                last_event[port] = now
            else:
                # packets ARE arriving; has the source ip:port migrated from the primary?
                cur_src = max(ib["sources"].items(), key=lambda kv: kv[1])[0]
                if cur_src != ib["primary"]:
                    log(f"ONE-WAY(migration) box:{port} inbound source CHANGED "
                        f"{ib['primary'][0]}:{ib['primary'][1]} -> {cur_src[0]}:{cur_src[1]} "
                        f"(RTPEngine not re-latching to migrated source; caller NAT rebind). "
                        f"box still sending to {remote[0]}:{remote[1]}")
                    last_event[port] = now

        # prune ports idle beyond IDLE_RESET so reused ports start clean
        for tbl in (inbound, outbound):
            for port in list(tbl.keys()):
                if now - tbl[port]["last"] > IDLE_RESET:
                    del tbl[port]
        for port in list(last_event.keys()):
            if port not in inbound and port not in outbound:
                del last_event[port]


def handle_packet(ts, sip, sp, dip, dp):
    _CURRENT_TS[0] = ts
    with lock:
        if dip == BOXIP and PORT_MIN <= dp <= PORT_MAX:
            src = (sip, sp)
            rec = inbound.get(dp)
            if not rec:
                rec = {"last": ts, "src": src, "sources": {}, "count": 0, "primary": None}
                inbound[dp] = rec
            rec["last"] = ts
            rec["src"] = src
            rec["count"] += 1
            rec["sources"][src] = ts
            if rec["primary"] is None and rec["count"] >= MIN_PKTS:
                rec["primary"] = src
            for s, t in list(rec["sources"].items()):
                if ts - t > 60:
                    del rec["sources"][s]
        elif sip == BOXIP and PORT_MIN <= sp <= PORT_MAX:
            dst = (dip, dp)
            rec = outbound.get(sp)
            if not rec:
                rec = {"last": ts, "dst": dst, "count": 0}
                outbound[sp] = rec
            rec["last"] = ts
            rec["dst"] = dst
            rec["count"] += 1


def scanner_thread():
    while True:
        time.sleep(SCAN_EVERY)
        try:
            scan()
        except Exception as e:
            log(f"monitor-scan-error: {e}")


def main():
    if not BOXIP:
        log("ERROR: could not determine box IP; set RTPMON_BOX_IP and restart")
        return
    log(f"rtp-oneway-monitor start iface={IFACE} box={BOXIP} ports={PORT_MIN}-{PORT_MAX} "
        f"silence={SILENCE_SEC}s min_pkts={MIN_PKTS} replay={REPLAY}")

    if REPLAY:
        src = sys.stdin
        last_scan = 0.0
        for line in src:
            m = LINE_RE.match(line.strip())
            if not m:
                continue
            ts = float(m.group(1))
            handle_packet(ts, m.group(2), int(m.group(3)), m.group(4), int(m.group(5)))
            if ts - last_scan >= SCAN_EVERY:
                scan()
                last_scan = ts
        scan()
        return

    threading.Thread(target=scanner_thread, daemon=True).start()
    filt = f"udp portrange {PORT_MIN}-{PORT_MAX}"
    p = subprocess.Popen(
        ["tcpdump", "-ni", IFACE, "-l", "-tt", "-q", filt],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    for line in p.stdout:
        m = LINE_RE.match(line.strip())
        if not m:
            continue
        handle_packet(float(m.group(1)), m.group(2), int(m.group(3)), m.group(4), int(m.group(5)))
    log("tcpdump exited; monitor stopping")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    main()
