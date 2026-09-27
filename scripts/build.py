#!/usr/bin/env python3
"""
Build the French listen-and-repeat PWA.

  1. Reads phrases.csv  (columns: english, french, set)
  2. Generates an MP3 per phrase and language with edge-tts, skipping any
     clip that is already in the audio cache. Clip filenames are a hash of
     (voice, rate, pitch, volume, text), so a changed phrase or voice gets a
     new file automatically and unchanged ones are reused.
  3. Writes dist/data/phrases.json (the manifest the app reads)
  4. Copies app/ into dist/ and stamps the service worker with a build id.

Usage:
  python scripts/build.py                     # real voices (needs internet)
  python scripts/build.py --placeholder-audio # beeps via ffmpeg, for offline dev
  python scripts/build.py --serve             # build, then serve dist/ on :8000

Voice settings come from tts.config.json and can be overridden with the
environment variables FR_VOICE, FR_RATE, FR_PITCH, EN_VOICE, EN_RATE, EN_PITCH.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = ROOT / "app"
DIST = ROOT / "dist"
CSV_PATH = ROOT / "phrases.csv"
CONFIG_PATH = ROOT / "tts.config.json"

DEFAULT_CONFIG = {
    "french": {"voice": "fr-FR-DeniseNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"},
    "english": {"voice": "en-GB-RyanNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"},
}
ENV_OVERRIDES = {
    ("french", "voice"): "FR_VOICE", ("french", "rate"): "FR_RATE", ("french", "pitch"): "FR_PITCH",
    ("english", "voice"): "EN_VOICE", ("english", "rate"): "EN_RATE", ("english", "pitch"): "EN_PITCH",
}
CONCURRENCY = 4
RETRIES = 4


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str) -> None:
    print(f"::error::{msg}" if os.environ.get("GITHUB_ACTIONS") else f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------- config

def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_PATH.exists():
        user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        for lang in ("french", "english"):
            cfg[lang].update({k: v for k, v in (user.get(lang) or {}).items() if v})
    for (lang, key), env in ENV_OVERRIDES.items():
        if os.environ.get(env, "").strip():
            cfg[lang][key] = os.environ[env].strip()
    return cfg


# --------------------------------------------------------------------------- phrases

def read_phrases() -> list[dict]:
    if not CSV_PATH.exists():
        fail(f"{CSV_PATH.name} not found")
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        headers = {h.strip().lower(): h for h in (reader.fieldnames or [])}
        missing = {"english", "french", "set"} - headers.keys()
        if missing:
            fail(f"phrases.csv is missing column(s): {', '.join(sorted(missing))}")
        rows, seen = [], set()
        for line_no, raw in enumerate(reader, start=2):
            en = (raw.get(headers["english"]) or "").strip()
            fr = (raw.get(headers["french"]) or "").strip()
            st = (raw.get(headers["set"]) or "").strip() or "Unsorted"
            if not en and not fr:
                continue
            if en.startswith("#"):
                continue  # allow commented-out rows
            if not en or not fr:
                fail(f"phrases.csv line {line_no}: both english and french are required")
            # Stable id: set + english. Fixing a typo in the French keeps your
            # flashcard progress; rewording the English starts the card afresh.
            pid = hashlib.sha1(f"{st}␟{en}".encode()).hexdigest()[:12]
            if pid in seen:
                log(f"warning: duplicate phrase on line {line_no} skipped: {en!r}")
                continue
            seen.add(pid)
            rows.append({"id": pid, "en": en, "fr": fr, "set": st})
    if not rows:
        fail("phrases.csv has no phrases")
    return rows


def clip_name(text: str, voice_cfg: dict) -> str:
    key = "|".join([voice_cfg["voice"], voice_cfg["rate"], voice_cfg["pitch"], voice_cfg["volume"], text])
    return hashlib.sha1(key.encode()).hexdigest()[:20] + ".mp3"


# --------------------------------------------------------------------------- audio

async def tts_edge(text: str, vc: dict, out: Path) -> None:
    import edge_tts  # imported lazily so --placeholder-audio needs no deps

    tmp = out.with_suffix(".part")
    for attempt in range(1, RETRIES + 1):
        try:
            comm = edge_tts.Communicate(text, vc["voice"], rate=vc["rate"], pitch=vc["pitch"], volume=vc["volume"])
            await comm.save(str(tmp))
            if tmp.stat().st_size < 500:
                raise RuntimeError("audio file came back empty")
            tmp.replace(out)
            return
        except Exception as e:  # noqa: BLE001 - network errors come in many shapes
            tmp.unlink(missing_ok=True)
            if attempt == RETRIES:
                raise RuntimeError(f"edge-tts failed for {text!r} with {vc['voice']}: {e}") from e
            wait = 2 ** attempt
            log(f"  retry {attempt}/{RETRIES - 1} in {wait}s ({e.__class__.__name__}: {e})")
            await asyncio.sleep(wait)


async def tts_placeholder(text: str, vc: dict, out: Path) -> None:
    """Beep whose length follows the text length: lets you test the app offline."""
    freq = 660 if vc["voice"].startswith("fr") else 440
    dur = max(0.8, min(5.0, len(text) * 0.06))
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
           "-i", f"sine=frequency={freq}:duration={dur:.2f}",
           "-af", "afade=t=in:d=0.05,afade=t=out:st=%.2f:d=0.2,volume=0.3" % (dur - 0.2),
           "-ac", "1", "-ar", "24000", "-b:a", "48k", str(out)]
    proc = await asyncio.create_subprocess_exec(*cmd)
    if await proc.wait() != 0:
        raise RuntimeError("ffmpeg failed making placeholder audio")


async def generate_audio(jobs: list[tuple[str, dict, Path]], placeholder: bool) -> None:
    sem = asyncio.Semaphore(CONCURRENCY)
    engine = tts_placeholder if placeholder else tts_edge
    done = 0

    async def run(text, vc, out):
        nonlocal done
        async with sem:
            await engine(text, vc, out)
            done += 1
            log(f"  [{done}/{len(jobs)}] {vc['voice']}: {text}")

    await asyncio.gather(*(run(*j) for j in jobs))


# --------------------------------------------------------------------------- build

def build(placeholder: bool) -> None:
    started = time.time()
    cfg = load_config()
    phrases = read_phrases()
    cache = ROOT / (".audio-cache-placeholder" if placeholder else ".audio-cache")
    cache.mkdir(exist_ok=True)

    log(f"Voices: FR {cfg['french']['voice']} ({cfg['french']['rate']}), "
        f"EN {cfg['english']['voice']} ({cfg['english']['rate']})")

    wanted: dict[str, tuple[str, dict]] = {}
    for p in phrases:
        p["frAudio"] = clip_name(p["fr"], cfg["french"])
        p["enAudio"] = clip_name(p["en"], cfg["english"])
        wanted[p["frAudio"]] = (p["fr"], cfg["french"])
        wanted[p["enAudio"]] = (p["en"], cfg["english"])

    jobs = [(text, vc, cache / name) for name, (text, vc) in wanted.items() if not (cache / name).exists()]
    log(f"{len(phrases)} phrases, {len(wanted)} clips: {len(wanted) - len(jobs)} cached, {len(jobs)} to generate")
    if jobs:
        try:
            asyncio.run(generate_audio(jobs, placeholder))
        except RuntimeError as e:
            fail(str(e))

    # Drop clips no longer referenced so the Actions cache doesn't grow forever.
    for f in cache.glob("*.mp3"):
        if f.name not in wanted:
            f.unlink()

    # ---- assemble dist/
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(APP_DIR, DIST)
    (DIST / "audio").mkdir()
    for name in wanted:
        shutil.copy2(cache / name, DIST / "audio" / name)

    sets: dict[str, list] = {}
    for p in phrases:
        sets.setdefault(p["set"], []).append(
            {"id": p["id"], "en": p["en"], "fr": p["fr"], "enAudio": p["enAudio"], "frAudio": p["frAudio"]})

    content_hash = hashlib.sha1()
    for f in sorted(APP_DIR.rglob("*")):
        if f.is_file():
            content_hash.update(f.relative_to(APP_DIR).as_posix().encode())
            content_hash.update(f.read_bytes())
    content_hash.update(json.dumps(sets, sort_keys=True).encode())
    build_id = content_hash.hexdigest()[:10]

    manifest = {
        "build": build_id,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "voices": {"fr": cfg["french"]["voice"], "en": cfg["english"]["voice"]},
        "placeholderAudio": placeholder,
        "sets": [{"name": name, "phrases": items} for name, items in sets.items()],
    }
    (DIST / "data").mkdir(exist_ok=True)
    (DIST / "data" / "phrases.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    # Stamp the service worker with this build's id and its app-shell file list.
    shell = sorted(f.relative_to(APP_DIR).as_posix() for f in APP_DIR.rglob("*")
                   if f.is_file() and f.name != "sw.js")
    sw = DIST / "sw.js"
    sw.write_text(sw.read_text(encoding="utf-8")
                  .replace("__BUILD_ID__", build_id)
                  .replace("__APP_FILES__", json.dumps(["./"] + shell)), encoding="utf-8")

    size = sum(f.stat().st_size for f in (DIST / "audio").glob("*.mp3"))
    log(f"Built dist/ (build {build_id}) with {len(sets)} set(s), {size / 1024:.0f} KB audio "
        f"in {time.time() - started:.1f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--placeholder-audio", action="store_true", help="make beeps with ffmpeg instead of calling edge-tts")
    ap.add_argument("--serve", action="store_true", help="serve dist/ on http://localhost:8000 after building")
    args = ap.parse_args()
    build(args.placeholder_audio)
    if args.serve:
        log("Serving on http://localhost:8000 (Ctrl+C to stop)")
        subprocess.run([sys.executable, "-m", "http.server", "8000", "--directory", str(DIST)])


if __name__ == "__main__":
    main()
