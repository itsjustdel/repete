// Listen-and-repeat engine.
//
// A round (every phrase in the set with its pauses) is rendered into ONE WAV
// file in memory and played by the single <audio> element, like a music
// track, looped with the element's own `loop`. Android keeps a playing track
// going with the screen off, and nothing has to run in the page to move from
// one phrase to the next. (Switching the element's source for every clip and
// pause, as an earlier version did, let the phone suspend the page between
// clips with the screen off.)
//
// The page only follows along: `timeupdate` says where playback is, and that
// drives the on-screen text and the lock-screen title.

const RATE = 24000; // edge-tts clips are 24 kHz mono
const EST_CLIP_SECONDS = 2.2;
// Gap between the English and its French: just enough to separate them.
const BRIDGE_SECONDS = 0.7;

// ---------------------------------------------------------------- plan
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One round. mode: '1' (with English) | '2' (French only) | 'both'.
export function buildPlan(phrases, { mode, shuffle }) {
  const stages = mode === 'both' ? [1, 2] : [Number(mode)];
  const steps = [];
  let unit = 0;
  for (const stage of stages) {
    const order = shuffle ? shuffled(phrases) : phrases;
    order.forEach((phrase, pos) => {
      const meta = { unit: unit++, phrase, stage, pos, count: order.length };
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
  return steps;
}

export function estimateMinutes(phraseCount, { mode, loops, pause, scale }) {
  const gap = pause + (scale ? EST_CLIP_SECONDS : 0);
  const s1 = 3 * EST_CLIP_SECONDS + BRIDGE_SECONDS + 2 * gap;
  const s2 = EST_CLIP_SECONDS + gap;
  const per = mode === '1' ? s1 : mode === '2' ? s2 : s1 + s2;
  return Math.max(1, Math.round((per * phraseCount * (loops || 1)) / 60));
}

// ---------------------------------------------------------------- render
// Decoded clips, by URL. Clips come through the service worker, so this
// works offline once the audio is saved.
const decoded = new Map();
let decodeCtx = null;

function decodeClip(url) {
  if (!decoded.has(url)) {
    decodeCtx ||= new OfflineAudioContext(1, 1, RATE);
    decoded.set(url, fetch(url)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.arrayBuffer(); })
      .then(buf => decodeCtx.decodeAudioData(buf))
      .then(ab => ab.getChannelData(0))
      .catch(err => { console.warn('clip unavailable', url, err); decoded.delete(url); return null; }));
    if (decoded.size > 300) decoded.delete(decoded.keys().next().value);
  }
  return decoded.get(url);
}

// Returns { url, starts } where starts[i] is when steps[i] begins, in seconds.
async function renderRound(steps, opts, audioUrl) {
  const clips = await Promise.all(steps.map(s => s.kind === 'clip'
    ? decodeClip(audioUrl(s.lang === 'fr' ? s.phrase.frAudio : s.phrase.enAudio))
    : null));

  let prevClip = EST_CLIP_SECONDS;
  const lengths = steps.map((s, k) => {
    if (s.kind === 'clip') {
      const n = clips[k] ? clips[k].length : Math.round(0.5 * RATE); // missing clip: short silence
      prevClip = n / RATE;
      return n;
    }
    const sec = s.purpose === 'think' ? BRIDGE_SECONDS : opts.pause + (opts.scale ? prevClip : 0);
    return Math.round(sec * RATE);
  });

  const total = lengths.reduce((a, n) => a + n, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total * 2, true);

  const pcm = new Int16Array(buf, 44, total);
  const starts = [];
  let at = 0;
  steps.forEach((s, k) => {
    starts.push(at / RATE);
    const src = clips[k];
    if (src) {
      for (let j = 0; j < src.length; j++) {
        const x = Math.max(-1, Math.min(1, src[j]));
        pcm[at + j] = x < 0 ? x * 0x8000 : x * 0x7fff;
      }
    } else {
      // ±1 LSB of dither (~ -90 dB, inaudible) so no layer decides the stream
      // is silent and powers down Bluetooth, which would clip the next phrase.
      for (let j = 0; j < lengths[k]; j++) pcm[at + j] = (j & 1) ? 1 : -1;
    }
    at += lengths[k];
  });
  return { url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), starts };
}

