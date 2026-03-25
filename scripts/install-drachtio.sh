#!/bin/bash
#
# ShadowPBX - Fresh Server Installation (Debian 12 / Ubuntu 24)
# Run as root on a clean VPS
#
# Installs: Node.js 18, MongoDB 7, Drachtio (UDP+WS), RTPEngine,
#           Nginx (reverse proxy + WSS), Let's Encrypt SSL, fail2ban
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

MONGO_DB="shadowpbx"
MONGO_USER="shadowpbx"
APP_DIR="/opt/shadowpbx"
LOG_DIR="/var/log/shadowpbx"
REC_DIR="/var/lib/shadowpbx/recordings"
AUDIO_DIR="${APP_DIR}/audio"
VM_DIR="/var/lib/shadowpbx/voicemail"
CERTS_DIR="${APP_DIR}/certs"

# Check if this is a re-install (existing .env with MongoDB URI)
EXISTING_ENV="${APP_DIR}/.env"
if [ -f "${EXISTING_ENV}" ] && grep -q "MONGODB_URI=" "${EXISTING_ENV}"; then
  MONGO_URI=$(grep '^MONGODB_URI=' "${EXISTING_ENV}" | cut -d= -f2-)
  API_SECRET=$(grep '^ADMIN_SECRET=' "${EXISTING_ENV}" | cut -d= -f2-)
  ADMIN_PASSWORD=$(grep '^ADMIN_PASSWORD=' "${EXISTING_ENV}" | cut -d= -f2-)
  DRACHTIO_SECRET=$(grep '^DRACHTIO_SECRET=' "${EXISTING_ENV}" | cut -d= -f2-)
  log "Re-install detected: preserving existing credentials from .env"
  REINSTALL=true
else
  REINSTALL=false
fi

MONGO_ADMIN_PASS=$(gen_pass 24)
MONGO_APP_PASS=$(gen_pass 24)
[ -z "$DRACHTIO_SECRET" ] && DRACHTIO_SECRET=$(gen_pass 20)
[ -z "$API_SECRET" ] && API_SECRET=$(gen_pass 32)
EXTERNAL_IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

# Ask for SIP domain
echo ""
read -p "Enter your SIP domain (or press Enter for ${EXTERNAL_IP}): " SIP_DOMAIN
SIP_DOMAIN=${SIP_DOMAIN:-$EXTERNAL_IP}

# Ask for web domain (for nginx + SSL)
echo ""
echo -e "  ${BOLD}Web domain${NC} (e.g. pbx.yourdomain.com)"
echo "  A domain enables HTTPS, WebRTC phone, and secure access."
echo "  The domain must already point to ${EXTERNAL_IP} via DNS."
echo ""
read -p "Enter web domain (or press Enter to skip — use IP:3000 instead): " WEB_DOMAIN
WEB_DOMAIN=${WEB_DOMAIN:-""}

if [ -n "$WEB_DOMAIN" ]; then
  read -p "Email for SSL certificate (required for Let's Encrypt): " SSL_EMAIL
  SSL_EMAIL=${SSL_EMAIL:-"admin@${WEB_DOMAIN}"}
