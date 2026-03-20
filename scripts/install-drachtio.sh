#!/bin/bash
#
# ShadowPBX - Fresh Server Installation (Debian 12)
# Run as root on a clean VPS
#
# Installs: Node.js 18, MongoDB 7, Drachtio, RTPEngine, fail2ban
# Generates: all passwords, MongoDB auth, .env config
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

# ============================================================
# PRE-CHECKS
# ============================================================
if [ "$EUID" -ne 0 ]; then
  err "Run as root: sudo bash $0"
  exit 1
fi

# ============================================================
# GENERATE ALL PASSWORDS
# ============================================================
gen_pass() {
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"
}

MONGO_ADMIN_PASS=$(gen_pass 24)
MONGO_APP_PASS=$(gen_pass 24)
DRACHTIO_SECRET=$(gen_pass 20)
API_SECRET=$(gen_pass 32)
EXTERNAL_IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

MONGO_DB="shadowpbx"
MONGO_USER="shadowpbx"
APP_DIR="/opt/shadowpbx"
LOG_DIR="/var/log/shadowpbx"
REC_DIR="/var/lib/shadowpbx/recordings"

# Ask for SIP domain
echo ""
read -p "Enter your SIP domain (or press Enter for ${EXTERNAL_IP}): " SIP_DOMAIN
SIP_DOMAIN=${SIP_DOMAIN:-$EXTERNAL_IP}

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  ShadowPBX - Fresh Server Installation${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  Server IP:   ${EXTERNAL_IP}"
echo "  SIP Domain:  ${SIP_DOMAIN}"
echo "  Target:      ${APP_DIR}"
echo ""
read -p "Continue? (y/n): " -n 1 -r
echo ""
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 0

# ============================================================
step "1/8 - Updating system and installing dependencies..."
# ============================================================
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  build-essential git curl wget gnupg lsb-release \
  libcurl4-openssl-dev libssl-dev \
  pkg-config openssl ca-certificates \
  software-properties-common unzip htop

# Install iptables-persistent non-interactively
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get install -y -qq iptables-persistent netfilter-persistent

log "System dependencies installed"

# ============================================================
step "2/8 - Installing Node.js 18 LTS..."
# ============================================================
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v) | npm $(npm -v)"

# ============================================================
step "3/8 - Installing and securing MongoDB 7..."
# ============================================================
if ! command -v mongod &> /dev/null; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
  echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -qq
  apt-get install -y -qq mongodb-org
fi

systemctl enable mongod
systemctl start mongod
sleep 3

# Create users (skip if auth already enabled)
if ! grep -q "authorization: enabled" /etc/mongod.conf; then
  mongosh --quiet admin << MONGOEOF
db.createUser({
  user: "admin",
  pwd: "${MONGO_ADMIN_PASS}",
  roles: [{ role: "root", db: "admin" }]
});
MONGOEOF

  mongosh --quiet ${MONGO_DB} << MONGOEOF
db.createUser({
  user: "${MONGO_USER}",
  pwd: "${MONGO_APP_PASS}",
  roles: [{ role: "readWrite", db: "${MONGO_DB}" }]
});
MONGOEOF

  # Enable auth + bind localhost only
  cat >> /etc/mongod.conf << EOF

security:
  authorization: enabled
EOF
  sed -i 's/bindIp:.*/bindIp: 127.0.0.1/' /etc/mongod.conf
  systemctl restart mongod
  sleep 2
fi

log "MongoDB secured (auth enabled, localhost only)"

MONGO_URI="mongodb://${MONGO_USER}:${MONGO_APP_PASS}@127.0.0.1:27017/${MONGO_DB}?authSource=${MONGO_DB}"

# ============================================================
step "4/8 - Installing Docker + Drachtio SIP server..."
# ============================================================
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

docker pull drachtio/drachtio-server:latest
docker stop drachtio 2>/dev/null || true
docker rm drachtio 2>/dev/null || true

docker run -d \
  --name drachtio \
  --restart unless-stopped \
  --net host \
  drachtio/drachtio-server:latest \
  drachtio \
    --contact "sip:${EXTERNAL_IP}:5060;transport=udp" \
    --external-ip ${EXTERNAL_IP} \
    --admin-port 9022 \
    --secret ${DRACHTIO_SECRET} \
    --loglevel info

sleep 3
docker ps | grep -q drachtio && log "Drachtio running on :5060" || err "Drachtio failed - check: docker logs drachtio"

# ============================================================
step "5/8 - Installing RTPEngine (media + recording)..."
# ============================================================
docker pull drachtio/rtpengine:latest
docker stop rtpengine 2>/dev/null || true
docker rm rtpengine 2>/dev/null || true

AUDIO_DIR="${APP_DIR}/audio"
VM_DIR="/var/lib/shadowpbx/voicemail"

