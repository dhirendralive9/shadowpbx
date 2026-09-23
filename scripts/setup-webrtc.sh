#!/bin/bash
#
# ShadowPBX — WebRTC Foundations (Web Dialer Phase 1)
#
# Verifies and hardens the pieces a browser call needs:
#
#   Browser ──wss://DOMAIN/ws──> nginx (TLS) ──ws──> Drachtio 127.0.0.1:5061
#   Browser <──DTLS-SRTP + ICE──> RTPEngine <──plain RTP──> phones / trunks
#
# What it does:
#   1. Checks Drachtio still has its WS listener (setup-tls.sh used to drop it)
#   2. Checks nginx proxies /ws to Drachtio and completes a real WSS handshake
#   3. Checks the TLS certificate on the web domain
#   4. Checks RTPEngine advertises the public IP (needed for ICE)
#   5. Opens UDP 10000-20000 (media) and TCP 443 (HTTPS/WSS) in the firewall
#   6. Adds the WebRTC keys to .env (without touching existing values)
#   7. Restarts ShadowPBX and runs the RTPEngine WebRTC self-test
#
# Usage:
#   sudo bash scripts/setup-webrtc.sh                 # check + safe fixes
#   sudo bash scripts/setup-webrtc.sh --fix-drachtio  # also re-add the WS listener
#   sudo bash scripts/setup-webrtc.sh --fix-rtpengine # also recreate RTPEngine for NAT (private!public)
#   sudo bash scripts/setup-webrtc.sh --yes           # don't prompt
#   sudo bash scripts/setup-webrtc.sh --no-restart    # don't restart ShadowPBX
#
# Nginx is the TLS terminator for WSS, so Let's Encrypt RSA *or* ECDSA
# certificates both work here. (The RSA requirement only applies if you
# terminate TLS inside Drachtio itself, as setup-tls.sh does for SIP/TLS.)
#

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
step() { echo -e "\n${CYAN}[STEP]${NC} ${BOLD}$1${NC}"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; WARNINGS=$((WARNINGS+1)); }
err()  { echo -e "${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES+1)); }
info() { echo -e "       $1"; }

APP_DIR="/opt/shadowpbx"
ENV_FILE="${APP_DIR}/.env"
TLS_DIR="/etc/shadowpbx/tls"
SPOOL_DIR="/var/spool/rtpengine"
DEFAULT_DRACHTIO_IMAGE="drachtio/drachtio-server:0.8.25"
DEFAULT_RTPENGINE_IMAGE="jambonz/rtpengine:latest"

FIX_DRACHTIO=false
FIX_RTPENGINE=false
ASSUME_YES=false
DO_RESTART=true
WARNINGS=0
FAILURES=0
CHANGED=false

for arg in "$@"; do
  case "$arg" in
    --fix-drachtio)  FIX_DRACHTIO=true ;;
    --fix-rtpengine) FIX_RTPENGINE=true ;;
    --yes|-y)        ASSUME_YES=true ;;
    --no-restart)    DO_RESTART=false ;;
    -h|--help)       sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR]${NC} Run as root: sudo bash $0"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}[ERROR]${NC} ${ENV_FILE} not found — install ShadowPBX first (scripts/install-drachtio.sh)"
  exit 1
fi

confirm() {
  $ASSUME_YES && return 0
  read -r -p "$1 (y/n): " -n 1 REPLY; echo ""
  [[ $REPLY =~ ^[Yy]$ ]]
}

env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

env_default() {
  # Add KEY=VALUE only if KEY is absent — never overwrite an existing value
  if ! grep -qE "^$1=" "$ENV_FILE"; then
    echo "$1=$2" >> "$ENV_FILE"
    log ".env: added $1=$2"
    CHANGED=true
  else
    info ".env: $1=$(env_get "$1") (kept)"
  fi
}

EXTERNAL_IP=$(env_get EXTERNAL_IP)
DRACHTIO_SECRET=$(env_get DRACHTIO_SECRET)
WEB_DOMAIN=$(env_get WEB_DOMAIN)
WSS_URL=$(env_get WSS_URL)
MOH_DIR=$(env_get MOH_DIR); MOH_DIR=${MOH_DIR:-${APP_DIR}/audio}
VM_DIR=$(env_get VOICEMAIL_DIR); VM_DIR=${VM_DIR:-/var/lib/shadowpbx/voicemail}

