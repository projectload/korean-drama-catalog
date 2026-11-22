// Cloudflare Pages Function: shared watch-state storage in D1.
// Bindings: DB (D1 database). Env var: ACCESS_KEY (secret part of the private link).

const VALID = new Set(['none', 'watching', 'seen']);

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function authorized(request, env) {
  if (!env.ACCESS_KEY) return true;
  return request.headers.get('x-key') === String(env.ACCESS_KEY);
}

export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const n = v.trim().replace(/\s+/g, ' ');
  return n.length >= 1 && n.length <= 30 ? n : null;
}

export async function ensureSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS log (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, state TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS hidden (id INTEGER PRIMARY KEY, by TEXT, at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS posters (id INTEGER PRIMARY KEY, url TEXT, source TEXT, by TEXT, at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS shows (id INTEGER PRIMARY KEY, name TEXT NOT NULL, year INTEGER, genre TEXT, poster TEXT, added_by TEXT, added_at INTEGER NOT NULL)'),
  ]);
  try {
    await db.prepare('ALTER TABLE states ADD COLUMN updated_by TEXT').run();
  } catch {
    /* column already exists */
  }
}

export async function snapshot(db) {
  const [st, lg, us, sh, po, hd] = await db.batch([
    db.prepare("SELECT id, state, updated_at, updated_by FROM states WHERE state != 'none' OR updated_by IS NOT NULL"),
    db.prepare('SELECT id, state, by, at FROM log ORDER BY rowid DESC LIMIT 150'),
    db.prepare('SELECT name, last_seen FROM users ORDER BY last_seen DESC'),
    db.prepare('SELECT id, name, year, genre, poster, added_by, added_at FROM shows ORDER BY id'),
    db.prepare('SELECT id, url FROM posters'),
    db.prepare('SELECT id, by, at FROM hidden ORDER BY at DESC'),
  ]);
  const posters = {};
  for (const r of po.results) posters[r.id] = r.url;
  const states = {};
  for (const r of st.results) states[r.id] = { s: r.state, by: r.updated_by || null, at: r.updated_at };
  return {
    states,
    log: lg.results.map((r) => ({ id: r.id, s: r.state, by: r.by, at: r.at })),
    users: us.results.map((r) => ({ name: r.name, at: r.last_seen })),
    posters,
    hidden: hd.results.map((r) => ({ id: r.id, by: r.by, at: r.at })),
    custom: sh.results.map((r) => ({ id: r.id, name: r.name, year: r.year, genre: r.genre, poster: r.poster, by: r.added_by, at: r.added_at })),
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  await ensureSchema(env.DB);
  const me = cleanName(decodeURIComponent(request.headers.get('x-user') || ''));
  if (me) await env.DB.prepare('INSERT INTO users (name, last_seen) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen').bind(me, Date.now()).run();
  return json(await snapshot(env.DB));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const by = cleanName(body && body.by);
  if (!by) return json({ error: 'name' }, 400);

  // Accept {id, state} or {states: {id: state}} (bulk restore).
  const entries = body.states ? Object.entries(body.states) : [[body.id, body.state]];
  const now = Date.now();
  const db = env.DB;
  const stmts = [];
  for (const [rawId, raw] of entries) {
    const id = Number(rawId);
    const state = raw && typeof raw === 'object' ? raw.s : raw;
    if (!Number.isInteger(id) || id < 1 || id > 10000000 || !VALID.has(state)) continue;
    stmts.push(
      db.prepare(
        'INSERT INTO states (id, state, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
      ).bind(id, state, now, by),
      db.prepare('INSERT INTO log (id, state, by, at) VALUES (?1, ?2, ?3, ?4)').bind(id, state, by, now)
    );
  }
  if (!stmts.length) return json({ error: 'nothing_valid' }, 400);
  stmts.push(db.prepare('INSERT INTO users (name, last_seen) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen').bind(by, now));

  await ensureSchema(db);
  await db.batch(stmts);
  return json({ ok: true, ...(await snapshot(db)) });
}