// Index of the last start <= t.
function stepAt(starts, t) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t + 0.02) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------- player
export class ListenPlayer extends EventTarget {
  constructor(audio, audioUrl) {
    super();
    this.audio = audio;
    this.audioUrl = audioUrl; // (filename) => url
    this.steps = [];
    this.i = 0;
    this.round = 1;
    this.playing = false;
    this.active = false; // true while the listening session owns the element
    this.finished = false;
    this.opts = null;
    this.setName = '';
    this.phrases = [];
    this.render = null; // { url, starts } for this.steps
    this._pending = null; // promise of a render in progress
    this._gen = 0;
    this._lastT = 0;

    const follow = () => this._follow();
    audio.addEventListener('timeupdate', follow);
    audio.addEventListener('seeked', follow);
    audio.addEventListener('ended', () => { if (this.active) this._finish(); });
    audio.addEventListener('error', () => {
      if (!this.active || !this.playing) return;
      console.warn('audio error', audio.error);
      this.playing = false;
      this._emit();
    });
    // Paused by something other than us: a phone call, another app taking
    // audio focus, a Bluetooth disconnect. Keep the UI truthful.
    audio.addEventListener('pause', () => {
      if (!this.active || audio.ended || !this.playing) return;
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
  get loading() { return this.playing && !this.render; }

  load(setName, phrases, opts) {
    this.stop();
    this.setName = setName;
    this.phrases = phrases;
    this.opts = opts; // live object: read again whenever settings change
    this.round = 1;
    this.steps = buildPlan(phrases, opts);
    this.i = 0;
    this.finished = false;
    this._drop();
    this._prepare();
    this._emit();
  }

  /** Pause length changed: render the same plan again and carry on from this phrase. */
  refresh() {
    if (!this.steps.length) return;
    const unit = this.step.unit;
    this._drop();
    this._prepare().then(r => {
      if (!r) return;
      this.i = this.steps.findIndex(s => s.unit === unit);
      if (this.active) this._attach(this.playing);
      this._emit();
    });
  }

  /** Repeat count changed. */
  updateLoop() {
    this.audio.loop = !this.opts.loops || this.round < this.opts.loops;
    this._emit();
  }

  async play() {
    if (!this.steps.length) return;
    this.active = true;
    if (this.finished) { this.finished = false; this.round = 1; this.i = 0; }
    this.playing = true;
    this._emit();
    const r = this.render || await this._pending;
    if (!r || !this.playing || !this.active) return; // paused or reloaded meanwhile
    this._attach(true);
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
    const into = this.render ? this.audio.currentTime - this.render.starts[start] : 0;
    if (this.i > start + 1 || into > 1.5) this._goto(start);
    else this._jumpUnit(-1);
  }

  // ------------------------------------------------ internals
  _prepare() {
    const gen = ++this._gen;
    this._pending = renderRound(this.steps, this.opts, this.audioUrl).then(r => {
      if (gen !== this._gen) { URL.revokeObjectURL(r.url); return null; }
      this.render = r;
      this._emit();
      return r;
    });
    return this._pending;
  }

  // Forget the current render. Its URL stays valid while the element uses it.
  _drop() {
    if (this.render && this.audio.src !== this.render.url) URL.revokeObjectURL(this.render.url);
    this.render = null;
  }

  // Point the element at the current render, at step i, and optionally play.
  _attach(play) {
    const r = this.render;
    const old = this.audio.src;
    if (old !== r.url) {
      this.audio.src = r.url;
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    }
    this._seek(this.i);
    this.audio.loop = !this.opts.loops || this.round < this.opts.loops;
    if (play) this.audio.play().catch(err => this._playFailed(err));
    this._updateMediaSession();
  }

  _seek(idx) {
    const t = this.render.starts[idx] || 0;
    this._lastT = t;
    this.audio.currentTime = t;
  }

  // Follow playback: which step is playing, and whether the track looped.
  _follow() {
    if (!this.active || !this.render || this.audio.src !== this.render.url) return;
    const t = this.audio.currentTime;
    if (t + 1 < this._lastT) this._nextRound();
    this._lastT = t;
    const i = stepAt(this.render.starts, t);
    if (i !== this.i) {
      this.i = i;
      this._updateMediaSession();
      this._emit();
    }
  }

  _nextRound() {
    this.round++;
    this._msKey = null;
    // On the last round, let the track end instead of looping.
    this.audio.loop = !this.opts.loops || this.round < this.opts.loops;
  }

  _jumpUnit(dir) {
    const s = this.step;
    if (!s) return;
    const target = s.unit + dir;
    if (target < 0) return this._goto(0);
    const idx = this.steps.findIndex(x => x.unit === target);
    if (idx !== -1) return this._goto(idx);
    if (!this.opts.loops || this.round < this.opts.loops) { this._nextRound(); return this._goto(0); }
    this._finish();
  }

  _goto(idx) {
    this.i = idx;
    this.finished = false;
    if (this.render && this.audio.src === this.render.url) this._seek(idx);
    this._updateMediaSession();
    this._emit();
  }

  _playFailed(err) {
    if (err && err.name === 'AbortError') return; // superseded by a newer src
    console.warn('play() failed', err);
    this.playing = false;
    this._emit();
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
    const key = `${this.round}:${s.unit}`;
    if (this._msKey === key) return; // only once per phrase, avoids flicker
    this._msKey = key;
    const hide = this.opts && !this.opts.showText;
    const set = this.setName.replace(/^\d+[\s._-]+/, '');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: hide ? `Phrase ${s.pos + 1} of ${s.count}` : s.phrase.fr,
      artist: hide ? set : s.phrase.en,
      album: `${set} · round ${this.round}`,
      artwork: [
        { src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  }
}
