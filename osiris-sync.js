/* ============================================================
 * OSIRIS · SYNC (FASE 1)
 * Spiegelt de localStorage-staat naar Supabase, houdt een groeiende trade-dataset
 * bij, en leest de afstandsbediening (aan/uit). Puur ADDITIEF: het raakt de bestaande
 * bot-logica niet aan.
 *
 * VEILIGHEID: gebruikt alleen de PUBLIEKE anon/publishable key. Dat mag in de browser
 * staan - RLS (zie osiris_schema.sql) beschermt de data zodat niemand anders erbij kan.
 * De 'service_role' key hoort NOOIT in de browser (alleen op de Oracle-worker later).
 *
 * INSTELLEN: vul hieronder je URL + anon key in, en zet in index.html:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="osiris-sync.js"></script>
 *   <script>window.addEventListener('DOMContentLoaded', osirisSyncInit);</script>
 * ============================================================ */

const OSIRIS_SUPABASE_URL = 'https://brhvybtokdjlmbxmxaiy.supabase.co';   // <-- INVULLEN
const OSIRIS_SUPABASE_KEY = 'sb_publishable_bTchUvswyWHLAHkumkbN8w_HEAVP0R9';       // <-- INVULLEN (publiek, veilig)

// Dirty-check-cache: ruwe localStorage-string per staat-sleutel bij de laatste
// GESLAAGDE cloud-push. Laat osirisSyncPush ongewijzigde (vaak grote) blobs overslaan.
let _osLastPushRaw = {};

// ---- SYNC-VERSIE-LABEL ----------------------------------------------------------
// Elke geslaagde push van het engine-apparaat bumpt een oplopend versienummer en schrijft
// een meta-rij (osirisSyncMeta) naar de cloud: {version, at, device, changed}. Zo kan een
// kijk-apparaat (telefoon) exact zien WELKE versie het ophaalt, en of de cloud iets nieuwers heeft.
const OSIRIS_SYNC_META_KEY = 'osirisSyncMeta';
function _osSyncLocalVersion() { try { return parseInt(localStorage.getItem('osirisSyncVersion') || '0') || 0; } catch (e) { return 0; } }
function _osDeviceLabel() {
    try {
        let n = localStorage.getItem('osirisDeviceName') || localStorage.getItem('osirisSyncDevice');
        if (!n) {
            const ua = (navigator.userAgent || '');
            const plat = /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : /Macintosh|Mac OS/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'device';
            n = plat + '-' + Math.random().toString(36).slice(2, 6);
            try { localStorage.setItem('osirisSyncDevice', n); } catch (e) {}
        }
        return n;
    } catch (e) { return 'device'; }
}
function _osFmtWhen(iso) { try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso || '—'; } }

// localStorage-sleutels die we naar de cloud spiegelen (de EXACTE keys die je app schrijft).
const OSIRIS_STATE_KEYS = [
    'osirisWalletState', 'osirisOpenPositions', 'osirisPendingOrders',
    'osirisTradeLog', 'osirisLearningLog', 'osirisSessionLog',
    'osirisBotSettings', 'osirisIndicatorSettings',
    'osirisAdaptiveWeights', 'osirisRegimeWeights',
    'osirisL2', 'osirisL3',
    'osirisDeepNet_BTC', 'osirisDeepNet_ETH', 'osirisDeepNet_SOL',
    'osirisDeepNetTsAB', 'osirisDeepNetDynOff', 'osirisDeepNetLive',
    'osirisFSOLog', 'osirisKineticLog', 'osirisRLModel', 'osirisMarginState', 'osirisMetaState', 'osirisSelfReview',
    'osirisDeepNetDir', 'osirisPredictInv',        // inversie-autopiloot staat (DeepNet + Predict)
    'osirisTiming', 'osirisTimingShadow', 'osirisTimingBT',   // Timing-Agent (live + schaduw + scenario-backtest): gewichten + hitrates + resolves
    'osirisFSOCal', 'osirisFSOShadow',             // FSO zone-kalibratie (live drempels) + shadow-backtest voorstellen
    'osirisJournal', 'osirisLLMfeed',              // G: journaal + LLM/vertaler-feed (leesbare neerslag)
    'osirisLiveEnabled', 'multiEngineRunning',
    'botIsRunning', 'botStartTime'
    // BEWUST NIET gesynct: 'osirisTestnetKeys', 'osirisLLMcfg' EN 'osirisAuditCfg' - API-keys
    // (futures + LLM) en de audit webhook/e-mail-sleutels horen niet in de cloud-DB. De audit-LOG
    // zelf (osirisAuditLog / osirisDeviceId / osirisDeviceName) blijft lokaal + gaat naar de aparte
    // osiris_access_log-tabel, niet via de state-sync.
];

