// POST /api/translate {text} -> {ar}
import { json, authorized } from './state.js';
import { translate } from './summary.js';
export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ error: 'key' }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const text = typeof b.text === 'string' ? b.text.slice(0, 1500) : '';
  if (!text) return json({ ar: null });
  let ar = null;
  try { ar = await translate(text); } catch {}
  return json({ ar });
}