if [ -z "$WEB_DOMAIN" ] && [ -n "$WSS_URL" ]; then
  WEB_DOMAIN=$(echo "$WSS_URL" | sed -E 's#^wss?://([^/:]+).*#\1#')
fi

echo ""
echo -e "${BOLD}ShadowPBX — WebRTC foundations check${NC}"
echo "  External IP : ${EXTERNAL_IP:-<not set>}"
echo "  Web domain  : ${WEB_DOMAIN:-<not set>}"
echo "  WSS URL     : ${WSS_URL:-<not set>}"

# ============================================================
step "1/7 Drachtio WebSocket listener"
# ============================================================
if ! docker ps --format '{{.Names}}' | grep -qx drachtio; then
  err "Drachtio container is not running (docker ps)"
else
  D_ARGS=$(docker inspect drachtio --format '{{join .Config.Cmd " "}} {{join .Args " "}}' 2>/dev/null)
  D_IMAGE=$(docker inspect drachtio --format '{{.Config.Image}}' 2>/dev/null)
  D_IMAGE=${D_IMAGE:-$DEFAULT_DRACHTIO_IMAGE}
  HAS_WS=false; HAS_TLS=false
  echo "$D_ARGS" | grep -q 'transport=ws' && HAS_WS=true
  echo "$D_ARGS" | grep -q 'transport=tls' && HAS_TLS=true

  if $HAS_WS; then
    log "Drachtio has a WS contact (${D_IMAGE})"
  else
    err "Drachtio has NO WS contact — browsers cannot register (commonly caused by an older setup-tls.sh)"
    TLS_LABEL=""; $HAS_TLS && TLS_LABEL=" + existing TLS 5061"
    if $FIX_DRACHTIO || confirm "Recreate Drachtio with UDP/TCP 5060 + WS 127.0.0.1:5061${TLS_LABEL}?"; then
      if [ -z "$EXTERNAL_IP" ] || [ -z "$DRACHTIO_SECRET" ]; then
        err "EXTERNAL_IP / DRACHTIO_SECRET missing in .env — cannot recreate Drachtio"
      else
        TLS_ARGS=()
        TLS_VOL=()
        if $HAS_TLS && [ -f "${TLS_DIR}/fullchain.pem" ]; then
          TLS_VOL=(-v "${TLS_DIR}:/etc/drachtio-tls:ro")
          TLS_ARGS=(--contact "sips:${EXTERNAL_IP}:5061;transport=tls,tls-cert-file=/etc/drachtio-tls/fullchain.pem,tls-key-file=/etc/drachtio-tls/privkey.pem")
        fi
        docker stop drachtio >/dev/null 2>&1 || true
        docker rm drachtio >/dev/null 2>&1 || true
        docker run -d \
          --name drachtio \
          --restart unless-stopped \
          --net host \
          "${TLS_VOL[@]}" \
          --entrypoint drachtio \
          "${D_IMAGE}" \
            --contact "sip:${EXTERNAL_IP}:5060;transport=udp,tcp" \
            "${TLS_ARGS[@]}" \
            --contact "sip:127.0.0.1:5061;transport=ws" \
            --external-ip "${EXTERNAL_IP}" \
            --secret "${DRACHTIO_SECRET}" \
            --loglevel info >/dev/null
        sleep 3
        if docker ps --format '{{.Names}}' | grep -qx drachtio; then
          log "Drachtio recreated with WS listener"; CHANGED=true; FAILURES=$((FAILURES-1))
        else
          err "Drachtio failed to start — docker logs drachtio"
        fi
      fi
    fi
  fi

  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:5061'; then
    log "Listening on 127.0.0.1:5061 (WS)"
  else
    warn "Nothing listening on 127.0.0.1:5061 yet (Drachtio may still be starting)"
  fi
fi

