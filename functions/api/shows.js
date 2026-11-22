// Add / remove user-added shows. Built-in shows have ids 1..999; added ones start at 1001.
import { json, authorized, cleanName, ensureSchema, snapshot } from './state.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const by = cleanName(b && b.by);
  const name = clip(b && b.name, 80);
  if (!by || !name) return json({ error: 'missing' }, 400);
  const year = Number.isInteger(Number(b.year)) && b.year >= 1950 && b.year <= 2100 ? Number(b.year) : null;
  const genre = clip(b.genre, 30) || 'أخرى';
  let poster = clip(b.poster, 400);
  if (poster && !/^https:\/\//.test(poster)) poster = '';
  const db = env.DB;
  await ensureSchema(db);
  const dup = await db.prepare('SELECT id FROM shows WHERE lower(name) = lower(?1)').bind(name).first();
  if (dup) return json({ error: 'exists', id: dup.id }, 409);
  const row = await db.prepare('SELECT COALESCE(MAX(id), 1000) + 1 AS next FROM shows').first();
  const id = Math.max(1001, row.next);
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO shows (id, name, year, genre, poster, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(id, name, year, genre, poster || null, by, now),
    db.prepare("INSERT INTO log (id, state, by, at) VALUES (?1, 'added', ?2, ?3)").bind(id, by, now),
  ]);
  return json({ ok: true, id, ...(await snapshot(db)) });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 1000) return json({ error: 'bad_id' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  await db.batch([
    db.prepare('DELETE FROM shows WHERE id = ?1').bind(id),
    db.prepare('DELETE FROM states WHERE id = ?1').bind(id),
    db.prepare('DELETE FROM log WHERE id = ?1').bind(id),
  ]);
  return json({ ok: true, ...(await snapshot(db)) });
}
