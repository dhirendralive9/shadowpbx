#!/usr/bin/env bash
#
# ShadowPBX one-way call extractor.
#
# Reads the most recent ONE-WAY event from the monitor log (or takes a box port
# + remote IP on the command line), carves the matching packets out of the
# rolling capture, and prints a per-source breakdown so you can see exactly what
# happened: did the trunk keep sending from a NEW source port (RTPEngine failed
# to re-latch), or did it stop sending entirely (return path / carrier)?
#
# Usage:
#   rtp-extract.sh                 # analyse the last ONE-WAY event in the log
#   rtp-extract.sh <boxport>       # analyse a specific box RTP port
#   rtp-extract.sh <boxport> <ip>  # limit to one remote IP too
set -euo pipefail

DIR="${RTPMON_CAP_DIR:-/var/log/shadowpbx/rtpcap}"
LOG="${RTPMON_LOG:-/var/log/shadowpbx/oneway-monitor.log}"
BOXIP="${RTPMON_BOX_IP:-$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'src \K[0-9.]+' || true)}"

PORT="${1:-}"
REMOTE="${2:-}"

if [ -z "$PORT" ]; then
  last="$(grep 'ONE-WAY' "$LOG" 2>/dev/null | tail -1 || true)"
  if [ -z "$last" ]; then
    echo "No ONE-WAY events in $LOG yet. Pass a box port explicitly, or wait for one to be logged."
    exit 1
  fi
  echo "Last event: $last"
  PORT="$(echo "$last" | grep -oP 'box:\K[0-9]+' | head -1)"
  REMOTE="$(echo "$last" | grep -oP '\d+\.\d+\.\d+\.\d+' | head -1)"
fi

[ -z "$PORT" ] && { echo "Could not determine box port."; exit 1; }
echo "Analysing box RTP port $PORT ${REMOTE:+(remote $REMOTE)} against $DIR ..."

filter="udp port $PORT"
[ -n "$REMOTE" ] && filter="$filter and host $REMOTE"

shopt -s nullglob
pcaps=("$DIR"/rtp-*.pcap)
if [ ${#pcaps[@]} -eq 0 ]; then
  echo "No capture files in $DIR. Is shadowpbx-rtpcapture.service running?"
  exit 1
fi

OUT="$DIR/oneway-port${PORT}-$(date +%Y%m%d-%H%M%S).pcap"

# Produce a merged extract if mergecap is available; otherwise summarise per file.
if command -v mergecap >/dev/null 2>&1; then
  tmp=(); i=0
  for f in "${pcaps[@]}"; do
    t="/tmp/.rtpx.$$.$i.pcap"; i=$((i+1))
    tcpdump -r "$f" -w "$t" "$filter" 2>/dev/null || true
    [ -s "$t" ] && tmp+=("$t")
  done
  if [ ${#tmp[@]} -gt 0 ]; then
    mergecap -w "$OUT" "${tmp[@]}" 2>/dev/null || true
    rm -f "${tmp[@]}"
    echo "Extracted -> $OUT"
  fi
else
  echo "(mergecap not installed; skipping merged pcap. 'apt-get install wireshark-common' to enable.)"
fi

echo
echo "=== inbound sources seen for box:$PORT (who was sending TO the box) ==="
echo "    packets  source(ip.port)"
inflt="dst port $PORT"
[ -n "$REMOTE" ] && inflt="$inflt and host $REMOTE"
for f in "${pcaps[@]}"; do
  tcpdump -nr "$f" "$inflt" 2>/dev/null
done | awk '/ IP /{print $3}' | sort | uniq -c | sort -rn | head -10 || true

echo
echo "Read: more than one inbound source above (esp. same IP, different port) means the caller's"
echo "media source MIGRATED and RTPEngine did not re-latch -> the RTPEngine-side fix. A single"
echo "source that simply stops means the trunk/carrier stopped sending -> trunk/return-path side."
echo
echo "Inspect the extract with:  tcpdump -nr $OUT | less     (or open in Wireshark)"
