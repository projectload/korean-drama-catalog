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

function chunks(text, max) {
  const out = [];
  for (const para of text.split(/\n\n+/)) {
    let cur = '';
    for (const sent of para.match(/[^.!?]+[.!?]*\s*/g) || [para]) {
      if ((cur + sent).length > max && cur) { out.push(cur.trim()); cur = ''; }
      cur += sent;
    }
    if (cur.trim()) out.push(cur.trim());
    out.push('\n\n');
  }
  return out;
}

async function viaGoogle(part) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=' + encodeURIComponent(part), { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('g' + r.status);
  const j = await r.json();
  const t = (j[0] || []).map((x) => x[0]).join('');
  if (!t) throw new Error('g-empty');
  return t;
}

async function viaMyMemory(part) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|ar&q=' + encodeURIComponent(part));
  if (!r.ok) throw new Error('m' + r.status);
  const j = await r.json();
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t || j.responseStatus !== 200 || /MYMEMORY WARNING/i.test(t)) throw new Error('m-bad');
  return t;
}

export async function translate(text) {
  if (!text) return null;
  for (const engine of [viaGoogle, viaMyMemory]) {
    try {
      let out = '';
      for (const c of chunks(text, engine === viaMyMemory ? 450 : 1500)) out += c === '\n\n' ? c : (await engine(c)) + ' ';
      out = out.replace(/ +\n/g, '\n').trim();
      if (/[\u0600-\u06FF]/.test(out)) return out;
    } catch {}
  }
  return null;
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

// POST /api/summary {id, ar}: store an Arabic translation made on the device when the server could not translate.
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = Number(b && b.id);
  const ar = typeof b.ar === 'string' ? b.ar.trim().slice(0, 6000) : '';
  if (!Number.isInteger(id) || id < 1 || !/[\u0600-\u06FF]/.test(ar)) return json({ error: 'bad_input' }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare('UPDATE summaries SET ar = ?2 WHERE id = ?1 AND ar IS NULL').bind(id, ar).run();
  return json({ ok: true });
}
