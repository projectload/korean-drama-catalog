// GET /api/trailer?id=&name=&year= -> {yt, title} (YouTube key) via TMDB, cached in D1 for a week.
import { json, authorized, ensureSchema } from './state.js';
import { tmdbKey, tmdbFind, tmdbTrailer } from './_tmdb.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  const q = new URL(request.url).searchParams;
  const id = Number(q.get('id')), name = (q.get('name') || '').slice(0, 80), year = Number(q.get('year')) || null;
  if (!Number.isInteger(id) || id < 1 || !name) return json({ error: 'bad_input' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  const row = await db.prepare('SELECT yt, title, at FROM trailers WHERE id = ?1').bind(id).first();
  if (row && (row.yt || Date.now() - row.at < 7 * 86400000)) return json({ yt: row.yt, title: row.title });
  const key = await tmdbKey(db, env);
  if (!key) return json({ yt: null, reason: 'no_tmdb' });
  let res = null;
  try {
    const s = await db.prepare('SELECT meta FROM summaries WHERE id = ?1').bind(id).first();
    let tvId = s ? (JSON.parse(s.meta || '{}').tmdb || null) : null;
    if (!tvId) { const t = await tmdbFind(name, year, key); tvId = t ? t.id : null; }
    const m = name.match(/\s(\d)$/);
    if (tvId) res = await tmdbTrailer(tvId, key, m ? +m[1] : null);
  } catch { return json({ yt: null, reason: 'error' }); }
  await db.prepare('INSERT OR REPLACE INTO trailers (id, yt, title, at) VALUES (?1, ?2, ?3, ?4)').bind(id, res ? res.yt : null, res ? res.title : null, Date.now()).run();
  return json(res || { yt: null });
}
