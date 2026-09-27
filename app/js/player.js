// Listen-and-repeat engine.
//
// Everything goes through ONE <audio> element: phrase clips and the pauses
// between them. Pauses are real audio (a generated silent WAV) rather than
// setTimeout, because:
//   * timers are throttled or frozen when an Android screen is locked,
//     but an element that keeps playing keeps the page alive;
//   * lock-screen / headphone controls (Media Session) stay attached to a
//     single continuous media session;
//   * pausing during a gap and resuming just works.

const EST_CLIP_SECONDS = 2.2;

// ---------------------------------------------------------------- silence
const silenceCache = new Map();
function silenceUrl(seconds) {
  const s = Math.max(0.3, Math.round(seconds * 10) / 10);
  if (silenceCache.has(s)) return silenceCache.get(s);
  const rate = 8000, n = Math.round(rate * s), bytes = n * 2;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  // ±1 LSB of dither (~ -90 dB, inaudible) so no layer decides the stream is
  // "silent" and powers down Bluetooth, which would clip the next phrase.
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, (i & 1) ? 1 : -1, true);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  silenceCache.set(s, url);
  if (silenceCache.size > 40) {
    const [k, old] = silenceCache.entries().next().value;
    URL.revokeObjectURL(old);
    silenceCache.delete(k);
  }
  return url;
}

// ---------------------------------------------------------------- plan
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// mode: '1' | '2' | 'both'. loops: 0 means on repeat, so plan one round
// at a time; `round` numbers it.
export function buildPlan(phrases, { mode, loops, shuffle }, round = 1) {
  const stages = mode === 'both' ? [1, 2] : [Number(mode)];
  const steps = [];
  let unit = 0;
  for (const stage of stages) {
    for (let loop = loops ? 1 : round; loop <= (loops || round); loop++) {
      const order = shuffle ? shuffled(phrases) : phrases;
      order.forEach((phrase, pos) => {
        const meta = { unit: unit++, phrase, stage, loop, pos, count: order.length };
        if (stage === 1) {
          steps.push(
            { ...meta, kind: 'clip', lang: 'en' },
            { ...meta, kind: 'gap', purpose: 'think' },
            { ...meta, kind: 'clip', lang: 'fr' },
            { ...meta, kind: 'gap', purpose: 'repeat' },
            { ...meta, kind: 'clip', lang: 'fr', again: true },
            { ...meta, kind: 'gap', purpose: 'repeat' },
          );
        } else {
          steps.push({ ...meta, kind: 'clip', lang: 'fr' }, { ...meta, kind: 'gap', purpose: 'repeat' });
        }
      });
    }
  }
  return steps;
}

export function estimateMinutes(phraseCount, { mode, loops, pause, scale }) {
  const gap = pause + (scale ? EST_CLIP_SECONDS : 0);
  const s1 = 3 * EST_CLIP_SECONDS + 3 * gap;
  const s2 = EST_CLIP_SECONDS + gap;
  const per = mode === '1' ? s1 : mode === '2' ? s2 : s1 + s2;
  return Math.max(1, Math.round((per * phraseCount * (loops || 1)) / 60));
}

// ---------------------------------------------------------------- player
export class ListenPlayer extends EventTarget {
  constructor(audio, audioUrl) {
    super();
    this.audio = audio;
    this.audioUrl = audioUrl; // (filename) => url
    this.steps = [];
    this.i = 0;
    this.loaded = -1;
    this.playing = false;
    this.active = false; // true while the listening session owns the element
    this.finished = false;
    this.lastClipSeconds = EST_CLIP_SECONDS;
    this.switching = false;
    this.round = 1;
    this.opts = null;
    this.setName = '';

    audio.addEventListener('ended', () => { if (this.active) this._onEnded(); });
    audio.addEventListener('error', () => {
      if (!this.active || !this.playing) return;
      console.warn('audio error, skipping step', this.audio.error);
      setTimeout(() => this._onEnded(), 250);
    });
    // Paused by something other than us: a phone call, another app taking
    // audio focus, a Bluetooth disconnect. Keep the UI truthful.
    audio.addEventListener('pause', () => {
      if (!this.active || this.switching || audio.ended || !this.playing) return;
      this.playing = false;
      this._emit();
    });
    audio.addEventListener('play', () => {
      if (!this.active || this.playing) return;
      this.playing = true;
      this._emit();
    });
    this._setupMediaSession();
  }