// TRINITY (FX) — dezelfde spiegel-aanpak: al Trinity's leerdata/instellingen/FSO-GSD-state gaat
// óók mee naar de cloud, zodat een tweede apparaat (mobiel) ALLES terugkrijgt (Osiris Crypto ÉN Trinity).
// 'oif_state' is de hoofd-blob (wallet, tradeLog, learnings, brokerMeta, running-vlag).
const TRINITY_STATE_KEYS = [
    'oif_state', 'oif_seenClosed', 'trinityTxLearn', 'trinityImportKeys',
    'trinityPairTrust', 'trinityGSDShadow', 'trinityCompRelease',
    'trinityFSOCal', 'trinityFSOShadow', 'trinityFSOvis',
    'trinityGSDproxy', 'trinityGSDcal', 'trinityGSDhistCal', 'trinityGSDbackfill',
    'trinityGSDvis', 'trinityGSDroll', 'trinityGSDhist', 'trinityGSDpredlog'
];
// alle sleutels die naar de cloud gespiegeld worden = Osiris Crypto + Trinity
const ALL_STATE_KEYS = OSIRIS_STATE_KEYS.concat(TRINITY_STATE_KEYS);

// Deze run-vlaggen worden wel gespiegeld (voor backup/Fase 2) maar NIET teruggezet bij
// 'herstel', zodat een tweede apparaat niet per ongeluk een tweede engine start en zo
// dubbel op dezelfde testnet-wallet gaat traden. In Fase 1 draait de engine op 1 plek.
const OSIRIS_NO_RESTORE = ['botIsRunning', 'multiEngineRunning', 'botStartTime'];
// na een pull/herstel op een KIJK-apparaat: zet Trinity's running-vlag in oif_state op false,
// zodat het mobiel niet ineens live gaat handelen op dezelfde Capital-account.
function _osTrinityDisableRunAfterPull() {
    try { const raw = localStorage.getItem('oif_state'); if (!raw) return; const os = JSON.parse(raw);
        if (os && os.trinityWasRunning) { os.trinityWasRunning = false; localStorage.setItem('oif_state', JSON.stringify(os)); }
    } catch (e) {}
}
// SPIEGEL van bovenstaande, maar voor de OSIRIS-CRYPTO-engine. Zonder dit bleef de lokale Osiris-bot
// op een kijk-apparaat gewoon dóórdraaien ná een pull/herstel, en overschreef hij de zojuist opgehaalde
// cloud-staat (wallet/trades) met zijn eigen sessie — precies waarom Osiris crypto niet leek te syncen,
// terwijl Trinity dat wél deed. Nu wordt de Osiris-bot op het kijk-apparaat na een pull/herstel gestopt,
// zodat de gesynchroniseerde data blijft staan. (botStartTime blijft ongemoeid: de runtime-weergave leest
// de authoritatieve starttijd apart uit de cloud.)
function _osDisableOsirisEngineAfterPull() {
    try { if (localStorage.getItem('botIsRunning') != null) localStorage.setItem('botIsRunning', 'false'); } catch (e) {}
    try { if (localStorage.getItem('multiEngineRunning') != null) localStorage.setItem('multiEngineRunning', 'false'); } catch (e) {}
    try { if (localStorage.getItem('osirisMarginEnabled') != null) localStorage.setItem('osirisMarginEnabled', '0'); } catch (e) {}
    try { if (typeof isBotRunning !== 'undefined' && isBotRunning && typeof stopAutonomousBot === 'function') stopAutonomousBot(); } catch (e) {}
    try { if (typeof multiEngineRunning !== 'undefined' && multiEngineRunning && typeof stopMultiEngine === 'function') stopMultiEngine(); } catch (e) {}
    try { if (typeof marginEngineEnabled !== 'undefined') marginEngineEnabled = false; } catch (e) {}
}

let _sb = null, _sbUser = null, _syncTimer = null;

