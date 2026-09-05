/* ============================================================================
   OSIRIS · GSD PROXY — Cloudflare Worker
   ----------------------------------------------------------------------------
   Doel: de browser (Osiris ShockWave) kan geen bronnen ophalen die CORS
   blokkeren. Deze Worker haalt ze server-side op, zet CORS-headers, en spuit
   FRED/ACLED-keys erin die NOOIT naar de browser gaan (Cloudflare Secrets).

   De app roept aan:   <worker-url>/pass?url=<ge-encodeerde https-URL>
   (bv. https://oif-gsd-proxy.thailand-kpx.workers.dev/pass?url=...)

   Alleen hosts op de ALLOW-lijst worden doorgelaten (veiligheid).
   ============================================================================ */

// --- ALLOW-LIST: alleen deze hosts mag de proxy ophalen -----------------------
const ALLOW = new Set([
  'api.gdeltproject.org',      // GDELT — geopolitiek / mediatoon
  'api.stlouisfed.org',        // FRED — financiële condities (heeft FRED_API_KEY nodig)
  'data-api.ecb.europa.eu',    // ECB — systeemstress (CISS)
  'api.acleddata.com',         // ACLED — gewapende conflicten (heeft ACLED_KEY + ACLED_EMAIL nodig)
  'dataservices.imf.org',      // IMF — Balance of Payments (kapitaalstroom)
  'stooq.com',                 // Stooq — live grondstoffen (WTI/Brent/gas/goud/koper/tarwe)
  'www.cpc.ncep.noaa.gov',     // NOAA CPC — Oceanic Niño Index (El Niño/La Niña)
  'stats.bis.org',             // BIS — credit-to-GDP gap (systeemrisico)
  // (USGS, NASA EONET, GDACS, Open-Meteo, World Bank en NOAA SWPC halen browser-direct
  //  op en hoeven hier NIET bij — voeg ze alleen toe als je ze ooit via de proxy routeert.)
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',            // wil je strenger? zet hier je eigen domein
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    // preflight
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (pathname !== '/pass') {
      return new Response('Osiris GSD proxy — use /pass?url=<https url>', { status: 200, headers: CORS });
    }

    const target = searchParams.get('url');
    if (!target) return json({ error: 'missing url' }, 400);

    let u;
    try { u = new URL(target); } catch { return json({ error: 'bad url' }, 400); }
    if (u.protocol !== 'https:') return json({ error: 'https only' }, 400);
    if (!ALLOW.has(u.hostname)) return json({ error: 'host not allowed: ' + u.hostname }, 403);

    // --- keys server-side injecteren (gaan nooit naar de browser) ---
    if (u.hostname === 'api.stlouisfed.org') {
      if (env.FRED_API_KEY && !u.searchParams.get('api_key')) u.searchParams.set('api_key', env.FRED_API_KEY);
      if (!u.searchParams.get('file_type')) u.searchParams.set('file_type', 'json'); // FRED geeft anders XML
    }
    if (u.hostname === 'api.acleddata.com') {
      if (env.ACLED_KEY && !u.searchParams.get('key')) u.searchParams.set('key', env.ACLED_KEY);
      if (env.ACLED_EMAIL && !u.searchParams.get('email')) u.searchParams.set('email', env.ACLED_EMAIL);
    }

    // --- ophalen (met korte edge-cache zodat je de bronnen niet belast) ---
    let resp;
    try {
      resp = await fetch(u.toString(), {
        headers: { 'User-Agent': 'Osiris-GSD/1.0 (+cloudflare-worker)', 'Accept': '*/*' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + e.message }, 502);
    }

    // body 1-op-1 terug, mét CORS en het originele content-type (JSON, CSV of tekst)
    const headers = new Headers(CORS);
    const ct = resp.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('cache-control', 'public, max-age=300');
    return new Response(resp.body, { status: resp.status, headers });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
