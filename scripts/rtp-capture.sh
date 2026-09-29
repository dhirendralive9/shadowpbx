#!/usr/bin/env bash
#
# ShadowPBX rolling RTP/SIP packet capture.
#
# Writes a ring buffer of pcap files so that when a call goes one-way you can
# still pull the raw packets for it afterwards. Disk use is bounded: it keeps
# only RTPMON_CAP_FILES files of RTPMON_CAP_SIZE_MB each, auto-deleting the
# oldest (default 12 x 100 MB = ~1.2 GB max).
#
# Captures the media range AND SIP (5060) so the INVITE/BYE for a flagged call
# is in the same buffer as its RTP. Run as a service; see
# scripts/systemd/shadowpbx-rtpcapture.service.
#
# NOTE: these pcaps contain live call audio -- treat the capture dir as
# sensitive, same as your call recordings. The ring buffer self-purges.
set -euo pipefail

IFACE="${RTPMON_IFACE:-eth0}"
PORT_MIN="${RTPMON_PORT_MIN:-10000}"
PORT_MAX="${RTPMON_PORT_MAX:-20000}"
DIR="${RTPMON_CAP_DIR:-/var/log/shadowpbx/rtpcap}"
FILES="${RTPMON_CAP_FILES:-12}"       # ring buffer depth
SIZE_MB="${RTPMON_CAP_SIZE_MB:-100}"  # size per file

mkdir -p "$DIR"
exec tcpdump -ni "$IFACE" \
  -w "$DIR/rtp-%Y%m%d-%H%M%S.pcap" \
  -W "$FILES" -C "$SIZE_MB" -Z root \
  "(udp portrange ${PORT_MIN}-${PORT_MAX}) or (udp port 5060)"
