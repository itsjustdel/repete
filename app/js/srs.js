// SM-2 spaced repetition, lightly adapted for a phone app:
//  - four buttons (Again / Hard / Good / Easy) map to SM-2 quality 2 / 3 / 4 / 5
//  - "Again" resets the card and brings it back later in the same session
//  - a due date is the start of a local day, so a card is due all day long
const DAY = 86400000;

export const GRADES = [
  { key: 'again', label: 'Again', q: 2 },
  { key: 'hard', label: 'Hard', q: 3 },
  { key: 'good', label: 'Good', q: 4 },
  { key: 'easy', label: 'Easy', q: 5 },
];

export function newCard(id) {
  return { id, ef: 2.5, reps: 0, interval: 0, due: 0, lapses: 0, last: 0, isNew: true };
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Pure function: returns the updated card without saving it.
export function schedule(card, q, now = Date.now()) {
  const c = { ...card, last: now };
  delete c.isNew;
  c.ef = Math.max(1.3, c.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (q < 3) {
    c.reps = 0;
    c.interval = 0;
    c.lapses += 1;
    c.due = now; // due immediately: the session re-queues it
    return c;
  }

  c.reps += 1;
  if (c.reps === 1) c.interval = q === 5 ? 3 : 1;
  else if (c.reps === 2) c.interval = q === 3 ? 3 : 6;
  else {
    let next = c.interval * c.ef;
    if (q === 3) next = c.interval * 1.2;
    if (q === 5) next *= 1.3;
    c.interval = Math.max(c.interval + 1, Math.round(next));
  }
  c.due = startOfDay(now) + c.interval * DAY;
  return c;
}

export function isDue(card, now = Date.now()) {
  return card.isNew || card.due <= now;
}

export function intervalLabel(card, q, now = Date.now()) {
  const next = schedule(card, q, now);
  if (q < 3) return 'now';
  const d = next.interval;
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
