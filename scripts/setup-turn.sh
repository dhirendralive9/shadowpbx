#!/bin/bash
#
# ShadowPBX — TURN server setup (Web Dialer Phase 8)
#
# Installs and configures coturn so browser calls work from behind
# restrictive NATs and corporate firewalls.
#
#   Browser ──ICE──> direct  → STUN (reflexive)  → TURN (relay, this server)
#
# Without a relay, roughly one visitor in ten connects the call but hears
# nothing. coturn fixes that. Credentials are ephemeral (HMAC of an expiry
# timestamp), minted per call by ShadowPBX — no TURN users are ever stored.
#
# What this script does:
#   1. Installs coturn
#   2. Generates a shared secret and writes /etc/turnserver.conf
#   3. Re-uses your Let's Encrypt certificate for TURN over TLS (:5349)
#   4. Opens 3478/udp+tcp, 5349/tcp and the relay range in the firewall
#   5. Adds TURN_URLS / TURN_SECRET / TURN_TTL to .env
#   6. Restarts coturn and ShadowPBX, then verifies the relay answers
#
# Usage:
#   sudo bash scripts/setup-turn.sh                  # use WEB_DOMAIN from .env
#   sudo bash scripts/setup-turn.sh pbx.example.com  # explicit hostname
#   sudo bash scripts/setup-turn.sh --no-tls         # plain TURN only (3478)
#   sudo bash scripts/setup-turn.sh --yes            # no prompts
#
# Relay ports default to 49160-49200 (enough for ~20 concurrent relayed
# calls). Raise WEBCALL_TURN_PORT_MAX below if you need more.
#

set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
step() { echo -e "\n${CYAN}[STEP]${NC} ${BOLD}$1${NC}"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[FAIL]${NC} $1"; }

APP_DIR="/opt/shadowpbx"
ENV_FILE="${APP_DIR}/.env"
CONF="/etc/turnserver.conf"
PORT_MIN=49160
PORT_MAX=49200

USE_TLS=true
ASSUME_YES=false
DOMAIN=""

for arg in "$@"; do
  case "$arg" in
    --no-tls)  USE_TLS=false ;;
    --yes|-y)  ASSUME_YES=true ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $arg"; exit 1 ;;
    *) DOMAIN="$arg" ;;
  esac
done

[ "$EUID" -ne 0 ] && { echo -e "${RED}[ERROR]${NC} Run as root: sudo bash $0"; exit 1; }
[ ! -f "$ENV_FILE" ] && { echo -e "${RED}[ERROR]${NC} ${ENV_FILE} not found — install ShadowPBX first"; exit 1; }

env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
env_set() {
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
  log ".env: $1 set"
}

EXTERNAL_IP=$(env_get EXTERNAL_IP)
[ -z "$DOMAIN" ] && DOMAIN=$(env_get WEB_DOMAIN)
[ -z "$DOMAIN" ] && DOMAIN="$EXTERNAL_IP"
[ -z "$DOMAIN" ] && { err "No domain or EXTERNAL_IP — set WEB_DOMAIN in .env or pass a hostname"; exit 1; }

PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')
BEHIND_NAT=false
if [ -n "$EXTERNAL_IP" ] && ! echo " $(hostname -I) " | grep -q " ${EXTERNAL_IP} "; then BEHIND_NAT=true; fi

CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
if $USE_TLS && [ ! -f "$CERT" ]; then
  warn "No certificate at ${CERT} — continuing with plain TURN on 3478 only"
  USE_TLS=false
fi

echo ""
echo -e "${BOLD}ShadowPBX — TURN setup${NC}"
echo "  Hostname    : ${DOMAIN}"
echo "  Public IP   : ${EXTERNAL_IP:-<unset>}$( $BEHIND_NAT && echo "  (1:1 NAT, private ${PRIVATE_IP})" )"
echo "  TURN over TLS: $( $USE_TLS && echo yes || echo 'no (3478 only)' )"
echo "  Relay ports : ${PORT_MIN}-${PORT_MAX}/udp"
echo ""
if ! $ASSUME_YES; then
  read -r -p "Continue? (y/n): " -n 1 REPLY; echo ""
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
fi

# ============================================================
step "1/6 Installing coturn"
# ============================================================
if ! command -v turnserver >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn || { err "coturn install failed"; exit 1; }
fi
log "coturn $(turnserver --version 2>&1 | head -1)"
sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn

# ============================================================
step "2/6 Writing ${CONF}"
# ============================================================
SECRET=$(env_get TURN_SECRET)
if [ -z "$SECRET" ]; then
  SECRET=$(openssl rand -hex 32)
  log "Generated a new TURN shared secret"
else
  log "Re-using the TURN secret already in .env"
fi

[ -f "$CONF" ] && cp "$CONF" "${CONF}.bak.$(date +%s)"

