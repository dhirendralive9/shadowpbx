#!/bin/bash
#
# ShadowPBX — TLS/SRTP Setup
#
# Enables encrypted SIP signaling (TLS on port 5061) and
# encrypted media (SRTP via SDES) for compliance and security.
#
# What this script does:
#   1. Installs certbot (Let's Encrypt)
#   2. Obtains a TLS certificate for your SIP domain
#   3. Recreates the Drachtio container with TLS on port 5061
#   4. Updates .env with SRTP_MODE=offer
#   5. Restarts ShadowPBX
#   6. Sets up auto-renewal cron
#
# Prerequisites:
#   - Port 80 open temporarily (for Let's Encrypt HTTP challenge)
#   - DNS A record pointing your SIP domain to this server's IP
#   - ShadowPBX already installed via install-drachtio.sh
#
# Usage:
#   sudo bash scripts/setup-tls.sh your-sip-domain.com
#
# After running:
#   - SIP/TLS available on port 5061
#   - SIP/UDP still available on port 5060 (for backward compat)
#   - SRTP offered on all calls (plain RTP fallback if peer doesn't support it)
#   - Set SRTP_MODE=require in .env to reject non-SRTP calls
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
step() { echo -e "${CYAN}[STEP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }

APP_DIR="/opt/shadowpbx"
ENV_FILE="${APP_DIR}/.env"
CERT_DIR="/etc/shadowpbx/tls"

if [ "$EUID" -ne 0 ]; then
  err "Run as root: sudo bash $0 <domain>"
  exit 1
fi

DOMAIN="$1"
if [ -z "$DOMAIN" ]; then
  # Try to read from .env
  if [ -f "$ENV_FILE" ]; then
    DOMAIN=$(grep '^SIP_DOMAIN=' "$ENV_FILE" | cut -d= -f2)
  fi
  if [ -z "$DOMAIN" ]; then
    err "Usage: sudo bash $0 <your-sip-domain.com>"
    echo "  The domain must have a DNS A record pointing to this server."
    exit 1
  fi
fi

EXTERNAL_IP=$(grep '^EXTERNAL_IP=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || curl -4 -s ifconfig.me)
DRACHTIO_SECRET=$(grep '^DRACHTIO_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "cymru")

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  ShadowPBX — TLS/SRTP Setup${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  Domain:      ${DOMAIN}"
echo "  External IP: ${EXTERNAL_IP}"
echo ""

# ============================================================
step "1/5 — Installing certbot..."
# ============================================================
if ! command -v certbot &> /dev/null; then
  apt-get update -qq
  apt-get install -y -qq certbot
  log "certbot installed"
else
  log "certbot already installed"
fi

# ============================================================
step "2/5 — Obtaining TLS certificate..."
# ============================================================
mkdir -p ${CERT_DIR}

if [ -f "${CERT_DIR}/fullchain.pem" ] && [ -f "${CERT_DIR}/privkey.pem" ]; then
  warn "Existing certificates found in ${CERT_DIR}"
  read -p "  Re-issue? (y/N): " REISSUE
  if [ "$REISSUE" != "y" ] && [ "$REISSUE" != "Y" ]; then
    log "Using existing certificates"
  else
    certbot certonly --standalone --non-interactive --agree-tos \
      --register-unsafely-without-email \
      -d "${DOMAIN}" \
      --cert-path "${CERT_DIR}/cert.pem" \
      --key-path "${CERT_DIR}/privkey.pem" \
      --fullchain-path "${CERT_DIR}/fullchain.pem" \
      --chain-path "${CERT_DIR}/chain.pem"
    log "Certificate issued for ${DOMAIN}"
  fi
else
  # Temporarily stop anything on port 80
  systemctl stop nginx 2>/dev/null || true

  certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email \
    -d "${DOMAIN}"

  # Copy certs to our directory (certbot stores in /etc/letsencrypt)
  cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ${CERT_DIR}/fullchain.pem
  cp /etc/letsencrypt/live/${DOMAIN}/privkey.pem ${CERT_DIR}/privkey.pem
  cp /etc/letsencrypt/live/${DOMAIN}/chain.pem ${CERT_DIR}/chain.pem 2>/dev/null || true
  chmod 600 ${CERT_DIR}/*.pem

  log "Certificate issued for ${DOMAIN}"
fi

# ============================================================
step "3/5 — Recreating Drachtio with TLS..."
# ============================================================
docker stop drachtio 2>/dev/null || true
docker rm drachtio 2>/dev/null || true

# Drachtio supports multiple --contact flags for multi-transport
# We keep UDP on 5060 and add TLS on 5061
docker run -d \
  --name drachtio \
  --restart unless-stopped \
  --net host \
  -v ${CERT_DIR}:/etc/drachtio-tls:ro \
  drachtio/drachtio-server:latest \
  drachtio \
    --contact "sip:${EXTERNAL_IP}:5060;transport=udp" \
    --contact "sips:${EXTERNAL_IP}:5061;transport=tls,tls-cert-file=/etc/drachtio-tls/fullchain.pem,tls-key-file=/etc/drachtio-tls/privkey.pem" \
    --external-ip ${EXTERNAL_IP} \
    --admin-port 9022 \
    --secret ${DRACHTIO_SECRET} \
    --loglevel info

sleep 3
if docker ps | grep -q drachtio; then
  log "Drachtio running with TLS on :5061 + UDP on :5060"
else
  err "Drachtio failed to start — check: docker logs drachtio"
  exit 1
fi

# ============================================================
step "4/5 — Updating .env and firewall..."
# ============================================================

# Add/update SRTP_MODE in .env
if grep -q '^SRTP_MODE=' "$ENV_FILE" 2>/dev/null; then
  sed -i 's/^SRTP_MODE=.*/SRTP_MODE=offer/' "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "# TLS/SRTP — set to 'require' to reject non-SRTP calls" >> "$ENV_FILE"
  echo "SRTP_MODE=offer" >> "$ENV_FILE"
fi

# Add TLS cert paths to .env
if ! grep -q '^TLS_CERT=' "$ENV_FILE" 2>/dev/null; then
  echo "TLS_CERT=${CERT_DIR}/fullchain.pem" >> "$ENV_FILE"
  echo "TLS_KEY=${CERT_DIR}/privkey.pem" >> "$ENV_FILE"
fi

# Update SIP_DOMAIN if needed
sed -i "s/^SIP_DOMAIN=.*/SIP_DOMAIN=${DOMAIN}/" "$ENV_FILE"

log ".env updated (SRTP_MODE=offer)"

# Open port 5061 in firewall
iptables -C INPUT -p tcp --dport 5061 -j ACCEPT 2>/dev/null || \
  iptables -A INPUT -p tcp --dport 5061 -j ACCEPT
netfilter-persistent save 2>/dev/null || true

log "Firewall: port 5061/tcp open"

# ============================================================
step "5/5 — Setting up auto-renewal and restarting..."
# ============================================================

# Cron job for cert renewal — copies new certs and restarts Drachtio
RENEW_SCRIPT="/etc/cron.weekly/shadowpbx-tls-renew"
cat > ${RENEW_SCRIPT} << 'RENEWEOF'
#!/bin/bash
certbot renew --quiet
DOMAIN=$(grep '^SIP_DOMAIN=' /opt/shadowpbx/.env | cut -d= -f2)
if [ -n "$DOMAIN" ] && [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /etc/shadowpbx/tls/fullchain.pem
  cp /etc/letsencrypt/live/${DOMAIN}/privkey.pem /etc/shadowpbx/tls/privkey.pem
  chmod 600 /etc/shadowpbx/tls/*.pem
  docker restart drachtio
  systemctl restart shadowpbx
fi
RENEWEOF
chmod +x ${RENEW_SCRIPT}
log "Auto-renewal cron: ${RENEW_SCRIPT}"

# Restart ShadowPBX to pick up SRTP_MODE
systemctl restart shadowpbx
sleep 2

echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  TLS/SRTP Setup Complete${NC}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}SIP/UDP${NC}  (unencrypted):  ${EXTERNAL_IP}:5060"
echo -e "  ${BOLD}SIP/TLS${NC}  (encrypted):    ${EXTERNAL_IP}:5061"
echo -e "  ${BOLD}SRTP${NC}    mode:            offer (with plain RTP fallback)"
echo -e "  ${BOLD}Domain${NC}:                  ${DOMAIN}"
echo -e "  ${BOLD}Certificate${NC}:             ${CERT_DIR}/fullchain.pem"
echo -e "  ${BOLD}Auto-renewal${NC}:            weekly via ${RENEW_SCRIPT}"
echo ""
echo -e "  ${BOLD}Softphone TLS settings:${NC}"
echo "    Server:    ${DOMAIN}"
echo "    Port:      5061"
echo "    Transport: TLS"
echo "    SRTP:      Enabled (SDES)"
echo ""
echo -e "  ${BOLD}To require SRTP (no plain RTP fallback):${NC}"
echo "    Edit ${ENV_FILE} and set SRTP_MODE=require"
echo "    Then: systemctl restart shadowpbx"
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
