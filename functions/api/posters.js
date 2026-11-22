// Shared posters stored in D1.
// POST /api/posters        {id, url, by}  -> set a poster manually
// POST /api/posters?resolve {ids:[...]}   -> look up posters (TVmaze, season images, Wikipedia) on the server
import { json, authorized, cleanName, ensureSchema, snapshot } from './state.js';

const UA = { 'user-agent': 'korean-drama-catalog/1.0 (personal watch list)' };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isKR = (sh) => {
  const c = (sh.network && sh.network.country && sh.network.country.code) || (sh.webChannel && sh.webChannel.country && sh.webChannel.country.code);
  return c === 'KR' || sh.language === 'Korean';
};
const getJSON = async (url) => {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 86400 } });
  if (r.status === 429 || r.status >= 500) throw new Error('retry');
  return r.ok ? r.json() : null;
};

async function tvSearch(name, year, minScore = 4) {
  const arr = (await getJSON('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(name))) || [];
  let best = null, bs = 0;
  for (const { show: sh } of arr) {
    let sc = 0;
    if (norm(sh.name) === norm(name)) sc += 3;
    else if (norm(sh.name).includes(norm(name)) || norm(name).includes(norm(sh.name))) sc += 1;
    const y = parseInt(sh.premiered);
    if (year && y && Math.abs(y - year) <= 1) sc += 2;
    if (isKR(sh)) sc += 2;
    if (sh.image) sc += 0.5;
    if (sc > bs) { bs = sc; best = sh; }
  }
  return bs >= minScore ? best : null;
}

async function seasonImage(base, n) {
  const sh = await tvSearch(base, null, 3);
  if (!sh) return null;
  const seasons = (await getJSON(`https://api.tvmaze.com/shows/${sh.id}/seasons`)) || [];
  const s = seasons.find((x) => x.number === n);
  return s && s.image ? s.image.medium : null;
}

async function wiki(name, year) {
  const q = `${name} ${year || ''} South Korean television series`;
  const j = await getJSON(
    'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&prop=pageimages&pilicense=any&piprop=thumbnail&pithumbsize=400&gsrsearch=' +
      encodeURIComponent(q)
  );
  const pages = Object.values((j && j.query && j.query.pages) || {}).sort((a, b) => a.index - b.index);
  const first = norm(name).split(' ')[0];
  for (const p of pages) if (p.thumbnail && norm(p.title).includes(first)) return p.thumbnail.source.split('?')[0];
  return null;
}

async function resolve(name, year) {
  let failed = false;
  const m = name.match(/^(.*?)(?:\s+Class)?\s+(\d)$/);
  if (m && +m[2] > 1) {
    try { const u = await seasonImage(m[1], +m[2]); if (u) return [u, 'tvmaze-season']; } catch { failed = true; }
  }
  try { const sh = await tvSearch(name, year); if (sh && sh.image) return [sh.image.medium, 'tvmaze']; } catch { failed = true; }
  try { const u = await wiki(name, year); if (u) return [u, 'wikipedia']; } catch { failed = true; }
  return [null, failed ? 'retry' : 'none'];
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const db = env.DB;
  await ensureSchema(db);
  const now = Date.now();

  if (new URL(request.url).searchParams.has('resolve')) {
    const items = Array.isArray(b.items) ? b.items.slice(0, 6) : [];
    const stmts = [];
    for (const it of items) {
      const id = Number(it.id);
      const name = typeof it.name === 'string' ? it.name.slice(0, 80) : '';
      if (!Number.isInteger(id) || id < 1 || !name) continue;
      const [url, source] = await resolve(name, Number(it.year) || null);
      if (source === 'retry') continue; // temporary error: leave it for a later attempt
      stmts.push(
        db.prepare('INSERT INTO posters (id, url, source, by, at) VALUES (?1, ?2, ?3, NULL, ?4) ON CONFLICT(id) DO NOTHING').bind(id, url, source, now)
      );
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, ...(await snapshot(db)) });
  }

  const by = cleanName(b.by);
  const id = Number(b.id);
  const url = typeof b.url === 'string' ? b.url.trim().slice(0, 500) : '';
  if (!by || !Number.isInteger(id) || id < 1 || !/^https:\/\//.test(url)) return json({ error: 'bad_input' }, 400);
  await db
    .prepare("INSERT INTO posters (id, url, source, by, at) VALUES (?1, ?2, 'manual', ?3, ?4) ON CONFLICT(id) DO UPDATE SET url = excluded.url, source = 'manual', by = excluded.by, at = excluded.at")
    .bind(id, url, by, now)
    .run();
  return json({ ok: true, ...(await snapshot(db)) });
}
