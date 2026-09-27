import { ListenPlayer, estimateMinutes } from './player.js';
import { getGithub, saveGithub, forgetGithub, checkAccess, addPhrases, editPhrase, deletePhrase } from './github.js';

const $view = document.getElementById('view');
const $np = document.getElementById('nowplaying');
const $toast = document.getElementById('toast');
const audio = document.getElementById('audio');

export const AUDIO_CACHE = 'repete-audio';
const audioUrl = file => `audio/${file}`;
const player = new ListenPlayer(audio, audioUrl);

let data = null;
let cleanup = null;
let installPrompt = null;
let offline = { have: 0, total: 0, busy: false };

// ------------------------------------------------------------------ helpers
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const findSet = name => data.sets.find(s => s.name === name);
const setHref = (view, name) => `#/${view}/${encodeURIComponent(name)}`;

function splitSetName(name) {
  const m = name.match(/^(\d+)[\s._-]+(.+)$/);
  return m ? { no: String(Number(m[1])), title: m[2] } : { no: name.trim().charAt(0).toUpperCase(), title: name };
}

function toast(msg, actionLabel, onAction, ms = 0) {
  $toast.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  $toast.hidden = false;
  if (actionLabel) $toast.querySelector('button').onclick = () => { $toast.hidden = true; onAction(); };
  if (ms) setTimeout(() => { $toast.hidden = true; }, ms);
}

// ------------------------------------------------------------------ prefs (listening settings)
const PREFS_KEY = 'repete.listen.v1';
// loops: 0 = play on repeat until stopped. modes: per set, '1' (with English),
// '2' (French only) or 'both'; `mode` is the one for the set that's loaded.
const DEFAULT_PREFS = { mode: '1', modes: {}, pause: 3, loops: 0, scale: true, shuffle: false, showText: true };
const prefs = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

// ------------------------------------------------------------------ data
async function loadData() {
  const res = await fetch('data/phrases.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`phrases.json: HTTP ${res.status}`);
  data = await res.json();
}

// ------------------------------------------------------------------ pending changes
// Phrases added, edited or deleted from this phone that aren't in a published
// build yet: { op: 'add'|'edit'|'delete', en, fr, set, from?, build, at }.
// `from` is the id of the phrase an edit or delete applies to, and `build`
// the build that was live when the change was made.
const PENDING_KEY = 'repete.pending.v1';
let pending = (() => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; }
})();
const savePending = () => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { /* private mode */ } };
const pendingFor = id => pending.find(p => p.from === id);

function addPending(change) {
  pending.push({ ...change, build: data.build, at: Date.now() });
  savePending();
  pollForBuild();
}

// Drops changes that a newer build has picked up. Returns how many did.
function prunePending() {
  const before = pending.length;
  const present = p => !!findSet(p.set)?.phrases.some(x => (!p.en || x.en === p.en) && (!p.fr || x.fr === p.fr));
  pending = pending.filter(p => {
    if (Date.now() - p.at > 60 * 60 * 1000) return false; // give up on it after an hour
    if (p.build && p.build === data.build) return true;
    return p.op === 'delete' ? present(p) : !present(p);
  });
  savePending();
  return before - pending.length;
}

function pendingHtml(setName) {
  const list = pending.filter(p => !setName || p.set === setName);
  if (!list.length) return '';
  const repo = data.repo || getGithub()?.repo;
  const items = list.map(p => {
    const slow = Date.now() - p.at > 10 * 60 * 1000;
    const status = slow
      ? `Taking longer than usual${repo ? ` · <a href="https://github.com/${esc(repo)}/actions" target="_blank" rel="noopener">check GitHub</a>` : ''}`
      : p.op === 'delete' ? 'Removing…'
      : p.en && p.fr ? (p.op === 'edit' ? 'Updating…' : 'Recording…')
      : 'Translating and recording…';
    return `<li><span class="p-text">${esc(p.en || p.fr)}</span><small>${esc(splitSetName(p.set).title)} · ${status}</small></li>`;
  }).join('');
  return `<h3 class="section-title">On the way</h3><section class="panel"><ul class="pending">${items}</ul></section>`;
}

