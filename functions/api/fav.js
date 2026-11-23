// POST /api/fav {id, by, on} -> add/remove a favourite for this person.
import { json, authorized, cleanName, ensureSchema, snapshot } from './state.js';
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const by = cleanName(b && b.by), id = Number(b && b.id);
  if (!by || !Number.isInteger(id) || id < 1) return json({ error: 'bad_input' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  if (b.on) await db.prepare('INSERT OR IGNORE INTO favs (id, by, at) VALUES (?1, ?2, ?3)').bind(id, by, Date.now()).run();
  else await db.prepare('DELETE FROM favs WHERE id = ?1 AND by = ?2').bind(id, by).run();
  return json({ ok: true, ...(await snapshot(db)) });
}