# ============================================================
step "2/7 nginx /ws proxy"
# ============================================================
NGINX_FILE=$(grep -rls 'proxy_pass http://127.0.0.1:5061' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1)
if [ -z "$NGINX_FILE" ]; then
  err "No nginx location proxies to Drachtio WS (127.0.0.1:5061)"
  info "Add this inside the 'listen 443 ssl' server block for ${WEB_DOMAIN:-your domain}, then: nginx -t && systemctl reload nginx"
  cat << 'NGX'

    # SIP over WebSocket (WebRTC) -> Drachtio WS
    location /ws {
        proxy_pass http://127.0.0.1:5061;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

NGX
else
  log "WS proxy found in ${NGINX_FILE}"
  grep -q 'proxy_read_timeout' "$NGINX_FILE" || warn "No proxy_read_timeout on /ws — nginx will drop idle SIP WebSockets after 60s (set 3600s)"
  grep -q 'listen 443' "$NGINX_FILE" || warn "${NGINX_FILE} has no 'listen 443' — browsers require wss:// (HTTPS)"
fi

# ============================================================
step "3/7 TLS certificate + live WSS handshake"
# ============================================================
if [ -z "$WEB_DOMAIN" ]; then
  err "WEB_DOMAIN not set — WebRTC needs a domain with HTTPS (browsers block mic + ws:// on plain HTTP)"
else
  CERT="/etc/letsencrypt/live/${WEB_DOMAIN}/fullchain.pem"
  if [ -f "$CERT" ]; then
    EXP=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
    ALG=$(openssl x509 -text -noout -in "$CERT" 2>/dev/null | grep -m1 'Public Key Algorithm' | awk -F: '{print $2}' | xargs)
    log "Certificate for ${WEB_DOMAIN}: ${ALG:-unknown}, expires ${EXP:-unknown}"
    if ! openssl x509 -checkend 1209600 -noout -in "$CERT" >/dev/null 2>&1; then
      warn "Certificate expires within 14 days — run: certbot renew"
    fi
  else
    warn "No Let's Encrypt certificate at ${CERT} (fine if you use another CA)"
  fi

  if command -v curl >/dev/null 2>&1; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 4 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: c2hhZG93cGJ4LXdlYnJ0Yw==' \
      -H 'Sec-WebSocket-Protocol: sip' \
      "https://${WEB_DOMAIN}/ws" 2>/dev/null)
    if [ "$CODE" = "101" ]; then
      log "wss://${WEB_DOMAIN}/ws answered 101 Switching Protocols (TLS + nginx + Drachtio OK)"
    else
      err "wss://${WEB_DOMAIN}/ws returned HTTP ${CODE:-no response} (expected 101)"
      info "000 = TLS/DNS/firewall problem · 502 = nginx cannot reach Drachtio 127.0.0.1:5061 · 404 = /ws location missing"
    fi
  fi
fi

# ============================================================
step "4/7 RTPEngine public address (ICE candidates)"
# ============================================================
if ! docker ps --format '{{.Names}}' | grep -qx rtpengine; then
  err "RTPEngine container is not running"
else
  R_ARGS=$(docker inspect rtpengine --format '{{join .Config.Cmd " "}} {{join .Args " "}}' 2>/dev/null)
  R_IMAGE=$(docker inspect rtpengine --format '{{.Config.Image}}' 2>/dev/null)
  R_IMAGE=${R_IMAGE:-$DEFAULT_RTPENGINE_IMAGE}
  R_IFACE=$(echo "$R_ARGS" | grep -oE 'interface=[^ ]+' | head -1 | cut -d= -f2 | tr -d '"')
  info "RTPEngine --interface=${R_IFACE:-<unknown>}"

  LOCAL_IPS=$(hostname -I 2>/dev/null)
  PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')
  WANT_IFACE="${EXTERNAL_IP}"
  if [ -n "$EXTERNAL_IP" ] && ! echo " ${LOCAL_IPS} " | grep -q " ${EXTERNAL_IP} "; then
    # Public IP is not on a local NIC (AWS/GCP/Azure style 1:1 NAT)
    WANT_IFACE="${PRIVATE_IP}!${EXTERNAL_IP}"
  fi

  if [ "$R_IFACE" = "$WANT_IFACE" ]; then
    log "RTPEngine advertises ${EXTERNAL_IP} — browsers can reach it"
  elif [ "$R_IFACE" = "$EXTERNAL_IP" ] && [ "$WANT_IFACE" != "$EXTERNAL_IP" ]; then
    err "EXTERNAL_IP ${EXTERNAL_IP} is not bound to a local interface — RTPEngine needs --interface=${WANT_IFACE}"
  else
    warn "RTPEngine interface '${R_IFACE}' differs from expected '${WANT_IFACE}'"
  fi

  if [ "$R_IFACE" != "$WANT_IFACE" ] && [ -n "$EXTERNAL_IP" ]; then
    if $FIX_RTPENGINE || confirm "Recreate RTPEngine with --interface=${WANT_IFACE}? (drops calls in progress)"; then
      mkdir -p "${SPOOL_DIR}" && chmod 777 "${SPOOL_DIR}"
      docker stop rtpengine >/dev/null 2>&1 || true
      docker rm rtpengine >/dev/null 2>&1 || true
      docker run -d \
        --name rtpengine \
        --restart unless-stopped \
        --net host \
        -v "${SPOOL_DIR}:${SPOOL_DIR}" \
        -v "${MOH_DIR}:/audio:ro" \
        -v "${VM_DIR}:/voicemail" \
        --entrypoint /usr/local/bin/rtpengine \
        "${R_IMAGE}" \
          --interface="${WANT_IFACE}" \
          --listen-ng=127.0.0.1:22222 \
          --port-min=10000 \
          --port-max=20000 \
          --recording-dir="${SPOOL_DIR}" \
          --recording-method=pcap \
          --recording-format=eth \
          --dtmf-log-dest=127.0.0.1:22223 \
          --log-level=4 \
          --log-stderr \
          --foreground \
          --delete-delay=0 >/dev/null
      sleep 3
      if docker ps --format '{{.Names}}' | grep -qx rtpengine; then
        log "RTPEngine recreated with --interface=${WANT_IFACE}"; CHANGED=true
      else
        err "RTPEngine failed to start — docker logs rtpengine"
      fi
    fi
  fi
fi

# ============================================================
step "5/7 Firewall (media UDP 10000-20000, HTTPS/WSS TCP 443)"
# ============================================================
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 10000:20000/udp >/dev/null && log "ufw: 10000:20000/udp allowed"
  ufw allow 443/tcp >/dev/null && log "ufw: 443/tcp allowed"
elif command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p udp --dport 10000:20000 -j ACCEPT 2>/dev/null || { iptables -I INPUT -p udp --dport 10000:20000 -j ACCEPT; CHANGED=true; }
  log "iptables: 10000:20000/udp accepted"
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || { iptables -I INPUT -p tcp --dport 443 -j ACCEPT; CHANGED=true; }
  log "iptables: 443/tcp accepted"
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true
  else mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 2>/dev/null || true; fi
else
  warn "No ufw/iptables found — make sure UDP 10000-20000 and TCP 443 are open"
fi
info "Cloud firewall / security group: open the same ports there too."
info "Drachtio WS (5061) should NOT be public — nginx reaches it on 127.0.0.1."

# ============================================================
step "6/7 .env WebRTC settings"
# ============================================================
env_default WEBRTC_ENABLED true
env_default WEBRTC_CODEC_POLICY g711
env_default WEBRTC_DTLS_ANSWER passive
env_default WEBRTC_STUN_SERVERS "stun:stun.l.google.com:19302"
if [ -n "$WEB_DOMAIN" ]; then
  if [ -z "$WSS_URL" ]; then
    sed -i '/^WSS_URL=$/d' "$ENV_FILE"
    env_default WSS_URL "wss://${WEB_DOMAIN}/ws"
  else
    info ".env: WSS_URL=${WSS_URL} (kept)"
  fi
fi

# ============================================================
step "7/7 Restart + RTPEngine WebRTC self-test"
# ============================================================
if $DO_RESTART && systemctl list-unit-files 2>/dev/null | grep -q '^shadowpbx.service'; then
  systemctl restart shadowpbx && log "shadowpbx restarted"
  sleep 4
fi

if [ -f "${APP_DIR}/scripts/webrtc-selftest.js" ]; then
  (cd "${APP_DIR}" && node scripts/webrtc-selftest.js) || FAILURES=$((FAILURES+1))
else
  warn "${APP_DIR}/scripts/webrtc-selftest.js not found — copy the Phase 1 files to ${APP_DIR} first"
fi

echo ""
if [ "$FAILURES" -le 0 ]; then
  echo -e "${BOLD}${GREEN}WebRTC foundations ready${NC} (${WARNINGS} warning(s))"
  echo ""
  echo "  Next: log in as admin -> Network -> WebRTC"
  echo "        register an extension in the test softphone and call a desk phone."
else
  echo -e "${BOLD}${RED}${FAILURES} check(s) failed${NC}, ${WARNINGS} warning(s) — fix the [FAIL] items above and re-run."
fi
echo ""
exit 0
