// Practice-time tracking and streaks.
import { db } from './db.js';

// A day counts towards the streak once you've practised this long.
export const STREAK_MIN_SECONDS = 60;

export function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let pending = 0;
let flushing = Promise.resolve();

// Called often (every audio step, every flashcard answer). Buffers in memory
// and writes to IndexedDB every ~10 s of accumulated practice.
export function addPractice(seconds) {
  if (!(seconds > 0)) return;
  pending += Math.min(seconds, 180); // guard against clock jumps / sleeping devices
  if (pending >= 10) flush();
}

export function flush() {
  if (pending <= 0) return flushing;
  const add = pending;
  pending = 0;
  const key = dayKey();
  flushing = flushing.then(async () => {
    const row = (await db.get('days', key)) || { date: key, seconds: 0 };
    row.seconds += add;
    await db.put('days', row);
  }).catch(err => console.warn('stats flush failed', err));
  return flushing;
}

export async function summary() {
  await flush();
  const rows = await db.getAll('days');
  const byDate = new Map(rows.map(r => [r.date, r.seconds]));
  const total = rows.reduce((a, r) => a + r.seconds, 0);
  const today = byDate.get(dayKey()) || 0;

  // Streak: consecutive qualifying days ending today, or ending yesterday if
  // today isn't done yet (the streak is still alive until midnight).
  const d = new Date();
  if (today < STREAK_MIN_SECONDS) d.setDate(d.getDate() - 1);
  let streak = 0;
  while ((byDate.get(dayKey(d)) || 0) >= STREAK_MIN_SECONDS) {
    streak++;
    d.setDate(d.getDate() - 1);
  }

  // Monday-first week strip for the current week.
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    const k = dayKey(x);
    return { date: k, seconds: byDate.get(k) || 0, isToday: k === dayKey(now), label: 'MTWTFSS'[i] };
  });

  return { today, total, streak, week, doneToday: today >= STREAK_MIN_SECONDS };
}

addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', () => flush());
