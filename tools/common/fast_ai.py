"""Shared utility-model adapter for the lightweight ingestion AI steps.

The fast/simple actions — customer alias generation and weak-link verification —
use the model assigned to SE Assist's explicit utility role via the connected GitHub
Copilot API and nothing else. The desktop app already holds a Copilot bearer token, so
it passes the token + endpoint + resolved model down to these Python subprocesses:

    SEASSIST_COPILOT_TOKEN  short-lived Copilot bearer (from copilot-provider)
    SEASSIST_COPILOT_API    API base, e.g. https://api.githubcopilot.com
    SEASSIST_FAST_MODEL     resolved utility-model id

When those are absent (Copilot not connected in Settings) or a call fails, there is NO
alternate model — the AI step is skipped and the run continues in a degraded state on
the deterministic exact-name baseline (see ai_aliases). The degraded state is surfaced
loudly in each step's summary (model_available / ai_error) and by the desktop
orchestrator, never silently substituted.

The larger, user-selectable report features are unaffected: they keep going through
the desktop copilot-provider with the user's chosen model.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_FAST_MODEL = "claude-haiku-4.5"
_TIMEOUT_S = 60
_UA = "SE-Assist/1.0"


def copilot_config() -> tuple[str, str, str] | None:
    """(token, api_base, model) from env, or None when the Copilot fast path isn't wired."""
    token = (os.environ.get("SEASSIST_COPILOT_TOKEN") or "").strip()
    api = (os.environ.get("SEASSIST_COPILOT_API") or "").strip()
    if not token or not api:
        return None
    model = (os.environ.get("SEASSIST_FAST_MODEL") or "").strip() or DEFAULT_FAST_MODEL
    return token, api.rstrip("/"), model


def copilot_available() -> bool:
    """True when the desktop app has handed us a usable Copilot token + endpoint."""
    return copilot_config() is not None


def fast_model_label() -> str | None:
    """The Copilot fast-model id if wired, else None (Copilot is the only model)."""
    cfg = copilot_config()
    return cfg[2] if cfg else None


def _post(api: str, token: str, body: dict) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{api}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
            "Editor-Version": _UA,
            "Editor-Plugin-Version": _UA,
            "Copilot-Integration-Id": os.environ.get(
                "SEASSIST_COPILOT_INTEGRATION_ID", "vscode-chat"
            ),
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:  # 4xx/5xx carry a readable body
        try:
            return e.code, e.read().decode("utf-8")
        except Exception:  # noqa: BLE001 - body may be unreadable
            return e.code, ""
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return 0, ""


def copilot_chat(
    system_prompt: str,
    user_prompt: str,
    *,
    max_tokens: int,
    temperature: float = 0.0,
) -> str | None:
    """Call the Copilot chat/completions API with the fast model.

    Returns the assistant message text, or None on any failure (so callers treat it as
    a transient miss and their resilience logic skips/retries rather than caching junk).
    """
    cfg = copilot_config()
    if cfg is None:
        return None
    token, api, model = cfg
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }

    # Adapt once to the two common model-specific parameter constraints, mirroring the
    # desktop copilot-provider: some models reject `temperature` and/or require
    # `max_completion_tokens` instead of `max_tokens`.
    for _ in range(3):
        status, text = _post(api, token, body)
        if status == 200:
            try:
                content = json.loads(text)["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError, ValueError):
                return None
            if not isinstance(content, str) or not content.strip():
                return None
            return content.strip()
        if status != 400:
            return None
        low = text.lower()
        adapted = False
        if "'max_tokens'" in low and "max_completion_tokens" in low and "max_tokens" in body:
            body["max_completion_tokens"] = body.pop("max_tokens")
            adapted = True
        elif "'max_completion_tokens'" in low and "max_tokens" in low and "max_completion_tokens" in body:
            body["max_tokens"] = body.pop("max_completion_tokens")
            adapted = True
        if "temperature" in low and "temperature" in body:
            del body["temperature"]
            adapted = True
        if not adapted:
            return None
    return None