function osirisSyncInit() {
    if (typeof supabase === 'undefined') { console.warn('[osiris-sync] supabase-js niet geladen'); return; }
    _sb = supabase.createClient(OSIRIS_SUPABASE_URL, OSIRIS_SUPABASE_KEY);
    _osirisSyncBuildUI();
    _sb.auth.onAuthStateChange((_ev, session) => {
        _sbUser = session ? session.user : null;
        _osirisSyncRenderAuth();
        if (_sbUser && !_syncTimer) { _syncTimer = setInterval(osirisSyncPush, 60000); osirisSyncPush(); }
        if (!_sbUser && _syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    });
    _sb.auth.getSession();
}
window.osirisSyncInit = osirisSyncInit;

// ------------------------------------------------------------------
// AUDIT / ACCESS LOG — anon insert naar de tabel osiris_access_log.
// Werkt OOK zonder ingelogd te zijn (juist bedoeld om onbevoegde toegang te
// betrappen). Vereist eenmalig in Supabase een tabel + RLS-policy die anon
// INSERT toestaat en SELECT alleen voor de eigenaar. Faalt stil als die ontbreekt.
//
//   create table public.osiris_access_log (
//     id bigint generated always as identity primary key,
//     device_id text, device_name text, event_type text, label text,
//     sensitive boolean, ts timestamptz, ip text, geo jsonb, geo_precise jsonb,
//     device jsonb, engagement_ms bigint, url text, extra jsonb,
//     created_at timestamptz default now()
//   );
//   alter table public.osiris_access_log enable row level security;
//   create policy "anon insert" on public.osiris_access_log for insert to anon with check (true);
//   -- (SELECT bewust NIET aan anon geven; lees hem als eigenaar via de dashboard/service-role)
//   -- E-mail gratis: zet een Database Webhook / trigger op deze tabel die een gratis
//   --   mailprovider (bijv. Resend free tier) aanroept — sleutels blijven server-side in Supabase.
// ------------------------------------------------------------------
let _auditDead = false, _auditFails = 0;
async function osirisAuditPush(rows) {
    try {
        if (_auditDead || !_sb || !Array.isArray(rows) || !rows.length) return;
        const { error } = await _sb.from('osiris_access_log').insert(rows);
        if (error) {
            _auditFails++;
            // tabel/policy ontbreekt (404/42P01) of geweigerd -> na 2 pogingen STOPPEN met pushen
            // zodat de console niet volloopt met 404's. Log één keer een duidelijke hint.
            if (_auditFails >= 2) {
                _auditDead = true;
                try { console.warn('[osiris-audit] access-log uitgeschakeld voor deze sessie: tabel public.osiris_access_log ontbreekt of weigert insert. Maak de tabel + anon-insert-policy aan (SQL staat boven osirisAuditPush) en herlaad.'); } catch (e) {}
            }
        } else { _auditFails = 0; }
    } catch (e) {
        _auditFails++; if (_auditFails >= 2) _auditDead = true;
    }
}
window.osirisAuditPush = osirisAuditPush;
window.osirisAuditReset = function () { _auditDead = false; _auditFails = 0; };   // na tabel-aanmaak: aanroepen of herladen

// data-true cloud/sync status voor de neural-net visual
window.osirisCloudStatus = function () { try { return { connected: !!_sb, signedIn: !!_sbUser, syncing: !!_syncTimer }; } catch (e) { return { connected: false, signedIn: false, syncing: false }; } };

async function osirisSignIn(email, pw) {
    if (!_sb) return;
    if (!email || !pw) { _osirisSyncMsg('Vul e-mail en wachtwoord in.'); return; }
    _osirisSyncMsg('inloggen\u2026', true); _osirisSyncDot('busy');
    const { error } = await _sb.auth.signInWithPassword({ email, password: pw });
    if (error) {
        const s = await _sb.auth.signUp({ email, password: pw });
        if (s.error) { _osirisSyncMsg('Mislukt: ' + error.message); _osirisSyncDot('err'); }
        else _osirisSyncMsg('Account aangemaakt. Staat e-mailbevestiging aan? Check je inbox en log daarna in.', true);
    } else { _osirisSyncMsg(''); }
}
async function osirisSignOut() { if (_sb) await _sb.auth.signOut(); }

/* Draait op DIT apparaat de engine? Alleen dat apparaat is de 'bron van waarheid' en mag
 * de cloud-staat mirroren. Een puur kijk-apparaat (mobiel dat alleen meekijkt) mag NIET
 * pushen - anders overschrijft zijn verouderde staat (incl. een oude botStartTime) de
 * echte sessie in de cloud, waardoor de runtime op mobiel bv. 400u toont i.p.v. de echte 64u. */
function _osirisEngineActive() {
    try { if (typeof botIsRunning !== 'undefined' && botIsRunning) return true; } catch (e) {}
    try { if (typeof isBotRunning !== 'undefined' && isBotRunning) return true; } catch (e) {}
    try { if (localStorage.getItem('botIsRunning') === 'true') return true; } catch (e) {}
    try { if (typeof multiEngineRunning !== 'undefined' && multiEngineRunning) return true; } catch (e) {}
    try { if (localStorage.getItem('multiEngineRunning') === 'true') return true; } catch (e) {}
    try { if (typeof marginEngineEnabled !== 'undefined' && marginEngineEnabled) return true; } catch (e) {}
    try { if (localStorage.getItem('osirisMarginEnabled') === '1') return true; } catch (e) {}
    // Trinity (FX) draait op dit apparaat? Dan is dit óók een bron-van-waarheid en mag het pushen,
    // ook als de Osiris-crypto-bot uit staat.
    try { if (typeof trinityOn !== 'undefined' && trinityOn) return true; } catch (e) {}
    try { const os = JSON.parse(localStorage.getItem('oif_state') || 'null'); if (os && os.trinityWasRunning) return true; } catch (e) {}
    return false;
}
window._osirisEngineActive = _osirisEngineActive;

/* ---- PUSH: spiegel de staat + nieuwe trades naar de cloud, lees de afstandsbediening ---- */
async function osirisSyncPush() {
    if (!_sb) return;
    // eerste tik na page-load: sessie kan nog niet hersteld zijn -> even ophalen
    // i.p.v. stil niets doen (dat was de reden dat je een paar keer moest tikken).
    if (!_sbUser) { try { const { data } = await _sb.auth.getSession(); _sbUser = data && data.session ? data.session.user : null; } catch (e) {} }
    if (!_sbUser) { _osirisSyncMsg('Log eerst in.'); return; }
    _osirisSyncDot('busy');
    const _engine = _osirisEngineActive();
    try {
        // KIJK-APPARAAT (engine draait hier NIET): niet pushen (anders klobber je de echte
        // sessie), maar de authoritatieve runtime-starttijden ophalen voor de weergave.
        if (!_engine) {
            try {
                const { data: st } = await _sb.from('osiris_state').select('key,value').eq('user_id', _sbUser.id).in('key', ['botStartTime', 'osirisMarginState']);
                if (st) for (const r of st) {
                    if (r.key === 'botStartTime') { const v = (typeof r.value === 'number') ? r.value : parseInt(r.value); if (v > 0) window._osirisAuthSpotStart = v; }
                    if (r.key === 'osirisMarginState' && r.value && r.value.startTime) window._osirisAuthMarginStart = r.value.startTime;
                }
            } catch (e) {}
            // afstandsbediening lezen blijft wel
            try { const { data: ctrl } = await _sb.from('osiris_control').select('desired_running').eq('user_id', _sbUser.id).maybeSingle(); if (ctrl) _osirisApplyDesiredRunning(ctrl.desired_running); } catch (e) {}
            try { localStorage.setItem('osirisSyncLastConnected', new Date().toISOString()); } catch (e) {}
            _osirisSyncStamp('kijk-modus · gesynct ' + new Date().toLocaleTimeString('nl-NL'), 'ok');
            return;
        }
        // 1) staat-sleutels upserten (mirror) - alleen het engine-apparaat.
        // PRESTATIE: veel van deze sleutels (trade-log, FSO-log, DeepNet-modellen,
        // RL-model) zijn grote JSON-blobs die zelden per minuut wijzigen. Voorheen
        // werd elke tick ALLE 37 blobs geparsed + geüpload -> dat was de ~75ms
        // 'setInterval handler took'-violation. Nu een dirty-check op de ruwe string:
        // alleen gewijzigde sleutels worden geparsed en meegestuurd. De 'last pushed'-
        // stempel wordt pas NA een geslaagde upsert gezet, zodat een mislukte push
        // de volgende keer gewoon opnieuw wordt geprobeerd.
        const rows = []; const pushedRaw = [];
        _osLastPushRaw = (typeof _osLastPushRaw !== 'undefined' && _osLastPushRaw) ? _osLastPushRaw : {};
        for (const k of ALL_STATE_KEYS) {   // Osiris Crypto + Trinity samen naar de cloud
            const v = localStorage.getItem(k);
            if (v == null) continue;
            if (_osLastPushRaw[k] === v) continue;   // ongewijzigd sinds vorige geslaagde push -> overslaan
            let parsed; try { parsed = JSON.parse(v); } catch (e) { parsed = v; }
            rows.push({ user_id: _sbUser.id, key: k, value: parsed, updated_at: new Date().toISOString() });
            pushedRaw.push([k, v]);
        }
        if (rows.length) { await _sb.from('osiris_state').upsert(rows, { onConflict: 'user_id,key' }); for (const [k, v] of pushedRaw) _osLastPushRaw[k] = v; }

        // ---- SYNC-VERSIE bumpen + meta-rij schrijven (alleen als er echt iets veranderde) ----
        // De telefoon leest deze rij om te tonen welke versie er in de cloud staat.
        let _ver = _osSyncLocalVersion();
        if (rows.length) {
            _ver++;
            try { localStorage.setItem('osirisSyncVersion', String(_ver)); } catch (e) {}
            const meta = { version: _ver, at: new Date().toISOString(), device: _osDeviceLabel(), changed: rows.length };
            try { await _sb.from('osiris_state').upsert([{ user_id: _sbUser.id, key: OSIRIS_SYNC_META_KEY, value: meta, updated_at: meta.at }], { onConflict: 'user_id,key' }); } catch (e) {}
            try { localStorage.setItem(OSIRIS_SYNC_META_KEY, JSON.stringify(meta)); _osLastPushRaw[OSIRIS_SYNC_META_KEY] = JSON.stringify(meta); } catch (e) {}
        }

        // 2) nieuwe gesloten trades append (ontdubbeld op trade_id)
        const log = (typeof botTradeLog !== 'undefined' && Array.isArray(botTradeLog)) ? botTradeLog : [];
        const _byId = new Map();   // ontdubbel binnen de batch (2x dezelfde trade_id -> 409)
        log.filter(t => t.action === 'EXIT').forEach((t, idx) => {
            const tid = String(t.id || ((t.timestampMs || 0) + '-' + (t.market || 'BTC') + '-' + (t.side || '') + '-' + idx));
            _byId.set(tid, {
                user_id: _sbUser.id, trade_id: tid,
                market: t.market || 'BTC', side: t.side || null,
                is_osiris: t.isOsiris === true, is_scalp: t.isScalp === true, is_ict: t.isIct === true, is_manual: t.isManual === true,
                exit_price: t.price ?? null, pnl: (t.pnlAmount ?? null), pnl_pct: (t.pnl ?? null), reason: t.reason || null,
                closed_at: t.timestampMs ? new Date(t.timestampMs).toISOString() : null,
                raw: t
            });
        });
        const exits = [..._byId.values()];
        // in blokken van 500 om payloadlimieten te respecteren
        for (let i = 0; i < exits.length; i += 500) {
            await _sb.from('osiris_trades').upsert(exits.slice(i, i + 500), { onConflict: 'user_id,trade_id' });
        }

        // 2b) MARGIN-WALLET (19-08): de margin-staat wordt al mee-gespiegeld via de
        // OSIRIS_STATE_KEYS ('osirisMarginState'), zodat wallet/equity/open posities op
        // een tweede apparaat teruggezet kunnen worden. Hier pushen we bovendien de
        // GESLOTEN margin-trades als aparte rijen in dezelfde osiris_trades-tabel, zodat
        // je margin- en spot-trades in één dataset kunt analyseren. Getagd met is_margin
        // in 'raw' (leverage + mfe/mae), trade_id met 'margin-'-prefix zodat ze niet met
        // de spot-trades botsen. Geen schema-wijziging nodig.
        try {
            const ms = (typeof marginState !== 'undefined' && marginState) ? marginState : (typeof window !== 'undefined' ? window.marginState : null);
            const mclosed = (ms && Array.isArray(ms.closed)) ? ms.closed : [];
            const _mById = new Map();
            mclosed.forEach((t, idx) => {
                const tid = 'margin-' + String(t.ts || idx) + '-' + (t.sym || 'BTC') + '-' + (t.side || '');
                _mById.set(tid, {
                    user_id: _sbUser.id, trade_id: tid,
                    market: t.sym || 'BTC', side: t.side || null,
                    is_osiris: true, is_scalp: false, is_ict: false, is_manual: t.reason === 'MANUAL',
                    exit_price: t.price ?? null,
                    pnl: (t.pnlUSD ?? null),                 // gerealiseerd bedrag (USD, geleveraged)
                    pnl_pct: (t.pnl ?? null),                // geleveraged rendement (fractie)
                    reason: t.reason || null,
                    closed_at: t.ts ? new Date(t.ts).toISOString() : null,
                    raw: Object.assign({ isMargin: true, leverage: t.leverage ?? null, mfe: t.mfe ?? null, mae: t.mae ?? null }, t)
                });
            });
            const mexits = [..._mById.values()];
            for (let i = 0; i < mexits.length; i += 500) {
                await _sb.from('osiris_trades').upsert(mexits.slice(i, i + 500), { onConflict: 'user_id,trade_id' });
            }
        } catch (e) { console.warn('[osiris-sync] margin-trades push-fout', e); }

        // 3) afstandsbediening lezen -> lokaal toepassen
        const { data: ctrl } = await _sb.from('osiris_control').select('desired_running').eq('user_id', _sbUser.id).maybeSingle();
        if (ctrl) _osirisApplyDesiredRunning(ctrl.desired_running);

        try { localStorage.setItem('osirisSyncLastConnected', new Date().toISOString()); } catch (e) {}
        _osirisSyncStamp('gesynct v#' + _osSyncLocalVersion() + ' · ' + new Date().toLocaleTimeString('nl-NL'), 'ok');
    } catch (e) { console.warn('[osiris-sync] push-fout', e); _osirisSyncStamp('sync-fout (zie console)', 'err'); }
}
window.osirisSyncPush = osirisSyncPush;

/* ---- RESTORE (handmatig): haal de cloud-staat terug naar localStorage en herlaad ---- */
async function osirisRestoreFromCloud() {
    if (!_sb) { alert('Cloud niet geladen.'); return; }
    if (!_sbUser) { try { const { data } = await _sb.auth.getSession(); _sbUser = data && data.session ? data.session.user : null; } catch (e) {} }
    if (!_sbUser) { alert('Log eerst in.'); return; }
    if (!confirm('Cloud-staat over je lokale staat heen zetten en de pagina herladen?')) return;
    const { data, error } = await _sb.from('osiris_state').select('key,value').eq('user_id', _sbUser.id);
    if (error) { alert('Restore-fout: ' + error.message); return; }
    let n = 0;
    (data || []).forEach(r => {
        if (OSIRIS_NO_RESTORE.includes(r.key)) return;   // engine niet auto-starten op dit apparaat
        try { localStorage.setItem(r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)); n++; } catch (e) {}
    });
    _osTrinityDisableRunAfterPull();
    _osDisableOsirisEngineAfterPull();   // Osiris-bot niet laten dóórdraaien over de herstelde staat heen
    try { sessionStorage.setItem('osirisJustPulled', String(n)); } catch (e) {}
    location.reload();
}
window.osirisRestoreFromCloud = osirisRestoreFromCloud;

