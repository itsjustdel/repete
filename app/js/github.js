// Edits the repo's phrases.csv through the GitHub contents API. Each commit
// starts the deploy workflow, which translates any blank English/French with
// Claude, records the audio and publishes a new build.
//
// Needs a fine-grained personal access token limited to this one repo with
// "Contents: Read and write". It's kept in this browser's localStorage only.

const CFG_KEY = 'repete.github.v1';
const CSV_PATH = 'phrases.csv';

export function getGithub() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { return null; }
}
export function saveGithub(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
}
export function forgetGithub() {
  try { localStorage.removeItem(CFG_KEY); } catch { /* private mode */ }
}

const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
const b64encode = s => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };

// ------------------------------------------------------------------ CSV
// Same dialect as Python's csv module: quote only fields that need it.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f !== ''));
}
const csvField = s => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const toCsv = rows => rows.map(r => r.map(f => csvField(f ?? '')).join(',')).join('\n') + '\n';

// ------------------------------------------------------------------ API
async function api(cfg, method, body) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${CSV_PATH}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach GitHub. Changing phrases needs an internet connection.");
  }
  if (res.ok) return res.json();
  const err = new Error(
    res.status === 401 ? 'GitHub rejected the token. It may have expired: forget it and connect again.'
    : res.status === 403 ? "The token can't edit this repo. It needs Contents: Read and write."
    : res.status === 404 ? `Couldn't find ${cfg.repo}/${CSV_PATH}, or the token doesn't have access to it.`
    : `GitHub error ${res.status}`);
  err.status = res.status;
  throw err;
}

/** Throws a readable error if the token can't read the phrase list. */
export async function checkAccess(cfg) {
  await api(cfg, 'GET');
}

// Reads the CSV, lets `change` edit it as { cols, rows } (rows are objects
// keyed by lower-case column name), and commits the result. Retries if the
// file changed on GitHub in between (e.g. the workflow saving translations).
async function updateCsv(cfg, message, change) {
  for (let attempt = 1; ; attempt++) {
    const file = await api(cfg, 'GET');
    const [header = ['english', 'french', 'set'], ...body] = parseCsv(b64decode(file.content));
    const cols = header.map(h => h.trim().toLowerCase());
    if (!cols.includes('notes')) cols.push('notes');
    const rows = body.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ''])));
    change(rows);
    const out = [header.length < cols.length ? [...header, 'notes'] : header, ...rows.map(r => cols.map(c => r[c]))];
    try {
      return await api(cfg, 'PUT', { message, content: b64encode(toCsv(out)), sha: file.sha });
    } catch (err) {
      if (err.status !== 409 || attempt >= 3) throw err;
    }
  }
}

const short = s => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
const sameSet = (row, set) => (row.set.trim() || 'Unsorted') === set;

function findRow(rows, { en, fr, set }) {
  const i = rows.findIndex(r => sameSet(r, set) && (en ? r.english.trim() === en : r.french.trim() === fr));
  if (i < 0) throw new Error("Couldn't find that phrase in phrases.csv. It may have been changed elsewhere; reopen the app and try again.");
  return i;
}

/** Appends one row. Leave en or fr blank for Claude to translate. notes: '', 'tu' or 'vous'. */
export function addPhrase(cfg, { en, fr, set, notes }) {
  return updateCsv(cfg, `Add phrase: ${short(en || fr)}`, rows => {
    rows.push({ english: en, french: fr, set, notes });
  });
}

/** Replaces the row matching `was` ({ en, fr, set }) with `now` ({ en, fr, set, notes }). */
export function editPhrase(cfg, was, now) {
  return updateCsv(cfg, `Edit phrase: ${short(now.en || now.fr)}`, rows => {
    const i = findRow(rows, was);
    rows[i] = { ...rows[i], english: now.en, french: now.fr, set: now.set, notes: now.notes };
  });
}

/** Removes the row matching { en, fr, set }. */
export function deletePhrase(cfg, was) {
  return updateCsv(cfg, `Delete phrase: ${short(was.en || was.fr)}`, rows => {
    rows.splice(findRow(rows, was), 1);
  });
}
