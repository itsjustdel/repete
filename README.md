# Répète: French listen & repeat

A small Progressive Web App for learning French passively by *listen and repeat*: give it a set of sentences, then play them on a loop while you work or travel. Start with each English sentence followed by its French; once you follow the French on its own, drop the English. You install it on Android, it keeps playing with the screen locked, and it works offline. Phrases live in a CSV file in this repo. A GitHub Action turns them into audio with Microsoft's neural voices (via [edge-tts](https://github.com/rany2/edge-tts)) and publishes the app to GitHub Pages.

There's no backend, no account, and no scores or streaks.

## What's in the box

```
phrases.csv                  your phrases: english, french, set, notes (optional)
tts.config.json              voices and speaking rate
requirements.txt             edge-tts
scripts/translate.py         fills in missing English or French with Claude
scripts/build.py             generates audio, writes the manifest, assembles dist/
scripts/make_icons.py        regenerates the app icons (only if you want to restyle them)
.github/workflows/deploy.yml build + deploy on every push to main
app/                         the static app (vanilla JS, no build step)
  index.html  css/  js/  icons/  sw.js  manifest.webmanifest
```

## Setup (about 5 minutes)

1. **Create a repository** on GitHub and push these files to the `main` branch.
   GitHub Pages is free for **public** repos. Pages on a private repo needs a paid plan (Pro, Team or Enterprise).

   ```bash
   git init -b main
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Turn on Pages with Actions as the source.**
   Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   Don't pick "Deploy from a branch". The workflow uploads the site itself.

3. **Check Actions is allowed.**
   Repo → **Settings → Actions → General**:
   - *Actions permissions*: "Allow all actions and reusable workflows", or at least allow actions created by GitHub.
   - *Workflow permissions* can stay on the default read-only setting. The workflow asks for exactly what it needs itself (`contents: write` to save translations, `pages: write`, `id-token: write`).

4. **Run it.** The push in step 1 already triggered a run. If it failed because Pages wasn't enabled yet, open the **Actions** tab → *Build audio & deploy* → **Run workflow**. The first run takes about a minute. The site URL appears in the deploy job and under Settings → Pages:

   `https://<you>.github.io/<repo>/`

   If your default branch isn't `main`, change `branches: [main]` in `.github/workflows/deploy.yml`. Also allow that branch under Settings → Environments → github-pages.

## Install on Android

1. Open the site URL in **Chrome** on your phone. Wait for "Ready offline · N clips saved" at the bottom of the home screen. That means every clip is stored on the phone.
2. Tap **Install app** at the top of the home screen, if it appears. Otherwise use Chrome's **⋮** menu → **Add to Home screen** → **Install**.
3. Open *Répète* from your home screen. It runs full screen and works in airplane mode.

**For reliable locked-screen playback:** some phones (Samsung, Xiaomi, OnePlus…) kill background audio aggressively. If playback stops after a few minutes with the screen off, go to Android **Settings → Apps → Chrome → Battery** and choose **Unrestricted**. On Samsung, also take Chrome off the "Sleeping apps" list.

## Adding phrases from the app

Tap **Add phrases** on the home screen, paste your sentences in English, one per line (about 10 makes a good set, but any number works), optionally name the set, and tap **Add**. Unnamed sets are called "Batch 3" and so on. About a minute later the set is ready to play, with the French and audio. You can also type the French yourself (one line per English line), or type only French and get the English. To add to an existing set, open it with the pencil and tap **Add a phrase to this set**.

Behind the scenes the app commits a row per sentence to `phrases.csv` with the missing language left blank. The workflow asks Claude for the translation (`scripts/translate.py`), commits it back to `phrases.csv`, records the audio and deploys. Each phrase is only translated once, and you can edit the wording in the CSV afterwards.

**One-time setup:**

1. **Claude token for the workflow.** On your computer, install Claude Code (`npm install -g @anthropic-ai/claude-code`) and run `claude setup-token`. Sign in with your Claude Pro/Max account and copy the token. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**, name it `CLAUDE_CODE_OAUTH_TOKEN` and paste the token. Translations then count towards your plan's usage. With API credits instead, add an `ANTHROPIC_API_KEY` secret.
2. **GitHub token on your phone.** The first time you open **Add phrases**, the app walks you through creating a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to this repo with **Contents: Read and write**. It stays in that browser's storage only. To remove it, use *About & settings → Forget GitHub token*, or revoke it on GitHub.

**Editing, moving and deleting.** Tap the pencil on a set to see its phrases, then tap one to change the English or French, move it to another set (existing or new), or delete it. To get a fresh translation, clear the French (*Clear and retranslate*) and save. Changes show as *Updating…* or *Removing…* until the new build is live.

**Speaking to** picks the register: *Anyone* (vous), *A friend* (tu), or *Let Claude pick*. It's stored in the optional `notes` column, which you can also use for context such as `at the pharmacy`.