/* ---- PULL LATEST (mobiel/kijk-apparaat): één tik -> volledige nieuwste cloud-staat ----
 * Het probleem was: "sync nu" op een kijk-apparaat haalde alléén de start-tijden op, niet
 * de volledige staat. Daardoor moest je meerdere keren tikken (en zag je alsnog oude data).
 * Deze functie haalt in ÉÉN tik ALLE staat-sleutels op, schrijft ze naar localStorage
 * (behalve de run-vlaggen, zodat er geen tweede engine start) en herlaadt één keer, zodat
 * elk paneel meteen de nieuwste data toont. Non-destructief op een kijk-apparaat (dat heeft
 * geen eigen authoritatieve staat), dus zonder bevestigingsdialoog. */
let _osPulling = false;
async function osirisPullLatest() {
    if (!_sb) { _osirisSyncMsg('Cloud niet geladen.'); return; }
    if (_osPulling) return; _osPulling = true;
    if (!_sbUser) { try { const { data } = await _sb.auth.getSession(); _sbUser = data && data.session ? data.session.user : null; } catch (e) {} }
    if (!_sbUser) { _osirisSyncMsg('Log eerst in.'); _osPulling = false; return; }
    _osirisSyncStamp('nieuwste ophalen…', 'busy'); _osirisSyncDot('busy');
    try {
        const { data, error } = await _sb.from('osiris_state').select('key,value').eq('user_id', _sbUser.id);
        if (error) { _osirisSyncStamp('ophalen mislukt: ' + error.message, 'err'); _osPulling = false; return; }
        let n = 0, _meta = null;
        (data || []).forEach(r => {
            if (r.key === OSIRIS_SYNC_META_KEY) { _meta = (typeof r.value === 'object') ? r.value : (function(){try{return JSON.parse(r.value);}catch(e){return null;}})(); }
            if (OSIRIS_NO_RESTORE.includes(r.key)) return;   // run-vlaggen niet terugzetten (geen 2e engine)
            try { localStorage.setItem(r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)); n++; } catch (e) {}
        });
        // versie van de opgehaalde staat lokaal vastleggen, zodat de telefoon weet WELKE versie het heeft
        if (_meta && _meta.version != null) { try { localStorage.setItem('osirisSyncVersion', String(_meta.version)); } catch (e) {} }
        _osTrinityDisableRunAfterPull();   // mobiel niet ineens live laten handelen na de pull
        _osDisableOsirisEngineAfterPull(); // idem voor de Osiris-crypto-bot, anders overschrijft die de pull
        try { sessionStorage.setItem('osirisJustPulled', String(n)); if (_meta) sessionStorage.setItem('osirisJustPulledMeta', JSON.stringify(_meta)); } catch (e) {}
        const _vtxt = _meta && _meta.version != null ? ('v#' + _meta.version + ' ') : '';
        _osirisSyncStamp('nieuwste ' + _vtxt + 'opgehaald (' + n + ') · herladen…', 'ok');
        setTimeout(() => { try { location.reload(); } catch (e) { _osPulling = false; } }, 220);
    } catch (e) { _osirisSyncStamp('ophalen mislukt (zie console)', 'err'); console.warn('[osiris-sync] pull-fout', e); _osPulling = false; }
}
window.osirisPullLatest = osirisPullLatest;

