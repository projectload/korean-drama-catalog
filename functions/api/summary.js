// GET /api/summary?id=&name=&year=  -> {ar, en, meta}
// Looks the show up on TVmaze once, translates the summary to Arabic, and caches it in D1 for everyone.
import { json, authorized, ensureSchema } from './state.js';
import { getJSON, tvSearch } from './posters.js';

const strip = (h) =>
  String(h || '')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim();

async function translate(text) {
  if (!text) return null;
  const out = [];
  // Translate paragraph by paragraph to stay within URL limits.
  for (const part of text.split(/\n\n+/)) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=' + encodeURIComponent(part.slice(0, 1800));
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    out.push((j[0] || []).map((x) => x[0]).join(''));
  }
  return out.join('\n\n').trim() || null;
}

async function lookup(name, year) {
  let show = null, season = null;
  const m = name.match(/^(.*?)(?:\s+Class)?\s+(\d)$/);
  if (m && +m[2] > 1) {
    show = await tvSearch(m[1], null, 3);
    if (show) {
      const ss = (await getJSON(`https://api.tvmaze.com/shows/${show.id}/seasons`)) || [];
      season = ss.find((x) => x.number === +m[2]) || null;
    }
  }
  if (!show) show = await tvSearch(name, year);
  if (!show) return null;
  const en = strip((season && season.summary) || show.summary);
  const meta = {
    network: (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || null,
    country: (show.network && show.network.country && show.network.country.name) || (show.webChannel && show.webChannel.country && show.webChannel.country.name) || null,
    genres: show.genres || [],
    rating: show.rating && show.rating.average,
    status: show.status || null,
    premiered: (season && season.premiereDate) || show.premiered || null,
    episodes: season ? season.episodeOrder : null,
    url: show.url || null,
  };
  return { en, meta };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  const q = new URL(request.url).searchParams;
  const id = Number(q.get('id'));
  const name = (q.get('name') || '').slice(0, 80);
  const year = Number(q.get('year')) || null;
  if (!Number.isInteger(id) || id < 1 || !name) return json({ error: 'bad_input' }, 400);
  const db = env.DB;
  await ensureSchema(db);
  const row = await db.prepare('SELECT ar, en, meta FROM summaries WHERE id = ?1').bind(id).first();
  if (row && (row.ar || !row.en)) return json({ ar: row.ar, en: row.en, meta: JSON.parse(row.meta || '{}'), cached: true });

  let found;
  try { found = row ? { en: row.en, meta: JSON.parse(row.meta || '{}') } : await lookup(name, year); }
  catch { return json({ error: 'lookup_failed' }, 502); }
  if (!found) {
    await db.prepare('INSERT OR REPLACE INTO summaries (id, ar, en, meta, at) VALUES (?1, NULL, NULL, ?2, ?3)').bind(id, '{}', Date.now()).run();
    return json({ ar: null, en: null, meta: {} });
  }
  let ar = null;
  try { ar = await translate(found.en); } catch {}
  await db.prepare('INSERT OR REPLACE INTO summaries (id, ar, en, meta, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, ar, found.en || null, JSON.stringify(found.meta), Date.now()).run();
  return json({ ar, en: found.en || null, meta: found.meta });
}
