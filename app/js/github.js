// Adds phrases to the repo's phrases.csv through the GitHub contents API.
// The commit starts the deploy workflow, which translates the phrase with
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
const csvField = s => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

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
    throw new Error("Couldn't reach GitHub. Adding phrases needs an internet connection.");
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

/** Appends one row. Leave en or fr blank for Claude to translate. notes: '', 'tu' or 'vous'. */
export async function addPhrase(cfg, { en, fr, set, notes }) {
  for (let attempt = 1; ; attempt++) {
    const file = await api(cfg, 'GET');
    const lines = b64decode(file.content).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    const cols = lines[0].split(',').map(h => h.trim().toLowerCase());
    if (!cols.includes('notes')) { lines[0] += ',notes'; cols.push('notes'); }
    const values = { english: en, french: fr, set, notes };
    lines.push(cols.map(c => csvField(values[c] || '')).join(','));

    const label = (en || fr).length > 60 ? `${(en || fr).slice(0, 57)}…` : (en || fr);
    try {
      return await api(cfg, 'PUT', {
        message: `Add phrase: ${label}`,
        content: b64encode(lines.join('\n') + '\n'),
        sha: file.sha,
      });
    } catch (err) {
      // 409: someone else changed the file since we read it (e.g. the
      // workflow saving translations). Read it again and retry.
      if (err.status !== 409 || attempt >= 3) throw err;
    }
  }
}
