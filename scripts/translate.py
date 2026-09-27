#!/usr/bin/env python3
"""
Fill in missing translations in phrases.csv with Claude.

Any row that has English but no French (or French but no English) is sent
to Claude in one batch, and the answers are written back into the CSV so
each phrase is translated only once. Edit the CSV afterwards if you'd like
different wording; a filled-in row is never touched again.

The optional "notes" column steers the translation: "tu" or "vous" picks
the register, anything else is passed along as context.

Claude is called through the Claude Code CLI (via npx), authenticated by
CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, uses a Pro/Max plan)
or ANTHROPIC_API_KEY (API credits).

Usage:
  python scripts/translate.py            # translate and rewrite phrases.csv
  python scripts/translate.py --dry-run  # show what would be translated
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "phrases.csv"
MODEL = os.environ.get("TRANSLATE_MODEL", "sonnet")

PROMPT = """You translate phrases for a French learner's listen-and-repeat app.
The learner is British and wants natural, everyday spoken French from France:
what a native speaker would actually say in that situation, not a word-for-word
rendering. Keep it about as short as the original. Use standard French
punctuation (a space before ? ! : ;). For French to English, use natural British English.

Register: use "vous" unless the note says "tu" or the English is clearly
casual talk with a friend, child or family member. A note saying "vous"
always means vous.

Each item has an "id", a "from" language, the "text" and sometimes a "note".
Reply with only a JSON array, no prose and no code fences, one object per item:
[{"id": <id>, "text": "<translation>"}]

Items:
"""


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str) -> None:
    print(f"::error::{msg}" if os.environ.get("GITHUB_ACTIONS") else f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def read_csv() -> tuple[list[str], list[dict]]:
    text = CSV_PATH.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    fields = list(reader.fieldnames or [])
    missing = {"english", "french", "set"} - {f.strip().lower() for f in fields}
    if missing:
        fail(f"phrases.csv is missing column(s): {', '.join(sorted(missing))}")
    return fields, list(reader)


def col(fields: list[str], name: str) -> str | None:
    return next((f for f in fields if f.strip().lower() == name), None)


def ask_claude(items: list[dict]) -> dict[int, str]:
    if not (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")):
        fail("New phrases need translating but neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set. "
             "Add one as a repository secret (see README).")
    npx = shutil.which("npx")
    if not npx:
        fail("npx not found: Node.js is needed to run the Claude Code CLI")

    prompt = PROMPT + json.dumps(items, ensure_ascii=False, indent=1)
    cmd = [npx, "-y", "@anthropic-ai/claude-code", "-p", "--output-format", "json",
           "--model", MODEL, "--max-turns", "1"]
    # Tokens copied from a terminal often pick up a line break where it wrapped.
    env = dict(os.environ)
    for var in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
        if env.get(var):
            env[var] = re.sub(r"\s+", "", env[var])
    log(f"Asking Claude ({MODEL}) to translate {len(items)} phrase(s)")
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=300, env=env)
    if proc.returncode != 0:
        try:
            reason = json.loads(proc.stdout).get("result")
        except (json.JSONDecodeError, AttributeError):
            reason = None
        reason = reason or (proc.stderr or proc.stdout).strip()[-800:]
        if "401" in reason or "authenticate" in reason.lower():
            reason += (" The CLAUDE_CODE_OAUTH_TOKEN secret is wrong or expired: run `claude setup-token` "
                       "again and update the secret.")
        fail(f"Claude CLI failed (exit {proc.returncode}): {reason}")

    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        fail(f"Claude CLI returned something that isn't JSON: {proc.stdout[:400]}")
    if envelope.get("is_error"):
        fail(f"Claude returned an error: {envelope.get('result')}")
    reply = str(envelope.get("result", ""))
    m = re.search(r"\[.*\]", reply, re.S)
    if not m:
        fail(f"Couldn't find a JSON array in Claude's reply: {reply[:400]}")
    try:
        answers = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        fail(f"Claude's reply wasn't valid JSON ({e}): {reply[:400]}")
    return {int(a["id"]): str(a["text"]).strip() for a in answers if str(a.get("text", "")).strip()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="list untranslated rows without calling Claude")
    args = ap.parse_args()

    fields, rows = read_csv()
    en_col, fr_col, notes_col = col(fields, "english"), col(fields, "french"), col(fields, "notes")

    items = []
    for i, row in enumerate(rows):
        en = (row.get(en_col) or "").strip()
        fr = (row.get(fr_col) or "").strip()
        if en.startswith("#") or bool(en) == bool(fr):
            continue  # comment, complete, or empty
        item = {"id": i, "from": "English" if en else "French", "text": en or fr}
        note = (row.get(notes_col) or "").strip() if notes_col else ""
        if note:
            item["note"] = note
        items.append(item)

    if not items:
        log("All phrases already translated")
        return
    for it in items:
        log(f"  {it['from']}: {it['text']}" + (f"  [{it['note']}]" if "note" in it else ""))
    if args.dry_run:
        return

    answers = ask_claude(items)
    done = 0
    for it in items:
        text = answers.get(it["id"])
        if not text:
            log(f"warning: no translation came back for {it['text']!r}")
            continue
        rows[it["id"]][fr_col if it["from"] == "English" else en_col] = text
        log(f"  -> {text}")
        done += 1
    if done < len(items):
        fail(f"Only {done} of {len(items)} phrase(s) were translated")

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=fields, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    CSV_PATH.write_text(out.getvalue(), encoding="utf-8", newline="")
    log(f"Translated {done} phrase(s) and updated {CSV_PATH.name}")


if __name__ == "__main__":
    main()
