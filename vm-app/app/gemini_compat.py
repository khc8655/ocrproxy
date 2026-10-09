"""Gemini (AI Studio / Vertex AI OpenAI-compatible endpoints) agent-mode helpers.

VM only: Gemini never runs on EdgeOne.  Everything here is applied only to
candidates whose preset uses reasoning.strategy == "gemini_thinking_matrix",
so other providers and the OpenAI zero-copy fast-path are untouched.

1. Thinking level   reasoning_effort -> extra_body.google.thinking_config
                    (3.x: thinking_level from the preset's model_matrix;
                    2.5: thinking_budget 1K/8K/24K, Google's documented mapping).
2. Thought display  request asks Google to wrap thoughts in <thought>...</thought>
                    (extra_body.google.thought_tag_marker); the response is split
                    so the thoughts go to `reasoning_content` and the answer
                    stays in `content` (non-streaming and streaming).
3. Thought signature (Gemini 3 function calling)
                    Google requires tool_calls[].extra_content.google.thought_signature
                    to be sent back on the next turn, but OpenAI clients only echo
                    the tool_call id.  The signature is carried statelessly inside
                    the id as "{id}:::{signature}" and restored on the way back;
                    an in-process LRU and Google's documented dummy signature
                    ("skip_thought_signature_validator") are the fallbacks.

Docs:
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai
  https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/overview
  https://ai.google.dev/gemini-api/docs/thought-signatures
"""

from __future__ import annotations

import json
import uuid
from collections import OrderedDict
from typing import Any, Callable, Dict, Optional

THOUGHT_TAG = "thought"
_OPEN = f"<{THOUGHT_TAG}>"
_CLOSE = f"</{THOUGHT_TAG}>"
SIG_SEP = ":::"
SKIP_SIGNATURE = "skip_thought_signature_validator"

_EFFORT_ORDER = ["minimal", "low", "medium", "high"]
_GEMINI25_BUDGET = {"minimal": 1024, "low": 1024, "medium": 8192, "high": 24576}


# ── 1. Thinking level ────────────────────────────────────────────────

def is_gemini_rules(rules: Any) -> bool:
    rr = rules.get("reasoning") if isinstance(rules, dict) else None
    return isinstance(rr, dict) and rr.get("strategy") == "gemini_thinking_matrix"


def apply_thinking(out: dict, rr: dict, m_name: str) -> None:
    """Agent mode only (KB never routes to Gemini)."""
    name = m_name.lower().split("/", 1)[-1]
    if name.startswith("gemma"):
        return
    is_25 = name.startswith("gemini-2.5-")
    is_pro = "pro" in name
    matrix = rr.get("model_matrix") or {}
    levels = [l for l in (matrix.get("pro") if is_pro else matrix.get("flash")) or [] if l in _EFFORT_ORDER]
    if not levels:
        levels = ["low", "high"] if is_pro else ["minimal", "low", "medium", "high"]
    levels.sort(key=_EFFORT_ORDER.index)

    effort = out.pop("reasoning_effort", None)
    google = dict(((out.get("extra_body") or {}).get("google")) or {})
    if effort is None:
        tc = google.get("thinking_config") or {}
        thinking_on = bool(tc) and tc.get("include_thoughts") is not False
    else:
        e = str(effort).lower()
        if e in ("xhigh", "max"):
            e = "high"
        if e in ("none", "false", "off"):
            # 2.5 Flash can switch thinking off; 2.5 Pro / 3.x cannot -> lowest setting.
            tc = ({"include_thoughts": False, "thinking_budget": 128 if is_pro else 0} if is_25
                  else {"include_thoughts": False, "thinking_level": levels[0]})
            thinking_on = False
        else:
            if e not in _EFFORT_ORDER:
                e = "medium"
            if is_25:
                tc = {"include_thoughts": True, "thinking_budget": _GEMINI25_BUDGET[e]}
            else:
                req = _EFFORT_ORDER.index(e)
                lvl = levels[0]
                for l in levels:
                    if _EFFORT_ORDER.index(l) <= req:
                        lvl = l
                tc = {"include_thoughts": True, "thinking_level": lvl}
            thinking_on = True
        google["thinking_config"] = tc

    if thinking_on:
        google.setdefault("thought_tag_marker", THOUGHT_TAG)
        if rr.get("headroom_elevation", True):
            for f in ("max_tokens", "max_completion_tokens"):
                if isinstance(out.get(f), int) and out[f] < 16384:
                    out[f] = 65535
    if google:
        extra = dict(out.get("extra_body") or {})
        extra["google"] = google
        out["extra_body"] = extra