{
  echo "# ShadowPBX — generated $(date)"
  echo "listening-port=3478"
  $USE_TLS && echo "tls-listening-port=5349"
  echo "fingerprint"
  echo "use-auth-secret"
  echo "static-auth-secret=${SECRET}"
  echo "realm=${DOMAIN}"
  echo "server-name=${DOMAIN}"
  if $BEHIND_NAT; then
    echo "listening-ip=${PRIVATE_IP}"
    echo "external-ip=${EXTERNAL_IP}/${PRIVATE_IP}"
  else
    echo "listening-ip=${EXTERNAL_IP:-0.0.0.0}"
    [ -n "$EXTERNAL_IP" ] && echo "external-ip=${EXTERNAL_IP}"
  fi
  echo "min-port=${PORT_MIN}"
  echo "max-port=${PORT_MAX}"
  if $USE_TLS; then
    echo "cert=${CERT}"
    echo "pkey=${KEY}"
    echo "no-tlsv1"
    echo "no-tlsv1_1"
  fi
  echo "no-cli"
  echo "no-multicast-peers"
  # A relay must never be usable to reach the inside of your network
  echo "denied-peer-ip=10.0.0.0-10.255.255.255"
  echo "denied-peer-ip=172.16.0.0-172.31.255.255"
  echo "denied-peer-ip=192.168.0.0-192.168.255.255"
  echo "denied-peer-ip=127.0.0.0-127.255.255.255"
  echo "denied-peer-ip=169.254.0.0-169.254.255.255"
  echo "allowed-peer-ip=${EXTERNAL_IP:-0.0.0.0}"
  echo "user-quota=12"
  echo "total-quota=1200"
  echo "syslog"
  echo "simple-log"
} > "$CONF"
chmod 640 "$CONF"
log "Configuration written (relay denied into private ranges, RTPEngine allowed)"

if $USE_TLS; then
  # coturn runs as its own user and must be able to read the certificate
  if getent group ssl-cert >/dev/null 2>&1; then
    usermod -aG ssl-cert turnserver 2>/dev/null || true
  fi
  chmod 755 /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  RENEW_HOOK=/etc/letsencrypt/renewal-hooks/deploy/shadowpbx-turn.sh
  mkdir -p "$(dirname "$RENEW_HOOK")"
  printf '#!/bin/bash\nsystemctl restart coturn\n' > "$RENEW_HOOK"
  chmod +x "$RENEW_HOOK"
  log "Certificate renewal hook installed (coturn restarts on renewal)"
fi

# ============================================================
step "3/6 Firewall"
# ============================================================
open_port() {  # proto port-or-range
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow "$2/$1" >/dev/null 2>&1
  elif command -v iptables >/dev/null 2>&1; then
    local dport="${2/-/:}"
    iptables -C INPUT -p "$1" --dport "$dport" -j ACCEPT 2>/dev/null || iptables -I INPUT -p "$1" --dport "$dport" -j ACCEPT
  fi
}
open_port udp 3478; open_port tcp 3478
$USE_TLS && { open_port tcp 5349; open_port udp 5349; }
open_port udp "${PORT_MIN}-${PORT_MAX}"
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true
elif command -v iptables-save >/dev/null 2>&1; then mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 2>/dev/null || true; fi
log "Opened 3478/udp+tcp$( $USE_TLS && echo ', 5349/tcp' ), ${PORT_MIN}-${PORT_MAX}/udp"
echo "       Open the same ports in your cloud firewall / security group."

# ============================================================
step "4/6 Updating .env"
# ============================================================
URLS="turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp"
$USE_TLS && URLS="${URLS},turns:${DOMAIN}:5349?transport=tcp"
env_set TURN_URLS "$URLS"
env_set TURN_SECRET "$SECRET"
env_set TURN_TTL "3600"

# ============================================================
step "5/6 Starting services"
# ============================================================
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn
sleep 2
if systemctl is-active --quiet coturn; then log "coturn running"; else err "coturn did not start — journalctl -u coturn -n 40"; fi
systemctl restart shadowpbx 2>/dev/null && log "shadowpbx restarted"

# ============================================================
step "6/6 Verifying"
# ============================================================
if command -v ss >/dev/null 2>&1; then
  ss -lun 2>/dev/null | grep -q ':3478' && log "Listening on 3478/udp" || warn "Nothing listening on 3478/udp"
  $USE_TLS && { ss -ltn 2>/dev/null | grep -q ':5349' && log "Listening on 5349/tcp" || warn "Nothing listening on 5349/tcp"; }
fi

if command -v turnutils_uclient >/dev/null 2>&1 && [ -n "$EXTERNAL_IP" ]; then
  EXPIRY=$(( $(date +%s) + 600 ))
  TUSER="${EXPIRY}:selftest"
  TPASS=$(printf '%s' "$TUSER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
  if timeout 12 turnutils_uclient -t -u "$TUSER" -w "$TPASS" -y -n 2 "$EXTERNAL_IP" >/tmp/turntest.log 2>&1; then
    log "Relay allocation succeeded with an ephemeral credential"
  else
    warn "turnutils_uclient could not allocate a relay — see /tmp/turntest.log"
  fi
fi

echo ""
echo -e "${BOLD}${GREEN}TURN ready${NC}"
echo ""
echo "  URLs   : ${URLS}"
echo "  Creds  : ephemeral, 3600s, minted per call by ShadowPBX"
echo ""
echo "  Verify from a browser: Network → WebRTC should no longer warn about TURN."
echo "  Then place a web call from a phone on mobile data — the relay path is"
echo "  the one that only shows up on restrictive networks."
echo ""
exit 0
