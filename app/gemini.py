"""The one way to reach models/gemini-3.1-flash-live-preview — ported from
src/lib/gemini.ts to Python `websockets`.

That model declares only bidiGenerateContent (no REST generateContent) and is
audio-native: it refuses a TEXT response modality outright (close 1007). The
route that works, verified against the live endpoint, is to ask for AUDIO and
switch on the Live API's own output transcription — the transcript IS the text,
and on a JSON turn the model skips speaking entirely so the audio costs nothing.
Everything here makes that one WebSocket exchange look like a function call:
open, set up, send one turn, collect the transcript until generation is
complete, close.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Callable, Optional

try:
    import websockets
    from websockets.exceptions import ConnectionClosed

    _HAVE_WS = True
except Exception:  # pragma: no cover - websockets is a hard dependency
    _HAVE_WS = False


# Pinned, deliberately, to the single model this project is required to use.
GEMINI_MODEL = "models/gemini-3.1-flash-live-preview"

# The four documented spellings first, then a scan for a key that is
# unmistakably Google-shaped.
KEY_NAMES = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_AI_API_KEY",
]

# AQ. + ~50 chars (AI Studio now) or AIza + 35 (older, and Firebase).
KEY_SHAPE = re.compile(r"^(AQ\.[\w.-]{20,}|AIza[\w-]{30,})$")

_warned_about_name = False


def geminiKey() -> Optional[str]:
    global _warned_about_name

    for name in KEY_NAMES:
        value = os.environ.get(name)
        value = value.strip() if value else ""
        if value:
            return value

    # Never Firebase, never NEXT_PUBLIC — a browser-visible key is by definition
    # not the one guarding a paid model.
    candidates = [n for n in os.environ.keys() if not re.search(r"firebase|next_public", n, re.I)]
    candidates.sort()
    _google = re.compile(r"gemini|google|ai.?studio", re.I)
    # Names mentioning Google/Gemini tried first (stable).
    candidates.sort(key=lambda n: 0 if _google.search(n) else 1)

    for name in candidates:
        value = os.environ.get(name)
        value = value.strip() if value else ""
        if value and KEY_SHAPE.match(value):
            if not _warned_about_name:
                _warned_about_name = True
                print(
                    f"[FinGuard] AI key found in {name}, which is not a name this reads by default. "
                    "It works, but rename it to GEMINI_API_KEY so the next person does not have to find this line."
                )
            return value

    if not _warned_about_name:
        _warned_about_name = True
        seen = [n for n in os.environ.keys() if re.search(r"gemini|google|ai.?studio|api.?key", n, re.I)]
        print(
            f"[FinGuard] no AI key found. Env names that looked related: {', '.join(seen) or '(none)'}. "
            "Set GEMINI_API_KEY."
        )
    return None


_HOST = "generativelanguage.googleapis.com"
_SERVICE = "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

# Hard ceiling on one exchange, well inside the handler's 60 seconds.
TURN_TIMEOUT_MS = 45_000

# How long to keep listening after generationComplete. The answer is complete at
# generationComplete; turnComplete comes ~11s later, waiting out a playback clock
# this console never uses. 400ms covers a trailing transcription chunk, and any
# chunk that does arrive re-arms the window rather than being cut off.
SETTLE_GRACE_MS = 400


def _is_quota(detail: str) -> bool:
    return bool(re.search(r"RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|exceeded", detail, re.I))


def _is_daily(detail: str) -> bool:
    return bool(re.search(r"per day|daily|PerDay|RequestsPerDay", detail, re.I))


def _retry_delay_ms(detail: str) -> int:
    m = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', detail) or re.search(r"retry in ([\d.]+)\s*s", detail, re.I)
    return min(int(float(m.group(1)) * 1000), 30_000) if m else 0


def _frame_text(data) -> str:
    if isinstance(data, str):
        return data
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data).decode("utf-8", "replace")
    return ""


async def askGemini(
    *,
    apiKey: str,
    system: str,
    turns: list[dict],
    temperature: float,
    maxOutputTokens: int,
    validate: Optional[Callable[[str], bool]] = None,
) -> dict:
    """One exchange with the pinned model. No retrying — the caller decides.

    Returns, on success: {"ok": True, "text", "model", "usage"}.
    On failure: {"ok": False, "status", "detail", "rateLimited", "daily",
    "retryMs", "usage"} — where status is the WebSocket close code, or 0 when the
    socket never opened.
    """
    usage: Optional[dict] = None

    def fail(status: int, detail: str) -> dict:
        q = _is_quota(detail)
        return {
            "ok": False,
            "status": status,
            "detail": detail[:400],
            "rateLimited": q,
            "daily": q and _is_daily(detail),
            "retryMs": _retry_delay_ms(detail),
            "usage": usage,
        }

    if not _HAVE_WS:
        return fail(0, "no WebSocket implementation available in this runtime (websockets not importable)")

    url = f"wss://{_HOST}/ws/{_SERVICE}?key={apiKey}"

    try:
        ws = await websockets.connect(url, max_size=None, ping_interval=None)
    except Exception as err:  # handshake failure — 401/429/network
        status = getattr(err, "status_code", 0) or getattr(err, "code", 0) or 0
        return fail(int(status) if isinstance(status, int) else 0, str(err))

    chunks: list[str] = []
    grace_active = False
    deadline = time.monotonic() + TURN_TIMEOUT_MS / 1000

    def settle_with_text() -> dict:
        text = "".join(chunks).strip()
        if not text:
            return fail(0, "the model returned an empty transcript")
        if validate and not validate(text):
            return fail(422, f"unusable answer ({len(text)} chars)")
        return {"ok": True, "text": text, "model": GEMINI_MODEL, "usage": usage}

    try:
        # Open the session.
        await ws.send(
            json.dumps(
                {
                    "setup": {
                        "model": GEMINI_MODEL,
                        "generationConfig": {
                            # AUDIO is the only modality this model accepts; the
                            # words come from outputAudioTranscription below.
                            "responseModalities": ["AUDIO"],
                            "temperature": temperature,
                            "maxOutputTokens": maxOutputTokens,
                        },
                        "outputAudioTranscription": {},
                        "systemInstruction": {"parts": [{"text": system}]},
                    }
                }
            )
        )

        while True:
            now = time.monotonic()
            if grace_active:
                # Wait one short window for a trailing chunk, bounded by the turn
                # deadline so a stream that never stops still settles.
                remaining = deadline - now
                if remaining <= 0:
                    return settle_with_text()
                recv_timeout = min(SETTLE_GRACE_MS / 1000, remaining)
            else:
                recv_timeout = deadline - now
                if recv_timeout <= 0:
                    # Overall turn timeout. Partial text beats nothing.
                    if chunks:
                        return settle_with_text()
                    return fail(408, f"no complete turn within {TURN_TIMEOUT_MS}ms")

            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
            except asyncio.TimeoutError:
                if grace_active:
                    return settle_with_text()
                if chunks:
                    return settle_with_text()
                return fail(408, f"no complete turn within {TURN_TIMEOUT_MS}ms")
            except ConnectionClosed:
                if chunks:
                    return settle_with_text()
                code = getattr(ws, "close_code", None) or 1006
                reason = getattr(ws, "close_reason", None) or "(no reason given)"
                return fail(code, f"socket closed {code}: {reason}")

            try:
                msg = json.loads(_frame_text(raw))
            except (ValueError, TypeError):
                continue

            # Session is live; send the conversation as one turn batch.
            if msg.get("setupComplete"):
                await ws.send(
                    json.dumps(
                        {
                            "clientContent": {
                                "turns": [{"role": t["role"], "parts": [{"text": t["text"]}]} for t in turns],
                                "turnComplete": True,
                            }
                        }
                    )
                )
                continue

            if msg.get("usageMetadata"):
                um = msg["usageMetadata"]
                usage = {
                    "promptTokens": int(um.get("promptTokenCount") or 0),
                    "totalTokens": int(um.get("totalTokenCount") or 0),
                }

            if msg.get("error"):
                err = msg["error"]
                code = 0
                try:
                    code = int(err.get("code") or 0)
                except (TypeError, ValueError):
                    code = 0
                return fail(code or 500, json.dumps(err))

            # Google's warning that it is about to hang up.
            if msg.get("goAway"):
                if chunks:
                    return settle_with_text()
                return fail(503, json.dumps(msg["goAway"]))

            sc = msg.get("serverContent")
            if not sc:
                continue

            ot = sc.get("outputTranscription")
            if ot and ot.get("text"):
                chunks.append(ot["text"])
                # Re-arm handled implicitly: the loop recomputes the grace
                # window from now, pushing the settle out as long as text flows.

            # Belt and braces: take direct text parts too if a future revision
            # returns them.
            model_turn = sc.get("modelTurn") or {}
            for part in model_turn.get("parts", []) or []:
                if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"]:
                    chunks.append(part["text"])

            # The answer is complete here; turnComplete comes later.
            if sc.get("generationComplete"):
                grace_active = True

            # Still honoured — a turn can complete without generationComplete.
            if sc.get("turnComplete"):
                return settle_with_text()
    finally:
        try:
            await ws.close()
        except Exception:
            pass