mkdir -p ${REC_DIR} ${REC_DIR}/pcap ${REC_DIR}/metadata
mkdir -p ${AUDIO_DIR}
mkdir -p ${VM_DIR}/greetings

docker run -d \
  --name rtpengine \
  --restart unless-stopped \
  --net host \
  -v ${REC_DIR}:/recordings \
  -v ${AUDIO_DIR}:/audio:ro \
  -v ${VM_DIR}:/voicemail \
  drachtio/rtpengine:latest \
  rtpengine \
    --interface="${EXTERNAL_IP}" \
    --listen-ng=127.0.0.1:22222 \
    --port-min=10000 \
    --port-max=20000 \
    --recording-dir=/recordings \
    --recording-method=pcap \
    --recording-format=eth \
    --dtmf-log-dest=127.0.0.1:22223 \
    --log-level=5

sleep 2
docker ps | grep -q rtpengine && log "RTPEngine running (ports 10000-20000)" || err "RTPEngine failed - check: docker logs rtpengine"

# ============================================================
step "6/8 - Setting up ShadowPBX application..."
# ============================================================
mkdir -p ${APP_DIR} ${LOG_DIR} ${REC_DIR}

# Copy app files from current directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "${SCRIPT_DIR}/package.json" ]; then
  cp -r ${SCRIPT_DIR}/src ${APP_DIR}/
  cp ${SCRIPT_DIR}/package.json ${APP_DIR}/
  log "App files copied from ${SCRIPT_DIR}"
else
  warn "No source files found in ${SCRIPT_DIR} - copy them manually to ${APP_DIR}"
fi

# Write .env
cat > ${APP_DIR}/.env << EOF
# ShadowPBX - Generated $(date)
DRACHTIO_HOST=127.0.0.1
DRACHTIO_PORT=9022
DRACHTIO_SECRET=${DRACHTIO_SECRET}
SIP_DOMAIN=${SIP_DOMAIN}
SIP_PORT=5060
EXTERNAL_IP=${EXTERNAL_IP}
RTPENGINE_HOST=127.0.0.1
RTPENGINE_PORT=22222
MONGODB_URI=${MONGO_URI}
RECORDINGS_DIR=${REC_DIR}
RECORDING_FORMAT=wav
API_PORT=3000
ADMIN_SECRET=${API_SECRET}
MAX_REGISTER_ATTEMPTS=5
REGISTER_BAN_DURATION=300
SIP_RATE_LIMIT=20
LOG_LEVEL=info

# Music on Hold
MOH_DIR=${AUDIO_DIR}

# Voicemail
VOICEMAIL_DIR=${VM_DIR}
VM_BEEP_FILE=/audio/beep.wav
VM_DEFAULT_GREETING=/audio/vm-greeting.wav
VM_MAX_MESSAGE_LENGTH=120

# Call Park
PARK_SLOT_MIN=70
PARK_SLOT_MAX=79
EOF

log ".env created"

# Install npm dependencies
if [ -f "${APP_DIR}/package.json" ]; then
  cd ${APP_DIR}
  npm install --production 2>&1 | tail -5
  log "npm dependencies installed"
else
  warn "package.json not found - run 'npm install' manually in ${APP_DIR}"
fi

# Create systemd service
cat > /etc/systemd/system/shadowpbx.service << EOF
[Unit]
Description=ShadowPBX
After=network.target mongod.service docker.service
Requires=mongod.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:${LOG_DIR}/shadowpbx.log
StandardError=append:${LOG_DIR}/error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shadowpbx
log "systemd service created"

# ============================================================
step "7/8 - Firewall + SIP brute force protection..."
# ============================================================

# Flush old SIP rules
iptables -F SIP_LIMIT 2>/dev/null || true
iptables -X SIP_LIMIT 2>/dev/null || true

# Create SIP rate limiting chain
iptables -N SIP_LIMIT 2>/dev/null || true
iptables -A SIP_LIMIT -m recent --name sip_brute --set
iptables -A SIP_LIMIT -m recent --name sip_brute --update --seconds 60 --hitcount 30 -j DROP
iptables -A SIP_LIMIT -j ACCEPT

# Allow established
iptables -I INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# SSH
iptables -I INPUT -p tcp --dport 22 -j ACCEPT

# SIP through rate limiter
iptables -A INPUT -p udp --dport 5060 -j SIP_LIMIT
iptables -A INPUT -p tcp --dport 5060 -j SIP_LIMIT

# RTP media
iptables -A INPUT -p udp --dport 10000:20000 -j ACCEPT

# API - localhost only
iptables -A INPUT -p tcp --dport 3000 -s 127.0.0.1 -j ACCEPT

netfilter-persistent save 2>/dev/null || true
log "Firewall: SIP rate limited (30/min), API localhost-only"

# fail2ban
apt-get install -y -qq fail2ban

mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d

