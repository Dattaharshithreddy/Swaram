#!/usr/bin/env bash
# One-shot setup of Swaram on a fresh Ubuntu GPU server (22.04 or 24.04).
#
#   curl -fsSL https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/main/deploy/setup-gpu-vm.sh | bash
#
# or, from a clone of the repo:
#
#   bash deploy/setup-gpu-vm.sh
#
# What it does:
#   1. Installs Docker and the NVIDIA Container Toolkit if missing.
#   2. Clones the repo to ~/Swaram (unless run from inside a clone).
#   3. Creates .env with a random API key and your Hugging Face token.
#   4. Builds and starts the server plus a Cloudflare https tunnel.
#   5. Downloads IndicF5 and Whisper so the first request is fast.
#   6. Prints the URL and API key to type into the Swaram mobile app.
#
# Safe to run again: it keeps an existing .env and only restarts the stack.

set -euo pipefail

REPO_URL="${SWARAM_REPO_URL:-https://github.com/Dattaharshithreddy/Swaram.git}"
INSTALL_DIR="${SWARAM_DIR:-$HOME/Swaram}"
PREFETCH_MODELS=("indicf5" "whisper-turbo")

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || die "Run as root or install sudo."
    SUDO="sudo"
fi

# --- 0. Sanity checks ---------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "This script is for a Linux (Ubuntu) server."
if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
    die "No working NVIDIA driver found (nvidia-smi failed). Pick a GPU server image with the NVIDIA driver preinstalled, or install the driver first."
fi
say "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

# --- 1. Docker + NVIDIA Container Toolkit -------------------------------------
if ! command -v docker >/dev/null; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | $SUDO sh
fi
if ! $SUDO docker info 2>/dev/null | grep -qi nvidia; then
    say "Installing NVIDIA Container Toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq nvidia-container-toolkit
    $SUDO nvidia-ctk runtime configure --runtime=docker
    $SUDO systemctl restart docker
fi

# --- 2. Code -----------------------------------------------------------------
if [ -f docker-compose.cloud.yml ] && [ -d backend ]; then
    INSTALL_DIR="$(pwd)"
elif [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
else
    say "Cloning Swaram into $INSTALL_DIR"
    command -v git >/dev/null || $SUDO apt-get install -y -qq git
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- 3. .env -----------------------------------------------------------------
if [ ! -f .env ]; then
    say "Creating .env"
    API_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
    HF_TOKEN_VALUE="${HF_TOKEN:-}"
    if [ -z "$HF_TOKEN_VALUE" ] && [ -t 0 ]; then
        echo "IndicF5 needs a Hugging Face token (free)."
        echo "  1) Accept the terms at https://huggingface.co/ai4bharat/IndicF5"
        echo "  2) Create a read token at https://huggingface.co/settings/tokens"
        read -r -p "Paste the token (or press Enter to skip for now): " HF_TOKEN_VALUE
    fi
    umask 077
    cat > .env <<EOF
# Swaram server settings. Keep this file private.
SWARAM_API_KEY=$API_KEY
HF_TOKEN=$HF_TOKEN_VALUE
EOF
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${HF_TOKEN:-}" ] || echo "Note: no HF_TOKEN in .env yet, so IndicF5 cannot download. Add it and re-run."

# --- 4. Start ----------------------------------------------------------------
if [ -n "$SUDO" ]; then
    COMPOSE=(sudo docker compose -f docker-compose.yml -f docker-compose.cloud.yml)
else
    COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.cloud.yml)
fi
say "Building and starting (the first build takes 10-20 minutes)"
"${COMPOSE[@]}" up -d --build

say "Waiting for the server"
for _ in $(seq 1 120); do
    if "${COMPOSE[@]}" exec -T voicebox curl -fsS http://localhost:17493/health >/dev/null 2>&1; then
        break
    fi
    sleep 5
done
"${COMPOSE[@]}" exec -T voicebox curl -fsS http://localhost:17493/health >/dev/null \
    || die "Server did not come up. Check: ${COMPOSE[*]} logs voicebox"

# --- 5. Pre-download models ------------------------------------------------------
if [ -n "${HF_TOKEN:-}" ]; then
    for model in "${PREFETCH_MODELS[@]}"; do
        say "Downloading $model in the background"
        "${COMPOSE[@]}" exec -T voicebox curl -fsS -X POST http://localhost:17493/models/download \
            -H "Authorization: Bearer $SWARAM_API_KEY" -H 'Content-Type: application/json' \
            -d "{\"model_name\": \"$model\"}" >/dev/null || echo "  could not start $model download"
    done
fi

# --- 6. Print connection details -------------------------------------------------
say "Finding the public https URL"
URL=""
for _ in $(seq 1 30); do
    URL="$("${COMPOSE[@]}" logs tunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$URL" ] && break
    sleep 2
done

cat <<EOF

────────────────────────────────────────────────────────────
 Swaram server is running.

 In the Swaram app → Settings, enter:
   Server URL : ${URL:-<not found yet: run '${COMPOSE[*]} logs tunnel'>}
   API key    : $SWARAM_API_KEY

 Model downloads continue in the background (IndicF5 is about 1.5 GB).
 Progress: ${COMPOSE[*]} logs -f voicebox

 Stop the GPU server when you are not using it, to save money.
 The tunnel URL changes after a restart; re-run this script to see it.
────────────────────────────────────────────────────────────
EOF
