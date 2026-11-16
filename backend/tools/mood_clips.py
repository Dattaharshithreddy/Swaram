"""Give a voice profile mood clips, so swaram_narrate can speak it with expression.

    # a folder with fear.wav, happy.wav, ... and texts.json ({"fear": "what the clip says", ...})
    python -m backend.tools.mood_clips --profile Datta --dir /app/data/emo_refs/datta
    python -m backend.tools.mood_clips --profile Datta --list
    python -m backend.tools.mood_clips --profile Datta --remove

Moods: story, talk, happy, sad, fear, surprise, anger, disgust. Each clip is
5-12 seconds of the voice speaking in that mood, with its exact transcript.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--profile", required=True, help="Voice profile name or id on this server")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", help="Folder with <mood>.wav files and texts.json")
    src.add_argument("--list", action="store_true", help="Show the moods this profile has")
    src.add_argument("--remove", action="store_true", help="Delete this profile's mood clips")
    args = p.parse_args()

    from backend import config
    from backend.database import get_db, init_db
    from backend.services import narration
    from backend.services.profiles import get_profile_orm_by_name_or_id

    if os.environ.get("VOICEBOX_DATA_DIR"):
        config.set_data_dir(os.environ["VOICEBOX_DATA_DIR"])
    init_db()
    db = next(get_db())
    try:
        profile = get_profile_orm_by_name_or_id(args.profile, db)
        if profile is None:
            sys.exit(f"No voice profile named {args.profile!r} on this server.")
        if args.remove:
            narration.remove_mood_clips(profile.id)
            print(f"{profile.name}: mood clips removed.")
        elif args.dir:
            try:
                moods = narration.install_mood_clips(profile.id, Path(args.dir))
            except ValueError as exc:
                sys.exit(str(exc))
            print(f"{profile.name}: moods ready: {', '.join(moods) or 'none'}")
        else:
            print(f"{profile.name}: {', '.join(sorted(narration.mood_clips(profile.id))) or 'no mood clips'}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
