import re
from typing import Any

VOICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,47}$")
MODEL_KEY_RE = re.compile(r"^models/voices/[A-Za-z0-9._/-]+\.pth$")
INDEX_KEY_RE = re.compile(r"^models/voices/[A-Za-z0-9._/-]+\.index$")


def validate_voice_entry(voice: Any) -> bool:
    if not isinstance(voice, dict):
        return False
    rights = voice.get("rights") or {}
    model_key = str(voice.get("model_key", ""))
    index_key = str(voice.get("index_key", "") or "")
    model_safe = MODEL_KEY_RE.fullmatch(model_key) and all(part not in ("", ".", "..") for part in model_key.split("/"))
    index_safe = not index_key or (INDEX_KEY_RE.fullmatch(index_key) and all(part not in ("", ".", "..") for part in index_key.split("/")))
    try:
        pitch = int(voice.get("pitch", 0))
        speaker_id = int(voice.get("speaker_id", 0))
        index_rate = float(voice.get("index_rate", 0.65))
    except (TypeError, ValueError):
        return False
    return bool(
        VOICE_ID_RE.fullmatch(str(voice.get("id", "")))
        and model_safe
        and index_safe
        and 1 <= len(str(voice.get("name", "")).strip()) <= 50
        and voice.get("enabled") is True
        and -12 <= pitch <= 12
        and 0 <= speaker_id <= 109
        and 0 <= index_rate <= 1
        and str(voice.get("f0_method", "rmvpe")) in ("rmvpe", "pm")
        and isinstance(rights, dict)
        and rights.get("voice_owner_consent") is True
        and str(rights.get("rights_holder", "")).strip()
        and str(rights.get("license", "")).strip()
        and str(rights.get("authorization_reference", "")).strip()
    )


def safe_relative_key(value: str, pattern: re.Pattern[str]) -> bool:
    if not pattern.fullmatch(value):
        return False
    parts = value.split("/")
    return all(part not in ("", ".", "..") for part in parts)
