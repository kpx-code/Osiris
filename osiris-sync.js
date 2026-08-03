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

// localStorage-sleutels die we naar de cloud spiegelen (de EXACTE keys die je app schrijft).
const OSIRIS_STATE_KEYS = [
    'osirisWalletState', 'osirisOpenPositions', 'osirisPendingOrders',
    'osirisTradeLog', 'osirisLearningLog', 'osirisSessionLog',
    'osirisBotSettings', 'osirisIndicatorSettings',
    'osirisAdaptiveWeights', 'osirisRegimeWeights',
    'osirisL2', 'osirisL3',
    'osirisDeepNet_BTC', 'osirisDeepNet_ETH', 'osirisDeepNet_SOL',
    'osirisDeepNetTsAB', 'osirisDeepNetDynOff', 'osirisDeepNetLive',
    'osirisLiveEnabled', 'multiEngineRunning',
    'botIsRunning', 'botStartTime'
    // BEWUST NIET gesynct: 'osirisTestnetKeys' - API-keys horen niet in de cloud-DB.
];

// Deze run-vlaggen worden wel gespiegeld (voor backup/Fase 2) maar NIET teruggezet bij
// 'herstel', zodat een tweede apparaat niet per ongeluk een tweede engine start en zo
// dubbel op dezelfde testnet-wallet gaat traden. In Fase 1 draait de engine op 1 plek.
const OSIRIS_NO_RESTORE = ['botIsRunning', 'multiEngineRunning', 'botStartTime'];

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

async function osirisSignIn(email, pw) {
    if (!_sb) return;
    const { error } = await _sb.auth.signInWithPassword({ email, password: pw });
    if (error) {
        // bestaat nog niet? probeer registreren (solo-project: mail-bevestiging kun je in Supabase uitzetten)
        const s = await _sb.auth.signUp({ email, password: pw });
        if (s.error) alert('Login/registratie mislukt: ' + error.message);
        else alert('Account aangemaakt. Als e-mailbevestiging aan staat: check je inbox en log daarna in.');
    }
}
async function osirisSignOut() { if (_sb) await _sb.auth.signOut(); }

/* ---- PUSH: spiegel de staat + nieuwe trades naar de cloud, lees de afstandsbediening ---- */
async function osirisSyncPush() {
    if (!_sb || !_sbUser) return;
    try {
        // 1) staat-sleutels upserten (mirror)
        const rows = [];
        for (const k of OSIRIS_STATE_KEYS) {
            const v = localStorage.getItem(k);
            if (v == null) continue;
            let parsed; try { parsed = JSON.parse(v); } catch (e) { parsed = v; }
            rows.push({ user_id: _sbUser.id, key: k, value: parsed, updated_at: new Date().toISOString() });
        }
        if (rows.length) await _sb.from('osiris_state').upsert(rows, { onConflict: 'user_id,key' });

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

        // 3) afstandsbediening lezen -> lokaal toepassen
        const { data: ctrl } = await _sb.from('osiris_control').select('desired_running').eq('user_id', _sbUser.id).maybeSingle();
        if (ctrl) _osirisApplyDesiredRunning(ctrl.desired_running);

        _osirisSyncStamp('gesynct ' + new Date().toLocaleTimeString('nl-NL'));
    } catch (e) { console.warn('[osiris-sync] push-fout', e); _osirisSyncStamp('sync-fout (zie console)'); }
}
window.osirisSyncPush = osirisSyncPush;

/* ---- RESTORE (handmatig): haal de cloud-staat terug naar localStorage en herlaad ---- */
async function osirisRestoreFromCloud() {
    if (!_sb || !_sbUser) { alert('Log eerst in.'); return; }
    if (!confirm('Cloud-staat over je lokale staat heen zetten en de pagina herladen?')) return;
    const { data, error } = await _sb.from('osiris_state').select('key,value').eq('user_id', _sbUser.id);
    if (error) { alert('Restore-fout: ' + error.message); return; }
    (data || []).forEach(r => {
        if (OSIRIS_NO_RESTORE.includes(r.key)) return;   // engine niet auto-starten op dit apparaat
        localStorage.setItem(r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
    });
    location.reload();
}
window.osirisRestoreFromCloud = osirisRestoreFromCloud;

/* ---- afstandsbediening toepassen ----
 * In FASE 1 werkt dit alleen als DEZE browser de engine draait. Echte 24/7-
 * afstandsbediening komt in FASE 2, wanneer de Oracle-worker deze vlag leest. */
function _osirisApplyDesiredRunning(want) {
    try {
        const running = (typeof isBotRunning !== 'undefined') ? isBotRunning : false;
        if (want && !running && typeof startAutonomousBot === 'function') startAutonomousBot();
        else if (!want && running && typeof stopAutonomousBot === 'function') stopAutonomousBot();
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

/* ---- minimale UI (klein zwevend paneel rechtsonder) ---- */
function _osirisSyncBuildUI() {
    if (document.getElementById('osiris-sync-box')) return;
    const box = document.createElement('div');
    box.id = 'osiris-sync-box';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#071018;border:1px solid rgba(0,217,255,0.3);border-radius:8px;padding:9px 11px;font:11px/1.4 "JetBrains Mono",monospace;color:#cfe3f0;max-width:250px;';
    box.innerHTML = `
      <div style="color:#7fd8ff;letter-spacing:1px;margin-bottom:6px;">OSIRIS · CLOUD-SYNC</div>
      <div id="osiris-sync-auth"></div>
      <div id="osiris-sync-stamp" style="color:#5c7488;margin-top:6px;">niet ingelogd</div>`;
    document.body.appendChild(box);
    _osirisSyncRenderAuth();
}
function _osirisSyncRenderAuth() {
    const el = document.getElementById('osiris-sync-auth'); if (!el) return;
    if (_sbUser) {
        el.innerHTML = `<div style="color:#14f195;">✓ ${(_sbUser.email || 'ingelogd')}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">
            <button onclick="osirisSyncPush()" style="cursor:pointer;">sync nu</button>
            <button onclick="osirisRestoreFromCloud()" style="cursor:pointer;">herstel</button>
            <button onclick="osirisSignOut()" style="cursor:pointer;">uit</button>
          </div>`;
    } else {
        el.innerHTML = `<input id="osiris-sync-email" placeholder="e-mail" style="width:100%;margin-bottom:4px;">
          <input id="osiris-sync-pw" type="password" placeholder="wachtwoord" style="width:100%;margin-bottom:4px;">
          <button onclick="osirisSignIn(document.getElementById('osiris-sync-email').value,document.getElementById('osiris-sync-pw').value)" style="cursor:pointer;width:100%;">inloggen / registreren</button>`;
    }
}
function _osirisSyncStamp(txt) { const el = document.getElementById('osiris-sync-stamp'); if (el) el.textContent = txt; }