fi

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  ShadowPBX - Fresh Server Installation${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  Server IP:   ${EXTERNAL_IP}"
echo "  SIP Domain:  ${SIP_DOMAIN}"
if [ -n "$WEB_DOMAIN" ]; then
  echo "  Web Domain:  ${WEB_DOMAIN} (HTTPS + WebRTC)"
else
  echo "  Web Access:  http://${EXTERNAL_IP}:3000 (no domain)"
fi
echo "  Target:      ${APP_DIR}"
echo ""
read -p "Continue? (y/n): " -n 1 -r
echo ""
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 0

# ============================================================
step "1/10 - Updating system and installing dependencies..."
# ============================================================
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  build-essential git curl wget gnupg lsb-release \
  libcurl4-openssl-dev libssl-dev \
  pkg-config openssl ca-certificates \
  software-properties-common unzip htop \
  sox libsox-fmt-all ffmpeg xxd dnsutils

# Install tshark non-interactively (for pcap to wav recording conversion)
echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tshark

# Install iptables-persistent non-interactively
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get install -y -qq iptables-persistent netfilter-persistent

log "System dependencies installed"

# UDP buffer tuning for VoIP
if ! grep -q "net.core.rmem_max=2097152" /etc/sysctl.conf 2>/dev/null; then
  cat >> /etc/sysctl.conf << SYSEOF

# ShadowPBX — UDP buffer tuning for VoIP
net.core.rmem_max=2097152
net.core.rmem_default=1048576
net.core.wmem_max=2097152
net.core.wmem_default=1048576
SYSEOF
  sysctl -p > /dev/null 2>&1
  log "UDP buffers tuned (rmem/wmem 1-2MB)"
else
  log "UDP buffers already configured"
fi

# ============================================================
step "2/10 - Installing Node.js 18 LTS..."
# ============================================================
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node.js $(node -v) | npm $(npm -v)"

# ============================================================
step "3/10 - Installing and securing MongoDB 7..."
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

if [ "$REINSTALL" = "true" ]; then
  log "MongoDB: using existing credentials from .env"
elif ! grep -q "authorization: enabled" /etc/mongod.conf; then
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

  cat >> /etc/mongod.conf << EOF

security:
  authorization: enabled
EOF
  sed -i 's/bindIp:.*/bindIp: 127.0.0.1/' /etc/mongod.conf
  systemctl restart mongod
  sleep 2
fi

log "MongoDB secured (auth enabled, localhost only)"

if [ "$REINSTALL" != "true" ]; then
  MONGO_URI="mongodb://${MONGO_USER}:${MONGO_APP_PASS}@127.0.0.1:27017/${MONGO_DB}?authSource=${MONGO_DB}"
fi

# ============================================================
step "4/10 - Installing Docker + Drachtio SIP server..."
# ============================================================
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# Configure Docker log rotation
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << DOCKEREOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
DOCKEREOF
systemctl restart docker 2>/dev/null || true

# Drachtio v0.8.25 — stable, supports WS transport for WebRTC
docker pull drachtio/drachtio-server:0.8.25
docker stop drachtio 2>/dev/null || true
docker rm drachtio 2>/dev/null || true

docker run -d \
  --name drachtio \
  --restart unless-stopped \
  --net host \
  --entrypoint drachtio \
  drachtio/drachtio-server:0.8.25 \
    --contact "sip:${EXTERNAL_IP}:5060;transport=udp,tcp" \
    --contact "sip:127.0.0.1:5061;transport=ws" \
    --external-ip ${EXTERNAL_IP} \
    --secret ${DRACHTIO_SECRET} \
    --loglevel info

sleep 3
if docker ps | grep -q drachtio; then
  log "Drachtio v0.8.25 running on UDP:5060 + WS:5061"
else
  err "Drachtio failed - check: docker logs drachtio"
fi

# ============================================================
step "5/10 - Installing RTPEngine (media + recording)..."
# ============================================================
docker pull jambonz/rtpengine:latest
docker stop rtpengine 2>/dev/null || true
docker rm rtpengine 2>/dev/null || true

mkdir -p ${REC_DIR} ${REC_DIR}/pcap ${REC_DIR}/pcaps ${REC_DIR}/metadata ${REC_DIR}/wav ${REC_DIR}/tmp
mkdir -p /var/spool/rtpengine
chmod 777 /var/spool/rtpengine
mkdir -p ${AUDIO_DIR}
mkdir -p ${VM_DIR}/greetings

docker run -d \
  --name rtpengine \
  --restart unless-stopped \
  --net host \
  -v /var/spool/rtpengine:/var/spool/rtpengine \
  -v ${AUDIO_DIR}:/audio:ro \
  -v ${VM_DIR}:/voicemail \
  --entrypoint /usr/local/bin/rtpengine \
  jambonz/rtpengine:latest \
    --interface="${EXTERNAL_IP}" \
    --listen-ng=127.0.0.1:22222 \
    --port-min=10000 \
    --port-max=20000 \
    --recording-dir=/var/spool/rtpengine \
    --recording-method=pcap \
    --recording-format=eth \
    --dtmf-log-dest=127.0.0.1:22223 \
    --log-level=4 \
    --log-stderr \
    --foreground \
    --delete-delay=0

sleep 3
if docker ps | grep -q rtpengine; then
  log "RTPEngine running (ports 10000-20000)"
else
  err "RTPEngine failed - check: docker logs rtpengine"
fi

# Verify RTPEngine interface IP
RTP_IP=$(docker inspect rtpengine --format '{{json .Config.Cmd}}' 2>/dev/null | grep -o 'interface=[0-9.]*' | cut -d= -f2)
if [ "${RTP_IP}" = "${EXTERNAL_IP}" ]; then
  log "RTPEngine interface IP verified: ${RTP_IP}"
else
  warn "RTPEngine interface IP mismatch! Expected ${EXTERNAL_IP}, got ${RTP_IP}"
fi

# ============================================================
step "6/10 - Setting up ShadowPBX application..."
# ============================================================
mkdir -p ${APP_DIR} ${LOG_DIR} ${REC_DIR} ${CERTS_DIR}

# Copy app files from current directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "${SCRIPT_DIR}/package.json" ]; then
  if [ "${SCRIPT_DIR}" != "${APP_DIR}" ]; then
    cp -r ${SCRIPT_DIR}/src ${APP_DIR}/
    cp ${SCRIPT_DIR}/package.json ${APP_DIR}/
    [ -d "${SCRIPT_DIR}/scripts" ] && cp -r ${SCRIPT_DIR}/scripts ${APP_DIR}/
    [ -d "${SCRIPT_DIR}/audio" ] && cp -r ${SCRIPT_DIR}/audio ${APP_DIR}/
    log "App files copied from ${SCRIPT_DIR}"
  else
    log "Already running from ${APP_DIR} — skipping file copy"
  fi
else
  warn "No source files found in ${SCRIPT_DIR} - copy them manually to ${APP_DIR}"
fi

# Generate admin GUI password (only on fresh install)
if [ "$REINSTALL" != "true" ] || [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD=$(cat /dev/urandom | tr -dc 'A-HJ-NP-Za-hj-np-z2-9' | fold -w 16 | head -n 1)
fi

# Determine web URL
if [ -n "$WEB_DOMAIN" ]; then
  WEB_URL="https://${WEB_DOMAIN}"
  WSS_URL="wss://${WEB_DOMAIN}/ws"
else
  WEB_URL="http://${EXTERNAL_IP}:3000"
  WSS_URL=""
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
ADMIN_USER=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
MAX_REGISTER_ATTEMPTS=5
REGISTER_BAN_DURATION=300
SIP_RATE_LIMIT=20
LOG_LEVEL=info

# Web domain (for WebRTC phone WSS URL)
WEB_DOMAIN=${WEB_DOMAIN}
WSS_URL=${WSS_URL}

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

# DTMF Detection
DTMF_LISTEN_PORT=22223

# Recording worker
RECORDING_SPOOL_DIR=/var/spool/rtpengine

# Registration
MAX_REGISTRATION_EXPIRES=300
EOF

log ".env created"

# Install npm dependencies
if [ -f "${APP_DIR}/package.json" ]; then
  cd ${APP_DIR}
  npm install --production 2>&1 | tail -5
  npm install cookie-parser ejs --save 2>&1 | tail -3
  log "npm dependencies installed"
else
  warn "package.json not found - run 'npm install' manually in ${APP_DIR}"
fi

# Create systemd service (StandardOutput=null to prevent double-logging)
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
StandardOutput=null
StandardError=append:${LOG_DIR}/error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shadowpbx
log "systemd service created"

# Create recording worker systemd service
cat > /etc/systemd/system/shadowpbx-recorder.service << EOF
[Unit]
Description=ShadowPBX Recording Worker
After=network.target mongod.service docker.service shadowpbx.service
Wants=shadowpbx.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/recorder-worker.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=append:${LOG_DIR}/recorder.log
StandardError=append:${LOG_DIR}/recorder-error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shadowpbx-recorder
log "Recording worker service created"

# ============================================================
step "7/10 - Setting up Nginx reverse proxy..."
# ============================================================
apt-get install -y -qq nginx

if [ -n "$WEB_DOMAIN" ]; then
  # Domain provided — set up nginx with HTTP first, then attempt SSL
  cat > /etc/nginx/sites-available/shadowpbx << NGINXEOF
server {
    listen 80;
    server_name ${WEB_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:5061;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINXEOF

  ln -sf /etc/nginx/sites-available/shadowpbx /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  log "Nginx configured for ${WEB_DOMAIN}"

  # Attempt SSL with Let's Encrypt
  step "7b/10 - Requesting SSL certificate..."
  apt-get install -y -qq certbot python3-certbot-nginx

  # Verify DNS resolves to this server
  RESOLVED_IP=$(dig +short ${WEB_DOMAIN} 2>/dev/null | tail -1)
  if [ "${RESOLVED_IP}" = "${EXTERNAL_IP}" ]; then
    log "DNS verified: ${WEB_DOMAIN} -> ${RESOLVED_IP}"

    # Request RSA cert (ECDSA not supported by older Drachtio/Sofia)
    if certbot --nginx -d ${WEB_DOMAIN} --cert-name ${WEB_DOMAIN} --key-type rsa \
       --non-interactive --agree-tos --email ${SSL_EMAIL} --redirect 2>/dev/null; then
      log "SSL certificate installed for ${WEB_DOMAIN}"
      SSL_INSTALLED=true

      # Re-write nginx config with proper SSL + WSS proxy
      cat > /etc/nginx/sites-available/shadowpbx << NGINXEOF
server {
    listen 80;
    server_name ${WEB_DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${WEB_DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${WEB_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${WEB_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Web UI + Socket.IO
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # SIP.js WebSocket -> Drachtio WS
    location /ws {
        proxy_pass http://127.0.0.1:5061;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINXEOF
      nginx -t && systemctl reload nginx

      # Copy certs for reference
      mkdir -p ${CERTS_DIR}
      cp /etc/letsencrypt/live/${WEB_DOMAIN}/privkey.pem ${CERTS_DIR}/
      cp /etc/letsencrypt/live/${WEB_DOMAIN}/cert.pem ${CERTS_DIR}/
      cp /etc/letsencrypt/live/${WEB_DOMAIN}/chain.pem ${CERTS_DIR}/
      cp /etc/letsencrypt/live/${WEB_DOMAIN}/fullchain.pem ${CERTS_DIR}/

      log "HTTPS + WSS proxy configured"
    else
      warn "SSL certificate failed — continuing without HTTPS"
      warn "Retry later: certbot --nginx -d ${WEB_DOMAIN} --key-type rsa"
      SSL_INSTALLED=false
    fi
  else
    warn "DNS mismatch: ${WEB_DOMAIN} resolves to ${RESOLVED_IP}, expected ${EXTERNAL_IP}"
    warn "Fix DNS and run: certbot --nginx -d ${WEB_DOMAIN} --key-type rsa"
    SSL_INSTALLED=false
  fi
else
  # No domain — nginx proxies port 80 to port 3000
  cat > /etc/nginx/sites-available/shadowpbx << NGINXEOF
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXEOF

  ln -sf /etc/nginx/sites-available/shadowpbx /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  SSL_INSTALLED=false
  log "Nginx configured (HTTP only — no domain provided)"
  warn "WebRTC phone requires HTTPS. Add a domain later and re-run."
fi

# ============================================================
step "8/10 - Firewall + SIP brute force protection..."
# ============================================================

iptables -F SIP_LIMIT 2>/dev/null || true
iptables -X SIP_LIMIT 2>/dev/null || true

iptables -N SIP_LIMIT 2>/dev/null || true
iptables -A SIP_LIMIT -m recent --name sip_brute --set
iptables -A SIP_LIMIT -m recent --name sip_brute --update --seconds 60 --hitcount 20 -j DROP
iptables -A SIP_LIMIT -j ACCEPT

iptables -I INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -I INPUT -p tcp --dport 22 -j ACCEPT

# HTTP/HTTPS (nginx)
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# SIP through rate limiter
iptables -A INPUT -p udp --dport 5060 -j SIP_LIMIT
iptables -A INPUT -p tcp --dport 5060 -j SIP_LIMIT

# RTP media
iptables -A INPUT -p udp --dport 10000:20000 -j ACCEPT

# API - localhost only (nginx proxies public access)
iptables -A INPUT -p tcp --dport 3000 -s 127.0.0.1 -j ACCEPT

# Block known SIP scanner networks
for BADNET in \
  5.135.0.0/16 \
  45.143.220.0/22 \
  185.7.214.0/24 \
  193.32.162.0/24 \
  194.163.128.0/17 \
  23.137.248.0/24 \
  45.95.147.0/24 \
  ; do
  iptables -I INPUT -s ${BADNET} -j DROP 2>/dev/null || true
done
log "Firewall: known SIP scanner networks pre-blocked"

netfilter-persistent save 2>/dev/null || true
log "Firewall: SIP rate limited (20/min), HTTP/HTTPS open, API localhost-only"

# fail2ban
apt-get install -y -qq fail2ban
mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d

cat > /etc/fail2ban/filter.d/shadowpbx.conf << 'FBEOF'
[Definition]
failregex = REGISTER rejected.*from <HOST>
            REGISTER blocked.*IP <HOST>
            INVITE rejected.*from <HOST>
            GUI: failed login.*from <HOST>
            INBOUND BLOCKED.*from <HOST>
ignoreregex =
FBEOF

cat > /etc/fail2ban/jail.d/shadowpbx.conf << FBEOF
[shadowpbx]
enabled = true
filter = shadowpbx
logpath = ${LOG_DIR}/shadowpbx.log
maxretry = 3
bantime = 86400
findtime = 300
action = iptables-multiport[name=shadowpbx, port="5060,5061,3000", protocol=udp]
         iptables-multiport[name=shadowpbx, port="5060,5061,3000", protocol=tcp]
FBEOF

cat > /etc/fail2ban/jail.d/shadowpbx-recidive.conf << 'FBEOF'
[shadowpbx-recidive]
enabled = true
filter = recidive
logpath = /var/log/fail2ban.log
maxretry = 3
bantime = 604800
findtime = 86400
action = iptables-allports[name=shadowpbx-recidive]
FBEOF

cat > /etc/fail2ban/jail.d/sshd.conf << 'FBEOF'
[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log
maxretry = 3
bantime = 86400
findtime = 600
FBEOF

systemctl enable fail2ban
systemctl restart fail2ban
log "fail2ban: SIP 3 fails = 24hr ban, repeat offenders = 7 day ban"

# ============================================================
step "9/10 - Creating helper scripts..."
# ============================================================
mkdir -p ${APP_DIR}/scripts

# SSL auto-renewal hook
if [ -n "$WEB_DOMAIN" ] && [ "$SSL_INSTALLED" = "true" ]; then
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/shadowpbx.sh << HOOKEOF
#!/bin/bash
cp /etc/letsencrypt/live/${WEB_DOMAIN}/privkey.pem ${CERTS_DIR}/
cp /etc/letsencrypt/live/${WEB_DOMAIN}/cert.pem ${CERTS_DIR}/
cp /etc/letsencrypt/live/${WEB_DOMAIN}/chain.pem ${CERTS_DIR}/
cp /etc/letsencrypt/live/${WEB_DOMAIN}/fullchain.pem ${CERTS_DIR}/
systemctl reload nginx
HOOKEOF
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/shadowpbx.sh
  log "SSL auto-renewal hook created"
fi

# ============================================================
step "10/10 - Starting ShadowPBX and verifying..."
# ============================================================

systemctl start shadowpbx
systemctl start shadowpbx-recorder
sleep 3

echo ""
echo "--- Service Status ---"
echo -n "  MongoDB:    "; systemctl is-active mongod
echo -n "  Docker:     "; systemctl is-active docker
echo -n "  Drachtio:   "; docker ps --format '{{.Status}}' -f name=drachtio 2>/dev/null || echo "not running"
echo -n "  RTPEngine:  "; docker ps --format '{{.Status}}' -f name=rtpengine 2>/dev/null || echo "not running"
echo -n "  Nginx:      "; systemctl is-active nginx
echo -n "  ShadowPBX:  "; systemctl is-active shadowpbx
echo -n "  Recorder:   "; systemctl is-active shadowpbx-recorder
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
SIP Server:       ${EXTERNAL_IP}:5060 (UDP/TCP)
SIP WS:           127.0.0.1:5061 (internal)
SIP Domain:       ${SIP_DOMAIN}
Web URL:          ${WEB_URL}
WSS URL:          ${WSS_URL:-N/A}
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
echo ""
echo -e "  ${BOLD}Web GUI${NC}"
if [ -n "$WEB_DOMAIN" ] && [ "$SSL_INSTALLED" = "true" ]; then
  echo "    URL:      https://${WEB_DOMAIN}"
  echo "    WSS:      wss://${WEB_DOMAIN}/ws (WebRTC)"
else
  echo "    URL:      http://${EXTERNAL_IP}:3000"
  if [ -n "$WEB_DOMAIN" ]; then
    echo "    Note:     SSL failed. Fix DNS and run:"
    echo "              certbot --nginx -d ${WEB_DOMAIN} --key-type rsa"
  fi
fi
echo "    Username: admin"
echo "    Password: ${ADMIN_PASSWORD}"
echo "    Reset:    node ${APP_DIR}/scripts/reset-password.js"
echo ""
echo -e "  ${BOLD}SIP Server${NC}"
echo "    Address:  ${EXTERNAL_IP}:5060 (UDP/TCP)"
echo "    WS:       127.0.0.1:5061 (internal, proxied via nginx)"
echo "    Domain:   ${SIP_DOMAIN}"
echo ""
echo -e "  ${BOLD}Security${NC}"
echo "    SIP rate limit:  20 req/min per IP"
echo "    fail2ban:        3 failed auths = 24hr ban"
echo "    API port 3000:   localhost only (nginx proxies)"
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
if [ -n "$WEB_DOMAIN" ] && [ "$SSL_INSTALLED" = "true" ]; then
  echo -e "  ${BOLD}${GREEN}WebRTC phone ready!${NC} Agents can use the web phone at:"
  echo "    https://${WEB_DOMAIN}"
  echo ""
fi
