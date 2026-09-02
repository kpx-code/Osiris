/* ============================================================
   OSIRIS INTEL FOREX — Capital.com proxy (Cloudflare Worker)
   ------------------------------------------------------------
   WHY THIS EXISTS
   Capital.com's API authenticates with your API key + a custom
   password, which together mint short-lived session tokens (CST +
   X-SECURITY-TOKEN, valid ~10 min). Those secrets must NEVER sit in
   the public GitHub Pages bundle. This worker holds them server-side,
   opens/refreshes the session, and exposes a tiny clean API to the
   dashboard: prices, place order, close, positions, account, top-up.

   Unlike OANDA, Capital.com blocks browser CORS AND needs your
   password, so BOTH pricing and orders go through this proxy.

   ------------------------------------------------------------
   DEPLOY (free tier is fine)
   1. capital.com → open a DEMO account. Turn ON 2FA (required before
      you can make an API key).
   2. Settings → API integrations → Generate API key. Give it a label
      and a CUSTOM PASSWORD (you'll need both the key and this password).
      Save the key string — it's shown only once.
   3. Cloudflare → Workers & Pages → Create Worker. Paste this file.
   4. Add these secrets (Settings → Variables and Secrets → Encrypt):
        CAP_API_KEY   = the API key from step 2
        CAP_IDENTIFIER= your capital.com login email
        CAP_PASSWORD  = the CUSTOM password you set for the key (step 2)
        CAP_ENV       = demo         (or: live)
      (Optional) CAP_ALLOW_ORIGIN = https://your-local-or-private-host
   5. Deploy. Copy the worker URL and paste it into the dashboard's
      "Capital.com proxy URL" field.

   ENDPOINTS (all POST unless noted, JSON in/out)
     GET  /health                      -> { ok, env, session:bool }
     GET  /prices?epics=EURUSD,GBPUSD  -> { prices:[{epic,bid,ask,mid,status}] }
     POST /order  { epic, direction:"BUY"|"SELL", size, stopDistance?, profitDistance? }
                                       -> { dealReference, confirm:{...} }
     POST /close  { dealId }           -> { dealReference }
     GET  /positions                   -> passthrough of /positions
     GET  /account                     -> { balance, deposit, profitLoss, available, currency }
     POST /topup  { amount }           -> adjust demo balance (demo only)

   NOTE: Capital.com uses "epics" (e.g. EURUSD) not "EUR/USD". The
   dashboard maps its pair names to epics before calling this worker.
   ============================================================ */

const HOST = {
  demo: 'https://demo-api-capital.backend-capital.com',
  live: 'https://api-capital.backend-capital.com',
};

// Session tokens are cached in module scope. Workers may reuse an isolate
// across requests, so this avoids re-authenticating on every call. Tokens
// expire after ~10 min of inactivity; we refresh on 401.
let SESSION = { cst: null, xst: null, at: 0, accountId: null };

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.CAP_ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
const j = (obj, status, env) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors(env), 'Content-Type': 'application/json' } });

function base(env) { return HOST[(env.CAP_ENV || 'demo').toLowerCase()] || HOST.demo; }