# ── 3. Thought signatures ────────────────────────────────────────────

class _LRU:
    def __init__(self, cap: int = 2000):
        self.cap = cap
        self.d: "OrderedDict[str, str]" = OrderedDict()

    def put(self, k: str, v: str) -> None:
        if not k or not v:
            return
        self.d[k] = v
        self.d.move_to_end(k)
        while len(self.d) > self.cap:
            self.d.popitem(last=False)

    def get(self, k: str) -> Optional[str]:
        v = self.d.get(k)
        if v is not None:
            self.d.move_to_end(k)
        return v


SIG_CACHE = _LRU()


def _split_id(tc_id: Any):
    s = str(tc_id or "")
    if SIG_SEP in s:
        real, sig = s.split(SIG_SEP, 1)
        return real, sig
    return s, None


def has_signed_ids(body: dict) -> bool:
    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        if SIG_SEP in str(m.get("tool_call_id") or ""):
            return True
        for tc in m.get("tool_calls") or []:
            if isinstance(tc, dict) and SIG_SEP in str(tc.get("id") or ""):
                return True
    return False


def restore_signatures(out: dict, keep: bool = True) -> None:
    """Request side.  keep=True (Gemini): split ids and put the signature back
    into extra_content.google.thought_signature.  keep=False (other providers
    in the same failover chain): just strip the signature suffix from ids."""
    msgs = out.get("messages")
    if not isinstance(msgs, list):
        return
    for m in msgs:
        if not isinstance(m, dict):
            continue
        if m.get("tool_call_id"):
            m["tool_call_id"] = _split_id(m["tool_call_id"])[0]
        tcs = m.get("tool_calls")
        if m.get("role") != "assistant" or not isinstance(tcs, list) or not tcs:
            continue
        first_missing = True
        for i, tc in enumerate(tcs):
            if not isinstance(tc, dict):
                continue
            real, sig = _split_id(tc.get("id"))
            tc["id"] = real
            if not keep:
                continue
            google = ((tc.get("extra_content") or {}).get("google")) or {}
            if google.get("thought_signature"):
                first_missing = False
                continue
            sig = sig or SIG_CACHE.get(real)
            if sig is None and i == 0 and first_missing:
                # Google only signs the first call of a parallel batch; a missing
                # one there would 400, so use the documented dummy signature.
                sig = SKIP_SIGNATURE
            if sig:
                ec = dict(tc.get("extra_content") or {})
                ec["google"] = {**google, "thought_signature": sig}
                tc["extra_content"] = ec
                first_missing = False


def _sign_tool_call(tc: dict) -> None:
    sig = (((tc.get("extra_content") or {}).get("google")) or {}).get("thought_signature")
    if not tc.get("id"):
        tc["id"] = f"call_{uuid.uuid4().hex[:24]}"
    if sig and SIG_SEP not in str(tc["id"]):
        SIG_CACHE.put(str(tc["id"]), sig)
        tc["id"] = f"{tc['id']}{SIG_SEP}{sig}"


# ── 2. Thought display ───────────────────────────────────────────────

def _split_thoughts(text: str):
    """Non-streaming: return (reasoning, answer)."""
    if _OPEN not in text:
        return "", text
    reasoning, answer, rest = [], [], text
    while rest:
        i = rest.find(_OPEN)
        if i < 0:
            answer.append(rest)
            break
        answer.append(rest[:i])
        rest = rest[i + len(_OPEN):]
        j = rest.find(_CLOSE)
        if j < 0:
            reasoning.append(rest)
            break
        reasoning.append(rest[:j])
        rest = rest[j + len(_CLOSE):]
    return "".join(reasoning).strip(), "".join(answer).lstrip("\n")


def normalize_response(data: Any) -> Any:
    """Non-streaming ChatCompletion dict, mutated in place."""
    if not isinstance(data, dict):
        return data
    for ch in data.get("choices") or []:
        msg = ch.get("message") if isinstance(ch, dict) else None
        if not isinstance(msg, dict):
            continue
        c = msg.get("content")
        if isinstance(c, str) and _OPEN in c:
            r, a = _split_thoughts(c)
            if r:
                msg["reasoning_content"] = (msg.get("reasoning_content") or "") + r
            msg["content"] = a
        for tc in msg.get("tool_calls") or []:
            if isinstance(tc, dict):
                _sign_tool_call(tc)
    return data


