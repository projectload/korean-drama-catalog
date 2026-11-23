// PIN login for the app.
// POST /api/pin?login {pin}        -> {key} if the PIN is right (5 wrong tries per IP => 15 min lock)
// POST /api/pin?set   {pin, by}    -> set/change the PIN (needs the access key)
// GET  /api/pin                    -> {set: bool}
import { json, authorized, cleanName, ensureSchema } from './state.js';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hash = async (salt, pin) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)));
const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);

async function getPin(db) {
  const row = await db.prepare("SELECT v FROM config WHERE k = 'pin'").first();
  return row ? JSON.parse(row.v) : null;
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  await ensureSchema(env.DB);
  return json({ set: !!(await getPin(env.DB)) });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  const db = env.DB;
  await ensureSchema(db);
  const q = new URL(request.url).searchParams;
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  if (q.has('set')) {
    if (!authorized(request, env)) return json({ error: 'key' }, 401);
    const by = cleanName(b.by);
    if (!by || !validPin(b.pin)) return json({ error: 'bad_pin' }, 400);
    const salt = crypto.randomUUID();
    await db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('pin', ?1)").bind(JSON.stringify({ salt, h: await hash(salt, b.pin), by, at: Date.now() })).run();
    return json({ ok: true });
  }

  // login
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const att = await db.prepare('SELECT n, until FROM attempts WHERE ip = ?1').bind(ip).first();
  if (att && att.until > now) return json({ error: 'locked', wait: Math.ceil((att.until - now) / 60000) }, 429);
  const stored = await getPin(db);
  if (!stored) return json({ error: 'no_pin' }, 409);
  if (validPin(b.pin) && (await hash(stored.salt, b.pin)) === stored.h) {
    await db.prepare('DELETE FROM attempts WHERE ip = ?1').bind(ip).run();
    return json({ ok: true, key: env.ACCESS_KEY || '' });
  }
  const n = (att && att.until <= now && att.n >= 5 ? 0 : (att ? att.n : 0)) + 1;
  const until = n >= 5 ? now + 15 * 60000 : 0;
  await db.prepare('INSERT OR REPLACE INTO attempts (ip, n, until) VALUES (?1, ?2, ?3)').bind(ip, n, until).run();
  return json({ error: 'wrong', left: Math.max(0, 5 - n), locked: n >= 5 }, 401);
}