// While changes are pending, check for a new build now and then and pull it in.
let pollTimer = null;
function pollForBuild() {
  if (pollTimer || !pending.length) return;
  pollTimer = setInterval(async () => {
    if (!pending.length) { clearInterval(pollTimer); pollTimer = null; return; }
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch('data/phrases.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const next = await res.json();
      if (next.build === data.build) return;
      data = next;
      const arrived = prunePending();
      if (arrived) toast(`${arrived} change${arrived === 1 ? ' is' : 's are'} live.`, null, null, 4000);
      if (!/^#\/(listen|add|edit)\//.test(location.hash) && location.hash !== '#/add') route();
      syncAudio();
    } catch { /* offline; try again next tick */ }
  }, 15000);
}

// ------------------------------------------------------------------ router
async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = decodeURIComponent(rest.join('/'));
  try {
    if (name === 'listen') await viewListen(arg);
    else if (name === 'add') await viewAdd(arg || null);
    else if (name === 'set') await viewSet(arg);
    else if (name === 'edit') await viewEdit(arg);
    else await viewHome();
  } catch (err) {
    console.error(err);
    $view.innerHTML = `<p class="error">Something went wrong: ${esc(err.message)}</p>`;
  }
  updateNowPlaying();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ home
async function viewHome() {
  const setsHtml = data.sets.map(set => {
    const { no, title } = splitSetName(set.name);
    const mode = prefs.modes[set.name] || '1';
    const bits = [`${set.phrases.length} phrase${set.phrases.length === 1 ? '' : 's'}`, MODES[mode].short];
    return `
      <article class="panel set">
        <div class="set-head">
          <div class="set-no">${esc(no)}</div>
          <div class="set-title"><div class="set-name">${esc(title)}</div><div class="set-meta">${bits.join(' · ')}</div></div>
          <a class="icon-btn flat" href="${setHref('set', set.name)}" aria-label="Edit phrases in ${esc(title)}">${icon('edit')}</a>
        </div>
        <a class="btn primary wide" href="${setHref('listen', set.name)}">${icon('play')} Play</a>
      </article>`;
  }).join('');

  $view.innerHTML = `
    <header class="brand"><h1>Répète<span>.</span></h1>${installPrompt ? '<button class="btn" id="install" style="min-height:48px;font-size:15px">Install app</button>' : ''}</header>

    ${setsHtml}
    <a class="btn wide" href="#/add">${icon('plus')} Add phrases</a>
    ${pendingHtml()}

    <footer class="foot">
      <div id="offline-status">${offlineStatusHtml()}</div>
      <details>
        <summary>About &amp; settings</summary>
        <p>Voices: ${esc(data.voices.fr)} / ${esc(data.voices.en)}<br>Build ${esc(data.build)} · ${esc(new Date(data.generated).toLocaleString())}</p>
        ${data.placeholderAudio ? '<p><b>This build uses placeholder beeps, not real voices.</b></p>' : ''}
        ${getGithub() ? `<p>Adding phrases to ${esc(getGithub().repo)} <button class="danger" id="forget">Forget GitHub token</button></p>` : ''}
      </details>
    </footer>`;

  $view.querySelector('#forget')?.addEventListener('click', () => {
    if (!confirm('Forget the GitHub token on this device? You can connect again from Add phrases.')) return;
    forgetGithub();
    route();
  });

  $view.querySelector('#install')?.addEventListener('click', async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    route();
  });
}

function offlineStatusHtml() {
  if (!('caches' in window) || !offline.total) return '';
  if (offline.have >= offline.total) return `<span class="offline-dot ok"></span>Ready offline · ${offline.total} clips saved`;
  return `<span class="offline-dot"></span>Saving audio for offline… ${offline.have}/${offline.total}`;
}

// ------------------------------------------------------------------ listen
const MODES = {
  1: { label: 'With English', sub: 'EN → FR ×2', short: 'with English' },
  2: { label: 'French only', sub: 'FR, repeat', short: 'French only' },
  both: { label: 'Both', sub: 'then French only', short: 'with English, then French only' },
};

