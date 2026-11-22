// GET /api/discover -> new & upcoming series from the TVmaze schedule (Korean + worldwide streaming), cached ~6h at the edge.
import { json, authorized } from './state.js';

const UA = { 'user-agent': 'korean-drama-catalog/1.0 (personal watch list)' };
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const get = async (url) => {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 21600, cacheEverything: true } });
  return r.ok ? r.json() : [];
};
const isKR = (sh) => {
  const c = (sh.network && sh.network.country && sh.network.country.code) || (sh.webChannel && sh.webChannel.country && sh.webChannel.country.code);
  return c === 'KR' || sh.language === 'Korean';
};
const plain = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

function pack(ep, sh) {
  return {
    tvmaze: sh.id,
    name: sh.name,
    year: (sh.premiered || ep.airdate || '').slice(0, 4),
    premiered: sh.premiered || null,
    airdate: ep.airdate || (ep.airstamp || '').slice(0, 10),
    season: ep.season,
    number: ep.number,
    network: (sh.network && sh.network.name) || (sh.webChannel && sh.webChannel.name) || null,
    country: (sh.network && sh.network.country && sh.network.country.name) || (sh.webChannel && sh.webChannel.country && sh.webChannel.country.name) || null,
    image: sh.image ? sh.image.medium : null,
    genres: sh.genres || [],
    rating: sh.rating && sh.rating.average,
    language: sh.language,
    summary: plain(sh.summary).slice(0, 1200),
    weight: sh.weight || 0,
  };
}

export async function onRequestGet({ request, env, waitUntil }) {
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  const cache = caches.default;
  const cacheKey = new Request('https://cache.local/discover-v1-' + day(0));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const dates = [];
  for (let i = -10; i <= 10; i++) dates.push(day(i));
  const kr = new Map(), world = new Map();
  const add = (map, ep, sh) => {
    if (!sh || sh.type === 'News' || sh.type === 'Talk Show' || sh.type === 'Variety' || sh.type === 'Reality' || sh.type === 'Game Show' || sh.type === 'Sports') return;
    const isPremiere = ep.season === 1 && ep.number === 1;
    const prev = map.get(sh.id);
    const item = pack(ep, sh);
    item.isPremiere = isPremiere;
    if (!prev || (isPremiere && !prev.isPremiere)) map.set(sh.id, item);
  };

  const jobs = [];
  for (const d of dates) {
    jobs.push(get(`https://api.tvmaze.com/schedule?country=KR&date=${d}`).then((list) => list.forEach((ep) => add(kr, ep, ep.show))));
    jobs.push(get(`https://api.tvmaze.com/schedule/web?date=${d}`).then((list) => list.forEach((ep) => {
      const sh = ep._embedded && ep._embedded.show;
      if (!sh) return;
      add(isKR(sh) ? kr : world, ep, sh);
    })));
  }
  await Promise.allSettled(jobs);

  const today = day(0);
  const finish = (map, minWeight) => {
    const all = [...map.values()].filter((x) => x.image);
    // New = first episode within the window (past 10 days or next 10 days).
    const fresh = all.filter((x) => x.isPremiere && x.weight >= minWeight).sort((a, b) => (b.airdate > a.airdate ? 1 : -1));
    const upcoming = fresh.filter((x) => x.airdate > today).sort((a, b) => (a.airdate > b.airdate ? 1 : -1));
    const out = fresh.filter((x) => x.airdate <= today);
    return { new: out.slice(0, 25), upcoming: upcoming.slice(0, 15) };
  };
  const body = { updated: new Date().toISOString(), korean: finish(kr, 0), world: finish(world, 60) };
  const res = json(body);
  res.headers.set('cache-control', 'public, max-age=21600');
  const put = cache.put(cacheKey, res.clone());
  if (waitUntil) waitUntil(put); else await put;
  return res;
}
