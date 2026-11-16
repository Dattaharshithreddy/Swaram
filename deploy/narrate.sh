#!/usr/bin/env bash
# Narrate a script in a saved voice on this server and print the result.
#
#   bash deploy/narrate.sh "Datta" script.txt            # natural length
#   bash deploy/narrate.sh "Datta" script.txt 50         # fit to 50 seconds
#   bash deploy/narrate.sh "Datta" script.txt 50 'https://...presigned PUT URL'
#
# script.txt has one sentence per line, with optional marks:
#   (fear, slow) ఇల్లంతా చీకటి. [pause 1]
# See deploy/NARRATE.md. Prints the server's JSON reply (duration and each
# line's start/end time) and the path of the WAV; with a fourth argument it
# also uploads the WAV to that URL.

set -euo pipefail

main() {
    [ $# -ge 2 ] || { echo "Usage: bash deploy/narrate.sh VOICE SCRIPT_FILE [SECONDS] [UPLOAD_URL]" >&2; exit 1; }
    local voice="$1" script_file="$2" seconds="${3:-}" upload="${4:-}"
    [ -f "$script_file" ] || { echo "No such file: $script_file" >&2; exit 1; }
    script_file="$(realpath "$script_file")"
    cd "$(dirname "$0")/.."

    local key
    key="$(grep -m1 '^SWARAM_API_KEY=' .env | cut -d= -f2-)"
    local port="${SWARAM_PORT:-17493}"

    echo "Waiting for the server..." >&2
    local i
    for i in $(seq 1 90); do
        curl -sf -o /dev/null "http://localhost:$port/health" && break
        [ "$i" -lt 90 ] || { echo "The server did not come up. Check: docker compose logs voicebox" >&2; exit 1; }
        sleep 4
    done

    local body reply
    body="$(mktemp)" reply="$(mktemp)"
    trap "rm -f '$body' '$reply'" EXIT  # expanded now: the names are local to main
    VOICE="$voice" SECONDS_TARGET="$seconds" python3 - "$script_file" > "$body" <<'PY'
import json, os, sys
req = {"profile": os.environ["VOICE"], "script": open(sys.argv[1], encoding="utf-8").read()}
if os.environ.get("SECONDS_TARGET"):
    req["target_seconds"] = float(os.environ["SECONDS_TARGET"])
print(json.dumps(req, ensure_ascii=False))
PY

    # The key goes in a header file, not on the command line.
    local status
    status="$(curl -sS -m 1800 -o "$reply" -w '%{http_code}' -X POST "http://localhost:$port/indic/narrate" \
        -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$key") --data-binary "@$body")"
    cat "$reply"; echo
    [ "$status" = 200 ] || { echo "Narration failed (HTTP $status)." >&2; exit 1; }

    local name wav
    name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["audio_url"].rsplit("/",1)[1])' "$reply")"
    wav="$PWD/output/narrations/$name"
    echo "WAV: $wav"
    if [ -n "$upload" ]; then
        curl -sS -f -X PUT -T "$wav" "$upload" && echo "Uploaded."
    fi
}

main "$@"