async function viewListen(name) {
  const set = findSet(name);
  if (!set) { location.hash = '#/'; return; }
  if (player.setName !== set.name || !player.steps.length) {
    prefs.mode = prefs.modes[set.name] || '1';
    player.load(set.name, set.phrases, prefs);
  }
  const { title } = splitSetName(set.name);

  $view.innerHTML = `
    <div class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back">${icon('back')}</a>
      <h2>${esc(title)}</h2>
    </div>

    <section class="panel phrase-card" aria-live="polite">
      <span class="chip" id="chip"></span>
      <p class="fr-text" id="fr" lang="fr"></p>
      <p class="en-text" id="en"></p>
    </section>

    <div class="progress">
      <div class="bar"><i id="bar"></i></div>
      <div class="progress-meta"><span id="pos"></span><span id="loopinfo"></span></div>
    </div>

    <div class="transport">
      <button class="icon-btn" id="prev" aria-label="Previous phrase">${icon('prev')}</button>
      <button class="play-big" id="play" aria-label="Play">${icon('play')}</button>
      <button class="icon-btn" id="next" aria-label="Next phrase">${icon('next')}</button>
    </div>

    <section class="panel settings">
      <div class="seg" role="group" aria-label="Mode">
        ${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}">${m.label}<small>${m.sub}</small></button>`).join('')}
      </div>
      <p class="hint">Start with English. Once you follow the French without it, switch to French only.</p>
      <div class="row"><span>Pause<small>Time to repeat</small></span>
        <div class="stepper"><button data-step="pause" data-d="-0.5" aria-label="Shorter pause">−</button><output id="pause-v"></output><button data-step="pause" data-d="0.5" aria-label="Longer pause">+</button></div>
      </div>
      <div class="row"><span>Repeat<small>Times through the set</small></span>
        <div class="stepper"><button data-step="loops" data-d="-1" aria-label="Fewer loops">−</button><output id="loops-v"></output><button data-step="loops" data-d="1" aria-label="More loops">+</button></div>
      </div>
      <div class="row"><label for="t-scale">Longer pause for longer phrases<small>Adds the phrase's length to the pause</small></label>
        <span class="switch"><input type="checkbox" id="t-scale" data-pref="scale"><span></span></span></div>
      <div class="row"><label for="t-shuffle">Shuffle</label>
        <span class="switch"><input type="checkbox" id="t-shuffle" data-pref="shuffle"><span></span></span></div>
      <div class="row"><label for="t-text">Show French text<small>Turn off to train your ear</small></label>
        <span class="switch"><input type="checkbox" id="t-text" data-pref="showText"><span></span></span></div>
      <p class="est" id="est"></p>
    </section>`;

  const $ = sel => $view.querySelector(sel);
  const els = { chip: $('#chip'), fr: $('#fr'), en: $('#en'), bar: $('#bar'), pos: $('#pos'), loop: $('#loopinfo'), play: $('#play') };

  function renderSettings() {
    $view.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode)));
    $('#pause-v').textContent = `${prefs.pause.toFixed(1)} s`;
    $('#loops-v').textContent = prefs.loops ? `${prefs.loops}×` : '∞';
    $('#t-scale').checked = prefs.scale;
    $('#t-shuffle').checked = prefs.shuffle;
    $('#t-text').checked = prefs.showText;
    $('#est').textContent = prefs.loops
      ? `About ${estimateMinutes(set.phrases.length, prefs)} min · keeps playing with the screen locked`
      : `About ${estimateMinutes(set.phrases.length, { ...prefs, loops: 1 })} min a round · plays on repeat until you stop it, even with the screen locked`;
  }

  function render() {
    const s = player.step;
    els.play.innerHTML = icon(player.playing ? 'pause' : 'play');
    els.play.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    if (!s) return;
    if (player.finished) {
      els.chip.textContent = 'Finished';
      els.chip.className = 'chip';
      els.fr.textContent = 'Bien joué !';
      els.fr.className = 'fr-text';
      els.en.textContent = 'Press play to go again.';
      els.en.className = 'en-text';
      els.bar.style.width = '100%';
      els.pos.textContent = `${s.count} phrases`;
      els.loop.textContent = '';
      return;
    }
    const started = player.active || player.i > 0;
    let chip = 'Ready';
    if (started) {
      if (s.kind === 'clip') chip = s.lang === 'en' ? 'English' : s.again ? 'French · again' : 'French';
      else chip = s.purpose === 'think' ? 'In French…' : 'Repeat';
    }
    els.chip.textContent = chip;
    els.chip.className = `chip${started && s.kind === 'gap' ? ' gap' : ''}`;

    // Stage 1 reveals the French text only once it's been heard.
    const idxInUnit = player.i - player.steps.findIndex(x => x.unit === s.unit);
    const frHeard = s.stage === 2 || idxInUnit >= 2;
    const showFr = prefs.showText && frHeard;
    const showEn = s.stage === 1 || prefs.showText;
    els.fr.textContent = s.phrase.fr;
    els.en.textContent = s.phrase.en;
    els.fr.className = `fr-text${showFr ? '' : ' hidden'}${started && s.kind === 'clip' && s.lang === 'fr' ? ' speaking' : ''}`;
    els.en.className = `en-text${showEn ? '' : ' hidden'}`;
    els.bar.style.width = `${(s.unit / player.units) * 100}%`;
    els.pos.textContent = `Phrase ${s.pos + 1} of ${s.count}`;
    const stage = prefs.mode === 'both' ? `${MODES[s.stage].label} · ` : '';
    els.loop.textContent = `${stage}round ${s.loop}${prefs.loops ? ` of ${prefs.loops}` : ''}`;
  }

  function rebuild() {
    const wasPlaying = player.playing;
    player.load(set.name, set.phrases, prefs);
    if (wasPlaying) player.play();
  }

  $view.querySelector('.seg').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === prefs.mode) return;
    prefs.mode = prefs.modes[set.name] = b.dataset.mode; savePrefs(); renderSettings(); rebuild();
  });
  $view.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const d = Number(b.dataset.d);
    if (b.dataset.step === 'pause') prefs.pause = Math.min(15, Math.max(0.5, prefs.pause + d));
    else {
      // Steps through 1…20 then ∞ (stored as 0), and back down from ∞ to 20.
      const n = prefs.loops || 21;
      const next = Math.min(21, Math.max(1, n + d));
      if (next === n) return;
      prefs.loops = next === 21 ? 0 : next;
      rebuild();
    }
    savePrefs(); renderSettings();
  }));
  $view.querySelectorAll('[data-pref]').forEach(inp => inp.addEventListener('change', () => {
    prefs[inp.dataset.pref] = inp.checked; savePrefs(); renderSettings();
    if (inp.dataset.pref === 'shuffle') rebuild();
    if (inp.dataset.pref === 'showText') { player._msKey = null; render(); }
  }));
  els.play.addEventListener('click', () => player.toggle());
  $('#prev').addEventListener('click', () => player.prev());
  $('#next').addEventListener('click', () => player.next());

  const onKey = e => {
    if (e.target.closest('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowRight') player.next();
    else if (e.key === 'ArrowLeft') player.prev();
  };
  player.addEventListener('change', render);
  addEventListener('keydown', onKey);
  cleanup = () => { player.removeEventListener('change', render); removeEventListener('keydown', onKey); };

  renderSettings();
  render();
}

// ------------------------------------------------------------------ manage a set
async function viewSet(name) {
  player.stop();
  const set = findSet(name);
  const extra = pendingHtml(name);
  if (!set && !extra) { location.hash = '#/'; return; }
  const phrases = set ? set.phrases : [];
  const rows = phrases.map(p => {
    const change = pendingFor(p.id);
    const tag = change ? `<span class="tag">${change.op === 'delete' ? 'Removing…' : 'Updating…'}</span>` : '';
    return `<li><a class="phrase-row${change ? ' busy' : ''}" href="#/edit/${p.id}">
      <span class="fr" lang="fr">${esc(p.fr)}</span><span class="en">${esc(p.en)}</span>${tag}</a></li>`;
  }).join('');

  $view.innerHTML = `
    <div class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back">${icon('back')}</a>
      <h2>${esc(splitSetName(name).title)}</h2><span class="meta">${phrases.length} phrase${phrases.length === 1 ? '' : 's'}</span>
    </div>
    ${rows ? `<ul class="panel phrase-list">${rows}</ul>` : ''}
    <a class="btn wide" href="#/add/${encodeURIComponent(name)}">${icon('plus')} Add a phrase to this set</a>
    ${extra}
    <p class="hint center">Tap a phrase to edit, move or delete it.</p>`;
}

// ------------------------------------------------------------------ add / edit a phrase
function newSetName(title) {
  if (/^\d+[\s._-]/.test(title)) return title;
  const nums = data.sets.map(s => Number((s.name.match(/^(\d+)/) || [])[1] || 0));
  return `${String(Math.max(0, ...nums) + 1).padStart(2, '0')} ${title}`;
}

function findPhrase(id) {
  for (const set of data.sets) {
    const p = set.phrases.find(x => x.id === id);
    if (p) return { p, set: set.name };
  }
  return null;
}

function formTop(title, back) {
  return `
    <div class="topbar">
      <a class="icon-btn" href="${back}" aria-label="Back">${icon('back')}</a>
      <h2>${esc(title)}</h2>
    </div>`;
}

function viewConnect(top) {
  const guess = data.repo || (location.hostname.endsWith('.github.io')
    ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}` : '');
  $view.innerHTML = `${top}
    <section class="panel form">
      <p>To change phrases from here, the app needs a GitHub token that can edit your phrase list. You only do this once per device.</p>
      <ol>
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → New fine-grained token</a>.</li>
        <li>Repository access: <b>Only select repositories</b> → your Répète repo.</li>
        <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
        <li>Generate it, copy it and paste it below.</li>
      </ol>
      <label class="field"><span>Repository</span><input id="repo" value="${esc(guess)}" placeholder="owner/repo" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Token</span><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
      <button class="btn primary wide" id="connect">Connect</button>
      <p class="form-err" id="err" role="alert"></p>
    </section>`;
  const $btn = $view.querySelector('#connect');
  $btn.addEventListener('click', async () => {
    const cfg = { repo: $view.querySelector('#repo').value.trim(), token: $view.querySelector('#token').value.trim() };
    const $err = $view.querySelector('#err');
    if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo) || !cfg.token) { $err.textContent = 'Fill in both the repository (owner/repo) and the token.'; return; }
    $btn.disabled = true; $err.textContent = '';
    try {
      await checkAccess(cfg);
      saveGithub(cfg);
      route();
    } catch (err) {
      $err.textContent = err.message;
      $btn.disabled = false;
    }
  });
}

