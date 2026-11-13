"""Link a Studio voice (IndicF5 trained on someone's recordings) to a voice profile.

    # from the notebook's Kaggle output (asks for the Kaggle API token)
    python -m backend.tools.studio_voice --profile Datta --kaggle harshithreddy05/swaram-studio-voice-abc123
    # or from a file already on the server
    python -m backend.tools.studio_voice --profile Datta --file voice-model-abc123.safetensors
    # stop using it
    python -m backend.tools.studio_voice --profile Datta --remove

The profile keeps its reference clip; IndicF5 uses the trained weights with it.
Set its default engine to IndicF5 to use it everywhere (the tool does this).
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--profile", required=True, help="Voice profile name or id on this server")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--kaggle", help="owner/notebook-slug of the Studio voice training notebook")
    src.add_argument("--file", help="A voice-model-*.safetensors already on this machine")
    src.add_argument("--remove", action="store_true", help="Stop using a Studio voice for this profile")
    args = p.parse_args()

    from backend import config
    from backend.database import get_db, init_db
    from backend.services import studio_voices
    from backend.services.profiles import get_profile_orm_by_name_or_id

    if os.environ.get("VOICEBOX_DATA_DIR"):
        config.set_data_dir(os.environ["VOICEBOX_DATA_DIR"])
    init_db()
    db = next(get_db())
    try:
        profile = get_profile_orm_by_name_or_id(args.profile, db)
        if profile is None:
            sys.exit(f"No voice profile named {args.profile!r} on this server. Create it first (clone the voice).")
        if args.remove:
            studio_voices.unlink(profile.id)
            print(f"{profile.name}: Studio voice removed; IndicF5 uses its normal weights again.")
            return
        if args.kaggle:
            # The token comes from the environment, a pipe (deploy/add-studio-voice.sh,
            # which keeps it out of the process list), or a hidden prompt.
            token = os.environ.get("KAGGLE_API_TOKEN") or (
                sys.stdin.readline().strip() if not sys.stdin.isatty() else getpass.getpass("Kaggle API token (input hidden): ")
            )
            path = studio_voices.fetch_from_kaggle(args.kaggle, token, os.environ.get("KAGGLE_USERNAME"))
        else:
            path = Path(args.file)
        target = studio_voices.link(profile.id, path)
        if profile.default_engine != "indicf5":
            profile.default_engine = "indicf5"
            db.commit()
        print(f"{profile.name}: now uses the Studio voice {target.name} with IndicF5.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
