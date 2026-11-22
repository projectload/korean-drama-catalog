// Cloudflare Pages Function: shared watch-state storage in D1.
// Bindings: DB (D1 database). Optional env var: EDIT_PIN (shared secret).

const VALID = new Set(['none', 'watching', 'seen']);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function authorized(request, env) {
  if (!env.EDIT_PIN) return true;
  return request.headers.get('x-pin') === String(env.EDIT_PIN);
}

async function ensureTable(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS states (id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    .run();
}

async function readAll(db) {
  const { results } = await db.prepare('SELECT id, state FROM states').all();
  const states = {};
  for (const r of results) if (r.state !== 'none') states[r.id] = r.state;
  return states;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'pin' }, 401);
  await ensureTable(env.DB);
  return json({ states: await readAll(env.DB) });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'pin' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  // Accept either {id, state} or {states: {id: state, ...}} (bulk import).
  const entries = body && body.states ? Object.entries(body.states) : [[body && body.id, body && body.state]];
  const now = Date.now();
  const stmts = [];
  for (const [rawId, state] of entries) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || id > 10000 || !VALID.has(state)) continue;
    stmts.push(
      env.DB.prepare(
        'INSERT INTO states (id, state, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at'
      ).bind(id, state, now)
    );
  }
  if (!stmts.length) return json({ error: 'nothing_valid' }, 400);

  await ensureTable(env.DB);
  await env.DB.batch(stmts);
  return json({ ok: true, states: await readAll(env.DB) });
}
