/* ==================================================================================
   OSIRIS · FSO-GSD PROXY  —  Cloudflare Worker
   ----------------------------------------------------------------------------------
   Generic, allow-listed, cached passthrough so the browser (GitHub Pages) can reach
   data sources that block CORS or need a server-side key. The dashboard calls:
       <worker>/pass?url=<encoded target URL>
   and this worker fetches the target, injects any secret keys server-side, caches the
   result (to protect rate limits), and returns it with permissive CORS headers.

   Sources enabled here (all free):
     • GDELT   (geopolitics / tone)         — no key
     • ECB     (Data Portal, e.g. CISS)     — no key
     • World Bank / USGS / EONET / Open-Meteo (also CORS-open, but allowed here too)
     • FRED    (VIX / NFCI / commodities)   — free key  → set secret FRED_KEY
     • ACLED   (armed-conflict events)      — free key  → set secrets ACLED_KEY + ACLED_EMAIL

   Deploy: paste into a new Worker (e.g. "oif-gsd-proxy"), add the optional secrets,
   then paste the Worker URL into the FSO-GSD tab → "GSD proxy URL".
   NOTE: keep this SEPARATE from your capital proxy (own rate limits, no trading code).
   ================================================================================== */

const ALLOW = new Set([
  'api.gdeltproject.org',
  'api.stlouisfed.org',        // FRED
  'data-api.ecb.europa.eu',    // ECB Data Portal (SDMX JSON)
  'sdw-wsrest.ecb.europa.eu',  // ECB legacy SDW
  'api.acleddata.com',         // ACLED
  'api.worldbank.org',
  'earthquake.usgs.gov',
  'eonet.gsfc.nasa.gov',
  'api.open-meteo.com',
  'archive-api.open-meteo.com',
  'api.frankfurter.dev',
  'www.gdacs.org'
]);

const CACHE_TTL = 300; // seconds — protects source rate limits; the dashboard polls gently anyway

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('X-Osiris-Proxy', 'gsd');
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status) {
  return cors(new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } }));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'osiris-gsd-proxy', ts: Date.now(),
        keys: { fred: !!env.FRED_KEY, acled: !!(env.ACLED_KEY && env.ACLED_EMAIL) },
        allow: [...ALLOW] });
    }
    if (url.pathname !== '/pass') return json({ error: 'use /pass?url=<encoded target>' }, 400);

    const target = url.searchParams.get('url');
    if (!target) return json({ error: 'missing url param' }, 400);
    let t;
    try { t = new URL(target); } catch (e) { return json({ error: 'invalid url' }, 400); }
    if (t.protocol !== 'https:') return json({ error: 'https only' }, 400);
    if (!ALLOW.has(t.hostname)) return json({ error: 'host not allowed: ' + t.hostname }, 403);

    // inject secret keys server-side (never in the browser)
    if (t.hostname === 'api.stlouisfed.org') {
      if (env.FRED_KEY) t.searchParams.set('api_key', env.FRED_KEY);
      if (!t.searchParams.get('file_type')) t.searchParams.set('file_type', 'json');
    }
    if (t.hostname === 'api.acleddata.com') {
      if (env.ACLED_KEY) t.searchParams.set('key', env.ACLED_KEY);
      if (env.ACLED_EMAIL) t.searchParams.set('email', env.ACLED_EMAIL);
    }

    const finalUrl = t.toString();
    const cache = caches.default;
    const cacheKey = new Request(finalUrl, { method: 'GET' });
    let hit = await cache.match(cacheKey);
    if (hit) return cors(hit);

    try {
      const r = await fetch(finalUrl, {
        headers: { 'User-Agent': 'osiris-gsd-proxy/1.0 (+github-pages dashboard)', 'Accept': 'application/json,text/plain,*/*' },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      });
      const body = await r.text();
      const ct = r.headers.get('content-type') || 'application/json';
      const out = new Response(body, { status: r.status, headers: { 'content-type': ct, 'Cache-Control': 'max-age=' + CACHE_TTL } });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return cors(out);
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + e.message }, 502);
    }
  }
};