const viewAdd = presetSet => viewPhraseForm(null, presetSet);

async function viewEdit(id) {
  const found = findPhrase(id);
  if (!found) { location.hash = '#/'; return; }
  if (pendingFor(id)) { toast('That phrase is still being updated. Try again in a minute.', null, null, 3000); history.back(); return; }
  return viewPhraseForm(found);
}

// Shared form: `existing` is { p, set } when editing, null when adding.
async function viewPhraseForm(existing, presetSet) {
  player.stop();
  const editing = !!existing;
  const back = editing ? setHref('set', existing.set) : presetSet ? setHref('set', presetSet) : '#/';
  const top = formTop(editing ? 'Edit phrase' : 'Add phrases', back);
  const gh = getGithub();
  if (!gh) return viewConnect(top);

  const names = data.sets.map(s => s.name);
  for (const p of pending) if (!names.includes(p.set)) names.push(p.set); // new sets still on the way
  // Adding from the home screen starts a new set; from a set's page, adds to it.
  const selected = editing ? existing.set : names.includes(presetSet) ? presetSet : '';
  const p = existing?.p;
  // '' = Anyone (vous), 'tu' = A friend, 'auto' = let Claude judge.
  let register = !editing ? '' : p.notes === 'tu' ? 'tu' : p.notes === 'vous' ? '' : 'auto';
  const regBtn = (val, label, sub) => `<button type="button" data-reg="${val}" aria-pressed="${register === val}">${label}<small>${sub}</small></button>`;

  $view.innerHTML = `${top}
    <section class="panel form">
      <label class="field"><span>English${editing ? '' : ' <small>One sentence per line. Paste a whole set at once.</small>'}</span>
        <textarea id="en" rows="${editing ? 2 : 7}" placeholder="${editing ? '' : 'Where is the station?&#10;I&#39;d like a coffee, please.&#10;What time does it open?'}">${esc(p?.en || '')}</textarea></label>
      <div class="field"><label for="fr">French <small>${editing ? 'Clear it to get a fresh translation from Claude.' : 'Optional. Leave it blank and Claude translates. If you fill it in, one line per English line.'}</small></label>
        <textarea id="fr" rows="${editing ? 2 : 3}" lang="fr">${esc(p?.fr || '')}</textarea>
        ${editing ? '<button type="button" class="link-btn" id="retranslate">Clear and retranslate</button>' : ''}</div>
      <div class="field"><span>Speaking to <small>Used when Claude translates.</small></span>
        <div class="seg" role="group" aria-label="Formality">
          ${regBtn('', 'Anyone', 'vous')}${regBtn('tu', 'A friend', 'tu')}${regBtn('auto', 'Let Claude', 'pick')}
        </div></div>
      <label class="field"><span>Set</span>
        <select id="set">
          ${names.map(n => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(splitSetName(n).title)}</option>`).join('')}
          <option value=""${selected ? '' : ' selected'}>New set…</option>
        </select></label>
      <input id="newset" placeholder="Name of the new set, e.g. At the café"${selected ? ' hidden' : ''}>
      <button class="btn primary wide" id="save">${editing ? 'Save changes' : 'Add'}</button>
      ${editing ? '<button class="btn wide danger-btn" id="delete">Delete phrase</button>' : ''}
      <p class="form-err" id="err" role="alert"></p>
      <p class="hint">${editing ? 'Changes take' : 'Translating and recording takes'} about a minute.</p>
    </section>
    <div id="pending">${editing ? '' : pendingHtml()}</div>`;

  const $ = sel => $view.querySelector(sel);
  const $set = $('#set'), $newset = $('#newset'), $save = $('#save'), $err = $('#err');
  const buttons = [$save, $('#delete')].filter(Boolean);
  const busy = on => buttons.forEach(b => { b.disabled = on; });
  $set.addEventListener('change', () => { $newset.hidden = $set.value !== ''; if (!$newset.hidden) $newset.focus(); });
  $view.querySelector('.seg').addEventListener('click', e => {
    const b = e.target.closest('[data-reg]');
    if (!b) return;
    register = b.dataset.reg;
    $view.querySelectorAll('[data-reg]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('#retranslate')?.addEventListener('click', () => { $('#fr').value = ''; $('#fr').focus(); });

  $save.addEventListener('click', async () => {
    const lines = el => el.value.split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const [enLines, frLines] = [lines($('#en')), lines($('#fr'))];
    const en = enLines.join(' '), fr = frLines.join(' ');
    const set = $set.value || ($newset.value.trim() && newSetName($newset.value.trim()));
    // Goes in the CSV's notes column; blank lets Claude judge from the phrase.
    const notes = register === 'tu' ? 'tu' : register === 'auto' ? '' : 'vous';
    if (!en && !fr) { $err.textContent = 'Type at least one sentence in English (or French).'; return; }
    if (!set) { $err.textContent = 'Give the new set a name.'; return; }
    if (!editing && enLines.length && frLines.length && enLines.length !== frLines.length) {
      $err.textContent = `There are ${enLines.length} English lines but ${frLines.length} French. Give one French line per English line, or leave the French blank.`;
      return;
    }
    if (editing && en === p.en && fr === p.fr && set === existing.set && notes === (p.notes || '')) {
      location.hash = back; return;
    }
    busy(true); $err.textContent = '';
    try {
      if (editing) {
        await editPhrase(gh, { en: p.en, fr: p.fr, set: existing.set }, { en, fr, set, notes });
        addPending({ op: 'edit', en, fr, set, from: p.id });
        toast('Saved. The change appears in about a minute.', null, null, 3000);
        location.hash = setHref('set', set);
        return;
      }
      const items = (enLines.length ? enLines : frLines).map((_, i) =>
        ({ en: enLines[i] || '', fr: frLines[i] || '', set, notes }));
      await addPhrases(gh, items);
      items.forEach(({ en, fr }) => addPending({ op: 'add', en, fr, set }));
      toast(`Added ${items.length === 1 ? 'it' : `${items.length} phrases`}. Ready to play in about a minute.`, null, null, 3500);
      location.hash = presetSet ? setHref('set', set) : '#/';
    } catch (err) {
      $err.textContent = err.message;
    } finally {
      busy(false);
    }
  });

  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${p.en || p.fr}"?`)) return;
    busy(true); $err.textContent = '';
    try {
      await deletePhrase(gh, { en: p.en, fr: p.fr, set: existing.set });
      addPending({ op: 'delete', en: p.en, fr: p.fr, set: existing.set, from: p.id });
      toast('Deleted. It disappears in about a minute.', null, null, 3000);
      location.hash = setHref('set', existing.set);
    } catch (err) {
      $err.textContent = err.message;
      busy(false);
    }
  });
}

