// POST /api/episode {id, season, ep, total, by} -> shared episode progress (watched together).
import { json, authorized, cleanName, ensureSchema, snapshot } from './state.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const by = cleanName(b && b.by);
  const id = Number(b.id), season = Number(b.season) || 1, ep = Number(b.ep);
  const total = Number.isInteger(Number(b.total)) && Number(b.total) > 0 ? Number(b.total) : null;
  if (!by || !Number.isInteger(id) || id < 1 || !Number.isInteger(ep) || ep < 0 || ep > 500 || season < 1 || season > 50)
    return json({ error: 'bad_input' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  const now = Date.now();
  const stmts = [
    db.prepare('INSERT INTO eps (id, season, ep, total, by, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO UPDATE SET season = excluded.season, ep = excluded.ep, total = COALESCE(excluded.total, eps.total), by = excluded.by, at = excluded.at')
      .bind(id, season, ep, total, by, now),
  ];
  // One activity line per show/person/session: update the last progress entry if it is recent, else add one.
  const last = await db.prepare("SELECT rowid, id, by, state, at FROM log ORDER BY rowid DESC LIMIT 1").first();
  const tag = 'ep' + ep + (season > 1 ? 's' + season : '');
  if (last && last.id === id && last.by === by && /^ep\d+/.test(last.state) && now - last.at < 3 * 3600 * 1000)
    stmts.push(db.prepare('UPDATE log SET state = ?2, at = ?3 WHERE rowid = ?1').bind(last.rowid, tag, now));
  else if (ep > 0) stmts.push(db.prepare('INSERT INTO log (id, state, by, at) VALUES (?1, ?2, ?3, ?4)').bind(id, tag, by, now));
  await db.batch(stmts);
  return json({ ok: true, ...(await snapshot(db)) });
}
