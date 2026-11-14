#!/usr/bin/env bash
# Use a Studio voice (IndicF5 trained on your recordings, from the app's
# "Studio voice" on Kaggle) for a voice profile on this server.
#
#   bash deploy/add-studio-voice.sh "Datta" harshithreddy05/swaram-studio-voice-abc123
#
# The second argument is the training notebook as owner/slug (its Kaggle URL
# ends with it). Asks for your Kaggle API token (kaggle.com > Settings > API);
# the token is only used for this download and is not saved.

set -euo pipefail

main() {
    [ $# -eq 2 ] || { echo "Usage: bash deploy/add-studio-voice.sh PROFILE OWNER/NOTEBOOK" >&2; exit 1; }
    local profile="$1" notebook="$2"
    cd "$(dirname "$0")/.."

    local compose=(docker compose -f docker-compose.yml -f docker-compose.cloud.yml)
    [ "$(id -u)" -eq 0 ] || compose=(sudo "${compose[@]}")

    local token="${KAGGLE_API_TOKEN:-}"
    if [ -z "$token" ]; then
        read -r -s -p "Kaggle API token (hidden): " token </dev/tty
        echo
    fi
    [ -n "$token" ] || { echo "No token given." >&2; exit 1; }

    # Piped in, so the token never appears in the process list.
    printf '%s\n' "$token" | "${compose[@]}" exec -T voicebox \
        python -m backend.tools.studio_voice --profile "$profile" --kaggle "$notebook"
    echo "Done. Generate with \"$profile\" (IndicF5) to hear the Studio voice."
}

main "$@"
