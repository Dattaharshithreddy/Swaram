#!/usr/bin/env python3
"""Dub a video from a translated subtitle file, using a running Swaram server.

Examples
--------
Telugu track only (upload to YouTube as an extra audio language):

    python scripts/swaram_dub.py episode14.te.srt --profile "Priya" --language te

Telugu track muxed into the video as a second audio stream (needs ffmpeg):

    python scripts/swaram_dub.py episode14.te.srt --profile "Priya" \\
        --language te --video episode14.mp4

Outputs ``<srt name>.wav`` and ``<srt name>.report.json`` (cues that failed,
were sped up, or still run past their subtitle) next to the subtitle file,
plus ``<video name>.dubbed.mp4`` when ``--video`` is given.

Only standard-library modules are used, so this runs with any Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_SERVER = "http://127.0.0.1:17493"


def _multipart(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
            f'filename="{file_path.name}"\r\nContent-Type: application/x-subrip\r\n\r\n'
        ).encode()
        + file_path.read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def dub(args: argparse.Namespace) -> int:
    srt = Path(args.srt)
    if not srt.is_file():
        print(f"Subtitle file not found: {srt}", file=sys.stderr)
        return 2

    fields = {
        "profile": args.profile,
        "language": args.language,
        "max_speedup": str(args.max_speedup),
        "model_size": args.model_size,
    }
    if args.engine:
        fields["engine"] = args.engine
    if args.seed is not None:
        fields["seed"] = str(args.seed)

    body, content_type = _multipart(fields, "file", srt)
    req = urllib.request.Request(
        args.server.rstrip("/") + "/dub/srt",
        data=body,
        headers={"Content-Type": content_type},
        method="POST",
    )
    print(f"Dubbing {srt.name} with voice '{args.profile}' ({args.language})... this can take a while.")
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            audio = resp.read()
            report = json.loads(resp.headers.get("X-Swaram-Report") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        print(f"Server error {exc.code}: {detail}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Could not reach the server at {args.server}: {exc.reason}. Is Swaram running?", file=sys.stderr)
        return 1

    wav_path = Path(args.out) if args.out else srt.with_suffix(".wav")
    wav_path.write_bytes(audio)
    report_path = wav_path.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Saved {wav_path} ({report.get('duration_seconds', '?')} s, {report.get('cue_count', '?')} cues)")
    if report.get("failed_cues"):
        print(f"  Failed cues (left silent): {report['failed_cues']}")
    if report.get("overflowing_cues"):
        print(f"  Cues still longer than their subtitle (shorten these lines): {report['overflowing_cues']}")
    if report.get("sped_up_cues"):
        print(f"  Cues sped up to fit: {len(report['sped_up_cues'])}")
    print(f"  Report: {report_path}")

    if args.video:
        return mux(Path(args.video), wav_path, args.language, args.replace_audio)
    return 0


# ffmpeg wants ISO 639-2 codes in stream metadata.
ISO639_2 = {
    "en": "eng", "hi": "hin", "te": "tel", "ta": "tam", "kn": "kan", "ml": "mal",
    "mr": "mar", "bn": "ben", "gu": "guj", "or": "ori", "pa": "pan", "as": "asm",
}


def mux(video: Path, wav: Path, language: str, replace: bool) -> int:
    if shutil.which("ffmpeg") is None:
        print("ffmpeg is not installed, so the video was not muxed. The WAV is ready to use.", file=sys.stderr)
        return 1
    if not video.is_file():
        print(f"Video not found: {video}", file=sys.stderr)
        return 2
    out = video.with_name(video.stem + ".dubbed" + video.suffix)
    lang = ISO639_2.get(language, "und")
    if replace:
        cmd = [
            "ffmpeg", "-y", "-i", str(video), "-i", str(wav),
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-metadata:s:a:0", f"language={lang}", "-shortest", str(out),
        ]
    else:
        # Keep the original audio as track 1 and add the dub as track 2.
        cmd = [
            "ffmpeg", "-y", "-i", str(video), "-i", str(wav),
            "-map", "0:v", "-map", "0:a?", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-metadata:s:a:1", f"language={lang}", str(out),
        ]
    print("Muxing:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode == 0:
        print(f"Saved {out}")
    return result.returncode


def main() -> int:
    p = argparse.ArgumentParser(description="Dub a video from a translated .srt using a Swaram voice profile.")
    p.add_argument("srt", help="Translated subtitle file (.srt, UTF-8)")
    p.add_argument("--profile", required=True, help="Voice profile name or id")
    p.add_argument("--language", default="te", choices=sorted(ISO639_2), help="Target language (default: te)")
    p.add_argument("--engine", help="TTS engine, e.g. indicf5 (default: the profile's engine)")
    p.add_argument("--model-size", default="default")
    p.add_argument("--max-speedup", type=float, default=1.25, help="Most a line may be sped up to fit (1.0-1.6)")
    p.add_argument("--seed", type=int)
    p.add_argument("--video", help="Also mux the dub into this video with ffmpeg")
    p.add_argument("--replace-audio", action="store_true", help="With --video: replace the original audio instead of adding a track")
    p.add_argument("--out", help="Output WAV path (default: next to the .srt)")
    p.add_argument("--server", default=DEFAULT_SERVER)
    p.add_argument("--timeout", type=float, default=3600, help="Seconds to wait for the server")
    return dub(p.parse_args())


if __name__ == "__main__":
    sys.exit(main())
