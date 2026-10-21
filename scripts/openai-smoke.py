#!/usr/bin/env python3
"""
Phase 69 Plan 03 — OpenAI-endpoint E2E smoke test.

Covers OPENAI-01 (non-stream), OPENAI-02 (stream), OPENAI-03 (/v1/models),
and OPENAI-05 (per-bearer-key session continuity). Runs against a live daemon
with the OpenAI endpoint enabled (default port 3101). Any failed check exits
non-zero with a loud summary; all-pass exits 0 with a compact report.

Usage:

    pip install openai
    clawcode start-all           # daemon must be running
    export CLAWCODE_API_KEY=ck_clawdy_XXXX
    python scripts/openai-smoke.py

    # Or create a fresh key inline:
    python scripts/openai-smoke.py --create-key

Environment variables (all optional — CLI flags override):
    CLAWCODE_API_KEY    bearer key (required unless --create-key passed)
    CLAWCODE_BASE_URL   default http://127.0.0.1:3101/v1
    CLAWCODE_AGENT      default "clawdy"

Requirements: openai >= 1.0 (any recent 1.x release works).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import Any


def _maybe_create_key(agent: str) -> str | None:
    """Invoke `clawcode openai-key create <agent> --label smoke-test` and parse
    the Key: line from stdout. Returns the key, or None on any failure."""
    try:
        out = subprocess.check_output(
            ["clawcode", "openai-key", "create", agent, "--label", "smoke-test"],
            text=True,
            timeout=15,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as err:
        print(f"--create-key: failed to invoke clawcode CLI: {err}", file=sys.stderr)
        return None
    for line in out.splitlines():
        stripped = line.strip()
        if stripped.startswith("Key:"):
            return stripped.split(":", 1)[1].strip()
    print("--create-key: clawcode CLI output did not contain a 'Key:' line", file=sys.stderr)
    return None


def _models_check(client: Any, agent: str) -> tuple[str, str]:
    """OPENAI-03 — GET /v1/models must list the agent."""
    try:
        models = client.models.list()
        ids = [m.id for m in models.data]
        if agent not in ids:
            return ("FAIL", f"agent '{agent}' not in models list: {ids}")
        return ("pass", f"{len(ids)} model(s) listed, {agent} present")
    except Exception as err:  # noqa: BLE001
        return ("FAIL", str(err))


def _non_stream_check(client: Any, agent: str) -> tuple[str, str]:
    """OPENAI-01 — non-streaming POST /v1/chat/completions."""
    try:
        resp = client.chat.completions.create(
            model=agent,
            messages=[{"role": "user", "content": "Respond with the word: hello"}],
        )
        if not resp.id.startswith("chatcmpl-"):
            return ("FAIL", f"id did not start with chatcmpl-: {resp.id!r}")
        if resp.object != "chat.completion":
            return ("FAIL", f"object was {resp.object!r}")
        choice = resp.choices[0]
        if choice.message.role != "assistant":
            return ("FAIL", f"message.role was {choice.message.role!r}")
        content = choice.message.content or ""
        if not content.strip():
            return ("FAIL", "message.content was empty")
        return ("pass", f"id={resp.id} content={content[:40]!r}")
    except Exception as err:  # noqa: BLE001
        return ("FAIL", str(err))


def _stream_check(client: Any, agent: str) -> tuple[str, str]:
    """OPENAI-02 — streaming POST /v1/chat/completions."""
    try:
        stream = client.chat.completions.create(
            model=agent,
            messages=[{"role": "user", "content": "Count to 3, one per line."}],
            stream=True,
        )
        got_role = False
        got_content = False
        got_finish = False
        content = ""
        for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            if getattr(delta, "role", None) == "assistant":
                got_role = True
            delta_content = getattr(delta, "content", None)
            if delta_content:
                content += delta_content
                got_content = True
            if choice.finish_reason:
                got_finish = True
        if not (got_role and got_content and got_finish and content.strip()):
            return (
                "FAIL",
                f"role={got_role} content={got_content} finish={got_finish} text={content!r}",
            )
        return ("pass", f"role+content+finish seen, {len(content)} chars total")
    except Exception as err:  # noqa: BLE001
        return ("FAIL", str(err))


def _session_continuity_check(client: Any, agent: str) -> tuple[str, str]:
    """OPENAI-05 — two sequential non-stream calls share a session (same bearer key)."""
    try:
        client.chat.completions.create(
            model=agent,
            messages=[
                {
                    "role": "user",
                    "content": "My name is Alice. Please remember that for the rest of this conversation.",
                }
            ],
        )
        resp2 = client.chat.completions.create(
            model=agent,
            messages=[{"role": "user", "content": "What name did I tell you?"}],
        )
        text = (resp2.choices[0].message.content or "").lower()
        if "alice" not in text:
            return (
                "FAIL",
                f"expected 'alice' in response (session did NOT persist). Got: {text[:120]!r}",
            )
        return ("pass", "Second turn recalled 'Alice' — session continuity verified")
    except Exception as err:  # noqa: BLE001
        return ("FAIL", str(err))


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 69 OpenAI-endpoint smoke test")
    parser.add_argument(
        "--create-key",
        action="store_true",
        help="Run `clawcode openai-key create <agent>` and use the returned key",
    )
    parser.add_argument(
        "--agent",
        default=os.environ.get("CLAWCODE_AGENT", "clawdy"),
        help="Agent name to test (default: clawdy)",
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("CLAWCODE_BASE_URL", "http://127.0.0.1:3101/v1"),
        help="OpenAI base URL (default: http://127.0.0.1:3101/v1)",
    )
    args = parser.parse_args()

    try:
        from openai import OpenAI
    except ImportError:
        print("error: the 'openai' package is required. pip install openai", file=sys.stderr)
        return 2

    api_key = os.environ.get("CLAWCODE_API_KEY")
    if args.create_key:
        fresh = _maybe_create_key(args.agent)
        if fresh:
            api_key = fresh
    if not api_key:
        print(
            "error: set CLAWCODE_API_KEY or pass --create-key to mint one via the CLI",
            file=sys.stderr,
        )
        return 2

    client = OpenAI(base_url=args.base_url, api_key=api_key)

    results: dict[str, tuple[str, str]] = {}
    results["OPENAI-03"] = _models_check(client, args.agent)
    results["OPENAI-01"] = _non_stream_check(client, args.agent)
    results["OPENAI-02"] = _stream_check(client, args.agent)
    results["OPENAI-05"] = _session_continuity_check(client, args.agent)

    print("\n=== Phase 69 OpenAI-Endpoint Smoke Results ===")
    for req, (status, note) in results.items():
        marker = "pass" if status == "pass" else "FAIL"
        print(f"{req}: {marker}  {note}")
    failed = [req for req, (status, _) in results.items() if status != "pass"]
    if failed:
        print(f"\n{len(failed)} check(s) failed: {', '.join(failed)}")
        return 1
    print("\nAll 4 checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
