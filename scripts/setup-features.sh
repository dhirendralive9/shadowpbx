#!/bin/bash
#
# ShadowPBX - Post-Install Setup for v2.0 Features
# Run as root after initial install
#
# Sets up: Voicemail, MOH, Call Park, Recording directories,
#          generates beep tone, configures .env for all features
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

APP_DIR="/opt/shadowpbx"
ENV_FILE="${APP_DIR}/.env"
AUDIO_DIR="${APP_DIR}/audio"
VM_DIR="/var/lib/shadowpbx/voicemail"
VM_GREETINGS_DIR="${VM_DIR}/greetings"
REC_DIR="/var/lib/shadowpbx/recordings"
RTPENGINE_REC_DIR="${REC_DIR}"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR]${NC} Run as root: sudo bash $0"
  exit 1
fi

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  ShadowPBX v2.0 - Feature Setup${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

# ============================================================
step "1/6 - Creating directories..."
# ============================================================
mkdir -p "${AUDIO_DIR}"
mkdir -p "${VM_DIR}"
mkdir -p "${VM_GREETINGS_DIR}"
mkdir -p "${REC_DIR}/pcaps"
mkdir -p "${REC_DIR}/wav"
mkdir -p "${REC_DIR}/tmp"

# RTPEngine recording directory (must match --recording-dir)
mkdir -p "${RTPENGINE_REC_DIR}/pcap"
mkdir -p "${RTPENGINE_REC_DIR}/metadata"
chmod -R 777 "${RTPENGINE_REC_DIR}"

log "Directories created:"
echo "    Audio:       ${AUDIO_DIR}"
echo "    Voicemail:   ${VM_DIR}"
echo "    Greetings:   ${VM_GREETINGS_DIR}"
echo "    Recordings:  ${REC_DIR}"

# ============================================================
step "2/6 - Generating audio files..."
# ============================================================

# Check if sox is installed
if ! command -v sox &> /dev/null; then
  echo "  Installing sox for audio generation..."
  apt-get install -y -qq sox libsox-fmt-all 2>/dev/null || apt-get install -y -qq sox 2>/dev/null
fi

# Generate beep tone (0.5s 1000Hz sine wave, 8kHz mono u-law)
if [ ! -f "${AUDIO_DIR}/beep.wav" ] || [ ! -s "${AUDIO_DIR}/beep.wav" ]; then
  if command -v sox &> /dev/null; then
    sox -n -r 8000 -c 1 -e mu-law "${AUDIO_DIR}/beep.wav" synth 0.5 sine 1000 2>/dev/null
    log "Beep tone generated: ${AUDIO_DIR}/beep.wav"
  else
    warn "sox not available — beep.wav not generated"
  fi
else
  log "Beep tone already exists: ${AUDIO_DIR}/beep.wav"
fi

# Generate default VM greeting (3s tone sequence as placeholder)
if [ ! -f "${AUDIO_DIR}/vm-greeting.wav" ] || [ ! -s "${AUDIO_DIR}/vm-greeting.wav" ]; then
  if command -v sox &> /dev/null; then
    sox -n -r 8000 -c 1 -e mu-law "${AUDIO_DIR}/vm-greeting.wav" \
      synth 0.3 sine 600 : synth 0.1 silence : \
      synth 0.3 sine 800 : synth 0.1 silence : \
      synth 0.3 sine 1000 : synth 0.5 silence 2>/dev/null
    log "Default VM greeting generated: ${AUDIO_DIR}/vm-greeting.wav"
    echo -e "    ${YELLOW}TIP: Replace with a real greeting recording later${NC}"
  else
    warn "sox not available — vm-greeting.wav not generated"
  fi
else
  log "VM greeting already exists: ${AUDIO_DIR}/vm-greeting.wav"
fi

# Generate default MOH if missing
if [ ! -f "${AUDIO_DIR}/hold-music.wav" ] || [ ! -s "${AUDIO_DIR}/hold-music.wav" ]; then
  if command -v sox &> /dev/null; then
    # Generate a simple ambient tone loop as placeholder MOH
    sox -n -r 8000 -c 1 -e mu-law "${AUDIO_DIR}/hold-music.wav" \
      synth 30 sine 440:880 tremolo 0.5 50 fade t 0.5 30 0.5 2>/dev/null
    log "Placeholder MOH generated: ${AUDIO_DIR}/hold-music.wav"
    echo -e "    ${YELLOW}TIP: Replace with real hold music later${NC}"
  else
    warn "sox not available — hold-music.wav not generated"
  fi
else
  log "Hold music already exists: ${AUDIO_DIR}/hold-music.wav"
fi

# ============================================================
step "3/6 - Updating .env configuration..."
# ============================================================

# Function to add env var if not already present
add_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    # Update existing value
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    echo "    Updated: ${key}=${value}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
    echo "    Added:   ${key}=${value}"
  fi
}