cat > /etc/fail2ban/filter.d/shadowpbx.conf << 'FBEOF'
[Definition]
failregex = REGISTER rejected.*from <HOST>
            REGISTER blocked.*IP <HOST>
            INVITE rejected.*from <HOST>
ignoreregex =
FBEOF

cat > /etc/fail2ban/jail.d/shadowpbx.conf << FBEOF
[shadowpbx]
enabled = true
filter = shadowpbx
logpath = ${LOG_DIR}/shadowpbx.log
maxretry = 5
bantime = 3600
findtime = 300
action = iptables-multiport[name=shadowpbx, port="5060", protocol=udp]
         iptables-multiport[name=shadowpbx, port="5060", protocol=tcp]
FBEOF

systemctl enable fail2ban
systemctl restart fail2ban
log "fail2ban: 5 failed SIP auths = 1 hour ban"

# ============================================================
step "8/8 - Starting ShadowPBX and verifying..."
# ============================================================

# Start the service
systemctl start shadowpbx
sleep 3

echo ""
echo "--- Service Status ---"
echo -n "  MongoDB:    "; systemctl is-active mongod
echo -n "  Docker:     "; systemctl is-active docker
echo -n "  Drachtio:   "; docker ps --format '{{.Status}}' -f name=drachtio 2>/dev/null || echo "not running"
echo -n "  RTPEngine:  "; docker ps --format '{{.Status}}' -f name=rtpengine 2>/dev/null || echo "not running"
echo -n "  ShadowPBX:  "; systemctl is-active shadowpbx
echo -n "  fail2ban:   "; systemctl is-active fail2ban

# Save credentials
CREDS_FILE="${APP_DIR}/CREDENTIALS.txt"
cat > ${CREDS_FILE} << CREDSEOF
ShadowPBX Credentials - Generated $(date)
==========================================

MongoDB Admin:    admin / ${MONGO_ADMIN_PASS}
MongoDB App:      ${MONGO_USER} / ${MONGO_APP_PASS}
MongoDB URI:      ${MONGO_URI}
Drachtio Secret:  ${DRACHTIO_SECRET}
API URL:          http://localhost:3000/api
API Key:          ${API_SECRET}
SIP Server:       ${EXTERNAL_IP}:5060 (UDP)
SIP Domain:       ${SIP_DOMAIN}
CREDSEOF
chmod 600 ${CREDS_FILE}

echo ""
echo ""
echo -e "${BOLD}${RED}════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${RED}  SAVE THESE CREDENTIALS — SHOWN ONLY ONCE${NC}"
echo -e "${BOLD}${RED}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}MongoDB Admin${NC}"
echo "    User:     admin"
echo "    Password: ${MONGO_ADMIN_PASS}"
echo ""
echo -e "  ${BOLD}MongoDB App${NC}"
echo "    User:     ${MONGO_USER}"
echo "    Password: ${MONGO_APP_PASS}"
echo "    URI:      ${MONGO_URI}"
echo ""
echo -e "  ${BOLD}Drachtio Secret${NC}: ${DRACHTIO_SECRET}"
echo ""
echo -e "  ${BOLD}ShadowPBX API${NC}"
echo "    URL:      http://localhost:3000/api"
echo "    API Key:  ${API_SECRET}"
echo "    Remote:   ssh -L 3000:localhost:3000 root@${EXTERNAL_IP}"
echo ""
echo -e "  ${BOLD}SIP Server${NC}"
echo "    Address:  ${EXTERNAL_IP}:5060 (UDP)"
echo "    Domain:   ${SIP_DOMAIN}"
echo ""
echo -e "  ${BOLD}Security${NC}"
echo "    SIP rate limit:  30 req/min per IP"
echo "    fail2ban:        5 failed auths = 1hr ban"
echo "    API port 3000:   localhost only"
echo ""
echo "  Credentials saved: ${CREDS_FILE}"
echo ""
echo -e "${BOLD}${RED}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Create extensions:"
echo ""
EXT1_PASS=$(gen_pass 12)
EXT2_PASS=$(gen_pass 12)
EXT3_PASS=$(gen_pass 12)
echo "    curl -X POST http://localhost:3000/api/extensions/bulk \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -H 'X-API-Key: ${API_SECRET}' \\"
echo "      -d '{\"extensions\":["
echo "        {\"extension\":\"2001\",\"name\":\"User One\",\"password\":\"${EXT1_PASS}\"},"
echo "        {\"extension\":\"2002\",\"name\":\"User Two\",\"password\":\"${EXT2_PASS}\"},"
echo "        {\"extension\":\"2003\",\"name\":\"User Three\",\"password\":\"${EXT3_PASS}\"}]}'"
echo ""
echo "  Then register softphone: Server=${EXTERNAL_IP} User=2001 Pass=${EXT1_PASS}"
echo ""