class _ThoughtSplitter:
    """Streaming state machine for one choice; tags may straddle chunks."""

    def __init__(self):
        self.in_thought = False
        self.hold = ""
        self.after_close = False

    def feed(self, text: str):
        buf = self.hold + text
        self.hold = ""
        reasoning, answer = [], []
        while buf:
            tag = _CLOSE if self.in_thought else _OPEN
            i = buf.find(tag)
            if i >= 0:
                (reasoning if self.in_thought else answer).append(buf[:i])
                buf = buf[i + len(tag):]
                self.after_close = self.in_thought
                self.in_thought = not self.in_thought
                continue
            # keep a possible partial tag at the end for the next chunk
            keep = 0
            for k in range(min(len(tag) - 1, len(buf)), 0, -1):
                if tag.startswith(buf[-k:]):
                    keep = k
                    break
            out, self.hold = (buf[:-keep], buf[-keep:]) if keep else (buf, "")
            (reasoning if self.in_thought else answer).append(out)
            break
        a = "".join(answer)
        if self.after_close and a:
            a = a.lstrip("\n")
            if a:
                self.after_close = False
        return "".join(reasoning), a

    def flush(self):
        h, self.hold = self.hold, ""
        return (h, "") if self.in_thought else ("", h)


def make_stream_filter() -> Callable[[bytes], bytes]:
    """Byte-level SSE filter for _stream_with_keepalive.  Buffers partial events."""
    state: Dict[str, Any] = {"buf": b"", "split": {}, "ids": {}}

    def _process_event(ev: bytes) -> bytes:
        lines = ev.split(b"\n")
        out_lines = []
        for ln in lines:
            s = ln.strip()
            if not s.startswith(b"data:"):
                out_lines.append(ln)
                continue
            payload = s[5:].strip()
            if not payload or payload == b"[DONE]":
                out_lines.append(ln)
                continue
            try:
                obj = json.loads(payload)
            except Exception:
                out_lines.append(ln)
                continue
            changed = False
            for ch in obj.get("choices") or []:
                if not isinstance(ch, dict):
                    continue
                delta = ch.get("delta")
                if not isinstance(delta, dict):
                    continue
                idx = ch.get("index", 0)
                c = delta.get("content")
                sp = state["split"].get(idx)
                if isinstance(c, str) and c and (sp is not None or _OPEN[:1] in c):
                    if sp is None:
                        sp = state["split"][idx] = _ThoughtSplitter()
                    r, a = sp.feed(c)
                else:
                    r, a = "", (c if isinstance(c, str) else None)
                if sp is not None and ch.get("finish_reason"):
                    fr, fa = sp.flush()
                    r, a = r + fr, (a or "") + fa
                if sp is not None:
                    if r:
                        delta["reasoning_content"] = (delta.get("reasoning_content") or "") + r
                    if a is not None:
                        delta["content"] = a
                    changed = True
                for tc in delta.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    key = (idx, tc.get("index", 0))
                    sig = (((tc.get("extra_content") or {}).get("google")) or {}).get("thought_signature")
                    if tc.get("id"):
                        state["ids"][key] = str(tc["id"])
                        if sig:
                            _sign_tool_call(tc)
                            changed = True
                    elif sig and key in state["ids"]:
                        # signature arrived after the id was already sent
                        SIG_CACHE.put(state["ids"][key], sig)
            if changed:
                out_lines.append(b"data: " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())
            else:
                out_lines.append(ln)
        return b"\n".join(out_lines)

    def _filter(chunk: bytes) -> bytes:
        if not chunk:
            return chunk
        if chunk.startswith(b":") and not state["buf"]:
            return chunk  # keep-alive comment
        data = state["buf"] + chunk
        done = b"[DONE]" in chunk
        parts = data.replace(b"\r\n", b"\n").split(b"\n\n")
        if done:
            state["buf"] = b""
            complete = [p for p in parts if p]
        else:
            state["buf"] = parts.pop()
            complete = parts
        if not complete:
            return b""
        return b"".join(_process_event(p) + b"\n\n" for p in complete)

    def _flush() -> bytes:
        rest, state["buf"] = state["buf"], b""
        return _process_event(rest) + b"\n\n" if rest.strip() else b""

    _filter.flush = _flush  # type: ignore[attr-defined]
    return _filter
