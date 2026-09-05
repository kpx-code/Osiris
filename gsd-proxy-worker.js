/* ============================================================================
   OSIRIS · GSD PROXY — Cloudflare Worker  (veilige drop-in vervanging)
   ----------------------------------------------------------------------------
   Bevat AL je bestaande hosts (uit je /status) PLUS de 4 nieuwe, dus je kunt
   deze veilig 1-op-1 plakken zonder iets te breken.

   Route:   <worker-url>/pass?url=<ge-encodeerde https-URL>
   Status:  <worker-url>/            → JSON met keys + allowlist

   Keys (FRED/ACLED) staan als Cloudflare Secret in env en gaan NOOIT naar de browser.
   ============================================================================ */

const ALLOW = new Set([
  // --- je bestaande hosts ---
  'api.gdeltproject.org',      // GDELT — geopolitiek / tone
  'api.stlouisfed.org',        // FRED — condities + TIC + Fed Z.1 (FRED_API_KEY)
  'data-api.ecb.europa.eu',    // ECB — CISS (nieuwe API)
  'sdw-srest.ecb.europa.eu',   // ECB — SDW (oude API)
  'api.acleddata.com',         // ACLED — conflicten (ACLED_KEY + ACLED_EMAIL)
  'api.worldbank.org',         // World Bank — macro
  'earthquake.usgs.gov',       // USGS — aardbevingen
  'eonet.gsfc.nasa.gov',       // NASA EONET — natuur-events
  'api.open-meteo.com',        // Open-Meteo — weer
  'archive-api.open-meteo.com',// Open-Meteo — archief
  'api.frankfurter.dev',       // Frankfurter — FX
  'www.gdacs.org',             // GDACS — multi-hazard
  // --- de 4 NIEUWE ---
  'dataservices.imf.org',      // IMF — Balance of Payments (kapitaalstroom)
  'stooq.com',                 // Stooq — live grondstoffen (WTI/Brent/gas/goud/koper/tarwe)
  'www.cpc.ncep.noaa.gov',     // NOAA CPC — Oceanic Niño Index (El Niño/La Niña)
  'stats.bis.org',             // BIS — credit-to-GDP gap (systeemrisico)
  'services9.arcgis.com',      // IMF PortWatch — maritieme chokepoints (Suez/Hormuz/Panama/Malacca/…)
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // secret-naam-tolerant: pak de key ongeacht hoe je 'm noemde
    const FRED   = env.FRED_API_KEY || env.FRED_KEY || env.FRED || env.fred_api_key || env.fred;
    const ACLEDK = env.ACLED_KEY || env.ACLED_API_KEY || env.ACLED || env.acled_key;
    const ACLEDE = env.ACLED_EMAIL || env.ACLED_MAIL || env.acled_email;

    // status/health
    if (pathname === '/' || pathname === '/status') {
      return json({ ok: true, service: 'osiris-gsd-proxy', ts: Date.now(),
        keys: { fred: !!FRED, acled: !!(ACLEDK && ACLEDE) },
        allow: [...ALLOW] });
    }
    if (pathname !== '/pass') return json({ error: 'use /pass?url=<https url>' }, 404);

    const target = searchParams.get('url');
    if (!target) return json({ error: 'missing url' }, 400);
    let u;
    try { u = new URL(target); } catch { return json({ error: 'bad url' }, 400); }
    if (u.protocol !== 'https:') return json({ error: 'https only' }, 400);
    if (!ALLOW.has(u.hostname)) return json({ error: 'host not allowed: ' + u.hostname }, 403);

    // --- keys server-side injecteren (searchParams.set voegt correct toe, ook als er al ?params zijn) ---
    if (u.hostname === 'api.stlouisfed.org') {
      if (env.FRED_API_KEY) u.searchParams.set('api_key', env.FRED_API_KEY);
      if (!u.searchParams.get('file_type')) u.searchParams.set('file_type', 'json'); // FRED geeft anders XML
    }
    if (u.hostname === 'api.acleddata.com') {
      if (env.ACLED_KEY) u.searchParams.set('key', env.ACLED_KEY);
      if (env.ACLED_EMAIL) u.searchParams.set('email', env.ACLED_EMAIL);
    }

    // sommige SDMX-bronnen willen een expliciete Accept-header (anders 406)
    const accept =
      u.hostname === 'stats.bis.org'          ? 'application/vnd.sdmx.data+json;version=1.0.0, application/json, */*' :
      u.hostname === 'data-api.ecb.europa.eu' ? 'application/json, application/vnd.sdmx.data+json, */*' :
      '*/*';

    let resp;
    try {
      resp = await fetch(u.toString(), {
        headers: { 'User-Agent': 'Osiris-GSD/1.1 (+cloudflare-worker)', 'Accept': accept },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + e.message }, 502);
    }

    const headers = new Headers(CORS);
    const ct = resp.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('cache-control', 'public, max-age=300');
    // geef de originele upstream-status door (zodat je 400/406/530 in de feed-rij ziet)
    return new Response(resp.body, { status: resp.status, headers });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