echo ""
add_env "MOH_DIR" "${AUDIO_DIR}"
add_env "VM_BEEP_FILE" "/audio/beep.wav"
add_env "VM_DEFAULT_GREETING" "/audio/vm-greeting.wav"
add_env "VM_MAX_MESSAGE_LENGTH" "120"
add_env "VOICEMAIL_DIR" "${VM_DIR}"
add_env "RECORDINGS_DIR" "${REC_DIR}"
add_env "PARK_SLOT_MIN" "70"
add_env "PARK_SLOT_MAX" "79"
echo ""
log ".env updated with all feature configs"
log "Note: VM_BEEP_FILE and VM_DEFAULT_GREETING use Docker container paths (/audio/)"

# ============================================================
step "4/6 - Verifying RTPEngine Docker mounts..."
# ============================================================

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q rtpengine; then
  MOUNTS=$(docker inspect rtpengine --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null)
  HAS_AUDIO=$(echo "${MOUNTS}" | grep -c "/audio")
  HAS_VM=$(echo "${MOUNTS}" | grep -c "/voicemail")
  HAS_REC=$(echo "${MOUNTS}" | grep -c "/recordings")

  if [ "${HAS_AUDIO}" -gt 0 ] && [ "${HAS_VM}" -gt 0 ] && [ "${HAS_REC}" -gt 0 ]; then
    log "RTPEngine Docker mounts OK: /audio /voicemail /recordings"
  else
    warn "RTPEngine is missing mounts. Run install-drachtio.sh or recreate manually:"
    echo ""
    echo "    docker stop rtpengine && docker rm rtpengine"
    echo "    EXTERNAL_IP=\$(curl -4 -s ifconfig.me)"
    echo "    docker run -d --name rtpengine --restart unless-stopped --net host \\"
    echo "      -v /var/lib/shadowpbx/recordings:/recordings \\"
    echo "      -v /opt/shadowpbx/audio:/audio:ro \\"
    echo "      -v /var/lib/shadowpbx/voicemail:/voicemail \\"
    echo "      --entrypoint /usr/local/bin/rtpengine \\"
    echo "      jambonz/rtpengine:latest \\"
    echo "      --interface=\"\${EXTERNAL_IP}\" --listen-ng=127.0.0.1:22222 \\"
    echo "      --port-min=10000 --port-max=20000 \\"
    echo "      --recording-dir=/recordings --recording-method=pcap \\"
    echo "      --recording-format=eth --dtmf-log-dest=127.0.0.1:22223 \\"
    echo "      --log-level=4 --log-stderr --foreground --delete-delay=0"
    echo ""
  fi

  # Ensure recording dirs are writable
  mkdir -p "${RTPENGINE_REC_DIR}/pcap" "${RTPENGINE_REC_DIR}/metadata" 2>/dev/null
  chmod -R 777 "${RTPENGINE_REC_DIR}" 2>/dev/null
else
  warn "RTPEngine not running. Run install-drachtio.sh to set it up."
fi

# ============================================================
step "5/6 - Verifying audio files..."
# ============================================================
echo ""

verify_audio() {
  local file="$1"
  local name="$2"
  if [ -f "${file}" ] && [ -s "${file}" ]; then
    local size=$(du -h "${file}" | cut -f1)
    echo -e "    ${GREEN}✓${NC} ${name}: ${file} (${size})"
  else
    echo -e "    ${RED}✗${NC} ${name}: ${file} — MISSING or EMPTY"
  fi
}

verify_audio "${AUDIO_DIR}/beep.wav" "Beep tone"
verify_audio "${AUDIO_DIR}/vm-greeting.wav" "VM greeting"
verify_audio "${AUDIO_DIR}/hold-music.wav" "Hold music"
echo ""

# ============================================================
step "6/6 - Restarting ShadowPBX..."
# ============================================================
systemctl restart shadowpbx
sleep 2

if systemctl is-active --quiet shadowpbx; then
  log "ShadowPBX restarted successfully"
else
  warn "ShadowPBX may have failed to start — check: journalctl -u shadowpbx -n 20"
fi

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  Setup Complete!${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  Features configured:"
echo "    ✓ Voicemail (greeting + beep + recording)"
echo "    ✓ Music on Hold"
echo "    ✓ Call Park (slots 70-79)"
echo "    ✓ Call Transfer (API + SIP REFER)"
echo "    ✓ Call Hold/Resume"
echo ""
echo "  Audio files: ${AUDIO_DIR}/"
echo "  Voicemail:   ${VM_DIR}/"
echo "  Recordings:  ${REC_DIR}/"
echo ""
echo "  To customize:"
echo "    Replace ${AUDIO_DIR}/vm-greeting.wav with a real greeting"
echo "    Replace ${AUDIO_DIR}/hold-music.wav with real hold music"
echo "    Per-extension greetings: ${VM_GREETINGS_DIR}/2001.wav"
echo ""
echo "  Format for all audio: 8kHz, mono, µ-law WAV"
echo "    Convert: sox input.mp3 -r 8000 -c 1 -e mu-law output.wav"
echo ""
