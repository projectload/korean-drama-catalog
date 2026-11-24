// TMDB helpers (key stored in D1 config 'tmdb', or env TMDB_KEY).
const IMG = 'https://image.tmdb.org/t/p/w342';
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function tmdbKey(db, env) {
  if (env.TMDB_KEY) return env.TMDB_KEY;
  try {
    const row = await db.prepare("SELECT v FROM config WHERE k = 'tmdb'").first();
    return row ? row.v : null;
  } catch { return null; }
}

async function get(path, key, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { cf: { cacheTtl: 86400 } });
  if (r.status === 429 || r.status >= 500) throw new Error('retry');
  return r.ok ? r.json() : null;
}

export async function tmdbCheck(key) {
  const r = await fetch('https://api.themoviedb.org/3/configuration?api_key=' + encodeURIComponent(key));
  return r.ok;
}

// Find the best TMDB TV match for a name (+year), preferring Korean originals.
export async function tmdbFind(name, year, key) {
  const tries = [{ query: name, first_air_date_year: year || undefined }, { query: name }];
  const m = name.match(/^(.*?)(?:\s+Class)?\s+(\d)$/);
  let best = null, bs = 0;
  for (const p of tries) {
    const res = await get('/search/tv', key, { ...p, include_adult: 'false', language: 'en-US' });
    for (const x of (res && res.results) || []) {
      let sc = 0;
      const n = norm(x.name), on = norm(x.original_name), q = norm(name);
      if (n === q || on === q) sc += 3; else if (n.startsWith(q) || q.startsWith(n)) sc += 1;
      const y = parseInt(x.first_air_date);
      if (year && y && Math.abs(y - year) <= 1) sc += 2;
      if (x.original_language === 'ko' || (x.origin_country || []).includes('KR')) sc += 2;
      if (x.poster_path) sc += 0.5;
      sc += Math.min(1, (x.popularity || 0) / 50);
      if (sc > bs) { bs = sc; best = x; }
    }
    if (bs >= 5) break;
  }
  if (!best || bs < 4) return null;
  const [ar, en] = await Promise.all([get(`/tv/${best.id}`, key, { language: 'ar-SA' }), get(`/tv/${best.id}`, key, { language: 'en-US' })]);
  let seasonPoster = null, seasonOverviewAr = null;
  if (m && +m[2] > 1) {
    const s = await get(`/tv/${best.id}/season/${m[2]}`, key, { language: 'ar-SA' }).catch(() => null);
    if (s) { seasonPoster = s.poster_path ? IMG + s.poster_path : null; seasonOverviewAr = (s.overview || '').trim() || null; }
  }
  const overviewAr = seasonOverviewAr || ((ar && ar.overview) || '').trim() || null;
  return {
    id: best.id,
    overviewAr: overviewAr && /[؀-ۿ]/.test(overviewAr) ? overviewAr : null,
    overviewEn: ((en && en.overview) || '').trim() || null,
    poster: seasonPoster || (best.poster_path ? IMG + best.poster_path : null),
    rating: en && en.vote_count >= 10 ? Math.round(en.vote_average * 10) / 10 : null,
    network: en && en.networks && en.networks[0] ? en.networks[0].name : null,
    genres: en && en.genres ? en.genres.map((g) => g.name) : [],
    episodes: en ? en.number_of_episodes : null,
  };
}

export async function tmdbSearchPosters(q, key) {
  const res = await get('/search/tv', key, { query: q, include_adult: 'false' });
  const out = [];
  for (const x of ((res && res.results) || []).slice(0, 6)) {
    if (x.poster_path) out.push({ u: IMG + x.poster_path, label: 'TMDB: ' + x.name + ' ' + (x.first_air_date || '').slice(0, 4) });
  }
  return out;
}

// Best YouTube trailer for a TMDB TV id (Korean/English/Arabic), official trailers first.
export async function tmdbTrailer(tvId, key, season) {
  const paths = [];
  if (season && season > 1) paths.push(`/tv/${tvId}/season/${season}/videos`);
  paths.push(`/tv/${tvId}/videos`);
  for (const p of paths) {
    const r = await get(p, key, { include_video_language: 'ko,en,ar,null' });
    const vids = ((r && r.results) || []).filter((v) => v.site === 'YouTube' && v.key);
    const score = (v) => (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 2 : 0) + (v.iso_639_1 === 'ar' ? 1 : 0);
    vids.sort((a, b) => score(b) - score(a) || (b.size || 0) - (a.size || 0));
    if (vids.length && score(vids[0]) >= 2) return { yt: vids[0].key, title: vids[0].name };
  }
  return null;
}
