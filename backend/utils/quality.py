"""Speed / quality preset shared by the flow-matching engines (IndicF5, DhVaani).

One of ``fast`` | ``balanced`` | ``studio``. Read from
``SWARAM_QUALITY`` at start-up (default ``balanced``) and changeable at run
time through ``PUT /indic/quality`` or the ``swaram_set_quality`` MCP tool.
Each engine maps the preset to its own step count.
"""

from __future__ import annotations

import os
import threading

PRESETS = ("fast", "balanced", "studio")
DEFAULT = "balanced"

_lock = threading.Lock()
_current: str | None = None


def get_quality() -> str:
    with _lock:
        if _current is not None:
            return _current
    env = (os.environ.get("SWARAM_QUALITY") or os.environ.get("SWARAM_INDICF5_QUALITY") or DEFAULT).strip().lower()
    return env if env in PRESETS else DEFAULT


def set_quality(value: str) -> str:
    value = (value or "").strip().lower()
    if value not in PRESETS:
        raise ValueError(f"Quality must be one of {', '.join(PRESETS)}")
    global _current
    with _lock:
        _current = value
    return value