/* ---- CLOUD-VERSIE CHECKEN: lees alleen de meta-rij en toon of de cloud nieuwer is dan lokaal.
 * Zo zie je op de telefoon in één oogopslag: "cloud v#15 (nieuwer) · jij hebt v#12". */
async function osirisCheckCloudVersion(silent) {
    if (!_sb) return null;
    if (!_sbUser) { try { const { data } = await _sb.auth.getSession(); _sbUser = data && data.session ? data.session.user : null; } catch (e) {} }
    if (!_sbUser) return null;
    try {
        const { data } = await _sb.from('osiris_state').select('value').eq('user_id', _sbUser.id).eq('key', OSIRIS_SYNC_META_KEY).maybeSingle();
        const meta = data ? ((typeof data.value === 'object') ? data.value : (function(){try{return JSON.parse(data.value);}catch(e){return null;}})()) : null;
        _osirisRenderVersionLine(meta);
        return meta;
    } catch (e) { if (!silent) _osirisSyncMsg('versie-check mislukt'); return null; }
}
window.osirisCheckCloudVersion = osirisCheckCloudVersion;

// toont de versie-regel: lokale versie vs cloud-versie (+ apparaat + tijd)
function _osirisRenderVersionLine(cloudMeta) {
    const el = document.getElementById('osiris-sync-ver'); if (!el) return;
    const local = _osSyncLocalVersion();
    if (!cloudMeta || cloudMeta.version == null) { el.innerHTML = '<span style="color:#5c7488">jouw versie: v#' + local + ' · cloud onbekend</span>'; return; }
    const cv = cloudMeta.version, newer = cv > local;
    const dev = cloudMeta.device ? (' · ' + cloudMeta.device) : '';
    const when = cloudMeta.at ? (' · ' + _osFmtWhen(cloudMeta.at)) : '';
    el.innerHTML = newer
        ? '<span style="color:#ffb627">cloud v#' + cv + ' (nieuwer!)' + dev + when + '</span><br><span style="color:#5c7488">jij hebt v#' + local + ' — tik op ophalen</span>'
        : '<span style="color:#14f195">✓ up-to-date · v#' + local + dev + when + '</span>';
}