  get step() { return this.steps[Math.min(this.i, this.steps.length - 1)]; }
  get units() { return this.steps.length ? this.steps[this.steps.length - 1].unit + 1 : 0; }

  load(setName, phrases, opts) {
    this.stop();
    this.setName = setName;
    this.phrases = phrases;
    this.opts = opts; // live object: pause/scale changes apply to the next gap
    this.round = 1;
    this.steps = buildPlan(phrases, opts);
    this.i = 0;
    this.loaded = -1;
    this.finished = false;
    this._emit();
  }

  play() {
    if (!this.steps.length) return;
    this.active = true;
    if (this.finished || this.i >= this.steps.length) { this.i = 0; this.finished = false; this.loaded = -1; }
    this.playing = true;
    if (this.loaded === this.i && this.audio.src && !this.audio.ended) {
      this.audio.play().catch(err => this._playFailed(err));
    } else {
      this._loadStep();
    }
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.audio.pause();
    this._emit();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this._msKey = null;
    this.playing = false;
    if (this.active) this.audio.pause();
    this.active = false;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
    this._emit();
  }

  next() { this._jumpUnit(+1); }

  prev() {
    const s = this.step;
    if (!s) return;
    const start = this.steps.findIndex(x => x.unit === s.unit);
    const intoUnit = this.i > start || (this.loaded === this.i && this.audio.currentTime > 1.5);
    if (intoUnit) this._goto(start);
    else this._jumpUnit(-1);
  }

  _jumpUnit(dir) {
    const s = this.step;
    if (!s) return;
    const target = s.unit + dir;
    if (target < 0) return this._goto(0);
    const idx = this.steps.findIndex(x => x.unit === target);
    if (idx !== -1) return this._goto(idx);
    if (this._nextRound()) return this._goto(0);
    this._finish();
  }

  _goto(idx) {
    this.i = idx;
    this.finished = false;
    this.loaded = -1;
    if (this.playing) this._loadStep();
    this._emit();
  }

  _loadStep() {
    const s = this.steps[this.i];
    if (!s) return this._finish();
    const src = s.kind === 'clip'
      ? this.audioUrl(s.lang === 'fr' ? s.phrase.frAudio : s.phrase.enAudio)
      : silenceUrl(this.opts.pause + (this.opts.scale ? this.lastClipSeconds : 0));
    this.loaded = this.i;
    this.switching = true;
    this.audio.src = src;
    this.audio.play()
      .then(() => { this.switching = false; })
      .catch(err => { this.switching = false; this._playFailed(err); });
    this._updateMediaSession();
  }

  _playFailed(err) {
    if (err && err.name === 'AbortError') return; // superseded by a newer src
    console.warn('play() failed', err);
    this.playing = false;
    this._emit();
  }

  _onEnded() {
    const s = this.steps[this.i];
    if (s && s.kind === 'clip' && Number.isFinite(this.audio.duration)) this.lastClipSeconds = this.audio.duration;
    this.i++;
    if (this.i >= this.steps.length) {
      if (!this._nextRound()) return this._finish();
      this.i = 0;
    }
    if (this.playing) this._loadStep();
    this._emit();
  }

  // On repeat: plan the next round (reshuffled if shuffle is on) and keep going.
  _nextRound() {
    if (this.opts.loops) return false;
    this.round++;
    this.steps = buildPlan(this.phrases, this.opts, this.round);
    return true;
  }

  _finish() {
    this.playing = false;
    this.finished = true;
    this.i = this.steps.length;
    this.audio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    this._emit();
    this.dispatchEvent(new Event('done'));
  }

  _emit() {
    if ('mediaSession' in navigator && this.active) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
    this.dispatchEvent(new Event('change'));
  }

  // ------------------------------------------------ lock screen / headphones
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => this.pause(),
      nexttrack: () => this.next(),
      previoustrack: () => this.prev(),
      // Some headsets only send seek commands; treat them as phrase skips.
      seekforward: () => this.next(),
      seekbackward: () => this.prev(),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = this.step;
    if (!s) return;
    const key = `${s.unit}`;
    if (this._msKey === key) return; // only once per phrase, avoids flicker
    this._msKey = key;
    const hide = this.opts && !this.opts.showText;
    const set = this.setName.replace(/^\d+[\s._-]+/, '');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: hide ? `Phrase ${s.pos + 1} of ${s.count}` : s.phrase.fr,
      artist: hide ? set : s.phrase.en,
      album: `${set} · round ${s.loop}`,
      artwork: [
        { src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  }
}