// ------------------------------------------------------------------ now playing bar
function updateNowPlaying() {
  const onListen = location.hash.startsWith('#/listen/');
  const show = player.active && !player.finished && !onListen;
  $np.hidden = !show;
  document.body.classList.toggle('has-np', show);
  if (!show) return;
  const s = player.step;
  $np.innerHTML = `${icon(player.playing ? 'pause' : 'play')}<span class="np-text">${esc(splitSetName(player.setName).title)}<small>${player.playing ? 'Playing' : 'Paused'} · phrase ${s.pos + 1} of ${s.count}</small></span>`;
}
$np.addEventListener('click', () => { location.hash = setHref('listen', player.setName); });
player.addEventListener('change', updateNowPlaying);

// ------------------------------------------------------------------ offline audio
async function syncAudio() {
  if (!('caches' in window) || offline.busy) return;
  offline.busy = true;
  try {
    const files = [...new Set(data.sets.flatMap(s => s.phrases.flatMap(p => [p.frAudio, p.enAudio])))];
    const urls = files.map(f => new URL(audioUrl(f), location.href).href);
    const cache = await caches.open(AUDIO_CACHE);
    const want = new Set(urls);
    for (const req of await cache.keys()) if (!want.has(req.url)) await cache.delete(req);
    const missing = [];
    for (const u of urls) if (!(await cache.match(u))) missing.push(u);
    offline = { have: urls.length - missing.length, total: urls.length, busy: true };
    refreshOfflineStatus();
    const worker = async () => {
      while (missing.length) {
        const u = missing.shift();
        try {
          const res = await fetch(u);
          if (res.ok) { await cache.put(u, res); offline.have++; refreshOfflineStatus(); }
        } catch { /* offline right now; try again next launch */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    offline.busy = false;
    refreshOfflineStatus();
  }
}

function refreshOfflineStatus() {
  const el = document.getElementById('offline-status');
  if (el) el.innerHTML = offlineStatusHtml();
}

// ------------------------------------------------------------------ service worker
let userAskedUpdate = false;
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = () => toast('A new version is ready.', 'Update', () => {
      userAskedUpdate = true;
      reg.waiting?.postMessage('skipWaiting');
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer();
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(err => console.warn('SW registration failed', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAskedUpdate) location.reload();
  });
}

addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  if (!location.hash || location.hash === '#/') route();
});

// ------------------------------------------------------------------ boot
(async function boot() {
  registerSW();
  try {
    await loadData();
  } catch (err) {
    $view.innerHTML = `<p class="error">Couldn't load phrases. Connect to the internet once so the app can save them for offline use.<br><small>${esc(err.message)}</small></p>`;
    return;
  }
  prunePending();
  addEventListener('hashchange', route);
  await route();
  pollForBuild();
  navigator.storage?.persist?.().catch(() => {});
  syncAudio();
})();