/* ---- afstandsbediening toepassen ----
 * In FASE 1 werkt dit alleen als DEZE browser de engine draait. Echte 24/7-
 * afstandsbediening komt in FASE 2, wanneer de Oracle-worker deze vlag leest. */
function _osirisApplyDesiredRunning(want) {
    try {
        // Alleen handelen bij een EXPLICIETE wens. Is desired_running null/undefined
        // (nog nooit gezet), dan NIETS doen - anders stopte de sync elke 60s de
        // draaiende bot (want !null === true), wat de hele handel platlegde.
        if (want !== true && want !== false) return;
        const running = (typeof isBotRunning !== 'undefined') ? isBotRunning : false;
        if (want === true && !running && typeof startAutonomousBot === 'function') startAutonomousBot();
        else if (want === false && running && typeof stopAutonomousBot === 'function') stopAutonomousBot();
    } catch (e) {}
}

/* zet de gewenste aan/uit-staat vanuit dit apparaat (schrijft naar de DB; elk ander
 * apparaat / de Oracle-worker leest het) */
async function osirisSetDesiredRunning(want) {
    if (!_sb || !_sbUser) { alert('Log eerst in.'); return; }
    await _sb.from('osiris_control').upsert(
        { user_id: _sbUser.id, desired_running: !!want, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
    );
}
window.osirisSetDesiredRunning = osirisSetDesiredRunning;

/* ---- UI: net cloud-sync paneel (inklapbaar, statusdot, inline meldingen) ---- */
function _osirisSyncBuildUI() {
    if (document.getElementById('osiris-sync-box')) return;
    const style = document.createElement('style');
    style.textContent = `
      #osiris-sync-box{position:fixed;right:14px;bottom:14px;z-index:99999;width:238px;
        background:linear-gradient(180deg,#071722,#040b12);border:1px solid rgba(0,217,255,0.35);
        border-radius:11px;box-shadow:0 8px 28px rgba(0,0,0,0.55),inset 0 0 0 1px rgba(0,217,255,0.05);
        font:11px/1.45 'JetBrains Mono',ui-monospace,monospace;color:#cfe3f0;overflow:hidden;transition:width .15s ease;}
      #osiris-sync-box.min{width:158px;}
      #osiris-sync-box .osb-hd{display:flex;align-items:center;gap:8px;padding:9px 11px;
        background:rgba(0,217,255,0.06);border-bottom:1px solid rgba(0,217,255,0.15);cursor:pointer;user-select:none;}
      #osiris-sync-box .osb-dot{width:8px;height:8px;border-radius:50%;background:#5c7488;color:#5c7488;flex:none;box-shadow:0 0 7px currentColor;transition:all .2s;}
      #osiris-sync-box .osb-ttl{color:#7fd8ff;letter-spacing:1.6px;font-size:9.5px;flex:1;font-weight:700;}
      #osiris-sync-box .osb-min{color:#5c7488;font-size:14px;line-height:1;padding:0 2px;}
      #osiris-sync-box .osb-body{padding:10px 11px;}
      #osiris-sync-box.min .osb-body{display:none;}
      #osiris-sync-box input{width:100%;box-sizing:border-box;margin-bottom:7px;padding:7px 9px;
        background:#020a11;border:1px solid rgba(120,160,190,0.3);border-radius:6px;color:#eaffff;font:inherit;outline:none;transition:border-color .12s;}
      #osiris-sync-box input:focus{border-color:rgba(0,217,255,0.7);box-shadow:0 0 0 2px rgba(0,217,255,0.12);}
      #osiris-sync-box button{cursor:pointer;padding:6px 9px;border-radius:6px;border:1px solid rgba(0,217,255,0.4);
        background:rgba(0,217,255,0.08);color:#eaffff;font:inherit;transition:background .1s;}
      #osiris-sync-box button:hover{background:rgba(0,217,255,0.18);}
      #osiris-sync-box .osb-primary{width:100%;background:rgba(20,241,149,0.14);border-color:rgba(20,241,149,0.5);color:#b6ffe0;font-weight:700;letter-spacing:.5px;}
      #osiris-sync-box .osb-primary:hover{background:rgba(20,241,149,0.24);}
      #osiris-sync-box .osb-row{display:flex;gap:5px;margin-top:8px;}
      #osiris-sync-box .osb-row button{flex:1;font-size:10px;}
      #osiris-sync-box .osb-user{color:#14f195;font-size:11px;word-break:break-all;}
      #osiris-sync-box .osb-stamp{color:#5c7488;font-size:9.5px;margin-top:8px;display:flex;align-items:center;gap:5px;}
      #osiris-sync-box .osb-msg{font-size:9.5px;margin-top:6px;min-height:12px;color:#ff8a94;}
    `;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'osiris-sync-box';
    box.innerHTML =
      '<div class="osb-hd" onclick="_osirisSyncToggleMin()">' +
        '<span class="osb-dot" id="osiris-sync-dot"></span>' +
        '<span class="osb-ttl">OSIRIS \u00b7 CLOUD-SYNC</span>' +
        '<span class="osb-min" id="osiris-sync-min">\u2013</span>' +
      '</div>' +
      '<div class="osb-body">' +
        '<div id="osiris-sync-auth"></div>' +
        '<div class="osb-msg" id="osiris-sync-msg"></div>' +
        '<div class="osb-stamp" id="osiris-sync-stamp">niet ingelogd</div>' +
      '</div>';
    document.body.appendChild(box);
    _osirisSyncRenderAuth();
    try { const lc = localStorage.getItem('osirisSyncLastConnected'); if (lc) _osirisSyncStamp('laatst verbonden ' + new Date(lc).toLocaleString('nl-NL')); } catch (e) {}
    // net na een "nieuwste data ophalen" + reload: bevestig kort dat de verse data binnen is
    try { const jp = sessionStorage.getItem('osirisJustPulled'); if (jp != null) { sessionStorage.removeItem('osirisJustPulled');
        let vtxt = ''; try { const m = JSON.parse(sessionStorage.getItem('osirisJustPulledMeta') || 'null'); sessionStorage.removeItem('osirisJustPulledMeta'); if (m && m.version != null) vtxt = 'v#' + m.version + ' '; } catch (e) {}
        _osirisSyncStamp('✓ ' + vtxt + 'geladen (' + jp + ' items)', 'ok'); } } catch (e) {}
}
function _osirisSyncToggleMin() {
    const b = document.getElementById('osiris-sync-box'); if (!b) return;
    b.classList.toggle('min');
    const m = document.getElementById('osiris-sync-min'); if (m) m.textContent = b.classList.contains('min') ? '+' : '\u2013';
}
window._osirisSyncToggleMin = _osirisSyncToggleMin;

function _osirisSyncRenderAuth() {
    const el = document.getElementById('osiris-sync-auth'); if (!el) return;
    if (_sbUser) {
        var _engine = false; try { _engine = _osirisEngineActive(); } catch (e) {}
        if (_engine) {
            // ENGINE-APPARAAT (bron van waarheid): pushen naar de cloud + evt. herstel.
            el.innerHTML =
              '<div class="osb-user">\u2713 ' + (_sbUser.email || 'ingelogd') + '</div>' +
              '<div class="osb-ver" style="font-size:9.5px;line-height:1.5;margin:5px 0 6px;color:#14f195;">engine \u00b7 pusht als v#' + (_osSyncLocalVersion() + 1) + '</div>' +
              '<div class="osb-row">' +
                '<button onclick="osirisSyncPush()">sync nu</button>' +
                '<button onclick="osirisRestoreFromCloud()">herstel</button>' +
                '<button onclick="osirisSignOut()">uit</button>' +
              '</div>';
        } else {
            // KIJK-APPARAAT (bv. mobiel): \u00e9\u00e9n tik haalt de VOLLEDIGE nieuwste staat op.
            el.innerHTML =
              '<div class="osb-user">\u2713 ' + (_sbUser.email || 'ingelogd') + '</div>' +
              '<div class="osb-ver" id="osiris-sync-ver" style="font-size:9.5px;line-height:1.5;margin:5px 0 6px;color:#5c7488;">jouw versie: v#' + _osSyncLocalVersion() + ' \u00b7 cloud checken\u2026</div>' +
              '<button class="osb-primary" onclick="osirisPullLatest()" style="margin-top:2px;">\u2b73 nieuwste data ophalen</button>' +
              '<div class="osb-row">' +
                '<button onclick="osirisCheckCloudVersion()">check versie</button>' +
                '<button onclick="osirisSignOut()">uit</button>' +
              '</div>';
            try { osirisCheckCloudVersion(true); } catch (e) {}
        }
        _osirisSyncDot('ok');
    } else {
        // in een <form> voor toegankelijkheid (fixt de "password field not in a form"-warning)
        el.innerHTML =
          '<form onsubmit="osirisSignIn(this.email.value, this.pw.value); return false;">' +
            '<input name="email" type="email" placeholder="e-mail" autocomplete="username">' +
            '<input name="pw" type="password" placeholder="wachtwoord" autocomplete="current-password">' +
            '<button type="submit" class="osb-primary">inloggen / registreren</button>' +
          '</form>';
        _osirisSyncDot('idle');
    }
}
function _osirisSyncDot(state) {
    const d = document.getElementById('osiris-sync-dot'); if (!d) return;
    const c = state === 'ok' ? '#14f195' : state === 'busy' ? '#ffb627' : state === 'err' ? '#ff5c6a' : '#5c7488';
    d.style.color = c; d.style.background = c;
}
function _osirisSyncStamp(txt, state) {
    const el = document.getElementById('osiris-sync-stamp'); if (el) el.textContent = txt;
    if (state) _osirisSyncDot(state);
}
function _osirisSyncMsg(txt, ok) {
    const el = document.getElementById('osiris-sync-msg'); if (!el) return;
    el.textContent = txt || ''; el.style.color = ok ? '#14f195' : '#ff8a94';
}
