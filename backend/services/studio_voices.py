"""Studio voices: IndicF5 trained on one person's recordings (cloud/finetune.py).

The phone app trains them on Kaggle ("Studio voice"); the result is a
``voice-model-<id>.safetensors`` with the fine-tuned transformer weights.
Linking one to a voice profile makes IndicF5 use those weights for that
profile, so it sounds like the person rather than an imitation from one clip.

    python -m backend.tools.studio_voice --profile Datta --kaggle OWNER/NOTEBOOK

The link lives in ``<data dir>/studio_voices/index.json``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

from .. import config

logger = logging.getLogger(__name__)

_lock = threading.Lock()
KAGGLE_API = "https://api.kaggle.com/v1"


def _dir() -> Path:
    d = Path(config.get_data_dir()) / "studio_voices"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path() -> Path:
    return _dir() / "index.json"


def _read() -> dict[str, str]:
    p = _index_path()
    try:
        return json.loads(p.read_text("utf-8")) if p.exists() else {}
    except (OSError, ValueError):
        logger.warning("Ignoring unreadable %s", p)
        return {}


def checkpoint_for(profile_id: str) -> Path | None:
    """The Studio voice weights linked to a profile, if any (and still on disk)."""
    name = _read().get(profile_id)
    if not name:
        return None
    path = _dir() / name
    return path if path.is_file() else None


def link(profile_id: str, checkpoint: Path) -> Path:
    """Copy (or keep) the weights in the store and link them to the profile."""
    checkpoint = Path(checkpoint)
    if not checkpoint.is_file() or checkpoint.suffix != ".safetensors":
        raise ValueError(f"Not a .safetensors file: {checkpoint}")
    target = _dir() / checkpoint.name
    if checkpoint.resolve() != target.resolve():
        import shutil

        shutil.copyfile(checkpoint, target)
    with _lock:
        data = _read()
        data[profile_id] = target.name
        _index_path().write_text(json.dumps(data, indent=1), "utf-8")
    return target


def unlink(profile_id: str) -> None:
    with _lock:
        data = _read()
        if data.pop(profile_id, None) is not None:
            _index_path().write_text(json.dumps(data, indent=1), "utf-8")


def _kaggle_headers(token: str, username: str | None) -> dict[str, str]:
    """API tokens use Bearer; legacy kaggle.json keys (32 hex chars) use Basic."""
    import base64
    import re

    token = token.strip()
    if re.fullmatch(r"[0-9a-fA-F]{32}", token):
        if not username:
            raise ValueError("A legacy kaggle.json key also needs the Kaggle username.")
        raw = base64.b64encode(f"{username}:{token}".encode()).decode()
        return {"Authorization": f"Basic {raw}", "Content-Type": "application/json"}
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def fetch_from_kaggle(notebook: str, token: str, username: str | None = None, dest: Path | None = None) -> Path:
    """Download the voice-model-*.safetensors a Studio voice notebook produced.

    ``notebook`` is ``owner/slug`` as shown in the notebook's Kaggle URL.
    """
    import urllib.request

    owner, _, slug = notebook.strip().strip("/").partition("/")
    if not owner or not slug:
        raise ValueError("Give the notebook as owner/slug, e.g. harshithreddy05/swaram-studio-voice-abc123")
    headers = _kaggle_headers(token, username or owner)
    body = json.dumps({"userName": owner, "kernelSlug": slug, "pageSize": 100}).encode()
    req = urllib.request.Request(
        f"{KAGGLE_API}/kernels.KernelsApiService/ListKernelSessionOutput", data=body, headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        files = json.loads(r.read().decode()).get("files", [])
    models = [f for f in files if f.get("fileName", "").endswith(".safetensors")]
    if not models:
        raise RuntimeError(f"No Studio voice model in the output of {notebook}. Did its training finish?")
    url, name = models[0]["url"], os.path.basename(models[0]["fileName"])
    dest = Path(dest or _dir())
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / name
    tmp = target.with_suffix(".part")
    logger.info("Downloading %s from Kaggle", name)
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as out:
        while chunk := r.read(1 << 20):
            out.write(chunk)
    tmp.replace(target)
    return target