## Adding phrases by hand

Edit `phrases.csv`. The GitHub web editor works fine from your phone. Commit, and about a minute later the new phrases are live.

```csv
english,french,set
"Could we have the bill, please?","L'addition, s'il vous plaît.",01 First dinner
Where is the station?,Où est la gare ?,02 Getting around
```

- Quote any field that contains a comma.
- **Sets** are grouped by name, in order of first appearance. A leading number (`01 `, `02 `) becomes the badge on the set card, and the rest is its title.
- A row whose English starts with `#` is skipped, so you can comment phrases out.
- Leave the French (or English) blank to have Claude fill it in on the next build.
- Only new or changed phrases get new audio. Clip filenames are a hash of voice + rate + text, so everything else comes from the cache.

The app checks for new phrases every time it opens while online. It then downloads the new audio in the background. Open it once on Wi-Fi before you go offline.

## Changing voices

Edit `tts.config.json`:

```json
{
  "french":  { "voice": "fr-FR-DeniseNeural", "rate": "-10%" },
  "english": { "voice": "en-GB-RyanNeural",   "rate": "+0%" }
}
```

French is slowed by 10% by default, which helps at the start. Set it to `"+0%"` for natural speed. Changing a voice or rate regenerates the affected clips on the next push.

You can also override voices without touching the file. Add repository **variables** (Settings → Secrets and variables → Actions → *Variables*) named `FR_VOICE`, `FR_RATE`, `EN_VOICE` or `EN_RATE`, then re-run the workflow.

To see every voice: `pip install edge-tts && edge-tts --list-voices | grep -E "fr-|en-GB"`. Some good French alternatives are `fr-FR-HenriNeural` (male), `fr-FR-VivienneMultilingualNeural`, and `fr-CA-SylvieNeural` (Québécois).

## How the app works

### Listening

Tap **Play** on a set. The phone can go in your pocket.

- **With English**: English → French straight after → pause → French again → pause. Where you start with a new set.
- **French only**: each French phrase with a pause to repeat it. Switch to this once you follow the French without the English.
- **Both**: a round with English, then a round of French only.

Each set remembers its own mode. **Repeat** defaults to **∞**, so it plays on a loop until you stop it; step it down for a fixed number of rounds. **Pause** sets the gap after each French phrase (2 s by default). *Longer pause for longer phrases* adds the phrase's own length to the gap. *Shuffle* reorders every round. *Show French text* can be turned off to train your ear.

Lock-screen and headphone buttons work: play/pause, next and previous phrase. Everything plays through a single `<audio>` element, and the pauses are real (silent) audio rather than timers. Android throttles timers when the screen is locked, but a page that's playing media stays alive, so the session keeps going.

### Offline

The service worker precaches the app shell. It serves audio cache-first, including proper `206` range responses so media playback works offline. The phrase list is fetched network-first with a 4-second timeout, falling back to the cached copy. When you push a new version of the app code, an **Update** prompt appears. It never reloads mid-session by itself.

## Running locally

```bash
pip install -r requirements.txt
python scripts/build.py --serve          # real voices, then http://localhost:8000
python scripts/build.py --placeholder-audio --serve   # beeps via ffmpeg, no network needed
```

Service workers need `localhost` or HTTPS. To test on a phone, use the deployed Pages URL.

## Troubleshooting

- **Action fails with `403` / `WSServerHandshakeError` from edge-tts.** Microsoft changes the endpoint now and then, and edge-tts usually ships a fix within days. Bump the version in `requirements.txt` (for example `edge-tts>=7.3,<8`) and push again.
- **A phrase added from the app never shows up.** Check the Actions tab. *Translate new phrases* fails if the `CLAUDE_CODE_OAUTH_TOKEN` secret is missing or expired; run `claude setup-token` again and update the secret.
- **Site 404s.** Check Settings → Pages says *Source: GitHub Actions*, and that the deploy job succeeded.
- **Audio regenerated even though nothing changed.** GitHub evicts Actions caches that go unused for 7 days. Everything is regenerated automatically, which takes about a minute.
- **Progress disappeared.** Progress lives in the browser's storage for the site. Clearing Chrome's site data, or uninstalling and reinstalling in some cases, wipes it. The app asks Chrome for persistent storage to make eviction unlikely.
- **Nothing plays after tapping play.** Check the phone isn't on silent for media volume. In a desktop browser, the first play needs a click (autoplay policy).

## Costs

None. GitHub Actions is free for public repos, and a private repo on a free account gets 2,000 minutes a month; each build takes about a minute. GitHub Pages is free for public repos. edge-tts uses the free Edge read-aloud voices and needs no API key. Translations of phrases added from the app use your Claude plan (a few seconds per batch).
