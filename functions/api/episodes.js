// GET /api/episodes?id=&name=&year= -> seasons with episode counts + next airing episode (TVmaze), cached 12h in D1.
import { json, authorized, ensureSchema } from './state.js';
import { getJSON, tvSearch } from './posters.js';

async function build(name, year) {
  let target = 1;
  let show = null;
  const m = name.match(/^(.*?)(?:\s+Class)?\s+(\d)$/);
  if (m && +m[2] > 1) { show = await tvSearch(m[1], null, 3); if (show) target = +m[2]; }
  if (!show) show = await tvSearch(name, year);
  if (!show) return null;
  const all = (await getJSON(`https://api.tvmaze.com/shows/${show.id}/episodes`)) || [];
  const regular = all.filter((e) => e.type !== 'insignificant_special' && e.number != null);
  const seasons = {};
  for (const e of regular) {
    const s = (seasons[e.season] = seasons[e.season] || { season: e.season, total: 0, aired: 0 });
    s.total++;
    if (e.airstamp && Date.parse(e.airstamp) <= Date.now()) s.aired++;
  }
  const next = regular.filter((e) => e.airstamp && Date.parse(e.airstamp) > Date.now()).sort((a, b) => Date.parse(a.airstamp) - Date.parse(b.airstamp))[0];
  const list = Object.values(seasons).sort((a, b) => a.season - b.season);
  // Prefer the announced episode order when TVmaze knows more episodes than it has listed.
  const so = (await getJSON(`https://api.tvmaze.com/shows/${show.id}/seasons`)) || [];
  for (const s of list) { const x = so.find((z) => z.number === s.season); if (x && x.episodeOrder > s.total) s.total = x.episodeOrder; }
  return {
    tvmaze: show.id,
    defaultSeason: list.some((s) => s.season === target) ? target : (list[0] ? list[0].season : 1),
    seasons: list,
    status: show.status,
    next: next ? { season: next.season, number: next.number, airstamp: next.airstamp } : null,
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  const q = new URL(request.url).searchParams;
  const id = Number(q.get('id')), name = (q.get('name') || '').slice(0, 80), year = Number(q.get('year')) || null;
  if (!Number.isInteger(id) || id < 1 || !name) return json({ error: 'bad_input' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  const row = await db.prepare('SELECT data, at FROM epinfo WHERE id = ?1').bind(id).first();
  if (row && Date.now() - row.at < 12 * 3600 * 1000) return json(JSON.parse(row.data || 'null') || { seasons: [] });
  let data = null;
  try { data = await build(name, year); } catch { if (row) return json(JSON.parse(row.data || 'null') || { seasons: [] }); return json({ error: 'lookup_failed' }, 502); }
  await db.prepare('INSERT OR REPLACE INTO epinfo (id, data, at) VALUES (?1, ?2, ?3)').bind(id, JSON.stringify(data), Date.now()).run();
  return json(data || { seasons: [] });
}