async function ensureSession(env, force) {
  const fresh = SESSION.cst && (Date.now() - SESSION.at < 8 * 60 * 1000);
  if (fresh && !force) return SESSION;
  const resp = await fetch(base(env) + '/api/v1/session', {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': env.CAP_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: env.CAP_IDENTIFIER, password: env.CAP_PASSWORD }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('session failed: HTTP ' + resp.status + ' ' + t.slice(0, 200));
  }
  const data = await resp.json();
  SESSION = {
    cst: resp.headers.get('CST'),
    xst: resp.headers.get('X-SECURITY-TOKEN'),
    at: Date.now(),
    accountId: data.currentAccountId || (data.accounts && data.accounts[0] && data.accounts[0].accountId) || null,
  };
  return SESSION;
}

async function capFetch(env, path, opts, retry) {
  const s = await ensureSession(env);
  const resp = await fetch(base(env) + path, {
    ...opts,
    headers: { ...(opts && opts.headers), 'CST': s.cst, 'X-SECURITY-TOKEN': s.xst, 'Content-Type': 'application/json' },
  });
  if (resp.status === 401 && !retry) {          // session expired → re-auth once
    await ensureSession(env, true);
    return capFetch(env, path, opts, true);
  }
  return resp;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/health') {
        let session = false;
        try { await ensureSession(env); session = !!SESSION.cst; } catch (e) {}
        return j({ ok: true, env: (env.CAP_ENV || 'demo'), session, accountId: SESSION.accountId }, 200, env);
      }

      // ---- SEARCH markets: discover the real epic names for a term (e.g. "EUR/USD" or "euro") ----
      if (request.method === 'GET' && path === '/search') {
        const term = (url.searchParams.get('q') || '').trim();
        if (!term) return j({ error: 'no q' }, 400, env);
        const resp = await capFetch(env, '/api/v1/markets?searchTerm=' + encodeURIComponent(term));
        if (!resp.ok) return j({ error: 'search HTTP ' + resp.status, detail: (await resp.text()).slice(0, 200) }, resp.status, env);
        const data = await resp.json();
        const markets = (data.markets || []).map(m => ({
          epic: m.epic, name: m.instrumentName, type: m.instrumentType,
          bid: m.bid, ask: m.offer, status: m.marketStatus,
        }));
        return j({ markets }, 200, env);
      }

      // ---- DEALING RULES: min/max deal size + decimals per epic (for correct order sizing) ----
      if (request.method === 'GET' && path === '/rules') {
        const epicsRaw = (url.searchParams.get('epics') || '').trim();
        if (!epicsRaw) return j({ error: 'no epics' }, 400, env);
        const epics = epicsRaw.split(',').map(e => e.trim()).filter(Boolean).slice(0, 40);
        const s = await ensureSession(env);
        const fetchRule = async epic => {
          try {
            const r = await fetch(base(env) + '/api/v1/markets/' + encodeURIComponent(epic), {
              headers: { 'CST': s.cst, 'X-SECURITY-TOKEN': s.xst, 'Content-Type': 'application/json' },
            });
            if (!r.ok) return null;
            const m = await r.json();
            const dr = m.dealingRules || {};
            return {
              epic,
              minSize: dr.minDealSize && dr.minDealSize.value,
              sizeStep: dr.minSizeIncrement && dr.minSizeIncrement.value,
              minStopPct: dr.minStopOrProfitDistance && dr.minStopOrProfitDistance.unit === 'PERCENTAGE' ? dr.minStopOrProfitDistance.value : null,
              maxStopPct: dr.maxStopOrProfitDistance && dr.maxStopOrProfitDistance.unit === 'PERCENTAGE' ? dr.maxStopOrProfitDistance.value : null,
              currency: m.instrument && m.instrument.currency,
            };
          } catch (e) { return null; }
        };
        const rules = [];
        for (let i = 0; i < epics.length; i += 6) {
          const res = await Promise.all(epics.slice(i, i + 6).map(fetchRule));
          res.forEach(x => { if (x) rules.push(x); });
          if (i + 6 < epics.length) await new Promise(r => setTimeout(r, 250));
        }
        return j({ rules }, 200, env);
      }

      // ---- PRICES: dashboard passes epics=EURUSD,GBPUSD,... ----
      // We fetch each epic via the single-market endpoint /markets/{epic}, which reliably
      // returns snapshot bid/offer. The batch ?epics= query proved unreliable (empty results),
      // so we query per-epic in parallel and simply skip any the account doesn't have.
      if (request.method === 'GET' && path === '/prices') {
        const epicsRaw = (url.searchParams.get('epics') || '').trim();
        if (!epicsRaw) return j({ error: 'no epics' }, 400, env);
        const epics = epicsRaw.split(',').map(e => e.trim()).filter(Boolean).slice(0, 40);
        const s = await ensureSession(env);
        const fetchOne = async epic => {
          try {
            const r = await fetch(base(env) + '/api/v1/markets/' + encodeURIComponent(epic), {
              headers: { 'CST': s.cst, 'X-SECURITY-TOKEN': s.xst, 'Content-Type': 'application/json' },
            });
            if (!r.ok) return null;
            const m = await r.json();
            const snap = m.snapshot || {};
            const bid = snap.bid, ask = snap.offer;
            if (bid == null || ask == null) return null;
            return { epic, bid, ask, mid: (bid + ask) / 2, status: snap.marketStatus, updated: snap.updateTime };
          } catch (e) { return null; }
        };
        // Chunk to respect the 10 req/s limit: 6 per batch, ~250ms between batches.
        const prices = [];
        for (let i = 0; i < epics.length; i += 6) {
          const batch = epics.slice(i, i + 6);
          const res = await Promise.all(batch.map(fetchOne));
          res.forEach(x => { if (x) prices.push(x); });
          if (i + 6 < epics.length) await new Promise(r => setTimeout(r, 250));
        }
        return j({ prices }, 200, env);
      }

      // ---- PLACE ORDER (market position with broker-side stop/target) ----
      if (request.method === 'POST' && path === '/order') {
        const b = await request.json();
        if (!b.epic || !b.direction || !b.size) return j({ error: 'need epic, direction, size' }, 400, env);
        const body = { epic: b.epic, direction: b.direction, size: b.size };
        if (b.stopDistance != null) body.stopDistance = b.stopDistance;      // broker enforces the stop
        if (b.profitDistance != null) body.profitDistance = b.profitDistance; // broker enforces the target
        const resp = await capFetch(env, '/api/v1/positions', { method: 'POST', body: JSON.stringify(body) });
        const text = await resp.text();
        if (!resp.ok) return j({ error: 'order HTTP ' + resp.status, detail: text.slice(0, 300) }, resp.status, env);
        const out = JSON.parse(text);
        // resolve the deal confirmation so the dashboard learns fill/reject
        let confirm = null;
        if (out.dealReference) {
          const c = await capFetch(env, '/api/v1/confirms/' + encodeURIComponent(out.dealReference));
          if (c.ok) confirm = await c.json();
        }
        return j({ dealReference: out.dealReference, confirm }, 200, env);
      }

      // ---- UPDATE POSITION stop/target (used to raise the safety-net stop to breakeven) ----
      if (request.method === 'POST' && path === '/update') {
        const b = await request.json();
        if (!b.dealId) return j({ error: 'need dealId' }, 400, env);
        const body = {};
        if (b.stopLevel != null) body.stopLevel = b.stopLevel;
        if (b.profitLevel != null) body.profitLevel = b.profitLevel;
        const resp = await capFetch(env, '/api/v1/positions/' + encodeURIComponent(b.dealId), { method: 'PUT', body: JSON.stringify(body) });
        const text = await resp.text();
        return j(resp.ok ? JSON.parse(text) : { error: 'update HTTP ' + resp.status, detail: text.slice(0, 200) }, resp.ok ? 200 : resp.status, env);
      }

      // ---- CLOSE POSITION ----
      if (request.method === 'POST' && path === '/close') {
        const b = await request.json();
        if (!b.dealId) return j({ error: 'need dealId' }, 400, env);
        const resp = await capFetch(env, '/api/v1/positions/' + encodeURIComponent(b.dealId), { method: 'DELETE' });
        const text = await resp.text();
        return j(resp.ok ? JSON.parse(text) : { error: 'close HTTP ' + resp.status, detail: text.slice(0, 200) }, resp.ok ? 200 : resp.status, env);
      }

      // ---- OPEN POSITIONS (cleaned: dealId, epic, direction, size, entry, live P/L) ----
      if (request.method === 'GET' && path === '/positions') {
        const resp = await capFetch(env, '/api/v1/positions');
        if (!resp.ok) return j({ error: 'positions HTTP ' + resp.status }, resp.status, env);
        const data = await resp.json();
        const positions = (data.positions || []).map(row => {
          const p = row.position || {}, m = row.market || {};
          return {
            dealId: p.dealId, epic: m.epic, direction: p.direction, size: p.size,
            entry: p.level, upl: p.upl, currency: p.currency,
            bid: m.bid, offer: m.offer, status: m.marketStatus,
            stopLevel: p.stopLevel, profitLevel: p.limitLevel,
            createdUTC: p.createdDateUTC,
          };
        });
        return j({ positions }, 200, env);
      }

      // ---- ACTIVITY: recently closed/settled deals, so Trinity can learn outcomes the broker settled ----
      // Capital caps lastPeriod (transactions rejects >1 day with error.invalid.lastPeriod), so for any
      // window beyond a day we use an explicit from/to range instead. Format: yyyy-MM-ddTHH:mm:ss (no ms/Z).
      const isoRange = secs => { const to = new Date(); const from = new Date(to.getTime() - secs * 1000);
        const f = d => d.toISOString().slice(0, 19); return 'from=' + f(from) + '&to=' + f(to); };

      if (request.method === 'GET' && path === '/activity') {
        const secs = Math.min(31536000, parseInt(url.searchParams.get('seconds') || '86400', 10) || 86400); // up to 1y via from/to
        const resp = await capFetch(env, '/api/v1/history/activity?' + isoRange(secs) + '&detailed=true');
        if (!resp.ok) return j({ error: 'activity HTTP ' + resp.status, detail: (await resp.text()).slice(0, 200) }, resp.status, env);
        const data = await resp.json();
        const activities = (data.activities || []).map(a => ({
          date: a.dateUTC || a.date, epic: a.epic, dealId: a.dealId,
          source: a.source, type: a.type, status: a.status,
          details: a.details || null,
        }));
        return j({ activities }, 200, env);
      }

      // ---- TRANSACTIONS: settled trades WITH realized P/L (the authoritative closed-trade history).
      //      Capital's /activity only reports open/close EVENTS (no P/L); /history/transactions gives
      //      instrument, size, open/close level, currency and profitAndLoss per settled deal. ----
      if (request.method === 'GET' && path === '/transactions') {
        const secs = Math.min(31536000, parseInt(url.searchParams.get('seconds') || '2592000', 10) || 2592000); // default 30d, up to 1y
        // from/to range (lastPeriod is rejected beyond ~1 day → error.invalid.lastPeriod)
        const resp = await capFetch(env, '/api/v1/history/transactions?' + isoRange(secs));
        if (!resp.ok) return j({ error: 'transactions HTTP ' + resp.status, detail: (await resp.text()).slice(0, 200) }, resp.status, env);
        const data = await resp.json();
        const num = s => { if (s == null) return null; const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
        const transactions = (data.transactions || []).map(t => ({
          date: t.dateUtc || t.date, instrument: t.instrumentName, type: t.transactionType,
          size: num(t.size), openLevel: num(t.openLevel), closeLevel: num(t.closeLevel),
          pnl: num(t.profitAndLoss), pnlRaw: t.profitAndLoss, currency: t.currency,
          ref: t.reference || t.dealReference || null,
        }));
        return j({ transactions }, 200, env);
      }

      // ---- ACCOUNT summary (balance) ----
      if (request.method === 'GET' && path === '/account') {
        const resp = await capFetch(env, '/api/v1/accounts');
        if (!resp.ok) return j({ error: 'account HTTP ' + resp.status }, resp.status, env);
        const data = await resp.json();
        const acct = (data.accounts || []).find(a => a.preferred) || (data.accounts || [])[0];
        const bal = acct && acct.balance || {};
        return j({ accountId: acct && acct.accountId, currency: acct && acct.currency,
                   balance: bal.balance, deposit: bal.deposit, profitLoss: bal.profitLoss, available: bal.available }, 200, env);
      }

      // ---- TOP UP demo balance ----
      if (request.method === 'POST' && path === '/topup') {
        if ((env.CAP_ENV || 'demo').toLowerCase() !== 'demo') return j({ error: 'top-up is demo-only' }, 400, env);
        const b = await request.json();
        const resp = await capFetch(env, '/api/v1/accounts/topUp', { method: 'POST', body: JSON.stringify({ amount: b.amount }) });
        const text = await resp.text();
        return j(resp.ok ? JSON.parse(text) : { error: 'topup HTTP ' + resp.status, detail: text.slice(0, 200) }, resp.ok ? 200 : resp.status, env);
      }

      return j({ error: 'not found' }, 404, env);
    } catch (e) {
      return j({ error: String(e.message || e) }, 500, env);
    }
  },
};
