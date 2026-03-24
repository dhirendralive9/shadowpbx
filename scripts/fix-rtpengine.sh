#!/bin/bash
#
# ShadowPBX — Fix RTPEngine Interface IP
#
# Run this after migrating to a new server, or if audio is broken
# because RTPEngine is bound to the wrong IP.
#
# Usage: sudo bash scripts/fix-rtpengine.sh [IP]
#   If no IP provided, auto-detects the server's public IP.
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR]${NC} Run as root: sudo bash $0"
  exit 1
fi

APP_DIR="/opt/shadowpbx"
REC_DIR="/var/lib/shadowpbx/recordings"
AUDIO_DIR="${APP_DIR}/audio"
VM_DIR="/var/lib/shadowpbx/voicemail"

# Get the target IP
if [ -n "$1" ]; then
  NEW_IP="$1"
else
  NEW_IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
fi

# Get current RTPEngine IP
CURRENT_IP=$(docker inspect rtpengine --format '{{json .Config.Cmd}}' 2>/dev/null | grep -o 'interface=[0-9.]*' | cut -d= -f2 || echo "unknown")

echo ""
echo -e "${BOLD}ShadowPBX — RTPEngine IP Fix${NC}"
echo ""
echo "  Current RTPEngine IP:  ${CURRENT_IP}"
echo "  New IP:                ${NEW_IP}"
echo ""

if [ "${CURRENT_IP}" = "${NEW_IP}" ]; then
  echo -e "${GREEN}[OK]${NC} RTPEngine is already using the correct IP. No changes needed."
  exit 0
fi

read -p "Recreate RTPEngine with IP ${NEW_IP}? (y/n): " -n 1 -r
echo ""
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 0

echo ""
echo -e "${CYAN}[STEP]${NC} Stopping RTPEngine..."
docker stop rtpengine 2>/dev/null || true
docker rm rtpengine 2>/dev/null || true

echo -e "${CYAN}[STEP]${NC} Starting RTPEngine with interface=${NEW_IP}..."
docker run -d \
  --name rtpengine \
  --restart unless-stopped \
  --net host \
  -v ${REC_DIR}:/recordings \
  -v ${AUDIO_DIR}:/audio:ro \
  -v ${VM_DIR}:/voicemail \
  --entrypoint /usr/local/bin/rtpengine \
  jambonz/rtpengine:latest \
    --interface="${NEW_IP}" \
    --listen-ng=127.0.0.1:22222 \
    --port-min=10000 \
    --port-max=20000 \
    --recording-dir=/recordings \
    --recording-method=pcap \
    --recording-format=eth \
    --dtmf-log-dest=127.0.0.1:22223 \
    --log-level=4 \
    --log-stderr \
    --foreground \
    --delete-delay=0

sleep 3

if docker ps | grep -q rtpengine; then
  echo -e "${GREEN}[OK]${NC} RTPEngine running with interface=${NEW_IP}"
else
  echo -e "${RED}[ERROR]${NC} RTPEngine failed to start. Check: docker logs rtpengine"
  exit 1
fi

# Also update Drachtio if it's using the old IP
DRACHTIO_IP=$(docker inspect drachtio --format '{{json .Config.Cmd}}' 2>/dev/null | grep -o 'sip:[0-9.]*' | head -1 | sed 's/sip://' || echo "unknown")
if [ "${DRACHTIO_IP}" != "${NEW_IP}" ] && [ "${DRACHTIO_IP}" != "unknown" ]; then
  echo ""
  echo -e "${CYAN}[STEP]${NC} Drachtio is also using old IP (${DRACHTIO_IP}). Updating..."

  DRACHTIO_SECRET=$(grep '^DRACHTIO_SECRET=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2-)
  if [ -z "${DRACHTIO_SECRET}" ]; then
    echo -e "${RED}[ERROR]${NC} Cannot read DRACHTIO_SECRET from .env. Update Drachtio manually."
  else
    docker stop drachtio 2>/dev/null || true
    docker rm drachtio 2>/dev/null || true

    docker run -d \
      --name drachtio \
      --restart unless-stopped \
      --net host \
      drachtio/drachtio-server:latest \
      drachtio \
        --contact "sip:${NEW_IP}:5060;transport=udp" \
        --external-ip ${NEW_IP} \
        --admin-port 9022 \
        --secret ${DRACHTIO_SECRET} \
        --loglevel info

    sleep 3
    if docker ps | grep -q drachtio; then
      echo -e "${GREEN}[OK]${NC} Drachtio updated to ${NEW_IP}"
    else
      echo -e "${RED}[ERROR]${NC} Drachtio failed. Check: docker logs drachtio"
    fi
  fi
fi

# Update .env
if [ -f "${APP_DIR}/.env" ]; then
  sed -i "s|^EXTERNAL_IP=.*|EXTERNAL_IP=${NEW_IP}|" "${APP_DIR}/.env"
  sed -i "s|^SIP_DOMAIN=.*|SIP_DOMAIN=${NEW_IP}|" "${APP_DIR}/.env"
  echo -e "${GREEN}[OK]${NC} .env updated: EXTERNAL_IP=${NEW_IP}"
fi

# Restart ShadowPBX
echo -e "${CYAN}[STEP]${NC} Restarting ShadowPBX..."
systemctl restart shadowpbx
sleep 2

if systemctl is-active --quiet shadowpbx; then
  echo -e "${GREEN}[OK]${NC} ShadowPBX restarted"
else
  echo -e "${RED}[ERROR]${NC} ShadowPBX failed. Check: journalctl -u shadowpbx -n 20"
fi

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Migration Complete${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  RTPEngine:  ${NEW_IP} (ports 10000-20000)"
echo "  Drachtio:   ${NEW_IP}:5060"
echo "  ShadowPBX:  restarted"
echo ""
echo "  Update your softphones and SIP trunks to point to: ${NEW_IP}"
echo ""
