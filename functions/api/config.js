// GET /api/config -> {tmdb: bool}; POST /api/config {tmdb} -> save TMDB key after checking it works.
import { json, authorized, ensureSchema } from './state.js';
import { tmdbKey, tmdbCheck } from './_tmdb.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  await ensureSchema(env.DB);
  return json({ tmdb: !!(await tmdbKey(env.DB, env)) });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const key = typeof b.tmdb === 'string' ? b.tmdb.trim() : '';
  if (!/^[a-f0-9]{32}$/i.test(key)) return json({ error: 'format' }, 400);
  if (!(await tmdbCheck(key))) return json({ error: 'invalid' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('tmdb', ?1)").bind(key),
    // let shows without a poster try again, now with TMDB
    db.prepare('DELETE FROM posters WHERE url IS NULL'),
    db.prepare('DELETE FROM summaries WHERE ar IS NULL'),
  ]);
  return json({ ok: true });
}
