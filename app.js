// - UOTAM CONFIGURATIE EN PARAMETERS --
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;
// Confluence-drempels (herijkt 13-07 na de meter-fixes; zie calculateConfluence)
const CONF_VFM_TH = 0.8;
const CONF_DB_TH = 0.3;
const CONF_CHAOS_TH = 0.30;
const CONF_ER_TH = 1.2;

// ONTKOPPELING BOT vs. VIEW (13-07): de bot rekent ALTIJD op 15m spot-data
// (BOT_INTERVAL); currentInterval is voortaan uitsluitend de CHART-WEERGAVE.
// Wisselen van view (1m/30m/45m/1h/4h) raakt de handelslogica dus niet meer.
const BOT_INTERVAL = '15m';
const BOT_INTERVAL_MS = 15 * 60 * 1000;
let currentInterval = '15m'; // VIEW-interval van de chart (niet van de bot)
let viewData = [];           // candles van de huidige chart-view (klines-formaat)
let viewWs = null;           // aparte WebSocket voor de chart-view (indien != 15m)

let currentWs = null; // Dit is cruciaal: Onthoudt actieve WebSocket-verbinding
let rawData = [];
// Houd een lijst bij van alle nodes waarvoor we puntjes willen tonen -
let activeNodes = [];
let allNodes = []; // Hierin slaan we de gedetecteerde nodes op
let gridMarkers = []; // Zorg dat deze hier staat
// FIX: LightweightCharts.createSeriesMarkers() geeft één plugin-instantie terug
// die je moet HERGEBRUIKEN via .setMarkers() om te updaten. Hem telkens opnieuw
// aanroepen (zoals voorheen overal gebeurde) stapelt marker-sets op elkaar i.p.v.
// ze te vervangen - daardoor bleven bij het node-type filter alle oude markers
// gewoon zichtbaar. Deze referentie zorgt dat er maar één instantie bestaat.
let nodeMarkersPlugin = null;
// Globale variabele voor je lens (zorg dat deze bovenin staat)
let uotamHarmonicSetting = 3; 
// Houd een referentie bij van de actieve lijnen zodat we ze kunnen verwijderen
let activeFibLines = [];
// FIX: de MIC/MES/MAC-fibs werden voorheen alleen berekend als die schaal
// zichtbaar stond via de dropdown - de bot kon er dus niet bij als de
// gebruiker bijvoorbeeld alleen "Micro" had aangevinkt. Nu wordt dit altijd
// berekend (computeFibScaleLevels), losstaand van wat er getekend wordt, en
// gebruikt de bot's eigen entry-logica DEZELFDE waarden als de chart.
let currentFibLevels = { MIC: null, MES: null, MAC: null };
let lastProcessedNodeId = null;
let sentimentWs = null;
let activeFibScales = {
    MIC: true, // Alleen deze staat bij start aan
    MES: false,
    MAC: false
};
// Welke node-types worden als marker op de chart getoond (allemaal standaard aan,
// net als voorheen toen dit nog niet toggelbaar was).
let activeNodeTypes = {
    RESET: true,
    VOLA: true,
    VORTEX3: true,
    VORTEX6: true,
    OSC: true,
    MIDPULSE: true
};
// Open-posities als lijnen op de chart tonen (entry/target/stop), standaard uit.
let showPositionLines = false;
let positionChartLines = []; // referenties zodat we ze kunnen verwijderen bij een update
//bot globale var
// Globale variabelen (cruciaal voor de bot)
let livePrice = 0;
let liveVol = 0;
let isBullish = true;

// --- BOT INSTELLINGEN ---
// maxAllocationPct/stopLossPct zijn fracties (0.70 = 70%). minProbabilityPct/
// minProjectedProfitPct zijn percentages (90 = 90%, 1 = 1%).
let botSettings = {
    maxAllocationPct: 0.70,      // max 70% van de equity per trade
    stopLossPct: 0.02,           // -2% harde stop, niet onderhandelbaar
    profitHoldTriggerPct: 0.02,  // vanaf +2% winst mag Osiris zelf beslissen: houden of innen
    trailBufferPct: 0.01,        // trailing-marge zodra we boven de trigger houden
    minProjectedProfitPct: 1,    // alleen openen als het verwachte doel >1% winst oplevert
    minProbabilityPct: 70,       // alleen openen als Osiris' zekerheids-score >=70% (was 90% - verlaagd voor meer entries/P&L-kansen, instelbaar via UI)
    holdContinuationMinProbabilityPct: 85, // STRENGER dan entries: je zet al zekere winst op het spel om op meer te gokken, dus de lat moet hoger liggen
    minProfitForTrendExit: 0.002, // ondergrens (0.2%) voordat een trendommekeer al winst mag verzilveren - voorkomt churn op ruis
    // WINST-BESCHERMING (data 12-07): trend-trades piekten gem. +0.18% maar
    // realiseerden +0.03% - 0.15%-punt weggegeven per trade. Simulatie op de
    // sessiedata waarschuwde echter: bescherming die al bij 0.3%-pieken
    // ingrijpt kapt winnaars af (backtest: +0.34 i.p.v. +1.12%-punt), omdat
    // zulke pieken binnen de ruis+kostenband (~0.24% r.t.) vallen. Daarom:
    // pas actief vanaf een piek die de kosten ruim overstijgt, en dan een
    // ruime greep (55% van de piek behouden) i.p.v. een krappe.
    profitProtectActivationPct: 0.005, // piek (0.5%) waarboven winst-bescherming actief wordt
    profitProtectKeepPct: 55,          // sluit zodra P/L onder dit % van de piek zakt
    // KANS-COLLAPS EXIT (screenshot 12-07): positie toonde "winkans nu ~32%
    // (bij entry ~95%)" maar bleef bevroren in de neutrale zone wachten op de
    // vaste winst/verlies-drempels. Als de live kans voor de eigen kant
    // aanhoudend instort, is wachten geen discipline meer maar ontkenning.
    // De bevestigingstijd (default 120s = "2-3 candles") voorkomt reageren op
    // één slechte meting - dit is de geformaliseerde versie van het inzicht
    // dat een omkeer zich vaak 2-3 candles na een node aftekent.
    // KANS-COLLAPS AAN/UIT (17-07). Meting over de hele learningLog:
    // PROB_COLLAPSE_EXIT = 121 trades, winrate 13%, bijdrage -7.05 %-punt.
    // ALLE andere exits samen = 48 trades, winrate 67%, +2.82 %-punt.
    // Winnaars werden 14 min vastgehouden, verliezers 9 min: het mechanisme
    // maait posities om vóór de these getoetst is. Daarom nu uitschakelbaar;
    // met false doen stop-loss, winst-bescherming, tijd-stop en oogst het werk.
    probCollapseEnabled: true,
    probCollapseThresholdPct: 35,      // live winkans waaronder de collaps-teller start
    probCollapseConfirmSeconds: 120,   // zo lang moet de kans onafgebroken onder de drempel blijven
    // REGIME-POORT (13-07): de sessiedata laat consequent zien dat de bot
    // verliest in samengedrukte, energieloze ranges (avg trade 0.03% bij 0.24%
    // kosten) en verdient in trends. Als chaos (gerealiseerde vol) EN |VFM|
    // beide aanhoudend onder hun eigen mediaan van de recente historie liggen,
    // valt er structureel niets te oogsten - dan worden nieuwe entries
    // gepauzeerd. "Niet handelen" is in dat regime het winstgevendste besluit.
    regimeGateEnabled: true,
    regimeGateConfirmMinutes: 3,       // zo lang moet het dode regime aanhouden voordat de poort sluit
    // TIJD-STOP (13-07): een positie die na zo veel minuten nog rond
    // break-even hangt (binnen de kostenband) heeft zijn these niet
    // waargemaakt en bindt alleen kapitaal + risico. Sluiten en herbeoordelen.
    maxPositionAgeMinutes: 90,
    // KANS-SMOOTHING (14-07): de nachtsessie liet zien dat de kansscore
    // hyperreactief was - entries op ~95% stortten binnen 14 min onder de 25%
    // (10 van 12 exits = PROB_COLLAPSE, kalibratie: 90-100%-bucket won 25%).
    // Eén MA-flip kon de hele score laten zwiepen. Beslissingen (entry én
    // collaps) rekenen nu met de MEDIAAN van de laatste N metingen per kant:
    // één uitschieter telt niet meer, een aanhoudende verschuiving wel.
    probSmoothingSamples: 6,           // ~1 minuut historie bij een 10s-scancyclus
    // KLEINE-WINST-OOGST (14-07, Markov-analyse op 153 trades / 4975
    // overgangen): vanuit de kleine-winst-zone (kosten..activatie) is de kans
    // om ooit de activatiedrempel te halen maar 41%, en vanuit 0.5-1.0% haalt
    // slechts 11% ooit de 1%. Wachten in die zones is -EV zodra het lang
    // duurt. Regel: staat een trade >= dit aantal minuten in de winst boven
    // de kosten zonder ooit de winst-beschermingsactivatie te hebben gehaald,
    // dan wordt de winst geoogst. Beleidssimulatie op de echte trade-paden:
    // +22.4 vs +18.4 (zonder oogst) vs +1.5 (werkelijk gerealiseerd). 0 = uit.
    smallProfitHarvestMinutes: 30,
    // NODE-GEWICHT (15-07). Drie onafhankelijke toetsen vonden geen robuust
    // node-effect: spectraalanalyse (geen 188.66-min periodiciteit), respons-
    // analyse (30/60/90/120 min na node = baseline), en de learningLog (node-
    // invloed >5 -> winrate 18-21%). De kantelpunt-toets gaf als enige iets:
    // momentum zet door op gewone momenten (r=+0.149) maar niet op nodes
    // (r=-0.114), verschil z=-2.94 p=0.0033, permutatie p=0.013 - maar het
    // repliceerde NIET in de split-half (1e helft -0.212, 2e helft +0.041) en
    // overleeft geen Bonferroni over ~50 toetsen (p_corr ~ 0.16).
    // Daarom: geen prijscomponent inbouwen op zwak bewijs, maar het gewicht
    // wel expliciet in handen van de gebruiker leggen.
    //   'adaptive' = het lerende systeem bepaalt (kan tot 0.5x dempen)
    //   'manual'   = vast op nodeWeightManual (0 = node-invloed volledig uit)
    // Hertoets de kantelpunt-correlatie over ~1 maand op verse data.
    nodeWeightMode: 'adaptive',
    nodeWeightManual: 1.0,
    minLossForEarlyExit: 0.003,  // ondergrens (0.3%) verlies voordat de bot vroegtijdig mag sluiten op bevestigde tegentrend, vóór de volle stop-loss
    maxOpenPositions: 3,         // totaal aantal posities dat tegelijk open mag staan (over beide kanten samen), hard begrensd op 4
    minHedgeReservePct: 0.15,    // gereserveerde allocatie voor een eventuele hedge op de andere kant, ALLEEN als die kant nog geen positie heeft
    pendingOrderTtlMinutes: 30,  // hoe lang een pending order geldig blijft als hij niet eerder triggert of wordt herbeoordeeld (zie revalidatePendingOrders)
    continuationConfirmationSeconds: 20, // hoeveel seconden een "niet langer gunstig"-signaal moet aanhouden vóórdat PROFIT_LOCKED/TREND_REVERSAL_EXIT/EARLY_STOP_TREND daadwerkelijk sluit - voorkomt sluiten op een enkele, kortstondige meting die toevallig op het omslagpunt zelf valt
    // --- RANGE-SCALP: aparte, altijd-actieve modus naast de trend-logica ---
    // Verkoopt bij de top van een recente zijwaartse range, koopt bij de bodem -
    // andersom dan de trend-volgende logica hierboven, met een klein vast doel
    // i.p.v. de log-gedempte meso-target.
    rangeScalpProfitTargetPct: 0.3,  // klein, vast winstdoel (kan ook 0.2 zijn, instelbaar)
    rangeScalpStopLossPct: 0.5,      // eigen, krappere stop-loss dan de normale 2% - past bij het kleinere doel
    rangeScalpAllocationPct: 0.10,   // vaste, kleine allocatie per scalp (i.p.v. confluence-geschaald zoals trend-trades)
    // --- CHASE: pending order eerder invullen als het signaal heel sterk blijft ---
    chaseEnabled: true,
    chaseProbabilityThreshold: 90,  // pas chasen bij een duidelijk hogere kans dan de gewone entry-drempel
    chaseAfterMinutes: 10,          // hoe lang een order eerst gewoon op de pullback mag wachten voordat chasen mag
    // --- REALLOCATIE: ruimte maken voor een duidelijk betere nieuwe kans ---
    reallocationEnabled: true,
    reallocationMarginPct: 15,      // nieuwe kans moet minstens dit veel hoger scoren dan de zwakste bestaande positie
    reallocationMinAgeMinutes: 15,  // FIX (data 12-07): een positie moet minimaal zo oud zijn voordat ze wegge-realloceerd mag worden - 29 van 42 exits waren reallocaties (netto -3.86 EUR) die posities gemiddeld na 28 min sloten, precies vóór de trend-reversal-fase (44 min) waar de winst zat
    reallocationCooldownMinutes: 10, // minimale tijd tussen twee reallocaties - voorkomt kettingreacties van churn binnen enkele scans
    // --- FEES: gesimuleerde handelskosten per zijde (taker). Binance spot taker = 0.1%.
    // Zonder dit optimaliseert de bot onbewust voor veel micro-trades: de sessie van
    // 12-07 pakte 1.45 EUR bruto over 42 trades, terwijl 0.1%/zijde ~25 EUR aan
    // fees had gekost. Alle PnL en entry-drempels rekenen nu netto-na-fees.
    feePct: 0.1,                    // percentage per zijde (0.1 = 0.1%); round-trip = 2x
    // SLIPPAGE: verschil tussen livePrice (waarop de simulatie vult) en de prijs
    // waarop een echte order gevuld zou worden (halve spread + orderboek-diepte).
    // Voor BTC/USDT spot bij kleine notionals is dit klein (~0.01-0.05% per
    // zijde), maar de gemiddelde trade van de sessie 12-07 pakte maar 0.03%
    // beweging - op die schaal telt zelfs 0.02% per zijde volwaardig mee.
    slippagePct: 0.02,              // percentage per zijde; 0 = uit
    // EXECUTIE: 'SIM' = interne simulatie (zoals altijd), 'TESTNET' = echte
    // market-orders naar Binance Spot Testnet (nepgeld, echt orderboek).
    // In TESTNET-modus komen fill-prijs en commissie van de exchange en staat
    // de eigen fee/slippage-simulatie automatisch uit.
    executionMode: 'SIM',
    isRunning: false
};

// Round-trip TRANSACTIEKOSTEN (fees + slippage, beide zijden) als PERCENTAGE -
// dit is het getal dat elke trade minimaal moet overwinnen om break-even te zijn.
function roundTripCostPct() { return ((botSettings.feePct || 0) + (botSettings.slippagePct || 0)) * 2; }
// Behouden voor bestaande aanroepen/leesbaarheid: alleen de fees, zonder slippage.
function roundTripFeePct() { return (botSettings.feePct || 0) * 2; }

// ============================================================
// BINANCE SPOT TESTNET EXECUTIE
// ============================================================
// In executionMode 'TESTNET' stuurt de bot echte market-orders naar
// testnet.binance.vision (nepgeld, echt orderboek met echte matching).
// Ontwerpkeuzes:
// - API-keys staan in een EIGEN localStorage-sleutel ('osirisTestnetKeys'),
//   bewust NIET in botSettings, zodat ze nooit in de full export of de
//   instellingen-export terechtkomen.
// - Signing gebeurt met HMAC-SHA256 via de Web Crypto API (crypto.subtle) -
//   dat werkt alleen op HTTPS, en GitHub Pages serveert HTTPS, dus dat past.
// - LONG = BUY dan SELL. SHORT = SELL dan BUY ("inventory short"): spot kent
//   geen echte shorts, maar BTC uit het testnet-saldo verkopen en later
//   goedkoper terugkopen levert exact dezelfde PnL-dynamiek op. Vereist wel
//   BTC-saldo; het testnet verstrekt dat bij elke maandelijkse reset.
// - Interne wallet-boekhouding blijft in EUR/USD zoals ingesteld; orders
//   worden gesized in USDT via de bestaande eurUsdtRate-conversie. PnL-
//   percentages zijn valuta-onafhankelijk, dus het grootboek blijft kloppen.
// - In TESTNET-modus staat de eigen fee/slippage-simulatie uit: de fill-prijs
//   en commissie komen van de exchange zelf en zijn dus al "echt".
// ============================================================
// TRANSPORT: de REST-endpoints van testnet.binance.vision sturen geen CORS-
// headers, dus signed fetch()-calls vanuit een browserpagina worden door de
// browser zelf geblokkeerd ("Failed to fetch", geconstateerd op 12-07 vanaf
// GitHub Pages). Daarom loopt ALLE communicatie hier over de officiële
// Binance WebSocket API (wss://ws-api.testnet.binance.vision/ws-api/v3):
// WebSockets vallen buiten het CORS-mechanisme en werken dus wel volledig
// client-side. Zelfde functionaliteit (order.place, account.status,
// exchangeInfo), zelfde HMAC-signing - alleen het vervoermiddel verschilt.
// Let op één subtiel verschil met REST: bij de WS API wordt de signature
// berekend over ALLE parameters ALFABETISCH gesorteerd, niet in verzendvolgorde.
const TESTNET_WS_API_URL = 'wss://ws-api.testnet.binance.vision/ws-api/v3';
const TESTNET_SYMBOL = 'BTCUSDT';
let testnetSymbolFilters = null; // { stepSize, minQty, minNotional } - lazy geladen uit exchangeInfo

function getTestnetKeys() {
    try {
        const raw = localStorage.getItem('osirisTestnetKeys');
        return raw ? JSON.parse(raw) : { apiKey: '', secret: '' };
    } catch (e) { return { apiKey: '', secret: '' }; }
}

function saveTestnetKeysFromInputs() {
    const apiKey = (document.getElementById('testnet-api-key')?.value || '').trim();
    const secret = (document.getElementById('testnet-api-secret')?.value || '').trim();
    if (!apiKey || !secret) { setTestnetStatus('Vul zowel key als secret in.', true); return; }
    localStorage.setItem('osirisTestnetKeys', JSON.stringify({ apiKey, secret }));
    setTestnetStatus('Keys lokaal opgeslagen. Klik "Test verbinding" om te controleren.');
}

function setTestnetStatus(msg, isError = false) {
    const el = document.getElementById('testnet-status');
    if (el) { el.textContent = msg; el.style.color = isError ? '#ff5555' : 'var(--teal, #00ffcc)'; }
    if (isError) console.warn('Testnet:', msg);
}

async function hmacSha256Hex(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- WebSocket-verbinding met request/response-administratie ---
let wsApi = null;
let wsApiConnecting = null;
let wsApiIdCounter = 1;
const wsApiPending = new Map(); // id -> { resolve, reject }

function ensureWsApiConnection() {
    if (wsApi && wsApi.readyState === WebSocket.OPEN) return Promise.resolve();
    if (wsApiConnecting) return wsApiConnecting;
    wsApiConnecting = new Promise((resolve, reject) => {
        let settled = false;
        const sock = new WebSocket(TESTNET_WS_API_URL);
        sock.onopen = () => { settled = true; wsApi = sock; wsApiConnecting = null; resolve(); };
        sock.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            const pending = msg.id != null ? wsApiPending.get(msg.id) : null;
            if (!pending) return;
            wsApiPending.delete(msg.id);
            if (msg.status === 200) pending.resolve(msg.result);
            else pending.reject(new Error(`Testnet ${msg.status}: ${msg.error?.msg || 'onbekende fout'} (code ${msg.error?.code ?? '?'})`));
        };
        sock.onerror = () => {
            if (!settled) { settled = true; wsApiConnecting = null; reject(new Error('WebSocket-verbinding met ws-api.testnet.binance.vision mislukt')); }
        };
        sock.onclose = () => {
            wsApi = null; wsApiConnecting = null;
            // Alles wat nog onderweg was netjes laten falen; de aanroepende
            // logica (entry skipt, exit probeert volgende cyclus opnieuw) vangt dit op.
            for (const [, p] of wsApiPending) p.reject(new Error('WebSocket-verbinding gesloten'));
            wsApiPending.clear();
        };
    });
    return wsApiConnecting;
}

// Eén request-functie voor alle testnet-calls, nu over de WS API.
// signed=true voegt apiKey/timestamp/recvWindow toe en berekent de signature
// over alle parameters in ALFABETISCHE volgorde (WS API-vereiste).
async function testnetWsRequest(method, params = {}, signed = false) {
    await ensureWsApiConnection();
    const keys = getTestnetKeys();
    const p = {};
    for (const [k, v] of Object.entries(params)) p[k] = String(v);
    if (signed) {
        if (!keys.apiKey || !keys.secret) throw new Error('Geen testnet API-keys ingesteld.');
        p.apiKey = keys.apiKey;
        p.timestamp = String(Date.now());
        p.recvWindow = '10000';
        const payload = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('&');
        p.signature = await hmacSha256Hex(keys.secret, payload);
    }
    const id = `osiris-${wsApiIdCounter++}`;
    return new Promise((resolve, reject) => {
        wsApiPending.set(id, { resolve, reject });
        setTimeout(() => {
            if (wsApiPending.has(id)) { wsApiPending.delete(id); reject(new Error(`timeout (15s) op ${method}`)); }
        }, 15000);
        try { wsApi.send(JSON.stringify({ id, method, params: p })); }
        catch (e) { wsApiPending.delete(id); reject(e); }
    });
}

// LOT_SIZE (stepSize/minQty) en NOTIONAL-filters ophalen en cachen - nodig om
// BTC-hoeveelheden correct af te ronden, anders weigert de exchange de order.
async function getTestnetSymbolFilters() {
    if (testnetSymbolFilters) return testnetSymbolFilters;
    const info = await testnetWsRequest('exchangeInfo', { symbol: TESTNET_SYMBOL });
    const sym = info.symbols?.[0];
    const lot = sym?.filters?.find(f => f.filterType === 'LOT_SIZE');
    const notional = sym?.filters?.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    testnetSymbolFilters = {
        stepSize: parseFloat(lot?.stepSize || '0.00001'),
        minQty: parseFloat(lot?.minQty || '0.00001'),
        minNotional: parseFloat(notional?.minNotional || '5')
    };
    return testnetSymbolFilters;
}

function roundToStep(qty, stepSize) {
    const decimals = Math.max(0, (stepSize.toString().split('.')[1] || '').length);
    return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(decimals));
}

async function getTestnetBalances() {
    const acc = await testnetWsRequest('account.status', {}, true);
    const bal = {};
    (acc.balances || []).forEach(b => { bal[b.asset] = parseFloat(b.free); });
    return bal;
}

// Market-order plaatsen. opts: { quoteOrderQty } (USDT-bedrag, voor entries)
// of { quantity } (BTC-hoeveelheid, voor exits van een bestaande positie).
// newOrderRespType FULL zodat de respons de individuele fills bevat.
async function testnetMarketOrder(orderSide, opts) {
    const params = { symbol: TESTNET_SYMBOL, side: orderSide, type: 'MARKET', newOrderRespType: 'FULL' };
    if (opts.quoteOrderQty != null) params.quoteOrderQty = opts.quoteOrderQty.toFixed(2);
    if (opts.quantity != null) params.quantity = String(opts.quantity);
    return testnetWsRequest('order.place', params, true);
}

// Gewogen gemiddelde fill-prijs + commissie (omgerekend naar USDT) uit een
// orderrespons. Commissie kan in USDT, BTC of BNB luiden; BNB is op het
// testnet zeldzaam en wordt conservatief op 0 gezet met een waarschuwing.
function summarizeTestnetFills(orderResponse) {
    const fills = orderResponse.fills || [];
    let qty = 0, cost = 0, commissionQuote = 0;
    for (const f of fills) {
        const fQty = parseFloat(f.qty), fPrice = parseFloat(f.price), comm = parseFloat(f.commission || '0');
        qty += fQty; cost += fQty * fPrice;
        if (f.commissionAsset === 'USDT') commissionQuote += comm;
        else if (f.commissionAsset === 'BTC') commissionQuote += comm * fPrice;
        else if (comm > 0) console.warn(`Testnet: commissie in ${f.commissionAsset} niet omgerekend (${comm}) - PnL telt deze niet mee.`);
    }
    const executedQty = parseFloat(orderResponse.executedQty || qty || '0');
    const avgPrice = qty > 0 ? cost / qty : parseFloat(orderResponse.price || '0');
    return { avgPrice, executedQty, commissionQuote };
}

// Zet de interne wallet gelijk aan de werkelijkheid op het testnet: valuta
// USDT, startkapitaal = vrij USDT-saldo. Zo betekent "Balance" in de UI
// hetzelfde als wat de exchange je daadwerkelijk laat besteden, en verdwijnt
// de EUR/USDT-spraakverwarring in TESTNET-modus volledig. Gebruikt de
// bestaande resetWallet()-flow inclusief de bevestigingsvraag, omdat een
// wallet-sync per definitie een schone sessie-start is.
async function syncWalletToTestnetBalance() {
    try {
        setTestnetStatus('Testnet-saldo ophalen...');
        const bal = await getTestnetBalances();
        const usdt = bal.USDT || 0;
        if (usdt <= 0) { setTestnetStatus('Geen vrij USDT-saldo gevonden op het testnet.', true); return; }
        // FIX (12-07): de sync zette het startkapitaal stilzwijgend op het VOLLEDIGE
        // testnet-saldo (10.000 USDT), waardoor posities 10x groter werden dan de
        // gebruiker met zijn oude 1.000-kapitaal gewend was. Nu vraagt de sync
        // hoeveel van het saldo de bot mag gebruiken - de rest blijft onaangeroerd
        // op het testnet staan (de bot sized altijd vanuit zijn eigen interne balance).
        const input = prompt(
            `Vrij testnet-saldo: ${usdt.toFixed(2)} USDT (en ${(bal.BTC || 0).toFixed(5)} BTC voor shorts).\n\n` +
            `Hoeveel USDT mag de bot als startkapitaal gebruiken?`,
            usdt.toFixed(2)
        );
        if (input === null) { setTestnetStatus('Sync geannuleerd.'); return; }
        const capital = parseFloat(input);
        if (isNaN(capital) || capital <= 0) { setTestnetStatus('Ongeldig bedrag - sync geannuleerd.', true); return; }
        if (capital > usdt) { setTestnetStatus(`Bedrag (${capital.toFixed(2)}) is hoger dan je vrije saldo (${usdt.toFixed(2)}) - sync geannuleerd.`, true); return; }
        const capitalInput = document.getElementById('start-capital');
        const currencyInput = document.getElementById('wallet-currency-select');
        if (capitalInput) capitalInput.value = capital.toFixed(2);
        if (currencyInput) currencyInput.value = 'USDT';
        setTestnetStatus(`Startkapitaal: ${capital.toFixed(2)} van ${usdt.toFixed(2)} USDT vrij saldo.`);
        resetWallet(); // vraagt zelf om bevestiging en leest de zojuist gezette invoervelden
    } catch (e) {
        setTestnetStatus(`Sync mislukt: ${e.message}`, true);
    }
}

// Verbindingstest voor de UI-knop: haalt het account op en toont de saldi.
async function testTestnetConnection() {
    setTestnetStatus('Verbinden met ws-api.testnet.binance.vision...');
    try {
        const bal = await getTestnetBalances();
        await getTestnetSymbolFilters();
        setTestnetStatus(`Verbonden via WebSocket. Saldo: ${(bal.USDT || 0).toFixed(2)} USDT | ${(bal.BTC || 0).toFixed(5)} BTC. Klaar voor TESTNET-modus.`);
        return true;
    } catch (e) {
        setTestnetStatus(`Verbinding mislukt: ${e.message} - check je keys en of je netwerk uitgaande WebSockets (wss, poort 443) toestaat.`, true);
        return false;
    }
}

// --- WALLET (persistente staat, los van botSettings.startingCapital-invoer) ---
let walletState = {
    startingCapital: 1000,
    realizedPnL: 0,   // cumulatieve gerealiseerde winst/verlies, in walletState.currency
    currency: 'EUR',  // de ECHTE rekeneenheid van de wallet - los van displayCurrency (die is puur voor de chart-prijzen)
    wins: 0,
    losses: 0
};

// Meerdere posities tegelijk = hedging (LONG + SHORT naast elkaar toegestaan)
let openPositions = [];   // { id, side, entryPrice, amount, notional, sizePct, targetPrice, openTime, peakPnlPct, trailingStopPct }
let pendingOrders = [];   // { id, side, triggerPrice, direction, targetPrice, projectedProfitPct, probabilityPct, createdAt, expiresAt }

// Cache van de laatste (elke 10s) Osiris-berekening, gebruikt door de per-seconde
// hold/close-beslissing zodat we niet elke seconde alles hoeven te herberekenen.
let lastOsirisDecision = null;

// ============================================================
// NIVEAU 1 - ADAPTIEVE GEWICHTEN ("leren van fouten")
// Geen neuraal netwerk, geen black box: elke factor die meeweegt in de
// kans-score (confluence, node-invloed, momentum-invloed, fib-confluentie)
// heeft een eigen vermenigvuldigingsfactor die langzaam bijstelt op basis van
// hoe goed die factor in de PRAKTIJK voorspelde bij afgesloten trades. Begint
// altijd op 1.0 (= exact het oorspronkelijke gedrag) en beweegt nooit verder
// dan 0.5x-1.5x, en nooit met minder dan MIN_SAMPLE_SIZE trades per groep -
// bewust traag en behoudend, om niet te "leren" van ruis bij te weinig data
// (zie de node-correlatie-les eerder: te weinig samples geeft schijnpatronen).
// ============================================================
let adaptiveWeights = { confluence: 1.0, nodeInfluence: 1.0, momentumInfluence: 1.0, fibConfluence: 1.0, pattern: 1.0 };
let learningLog = []; // { timestampMs, side, factors: {confluence, nodeInfluence, momentumInfluence, fibConfluenceInfluence, probabilityPct}, outcome: 'win'|'loss', pnlPct }
let lastReallocationAt = 0; // timestamp (ms) van de laatste reallocatie - voor de cooldown-poort in tryReallocateForBetterOpportunity
// FIX (crash 12-07): sessionLog stond gedeclareerd op ~regel 1200, terwijl
// loadPersistentState() - dat sessionLog herstelt - al op ~regel 978 draait.
// `let` kent een temporal dead zone: de variabele bestaat vóór zijn declaratie-
// regel simpelweg nog niet, dus het herstel crashte met "Cannot access
// 'sessionLog' before initialization". De catch slokte dat op, waardoor OOK
// learningLog en adaptiveWeights (de regels erna) stilzwijgend nooit werden
// teruggeladen - elke refresh gooide dus het adaptieve leren weg. De declaratie
// hoort hier, bij de rest van de persistente state.
let sessionLog = [];
// FIX (crash 15-07): _calibMap stond gedeclareerd bij de kalibratiefunctie
// (~regel 3260), terwijl loadPersistentState() - dat computeCalibrationMap()
// aanroept - al rond regel 1300 draait. Zelfde temporal-dead-zone-val als
// eerder met sessionLog: "Cannot access '_calibMap' before initialization".
// En met dezelfde stille schade: de catch slokte de fout op, waardoor de regel
// ERNA (adaptiveWeights herstellen) bij ELKE page-load werd overgeslagen.
// Declaratie hoort hier, bij de rest van de persistente state.
let _calibMap = null; // gesorteerde [rawMid, observedWinratePct]-punten
const MIN_SAMPLE_SIZE = 20; // minimaal aantal trades per groep voordat een gewicht wordt aangepast
let lastCalibrationSummary = null; // voor het transparantie-paneel

let lastOsirisMetrics = null;

let botTradeLog = [];
let osirisSystemLog = [];
let botInterval = null; // FIX: was nooit gedeclareerd, liep als impliciete global (breekt in strict mode)

// Bovenin bij je andere variabelen:
let vfm = 0;
let er = 0;
let db = 0;
let chaos = 0;

const fibPalettes = {
    MIC: { style: LightweightCharts.LineStyle.Dotted },
    MES: { style: LightweightCharts.LineStyle.Dashed },
    MAC: { style: LightweightCharts.LineStyle.Solid }
};

// prachtige kleuren globaal gedefinieerd:
const fibStyles = {
    '1.0':    { color: '#ffffff', label: '1.0' },
    '1.272':  { color: '#ff00ff', label: 'EXT 1.272' },
    '1.618':  { color: '#ff0000', label: 'EXT 1.618' },
    '0.786':  { color: '#26c6da', label: '0.782' },
    '0.618':  { color: '#66bb6a', label: '0.618' },
    '0.500':  { color: '#42a5f5', label: '0.5' },
    '0.382':  { color: '#ffa726', label: '0.382' },
    '0.236':  { color: '#fff176', label: '0.236' },
    '0.0':    { color: '#ffffff', label: '0.0' },
    '-0.236': { color: '#ffccbc', label: '-0.236' },
    '-0.382': { color: '#ffab91', label: '-0.382' },
    '-0.500': { color: '#ef9a9a', label: '-0.5' },
    '-0.618': { color: '#e57373', label: '-0.618' },
    '-0.786': { color: '#ef5350', label: '-0.782' }
};


// - INITIALISEER HET TRADINGVIEW CHART INTERFACE ---
const chartContainer = document.getElementById('chart-container');

// FIX: chart-hoogte stond vast op 600px, wat op een telefoonscherm het
// grootste deel van de pagina inneemt. Schaalt nu mee met de viewportbreedte.
function getResponsiveChartHeight() {
    return window.innerWidth < 768 ? 350 : 600;
}

const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: getResponsiveChartHeight(),
    layout: {
        background: { color: '#131722' },
        textColor: '#d1d4dc',
    },
    grid: {
        vertLines: { color: '#1f2233' },
        horzLines: { color: '#1f2233' },
    },
    crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
    },
    timeScale: {
        timeVisible: true,
        secondsVisible: false,
    },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
});

// ============================================================
// MOVING AVERAGE (SMA) - toggelbaar zoals de fib/node-lagen, en meewegend
// in de bot-redenering (trend-bevestiging: ligt de prijs boven/onder de MA?)
// ============================================================
// MOVING AVERAGE (SMA) - twee lijnen (fast/slow), zoals bij een normale MA-
// crossover-strategie. Standaard 9/21 - een gangbare, veelgebruikte combinatie
// voor kortetermijn-signalen op een 15m-chart. Instelbaar via UI. Een
// "golden cross" (fast kruist slow omhoog) of "death cross" (omlaag) wordt
// gedetecteerd en telt mee in de redenering.
// ============================================================
let maFastPeriod = 9;
let maSlowPeriod = 21;
let maFastSeries = null;
let maSlowSeries = null;
let showMovingAverage = false;
let lastMACrossoverState = null; // 'above' | 'below' | null - om een NIEUWE kruising te detecteren

function calculateSMA(closes, period) {
    if (!closes || closes.length < period) return [];
    const result = [];
    for (let i = period - 1; i < closes.length; i++) {
        const window = closes.slice(i - period + 1, i + 1);
        const avg = window.reduce((a, b) => a + b, 0) / period;
        result.push(avg);
    }
    return result;
}

// Actuele MA-waarden voor gebruik in de beslislogica (niet afhankelijk van of
// de lijnen zichtbaar staan op de chart).
function getCurrentMAValues() {
    if (!rawData || rawData.length < Math.max(maFastPeriod, maSlowPeriod)) return { fast: null, slow: null };
    const closesFast = rawData.slice(-maFastPeriod).map(d => parseFloat(d[4]));
    const closesSlow = rawData.slice(-maSlowPeriod).map(d => parseFloat(d[4]));
    return {
        fast: closesFast.reduce((a, b) => a + b, 0) / closesFast.length,
        slow: closesSlow.reduce((a, b) => a + b, 0) / closesSlow.length
    };
}

// Backwards-compatible alias (elders in de code gebruikt als "de" MA-waarde)
function getCurrentMAValue() {
    return getCurrentMAValues().fast;
}

// Detecteert een VERSE kruising (golden/death cross) t.o.v. de vorige check -
// geeft alleen 'bullish'/'bearish' terug op het moment van de kruising zelf,
// niet zolang de ene lijn simpelweg boven/onder de andere blijft liggen.
function detectMACrossover() {
    const { fast, slow } = getCurrentMAValues();
    if (fast === null || slow === null) return null;

    const state = fast > slow ? 'above' : 'below';
    let crossover = null;
    if (lastMACrossoverState !== null && state !== lastMACrossoverState) {
        crossover = state === 'above' ? 'bullish' : 'bearish'; // golden cross / death cross
    }
    lastMACrossoverState = state;
    return crossover;
}

function renderMovingAverage() {
    if (!showMovingAverage) {
        if (maFastSeries) { chart.removeSeries(maFastSeries); maFastSeries = null; }
        if (maSlowSeries) { chart.removeSeries(maSlowSeries); maSlowSeries = null; }
        return;
    }
    const src = (viewData && viewData.length) ? viewData : rawData;
    if (!src || src.length < Math.max(maFastPeriod, maSlowPeriod)) return;

    const closes = src.map(d => parseFloat(d[4]));
    const times = src.map(d => Math.floor(d[0] / 1000));

    const smaFast = calculateSMA(closes, maFastPeriod);
    const dataFast = smaFast.map((v, i) => ({ time: times[i + maFastPeriod - 1], value: v }));
    const smaSlow = calculateSMA(closes, maSlowPeriod);
    const dataSlow = smaSlow.map((v, i) => ({ time: times[i + maSlowPeriod - 1], value: v }));

    if (!maFastSeries) {
        maFastSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#ffa500', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: `MA${maFastPeriod}`
        });
    }
    if (!maSlowSeries) {
        maSlowSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#4287f5', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: `MA${maSlowPeriod}`
        });
    }
    maFastSeries.setData(dataFast);
    maSlowSeries.setData(dataSlow);
}

function handleMovingAverageSelect(value) {
    showMovingAverage = (value === 'VISIBLE');
    renderMovingAverage();
    const panel = document.getElementById('ma-inline-settings');
    if (panel) panel.style.display = showMovingAverage ? 'grid' : 'none';
}

function applyMASettings() {
    const fastInput = document.getElementById('ma-fast-period');
    const slowInput = document.getElementById('ma-slow-period');
    if (fastInput && !isNaN(parseInt(fastInput.value))) maFastPeriod = Math.max(2, parseInt(fastInput.value));
    if (slowInput && !isNaN(parseInt(slowInput.value))) maSlowPeriod = Math.max(3, parseInt(slowInput.value));
    if (maFastPeriod >= maSlowPeriod) maSlowPeriod = maFastPeriod + 1; // fast moet echt sneller zijn dan slow
    lastMACrossoverState = null; // reset kruisings-tracking bij periode-wijziging
    renderMovingAverage();
    savePersistentState(); // deze instellingen zijn live-instelbaar, dus meteen opslaan i.p.v. pas bij Start
}

// ============================================================
// RSI (14-periode, standaard formule) - eigen paneel onderaan de chart,
// toggelbaar, en gebruikt door de range-scalp-engine als extra bevestiging
// (overbought/oversold aan de randen van een range).
// ============================================================
// Standaard 14/70/30 - de klassieke Wilder-combinatie, instelbaar via UI.
let rsiPeriod = 14;
let rsiOverbought = 70;
let rsiOversold = 30;
let rsiSeries = null;
let showRSI = false;

function applyRSISettings() {
    const periodInput = document.getElementById('rsi-period');
    const obInput = document.getElementById('rsi-overbought');
    const osInput = document.getElementById('rsi-oversold');
    if (periodInput && !isNaN(parseInt(periodInput.value))) rsiPeriod = Math.max(2, parseInt(periodInput.value));
    if (obInput && !isNaN(parseInt(obInput.value))) rsiOverbought = Math.min(99, Math.max(51, parseInt(obInput.value)));
    if (osInput && !isNaN(parseInt(osInput.value))) rsiOversold = Math.min(49, Math.max(1, parseInt(osInput.value)));
    renderRSI();
    savePersistentState(); // deze instellingen zijn live-instelbaar, dus meteen opslaan i.p.v. pas bij Start
}

// ============================================================
// PRESETS: Conservatief / Balanced / Agressief - vult in één klik alle
// velden hieronder in, exact volgens de tabel in de User Manual §5. "Balanced"
// = de fabrieksinstellingen. Handmatig aanpassen na het kiezen van een preset
// kan gewoon - dit is een startpunt, geen vergrendeling.
// ============================================================
const PROFILE_PRESETS = {
    // KPX Mode 1: gebaseerd op de door de gebruiker geteste, agressieve setup.
    // HERZIEN na de sessie-analyse van 12-07 (42 trades, +1.45 EUR bruto, maar
    // ~25 EUR aan fictieve fees bij 0.1%/zijde) en de invoering van netto-na-fees:
    // - min-projected-profit 0.1%->0.5%: 0.1% doel bij 0.2% round-trip fees
    //   betekende dat ELKE trade die exact zijn doel haalde netto verlies was.
    // - range-scalp doel 0.5%->0.8% + stop 2%->1.2%: na fees was 0.5%/2% netto
    //   0.3% winst tegen 2.2% verlies - dat vereist 88% win rate, erger dan het
    //   1:8-probleem dat eerder al eens gefixt is. 0.8%/1.2% = netto 0.6/1.4,
    //   break-even bij 70%.
    // - reallocatie-guards (nieuw): min. leeftijd 15min + cooldown 10min. De
    //   sessie-data liet zien dat 29 van 42 exits reallocaties waren (netto
    //   -3.86 EUR) die posities gemiddeld na 28 min sloten - net vóór de
    //   trend-reversal-fase (gem. 44 min) waar de winst zat (+4.97 EUR).
    // - marge 50 blijft: op de nieuwe (logistisch gecomprimeerde) schaal is dat
    //   weer een betekenisvolle eis i.p.v. een die door de 100%-clamp continu
    //   triggerde.
    // Ongewijzigd: entry-drempel 60%, chase 82%/5min, stop-loss 1% - agressief
    // maar intern consistent.
    KPX_MODE_1: {
        'max-allocation-pct': 70, 'stop-loss-pct': 1, 'min-probability-pct': 60,
        'hold-continuation-probability-pct': 70, 'min-projected-profit-pct': 0.5,
        'max-open-positions': 4, 'hedge-reserve-pct': 10, 'pending-order-ttl': 45,
        'min-loss-early-exit': 0.3, 'continuation-confirmation-sec': 10, 'profit-protect-activation': 0.5, 'profit-protect-keep': 80,
        'prob-collapse-enabled': 'false', 'prob-collapse-threshold': 30, 'prob-collapse-confirm-sec': 180, 'prob-smoothing-samples': 18,
        'regime-gate-enabled': 'true', 'max-position-age': 90, 'node-weight-mode': 'adaptive', 'node-weight-manual': 1.0, 'small-profit-harvest': 30,
        'range-scalp-target-pct': 0.8, 'range-scalp-stop-pct': 1.2, 'range-scalp-alloc-pct': 20,
        'chase-probability-pct': 82, 'chase-after-minutes': 10,
        'reallocation-enabled': 'true', 'reallocation-margin-pct': 50,
        'reallocation-min-age': 15, 'reallocation-cooldown': 10, 'fee-pct': 0.1, 'slippage-pct': 0.02,
        'ma-fast-period': 12, 'ma-slow-period': 26,
        'rsi-period': 14, 'rsi-overbought': 70, 'rsi-oversold': 30
    },
    // CONSERVATIVE: hoge lat, weinig trades, kapitaalbehoud voorop.
    // FIX: range-scalp stond op doel 0.2% / stop 0.3% - na 0.2% round-trip fees
    // is dat netto 0.0% winst tegen 0.5% verlies: wiskundig gegarandeerd
    // verliesgevend, hoe goed het signaal ook is. Scalpen van micro-ranges kan
    // simpelweg niet uit bij realistische fees, dus voor dit profiel staat de
    // scalp-allocatie op 0 (uit). Reallocatie ook uit: churn past niet bij een
    // conservatief profiel dat winnaars de tijd wil geven.
    CONSERVATIVE: {
        'max-allocation-pct': 40, 'stop-loss-pct': 1.5, 'min-probability-pct': 80,
        'hold-continuation-probability-pct': 90, 'min-projected-profit-pct': 1.5,
        'max-open-positions': 2, 'hedge-reserve-pct': 25, 'pending-order-ttl': 20,
        'min-loss-early-exit': 0.2, 'continuation-confirmation-sec': 30, 'profit-protect-activation': 0.6, 'profit-protect-keep': 85,
        'prob-collapse-enabled': 'false', 'prob-collapse-threshold': 25, 'prob-collapse-confirm-sec': 240, 'prob-smoothing-samples': 24,
        'regime-gate-enabled': 'true', 'max-position-age': 120, 'node-weight-mode': 'adaptive', 'node-weight-manual': 1.0, 'small-profit-harvest': 45,
        'range-scalp-target-pct': 0.8, 'range-scalp-stop-pct': 0.8, 'range-scalp-alloc-pct': 0,
        'chase-probability-pct': 95, 'chase-after-minutes': 15,
        'reallocation-enabled': 'false', 'reallocation-margin-pct': 25,
        'reallocation-min-age': 30, 'reallocation-cooldown': 20, 'fee-pct': 0.1, 'slippage-pct': 0.02,
        'ma-fast-period': 20, 'ma-slow-period': 50,
        'rsi-period': 14, 'rsi-overbought': 75, 'rsi-oversold': 25
    },
    // BALANCED: de fabrieksinstellingen.
    // FIX: range-scalp 0.3%/0.5% was na fees netto +0.1% tegen -0.7% (vereiste
    // 88% win rate). Nu 0.7%/0.7%: netto +0.5% / -0.9%, break-even bij 64% -
    // haalbaar voor een mean-reversion scalp aan de rand van een range.
    BALANCED: {
        'max-allocation-pct': 70, 'stop-loss-pct': 2, 'min-probability-pct': 70,
        'hold-continuation-probability-pct': 85, 'min-projected-profit-pct': 1,
        'max-open-positions': 3, 'hedge-reserve-pct': 15, 'pending-order-ttl': 30,
        'min-loss-early-exit': 0.3, 'continuation-confirmation-sec': 20, 'profit-protect-activation': 0.5, 'profit-protect-keep': 80,
        'prob-collapse-enabled': 'false', 'prob-collapse-threshold': 30, 'prob-collapse-confirm-sec': 180, 'prob-smoothing-samples': 18,
        'regime-gate-enabled': 'true', 'max-position-age': 90, 'node-weight-mode': 'adaptive', 'node-weight-manual': 1.0, 'small-profit-harvest': 30,
        'range-scalp-target-pct': 0.7, 'range-scalp-stop-pct': 0.7, 'range-scalp-alloc-pct': 10,
        'chase-probability-pct': 90, 'chase-after-minutes': 10,
        'reallocation-enabled': 'true', 'reallocation-margin-pct': 20,
        'reallocation-min-age': 15, 'reallocation-cooldown': 10, 'fee-pct': 0.1, 'slippage-pct': 0.02,
        'ma-fast-period': 12, 'ma-slow-period': 26,
        'rsi-period': 14, 'rsi-overbought': 70, 'rsi-oversold': 30
    },
    // AGGRESSIVE: veel trades, snelle indicatoren (MA 5/13), lage drempels.
    // FIX: range-scalp 0.5%/0.8% was na fees netto +0.3% / -1.0% (vereiste 77%
    // win rate); nu 0.7%/1.0% = netto +0.5% / -1.2%, break-even bij ~71%.
    // Kortere reallocatie-guards dan de andere profielen (10min/5min) - dit
    // profiel MAG churnen, maar niet meer binnen dezelfde scan-cyclus.
    // Let op: MA 5/13 genereert in een zijwaartse markt veel valse crossovers;
    // dit profiel is bedoeld voor duidelijk trendende periodes.
    AGGRESSIVE: {
        'max-allocation-pct': 70, 'stop-loss-pct': 2.5, 'min-probability-pct': 60,
        'hold-continuation-probability-pct': 80, 'min-projected-profit-pct': 0.5,
        'max-open-positions': 4, 'hedge-reserve-pct': 10, 'pending-order-ttl': 45,
        'min-loss-early-exit': 0.5, 'continuation-confirmation-sec': 10, 'profit-protect-activation': 0.4, 'profit-protect-keep': 70,
        'prob-collapse-enabled': 'true', 'prob-collapse-threshold': 25, 'prob-collapse-confirm-sec': 120, 'prob-smoothing-samples': 12,
        'regime-gate-enabled': 'true', 'max-position-age': 60, 'node-weight-mode': 'adaptive', 'node-weight-manual': 1.0, 'small-profit-harvest': 20,
        'range-scalp-target-pct': 0.7, 'range-scalp-stop-pct': 1.0, 'range-scalp-alloc-pct': 15,
        'chase-probability-pct': 82, 'chase-after-minutes': 5,
        'reallocation-enabled': 'true', 'reallocation-margin-pct': 15,
        'reallocation-min-age': 10, 'reallocation-cooldown': 5, 'fee-pct': 0.1, 'slippage-pct': 0.02,
        'ma-fast-period': 9, 'ma-slow-period': 21,
        'rsi-period': 14, 'rsi-overbought': 65, 'rsi-oversold': 35
    }
};

function applyPreset(name) {
    if (name === 'MANUAL' || !PROFILE_PRESETS[name]) return; // "Handmatig" doet niets - velden blijven zoals ze staan

    const preset = PROFILE_PRESETS[name];
    Object.entries(preset).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    // MA/RSI zijn live-instelbaar (zie applyMASettings/applyRSISettings) - dus
    // meteen toepassen op de chart, ook als de bot nog niet gestart is.
    applyMASettings();
    applyRSISettings();

    console.log(`Preset "${name}" toegepast op alle velden. Klik Start Bot om de trend/scalp-instellingen te activeren.`);
}

function calculateRSISeries(closes, period) {
    if (!closes || closes.length < period + 1) return [];
    const result = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const delta = closes[i] - closes[i - 1];
        if (delta >= 0) gains += delta; else losses -= delta;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    result.push({ index: period, rsi: avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)) });

    for (let i = period + 1; i < closes.length; i++) {
        const delta = closes[i] - closes[i - 1];
        const gain = delta >= 0 ? delta : 0;
        const loss = delta < 0 ? -delta : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
        result.push({ index: i, rsi });
    }
    return result;
}

// Actuele RSI-waarde voor gebruik in de beslislogica (niet afhankelijk van of
// de lijn zichtbaar staat op de chart).
function getCurrentRSIValue() {
    if (!rawData || rawData.length < rsiPeriod + 1) return null;
    const closes = rawData.map(d => parseFloat(d[4]));
    const series = calculateRSISeries(closes, rsiPeriod);
    if (series.length === 0) return null;
    return series[series.length - 1].rsi;
}

function renderRSI() {
    if (!showRSI) {
        if (rsiSeries) { chart.removeSeries(rsiSeries); rsiSeries = null; }
        return;
    }
    const src = (viewData && viewData.length) ? viewData : rawData;
    if (!src || src.length < rsiPeriod + 1) return;

    const closes = src.map(d => parseFloat(d[4]));
    const times = src.map(d => Math.floor(d[0] / 1000));
    const series = calculateRSISeries(closes, rsiPeriod);
    const data = series.map(s => ({ time: times[s.index], value: s.rsi }));

    if (!rsiSeries) {
        rsiSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#c678dd', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
            priceScaleId: 'rsi-scale'
        });
        chart.priceScale('rsi-scale').applyOptions({
            scaleMargins: { top: 0.85, bottom: 0 } // klein paneeltje onderaan de chart
        });
    }
    rsiSeries.setData(data);
}

function handleRSISelect(value) {
    showRSI = (value === 'VISIBLE');
    renderRSI();
    const panel = document.getElementById('rsi-inline-settings');
    if (panel) panel.style.display = showRSI ? 'grid' : 'none';
}

// ============================================================
// LINEAIRE VOORSPELLING - een simpele lineaire regressie over de recente
// candles, doorgetrokken naar een gekozen horizon in de toekomst. Puur een
// extrapolatie van de recente trend (geen node/vfm-input), bedoeld als extra,
// onafhankelijke bevestiging naast de rest - niet als losstaand handelssignaal.
// ============================================================
const PREDICTION_HORIZONS_MIN = { '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '24h': 1440 };
let predictionBullishSeries = null;
let predictionBearishSeries = null;
let showPrediction = false;
let predictionHorizonMinutes = 60;

function linearRegressionFit(points) {
    const n = points.length;
    const sumX = points.reduce((a, p) => a + p.x, 0);
    const sumY = points.reduce((a, p) => a + p.y, 0);
    const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
    const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
    const denom = (n * sumXX - sumX * sumX);
    if (denom === 0) return { slope: 0, intercept: sumY / n };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

// Exponentieel-gewogen variant: recentere candles (hogere x) wegen zwaarder
// mee dan oudere, net als bij een EMA. Dit is bewust GEEN letterlijke
// exponentiële groeicurve op de prijs zelf - dat zou bij langere horizons
// (bijv. 24u) numeriek instabiel worden (een kleine positieve helling
// "ontploft" al snel bij compounding), en prijsbewegingen over uren gedragen
// zich sowieso niet echt exponentieel. Gewogen lineaire regressie is de
// standaard, stabiele manier om "recente data telt zwaarder" te implementeren.
function exponentialWeightedRegressionFit(points, decay = 0.94) {
    const n = points.length;
    let sumW = 0, sumWX = 0, sumWY = 0, sumWXY = 0, sumWXX = 0;
    points.forEach((p, i) => {
        const w = Math.pow(decay, n - 1 - i); // i dichtbij het einde -> gewicht dichtbij 1
        sumW += w;
        sumWX += w * p.x;
        sumWY += w * p.y;
        sumWXY += w * p.x * p.y;
        sumWXX += w * p.x * p.x;
    });
    const denom = sumW * sumWXX - sumWX * sumWX;
    if (denom === 0) return { slope: 0, intercept: sumWY / sumW };
    const slope = (sumW * sumWXY - sumWX * sumWY) / denom;
    const intercept = (sumWY - slope * sumWX) / sumW;
    return { slope, intercept };
}

// Berekent de voorspelling; niet afhankelijk van of de lijn zichtbaar staat,
// zodat de bot 'm ook kan gebruiken als extra confluence-input.
// Uitgebreid t.o.v. de eerste versie: het venster wordt nu geankerd op de
// laatst gepasseerde node (i.p.v. een vast aantal candles), en de
// hellingsprojectie wordt bijgesteld op basis van VFM-trend, volume-trend en
// chaos uit het bestaande geheugen (metricsHistory/calculateVolumeShift).
// Dit is een engineering-uitbreiding die meer van de al berekende
// databronnen van de bot gebruikt - GEEN validatie van de backtest-claims
// uit de bron-documenten, die blijven onbevestigd (zie Technical
// Documentation §15). De regressie zelf blijft een gewone lineaire fit;
// alleen de invoer en de bijstelling zijn rijker.
// Berekent de richting-bewuste kans voor zowel LONG als SHORT op dit moment,
// door dezelfde (net gefixte) calculateProbabilityScore twee keer aan te
// roepen met een verschillende 'side'. Hergebruikt voor de duale bullish/
// bearish voorspellingslijn hieronder.
function getDirectionalConfidences() {
    if (!lastOsirisDecision) return { bullish: 50, bearish: 50 };

    const nodeContext = getNodeContext();
    const nodeInfluence = calculateNodeInfluence(nodeContext);
    const momentumContext = getMomentumContext();
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(livePrice);

    const momentumInfluenceLong = calculateMomentumInfluence('LONG', momentumContext);
    const momentumInfluenceShort = calculateMomentumInfluence('SHORT', momentumContext);
    const patternInfluenceLong = calculatePatternInfluence('LONG');
    const patternInfluenceShort = calculatePatternInfluence('SHORT');

    const bullish = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluenceLong, fibConfluenceInfluence, 'LONG', isBullish, patternInfluenceLong);
    const bearish = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluenceShort, fibConfluenceInfluence, 'SHORT', isBullish, patternInfluenceShort);

    return { bullish, bearish };
}

// Geeft nu TWEE projecties terug (bullish én bearish), i.p.v. één lijn die
// koos voor "de" richting. De richting van elke lijn staat vast (omhoog voor
// bullish, omlaag voor bearish); de STEILHEID van elke lijn wordt geschaald
// door de eigen (richting-bewuste) kans-score van die kant - een lijn met
// weinig onderbouwing wordt dus zichtbaar vlakker/korter, niet onderdrukt.
function computeLinearPrediction(horizonMinutes) {
    if (!rawData || rawData.length < 20) return null;

    // 1. Venster ankeren op de laatst gepasseerde node i.p.v. een vast getal -
    // "kijk terug tot het laatste betekenisvolle knooppunt", begrensd tussen
    // 10 en 60 candles zodat het venster nooit absurd klein/groot wordt.
    const nodeCtx = getNodeContext();
    const candlesSinceNode = Math.round(nodeCtx.lastNode.minutesAgo / 15);
    const lookback = Math.min(60, Math.max(10, candlesSinceNode || 30));

    const recent = rawData.slice(-lookback);
    const points = recent.map((d, i) => ({ x: i, y: parseFloat(d[4]) }));
    // Exponentieel-gewogen i.p.v. gewone OLS - recente candles wegen zwaarder.
    const { slope } = exponentialWeightedRegressionFit(points);

    // 2. Bijstelling op basis van VFM-trend, volume-trend en chaos - allemaal
    // al berekend elders in de bot (metricsHistory-gebaseerd geheugen). Dit
    // schaalt de MAGNITUDE (hoe steil), niet de richting.
    const momentum = getMomentumContext();
    const volShift = calculateVolumeShift(6);
    let adjustmentFactor = 1.0;
    if (momentum.vfmTrend === 'rising') adjustmentFactor += 0.15;
    else if (momentum.vfmTrend === 'falling') adjustmentFactor -= 0.15;
    if (volShift > 15) adjustmentFactor += 0.1;
    else if (volShift < -15) adjustmentFactor -= 0.1;
    if (momentum.rangeCompressed) adjustmentFactor -= 0.2;
    if (chaos > 15) adjustmentFactor -= 0.15;
    else if (chaos < 5) adjustmentFactor += 0.05;
    adjustmentFactor = Math.max(0.3, Math.min(1.6, adjustmentFactor));

    const baseMagnitude = Math.abs(slope) * adjustmentFactor;

    // 3. Richting-bewuste kans per kant - dezelfde motor die nu ook de
    // entry/hold/exit-beslissingen aanstuurt (zie de fix hierboven).
    const confidences = getDirectionalConfidences();
    const bullishSlope = baseMagnitude * (confidences.bullish / 100);
    const bearishSlope = -baseMagnitude * (confidences.bearish / 100);

    const lastTimeSec = Math.floor(recent[recent.length - 1][0] / 1000);
    const candleIntervalSec = 15 * 60; // 15m candles
    const stepsForward = Math.max(1, Math.round((horizonMinutes * 60) / candleIntervalSec));
    const futureTimeSec = lastTimeSec + stepsForward * candleIntervalSec;
    const anchorPrice = livePrice || (slope * (points.length - 1));

    const bullishEndPrice = anchorPrice + (bullishSlope * stepsForward);
    const bearishEndPrice = anchorPrice + (bearishSlope * stepsForward);

    const strongerSide = confidences.bullish >= confidences.bearish ? 'bullish' : 'bearish';

    return {
        startTime: lastTimeSec,
        startPrice: anchorPrice,
        endTime: futureTimeSec,
        bullishEndPrice, bearishEndPrice,
        bullishConfidence: confidences.bullish,
        bearishConfidence: confidences.bearish,
        // Backwards-compatible velden (gebruikt door confluence hierboven):
        // pakken de kant met de hoogste kans.
        endPrice: strongerSide === 'bullish' ? bullishEndPrice : bearishEndPrice,
        slope: strongerSide === 'bullish' ? bullishSlope : bearishSlope,
        rawSlope: slope,
        adjustmentFactor,
        lookbackCandles: lookback,
        anchoredToNode: nodeCtx.lastNode.type,
        direction: strongerSide
    };
}

function renderPrediction() {
    if (!showPrediction) {
        if (predictionBullishSeries) { chart.removeSeries(predictionBullishSeries); predictionBullishSeries = null; }
        if (predictionBearishSeries) { chart.removeSeries(predictionBearishSeries); predictionBearishSeries = null; }
        // Terug naar een normale, kleine marge zodra de voorspelling uit staat
        chart.timeScale().applyOptions({ rightOffset: 6 });
        return;
    }
    const pred = computeLinearPrediction(predictionHorizonMinutes);
    if (!pred) return;

    const bullishData = [{ time: pred.startTime, value: pred.startPrice }, { time: pred.endTime, value: pred.bullishEndPrice }];
    const bearishData = [{ time: pred.startTime, value: pred.startPrice }, { time: pred.endTime, value: pred.bearishEndPrice }];

    // De kant met de hoogste kans krijgt een dikkere lijn - zo zie je in één
    // oogopslag welk scenario de bot zelf sterker onderbouwd vindt, zonder
    // dat de zwakkere kant helemaal verdwijnt.
    const bullishWidth = pred.bullishConfidence >= pred.bearishConfidence ? 3 : 1;
    const bearishWidth = pred.bearishConfidence > pred.bullishConfidence ? 3 : 1;

    if (!predictionBullishSeries) {
        predictionBullishSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#26a69a', lineWidth: bullishWidth, lineStyle: LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, title: `Bullish (${pred.bullishConfidence.toFixed(0)}%)`
        });
    } else {
        predictionBullishSeries.applyOptions({ lineWidth: bullishWidth, title: `Bullish (${pred.bullishConfidence.toFixed(0)}%)` });
    }
    predictionBullishSeries.setData(bullishData);

    if (!predictionBearishSeries) {
        predictionBearishSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#ef5350', lineWidth: bearishWidth, lineStyle: LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, title: `Bearish (${pred.bearishConfidence.toFixed(0)}%)`
        });
    } else {
        predictionBearishSeries.applyOptions({ lineWidth: bearishWidth, title: `Bearish (${pred.bearishConfidence.toFixed(0)}%)` });
    }
    predictionBearishSeries.setData(bearishData);

    // FIX: de tijdas heeft standaard geen ruimte rechts van de laatste candle
    // (rightOffset: 0), dus het toekomstige stuk van de lijn viel buiten het
    // zichtbare venster - de data klopte, maar was niet te zien zonder handmatig
    // te scrollen. Bereken hoeveel candle-breedtes de gekozen horizon nodig
    // heeft en zet daar de marge op (met een beetje extra lucht).
    const candleIntervalSec = 15 * 60;
    const stepsForward = Math.max(1, Math.round((predictionHorizonMinutes * 60) / candleIntervalSec));
    chart.timeScale().applyOptions({ rightOffset: stepsForward + 3 });
}

function handlePredictionSelect(value) {
    showPrediction = (value === 'VISIBLE');
    renderPrediction();
    const panel = document.getElementById('prediction-inline-settings');
    if (panel) panel.style.display = showPrediction ? 'grid' : 'none';
}

function handlePredictionHorizonSelect(value) {
    predictionHorizonMinutes = PREDICTION_HORIZONS_MIN[value] || 60;
    renderPrediction();
}

// VALUTA-WEERGAVE (USD/EUR) - puur cosmetisch voor de chart, raakt de
// trading-logica/wallet NIET (die blijft intern altijd correct rekenen,
// zie de EUR->USD-conversie in openPositionFromOrder voor de échte fix).
// ============================================================
let eurUsdtRate = null; // Binance's eigen EURUSDT-koers: hoeveel USDT is 1 EUR waard
let displayCurrency = 'USD'; // 'USD' of 'EUR' - alleen voor chart-labels

async function fetchEurUsdtRate() {
    try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT');
        const data = await res.json();
        const rate = parseFloat(data.price);
        if (rate && isFinite(rate) && rate > 0) eurUsdtRate = rate;
    } catch (e) {
        console.warn("Kon EUR/USDT-koers niet ophalen (valutaswitch valt terug op USD):", e);
    }
}

// Converteert een USD-bedrag (zoals livePrice, altijd de brontaal van de chart)
// naar het gekozen weergave-bedrag. Let op: dit is een BENADERING - historische
// candles worden allemaal met de HUIDIGE koers omgerekend, niet met de koers
// die op dat historische moment gold.
function convertToDisplayCurrency(usdAmount) {
    if (displayCurrency === 'EUR' && eurUsdtRate) return usdAmount / eurUsdtRate;
    return usdAmount;
}

function currencySymbol() {
    return (displayCurrency === 'EUR' && eurUsdtRate) ? '€' : '$';
}

// De chart-prijzen komen van BTCUSDT (dus USD als brontaal); de wallet is
// intern altijd EUR (dat is de echte valuta van je kapitaal - dit verandert
// NOOIT, alleen de weergave). Vandaar twee aparte formatters met een
// verschillend startpunt, die allebei uitkomen op dezelfde displayCurrency.
function formatChartPrice(usdPrice) {
    return `${currencySymbol()}${convertToDisplayCurrency(usdPrice).toFixed(0)}`;
}

// FIX: dit deed voorheen een ECHTE FX-omrekening (x eurUsdtRate) op de wallet,
// waardoor "Reset Wallet" met 1000 in het invoerveld plotseling ~1080-1170 kon
// tonen in USD-weergave - verwarrend, want de wallet is gewoon een vast bedrag
// dat je zelf invult, geen live-geconverteerd bezit. De wallet heeft nu zijn
// EIGEN valuta (walletState.currency, gekozen bij Reset Wallet) en toont dat
// bedrag exact zoals ingevoerd, zonder marktkoers-vermenigvuldiging. Dit is
// volledig los van displayCurrency, dat alleen de chart-prijzen (USD-bron)
// cosmetisch omrekent.
// USDT is toegevoegd als derde walletvaluta voor TESTNET-modus. Technisch is
// het zelfs de zuiverste keuze: BTCUSDT is in USDT genoteerd, dus een
// USDT-wallet heeft NUL conversie nodig (geen eurUsdtRate, geen aannames).
// 'USD-achtig' = genoteerd in de quote-valuta van het handelspaar; alleen EUR
// heeft een koersconversie nodig.
function isQuoteCurrencyWallet() {
    return walletState.currency === 'USD' || walletState.currency === 'USDT';
}

function walletSymbol() {
    if (walletState.currency === 'USDT') return '₮'; // ₮ - gangbaar informeel USDT-teken
    return walletState.currency === 'USD' ? '$' : '€';
}

function formatMoney(amount, decimals = 2) {
    return `${walletSymbol()}${amount.toFixed(decimals)}`;
}

// Past de as-labels, crosshair-labels EN alle price-line-labels (fib-lijnen,
// node-lijnen, positie-lijnen) in één keer aan via Lightweight Charts' eigen
// custom priceFormat - geen enkele lijn hoeft hiervoor opnieuw getekend te
// worden, alleen hoe de tekst wordt weergegeven verandert.
function applyChartPriceFormat() {
    if (typeof candlestickSeries === 'undefined') return;
    candlestickSeries.applyOptions({
        priceFormat: { type: 'custom', formatter: formatChartPrice, minMove: 0.01 }
    });
}

// Dropdown-handler voor de valuta-selector
function handleCurrencySelect(value) {
    displayCurrency = value;
    applyChartPriceFormat();
    updateWalletUI();
    updatePendingOrdersUI();
}

// --- FIBONACCI MARKERS FUNCTIE ---

// --- MOUSE HOVER (OHLC DATA) SUBSCRIBER ---
chart.subscribeCrosshairMove(param => {
    const ohlcOpen = document.getElementById('ohlc-open');
    const ohlcHigh = document.getElementById('ohlc-high');
    const ohlcLow = document.getElementById('ohlc-low');
    const ohlcClose = document.getElementById('ohlc-close');

    if (param.time && param.seriesData.has(candlestickSeries)) {
        const data = param.seriesData.get(candlestickSeries);
        ohlcOpen.innerText = formatChartPrice(data.open);
        ohlcHigh.innerText = formatChartPrice(data.high);
        ohlcLow.innerText = formatChartPrice(data.low);
        ohlcClose.innerText = formatChartPrice(data.close);
        
        const color = data.close >= data.open ? '#26a69a' : '#ef5350';
        ohlcClose.style.color = color;
    } else {
        ohlcOpen.innerText = '-';
        ohlcHigh.innerText = '-';
        ohlcLow.innerText = '-';
        ohlcClose.innerText = '-';
        ohlcClose.style.color = '#d1d4dc';
    }
});

function logSystemState(metrics, targets, currentPrice, liveVolume, chaosVal, dbVal, bullish) {
    // Snapshot van de node/sessie/momentum-context op het moment van loggen,
    // zodat je achteraf (Download All Data) exact kunt zien wat er meewoog.
    const nodeCtx = getNodeContext();
    const nodeInf = calculateNodeInfluence(nodeCtx);
    const momentumCtx = getMomentumContext();

    const logEntry = {
        timestamp: new Date().toISOString(),
        price: currentPrice,
        liveVolume: liveVolume || 0,
        // Kern-indicatoren
        vfm: metrics.vfm || 0,
        er: metrics.er || 0,
        db: dbVal || 0,
        chaos: chaosVal || 0,
        // Context-data
        volRate: metrics.rate || 0,
        volScore: metrics.score || 0,
        // Fractal Targets
        microBull: targets.micro.bullish,
        microBear: targets.micro.bearish,
        mesoBull: targets.meso.bullish,
        mesoBear: targets.meso.bearish,
        macroBull: targets.macro.bullish,
        macroBear: targets.macro.bearish,
        // Besluitvorming
        isBullish: bullish,
        // Node/sessie/geheugen-context (nieuw)
        nextNodeType: nodeCtx.nextNode.type,
        nextNodeMinutes: nodeCtx.nextNode.minutesUntil.toFixed(1),
        lastNodeType: nodeCtx.lastNode.type,
        lastNodeMinutesAgo: nodeCtx.lastNode.minutesAgo.toFixed(1),
        nodeInfluence: nodeInf.toFixed(2),
        volumeShiftPct: calculateVolumeShift(6).toFixed(2),
        consecutiveBullish: momentumCtx.consecutiveBullish,
        consecutiveBearish: momentumCtx.consecutiveBearish,
        rangeCompressed: momentumCtx.rangeCompressed,
        vfmTrend: momentumCtx.vfmTrend
    };
    
    osirisSystemLog.push(logEntry);
}

function exportOsirisData() {
    const headers = Object.keys(osirisSystemLog[0]).join(",");
    const rows = osirisSystemLog.map(obj => Object.values(obj).join(","));
    const csvContent = "data:text/csv;charset=utf-8," + headers + "\n" + rows.join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "osiris_kalibratie_log.csv");
    document.body.appendChild(link);
    link.click();
}

// --- PERSISTENTIE ---
let botStartTime = localStorage.getItem('botStartTime') ? parseInt(localStorage.getItem('botStartTime')) : null;
let isBotRunning = localStorage.getItem('botIsRunning') === 'true';

function savePersistentState() {
    try {
        localStorage.setItem('osirisWalletState', JSON.stringify(walletState));
        localStorage.setItem('osirisOpenPositions', JSON.stringify(openPositions));
        localStorage.setItem('osirisPendingOrders', JSON.stringify(pendingOrders));
        // FIX: botTradeLog werd nooit opgeslagen, waardoor de "Laatste 10 Posities"
        // tabel bij elke refresh/auto-herstart leeg leek (de DOM begint leeg, en
        // werd pas weer gevuld zodra een NIEUWE exit plaatsvond). Cap op de laatste
        // 500 entries zodat localStorage niet ongelimiteerd blijft groeien.
        // FIX: bij 500 als cap konden EXIT-records (waar de sessie-historie op
        // filtert) verdrongen worden door PENDING/CANCELLED-ruis - met snelle
        // instellingen (korte chase/bevestiging/TTL) genereert de bot veel van
        // die tussenmeldingen. Cap fors verhoogd, en bij het trimmen worden
        // EXIT-entries als eerste behouden, niet-EXIT-ruis wordt het eerst weggegooid.
        const CAP = 3000;
        let cappedLog = botTradeLog;
        if (botTradeLog.length > CAP) {
            const exits = botTradeLog.filter(e => e.action === 'EXIT');
            const nonExits = botTradeLog.filter(e => e.action !== 'EXIT');
            const roomForNonExits = Math.max(0, CAP - exits.length);
            cappedLog = [...exits, ...nonExits.slice(-roomForNonExits)]
                .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        }
        localStorage.setItem('osirisTradeLog', JSON.stringify(cappedLog));
        // FIX: botSettings (en de MA/RSI-instellingen) werden nooit opgeslagen -
        // bij elke refresh reset dit stilzwijgend naar de harde defaults in de
        // code, waardoor het "Actieve Sessie-Instellingen"-paneel na een
        // refresh niet meer klopte met wat er daadwerkelijk was ingesteld.
        localStorage.setItem('osirisBotSettings', JSON.stringify(botSettings));
        localStorage.setItem('osirisIndicatorSettings', JSON.stringify({
            maFastPeriod, maSlowPeriod, rsiPeriod, rsiOverbought, rsiOversold
        }));
        // NIVEAU 1: leer-log en adaptieve gewichten - de kern van "leren van fouten"
        localStorage.setItem('osirisLearningLog', JSON.stringify(learningLog));
        localStorage.setItem('osirisAdaptiveWeights', JSON.stringify(adaptiveWeights));
    } catch (e) { console.warn("Kon wallet/positie-status niet opslaan:", e); }
}

function loadPersistentState() {
    try {
        const w = localStorage.getItem('osirisWalletState');
        const p = localStorage.getItem('osirisOpenPositions');
        const q = localStorage.getItem('osirisPendingOrders');
        const t = localStorage.getItem('osirisTradeLog');
        const bs = localStorage.getItem('osirisBotSettings');
        const ind = localStorage.getItem('osirisIndicatorSettings');
        const sl = localStorage.getItem('osirisSessionLog');
        const ll = localStorage.getItem('osirisLearningLog');
        const aw = localStorage.getItem('osirisAdaptiveWeights');
        if (w) walletState = JSON.parse(w);
        if (p) {
            openPositions = JSON.parse(p);
            // FIX (testnet + refresh): pendingExchangeClose is een tijdelijke
            // in-flight-vlag ("exit-order is onderweg naar de exchange"). Wordt
            // de pagina ververst terwijl zo'n vlag toevallig mee-gepersisteerd
            // was (elke savePersistentState serialiseert de hele positie), dan
            // zou closePositionOnTestnet de herstelde positie voor eeuwig
            // overslaan en kon ze NOOIT meer sluiten. Na een refresh is er per
            // definitie geen order meer in-flight, dus de vlag hoort weg.
            openPositions.forEach(pos => { delete pos.pendingExchangeClose; });
        }
        if (q) pendingOrders = JSON.parse(q);
        if (t) botTradeLog = JSON.parse(t);
        if (bs) {
            const restored = JSON.parse(bs);
            restored.isRunning = false; // altijd vers starten - startAutonomousBot(true) zet dit zelf weer terug op true indien nodig
            // FIX: `botSettings = restored` verving het HELE object - instellingen
            // die in een nieuwere codeversie zijn toegevoegd (feePct, reallocatie-
            // guards, ...) verdwenen dan stilzwijgend zodra een oud opgeslagen
            // object werd teruggeladen, en waren daarna `undefined`. Mergen over
            // de defaults heen behoudt nieuwe keys mét hun default.
            botSettings = { ...botSettings, ...restored };
        }
        if (ind) {
            const restoredInd = JSON.parse(ind);
            if (restoredInd.maFastPeriod) maFastPeriod = restoredInd.maFastPeriod;
            if (restoredInd.maSlowPeriod) maSlowPeriod = restoredInd.maSlowPeriod;
            if (restoredInd.rsiPeriod) rsiPeriod = restoredInd.rsiPeriod;
            if (restoredInd.rsiOverbought) rsiOverbought = restoredInd.rsiOverbought;
            if (restoredInd.rsiOversold) rsiOversold = restoredInd.rsiOversold;
        }
        if (sl) sessionLog = JSON.parse(sl);
        if (ll) learningLog = JSON.parse(ll);
        if (aw) adaptiveWeights = JSON.parse(aw);
        computeCalibrationMap(); // pas NA het herstellen van alle state - zodat een
                                 // fout hier nooit meer een herstel-regel kan blokkeren
    } catch (e) { console.warn("Kon wallet/positie-status niet laden:", e); }
}

loadPersistentState();

// FIX: na het herladen moeten de invoervelden zelf ook de herstelde waarden
// tonen - anders klopt het scherm niet met wat er intern actief is, ook al is
// de data zelf correct. Dit is puur weergave; leest nergens data uit.
function populateSettingsInputsFromState() {
    const setVal = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null) el.value = value; };

    setVal('start-capital', walletState.startingCapital);
    setVal('wallet-currency-select', walletState.currency);

    const s = botSettings;
    setVal('max-allocation-pct', (s.maxAllocationPct * 100).toFixed(0));
    setVal('stop-loss-pct', (s.stopLossPct * 100).toFixed(2).replace(/\.00$/, ''));
    setVal('min-probability-pct', s.minProbabilityPct);
    setVal('hold-continuation-probability-pct', s.holdContinuationMinProbabilityPct);
    setVal('min-projected-profit-pct', s.minProjectedProfitPct);
    setVal('max-open-positions', s.maxOpenPositions);
    setVal('hedge-reserve-pct', (s.minHedgeReservePct * 100).toFixed(0));
    setVal('pending-order-ttl', s.pendingOrderTtlMinutes);
    setVal('min-loss-early-exit', (s.minLossForEarlyExit * 100).toFixed(2).replace(/\.00$/, ''));
    setVal('profit-protect-activation', (s.profitProtectActivationPct * 100).toFixed(2).replace(/\.00$/, ''));
    setVal('profit-protect-keep', s.profitProtectKeepPct);
    setVal('prob-collapse-threshold', s.probCollapseThresholdPct);
    setVal('prob-collapse-confirm-sec', s.probCollapseConfirmSeconds);
    setVal('regime-gate-enabled', String(s.regimeGateEnabled ?? true));
    setVal('max-position-age', s.maxPositionAgeMinutes);
    setVal('small-profit-harvest', s.smallProfitHarvestMinutes);
    setVal('prob-smoothing-samples', s.probSmoothingSamples);
    setVal('prob-collapse-enabled', String(s.probCollapseEnabled));
    setVal('node-weight-mode', s.nodeWeightMode);
    setVal('node-weight-manual', s.nodeWeightManual);
    setVal('continuation-confirmation-sec', s.continuationConfirmationSeconds);
    setVal('range-scalp-target-pct', s.rangeScalpProfitTargetPct);
    setVal('range-scalp-stop-pct', s.rangeScalpStopLossPct);
    setVal('range-scalp-alloc-pct', (s.rangeScalpAllocationPct * 100).toFixed(0));
    setVal('chase-probability-pct', s.chaseProbabilityThreshold);
    setVal('chase-after-minutes', s.chaseAfterMinutes);
    setVal('reallocation-enabled', s.reallocationEnabled ? 'true' : 'false');
    setVal('reallocation-margin-pct', s.reallocationMarginPct);
    setVal('reallocation-min-age', s.reallocationMinAgeMinutes);
    setVal('reallocation-cooldown', s.reallocationCooldownMinutes);
    setVal('fee-pct', s.feePct);
    setVal('slippage-pct', s.slippagePct);
    setVal('execution-mode', s.executionMode || 'SIM');

    setVal('ma-fast-period', maFastPeriod);
    setVal('ma-slow-period', maSlowPeriod);
    setVal('rsi-period', rsiPeriod);
    setVal('rsi-overbought', rsiOverbought);
    setVal('rsi-oversold', rsiOversold);
}

// FIX: na het laden de "Laatste 10 Posities" tabel opnieuw opbouwen uit de
// hersteldeel trade log, zodat gesloten posities niet meer "verdwijnen" bij
// een refresh - ze staan nu gewoon weer in de tabel, precies zoals vóór het
// herladen.
function rebuildHistoryUIFromLog() {
    const body = document.getElementById('history-body');
    if (!body) return;
    body.innerHTML = '';
    // FIX: toonde voorheen altijd de laatste 10 EXIT-regels, ongeacht sessie.
    // Nu: alle gesloten posities van de HUIDIGE bot-sessie (vanaf botStartTime).
    // Oudere entries zonder timestampMs (van vóór deze fix) worden niet als
    // "huidige sessie" meegeteld, aangezien dat niet betrouwbaar te bepalen is.
    const sessionStart = botStartTime || 0;
    const exits = botTradeLog.filter(e => e.action === 'EXIT' && e.timestampMs && e.timestampMs >= sessionStart);
    exits.forEach(entry => updateHistoryUI(entry));
}

// Auto-start bij laden
// FIX: dit hing eerder af van window 'load', dat wacht op ALLE resources
// (incl. externe scripts zoals Google Tag Manager). Als zo'n script geblokkeerd
// wordt (bijv. door Edge Tracking Prevention of een ad-blocker) en blijft
// hangen i.p.v. direct te falen, vuurt 'load' nooit - waardoor
// rebuildHistoryUIFromLog() nooit liep en de historie-tabel leeg leek, zelfs
// met correct opgeslagen data in localStorage. DOMContentLoaded wacht alleen op
// de HTML zelf, niet op externe scripts, en is de juiste keuze voor UI-init
// die geen externe resources nodig heeft.
function initializeOnReady() {
    populateSettingsInputsFromState();
    updateWalletUI();
    updatePendingOrdersUI();
    rebuildHistoryUIFromLog();
    renderActiveSettingsPanel();
    renderLearningPanel();
    if (isBotRunning) {
        startAutonomousBot(true); // true = herstart
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeOnReady);
} else {
    // DOM is al geparsed (interactive of complete) tegen de tijd dat dit script draait
    initializeOnReady();
}



// Leest alle trend/scalp/gedeelde instellingen uit de invoervelden in
// botSettings. Losgetrokken uit startAutonomousBot() zodat dezelfde logica
// ook gebruikt kan worden voor een live update terwijl de bot al draait (zie
// updateLiveSettings hieronder) - zonder de runtime/interval/wallet aan te raken.
// Inklap-gedrag voor het Engine Configuration-paneel: standaard open (voordat
// de bot draait wil je de instellingen meteen zien), klapt automatisch dicht
// zodra Start wordt ingedrukt (dan toont de samenvatting - het bestaande
// active-settings-panel - i.p.v. de volledige invoervelden), en kan altijd
// handmatig weer open/dicht via de header.
function toggleConfigPanel() {
    const body = document.getElementById('config-body');
    const chevron = document.getElementById('config-chevron');
    if (!body) return;
    const nowOpen = body.classList.toggle('open');
    if (chevron) chevron.classList.toggle('open', nowOpen);
}

function toggleReasoningPanel() {
    const body = document.getElementById('reasoning-body');
    const chevron = document.getElementById('reasoning-chevron');
    if (!body) return;
    const willBeOpen = !body.classList.contains('open');
    body.classList.toggle('open', willBeOpen);
    body.style.maxHeight = willBeOpen ? '320px' : '0px';
    body.style.overflowY = willBeOpen ? 'scroll' : 'hidden';
    if (chevron) chevron.classList.toggle('open', willBeOpen);
}
function collapseConfigPanel() {
    const body = document.getElementById('config-body');
    const chevron = document.getElementById('config-chevron');
    if (body) body.classList.remove('open');
    if (chevron) chevron.classList.remove('open');
}
function expandConfigPanel() {
    const body = document.getElementById('config-body');
    const chevron = document.getElementById('config-chevron');
    if (body) body.classList.add('open');
    if (chevron) chevron.classList.add('open');
}

function readTradingSettingsFromInputs() {
    const allocInput = document.getElementById('max-allocation-pct');
    const stopLossInput = document.getElementById('stop-loss-pct');
    const minProbInput = document.getElementById('min-probability-pct');
    const holdProbInput = document.getElementById('hold-continuation-probability-pct');
    const minProfitInput = document.getElementById('min-projected-profit-pct');
    const maxPositionsInput = document.getElementById('max-open-positions');
    const hedgeReserveInput = document.getElementById('hedge-reserve-pct');
    const pendingTtlInput = document.getElementById('pending-order-ttl');
    const minLossEarlyExitInput = document.getElementById('min-loss-early-exit');
    const confirmationSecInput = document.getElementById('continuation-confirmation-sec');
    const rangeScalpTargetInput = document.getElementById('range-scalp-target-pct');
    const rangeScalpStopInput = document.getElementById('range-scalp-stop-pct');
    const rangeScalpAllocInput = document.getElementById('range-scalp-alloc-pct');
    const chaseProbInput = document.getElementById('chase-probability-pct');
    const chaseAfterInput = document.getElementById('chase-after-minutes');
    const reallocationEnabledInput = document.getElementById('reallocation-enabled');
    const reallocationMarginInput = document.getElementById('reallocation-margin-pct');

    if (allocInput && !isNaN(parseFloat(allocInput.value))) {
        botSettings.maxAllocationPct = Math.min(Math.max(parseFloat(allocInput.value) / 100, 0), 1);
    }
    const ppActInput = document.getElementById('profit-protect-activation');
    if (ppActInput && !isNaN(parseFloat(ppActInput.value))) {
        botSettings.profitProtectActivationPct = Math.max(parseFloat(ppActInput.value) / 100, 0);
    }
    const ppKeepInput = document.getElementById('profit-protect-keep');
    if (ppKeepInput && !isNaN(parseFloat(ppKeepInput.value))) {
        botSettings.profitProtectKeepPct = Math.min(Math.max(parseFloat(ppKeepInput.value), 0), 100);
    }
    const pcThreshInput = document.getElementById('prob-collapse-threshold');
    if (pcThreshInput && !isNaN(parseFloat(pcThreshInput.value))) {
        botSettings.probCollapseThresholdPct = Math.min(Math.max(parseFloat(pcThreshInput.value), 0), 100);
    }
    const pcConfirmInput = document.getElementById('prob-collapse-confirm-sec');
    if (pcConfirmInput && !isNaN(parseFloat(pcConfirmInput.value))) {
        botSettings.probCollapseConfirmSeconds = Math.max(parseFloat(pcConfirmInput.value), 0);
    }
    const regimeGateInput = document.getElementById('regime-gate-enabled');
    if (regimeGateInput) botSettings.regimeGateEnabled = regimeGateInput.value === 'true';
    const maxAgeInput = document.getElementById('max-position-age');
    if (maxAgeInput && !isNaN(parseFloat(maxAgeInput.value))) {
        botSettings.maxPositionAgeMinutes = Math.max(parseFloat(maxAgeInput.value), 0);
    }
    const smoothInput = document.getElementById('prob-smoothing-samples');
    if (smoothInput && !isNaN(parseInt(smoothInput.value))) {
        botSettings.probSmoothingSamples = Math.max(1, parseInt(smoothInput.value));
    }
    const pcEnabled = document.getElementById('prob-collapse-enabled');
    if (pcEnabled) botSettings.probCollapseEnabled = pcEnabled.value === 'true';
    const nodeModeSel = document.getElementById('node-weight-mode');
    if (nodeModeSel) botSettings.nodeWeightMode = nodeModeSel.value;
    const nodeWInput = document.getElementById('node-weight-manual');
    if (nodeWInput && !isNaN(parseFloat(nodeWInput.value))) {
        botSettings.nodeWeightManual = Math.max(0, parseFloat(nodeWInput.value));
    }
    const harvestInput = document.getElementById('small-profit-harvest');
    if (harvestInput && !isNaN(parseFloat(harvestInput.value))) {
        botSettings.smallProfitHarvestMinutes = Math.max(parseFloat(harvestInput.value), 0);
    }
    if (stopLossInput && !isNaN(parseFloat(stopLossInput.value))) {
        botSettings.stopLossPct = Math.max(parseFloat(stopLossInput.value) / 100, 0.001);
    }
    if (minProbInput && !isNaN(parseFloat(minProbInput.value))) {
        botSettings.minProbabilityPct = Math.min(Math.max(parseFloat(minProbInput.value), 0), 100);
    }
    if (holdProbInput && !isNaN(parseFloat(holdProbInput.value))) {
        botSettings.holdContinuationMinProbabilityPct = Math.min(Math.max(parseFloat(holdProbInput.value), 0), 100);
    }
    if (minProfitInput && !isNaN(parseFloat(minProfitInput.value))) {
        botSettings.minProjectedProfitPct = Math.max(parseFloat(minProfitInput.value), 0);
    }
    if (maxPositionsInput && !isNaN(parseInt(maxPositionsInput.value))) {
        botSettings.maxOpenPositions = Math.min(Math.max(parseInt(maxPositionsInput.value), 1), 4);
    }
    if (hedgeReserveInput && !isNaN(parseFloat(hedgeReserveInput.value))) {
        botSettings.minHedgeReservePct = Math.min(Math.max(parseFloat(hedgeReserveInput.value) / 100, 0), 0.5);
    }
    if (pendingTtlInput && !isNaN(parseFloat(pendingTtlInput.value))) {
        botSettings.pendingOrderTtlMinutes = Math.max(parseFloat(pendingTtlInput.value), 1);
    }
    if (minLossEarlyExitInput && !isNaN(parseFloat(minLossEarlyExitInput.value))) {
        botSettings.minLossForEarlyExit = Math.max(parseFloat(minLossEarlyExitInput.value) / 100, 0);
    }
    if (confirmationSecInput && !isNaN(parseFloat(confirmationSecInput.value))) {
        botSettings.continuationConfirmationSeconds = Math.max(parseFloat(confirmationSecInput.value), 0);
    }
    if (rangeScalpTargetInput && !isNaN(parseFloat(rangeScalpTargetInput.value))) {
        botSettings.rangeScalpProfitTargetPct = Math.max(parseFloat(rangeScalpTargetInput.value), 0.05);
    }
    if (rangeScalpStopInput && !isNaN(parseFloat(rangeScalpStopInput.value))) {
        botSettings.rangeScalpStopLossPct = Math.max(parseFloat(rangeScalpStopInput.value), 0.05);
    }
    if (rangeScalpAllocInput && !isNaN(parseFloat(rangeScalpAllocInput.value))) {
        botSettings.rangeScalpAllocationPct = Math.min(Math.max(parseFloat(rangeScalpAllocInput.value) / 100, 0), 1);
    }
    if (chaseProbInput && !isNaN(parseFloat(chaseProbInput.value))) {
        botSettings.chaseProbabilityThreshold = Math.min(Math.max(parseFloat(chaseProbInput.value), 0), 100);
    }
    if (chaseAfterInput && !isNaN(parseFloat(chaseAfterInput.value))) {
        botSettings.chaseAfterMinutes = Math.max(parseFloat(chaseAfterInput.value), 0);
    }
    if (reallocationEnabledInput) {
        botSettings.reallocationEnabled = reallocationEnabledInput.value === 'true';
    }
    if (reallocationMarginInput && !isNaN(parseFloat(reallocationMarginInput.value))) {
        botSettings.reallocationMarginPct = Math.max(parseFloat(reallocationMarginInput.value), 0);
    }
    const reallocMinAgeInput = document.getElementById('reallocation-min-age');
    if (reallocMinAgeInput && !isNaN(parseFloat(reallocMinAgeInput.value))) {
        botSettings.reallocationMinAgeMinutes = Math.max(parseFloat(reallocMinAgeInput.value), 0);
    }
    const reallocCooldownInput = document.getElementById('reallocation-cooldown');
    if (reallocCooldownInput && !isNaN(parseFloat(reallocCooldownInput.value))) {
        botSettings.reallocationCooldownMinutes = Math.max(parseFloat(reallocCooldownInput.value), 0);
    }
    const feePctInput = document.getElementById('fee-pct');
    if (feePctInput && !isNaN(parseFloat(feePctInput.value))) {
        botSettings.feePct = Math.min(Math.max(parseFloat(feePctInput.value), 0), 1); // 0-1% per zijde is realistisch; alles daarbuiten is vrijwel zeker een typefout
    }
    const slippagePctInput = document.getElementById('slippage-pct');
    if (slippagePctInput && !isNaN(parseFloat(slippagePctInput.value))) {
        botSettings.slippagePct = Math.min(Math.max(parseFloat(slippagePctInput.value), 0), 1);
    }
    const executionModeInput = document.getElementById('execution-mode');
    if (executionModeInput && ['SIM', 'TESTNET'].includes(executionModeInput.value)) {
        botSettings.executionMode = executionModeInput.value;
    }
}

// ============================================================
// SESSIE-LOG: houdt bij WANNEER welke instellingen actief werden - zowel bij
// Start als bij een live update terwijl de bot draait. Dit maakt de trade log
// achteraf te segmenteren per configuratie, ook als je nooit expliciet Reset
// Wallet gebruikt tussen twee verschillende instellingen-sets in.
// ============================================================
// sessionLog zelf is bovenin gedeclareerd (bij de persistente state, ~regel 148)
// omdat loadPersistentState() hem al nodig heeft - zie de FIX-comment daar.

function recordSessionEvent(eventType) {
    sessionLog.push({
        timestamp: new Date().toISOString(),
        event: eventType, // 'START' | 'STOP' | 'SETTINGS_UPDATED'
        settings: JSON.parse(JSON.stringify(botSettings)),
        indicatorSettings: { maFastPeriod, maSlowPeriod, rsiPeriod, rsiOverbought, rsiOversold }
    });
    if (sessionLog.length > 200) sessionLog = sessionLog.slice(-200);
    try { localStorage.setItem('osirisSessionLog', JSON.stringify(sessionLog)); } catch (e) { /* niet kritiek */ }
}

// Werkt de instellingen van de AL DRAAIENDE bot live bij, zonder de runtime,
// het interval, of open posities aan te raken. Let op: dit verandert
// meteen de stop-loss/target-drempels waaronder AL OPEN posities worden
// beoordeeld (die lezen botSettings namelijk live, niet een bevroren kopie
// van instapmoment) - gebruik dit bewust, en gebruik voor een echt schone
// nieuwe testsessie liever Stop -> Reset Wallet -> Start.
function updateLiveSettings() {
    if (!botSettings.isRunning) {
        alert("De bot draait niet - gebruik gewoon Start Bot om de huidige instellingen te activeren.");
        return;
    }
    if (!confirm("Weet je zeker dat je de LIVE instellingen wilt bijwerken? Dit verandert meteen de regels waaronder AL OPEN posities worden beoordeeld (stop-loss, doelen, etc.), en je trade log bevat straks trades onder twee verschillende configuraties. Voor schone data-evaluatie is Stop -> Reset Wallet -> Start meestal beter.")) return;

    readTradingSettingsFromInputs();
    recordSessionEvent('SETTINGS_UPDATED');
    savePersistentState();
    renderActiveSettingsPanel();
    logBotAction("SETTINGS_UPDATED", livePrice || 0, null, 0, 0, "instellingen live bijgewerkt");
    console.log("Live instellingen bijgewerkt om", formatFullDateTime());
}

function startAutonomousBot(isAutoRestart = false) {
    isBotRunning = true;
    localStorage.setItem('botIsRunning', 'true');

    // Badge in de (ingeklapte) ENGINE CONFIGURATION-header: toont in één
    // oogopslag de executiemodus én hoe de sessie gestart is (manual vs.
    // auto-restart na een refresh) - ook als het paneel dicht is.
    const modeBadge = document.getElementById('engine-mode-badge');
    if (modeBadge) {
        modeBadge.textContent = `${botSettings.executionMode === 'TESTNET' ? 'BINANCE TESTNET' : 'SIM'} \u00b7 ${isAutoRestart ? 'auto-restart' : 'manual'}`;
        modeBadge.style.display = 'inline-block';
    }

    // FIX: dit was nooit true gezet, waardoor botHeartbeat() de trading
    // engine altijd oversloeg (bot deed nooit iets, ook al stond hij "ACTIEF").
    botSettings.isRunning = true;

    // Start Kapitaal/valuta wordt alleen toegepast als de wallet nog nooit
    // gebruikt is (anders zou elke herstart de opgebouwde equity overschrijven).
    if (!isAutoRestart && walletState.realizedPnL === 0 && openPositions.length === 0) {
        const capitalInput = document.getElementById('start-capital');
        if (capitalInput && !isNaN(parseFloat(capitalInput.value)) && parseFloat(capitalInput.value) > 0) {
            walletState.startingCapital = parseFloat(capitalInput.value);
        }
        const currencyInput = document.getElementById('wallet-currency-select');
        walletState.currency = ['USD', 'USDT'].includes(currencyInput?.value) ? currencyInput.value : 'EUR';
    }

    readTradingSettingsFromInputs();

    if (!isAutoRestart) {
        botStartTime = Date.now();
        localStorage.setItem('botStartTime', botStartTime);
    }
    // Start je interval hier
    botInterval = setInterval(botHeartbeat, 1000); 
    document.getElementById('bot-status').innerText = "ACTIEF";

    const startBtn = document.getElementById('btn-start-bot');
    const stopBtn = document.getElementById('btn-stop-bot');
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    recordSessionEvent(isAutoRestart ? 'AUTO_RESTART' : 'START');
    collapseConfigPanel();
    savePersistentState();
    updateWalletUI();
    renderActiveSettingsPanel();
}

// Toont de daadwerkelijk vergrendelde instellingen van de huidige sessie -
// instellingen worden alleen bij Start ingelezen (zie hierboven), dus dit
// laat precies zien "op basis waarvan" de bot nu draait, ongeacht wat er
// intussen in de invoervelden veranderd is.
// NIVEAU 1 - toont de huidige gewichten, hoeveel data elke factor heeft, en
// (zodra er genoeg is) de laatst gemeten win rate per groep. Volledig
// transparant: dit IS letterlijk wat het systeem "geleerd" heeft, in platte
// tekst, geen black box.
function renderLearningPanel() {
    const el = document.getElementById('learning-panel');
    if (!el) return;

    const labels = {
        confluence: 'Confluence', nodeInfluence: 'Node-invloed',
        momentumInfluence: 'Momentum-invloed', fibConfluenceInfluence: 'Fib-confluentie',
        patternInfluence: 'Patroon/structuur'
    };
    const weightKeys = { confluence: 'confluence', nodeInfluence: 'nodeInfluence', momentumInfluence: 'momentumInfluence', fibConfluenceInfluence: 'fibConfluence', patternInfluence: 'pattern' };

    const totalTrades = learningLog.length;
    let html = `<div style="font-size:0.72em; color:var(--text-dim); margin-bottom:10px;">Gebaseerd op ${totalTrades} afgesloten trend-trade(s) sinds deze instellingen zijn gaan loggen (minimaal ${MIN_SAMPLE_SIZE} per groep nodig voordat een gewicht verandert).</div>`;
    html += `<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px;">`;

    Object.keys(labels).forEach(fk => {
        const wKey = weightKeys[fk];
        const weight = adaptiveWeights[wKey];
        const s = lastCalibrationSummary ? lastCalibrationSummary.summary[fk] : null;
        const botOnly = learningLog.filter(l => !l.manual);
        const nPresent = s ? s.nPresent : botOnly.filter(l => l.factors[fk] > 1).length;
        const nAbsent = s ? s.nAbsent : botOnly.filter(l => l.factors[fk] !== null && l.factors[fk] <= 1).length;
        const weightColor = weight > 1.02 ? 'var(--teal)' : (weight < 0.98 ? 'var(--red)' : 'var(--text-primary)');

        html += `<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); padding:10px 12px;">
            <div style="font-size:0.7em; color:var(--text-dim); margin-bottom:4px;">${labels[fk]}</div>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:700; color:${weightColor};">${weight.toFixed(2)}x</div>
            <div style="font-size:0.62em; color:var(--text-dimmer); margin-top:4px;">n=${nPresent} aanwezig / ${nAbsent} zwak`;
        if (s && s.adjusted) {
            html += `<br>win rate: ${(s.winRatePresent * 100).toFixed(0)}% vs ${(s.winRateAbsent * 100).toFixed(0)}%`;
        } else {
            html += ` (nog &lt; ${MIN_SAMPLE_SIZE} - geen aanpassing)`;
        }
        html += `</div></div>`;
    });
    html += `</div>`;

    // KALIBRATIETABEL (13-07): voorspelde winkans-buckets vs. gerealiseerde
    // winrate. Dit is de directe toets of de kansscore eerlijk is: in een
    // perfect gekalibreerd systeem wint de 70-80%-bucket ~75% van de tijd.
    // Wint hij 40%, dan is de score overmoedig en weet je precies hoeveel.
    const withProb = learningLog.filter(l => !l.manual && (l.entryProbabilityPct != null || (l.factors && l.factors.probabilityPct != null)));
    if (withProb.length >= 10) {
        const buckets = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
        html += `<div style="font-size:0.7em; color:var(--text-dim); margin:14px 0 6px;">Kalibratie: voorspelde winkans vs. werkelijkheid (n=${withProb.length})</div>`;
        html += `<table style="width:100%; font-family:'JetBrains Mono',monospace; font-size:0.62em; border-collapse:collapse;">`;
        html += `<tr style="color:var(--text-dimmer); text-align:left;"><th style="padding:2px 6px;">voorspeld</th><th style="padding:2px 6px;">trades</th><th style="padding:2px 6px;">werkelijke winrate</th><th style="padding:2px 6px;">afwijking</th></tr>`;
        buckets.forEach(([lo, hi]) => {
            const inB = withProb.filter(l => {
                const p = l.entryProbabilityPct ?? l.factors.probabilityPct;
                return p >= lo && p < hi;
            });
            if (inB.length === 0) return;
            const wr = inB.filter(l => l.outcome === 'win').length / inB.length * 100;
            const mid = (lo + Math.min(hi, 100)) / 2;
            const dev = wr - mid;
            const devColor = Math.abs(dev) < 10 ? 'var(--teal)' : (Math.abs(dev) < 25 ? 'var(--amber, #ffb627)' : 'var(--red, #ef5350)');
            html += `<tr><td style="padding:2px 6px;">${lo}-${Math.min(hi, 100)}%</td><td style="padding:2px 6px;">${inB.length}</td><td style="padding:2px 6px;">${wr.toFixed(0)}%</td><td style="padding:2px 6px; color:${devColor};">${dev >= 0 ? '+' : ''}${dev.toFixed(0)}pt</td></tr>`;
        });
        html += `</table>`;
    }

    // Counterfactueel blok: wat leverden de handmatige trades op, gesplitst naar
    // "bot zou hier ook instappen" vs. "bot zou NIET instappen". Dat tweede vak
    // is de blinde vlek van het systeem - daar zit de leerwaarde.
    const man = learningLog.filter(l => l.manual);
    if (man.length > 0) {
        const groep = (arr) => arr.length ? `${arr.length}x, winrate ${(arr.filter(l => l.outcome === 'win').length / arr.length * 100).toFixed(0)}%, gem ${(arr.reduce((a, l) => a + l.pnlPct, 0) / arr.length * 100).toFixed(2)}%` : '-';
        html += `<div style="font-size:0.7em; color:var(--amber, #ffb627); margin:14px 0 4px;">Handmatige trades (counterfactueel \u00b7 tellen niet mee voor kalibratie/gewichten)</div>`;
        html += `<div style="font-family:'JetBrains Mono',monospace; font-size:0.62em; color:var(--text-dim);">`;
        html += `bot zou ook instappen: ${groep(man.filter(l => l.botWouldEnter === true))}<br>`;
        html += `bot zou NIET instappen: ${groep(man.filter(l => l.botWouldEnter === false))}`;
        html += `</div>`;
    }

    if (botSettings.nodeWeightMode === 'manual') {
        html += `<div style="font-size:0.64em; color:#ffb627; margin-top:8px;">Node-gewicht staat HANDMATIG op ${botSettings.nodeWeightManual}${botSettings.nodeWeightManual === 0 ? ' (node-invloed uit)' : ''} \u2014 het lerende systeem past dit gewicht niet aan.</div>`;
    }

    if (_calibMap) {
        const mapTxt = _calibMap.map(([r, w]) => `${r.toFixed(0)}\u2192${w.toFixed(0)}`).join(' \u00b7 ');
        html += `<div style="font-size:0.64em; color:var(--teal); margin-top:8px;">Herkalibratie actief (weergave): ruwe score \u2192 gemeten winrate: ${mapTxt}</div>`;
    }
    if (lastCalibrationSummary) {
        html += `<div style="font-size:0.62em; color:var(--text-dimmer); margin-top:10px;">Laatst herijkt: ${lastCalibrationSummary.timestamp}</div>`;
    }
    el.innerHTML = html;
}

function renderActiveSettingsPanel() {
    const el = document.getElementById('active-settings-panel');
    if (!el) return;

    if (!botSettings.isRunning) {
        el.innerHTML = `<span style="color:#888;">Bot staat stil - geen actieve sessie-instellingen.</span>`;
        return;
    }

    const lastEvent = sessionLog.length > 0 ? sessionLog[sessionLog.length - 1] : null;
    const startEvent = [...sessionLog].reverse().find(e => e.event === 'START' || e.event === 'AUTO_RESTART');

    const s = botSettings;
    const rows = [
        ['Wallet valuta', walletState.currency],
        ['Max % per trade', `${(s.maxAllocationPct * 100).toFixed(0)}%`],
        ['Stop-loss %', `${(s.stopLossPct * 100).toFixed(1)}%`],
        ['Min. kans % (entry)', `${s.minProbabilityPct}%`],
        ['Min. kans % (doorlopen >2%)', `${s.holdContinuationMinProbabilityPct}%`],
        ['Min. verwacht rendement %', `${s.minProjectedProfitPct}%`],
        ['Max open posities', `${s.maxOpenPositions}`],
        ['Hedge-reserve %', `${(s.minHedgeReservePct * 100).toFixed(0)}%`],
        ['Pending order geldig', `${s.pendingOrderTtlMinutes} min`],
        ['Min. verlies % vroege exit', `${(s.minLossForEarlyExit * 100).toFixed(1)}%`],
        ['Winst-bescherming (piek / greep)', `${(s.profitProtectActivationPct * 100).toFixed(1)}% / ${s.profitProtectKeepPct}%`],
        ['Kans-collaps (drempel / bevestiging)', `${s.probCollapseThresholdPct}% / ${s.probCollapseConfirmSeconds}s`],
        ['Regime-poort / tijd-stop', `${s.regimeGateEnabled ? 'aan' : 'uit'} / ${s.maxPositionAgeMinutes || 0}min`],
        ['Kleine-winst-oogst', `${s.smallProfitHarvestMinutes > 0 ? s.smallProfitHarvestMinutes + 'min' : 'uit'}`],
        ['Node-gewicht', s.nodeWeightMode === 'manual' ? `handmatig ${s.nodeWeightManual}${s.nodeWeightManual === 0 ? ' (uit)' : ''}` : 'adaptief'],
        ['Kans-collaps', s.probCollapseEnabled ? `aan (${s.probCollapseThresholdPct}% / ${s.probCollapseConfirmSeconds}s)` : 'UIT'],
        ['Bevestigingstijd exit', `${s.continuationConfirmationSeconds}s`],
        ['Range-scalp doel / stop / alloc', `${s.rangeScalpProfitTargetPct}% / ${s.rangeScalpStopLossPct}% / ${(s.rangeScalpAllocationPct * 100).toFixed(0)}%`],
        ['Chase (aan >kans / na min)', `${s.chaseEnabled ? 'aan' : 'uit'} / ${s.chaseProbabilityThreshold}% / ${s.chaseAfterMinutes}min`],
        ['Reallocatie (aan / marge)', `${s.reallocationEnabled ? 'aan' : 'uit'} / ${s.reallocationMarginPct}%`],
        ['Realloc. min. leeftijd / cooldown', `${s.reallocationMinAgeMinutes ?? 0}min / ${s.reallocationCooldownMinutes ?? 0}min`],
        ['Executiemodus', s.executionMode === 'TESTNET' ? 'BINANCE TESTNET (echte orders, nepgeld)' : 'Simulatie (intern)'],
        ['Fee / slippage per zijde', s.executionMode === 'TESTNET' ? 'echt (van exchange-fills)' : `${s.feePct ?? 0}% / ${s.slippagePct ?? 0}% (totaal ${(((s.feePct ?? 0) + (s.slippagePct ?? 0)) * 2).toFixed(2)}% r.t.)`],
        ['MA fast / slow', `${maFastPeriod} / ${maSlowPeriod}`],
        ['RSI periode / OB / OS', `${rsiPeriod} / ${rsiOverbought} / ${rsiOversold}`],
    ];

    const timingInfo = `<div style="margin-bottom:8px; font-size:0.8em; color:#aaa;">` +
        (startEvent ? `Sessie gestart: <b>${formatFullDateTime(new Date(startEvent.timestamp).getTime())}</b>` : '') +
        (lastEvent && lastEvent.event === 'SETTINGS_UPDATED' ? ` | Laatst live bijgewerkt: <b>${formatFullDateTime(new Date(lastEvent.timestamp).getTime())}</b>` : '') +
        `</div>`;

    el.innerHTML = timingInfo + `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap:4px 12px; font-size:0.8em;">` +
        rows.map(([k, v]) => `<div><span style="color:#888;">${k}:</span> <b>${v}</b></div>`).join('') +
        `</div>`;
}


function stopAutonomousBot() {
    const modeBadge = document.getElementById('engine-mode-badge');
    if (modeBadge) { modeBadge.textContent = ''; modeBadge.style.display = 'none'; }
    // 1. Stop de bot-logica
    botSettings.isRunning = false;
    recordSessionEvent('STOP');
    expandConfigPanel();
    
    // 2. Stop de 'hartslag' van de bot (belangrijk!)
    if (botInterval) {
        clearInterval(botInterval);
        botInterval = null;
    }

    // 3. Wis het geheugen zodat de bot niet auto-start na refresh
    localStorage.setItem('botIsRunning', 'false');
    localStorage.removeItem('botStartTime');
    
    // 4. Update de UI
    document.getElementById('bot-status').innerText = "STANDBY";
    document.getElementById('btn-start-bot').style.display = 'inline-block';
    document.getElementById('btn-stop-bot').style.display = 'none';
    
    // Optioneel: Reset runtime naar 0
    document.getElementById('bot-runtime').innerText = "Runtime: 00:00:00";
    renderActiveSettingsPanel();
}

// ============================================================
// WALLET / POSITIE HELPERS
// ============================================================
// Balance = alleen gerealiseerd kapitaal (startkapitaal + gerealiseerde P/L).
// Dit is de stabiele basis waartegen nieuwe posities worden gesized (zie
// openPositionFromOrder) - zo pyramide je nooit op nog-niet-gerealiseerde winst.
function getBalance() {
    return walletState.startingCapital + walletState.realizedPnL;
}

function getAllocatedPct() {
    return openPositions.reduce((sum, p) => sum + p.sizePct, 0);
}

function getUnrealizedPnL() {
    if (!livePrice) return 0;
    // NETTO (15-07): inclusief de round-trip kosten die bij sluiten geboekt
    // worden, zodat Open P/L en Equity tonen wat je werkelijk overhoudt en
    // niet een optimistische bruto-waarde.
    const costFrac = roundTripCostPct() / 100;
    return openPositions.reduce((sum, p) => {
        const grossPct = p.side === 'LONG'
            ? (livePrice - p.entryPrice) / p.entryPrice
            : (p.entryPrice - livePrice) / p.entryPrice;
        return sum + (p.notional * (grossPct - costFrac));
    }, 0);
}

// Equity = Balance + unrealized P/L van alle open posities: beweegt live mee
// met de markt, zoals gevraagd. Alleen voor weergave/inzicht - de bot zelf
// sized nieuwe trades tegen getBalance(), niet tegen deze dynamische waarde.
function getEquity() {
    return getBalance() + getUnrealizedPnL();
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function resetWallet() {
    if (!confirm("Weet je zeker dat je de wallet wilt resetten? Alle open posities, pending orders en logs worden gewist.")) return;

    const capitalInput = document.getElementById('start-capital');
    const newCapital = capitalInput ? parseFloat(capitalInput.value) : 1000;
    const currencyInput = document.getElementById('wallet-currency-select');
    const newCurrency = ['USD', 'USDT'].includes(currencyInput?.value) ? currencyInput.value : 'EUR';

    walletState = {
        startingCapital: (!isNaN(newCapital) && newCapital > 0) ? newCapital : 1000,
        realizedPnL: 0,
        currency: newCurrency,
        wins: 0,
        losses: 0
    };
    openPositions = [];
    pendingOrders = [];
    botTradeLog = [];
    osirisSystemLog = [];

    localStorage.removeItem('osirisWalletState');
    localStorage.removeItem('osirisOpenPositions');
    localStorage.removeItem('osirisPendingOrders');
    localStorage.removeItem('osirisTradeLog');

    const histBody = document.getElementById('history-body');
    if (histBody) histBody.innerHTML = '';

    updateWalletUI();
    updatePendingOrdersUI();
    console.log(`Wallet gereset naar ${walletSymbol()}${walletState.startingCapital} (${walletState.currency})`);
}

// ============================================================
// UI UPDATES
// ============================================================
// ============================================================
// LIVE BEREDENERING: laat continu zien HOE de bot elke open positie
// beoordeelt - welke fase van de exit-boom hij zit, en waar hij precies op
// wacht. Puur weergave; herhaalt (goedkoop) de logica uit
// checkOpenPositionsExits() om een leesbare uitleg te genereren zonder die
// functie zelf te hoeven ombouwen.
// ============================================================
function getPositionReasoning(pos) {
    if (!livePrice) return `${pos.side} @ ${formatChartPrice(pos.entryPrice)} | wacht op live data...`;

    const pnlPct = pos.side === 'LONG'
        ? (livePrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - livePrice) / pos.entryPrice;
    const activeStopLossPct = pos.customStopLossPct ?? botSettings.stopLossPct;

    let zone, detail = '';
    if (pnlPct <= -activeStopLossPct) {
        zone = '🔴 STOP-LOSS geraakt'; detail = 'sluit nu';
    } else if (pnlPct >= botSettings.profitHoldTriggerPct) {
        zone = `🟢 Winst-hold (\u2265+${(botSettings.profitHoldTriggerPct * 100).toFixed(1)}%)`;
        const trail = pos.trailingStopPct != null ? `${(pos.trailingStopPct * 100).toFixed(2)}%` : '-';
        detail = `trailing stop @ ${trail} | drempel ${botSettings.holdContinuationMinProbabilityPct}%`;
    } else if (pnlPct > 0 && isTargetReached(pos)) {
        zone = '🎯 Doel geraakt'; detail = 'sluit nu';
    } else if (pnlPct >= botSettings.minProfitForTrendExit) {
        zone = '🟡 Winst < drempel'; detail = pos.isScalp ? 'wacht op scalp-doel' : `trend-check actief (drempel ${botSettings.minProbabilityPct}%)`;
    } else if (pnlPct < 0 && Math.abs(pnlPct) >= botSettings.minLossForEarlyExit) {
        zone = '🟠 Verlies - trend-check actief'; detail = `drempel ${botSettings.minProbabilityPct}%`;
    } else {
        zone = '⚪ Neutraal'; detail = `wacht tot > ${(botSettings.minLossForEarlyExit * 100).toFixed(1)}% verlies of ${(botSettings.minProfitForTrendExit * 100).toFixed(1)}% winst`;
    }

    let confirmTxt = '';
    if (pos.continuationIneligibleSince) {
        const elapsed = Math.floor((Date.now() - pos.continuationIneligibleSince) / 1000);
        confirmTxt = ` | bevestiging: ${elapsed}/${botSettings.continuationConfirmationSeconds}s`;
    }

    // FIX: pos.probabilityPct is een BEVROREN momentopname van het moment van
    // instappen - twee posities op tegenovergestelde kanten kunnen dus allebei
    // ~100% tonen zonder dat dat tegenstrijdig is, ZOLANG ze op verschillende
    // momenten zijn geopend (elk toen terecht hoog voor die kant op dat
    // moment). Dat is op zichzelf geen fout, maar wél verwarrend zonder de
    // LIVE kans ernaast - die kan nu wél duidelijk uiteenlopen als de markt
    // sindsdien is gedraaid. Beide worden nu getoond, expliciet onderscheiden.
    let chanceTxt = '';
    if (pos.probabilityPct !== null && pos.probabilityPct !== undefined) {
        const liveCheck = evaluateContinuation(pos.side);
        chanceTxt = ` | winkans nu ${formatProbWithCalibration(liveCheck.probabilityPct)} (bij entry ${formatConfidencePct(pos.probabilityPct)}) / verlieskans nu ${formatConfidencePct(100 - liveCheck.probabilityPct)}`;
    }

    // Netto tonen (zie WEERGAVE-FIX 15-07): dit is wat sluiten nu zou boeken.
    const nettoPct = pnlPct - roundTripCostPct() / 100;
    return `[${pos.isScalp ? 'SCALP' : 'TREND'}] ${pos.side} @ ${formatChartPrice(pos.entryPrice)} | P/L ${(nettoPct * 100).toFixed(2)}% netto | ${zone}${detail ? ': ' + detail : ''}${confirmTxt}${chanceTxt}`;
}

// ============================================================
// LIVE NARRATIE: "continuous unpacking" van de berekening zelf - niet alleen
// het eindresultaat (kans X%, status Y), maar ELKE stap ertussen: de ruwe
// inputs, welke confluence-punten wel/niet vuren en waarom, de node/sessie-
// timing, het momentum-geheugen, de fib-confluentie, de indicatoren, en
// tot slot de richting-bewuste eindscore voor beide kanten. Ververst elke
// 10s (dezelfde cadans als de scan zelf).
// ============================================================
function generateLiveNarration() {
    if (!lastOsirisDecision || !livePrice) return ['Wacht op eerste marktdata-scan...'];

    const lines = [];
    lines.push(`INPUT · VFM ${vfm.toFixed(2)} · ER ${er.toFixed(2)} · DB ${db.toFixed(2)} · Chaos ${chaos.toFixed(2)}% · isBullish ${isBullish}`);

    const checks = [
        `${Math.abs(vfm) > CONF_VFM_TH ? '\u2713' : '\u2717'} |VFM|>${CONF_VFM_TH} (+2)`,
        `${Math.abs(db) > CONF_DB_TH ? '\u2713' : '\u2717'} |DB|>${CONF_DB_TH} (+1)`,
        `${chaos < CONF_CHAOS_TH ? '\u2713' : '\u2717'} Chaos<${CONF_CHAOS_TH} (+1)`,
        `${er > CONF_ER_TH ? '\u2713' : '\u2717'} ER>${CONF_ER_TH} (+1)`
    ];
    if (lastOsirisMetrics) checks.push(`${lastOsirisMetrics.score > 65 ? '\u2713' : '\u2717'} VolScore>65 (+1)`);
    lines.push(`CONFLUENCE-OPBOUW · ${checks.join(' \u00b7 ')} \u2192 ${lastOsirisDecision.confluence}/9`);

    const nodeCtx = getNodeContext();
    const nodeInf = calculateNodeInfluence(nodeCtx);
    lines.push(`NODE-TIMING · volgende ${nodeCtx.nextNode.type} over ${Math.round(nodeCtx.nextNode.minutesUntil)}min \u00b7 laatste ${nodeCtx.lastNode.type} was ${Math.round(nodeCtx.lastNode.minutesAgo)}min geleden \u2192 invloed ${nodeInf >= 0 ? '+' : ''}${nodeInf.toFixed(2)}`);

    const momentum = getMomentumContext();
    const streakTxt = momentum.consecutiveBullish > 0 ? `${momentum.consecutiveBullish}x bullish op rij` : (momentum.consecutiveBearish > 0 ? `${momentum.consecutiveBearish}x bearish op rij` : 'geen duidelijke streak');
    lines.push(`MOMENTUM-GEHEUGEN · ${streakTxt} \u00b7 vfm-trend ${momentum.vfmTrend}${momentum.rangeCompressed ? ' \u00b7 range samengedrukt' : ''}`);

    const fibInf = calculateFibConfluenceInfluence(livePrice);
    lines.push(`FIB-CONFLUENTIE · ${fibInf > 0 ? `+${fibInf} (${fibInf / 3} extra schaal${fibInf > 3 ? 'en' : ''} MES/MAC dichtbij)` : 'geen extra schaal-bevestiging dichtbij'}`);

    const cp = detectCandlestickPattern();
    const ms = detectMarketStructure();
    const patternLabels = { hammer: 'Hamer', hanging_man: 'Hanging man', inverted_hammer: 'Inverted hammer', shooting_star: 'Shooting star', doji: 'Doji', dragonfly_doji: 'Dragonfly doji', gravestone_doji: 'Gravestone doji', spinning_top: 'Spinning top', bullish_engulfing: 'Bullish engulfing', bearish_engulfing: 'Bearish engulfing', piercing_line: 'Piercing line', dark_cloud_cover: 'Dark cloud cover', harami_bull: 'Harami (bullish)', harami_bear: 'Harami (bearish)', tweezer_top: 'Tweezer top', tweezer_bottom: 'Tweezer bottom', three_white_soldiers: 'Three white soldiers', three_black_crows: 'Three black crows', morning_star: 'Morning star', evening_star: 'Evening star', marubozu_bull: 'Marubozu (bullish)', marubozu_bear: 'Marubozu (bearish)' };
    lines.push(`PATROON/STRUCTUUR · ${cp.pattern ? patternLabels[cp.pattern] + ` (${cp.bias})` : 'geen duidelijk candlestick-patroon'} \u00b7 ${ms.structure}`);

    const maVals = getCurrentMAValues();
    const rsiVal = getCurrentRSIValue();
    let indicatorTxt = 'INDICATOREN · ';
    indicatorTxt += maVals.fast !== null ? `MA${maFastPeriod} ${maVals.fast.toFixed(0)} / MA${maSlowPeriod} ${maVals.slow.toFixed(0)} (${maVals.fast > maVals.slow ? 'bullish' : 'bearish'} stand)` : 'MA nog niet beschikbaar';
    indicatorTxt += rsiVal !== null ? ` \u00b7 RSI${rsiPeriod} ${rsiVal.toFixed(0)}` : '';
    lines.push(indicatorTxt);

    const confDirs = getDirectionalConfidences();
    lines.push(`EINDSCORE \u00b7 LONG ${formatProbWithCalibration(confDirs.bullish)} vs. drempel ${botSettings.minProbabilityPct}% (${confDirs.bullish >= botSettings.minProbabilityPct ? 'gehaald' : 'niet gehaald'}) \u00b7 SHORT ${formatProbWithCalibration(confDirs.bearish)} vs. drempel ${botSettings.minProbabilityPct}% (${confDirs.bearish >= botSettings.minProbabilityPct ? 'gehaald' : 'niet gehaald'})`);

    lines.push(`STATUS · ${lastOsirisDecision.decision}`);

    return lines;
}

function updateReasoningPanel() {
    const el = document.getElementById('bot-reasoning');
    if (!el) return;

    const narration = generateLiveNarration();
    const narrationHtml = `<div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.08);">` +
        `<div style="font-size:0.62rem; letter-spacing:0.1em; text-transform:uppercase; color:#888; margin-bottom:6px;">Live berekening</div>` +
        narration.map(line => `<div style="font-size:0.72em; color:#9fb3c8; font-family:'JetBrains Mono',monospace; line-height:1.6;">${line}</div>`).join('') +
        `</div>`;

    if (openPositions.length === 0) {
        let scanTxt = 'Geen open posities.';
        if (pendingOrders.length > 0) {
            scanTxt += ` ${pendingOrders.length} pending order(s) actief.`;
        }
        el.innerHTML = narrationHtml + `<div style="color:#888; font-size:0.85em;">${scanTxt}</div>`;
        return;
    }

    el.innerHTML = narrationHtml + openPositions.map(pos =>
        `<div style="margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #222; font-size:0.8em;">${getPositionReasoning(pos)}</div>`
    ).join('');
}

function updateWalletUI() {
    const equity = getEquity();
    const balance = getBalance();
    const unrealized = getUnrealizedPnL();
    const allocatedPct = getAllocatedPct() * 100;
    const totalTrades = walletState.wins + walletState.losses;
    const winRate = totalTrades > 0 ? ((walletState.wins / totalTrades) * 100).toFixed(1) : null;

    setText('wallet-equity', formatMoney(equity));
    setText('wallet-balance', formatMoney(balance));
    // P/L nu ook als PERCENTAGE: gerealiseerd t.o.v. startkapitaal, open P/L
    // t.o.v. de ingezette notional van de open posities (of startkapitaal als
    // er niets open staat) - zo lees je in één oogopslag de schaal.
    const realizedPct = walletState.startingCapital > 0 ? (walletState.realizedPnL / walletState.startingCapital) * 100 : 0;
    setText('wallet-realized-pnl', `${formatMoney(walletState.realizedPnL)} (${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%)`);
    const realizedEl = document.getElementById('wallet-realized-pnl');
    if (realizedEl) realizedEl.style.color = walletState.realizedPnL >= 0 ? '#00ffcc' : '#ef5350';

    const openNotional = openPositions.reduce((a, p) => a + (p.notional || 0), 0);
    const unrealBase = openNotional > 0 ? openNotional : walletState.startingCapital;
    const unrealPct = unrealBase > 0 ? (unrealized / unrealBase) * 100 : 0;
    setText('wallet-unrealized-pnl', `${formatMoney(unrealized)} (${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%)`);
    const unrealizedEl = document.getElementById('wallet-unrealized-pnl');
    if (unrealizedEl) unrealizedEl.style.color = unrealized >= 0 ? '#00ffcc' : '#ef5350';

    setText('wallet-allocated-pct', `${allocatedPct.toFixed(1)}%`);
    setText('wallet-open-count', `${openPositions.length}`);
    setText('wallet-winrate', winRate !== null ? `${winRate}% (${walletState.wins}W / ${walletState.losses}L)` : '--');

    // Backwards-compatible aggregate P/L veld (bovenin de bot-monitor tegel) - nu met bedrag erbij
    const aggPct = equity !== 0 ? (unrealized / equity) * 100 : 0;
    setText('bot-pnl', `${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}% (${unrealized >= 0 ? '+' : ''}${formatMoney(unrealized)})`);
    const pnlEl = document.getElementById('bot-pnl');
    if (pnlEl) pnlEl.style.color = unrealized >= 0 ? '#00ffcc' : '#ef5350';

    // Open-posities tabel
    const posBody = document.getElementById('open-positions-body');
    if (posBody) {
        if (openPositions.length === 0) {
            posBody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:#888; padding:8px;">Geen open posities</td></tr>`;
            setText('bot-position', 'Geen');
        } else {
            posBody.innerHTML = openPositions.map(p => {
                // WEERGAVE-FIX (15-07): P/L wordt NETTO getoond (bruto minus de
                // verwachte round-trip kosten). Voorheen toonde het scherm bruto
                // terwijl de boeking bij sluiten netto is - een positie op
                // "+0.10%" stond werkelijk op -0.14%, en elke exit leek dan
                // "winst die in verlies veranderde". Wat je nu ziet is wat je
                // bij sluiten ongeveer boekt.
                const grossPct = livePrice ? (p.side === 'LONG'
                    ? (livePrice - p.entryPrice) / p.entryPrice
                    : (p.entryPrice - livePrice) / p.entryPrice) : 0;
                const pnlPct = grossPct - roundTripCostPct() / 100;
                const color = pnlPct >= 0 ? '#00ffcc' : '#ef5350';
                const entryTijd = p.openTime ? formatFullDateTime(p.openTime) : '-';
                const typeLabel = p.isManual ? 'MANUAL' : (p.isScalp ? 'SCALP' : 'TREND');
                const typeColor = p.isManual ? '#ffb627' : (p.isScalp ? '#c678dd' : '#4287f5');
                return `<tr>
                    <td style="padding:4px; color:${typeColor}; font-weight:bold; font-size:0.8em;" title="${p.isManual ? 'handmatige trade - telt niet mee voor kalibratie/gewichten' : 'bot-trade'}">${typeLabel}</td>
                    <td style="color:${p.side === 'LONG' ? '#26a69a' : '#ef5350'}; font-weight:bold;">${p.side}</td>
                    <td>${formatChartPrice(p.entryPrice)}</td>
                    <td style="font-size:0.9em; color:#aaa;">${entryTijd}</td>
                    <td>${p.amount}</td>
                    <td>${formatMoney(p.notional)}</td>
                    <td>${(p.sizePct * 100).toFixed(1)}%</td>
                    <td style="color:${color};" title="netto na ${roundTripCostPct().toFixed(2)}% round-trip kosten (bruto ${(grossPct * 100).toFixed(2)}%)">${(pnlPct * 100).toFixed(2)}%</td>
                    <td style="color:${color};">${formatMoney(p.notional * pnlPct)}</td>
                    <td style="padding:2px 4px;"><button type="button" class="btn btn-ghost btn-mini" style="color:#ff5f7e; border-color:rgba(255,95,126,0.5); padding:2px 7px; font-size:0.7em;" onclick="closePositionManually('${p.id}')" title="Sluit deze positie nu tegen de live prijs">Sluit</button></td>
                </tr>`;
            }).join('');
            setText('bot-position', openPositions.map(p => p.side).join(' + '));
        }
    }

    updatePositionLines();
    updateReasoningPanel();
}

function updatePendingOrdersUI() {
    const el = document.getElementById('pending-orders-list');
    if (!el) return;
    if (pendingOrders.length === 0) {
        el.innerHTML = `<span style="color:#888;">Geen pending orders</span>`;
        return;
    }
    // Pending orders komen UITSLUITEND van de trend-engine - de range-scalp-
    // engine opent altijd meteen tegen de live prijs, dus deze lijst is per
    // definitie nooit een scalp. Vandaar de vaste [TREND]-tag hier.
    el.innerHTML = pendingOrders.map(o => {
        const winChance = formatConfidencePct(o.probabilityPct);
        const lossChance = formatConfidencePct(100 - o.probabilityPct);
        return `<div>${o.side === 'LONG' ? '🟢' : '🔴'} [TREND] ${o.side} wacht op ${formatChartPrice(o.triggerPrice)} (winkans ${winChance} / verlieskans ${lossChance}, verwacht +${o.projectedProfitPct.toFixed(2)}%)</div>`;
    }).join('');
}

// ============================================================
// OPEN POSITIES OP DE CHART (toggelbaar, zoals de MIC/MES/MAC fib-lijnen)
// ============================================================
// Dropdown-gestuurd: "HIDDEN"/"VISIBLE" i.p.v. een los aan/uit-knopje.
function handlePositionLinesSelect(value) {
    showPositionLines = (value === 'VISIBLE');
    updatePositionLines();
}

function updatePositionLines() {
    // Wis altijd eerst de oude lijnen
    positionChartLines.forEach(line => {
        try { candlestickSeries.removePriceLine(line); } catch (e) { /* lijn bestond al niet meer */ }
    });
    positionChartLines = [];

    if (!showPositionLines || typeof candlestickSeries === 'undefined') return;

    openPositions.forEach(pos => {
        const color = pos.side === 'LONG' ? '#26a69a' : '#ef5350';

        const entryLine = candlestickSeries.createPriceLine({
            price: pos.entryPrice,
            color,
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: `${pos.side} ENTRY`
        });
        positionChartLines.push(entryLine);

        if (pos.targetPrice) {
            const targetLine = candlestickSeries.createPriceLine({
                price: parseFloat(pos.targetPrice),
                color,
                lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dotted,
                axisLabelVisible: true,
                title: `${pos.side} TARGET`
            });
            positionChartLines.push(targetLine);
        }

        // Toon de actieve stop: trailing stop indien actief, anders de vaste -2% stop-loss
        const stopPrice = pos.trailingStopPct != null
            ? (pos.side === 'LONG' ? pos.entryPrice * (1 + pos.trailingStopPct) : pos.entryPrice * (1 - pos.trailingStopPct))
            : (pos.side === 'LONG' ? pos.entryPrice * (1 - botSettings.stopLossPct) : pos.entryPrice * (1 + botSettings.stopLossPct));
        const stopLine = candlestickSeries.createPriceLine({
            price: stopPrice,
            color: '#ff4444',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${pos.side} STOP`
        });
        positionChartLines.push(stopLine);
    });
}

function updateHistoryUI(entry) {
    const body = document.getElementById('history-body');
    if (!body) return;
    const pnlColor = entry.pnl >= 0 ? '#00ffcc' : '#ef5350';
    const typeLabel = entry.isScalp ? 'SCALP' : 'TREND';
    const typeColor = entry.isScalp ? '#c678dd' : '#4287f5';
    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid #222';
    row.innerHTML = `
        <td style="padding:5px; color:#888;">${entry.timestamp}</td>
        <td style="color:${typeColor}; font-weight:bold; font-size:0.85em;">${typeLabel}</td>
        <td style="color:${entry.side === 'LONG' ? '#26a69a' : '#ef5350'};">${entry.side || '-'}</td>
        <td>${typeof entry.price === 'number' ? formatChartPrice(entry.price) : entry.price}</td>
        <td>${entry.amount}</td>
        <td>${formatMoney(entry.notionalEUR || 0)}</td>
        <td style="color:${pnlColor}; font-weight:bold;">${(entry.pnl * 100).toFixed(2)}% (${formatMoney(entry.pnlAmount || 0)})</td>
    `;
    body.insertBefore(row, body.firstChild);
    // FIX: toonde voorheen alleen de laatste 10 rijen (harde cap). De gebruiker
    // wil nu ALLE gesloten posities van de huidige bot-sessie kunnen zien - de
    // tabel-container is scrollbaar gemaakt (zie CSS), dus geen cap meer nodig.
}

// ============================================================
// LOGGING
// ============================================================
// Volledige datum + tijd (i.p.v. alleen tijd) zodat entries/exits die over
// middernacht of dagen heen lopen nog steeds eenduidig te herleiden zijn.
function formatFullDateTime(ts = Date.now()) {
    const d = new Date(ts);
    const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const time = d.toLocaleTimeString('nl-NL');
    return `${date} ${time}`;
}

function logBotAction(action, price, side, pnl = 0, amount = 0, reason = '', pnlAmount = 0, notionalEUR = 0, isScalp = false) {
    const timestamp = formatFullDateTime();
    const priceNum = typeof price === 'number' ? price : parseFloat(price);
    // Fallback voor het (zeldzame) geval dat notional niet is meegegeven:
    // amount*priceNum geeft een USD-bedrag (want price komt van BTCUSDT). Is de
    // wallet zelf USD, dan is dat al goed; is de wallet EUR, dan eerst omrekenen.
    const usdNotionalFallback = (amount && priceNum) ? amount * priceNum : 0;
    const walletNotionalFallback = isQuoteCurrencyWallet()
        ? usdNotionalFallback
        : (eurUsdtRate ? usdNotionalFallback / eurUsdtRate : usdNotionalFallback);
    const notional = notionalEUR || walletNotionalFallback;

    const entry = {
        timestamp,
        timestampMs: Date.now(), // FIX: los van de opgemaakte string, nodig om per-sessie te kunnen filteren
        action,
        price,
        side,
        pnl,
        pnlAmount,
        amount,
        notionalEUR: notional,
        reason,
        equity: getEquity(),
        isScalp
    };
    botTradeLog.push(entry);

    const actionEl = document.getElementById('bot-last-action');
    if (actionEl) {
        const priceTxt = typeof price === 'number' ? formatChartPrice(price) : price;
        const sizeTxt = amount ? `(${amount} BTC \u2248 ${formatMoney(notional)})` : '';
        actionEl.innerText = `${action} ${side || ''} @ ${priceTxt} ${sizeTxt} ${reason ? `[${reason}]` : ''} (${timestamp})`.replace(/\s+/g, ' ');
    }

    if (action === "EXIT") {
        updateHistoryUI(entry);
    }

    updateWalletUI();
}

// ============================================================
// OSIRIS OPPORTUNITY & PROBABILITY ENGINE
// ============================================================

// Heuristische zekerheids-score (GEEN gevalideerde statistische win-rate!).
// Gebaseerd op de bestaande confluence-telling (0-5, zie getOrisisDecisionData)
// plus chaos/ER als betrouwbaarheids-correctie. Dit is een instelbare proxy —
// kalibreer 'm met de gedownloade data (Download All Data-knop).
// FIX (aangetoond met echte export-data): confluence wordt maar ÉÉN keer per
// 10s-scan berekend en meet "hoeveel energie zit er in de huidige,
// waargenomen richting (isBullish)" - dat is NIET automatisch bewijs vóór een
// specifieke positie. Zonder richtingscorrectie werd dezelfde confluence van
// bijvoorbeeld 7/9 identiek bij zowel de LONG- als de SHORT-kansberekening
// opgeteld, waardoor een SHORT tijdens een sterke BULLISH BREAKOUT alsnog op
// 100% kans uitkwam - de kleine (±4) momentum-straf werd volledig overstemd
// door +63 (confluence) +10 (chaos/er) +~1-6 (node/fib), die geen van allen
// richting-specifiek waren. Nu telt confluence alleen mee als steun wanneer
// de kant van de positie overeenkomt met de waargenomen marktrichting; bij
// een tegengestelde richting trekt het er juist fors vanaf.
// FIX: calculateProbabilityScore clampt de ruwe score altijd naar [0,100] -
// een ruwe score van 101.81 en eentje van 180 zien er dus BEIDE identiek uit
// als "100%", wat een schijnzekerheid wekt die de heuristiek niet heeft. Exact
// 100 (of 0) raken is vrijwel altijd een teken dat de score geclampt is, niet
// dat er letterlijk 100% zekerheid is. Toon dat eerlijk i.p.v. een harde 100%.
function formatConfidencePct(pct) {
    if (pct >= 99.5) return '\u2265 99%'; // door logisticCompress wordt exact 100 nooit meer bereikt
    if (pct <= 0.5) return '\u2264 1%';
    return `~${pct.toFixed(0)}%`;
}

function calculateProbabilityScore(confluence, chaosVal, erVal, nodeInfluence = 0, momentumInfluence = 0, fibConfluenceInfluence = 0, side = null, isBullishNow = null, patternInfluence = 0) {
    let confluenceContribution = confluence * 9; // default (oud gedrag) als side/isBullishNow niet zijn meegegeven
    if (side !== null && isBullishNow !== null) {
        const directionAligned = (side === 'LONG' && isBullishNow) || (side === 'SHORT' && !isBullishNow);
        confluenceContribution = directionAligned ? confluence * 9 : -(confluence * 5);
    }
    // NIVEAU 1 - ADAPTIEVE GEWICHTEN: elke bijdrage wordt vermenigvuldigd met
    // een factor die begint op 1.0 en langzaam bijstelt op basis van hoe goed
    // die factor in de PRAKTIJK (afgesloten trades) daadwerkelijk voorspelde.
    // Zie recalibrateAdaptiveWeights() - blijft te allen tijde transparant en
    // inspecteerbaar, geen black box.
    confluenceContribution *= adaptiveWeights.confluence;
    nodeInfluence *= effectiveNodeWeight();
    momentumInfluence *= adaptiveWeights.momentumInfluence;
    fibConfluenceInfluence *= adaptiveWeights.fibConfluence;
    patternInfluence *= adaptiveWeights.pattern;

    let score = 50 + confluenceContribution; // confluence 0-9 -> tot 50-131 (aligned) of omlaag (tegengesteld), geclamped naar [0,100]
    if (chaosVal > 15) score -= 15;    // extreme volatiliteit = onbetrouwbaarder
    else if (chaosVal < 5) score += 5; // rustige markt = betrouwbaarder
    if (erVal > 1.5) score += 5;       // sterke volume-deelname = betrouwbaarder
    score += nodeInfluence;            // node-timing: VOLA/CORE verhogen, RESET verlaagt (zie calculateNodeInfluence)
    score += momentumInfluence;        // "geheugen": trend uit metricsHistory bevestigt of ontkracht het signaal
    score += fibConfluenceInfluence;   // MES/MAC fib-niveaus (dezelfde lijnen als op de chart) die de MIC-trigger bevestigen
    score += patternInfluence;         // candlestick-patronen (hamer/engulfing/etc.) + markt-structuur (HH/HL vs LH/LL)
    // NIEUW: volume-profile-bias. Prijs onder de value area (VAL) = koopzone
    // (ondersteunt LONG); boven de value area (VAH) = verkoopzone (ondersteunt
    // SHORT). Conservatief gewogen (max ~4 punten) zodat het de bestaande signalen
    // aanvult i.p.v. domineert - order-boek/volume-muren zijn context, geen orakel.
    if (_volumeProfile && side && isFinite(livePrice)) {
        const vpb = volumeProfileBias(livePrice).bias;  // -0.5..+0.5 (positief = koopzone)
        const gericht = side === 'LONG' ? vpb : -vpb;    // LONG profiteert van koopzone, SHORT van verkoopzone
        score += gericht * 8;                            // ±4 punten maximaal
    }
    // FIX (data 12-07): de harde clamp naar [0,100] maakte alle sterke signalen
    // identiek - 96 van 134 pending orders toonden "kans 100%" terwijl de echte
    // winrate 55% was. Daardoor filterden minProbabilityPct en de chase/reallocatie-
    // drempels bovenin de schaal helemaal niets meer. Een logistische compressie
    // behoudt de volgorde van de ruwe scores maar nadert 100 slechts asymptotisch:
    //   raw 50 -> 50 | raw 70 -> 75 | raw 90 -> 90 | raw 110 -> 97 | raw 131 -> 99
    // Zo blijft een ruwe 131 ook zichtbaar sterker dan een ruwe 101, en betekent
    // een reallocatie-marge van X punten weer echt iets.
    return logisticCompress(score);
}

function logisticCompress(rawScore) {
    const compressed = 100 / (1 + Math.exp(-(rawScore - 50) / 18));
    return Math.max(0.1, Math.min(99.9, compressed));
}

// Vertaalt de momentum-context (uit het metrics-geheugen) naar een kleine,
// begrensde bijstelling (-6..+6): een aanhoudende trend in dezelfde richting
// als het voorgestelde signaal verhoogt de kans; een tegengestelde trend of
// een samendrukkende (consoliderende) range verlaagt hem.
function calculateMomentumInfluence(side, momentumContext) {
    if (!momentumContext) return 0;
    let influence = 0;

    if (side === 'LONG' && momentumContext.consecutiveBullish >= 3) influence += 4;
    if (side === 'SHORT' && momentumContext.consecutiveBearish >= 3) influence += 4;
    if (side === 'LONG' && momentumContext.consecutiveBearish >= 3) influence -= 4;
    if (side === 'SHORT' && momentumContext.consecutiveBullish >= 3) influence -= 4;

    if (momentumContext.vfmTrend === 'rising') influence += 2;
    else if (momentumContext.vfmTrend === 'falling') influence -= 2;

    if (momentumContext.rangeCompressed) influence -= 2; // consolidatie = minder betrouwbaar signaal

    return Math.max(-6, Math.min(6, influence));
}

// Bepaalt het niveau waarop Osiris autonoom wil instappen: een pullback-zone
// op basis van de micro (9-candle) Fibonacci-retracement, in plaats van
// blind op de huidige live prijs in te stappen.
// FIX: dit gebruikte een eigen, losse 9-candle fib-berekening die NIETS te
// maken had met de MIC-lijn die je daadwerkelijk op de chart ziet (die is
// node-tijd-gedreven, zie computeFibScaleLevels). Nu leest de bot exact
// dezelfde currentFibLevels.MIC uit die ook de chart tekent.
function calculateEntryTrigger(side, currentPrice) {
    const micData = currentFibLevels.MIC;
    if (!micData) return currentPrice; // node-grid fib nog niet berekend - val terug op live prijs

    // LONG: wacht op een pullback naar de 0.618-retracement van de echte MIC-lijn
    // SHORT: wacht op een opleving naar de 0.382-retracement van de echte MIC-lijn
    const level = side === 'LONG' ? micData.levels['0.618'] : micData.levels['0.382'];
    if (!isFinite(level)) return currentPrice;

    // Als dat niveau te ver van de huidige prijs afligt (>1.5%) is wachten
    // niet realistisch binnen een redelijke tijd -> gebruik de live prijs.
    const distancePct = Math.abs(currentPrice - level) / currentPrice;
    if (distancePct > 0.015) return currentPrice;

    return level;
}

// NIEUW: checkt of de live prijs ook dicht bij een MES- of MAC-fib-niveau zit
// (dezelfde lijnen als op de chart) - meerdere schalen die tegelijk
// bevestigen is een sterker signaal dan alleen de MIC-lijn. Elke extra
// bevestigende schaal levert +3 op, dus max +6 (MES én MAC allebei dichtbij).
// ============================================================
// PATROONHERKENNING: candlestick-patronen (hamer, engulfing, doji, etc.) en
// markt-structuur (higher-highs/higher-lows vs. lower-highs/lower-lows).
// Werkt op dezelfde rawData-candles als de rest van de engine. Voegt een
// begrensde "patternInfluence" toe aan de kans-score, net als node/momentum/
// fib - en telt mee in het adaptieve leersysteem (niveau 1).
// ============================================================

// ---- Losse candlestick-patronen (laatste 1-3 candles) ----
// UITGEBREID (13-07): van 9 naar 22 patronen, zodat de bot meer markt-
// microstructuur herkent. Contextbewust waar dat hoort: dezelfde candle-vorm
// is bullish na een daling (hamer / inverted hammer) maar bearish na een
// stijging (hanging man / shooting star). Detectievolgorde: meest specifieke
// en meest zeldzame patronen eerst, generieke vormen (doji, spinning top) laatst.
// De optionele data-parameter laat de chart patronen tekenen op de VIEW-candles
// terwijl de bot zelf altijd op zijn eigen 15m-data blijft scannen.
function detectCandlestickPattern(index = null, data = null) {
    const src = data || rawData;
    if (!src || src.length < 3) return { pattern: null, bias: 'neutral' };
    const i = index === null ? src.length - 1 : index;
    if (i < 2) return { pattern: null, bias: 'neutral' };

    const c = [src[i - 2], src[i - 1], src[i]].map(d => ({
        open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
    }));
    const [c2, c1, c0] = c; // c0 = de candle op index i, c1 = ervoor, c2 = twee ervoor

    function metrics(k) {
        const body = Math.abs(k.close - k.open);
        const range = k.high - k.low || 0.0001;
        const upperWick = k.high - Math.max(k.open, k.close);
        const lowerWick = Math.min(k.open, k.close) - k.low;
        const isBull = k.close >= k.open;
        return { body, range, upperWick, lowerWick, isBull, bodyPct: body / range };
    }
    const m0 = metrics(c0), m1 = metrics(c1), m2 = metrics(c2);
    const wasUptrend = m1.isBull && m2.isBull;   // grove trend-context van de 2 candles ervoor
    const wasDowntrend = !m1.isBull && !m2.isBull;
    const bodyTop1 = Math.max(c1.open, c1.close), bodyBot1 = Math.min(c1.open, c1.close);
    const mid1 = (c1.open + c1.close) / 2;
    const wickTol = m0.range * 0.15; // tolerantie voor "gelijke" highs/lows (tweezers)

    // --- 3-candle momentum-patronen (zeldzaam en sterk) ---
    if (m2.isBull && m1.isBull && m0.isBull && m2.bodyPct > 0.5 && m1.bodyPct > 0.5 && m0.bodyPct > 0.5 &&
        c1.close > c2.close && c0.close > c1.close) {
        return { pattern: 'three_white_soldiers', bias: 'bullish' };
    }
    if (!m2.isBull && !m1.isBull && !m0.isBull && m2.bodyPct > 0.5 && m1.bodyPct > 0.5 && m0.bodyPct > 0.5 &&
        c1.close < c2.close && c0.close < c1.close) {
        return { pattern: 'three_black_crows', bias: 'bearish' };
    }
    // --- Morning/evening star (3 candles): groot - klein/besluiteloos - groot terug ---
    if (!m2.isBull && m2.bodyPct > 0.5 && m1.bodyPct < 0.35 && m0.isBull && m0.bodyPct > 0.5 && c0.close > (c2.open + c2.close) / 2) {
        return { pattern: 'morning_star', bias: 'bullish' };
    }
    if (m2.isBull && m2.bodyPct > 0.5 && m1.bodyPct < 0.35 && !m0.isBull && m0.bodyPct > 0.5 && c0.close < (c2.open + c2.close) / 2) {
        return { pattern: 'evening_star', bias: 'bearish' };
    }

    // --- Marubozu: nagenoeg geen pitten, maximale overtuiging ---
    if (m0.bodyPct > 0.92) {
        return { pattern: m0.isBull ? 'marubozu_bull' : 'marubozu_bear', bias: m0.isBull ? 'bullish' : 'bearish' };
    }

    // --- 2-candle omkeerpatronen ---
    // Engulfing: body van c0 omsluit volledig de body van c1
    if (!m1.isBull && m0.isBull && c0.open < c1.close && c0.close > c1.open) {
        return { pattern: 'bullish_engulfing', bias: 'bullish' };
    }
    if (m1.isBull && !m0.isBull && c0.open > c1.close && c0.close < c1.open) {
        return { pattern: 'bearish_engulfing', bias: 'bearish' };
    }
    // Piercing line: forse rode candle, dan groene die onder de low opent en
    // boven het midden van de rode body sluit (maar niet volledig omsluit)
    if (!m1.isBull && m1.bodyPct > 0.5 && m0.isBull && c0.open < c1.close && c0.close > mid1 && c0.close < c1.open) {
        return { pattern: 'piercing_line', bias: 'bullish' };
    }
    // Dark cloud cover: spiegelbeeld
    if (m1.isBull && m1.bodyPct > 0.5 && !m0.isBull && c0.open > c1.close && c0.close < mid1 && c0.close > c1.open) {
        return { pattern: 'dark_cloud_cover', bias: 'bearish' };
    }
    // Harami: kleine body volledig BINNEN de grote body ervan - momentum stokt
    if (m1.bodyPct > 0.5 && m0.body < m1.body * 0.5 &&
        Math.max(c0.open, c0.close) < bodyTop1 && Math.min(c0.open, c0.close) > bodyBot1) {
        if (!m1.isBull) return { pattern: 'harami_bull', bias: 'bullish' };
        return { pattern: 'harami_bear', bias: 'bearish' };
    }
    // Tweezer top/bottom: twee (bijna) gelijke extremen, tegengestelde candles
    if (m1.isBull && !m0.isBull && Math.abs(c0.high - c1.high) <= wickTol && m1.bodyPct > 0.3) {
        return { pattern: 'tweezer_top', bias: 'bearish' };
    }
    if (!m1.isBull && m0.isBull && Math.abs(c0.low - c1.low) <= wickTol && m1.bodyPct > 0.3) {
        return { pattern: 'tweezer_bottom', bias: 'bullish' };
    }

    // --- Doji-familie: nagenoeg geen body ---
    if (m0.bodyPct < 0.08) {
        if (m0.lowerWick > m0.range * 0.6) return { pattern: 'dragonfly_doji', bias: 'bullish' };
        if (m0.upperWick > m0.range * 0.6) return { pattern: 'gravestone_doji', bias: 'bearish' };
        return { pattern: 'doji', bias: 'neutral' };
    }

    // --- Enkelvoudige pit-patronen, contextbewust ---
    // Lange onderpit: hamer (bullish, na daling) of hanging man (bearish, na stijging)
    if (m0.lowerWick >= m0.body * 2 && m0.upperWick < m0.body * 0.5 && m0.bodyPct < 0.35) {
        if (wasUptrend) return { pattern: 'hanging_man', bias: 'bearish' };
        return { pattern: 'hammer', bias: 'bullish' };
    }
    // Lange bovenpit: shooting star (bearish, na stijging) of inverted hammer (bullish, na daling)
    if (m0.upperWick >= m0.body * 2 && m0.lowerWick < m0.body * 0.5 && m0.bodyPct < 0.35) {
        if (wasDowntrend) return { pattern: 'inverted_hammer', bias: 'bullish' };
        return { pattern: 'shooting_star', bias: 'bearish' };
    }
    // Spinning top: kleine body met pitten aan beide kanten - besluiteloosheid
    if (m0.bodyPct < 0.3 && m0.upperWick > m0.body && m0.lowerWick > m0.body) {
        return { pattern: 'spinning_top', bias: 'neutral' };
    }

    return { pattern: null, bias: 'neutral' };
}

// ---- Markt-structuur: higher-highs/higher-lows vs. lower-highs/lower-lows ----
// FIX (chart 12-07, 15m): de oude detectie telde ELKE order-3 pivot even zwaar,
// zonder significantiefilter. Gevolg op echte data: de lows stegen perfect
// (63826 -> 63959 -> 64042), maar één micro-piek van $37 (13:15, minder dan
// een halve gemiddelde candle-range) brak de "highs stijgend"-keten en
// veto'de de hele classificatie naar "range-bound" - terwijl elke menselijke
// blik op de chart een schoolvoorbeeld van HH/HL zag. De detectie werkt nu
// ZigZag-stijl: pivots moeten alterneren (H-L-H-L; zelfde-kant pivots houden
// alleen de extreemste) en een omkeer telt pas als hij minstens
// 1.5x de gemiddelde candle-range groot is - kleinere zwaaien zijn ruis.
// Gevalideerd op de sessie van 12-07: oud = "range-bound", nieuw = "HH/HL",
// conform de visuele structuur.
function detectMarketStructure() {
    const SWING_ORDER = 3, LOOKBACK = 60;
    if (!rawData || rawData.length < LOOKBACK) return { structure: 'onvoldoende data', swingHighs: [], swingLows: [] };

    const candles = rawData.slice(-LOOKBACK).map(d => ({ high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]) }));

    // 1. Ruwe order-3 pivots, in tijdsvolgorde
    const pivots = [];
    for (let i = SWING_ORDER; i < candles.length - SWING_ORDER; i++) {
        const win = candles.slice(i - SWING_ORDER, i + SWING_ORDER + 1);
        if (candles[i].high === Math.max(...win.map(w => w.high))) pivots.push({ type: 'H', val: candles[i].high, i });
        if (candles[i].low === Math.min(...win.map(w => w.low))) pivots.push({ type: 'L', val: candles[i].low, i });
    }
    pivots.sort((a, b) => a.i - b.i);

    // 2. ZigZag-filter: minimale omkeergrootte = 1.5x gemiddelde candle-range
    const avgRangeFrac = candles.reduce((s, c) => s + (c.high - c.low) / c.close, 0) / candles.length;
    const minReversal = 1.5 * avgRangeFrac * candles[candles.length - 1].close;
    const zz = [];
    for (const p of pivots) {
        if (zz.length === 0) { zz.push({ ...p }); continue; }
        const last = zz[zz.length - 1];
        if (p.type === last.type) {
            // zelfde kant: alleen de extreemste bewaren
            if ((p.type === 'H' && p.val > last.val) || (p.type === 'L' && p.val < last.val)) zz[zz.length - 1] = { ...p };
        } else if (Math.abs(p.val - last.val) >= minReversal) {
            zz.push({ ...p }); // significante omkeer
        } // anders: ruiszwaai, negeren
    }

    const lastHighs = zz.filter(p => p.type === 'H').map(p => p.val).slice(-3);
    const lastLows = zz.filter(p => p.type === 'L').map(p => p.val).slice(-3);
    if (lastHighs.length < 2 || lastLows.length < 2) return { structure: 'onvoldoende swings', swingHighs: lastHighs, swingLows: lastLows };

    const highsRising = lastHighs.every((v, i) => i === 0 || v >= lastHighs[i - 1]);
    const highsFalling = lastHighs.every((v, i) => i === 0 || v <= lastHighs[i - 1]);
    const lowsRising = lastLows.every((v, i) => i === 0 || v >= lastLows[i - 1]);
    const lowsFalling = lastLows.every((v, i) => i === 0 || v <= lastLows[i - 1]);

    let structure = 'range-bound / geen duidelijke structuur';
    if (highsRising && lowsRising) structure = 'HH/HL (opwaartse structuur)';
    else if (highsFalling && lowsFalling) structure = 'LH/LL (neerwaartse structuur)';

    return { structure, swingHighs: lastHighs, swingLows: lastLows };
}

// Combineert beide tot één begrensde bijdrage (-4..+4) aan de kans-score,
// afhankelijk van of het gedetecteerde patroon/structuur de gekozen kant steunt.
function calculatePatternInfluence(side) {
    let influence = 0;
    const cp = detectCandlestickPattern();
    if (cp.bias === 'bullish') influence += (side === 'LONG' ? 2 : -2);
    else if (cp.bias === 'bearish') influence += (side === 'SHORT' ? 2 : -2);

    const ms = detectMarketStructure();
    if (ms.structure.startsWith('HH/HL')) influence += (side === 'LONG' ? 2 : -2);
    else if (ms.structure.startsWith('LH/LL')) influence += (side === 'SHORT' ? 2 : -2);

    return Math.max(-4, Math.min(4, influence));
}

// Vult het "Patroon & Structuur"-kaartje in System Data - dezelfde detectie
// als hierboven, puur voor het snelle overzicht zonder het beredeneringspaneel te hoeven openen.
function updatePatternStructureCard() {
    const patternEl = document.getElementById('current-pattern');
    const structureEl = document.getElementById('current-structure');
    if (!patternEl || !structureEl) return;

    // Labels hergebruiken uit PATTERN_MARKER_STYLE zodat alle 22 patronen
    // automatisch gedekt zijn en er nooit meer een 'undefined' verschijnt.
    const cp = detectCandlestickPattern();
    const st = cp.pattern ? PATTERN_MARKER_STYLE[cp.pattern] : null;
    patternEl.innerText = st ? `${st.text} (${cp.bias})` : 'Geen duidelijk patroon';

    const ms = detectMarketStructure();
    structureEl.innerText = ms.structure;
}

function calculateFibConfluenceInfluence(price) {
    let influence = 0;
    ['MES', 'MAC'].forEach(scaleId => {
        const data = currentFibLevels[scaleId];
        if (!data) return;
        const nearAnyLevel = Object.values(data.levels).some(lvl => isFinite(lvl) && Math.abs(price - lvl) / price < 0.003);
        if (nearAnyLevel) influence += 3;
    });
    return influence;
}

// Evalueert of een kans (nieuwe entry, of het vasthouden van een lopende
// positie) voldoet aan Osiris' eisen: kans >= minProbabilityPct EN
// verwachte winst > minProjectedProfitPct.
function evaluateEntryOpportunity(side, decision, metrics, currentPrice) {
    const triggerPrice = calculateEntryTrigger(side, currentPrice);
    const nodeContext = getNodeContext();
    const nodeInfluence = calculateNodeInfluence(nodeContext);
    const momentumContext = getMomentumContext();
    const momentumInfluence = calculateMomentumInfluence(side, momentumContext);
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(currentPrice);
    const patternInfluence = calculatePatternInfluence(side);
    let probabilityPct = calculateProbabilityScore(decision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, side, isBullish, patternInfluence);

    const targetPrice = side === 'LONG'
        ? parseFloat(decision.targets.meso.bullish)
        : parseFloat(decision.targets.meso.bearish);

    const projectedProfitPct = side === 'LONG'
        ? ((targetPrice - triggerPrice) / triggerPrice) * 100
        : ((triggerPrice - targetPrice) / triggerPrice) * 100;

    // FIX: het verwachte doel moet de round-trip fees OVERTREFFEN plus de
    // ingestelde minimumwinst - anders is een "geslaagde" trade netto verlies.
    // Plus (13-07): de REGIME-POORT - in een dood regime (lage vol én lage
    // energie, aanhoudend) gaan er geen nieuwe entries open.
    // Plus (14-07): de kans is GESMOOTHED (mediaan van de laatste metingen) -
    // een entry vergt een aanhoudend hoge kans, niet één opgewonden meting.
    probabilityPct = smoothProb(side, probabilityPct);
    const regime = evaluateMarketRegime();
    const eligible = probabilityPct >= botSettings.minProbabilityPct &&
                      projectedProfitPct > (botSettings.minProjectedProfitPct + roundTripCostPct()) &&
                      !regime.dead;

    return { eligible, triggerPrice, targetPrice, projectedProfitPct, probabilityPct, nodeContext, nodeInfluence, momentumContext, momentumInfluence, fibConfluenceInfluence, confluence: decision.confluence, patternInfluence };
}

// ============================================================
// HANDMATIGE TRADE (15-07) - COUNTERFACTUELE DATA
// Opent een positie op commando via dezelfde executielaag (dus echte
// testnet-fill), met een eigen allocatie-percentage van de balance.
// Cruciaal: legt vast wat de BOT dacht op dat moment (factorsAtEntry +
// probabilityPct), ook als de bot zelf niet zou zijn ingestapt. Dat is de
// blinde vlek van het leersysteem: de bot leert nu alleen van momenten waarop
// hij zelf wilde handelen. Deze trades vullen de "wat als"-gaten.
// STRIKT: isManual=true. Ze tellen NIET mee in de kalibratietabel en NIET in
// de gewichten-herijking (ze komen uit een ander beslisproces en zouden juist
// het instrument vervuilen dat meet of de bot zichzelf eerlijk inschat), maar
// worden verder volledig opgeslagen, beheerd en geexporteerd als elke andere
// trade - inclusief alle exit-mechanismes, zodat ze vergelijkbaar blijven.
// Uitzondering: de reallocatie-engine mag ze niet opofferen (een bewuste keuze
// van de gebruiker wordt niet automatisch weggeruild voor een bot-idee).
// ============================================================
function openManualPosition(side) {
    if (!livePrice) { alert('Nog geen live prijs - wacht tot de stream draait.'); return; }
    const input = document.getElementById('manual-alloc-pct');
    const pct = Math.min(Math.max(parseFloat(input?.value) || 20, 1), 70);
    const allocPct = pct / 100;

    const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeHasPosition = openPositions.some(p => p.side === oppositeSide);
    const hedgeReserve = oppositeHasPosition ? 0 : botSettings.minHedgeReservePct;
    const availablePct = Math.max(0, 1 - getAllocatedPct() - hedgeReserve);
    const finalSizePct = Math.min(allocPct, availablePct);
    if (finalSizePct <= 0.001) {
        alert(`Onvoldoende vrije allocatie: ${(availablePct * 100).toFixed(1)}% beschikbaar (na hedge-reserve).`);
        return;
    }

    const balance = getBalance();
    const notional = balance * finalSizePct;
    const notionalUSD = isQuoteCurrencyWallet() ? notional : (eurUsdtRate ? notional * eurUsdtRate : notional);
    const amount = parseFloat((notionalUSD / livePrice).toFixed(6));

    // Wat dacht de bot op dit moment? (ook als hij zelf niet zou instappen)
    const nodeInfluence = calculateNodeInfluence(getNodeContext());
    const momentumInfluence = calculateMomentumInfluence(side, getMomentumContext());
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(livePrice);
    const patternInfluence = calculatePatternInfluence(side);
    const confluence = lastOsirisDecision ? lastOsirisDecision.confluence : null;
    const botProb = (confluence !== null)
        ? calculateProbabilityScore(confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, side, isBullish, patternInfluence)
        : null;
    const cal = botProb !== null ? calibrateProbability(botProb) : null;

    const botZouInstappen = botProb !== null && botProb >= botSettings.minProbabilityPct;
    const ok = confirm(
        `HANDMATIGE ${side}\n\n` +
        `Prijs: $${livePrice.toFixed(1)}\n` +
        `Inzet: ${pct}% van balance = ${formatMoney(notional)} (${amount} BTC)\n` +
        `Executie: ${botSettings.executionMode === 'TESTNET' ? 'ECHTE testnet-order' : 'simulatie'}\n\n` +
        `Bot-kans nu: ${botProb !== null ? botProb.toFixed(0) + '%' : 'onbekend'}${cal !== null ? ` (kal. ${cal.toFixed(0)}%)` : ''}\n` +
        `De bot zou hier ${botZouInstappen ? 'ZELF OOK instappen' : 'NIET instappen'} (drempel ${botSettings.minProbabilityPct}%).\n\n` +
        `Deze trade telt niet mee voor kalibratie/gewichten, maar wordt wel volledig gelogd.\n\nDoorgaan?`
    );
    if (!ok) return;

    const targetPrice = (lastOsirisDecision && lastOsirisDecision.targets)
        ? parseFloat(side === 'LONG' ? lastOsirisDecision.targets.meso.bullish : lastOsirisDecision.targets.meso.bearish)
        : (side === 'LONG' ? livePrice * 1.01 : livePrice * 0.99);

    const position = {
        id: `manual_${Date.now()}_${side}`,
        side,
        entryPrice: livePrice,
        amount,
        notional,
        sizePct: finalSizePct,
        targetPrice,
        probabilityPct: botProb,
        nodeInfluence,
        openTime: Date.now(),
        closeTime: null,
        peakPnlPct: 0,
        trailingStopPct: null,
        isManual: true,           // <- markering: counterfactuele data
        botWouldEnter: botZouInstappen,
        factorsAtEntry: {
            confluence: confluence,
            nodeInfluence,
            momentumInfluence,
            fibConfluenceInfluence,
            patternInfluence,
            probabilityPct: botProb
        }
    };
    commitPositionEntry(position, `MANUAL_ENTRY | alloc ${pct}% | bot-kans ${botProb !== null ? botProb.toFixed(0) + '%' : '?'} (bot zou ${botZouInstappen ? 'ook' : 'NIET'} instappen)`);
}

// HANDMATIG SLUITEN (17-07): sluit een open positie op commando, ook terwijl
// de bot draait. Loopt via dezelfde closePosition() als elke bot-exit, dus de
// fill, de boeking en de logging zijn identiek; alleen de reden verschilt
// (MANUAL_CLOSE), zodat je hem in de exit-verdeling apart terugziet.
function closePositionManually(id) {
    const pos = openPositions.find(p => p.id === id);
    if (!pos) return;
    if (!livePrice) { alert('Nog geen live prijs - wacht tot de stream draait.'); return; }
    const grossPct = pos.side === 'LONG'
        ? (livePrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - livePrice) / pos.entryPrice;
    const nettoPct = grossPct - roundTripCostPct() / 100;
    const ok = confirm(
        `POSITIE HANDMATIG SLUITEN\n\n` +
        `${pos.isManual ? 'HANDMATIGE' : 'BOT-'}${pos.isScalp ? ' SCALP' : ' TREND'} ${pos.side} @ $${pos.entryPrice.toFixed(1)}\n` +
        `Nu: $${livePrice.toFixed(1)}\n` +
        `Resultaat: ${(nettoPct * 100).toFixed(2)}% netto (${formatMoney(pos.notional * nettoPct)})\n` +
        `bruto ${(grossPct * 100).toFixed(2)}% minus ${roundTripCostPct().toFixed(2)}% kosten\n\n` +
        `Sluiten?`
    );
    if (!ok) return;
    closePosition(pos, nettoPct + roundTripCostPct() / 100, `MANUAL_CLOSE (handmatig gesloten op ${(nettoPct * 100).toFixed(2)}% netto)`);
}

// REGIME-POORT: bepaalt of de markt op dit moment "dood" is - gerealiseerde
// volatiliteit (chaos) én energie (|VFM|) beide onder hun eigen mediaan van de
// beschikbare meethistorie, aanhoudend gedurende regimeGateConfirmMinutes.
// Mediaan-gebaseerd = zelfkalibrerend: geen magische constantes, werkt op elk
// activum en in elk volatiliteitsregime. Bij te weinig historie (<60 samples,
// ~10 min) blijft de poort open - liever handelen op de bestaande drempels dan
// blind blokkeren.
// Ringbuffers voor kans-smoothing, per kant. smoothProb() voegt de nieuwste
// ruwe meting toe en geeft de mediaan van de laatste N terug.
const _probBuffers = { LONG: [], SHORT: [] };
function smoothProb(side, rawProb) {
    if (rawProb === null || !isFinite(rawProb)) return rawProb;
    const buf = _probBuffers[side];
    if (!buf) return rawProb;
    buf.push(rawProb);
    const cap = Math.max(2, botSettings.probSmoothingSamples || 6);
    while (buf.length > cap) buf.shift();
    const sorted = [...buf].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

let _regimeDeadSince = null;
let _lastRegimeSkipLog = 0;
function evaluateMarketRegime() {
    if (!botSettings.regimeGateEnabled) return { dead: false, reason: 'poort uit' };
    if (metricsHistory.length < 60) return { dead: false, reason: 'te weinig historie' };
    const chaosVals = metricsHistory.map(m => m.chaos).filter(v => isFinite(v)).sort((a, b) => a - b);
    const vfmVals = metricsHistory.map(m => Math.abs(m.vfm)).filter(v => isFinite(v)).sort((a, b) => a - b);
    const medChaos = chaosVals[Math.floor(chaosVals.length / 2)];
    const medVfm = vfmVals[Math.floor(vfmVals.length / 2)];
    const lowNow = chaos < medChaos && Math.abs(vfm) < medVfm;
    if (!lowNow) { _regimeDeadSince = null; return { dead: false, reason: 'regime actief' }; }
    if (!_regimeDeadSince) _regimeDeadSince = Date.now();
    const deadMinutes = (Date.now() - _regimeDeadSince) / 60000;
    if (deadMinutes < (botSettings.regimeGateConfirmMinutes || 0)) return { dead: false, reason: 'dood regime, nog niet bevestigd' };
    // Throttled loggen (max 1x per 5 min) - anders vult dit de tradelog met SKIPPED-spam
    if (Date.now() - _lastRegimeSkipLog > 5 * 60000) {
        _lastRegimeSkipLog = Date.now();
        logBotAction("SKIPPED", livePrice, isBullish ? 'LONG' : 'SHORT', 0, 0, `REGIME_GATE: vol ${chaos.toFixed(2)} < mediaan ${medChaos.toFixed(2)} en |VFM| ${Math.abs(vfm).toFixed(2)} < mediaan ${medVfm.toFixed(2)} - al ${deadMinutes.toFixed(0)} min dood, entries gepauzeerd`);
    }
    return { dead: true, reason: `dood regime (${deadMinutes.toFixed(0)} min)` };
}

// FIX: dit was voorheen evaluateEntryOpportunity() (zie hierboven) die óók een
// "minstens 1% ruimte tot het doel"-eis stelt. Die eis is bedoeld voor NIEUWE
// instappen ("is deze trade de moeite waard?"), niet voor een beslissing om een
// AL WINSTGEVENDE positie vast te houden - eenmaal 2%+ in winst is de ruimte tot
// hetzelfde doel vaak al bijna op, waardoor die eis meteen faalde en Osiris de
// winst binnen enkele ticks na het raken van 2% weer sloot. Deze functie stelt
// alleen de vraag die er bij het HOUDEN toe doet: wijst trend/momentum/kans nog
// steeds dezelfde kant op? Geen "ruimte tot doel"-eis meer.
function evaluateContinuation(side, thresholdOverride = null) {
    const threshold = thresholdOverride ?? botSettings.minProbabilityPct;
    if (!lastOsirisDecision) {
        // Geen recente scan beschikbaar (net gestart) - wees voorzichtig en
        // sluit niet af op basis van ontbrekende data; laat de trailing stop
        // en de harde stop-loss het werk doen.
        return { eligible: true, probabilityPct: null };
    }
    const nodeContext = getNodeContext();
    const nodeInfluence = calculateNodeInfluence(nodeContext);
    const momentumContext = getMomentumContext();
    const momentumInfluence = calculateMomentumInfluence(side, momentumContext);
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(livePrice);
    const patternInfluence = calculatePatternInfluence(side);
    const probabilityPct = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, side, isBullish, patternInfluence);

    return {
        eligible: probabilityPct >= threshold,
        probabilityPct, nodeContext, nodeInfluence, momentumContext, momentumInfluence
    };
}

// FIX (echte data uit een Download All Data-export liet zien dat dit nodig
// was): evaluateContinuation() werd voorheen direct uitgevoerd op elke check,
// waardoor één enkele, kortstondig "niet-gunstige" meting - die toevallig
// precies op een lokaal omslagpunt viel - meteen een positie sloot. In de
// geanalyseerde data gebeurde dit twee keer: posities werden op het exacte
// dieptepunt/hoogtepunt gestopt, vlak vóór een scherpe ommekeer die net in hun
// voordeel zou zijn geweest. Momentum-bevestiging is inherent een lagging
// signaal - tegen de tijd dat "genoeg" candles op een rij bevestigen, is de
// beweging vaak al bijna uitgeput. Deze wrapper eist dat het signaal
// continu "niet gunstig" blijft voor minstens continuationConfirmationSeconds
// (standaard 20s) vóórdat er daadwerkelijk gesloten wordt - lang genoeg om een
// enkele ruis-meting te negeren, kort genoeg om nog steeds "vroeg" te zijn.
function evaluateContinuationWithConfirmation(pos, side, thresholdOverride = null) {
    const result = evaluateContinuation(side, thresholdOverride);

    if (result.eligible) {
        pos.continuationIneligibleSince = null; // signaal is weer gunstig - reset de teller
        return { ...result, confirmed: false };
    }

    if (!pos.continuationIneligibleSince) {
        pos.continuationIneligibleSince = Date.now();
    }
    const ineligibleForMs = Date.now() - pos.continuationIneligibleSince;
    const confirmed = ineligibleForMs >= (botSettings.continuationConfirmationSeconds * 1000);

    return { ...result, confirmed };
}

// Elke 10 seconden: scan of er een nieuwe kans is voor LONG en/of SHORT.
// Hedging is toegestaan (beide kanten tegelijk), maar niet dubbel op dezelfde kant.
// Herbeoordeelt bestaande pending orders elke 10s (dynamische geldigheid i.p.v.
// alleen een harde TTL) - als het signaal intussen is weggevallen, wordt de
// order meteen geannuleerd i.p.v. te blijven wachten tot de vervaltijd. Loopt
// op dezelfde 10s-cadans als de rest van de Osiris-scan, dus zonder extra load.
// FIX: dit hergebruikte evaluateEntryOpportunity(), die bij ELKE herbeoordeling
// een compleet NIEUWE instapprijs berekent en opnieuw de volle "1% verse
// winstruimte"-eis stelt. Bij een kleine prijsschommeling kan die herberekende
// ruimte tijdelijk onder de drempel duiken, waardoor geldige orders veel te
// vaak voortijdig werden geannuleerd. Deze check kijkt alleen of de
// onderliggende kans nog redelijk overeind staat (met een marge van 10
// procentpunt onder de entry-drempel als buffer tegen ruis), zonder de
// oorspronkelijke triggerPrice/targetPrice van de order opnieuw te herschrijven.
function isPendingOrderStillValid(order) {
    if (!lastOsirisDecision) return { valid: true, probabilityPct: null }; // geen recente scan - wees niet te snel met cancelen

    const nodeContext = getNodeContext();
    const nodeInfluence = calculateNodeInfluence(nodeContext);
    const momentumContext = getMomentumContext();
    const momentumInfluence = calculateMomentumInfluence(order.side, momentumContext);
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(livePrice);
    const patternInfluence = calculatePatternInfluence(order.side);
    const probabilityPct = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, order.side, isBullish, patternInfluence);

    const cancelThreshold = Math.max(0, botSettings.minProbabilityPct - 10);
    return { valid: probabilityPct >= cancelThreshold, probabilityPct };
}

// Elke 10 seconden herbeoordeeld: annuleert orders waarvan het signaal is
// weggevallen, EN kan een order die al een tijd wacht en nog steeds heel
// sterk staat, naar voren halen ("chase") - meteen tegen de huidige prijs
// instappen i.p.v. te blijven wachten op de oorspronkelijke pullback-trigger.
// Zo kan de bot bijvoorbeeld een LONG pending order eerder invullen als de
// kans intussen nog verder is opgelopen, i.p.v. de kans te missen omdat de
// prijs nooit meer terugzakt naar het originele niveau.
function revalidatePendingOrders(decision, metrics) {
    let changed = false;
    const now = Date.now();

    pendingOrders = pendingOrders.filter(order => {
        const check = isPendingOrderStillValid(order);
        if (!check.valid) {
            logBotAction("CANCELLED", order.triggerPrice, order.side, 0, 0, "niet langer geldig (herbeoordeeld)");
            changed = true;
            return false;
        }

        if (botSettings.chaseEnabled && check.probabilityPct !== null && check.probabilityPct >= botSettings.chaseProbabilityThreshold) {
            const ageMinutes = (now - new Date(order.createdAt).getTime()) / 60000;
            if (ageMinutes >= botSettings.chaseAfterMinutes) {
                openPositionFromOrder(order, "CHASE_ENTRY");
                changed = true;
                return false;
            }
        }

        return true;
    });
    if (changed) updatePendingOrdersUI();
}

// Elke 10 seconden: scan of er een nieuwe kans is voor LONG en/of SHORT.
// Hedging is toegestaan (beide kanten tegelijk), EN stapelen op dezelfde kant
// is toegestaan (bijv. een 2e LONG naast een al open LONG) - het enige echte
// plafond is het totale aantal open posities (maxOpenPositions). Wel maar
// één pending order tegelijk per kant, om te voorkomen dat er meerdere
// wachtende orders op precies hetzelfde signaal stapelen.
// NIEUW: als er geen ruimte is voor een nieuwe kans (positie-cap bereikt OF
// nauwelijks vrije allocatie door de hedge-reserve), overweegt de bot een
// bestaande, zwakkere positie vervroegd te sluiten om ruimte te maken - maar
// alleen als de nieuwe kans DUIDELIJK beter scoort (reallocationMarginPct)
// dan de LIVE (niet de bevroren entry-)kans van de zwakste kandidaat. Posities
// die al in de winst-hold-zone zitten (>=profitHoldTriggerPct) worden bewust
// buiten beschouwing gelaten - die worden al actief getraild/beschermd en
// horen niet opgeofferd te worden voor een nieuwe, ongeteste kans.
function tryReallocateForBetterOpportunity(newSide, newProbabilityPct) {
    if (!botSettings.reallocationEnabled || openPositions.length === 0 || !livePrice) return false;

    // FIX (data 12-07): 29 van de 42 exits waren reallocaties met netto -3.86 EUR,
    // terwijl de overige exits samen +5.31 EUR opleverden. Drie nieuwe poorten:
    // 1. COOLDOWN: minimaal reallocationCooldownMinutes tussen twee reallocaties,
    //    zodat één sterke scan geen kettingreactie van sluitingen veroorzaakt.
    const now = Date.now();
    if (lastReallocationAt && (now - lastReallocationAt) < (botSettings.reallocationCooldownMinutes || 0) * 60000) return false;

    const candidates = openPositions.filter(pos => {
        const pnlPct = pos.side === 'LONG'
            ? (livePrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - livePrice) / pos.entryPrice;
        // 2. LEEFTIJD: de winstgevende exits (TREND_REVERSAL) hielden gem. 44 min
        //    vast; reallocaties sloten na gem. 28 min - precies te vroeg. Een
        //    positie krijgt eerst reallocationMinAgeMinutes de tijd om te bewijzen.
        if (pos.isManual) return false; // handmatige keuze wordt nooit automatisch weggeruild
        const ageMinutes = (now - (pos.openTime || 0)) / 60000;
        if (ageMinutes < (botSettings.reallocationMinAgeMinutes || 0)) return false;
        // 3. ALLEEN VERLIEZERS: een positie die (na fees) op winst staat wordt
        //    nooit opgeofferd voor een onbewezen nieuwe kans. De oude drempel
        //    (< profitHoldTriggerPct = 2%) was bij trades van gemiddeld 0.03%
        //    beweging effectief géén bescherming.
        const feeFraction = roundTripCostPct() / 100;
        return (pnlPct - feeFraction) < 0;
    });
    if (candidates.length === 0) return false;

    let weakest = null, weakestScore = Infinity;
    candidates.forEach(pos => {
        const check = evaluateContinuation(pos.side);
        if (check.probabilityPct < weakestScore) {
            weakestScore = check.probabilityPct;
            weakest = pos;
        }
    });

    if (weakest && (newProbabilityPct - weakestScore) >= botSettings.reallocationMarginPct) {
        const pnlPct = weakest.side === 'LONG'
            ? (livePrice - weakest.entryPrice) / weakest.entryPrice
            : (weakest.entryPrice - livePrice) / weakest.entryPrice;
        lastReallocationAt = Date.now();
        closePosition(weakest, pnlPct, `REALLOCATED (nieuwe ${newSide}-kans ${newProbabilityPct.toFixed(0)}% vs. ${weakestScore.toFixed(0)}%)`);
        return true;
    }
    return false;
}

function scanForOpportunities(decision, metrics) {
    revalidatePendingOrders(decision, metrics);

    ['LONG', 'SHORT'].forEach(side => {
        const hasPending = pendingOrders.some(p => p.side === side);
        if (hasPending) return;

        const evalResult = evaluateEntryOpportunity(side, decision, metrics, livePrice);
        if (!evalResult.eligible) return;

        if (openPositions.length >= botSettings.maxOpenPositions) {
            const madeRoom = tryReallocateForBetterOpportunity(side, evalResult.probabilityPct);
            if (!madeRoom) return; // geen ruimte gemaakt - deze kans overslaan
        } else {
            // Er is technisch een vrije slot, maar als de beschikbare allocatie
            // door de hedge-reserve zo goed als opgesoupeerd is, wordt een
            // nieuwe positie verwaarloosbaar klein. Ook dan reallocatie overwegen.
            const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
            const oppositeHasPosition = openPositions.some(p => p.side === oppositeSide);
            const hedgeReserve = oppositeHasPosition ? 0 : botSettings.minHedgeReservePct;
            const availablePct = Math.max(0, 1 - getAllocatedPct() - hedgeReserve);
            if (availablePct < 0.03) { // <3% beschikbaar - te weinig om nog zinvol te zijn
                tryReallocateForBetterOpportunity(side, evalResult.probabilityPct);
            }
        }

        const direction = evalResult.triggerPrice < livePrice ? 'below'
            : (evalResult.triggerPrice > livePrice ? 'above' : 'touch');

        const order = {
            id: `pend_${Date.now()}_${side}`,
            side,
            triggerPrice: evalResult.triggerPrice,
            direction,
            targetPrice: evalResult.targetPrice,
            projectedProfitPct: evalResult.projectedProfitPct,
            probabilityPct: evalResult.probabilityPct,
            nodeInfluence: evalResult.nodeInfluence,
            momentumInfluence: evalResult.momentumInfluence,
            fibConfluenceInfluence: evalResult.fibConfluenceInfluence,
            confluence: evalResult.confluence,
            patternInfluence: evalResult.patternInfluence,
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + (botSettings.pendingOrderTtlMinutes * 60 * 1000)
        };
        pendingOrders.push(order);
        logBotAction("PENDING", evalResult.triggerPrice, side, 0, 0, `kans ${evalResult.probabilityPct.toFixed(0)}%`);
    });
    savePersistentState();
    updatePendingOrdersUI();
}

// ============================================================
// RANGE-SCALP: verkoopt bij de top van een recente range, koopt bij de bodem.
// Altijd actief NAAST de trend-logica hierboven (niet gated achter een
// gedetecteerde consolidatie) - beide mogen tegelijk posities openen. Anders
// dan de trend-trades wordt hier direct tegen de live prijs geopend (geen
// pending order), met een klein vast winstdoel en een eigen, krappere stop.
// ============================================================
function evaluateRangeScalpOpportunity(side) {
    if (!rawData || rawData.length < 20 || !livePrice) return { eligible: false };

    const lookback = 20; // candles - houdt de "range" recent en relevant
    const recent = rawData.slice(-lookback);
    const rangeHigh = Math.max(...recent.map(d => parseFloat(d[2])));
    const rangeLow = Math.min(...recent.map(d => parseFloat(d[3])));
    const range = rangeHigh - rangeLow;
    if (range <= 0) return { eligible: false };

    const rangePct = (range / livePrice) * 100;
    // De range moet minstens 2x het winstdoel breed zijn - anders is er
    // simpelweg geen ruimte om de scalp te laten slagen.
    if (rangePct < botSettings.rangeScalpProfitTargetPct * 2) return { eligible: false };

    const positionInRange = (livePrice - rangeLow) / range; // 0 = bodem, 1 = top
    const nearTop = positionInRange >= 0.8;
    const nearBottom = positionInRange <= 0.2;

    if (side === 'SHORT' && !nearTop) return { eligible: false };
    if (side === 'LONG' && !nearBottom) return { eligible: false };

    // VFM/ER/Chaos moeten de scalp ook inhoudelijk ondersteunen, niet alleen de
    // kale prijspositie in de range - anders scalp je zomaar tegen een echte
    // uitbraak in i.p.v. tegen uitputting. VFM (=ER*DB) codeert al zowel de
    // richtingskracht (DB) als het volume erachter (ER) in één getal:
    // - chaos > 12: te wild/expansief voor een scalp, dit lijkt eerder op een
    //   trending markt dan op een range.
    // - er > 2.0: een volumepiek op dit moment wijst eerder op een echte
    //   uitbraak dan op uitputting aan het einde van de range.
    // - SHORT bij de top: vfm mag niet nog sterk positief zijn (>1.0) - dat
    //   betekent de bullish kracht is nog springlevend, geen omslag in zicht.
    // - LONG bij de bodem: vfm mag niet nog sterk negatief zijn (<-1.0) -
    //   dezelfde logica omgekeerd.
    if (chaos > 12) return { eligible: false };
    if (er > 2.0) return { eligible: false };
    if (side === 'SHORT' && vfm > 1.0) return { eligible: false };
    if (side === 'LONG' && vfm < -1.0) return { eligible: false };

    // NIEUW: RSI als extra bevestiging voor de mean-reversion-thesis. Een
    // range-top is een veel sterker short-signaal als RSI ook daadwerkelijk
    // overbought staat; een range-bodem sterker als RSI oversold staat.
    // Gebruikt de instelbare rsiOverbought/rsiOversold-drempels (standaard 70/30).
    const rsiValue = getCurrentRSIValue();
    if (rsiValue !== null) {
        if (side === 'SHORT' && rsiValue < rsiOverbought) return { eligible: false };
        if (side === 'LONG' && rsiValue > rsiOversold) return { eligible: false };
    }

    // Niet tegen een sterk bevestigde trend in scalpen (confluence >= 4 in de
    // "verkeerde" richting voor deze scalp) - dat is precies het domein van de
    // trend-logica hierboven, niet van een range-scalp.
    if (lastOsirisDecision && lastOsirisDecision.confluence >= 4) {
        if (side === 'SHORT' && isBullish) return { eligible: false };
        if (side === 'LONG' && !isBullish) return { eligible: false };
    }

    const targetPrice = side === 'SHORT'
        ? livePrice * (1 - botSettings.rangeScalpProfitTargetPct / 100)
        : livePrice * (1 + botSettings.rangeScalpProfitTargetPct / 100);

    return { eligible: true, targetPrice, rangeHigh, rangeLow, positionInRange, vfmAtEntry: vfm, erAtEntry: er, chaosAtEntry: chaos, rsiAtEntry: rsiValue };
}

function openRangeScalpPosition(side, evalResult) {
    const price = livePrice;
    const oppositeSide = side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeHasPosition = openPositions.some(p => p.side === oppositeSide);
    const hedgeReserve = oppositeHasPosition ? 0 : botSettings.minHedgeReservePct;
    const availablePct = Math.max(0, 1 - getAllocatedPct() - hedgeReserve);
    const finalSizePct = Math.min(botSettings.rangeScalpAllocationPct, availablePct);
    if (finalSizePct <= 0.001) return; // geen ruimte - stil overslaan, geen SKIPPED-log-ruis voor iedere scan

    const balance = getBalance();
    const notional = balance * finalSizePct;
    const notionalUSD = isQuoteCurrencyWallet() ? notional : (eurUsdtRate ? notional * eurUsdtRate : notional);
    const amount = parseFloat((notionalUSD / price).toFixed(6));

    const position = {
        id: `scalp_${Date.now()}_${side}`,
        side,
        entryPrice: price,
        amount,
        notional,
        sizePct: finalSizePct,
        targetPrice: evalResult.targetPrice,
        probabilityPct: null,
        nodeInfluence: 0,
        openTime: Date.now(),
        closeTime: null,
        peakPnlPct: 0,
        trailingStopPct: null,
        isScalp: true,
        customStopLossPct: botSettings.rangeScalpStopLossPct
    };

    commitPositionEntry(position, `RANGE-SCALP alloc ${(finalSizePct * 100).toFixed(1)}%`);
}

function scanForRangeScalps() {
    ['LONG', 'SHORT'].forEach(side => {
        if (openPositions.length >= botSettings.maxOpenPositions) return;
        const hasScalpOnSide = openPositions.some(p => p.side === side && p.isScalp);
        if (hasScalpOnSide) return; // niet twee keer op dezelfde kant stapelen

        const evalResult = evaluateRangeScalpOpportunity(side);
        if (evalResult.eligible) {
            openRangeScalpPosition(side, evalResult);
        }
    });
}

// ============================================================
// ENTRY / EXIT UITVOERING (trend-trades via pending orders)
// ============================================================
function openPositionFromOrder(order, entryTag = '') {
    const price = livePrice;
    const confluence = lastOsirisDecision ? lastOsirisDecision.confluence : 0;
    const maxConfluence = 9; // zie getOrisisDecisionData: vfm(2)+db(1)+chaos(1)+er(1)+volumeScore(1)+MA(1)+crossover(1)+voorspelling(1)

    // Grootte schaalt met signaalsterkte, tot maximaal maxAllocationPct
    let desiredSizePct = Math.min((confluence / maxConfluence) * botSettings.maxAllocationPct, botSettings.maxAllocationPct);

    // Node-timing beïnvloedt ook de sizing: een gunstige node (VOLA/CORE dichtbij)
    // laat iets groter toe, een RESET-node in de buurt maakt de bot voorzichtiger.
    // Begrensd tot 0.5x-1.2x zodat dit nooit de maxAllocationPct-cap kan doorbreken
    // op een manier die de bedoeling van die instelling ondermijnt.
    const sizeMultiplier = Math.max(0.5, Math.min(1.2, 1 + (order.nodeInfluence || 0) / 100));
    desiredSizePct = Math.min(desiredSizePct * sizeMultiplier, botSettings.maxAllocationPct);

    // Nooit meer dan 100% van de beschikbare allocatie, ook niet met hedging op beide kanten.
    // Reserveer daarbovenop ruimte voor een eventuele hedge: als de andere kant nog
    // GEEN positie heeft, houd minHedgeReservePct vrij zodat er straks nog altijd
    // budget is om tegen deze positie in te hedgen als het misgaat. Heeft de andere
    // kant al een positie (de hedge bestaat al), dan is die reservering niet nodig.
    const oppositeSide = order.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeHasPosition = openPositions.some(p => p.side === oppositeSide);
    const hedgeReserve = oppositeHasPosition ? 0 : botSettings.minHedgeReservePct;

    const availablePct = Math.max(0, 1 - getAllocatedPct() - hedgeReserve);
    const finalSizePct = Math.min(desiredSizePct, availablePct);

    if (finalSizePct <= 0.001) {
        logBotAction("SKIPPED", price, order.side, 0, 0, "onvoldoende beschikbare allocatie (na hedge-reserve)");
        return;
    }

    // FIX: sizing gebeurt tegen de Balance (alleen gerealiseerd kapitaal), niet tegen
    // de dynamische Equity (die nu ook unrealized P/L meeneemt, zie getEquity()).
    // Zo pyramide je nooit positiegrootte bovenop nog-niet-gerealiseerde winst.
    const balance = getBalance();
    const notional = balance * finalSizePct; // bedrag in walletState.currency (EUR of USD)

    // `price` (livePrice) komt van BTCUSDT en is dus altijd een USD-bedrag. Is de
    // wallet zelf al in USD, dan is er niets om te converteren. Is de wallet in
    // EUR, dan moet notional eerst omgerekend naar USD via de live EUR/USDT-koers
    // voor een kloppende BTC-hoeveelheid (anders werd 1 EUR stilzwijgend als 1 USD
    // behandeld, ~8-17% fout). Zonder koers (nog niet opgehaald) valt dit terug op
    // de EUR-aanname als noodgreep, met een duidelijke log-vermelding.
    let notionalUSD;
    if (isQuoteCurrencyWallet()) {
        notionalUSD = notional; // USD/USDT-wallet: al in quote-valuta, geen conversie
    } else {
        notionalUSD = eurUsdtRate ? (notional * eurUsdtRate) : notional;
    }
    const amount = parseFloat((notionalUSD / price).toFixed(6));
    if (walletState.currency === 'EUR' && !eurUsdtRate) {
        console.warn("EUR/USDT-koers nog niet beschikbaar - BTC-hoeveelheid is een schatting op basis van 1 EUR = 1 USD.");
    }

    const position = {
        id: `pos_${Date.now()}_${order.side}`,
        side: order.side,
        entryPrice: price,
        amount,
        notional,
        sizePct: finalSizePct,
        targetPrice: order.targetPrice,
        probabilityPct: order.probabilityPct,
        nodeInfluence: order.nodeInfluence || 0,
        openTime: Date.now(),
        closeTime: null,
        peakPnlPct: 0,
        trailingStopPct: null,
        // NIVEAU 1 - vastgelegd voor recalibrateAdaptiveWeights() zodra deze positie sluit
        factorsAtEntry: {
            confluence: order.confluence ?? null,
            nodeInfluence: order.nodeInfluence ?? 0,
            momentumInfluence: order.momentumInfluence ?? 0,
            fibConfluenceInfluence: order.fibConfluenceInfluence ?? 0,
            patternInfluence: order.patternInfluence ?? 0,
            probabilityPct: order.probabilityPct ?? null
        }
    };

    const tagTxt = entryTag ? `${entryTag} | ` : '';
    commitPositionEntry(position, `${tagTxt}alloc ${(finalSizePct * 100).toFixed(1)}% | node-inv ${(order.nodeInfluence || 0).toFixed(1)}`);
}

// ============================================================
// GEDEELDE EXECUTIELAAG: één punt waar posities daadwerkelijk "gecommit"
// worden. SIM pusht direct (het oude gedrag); TESTNET plaatst eerst een echte
// market-order en maakt de positie pas aan met de werkelijke fill-prijs,
// -hoeveelheid en commissie van de exchange. Zowel trend- als scalp-entries
// lopen hierdoor, zodat de bot in beide modi identiek redeneert en alleen de
// uitvoering verschilt.
// ============================================================
function commitPositionEntry(position, reasonText) {
    if (botSettings.executionMode !== 'TESTNET') {
        openPositions.push(position);
        logBotAction("ENTRY", position.entryPrice, position.side, 0, position.amount, reasonText, 0, position.notional, position.isScalp || false);
        savePersistentState();
        updateWalletUI();
        updatePositionLines();
        return;
    }
    commitPositionEntryOnTestnet(position, reasonText); // async - positie verschijnt pas na een geslaagde fill
}

async function commitPositionEntryOnTestnet(position, reasonText) {
    try {
        const filters = await getTestnetSymbolFilters();
        const notionalUSD = position.amount * position.entryPrice; // amount is al in USD-termen gesized
        if (notionalUSD < filters.minNotional) {
            logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: order (${notionalUSD.toFixed(2)} USDT) onder minNotional (${filters.minNotional})`);
            return;
        }
        let res;
        if (position.side === 'LONG') {
            res = await testnetMarketOrder('BUY', { quoteOrderQty: notionalUSD });
        } else {
            // SHORT op spot = BTC uit het testnet-saldo verkopen ("inventory short").
            const qty = roundToStep(position.amount, filters.stepSize);
            const bal = await getTestnetBalances();
            if ((bal.BTC || 0) < qty) {
                logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: onvoldoende BTC-saldo voor SHORT (nodig ${qty}, vrij ${(bal.BTC || 0).toFixed(5)}) - wacht op maandelijkse testnet-reset of koop eerst BTC`);
                return;
            }
            if (qty < filters.minQty) {
                logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: hoeveelheid ${qty} onder minQty (${filters.minQty})`);
                return;
            }
            res = await testnetMarketOrder('SELL', { quantity: qty });
        }
        const fill = summarizeTestnetFills(res);
        if (!fill.executedQty || !fill.avgPrice) throw new Error('order gaf geen fills terug');
        // Positie krijgt de ECHTE uitvoeringsgegevens - hier zie je dus voortaan
        // de werkelijke slippage t.o.v. de livePrice waarop de bot besloot.
        position.entryPrice = fill.avgPrice;
        position.amount = fill.executedQty;
        position.baseQty = fill.executedQty;
        position.entryCommissionQuote = fill.commissionQuote;
        position.isTestnet = true;
        openPositions.push(position);
        logBotAction("ENTRY", fill.avgPrice, position.side, 0, fill.executedQty, `${reasonText} [TESTNET fill]`, 0, position.notional, position.isScalp || false);
        savePersistentState();
        updateWalletUI();
        updatePositionLines();
    } catch (e) {
        setTestnetStatus(`Entry-order mislukt: ${e.message}`, true);
        logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET entry-order mislukt: ${e.message}`);
    }
}

function closePosition(pos, pnlPct, reason) {
    if (botSettings.executionMode === 'TESTNET' && pos.isTestnet) {
        closePositionOnTestnet(pos, reason); // async - finalize gebeurt na de echte fill
        return;
    }
    // SIM: fees + slippage meenemen - round-trip tegen (feePct+slippagePct) per
    // zijde. pnlPct wordt NETTO gemaakt zodat wins/losses, learningLog en de
    // tradelog allemaal dezelfde (eerlijke) waarheid zien. Bruto blijft
    // afleidbaar: bruto = netto + roundTripCostPct()/100.
    const feeFraction = roundTripCostPct() / 100;
    finalizeClosePosition(pos, pnlPct - feeFraction, reason);
}

async function closePositionOnTestnet(pos, reason) {
    if (pos.pendingExchangeClose) return; // dubbele close voorkomen terwijl de order onderweg is
    pos.pendingExchangeClose = true;
    try {
        const filters = await getTestnetSymbolFilters();
        const orderSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const qty = roundToStep(pos.baseQty || pos.amount, filters.stepSize);
        if (qty < filters.minQty) throw new Error(`hoeveelheid ${qty} onder minQty (${filters.minQty})`);
        const res = await testnetMarketOrder(orderSide, { quantity: qty });
        const fill = summarizeTestnetFills(res);
        if (!fill.executedQty || !fill.avgPrice) throw new Error('order gaf geen fills terug');
        // PnL uit de ECHTE fill-prijzen; commissies (entry + exit) van de
        // exchange zelf, omgerekend naar een percentage van de notional.
        const grossPnlPct = pos.side === 'LONG'
            ? (fill.avgPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - fill.avgPrice) / pos.entryPrice;
        const notionalUSD = pos.entryPrice * (pos.baseQty || pos.amount);
        const commPct = notionalUSD > 0 ? ((pos.entryCommissionQuote || 0) + fill.commissionQuote) / notionalUSD : 0;
        finalizeClosePosition(pos, grossPnlPct - commPct, `${reason} [TESTNET fill]`);
    } catch (e) {
        pos.pendingExchangeClose = false; // positie blijft open; volgende scan-cyclus probeert opnieuw
        setTestnetStatus(`Exit-order mislukt: ${e.message}`, true);
        console.warn('TESTNET exit-order mislukt, positie blijft open:', e);
    }
}

function finalizeClosePosition(pos, pnlPct, reason) {
    const pnlAmount = pos.notional * pnlPct;
    walletState.realizedPnL += pnlAmount;
    if (pnlPct >= 0) walletState.wins++; else walletState.losses++;
    pos.closeTime = Date.now();

    openPositions = openPositions.filter(p => p.id !== pos.id);

    // NIVEAU 1: alleen trend-posities met een vastgelegde factor-uitsplitsing
    // doen mee (range-scalps gebruiken een ander, regel-gebaseerd systeem
    // zonder confluence-score, dus die vallen hier terecht buiten).
    if (pos.factorsAtEntry && pos.factorsAtEntry.confluence !== null) {
        learningLog.push({
            timestampMs: Date.now(),
            side: pos.side,
            factors: pos.factorsAtEntry,
            outcome: pnlPct > 0 ? 'win' : 'loss',
            pnlPct,
            // Verrijking (13-07): exit-gedrag vastleggen zodat het leren straks
            // niet alleen entry-factoren maar ook exit-mechanismes kan wegen
            // (welke exit-reden verdient, welke bloedt - per regime).
            exitReason: (reason || '').split(' ')[0],
            holdMinutes: pos.openTime ? Math.round((Date.now() - pos.openTime) / 60000) : null,
            entryProbabilityPct: pos.probabilityPct ?? null,
            // Counterfactuele markering: handmatige trades worden volledig
            // gelogd en geexporteerd, maar filteren zichzelf uit de kalibratie
            // en de gewichten-herijking (zie computeCalibrationMap /
            // recalibrateAdaptiveWeights).
            manual: pos.isManual === true,
            botWouldEnter: pos.botWouldEnter ?? null
        });
        if (learningLog.length > 2000) learningLog = learningLog.slice(-2000);
        recalibrateAdaptiveWeights();
    } else if (!pos.isScalp) {
        // DIAGNOSE: de sessie-export van 12-07 had 42 exits maar een LEGE
        // learningLog - trend-posities zonder factorsAtEntry (bijv. hersteld uit
        // localStorage van een oudere versie) vielen stilzwijgend buiten het
        // leren. Dat mag nooit meer onzichtbaar gebeuren.
        console.warn(`Level 1: trend-positie ${pos.id} gesloten ZONDER factorsAtEntry - deze trade telt niet mee voor adaptief leren.`);
    }

    logBotAction("EXIT", livePrice, pos.side, pnlPct, pos.amount, reason, pnlAmount, pos.notional, pos.isScalp || false);
    savePersistentState();
    updateWalletUI();
    updatePositionLines();
}

// NIVEAU 1 - kalibratie: voor elke factor wordt de groep "factor duidelijk
// aanwezig" (waarde > 1) vergeleken met de groep "factor zwak/afwezig"
// (waarde <= 1) op werkelijke win rate. Is de aanwezige-groep NIET beter
// (of slechter) dan verwacht, dan zakt het gewicht van die factor iets;
// presteert hij duidelijk beter, dan mag het gewicht iets stijgen. Elke
// aanpassing is klein (max 5% per kalibratie) en pas bij >= MIN_SAMPLE_SIZE
// trades PER GROEP - bij te weinig data verandert er bewust niets.
// ============================================================
// EMPIRISCHE KANS-HERKALIBRATIE (15-07)
// De kalibratietabel bewees met n=98 dat de 90-100%-bucket werkelijk 36% wint:
// de score is structureel overmoedig. Deze laag mapt de ruwe score door de
// EIGEN gemeten winrates (monotoon afgedwongen, minimaal 15 trades per bucket,
// minimaal 50 totaal). BEWUST alleen als WEERGAVE-laag: overal waar een kans
// getoond wordt staat de eerlijke waarde erbij als "(kal. X%)". De
// beslisdrempels blijven op de ruwe schaal zodat het gedrag niet stilletjes
// verandert - pas als de mapping stabiel is, is de bewuste tweede stap om de
// poorten op de gekalibreerde schaal te zetten mét opnieuw gekozen drempels.
// ============================================================
// _calibMap is bovenin gedeclareerd (bij de persistente state) - zie de FIX daar.
function computeCalibrationMap() {
    const pts = [];
    const buckets = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
    // Handmatige trades tellen NIET mee: die meten niet of de bot zijn eigen
    // score eerlijk inschat (ander beslisproces, andere momentkeuze).
    const withProb = learningLog.filter(l => l.entryProbabilityPct != null && !l.manual);
    if (withProb.length < 50) { _calibMap = null; return; }
    for (const [lo, hi] of buckets) {
        const inB = withProb.filter(l => l.entryProbabilityPct >= lo && l.entryProbabilityPct < hi);
        if (inB.length >= 15) {
            pts.push([(lo + Math.min(hi, 100)) / 2, inB.filter(l => l.outcome === 'win').length / inB.length * 100]);
        }
    }
    if (pts.length < 2) { _calibMap = null; return; }
    // Monotoon afdwingen (kalibratie mag nooit dalen bij hogere ruwe score)
    for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]);
    _calibMap = pts;
}

function calibrateProbability(raw) {
    if (!_calibMap || raw == null || !isFinite(raw)) return null;
    const pts = _calibMap;
    if (raw <= pts[0][0]) return Math.max(1, (raw / pts[0][0]) * pts[0][1]);
    if (raw >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) {
        if (raw <= pts[i][0]) {
            const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
            return y0 + (raw - x0) / (x1 - x0) * (y1 - y0);
        }
    }
    return pts[pts.length - 1][1];
}

// Compacte weergave-hulp: "94% (kal. 36%)" zodra de mapping actief is.
function formatProbWithCalibration(rawPct) {
    if (rawPct == null || !isFinite(rawPct)) return '\u2014';
    const cal = calibrateProbability(rawPct);
    return cal === null ? formatConfidencePct(rawPct) : `${formatConfidencePct(rawPct)} (kal. ${cal.toFixed(0)}%)`;
}

function recalibrateAdaptiveWeights() {
    computeCalibrationMap();
    const factorKeys = ['confluence', 'nodeInfluence', 'momentumInfluence', 'fibConfluenceInfluence', 'patternInfluence'];
    const weightKeys = { confluence: 'confluence', nodeInfluence: 'nodeInfluence', momentumInfluence: 'momentumInfluence', fibConfluenceInfluence: 'fibConfluence', patternInfluence: 'pattern' };
    const summary = {};

    factorKeys.forEach(fk => {
        // Alleen eigen bot-trades: handmatige entries zijn counterfactuele data
        // en mogen de gewichten niet sturen.
        const botLog = learningLog.filter(l => !l.manual);
        const present = botLog.filter(l => l.factors[fk] !== null && l.factors[fk] > 1);
        const absent = botLog.filter(l => l.factors[fk] !== null && l.factors[fk] <= 1);

        summary[fk] = { nPresent: present.length, nAbsent: absent.length, adjusted: false };

        if (present.length < MIN_SAMPLE_SIZE || absent.length < MIN_SAMPLE_SIZE) return; // te weinig data - niets aanpassen

        const winRatePresent = present.filter(l => l.outcome === 'win').length / present.length;
        const winRateAbsent = absent.filter(l => l.outcome === 'win').length / absent.length;
        summary[fk].winRatePresent = winRatePresent;
        summary[fk].winRateAbsent = winRateAbsent;

        const wKey = weightKeys[fk];
        const diff = winRatePresent - winRateAbsent; // positief = factor werkt zoals bedoeld
        const step = Math.max(-0.05, Math.min(0.05, diff * 0.3)); // kleine, voorzichtige stap
        adaptiveWeights[wKey] = Math.max(0.5, Math.min(1.5, adaptiveWeights[wKey] + step));
        summary[fk].adjusted = true;
        summary[fk].newWeight = adaptiveWeights[wKey];
    });

    lastCalibrationSummary = { timestamp: formatFullDateTime(), summary };
    renderLearningPanel();
}

function isTargetReached(pos) {
    if (!pos.targetPrice || !livePrice) return false;
    return pos.side === 'LONG' ? livePrice >= pos.targetPrice : livePrice <= pos.targetPrice;
}

// Elke seconde: check of een pending order geraakt is door de live prijs.
function checkPendingTriggers() {
    if (pendingOrders.length === 0 || !livePrice) return;
    const now = Date.now();
    let changed = false;

    pendingOrders = pendingOrders.filter(order => {
        if (order.expiresAt && now > order.expiresAt) {
            logBotAction("CANCELLED", order.triggerPrice, order.side, 0, 0, `verlopen (${botSettings.pendingOrderTtlMinutes} min)`);
            changed = true;
            return false;
        }
        const triggered = order.direction === 'below' ? livePrice <= order.triggerPrice
            : order.direction === 'above' ? livePrice >= order.triggerPrice
            : true;
        if (triggered) {
            openPositionFromOrder(order);
            changed = true;
            return false;
        }
        return true;
    });

    if (changed) {
        savePersistentState();
        updatePendingOrdersUI();
    }
}

// Elke seconde: stop-loss (-2%, hard) + de "houden of innen"-beslissing vanaf +2% winst.
function checkOpenPositionsExits() {
    if (openPositions.length === 0 || !livePrice) return;

    const survivors = [];
    openPositions.forEach(pos => {
        const pnlPct = pos.side === 'LONG'
            ? (livePrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - livePrice) / pos.entryPrice;

        // 1. Harde stop-loss: -2% (of, voor een range-scalp, de eigen krappere
        // stop) - niet onderhandelbaar.
        const activeStopLossPct = pos.customStopLossPct ?? botSettings.stopLossPct;
        if (pnlPct <= -activeStopLossPct) {
            closePosition(pos, pnlPct, "STOP_LOSS");
            return;
        }

        // 1b. Piek ALTIJD bijhouden - voorheen gebeurde dit pas boven de
        // profitHoldTriggerPct (2%), waardoor de hele 0.3-0.8%-zone (waar in
        // de praktijk vrijwel alle winnaars leven) geen piekregistratie en
        // dus geen giveback-bescherming had.
        pos.peakPnlPct = Math.max(pos.peakPnlPct || 0, pnlPct);

        // 1c. WINST-BESCHERMING: is de piek ooit boven de activatiedrempel
        // gekomen, sluit dan zodra de P/L onder profitProtectKeepPct% van die
        // piek zakt. Bewust NIET krap afgesteld (zie comment bij de settings):
        // pieken binnen de ruis+kostenband worden met rust gelaten.
        if (!pos.isScalp && (pos.peakPnlPct || 0) >= botSettings.profitProtectActivationPct &&
            pnlPct <= pos.peakPnlPct * (botSettings.profitProtectKeepPct / 100)) {
            closePosition(pos, pnlPct, `PROFIT_PROTECT (piek +${(pos.peakPnlPct * 100).toFixed(2)}%, ${botSettings.profitProtectKeepPct}%-greep)`);
            return;
        }

        // 2. Winst >= 2%: Osiris mag zelf beslissen om te blijven zitten als
        // trend/momentum/kans nog steeds gunstig zijn (evaluateContinuation,
        // drempel = minProbabilityPct, GEEN "ruimte tot doel"-eis meer - die
        // hoort bij nieuwe instappen, niet bij het vasthouden van een
        // al winstgevende positie). Een trailing stop borgt de winst zodat
        // "laten lopen" niet alsnog in een verlies kan eindigen.
        if (pnlPct >= botSettings.profitHoldTriggerPct) {
            pos.peakPnlPct = Math.max(pos.peakPnlPct || 0, pnlPct);
            const floorPct = botSettings.profitHoldTriggerPct - botSettings.trailBufferPct;
            pos.trailingStopPct = Math.max(pos.trailingStopPct ?? floorPct, pos.peakPnlPct - botSettings.trailBufferPct);

            if (pnlPct <= pos.trailingStopPct) {
                closePosition(pos, pnlPct, "TRAILING_STOP");
                return;
            }

            const continuation = evaluateContinuationWithConfirmation(pos, pos.side, botSettings.holdContinuationMinProbabilityPct);
            if (continuation.confirmed) {
                closePosition(pos, pnlPct, "PROFIT_LOCKED");
                return;
            }
            // eligible -> Osiris kiest ervoor de winnaar te laten lopen
            survivors.push(pos);
            return;
        }

        // 3. Onder de 2%-drempel, maar wél in winst: als het doel exact geraakt wordt
        // pakken we het (TARGET). Draait de markttrend ondertussen tegen de positie
        // in - vóórdat de 2%-drempel is gehaald - dan kan Osiris er ook voor kiezen
        // om de kleinere winst te verzilveren i.p.v. te wachten op het volle doel of
        // af te glijden richting de stop-loss. Dit hergebruikt dezelfde
        // continuïteits-check als hierboven, zodat node-timing hier ook meeweegt.
        if (pnlPct > 0 && isTargetReached(pos)) {
            closePosition(pos, pnlPct, "TARGET");
            return;
        }
        if (pnlPct >= botSettings.minProfitForTrendExit) {
            const continuation = evaluateContinuationWithConfirmation(pos, pos.side);
            if (continuation.confirmed) {
                closePosition(pos, pnlPct, "TREND_REVERSAL_EXIT");
                return;
            }
        }

        // 4. Verlies, maar nog boven de harde -2%-stop: als het momentum
        // bevestigt dat de trend TEGEN de positie in blijft gaan (dezelfde
        // continuïteits-check als hierboven, nu in de andere richting), hoeft
        // de bot niet passief te wachten tot de volle -2% bereikt is. Alleen
        // vanaf een kleine ondergrens (minLossForEarlyExit) om niet op elke
        // kleine, ruis-achtige dip te reageren die net zo goed kan herstellen.
        if (pnlPct < 0 && Math.abs(pnlPct) >= botSettings.minLossForEarlyExit) {
            const continuation = evaluateContinuationWithConfirmation(pos, pos.side);
            if (continuation.confirmed) {
                closePosition(pos, pnlPct, "EARLY_STOP_TREND");
                return;
            }
        }

        // 4a-pre. KLEINE-WINST-OOGST: winst boven de kostenband, maar de piek
        // heeft de beschermingsactivatie nooit gehaald, en dat al >= de
        // ingestelde tijd - de Markov-matrix zegt dat doorstoten vanaf hier
        // onwaarschijnlijk is (41% vanuit de kleine-winst-zone). Innen.
        if (!pos.isScalp && botSettings.smallProfitHarvestMinutes > 0) {
            const ageMinH = (Date.now() - (pos.openTime || 0)) / 60000;
            if (pnlPct >= roundTripCostPct() / 100 &&
                (pos.peakPnlPct || 0) < botSettings.profitProtectActivationPct &&
                ageMinH >= botSettings.smallProfitHarvestMinutes) {
                closePosition(pos, pnlPct, `SMALL_PROFIT_HARVEST (+${(pnlPct * 100).toFixed(2)}% na ${ageMinH.toFixed(0)} min - doorstoten statistisch onwaarschijnlijk)`);
                return;
            }
        }

        // 4a-bis. TIJD-STOP: positie hangt na maxPositionAgeMinutes nog binnen
        // de kostenband rond break-even - de these is niet uitgekomen, het
        // kapitaal kan beter opnieuw beoordeeld worden. (Alleen trend-posities;
        // scalps hebben hun eigen krappe doel/stop.)
        if (!pos.isScalp && botSettings.maxPositionAgeMinutes > 0) {
            const ageMin = (Date.now() - (pos.openTime || 0)) / 60000;
            const costBand = roundTripCostPct() / 100;
            if (ageMin >= botSettings.maxPositionAgeMinutes && Math.abs(pnlPct) < costBand) {
                closePosition(pos, pnlPct, `TIME_STOP (${ageMin.toFixed(0)} min rond break-even - these niet uitgekomen)`);
                return;
            }
        }

        // 4b. KANS-COLLAPS: de neutrale zone (tussen de vroege-exit- en
        // trendwinst-drempels) bevroor de bot voorheen volledig, ook als de
        // live winkans voor de eigen kant was ingestort (gezien in de praktijk:
        // "winkans nu ~32% bij entry ~95%", positie bleef gewoon staan). Als de
        // kans onafgebroken >= probCollapseConfirmSeconds onder de drempel
        // blijft, sluiten we - ongeacht in welke micro-zone de P/L toevallig
        // zit. De bevestigingstijd is de geformaliseerde "2-3 candles na een
        // node"-observatie: één slechte meting telt niet, een aanhoudende wel.
        if (!pos.isScalp && botSettings.probCollapseEnabled) {
            const liveProb = smoothProb(pos.side, evaluateContinuation(pos.side).probabilityPct);
            if (liveProb !== null && liveProb <= botSettings.probCollapseThresholdPct) {
                // OMMEKEER-WINSTPAKKER (13-07): staat de positie NA KOSTEN in de
                // winst terwijl de winkans instort, dan is er niets om op te
                // wachten - de 120s-bevestiging is bedoeld om verliezers niet op
                // ruis te dumpen, niet om winnaars hun winst te laten teruggeven
                // aan een gedetecteerde ommekeer. Winst + collaps = direct innen.
                if (pnlPct >= roundTripCostPct() / 100) {
                    closePosition(pos, pnlPct, `PROFIT_PROTECT_REVERSAL (winst veiliggesteld: winkans zakte naar ${liveProb.toFixed(0)}%)`);
                    return;
                }
                if (!pos.probCollapseSince) pos.probCollapseSince = Date.now();
                if ((Date.now() - pos.probCollapseSince) / 1000 >= botSettings.probCollapseConfirmSeconds) {
                    closePosition(pos, pnlPct, `PROB_COLLAPSE_EXIT (winkans ${liveProb.toFixed(0)}% al ${botSettings.probCollapseConfirmSeconds}s onder ${botSettings.probCollapseThresholdPct}%)`);
                    return;
                }
            } else {
                pos.probCollapseSince = null; // kans herstelde - teller reset
            }
        }

        survivors.push(pos);
    });

    openPositions = survivors;
}

// ============================================================
// EXPORT
// ============================================================
function exportBotTradeLog() {
    if (botTradeLog.length === 0) {
        alert("Geen trade data beschikbaar om te exporteren.");
        return;
    }
    const headers = ["Timestamp", "Action", "Price", "Side", "Amount_BTC", "Notional_EUR", "PnL_Percent", "PnL_EUR", "Reason", "Equity"];
    const rows = botTradeLog.map(t => [
        t.timestamp, t.action, t.price, t.side, t.amount, (t.notionalEUR || 0).toFixed(2),
        (t.pnl * 100).toFixed(2), (t.pnlAmount || 0).toFixed(2), t.reason || '', (t.equity || 0).toFixed(2)
    ].join(","));
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "osiris_bot_trade_log.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Eén centrale download-knop: bundelt trade log, systeemlog (vfm/er/db/chaos/
// volume/scores), open posities/pending orders, wallet-status en de volledige
// prijs/volume-historie in één JSON-bestand, zodat je de bot achteraf kunt
// kalibreren met alle data uit de eerste testperiode.
// Losse download van alleen de prijs/volume-historie (CSV), zonder de rest
// van de Download All Data-bundel.
function downloadPriceVolumeHistory() {
    if (!rawData || rawData.length === 0) {
        alert("Geen prijs/volume-data beschikbaar om te exporteren.");
        return;
    }
    const headers = ["Datum/Tijd (UTC)", "Open", "High", "Low", "Close", "Volume"];
    const rows = rawData.map(d => [
        new Date(d[0]).toISOString(), d[1], d[2], d[3], d[4], d[5]
    ].join(","));
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", "osiris_price_volume_history.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Losse download van alleen de huidige bot-instellingen (JSON).
function downloadBotSettings() {
    const payload = {
        exportedAt: new Date().toISOString(),
        botSettings,
        walletCurrency: walletState.currency,
        startingCapital: walletState.startingCapital
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `osiris_bot_settings_${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function downloadAllData() {
    const nodeCtx = getNodeContext();
    const payload = {
        exportedAt: new Date().toISOString(),
        meta: {
            symbol: 'BTCUSDT',
            interval: BOT_INTERVAL, viewInterval: currentInterval,
            anchorTime: new Date(ANCHOR_TIME).toISOString(),
            tPiMinutes: T_PI_MINUTES,
            sessionTransitionsUTC: SESSION_TRANSITIONS_UTC,
            nodeInfluenceWeights: NODE_INFLUENCE_WEIGHTS,
            uiToggleState: { activeFibScales, activeNodeTypes, showPositionLines, uotamHarmonicSetting }
        },
        wallet: {
            startingCapital: walletState.startingCapital,
            realizedPnL: walletState.realizedPnL,
            balance: getBalance(),
            equity: getEquity(),
            unrealizedPnL: getUnrealizedPnL(),
            allocatedPct: getAllocatedPct(),
            wins: walletState.wins,
            losses: walletState.losses
        },
        botSettings,
        // Live snapshot van alle kernindicatoren op het exportmoment
        liveSnapshot: {
            timestamp: new Date().toISOString(),
            livePrice, liveVol, vfm, er, db, chaos, isBullish,
            nodeContext: nodeCtx,
            nodeInfluence: calculateNodeInfluence(nodeCtx),
            momentumContext: getMomentumContext(),
            volumeShiftPct: calculateVolumeShift(6),
            movingAverage20: getCurrentMAValue(),
            maValues: getCurrentMAValues(),
            rsi14: getCurrentRSIValue(),
            rsiSettings: { period: rsiPeriod, overbought: rsiOverbought, oversold: rsiOversold },
            linearPrediction: computeLinearPrediction(predictionHorizonMinutes),
            fibConfluenceInfluence: calculateFibConfluenceInfluence(livePrice)
        },
        // De echte MIC/MES/MAC fib-niveaus zoals ook op de chart getekend worden
        currentFibLevels,
        // Wanneer welke instellingen actief werden (START/STOP/SETTINGS_UPDATED) -
        // gebruik dit om de trade log te segmenteren per configuratie, ook als
        // je tussendoor live hebt bijgewerkt i.p.v. Reset Wallet gebruikt.
        sessionLog,
        // NIVEAU 1: leer-log (elke afgesloten trend-trade + factoren + uitkomst)
        // en de huidige adaptieve gewichten - dit is de basis voor toekomstige
        // kalibratie-analyse buiten de app om, mocht je dat willen.
        learningLog,
        adaptiveWeights,
        // Meest recente volledige Osiris-beslissing (targets, confluence, status, momentum)
        lastDecision: lastOsirisDecision,
        lastVolumeMetrics: lastOsirisMetrics,
        openPositions,
        pendingOrders,
        tradeLog: botTradeLog, // elke ENTRY/EXIT/PENDING/CANCELLED/SKIPPED actie, met €-bedragen en volledige datum/tijd
        systemLog: osirisSystemLog, // vfm/er/db/chaos/volume/scores/targets/node/sessie/momentum - elke 10s
        // Rauwe geheugen-buffer (iets ruwer dan systemLog, elke 10s, tot 500 samples terug)
        metricsHistory,
        // Volledige node-grid zoals gebruikt voor de chart-Fib-lijnen (zie §6 van het rekendocument)
        allNodes,
        priceVolumeHistory: rawData.map(d => ({
            time: new Date(d[0]).toISOString(),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }))
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `osiris_full_export_${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ============================================================
// HEARTBEAT
// ============================================================
// Globale variabele om de 10-seconden cyclus bij te houden
let botTickCounter = 0;

function botHeartbeat() {
    // 1. Runtime UI Update (elke seconde)
    if (botStartTime) {
        const diff = Date.now() - botStartTime;
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');

        const runtimeEl = document.getElementById('bot-runtime');
        if (runtimeEl) runtimeEl.innerText = `Runtime: ${h}:${m}:${s}  (gestart: ${formatFullDateTime(botStartTime)})`;
    }

    if (!botSettings.isRunning) {
        updateWalletUI();
        return;
    }

    // 2. Elke seconde: reageer direct op prijsbewegingen
    //    (pending orders raken, stop-loss/trailing-stop/hold-beslissing)
    checkPendingTriggers();
    checkOpenPositionsExits();
    updateWalletUI();

    // 3. Elke 10 seconden: zwaardere Osiris-berekening + scan naar nieuwe kansen
    botTickCounter++;
    if (botTickCounter >= 10) {
        botTickCounter = 0;

        // Geheugen bijwerken vóór de scan, zodat getMomentumContext() hierbinnen
        // de meest recente sample al meeneemt.
        recordMetricsSnapshot();

        const metrics = calculateVolumeMetrics(liveVol, db, isBullish, 9);
        const decision = getOrisisDecisionData(metrics, livePrice, vfm, er, db, chaos, isBullish);

        lastOsirisDecision = decision;
        lastOsirisMetrics = metrics;

        logSystemState(metrics, decision.targets, livePrice, liveVol, chaos, db, isBullish);

        scanForOpportunities(decision, metrics);
        scanForRangeScalps();
        renderMovingAverage();
        renderRSI();
        renderPrediction();
        renderPatternMarkers();
        updatePatternStructureCard();
    }
}


function setHarmonic(value) {
    uotamHarmonicSetting = value;
    
    // Visuele feedback op de knoppen (optional)
    document.querySelectorAll('.harmonic-selector button').forEach(btn => btn.style.opacity = '0.5');
    document.getElementById(`btn-${value}`).style.opacity = '1';
    
    // Herteken de lijnen direct
    if (typeof allNodes !== 'undefined') {
        updateActiveNodeFibLines(allNodes, uotamHarmonicSetting);
    }
    console.log("Lens gewijzigd naar:", value);
}

// --- DYNAMISCH TIMEFRAME WISSELEN (view-only; raakt de bot NIET) ---
const VIEW_INTERVALS = ['1m', '15m', '30m', '45m', '1h', '4h'];

function intervalToSec(iv) {
    const map = { '1m': 60, '15m': 900, '30m': 1800, '45m': 2700, '1h': 3600, '4h': 14400, '1d': 86400 };
    return map[iv] || 900;
}

// 45m is geen Binance-interval: we aggregeren 3x 15m-candles tot één 45m-candle.
function aggregate15mTo45m(klines15m) {
    const out = [];
    for (const k of klines15m) {
        const t = Math.floor(k[0] / 2700000) * 2700000; // 45m-bucket
        const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
        const last = out[out.length - 1];
        if (last && last[0] === t) {
            last[2] = String(Math.max(parseFloat(last[2]), h));
            last[3] = String(Math.min(parseFloat(last[3]), l));
            last[4] = String(c);
            last[5] = String(parseFloat(last[5]) + v);
        } else {
            out.push([t, String(o), String(h), String(l), String(c), String(v)]);
        }
    }
    return out;
}

async function fetchViewKlines(iv) {
    if (iv === BOT_INTERVAL && rawData && rawData.length) return rawData; // zelfde data, geen extra fetch
    if (iv === '45m') {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000`);
        return aggregate15mTo45m(await r.json());
    }
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=672`);
    return r.json();
}

// ============================================================
// SESSION VOLUME PROFILE (SVP) + ORDER BOOK DEPTH
// ============================================================
// SVP: verdeelt het WERKELIJK VERHANDELDE volume van elke candle over de
// prijs-bins die de candle raakte (high..low), en telt op over alle candles.
// Levert per prijsniveau hoeveel er is verhandeld -> waar kopers/verkopers zich
// echt hebben verzameld. De drukste bin is de POC (Point of Control); de zone
// eromheen die 70% van het volume bevat is de Value Area (VAH..VAL).
// Dit is een betrouwbare, kosteloze bot-parameter: prijs neigt terug te keren
// naar de POC, en value-area-randen werken als support/resistance.
let _volumeProfile = null;   // { bins:[{price,buy,sell,total}], poc, vah, val, binSize, maxTotal }
const VP_BINS = 60;          // aantal prijs-bins in het profiel

function computeVolumeProfile(klines) {
    if (!klines || klines.length < 10) return null;
    let hi = -Infinity, lo = Infinity;
    for (const k of klines) { const h = +k[2], l = +k[3]; if (h > hi) hi = h; if (l < lo) lo = l; }
    if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return null;
    const binSize = (hi - lo) / VP_BINS;
    const bins = Array.from({ length: VP_BINS }, (_, i) => ({ price: lo + (i + 0.5) * binSize, buy: 0, sell: 0, total: 0 }));
    for (const k of klines) {
        const o = +k[1], h = +k[2], l = +k[3], c = +k[4], v = +k[5];
        if (!isFinite(v) || v <= 0 || h <= l) continue;
        // candle-volume evenredig verdelen over de bins die hij overspant
        const loB = Math.max(0, Math.floor((l - lo) / binSize));
        const hiB = Math.min(VP_BINS - 1, Math.floor((h - lo) / binSize));
        const span = hiB - loB + 1;
        const perBin = v / span;
        // koop/verkoop-schatting: groene candle (c>=o) telt als buy-volume, rood als sell
        const isBuy = c >= o;
        for (let b = loB; b <= hiB; b++) {
            bins[b].total += perBin;
            if (isBuy) bins[b].buy += perBin; else bins[b].sell += perBin;
        }
    }
    // POC = bin met het hoogste totaal
    let pocIdx = 0, maxTotal = 0;
    bins.forEach((b, i) => { if (b.total > maxTotal) { maxTotal = b.total; pocIdx = i; } });
    // Value Area: groei vanaf POC tot 70% van het totale volume is bereikt
    const totalVol = bins.reduce((s, b) => s + b.total, 0);
    const target = totalVol * 0.7;
    let lo2 = pocIdx, hi2 = pocIdx, acc = bins[pocIdx].total;
    while (acc < target && (lo2 > 0 || hi2 < VP_BINS - 1)) {
        const below = lo2 > 0 ? bins[lo2 - 1].total : -1;
        const above = hi2 < VP_BINS - 1 ? bins[hi2 + 1].total : -1;
        if (above >= below) { hi2++; acc += bins[hi2].total; } else { lo2--; acc += bins[lo2].total; }
    }
    return {
        bins, binSize, maxTotal, totalVol,
        poc: bins[pocIdx].price,
        vah: bins[hi2].price,   // Value Area High
        val: bins[lo2].price,   // Value Area Low
    };
}

// Order Book Depth: haalt de VOLLEDIGE order book op (tot 1000 niveaus) en
// aggregeert bids/asks in prijs-bins -> toont wachtende limietorders (COB).
// Let op: order-book-muren zijn context, geen hard signaal (spoofing komt voor).
let _orderBookDepth = null;  // { bins:[{price,bid,ask}], maxSize, mid }
async function fetchOrderBookDepth() {
    try {
        const r = await fetch('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=1000');
        const ob = await r.json();
        if (!ob.bids || !ob.asks) return null;
        const bids = ob.bids.map(([p, q]) => [+p, +q]);
        const asks = ob.asks.map(([p, q]) => [+p, +q]);
        const mid = (bids[0][0] + asks[0][0]) / 2;
        const allP = [...bids, ...asks];
        let hi = -Infinity, lo = Infinity;
        for (const [p] of allP) { if (p > hi) hi = p; if (p < lo) lo = p; }
        const binSize = (hi - lo) / VP_BINS;
        if (binSize <= 0) return null;
        const bins = Array.from({ length: VP_BINS }, (_, i) => ({ price: lo + (i + 0.5) * binSize, bid: 0, ask: 0 }));
        for (const [p, q] of bids) { const b = Math.min(VP_BINS - 1, Math.max(0, Math.floor((p - lo) / binSize))); bins[b].bid += q; }
        for (const [p, q] of asks) { const b = Math.min(VP_BINS - 1, Math.max(0, Math.floor((p - lo) / binSize))); bins[b].ask += q; }
        let maxSize = 0; bins.forEach(b => { maxSize = Math.max(maxSize, b.bid, b.ask); });
        _orderBookDepth = { bins, maxSize, mid, binSize };
        return _orderBookDepth;
    } catch (e) { console.warn('Order book depth fetch faalde:', e); return null; }
}

// Bot-parameter: hoe ver zit de huidige prijs van de POC en value-area-randen?
// Geeft een genormaliseerde score (-1..1): positief = prijs onder value area
// (koopdruk-zone eronder), negatief = boven. Wordt in de confluence meegewogen.
function volumeProfileBias(price) {
    if (!_volumeProfile || !isFinite(price)) return { bias: 0, note: 'geen profiel' };
    const { poc, vah, val } = _volumeProfile;
    if (price < val) return { bias: +0.5, note: `onder value area (VAL ${val.toFixed(0)})` };
    if (price > vah) return { bias: -0.5, note: `boven value area (VAH ${vah.toFixed(0)})` };
    const range = vah - val;
    const bias = range > 0 ? (poc - price) / range * 0.3 : 0;
    return { bias, note: `binnen value area, POC ${poc.toFixed(0)}` };
}

let _depthMode = 'svp';   // 'svp' = volume profile | 'cob' = order book
function setDepthMode(m) {
    _depthMode = m;
    const svpBtn = document.getElementById('vp-tab-svp'), cobBtn = document.getElementById('vp-tab-cob');
    if (svpBtn) { svpBtn.style.color = m === 'svp' ? 'var(--teal)' : 'var(--dim)'; svpBtn.style.borderColor = m === 'svp' ? 'rgba(20,241,149,0.4)' : 'var(--dimmer)'; }
    if (cobBtn) { cobBtn.style.color = m === 'cob' ? 'var(--amber)' : 'var(--dim)'; cobBtn.style.borderColor = m === 'cob' ? 'rgba(255,182,39,0.4)' : 'var(--dimmer)'; }
    if (m === 'cob') fetchOrderBookDepth().then(renderDepthPanel);
    else renderDepthPanel();
}

function renderDepthPanel() {
    const cv = document.getElementById('vp-canvas');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const W = cv.width = Math.max(120, rect.width), H = cv.height = Math.max(300, rect.height);
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const legend = document.getElementById('vp-legend');
    const price = (typeof livePrice !== 'undefined' && livePrice > 0) ? livePrice : null;

    if (_depthMode === 'svp') {
        const vp = _volumeProfile;
        if (!vp) { if (legend) legend.textContent = 'Wacht op chartdata...'; return; }
        const bins = vp.bins, n = bins.length, bh = H / n;
        const priceToY = p => H - ((p - bins[0].price) / (bins[n - 1].price - bins[0].price)) * H;
        bins.forEach((b, i) => {
            const y = H - (i + 1) * bh;
            // buy-deel groen (links), sell-deel rood (rechts vanaf midden) - hier gestapeld naar rechts
            const buyW = (b.buy / vp.maxTotal) * W;
            const sellW = (b.sell / vp.maxTotal) * W;
            ctx.fillStyle = 'rgba(20,241,149,0.55)'; ctx.fillRect(0, y + 0.5, buyW, bh - 1);
            ctx.fillStyle = 'rgba(255,95,126,0.55)'; ctx.fillRect(buyW, y + 0.5, sellW, bh - 1);
        });
        // Value Area-band
        const yVAH = priceToY(vp.vah), yVAL = priceToY(vp.val);
        ctx.fillStyle = 'rgba(0,217,255,0.06)'; ctx.fillRect(0, yVAH, W, yVAL - yVAH);
        ctx.strokeStyle = 'rgba(0,217,255,0.3)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, yVAH); ctx.lineTo(W, yVAH); ctx.moveTo(0, yVAL); ctx.lineTo(W, yVAL); ctx.stroke();
        // POC-lijn (amber)
        const yPOC = priceToY(vp.poc);
        ctx.strokeStyle = '#ffb627'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, yPOC); ctx.lineTo(W, yPOC); ctx.stroke();
        // huidige prijs (wit)
        if (price) { const yP = priceToY(price); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(0, yP); ctx.lineTo(W, yP); ctx.stroke(); ctx.setLineDash([]); }
        if (legend) {
            const bias = price ? volumeProfileBias(price) : { note: '' };
            legend.innerHTML = `<span style="color:#ffb627;">POC ${vp.poc.toFixed(0)}</span> &middot; VA ${vp.val.toFixed(0)}-${vp.vah.toFixed(0)}<br><span style="color:var(--dimmer);">${bias.note}</span>`;
        }
    } else {
        const ob = _orderBookDepth;
        if (!ob) { if (legend) legend.textContent = 'Order book laden...'; return; }
        const bins = ob.bins, n = bins.length, bh = H / n;
        const priceToY = p => H - ((p - bins[0].price) / (bins[n - 1].price - bins[0].price)) * H;
        bins.forEach((b, i) => {
            const y = H - (i + 1) * bh;
            const bidW = (b.bid / ob.maxSize) * W;
            const askW = (b.ask / ob.maxSize) * W;
            ctx.fillStyle = 'rgba(20,241,149,0.55)'; ctx.fillRect(0, y + 0.5, bidW, bh - 1);
            ctx.fillStyle = 'rgba(255,95,126,0.55)'; ctx.fillRect(bidW, y + 0.5, askW, bh - 1);
        });
        if (ob.mid) { const yM = priceToY(ob.mid); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(0, yM); ctx.lineTo(W, yM); ctx.stroke(); ctx.setLineDash([]); }
        // grootste muur markeren
        let wallIdx = 0, wallSz = 0, wallSide = '';
        bins.forEach((b, i) => { if (b.bid > wallSz) { wallSz = b.bid; wallIdx = i; wallSide = 'bid'; } if (b.ask > wallSz) { wallSz = b.ask; wallIdx = i; wallSide = 'ask'; } });
        if (legend) legend.innerHTML = `<span style="color:${wallSide === 'bid' ? 'var(--teal)' : 'var(--red)'};">Grootste muur ${bins[wallIdx].price.toFixed(0)}</span><br><span style="color:var(--dimmer);">${wallSide === 'bid' ? 'koop' : 'verkoop'}-wand &middot; ${wallSz.toFixed(1)} BTC</span>`;
    }
}

// Live 45m-bucket bijwerken vanuit de 15m bot-stream (geen aparte socket nodig).
let _current45m = null;
function update45mBucketFromLive(candle15m) {
    const t = Math.floor(candle15m.t / 2700000) * 2700000;
    const h = parseFloat(candle15m.h), l = parseFloat(candle15m.l), c = parseFloat(candle15m.c), o = parseFloat(candle15m.o);
    if (!_current45m || _current45m.t !== t) {
        _current45m = { t, open: o, high: h, low: l, close: c };
    } else {
        _current45m.high = Math.max(_current45m.high, h);
        _current45m.low = Math.min(_current45m.low, l);
        _current45m.close = c;
    }
    candlestickSeries.update({ time: t / 1000, open: _current45m.open, high: _current45m.high, low: _current45m.low, close: _current45m.close });
}

// Aparte, view-gebonden stream voor chart-updates op niet-15m intervallen.
// (45m loopt via de 15m bot-stream; 15m zelf ook - dan is deze socket dicht.)
function startChartStream(iv) {
    if (viewWs) { try { viewWs.close(); } catch (e) {} viewWs = null; }
    if (iv === BOT_INTERVAL || iv === '45m') return;
    viewWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${iv}`);
    viewWs.onmessage = (event) => {
        try {
            const k = JSON.parse(event.data).k;
            if (!k) return;
            candlestickSeries.update({ time: k.t / 1000, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) });
        } catch (e) { /* view-stream mag nooit de bot raken */ }
    };
}

// Node-marker-dichtheid per view: op hogere timeframes passen er meerdere
// nodes in één candle - zonder filter krijgt elke 4h-candle een stapel labels.
// Regels: 1m/15m tonen alles; 30m/45m/1h alleen de CORE-types; 4h+ alleen de
// zwaarste (VORTEX/RESET). Daarbovenop: max één label per candle, de
// belangrijkste wint (VOLA > VORTEX6 > VORTEX3 > RESET > MIDPULSE > OSC).
function filterMarkersForView(markers, iv) {
    const allowed = (iv === '1m' || iv === '15m') ? null
        : (iv === '4h' || iv === '1d') ? ['VOLA', 'VORTEX', 'RESET']
        : ['VOLA', 'VORTEX', 'RESET', 'CORE'];
    const prio = { VOLA: 6, VORTEX: 5, RESET: 4, CORE: 3, MIDPULSE: 2, OSC: 1 };
    const keyOf = (m) => (m.nodeTypeKey || '').startsWith('VORTEX') ? 'VORTEX' : (m.nodeTypeKey || 'OSC');
    let out = allowed ? markers.filter(m => allowed.includes(keyOf(m))) : markers.slice();
    const perCandle = new Map();
    for (const m of out) {
        const cur = perCandle.get(m.time);
        if (!cur || (prio[keyOf(m)] || 0) > (prio[keyOf(cur)] || 0)) perCandle.set(m.time, m);
    }
    return [...perCandle.values()].sort((a, b) => a.time - b.time);
}

async function changeTimeframe(interval) {
    if (!VIEW_INTERVALS.includes(interval)) return;
    currentInterval = interval;
    VIEW_INTERVALS.forEach(iv => {
        const b = document.getElementById(`btn-${iv}`);
        if (b) {
            const actief = iv === interval;
            b.style.background = actief ? 'var(--teal, #00ffcc)' : '';
            b.style.color = actief ? '#04060a' : '';
            b.style.fontWeight = actief ? 'bold' : '';
        }
    });
    await refreshViewData();
}

// Ververst UITSLUITEND de chart-weergave: candles, MA/RSI, patroon-markers en
// node-markers op het gekozen view-interval. rawData (bot, 15m) blijft
// onaangeroerd; fib-PRIJSNIVEAUS komen van de bot en zijn op elke view geldig.
async function refreshViewData() {
    try {
        _current45m = null;
        viewData = await fetchViewKlines(currentInterval);
        const chartData = viewData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        candlestickSeries.setData(chartData);
        _volumeProfile = computeVolumeProfile(viewData);
        if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
        updateHistoryList(viewData);
        applyUOTAMGrid(chartData, { updateTrading: false, viewInterval: currentInterval });
        renderMovingAverage();
        renderRSI();
        renderPatternMarkers();
        startChartStream(currentInterval);
    } catch (e) {
        console.error('View-wissel mislukt:', e);
    }
}

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        setChartMarkers([]);

        // 1. BOT-DATA: altijd 672 x 15m spot-candles (7 dagen) - de vaste basis
        // voor alle handelslogica (structuur, meters, nodes, fib), ongeacht
        // welke view de chart toont.
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${BOT_INTERVAL}&limit=672`);
        rawData = await response.json();

        // 2. TRADING-instrumenten op de bot-data: nodes + fib-niveaus.
        const botChartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        applyUOTAMGrid(botChartData, { updateTrading: true, display: currentInterval === BOT_INTERVAL, viewInterval: currentInterval });

        // 3. VIEW: chart, historie, MA/RSI, patroon- en node-markers op het
        // gekozen weergave-interval (bij 15m identiek aan de bot-data).
        viewData = await fetchViewKlines(currentInterval);
        const chartData = viewData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        candlestickSeries.setData(chartData);
        _volumeProfile = computeVolumeProfile(viewData);
        if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
        updateHistoryList(viewData);
        if (currentInterval !== BOT_INTERVAL) {
            applyUOTAMGrid(chartData, { updateTrading: false, viewInterval: currentInterval });
        }
        renderMovingAverage();
        renderRSI();
        renderPatternMarkers();
        startLiveUpdates();
        startChartStream(currentInterval);
        startSentimentStream();
        
    } catch (error) {
        console.error("Fout bij het laden van de data:", error);
    }
}

// --- VFM Module: Berekening van het Momentum ---
function calculateVFM(currentPrice, currentVolume, historyData) {
    // 1. SMA20 (Volume)
    // Neem de laatste 20 candles uit de historie
    const last20Volumes = historyData.slice(-20).map(d => parseFloat(d[5])); // d[5] is volume
    const sma20Volume = last20Volumes.reduce((a, b) => a + b, 0) / 20;

    // 2. Energy Ratio (ER)
    const er = currentVolume / sma20Volume;

    // 3. Delta Balance (DB)
    // Formule: (2 * Close - (High + Low)) / (High - Low)
    // We gebruiken de huidige candle (laatste uit historyData) als referentie
    const currentCandle = historyData[historyData.length - 1];
    const high = parseFloat(currentCandle[2]);
    const low = parseFloat(currentCandle[3]);
    const db = (2 * currentPrice - (high + low)) / (high - low);

    // 4. VFM
    return er * db;
}

// --- LIVE KLOK BEREKENING ---
function updateInfoPanel() {
    const now = Date.now();
    
    const formatDateTime = (ms) => {
        const d = new Date(ms);
        return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    };

    const formatCountdown = (ms) => {
        const diff = ms - now;
        if (diff <= 0) return "00:00:00";
        const totalSeconds = Math.floor(diff / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    // Bereken huidige absolute node
    const currentAbsoluteNode = Math.floor((now - ANCHOR_TIME) / T_PI_MS);
    
    const nodes = [
        { id: 'next-reset', targets: [0] },
        { id: 'next-vola',  targets: [1] },
        { id: 'next-core',  targets: [3, 6] },
        { id: 'next-osc',   targets: [2, 4, 5, 7] }
    ];

    nodes.forEach(n => {
        const el = document.getElementById(n.id);
        if (!el) return;

        // Start zoeken bij de huidige node + 1 om altijd in de toekomst te kijken
        let candidate = currentAbsoluteNode + 1;
        
        // Loop totdat we een node vinden die in de target-lijst staat
        // We begrenzen dit op +20 nodes vooruit om oneindige loops te voorkomen
        let maxSearch = currentAbsoluteNode + 20; 
        while (!n.targets.includes(((candidate % 8) + 8) % 8) && candidate < maxSearch) {
            candidate++;
        }
        
        const targetTime = ANCHOR_TIME + (candidate * T_PI_MS);
        el.innerText = `${formatDateTime(targetTime)} (${formatCountdown(targetTime)})`;
    });
    // 2. NIEUWE LOGICA: Mid Pulse en Next Node (Type + Countdown)
    
    // Mid Pulse: Zoek de eerste 'mid_'-node in allNodes die nog moet komen
    // Mid Pulse: Zoek de eerste 'mid_'-node in de toekomst
   // Mid Pulse: Bereken altijd de eerstvolgende mid-pulse op basis van tijd
    const midPulseEl = document.getElementById('mid-pulse-display');
    if (midPulseEl) {
        // We weten dat een node T_PI_MS duurt. Een mid-pulse is op exact +0.5 node afstand.
        const now = Date.now();
        const timeSinceAnchor = now - ANCHOR_TIME;
        
        // Bereken de index van de huidige cyclus (bijv. 120.4)
        const currentIndex = timeSinceAnchor / T_PI_MS;
        
        // De volgende mid-pulse is de eerstvolgende 'X.5' waarde
        // We pakken de floor van de index, en tellen daar 0.5 bij op
        const nextMidIndex = Math.floor(currentIndex) + 0.5;
        
        // Als we al voorbij de 0.5 zijn, moeten we naar de volgende node (X+1.5)
        let targetMidIndex = nextMidIndex;
        if (targetMidIndex * T_PI_MS < timeSinceAnchor) {
            targetMidIndex += 1;
        }
        
        const nextMidTime = ANCHOR_TIME + (targetMidIndex * T_PI_MS);
        midPulseEl.innerText = `${formatDateTime(nextMidTime)} (${formatCountdown(nextMidTime)})`;
    }

    // Next Node: De absolute eerstvolgende node (Reset/Vola/Vortex/etc)
    const nextNodeEl = document.getElementById('next-node-display');
    if (nextNodeEl) {
        const nextIdx = currentAbsoluteNode + 1;
        const nextTime = ANCHOR_TIME + (nextIdx * T_PI_MS);
        
        let relIdx = ((nextIdx % 8) + 8) % 8;
        let type = ['RESET', 'VOLA', 'OSC', 'VORTEX 3', 'OSC', 'OSC', 'VORTEX 6', 'OSC'][relIdx];
        
        nextNodeEl.innerText = `${formatDateTime(nextTime)} (${formatCountdown(nextTime)}) | ${type}`;
    }
}

function updateSentimentBar(obi) {
    const barGreen = document.getElementById('sentiment-bar-green');
    const barRed = document.getElementById('sentiment-bar-red');
    if (!barGreen || !barRed) return;

    // OBI waarde tussen -1 en 1
    // 0 = 50% groen, 50% rood
    // 1 = 100% groen, 0% rood
    // -1 = 0% groen, 100% rood
    
    const greenWidth = ((obi + 1) / 2) * 100;
    const redWidth = 100 - greenWidth;

    barGreen.style.width = `${greenWidth}%`;
    barRed.style.width = `${redWidth}%`;
    _lastBuyersPct = greenWidth;
}

// Buyers-ratio (0..100) voor de oog-sentimentkleuring. Leest de laatst berekende
// order-book-imbalance; valt terug op 50 (neutraal) als er nog geen data is.
let _lastBuyersPct = 50;
function getMarketSentiment() { return _lastBuyersPct; }

// ============================================================
// NODE CONTEXT & INVLOED OP DE BOT
// ============================================================
// Primaire nodes staan op integer n (t_n = ANCHOR_TIME + n*T_PI_MS), mid-pulses
// op n+0.5. Samen liggen ze dus evenredig verdeeld op halve stappen van T_PI_MS.
// k = index in halve stappen: even k = primaire node (n = k/2), oneven k = mid-pulse.
function nodeTypeForHalfStepIndex(k) {
    const isMidPulse = (((k % 2) + 2) % 2) === 1;
    if (isMidPulse) return 'MIDPULSE';
    const n = k / 2;
    const rel = ((n % 8) + 8) % 8;
    if (rel === 0) return 'RESET';
    if (rel === 1) return 'VOLA';
    if (rel === 3) return 'VORTEX3';
    if (rel === 6) return 'VORTEX6';
    return 'OSC';
}

// Geeft de meest recent gepasseerde node en de eerstvolgende node terug, elk met
// hun type, tijd (in minuten) sinds/tot dat moment, én de absolute timestamp
// (nodig om sessie-overlap op het node-moment zelf te checken, niet op "nu").
// Het venster tussen "last" en "next" is precies één halve T_PI-cyclus (~94.33
// min) - dat is het volledige venster waarbinnen een node nog relevant is.
function getNodeContext(now = Date.now()) {
    const HALF_MS = T_PI_MS / 2;
    const kRaw = (now - ANCHOR_TIME) / HALF_MS;
    const kPrev = Math.floor(kRaw);
    const kNext = Math.ceil(kRaw);
    const prevTime = ANCHOR_TIME + kPrev * HALF_MS;
    const nextTime = ANCHOR_TIME + kNext * HALF_MS;
    return {
        lastNode: { type: nodeTypeForHalfStepIndex(kPrev), time: prevTime, minutesAgo: Math.max(0, (now - prevTime) / 60000) },
        nextNode: { type: nodeTypeForHalfStepIndex(kNext), time: nextTime, minutesUntil: Math.max(0, (nextTime - now) / 60000) }
    };
}

// ============================================================
// GEHEUGEN: rolling history van vfm/er/db/chaos/volume/prijs
// ============================================================
// Osiris kon voorheen alleen het huidige moment zien. Deze buffer onthoudt de
// laatste N samples (1 per 10s-scan, dus ~500 samples = ruim 80 minuten) zodat
// de bot kan redeneren over VERANDERINGEN (stijgt vfm? droogt volume op?)
// i.p.v. alleen een losse snapshot.
let metricsHistory = [];
const METRICS_HISTORY_MAX = 500;

let _lastSnapVol = 0;
let _lastSnapCandleBucket = 0;
function recordMetricsSnapshot() {
    // METER-FIX (13-07): liveVol is een OPLOPENDE teller binnen de candle -
    // volumeShift op de ruwe teller was daardoor vrijwel altijd positief
    // (recent > eerder, per definitie), wat MIDPULSE-nodes kunstmatig een
    // positief gewicht gaf. We slaan nu de INSTROOM per snapshot op (volRate):
    // het verschil sinds de vorige meting, met candle-reset-detectie.
    const bucket = Math.floor(Date.now() / BOT_INTERVAL_MS);
    const volRate = (bucket === _lastSnapCandleBucket && liveVol >= _lastSnapVol)
        ? liveVol - _lastSnapVol
        : liveVol; // nieuwe candle (of reset): alles sinds candle-opening
    _lastSnapVol = liveVol;
    _lastSnapCandleBucket = bucket;
    metricsHistory.push({
        timestamp: Date.now(),
        price: livePrice,
        vfm, er, db, chaos,
        liveVol,
        volRate,
        isBullish
    });
    if (metricsHistory.length > METRICS_HISTORY_MAX) metricsHistory.shift();
}

// Vergelijkt het gemiddelde volume van de laatste `lookback` samples met het
// gemiddelde van de `lookback` samples daarvóór - een simpele, robuuste manier
// om te zien of er rond dit moment een volume-verschuiving gaande is, zonder
// afhankelijk te zijn van een node-type. Dit is precies wat OSC/MIDPULSE-nodes
// nu gebruiken (zie calculateNodeInfluence) in plaats van een vaste 0-waarde.
function calculateVolumeShift(lookback = 6) {
    if (metricsHistory.length < lookback * 2) return 0;
    const recent = metricsHistory.slice(-lookback);
    const prior = metricsHistory.slice(-lookback * 2, -lookback);
    const avgRecent = recent.reduce((a, m) => a + (m.volRate ?? 0), 0) / recent.length;
    const avgPrior = prior.reduce((a, m) => a + (m.volRate ?? 0), 0) / prior.length;
    if (avgPrior === 0) return 0;
    return ((avgRecent - avgPrior) / avgPrior) * 100; // % verschuiving
}

// Redeneert over de recente geschiedenis: hoeveel opeenvolgende samples waren
// bullish/bearish (trend-aanhoudendheid), is de prijs-range aan het
// samendrukken (consolidatie-signaal), en stijgt/daalt vfm. Wordt gebruikt
// voor zowel de probability score als de gegradeerde market-status (§ verderop).
function getMomentumContext(lookback = 6) {
    if (metricsHistory.length < lookback) {
        return { consecutiveBullish: 0, consecutiveBearish: 0, rangeCompressed: false, rangePct: null, vfmTrend: 'flat' };
    }
    const recent = metricsHistory.slice(-lookback);

    let bullStreak = 0, bearStreak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].isBullish) {
            if (bearStreak > 0) break;
            bullStreak++;
        } else {
            if (bullStreak > 0) break;
            bearStreak++;
        }
    }

    const prices = recent.map(m => m.price).filter(p => p > 0);
    let rangeCompressed = false, rangePct = null;
    if (prices.length >= 2) {
        const range = Math.max(...prices) - Math.min(...prices);
        rangePct = (range / prices[0]) * 100;
        rangeCompressed = rangePct < 0.15; // < 0.15% beweging over de lookback = zijwaarts
    }

    const vfmVals = recent.map(m => m.vfm);
    const vfmDelta = vfmVals[vfmVals.length - 1] - vfmVals[0];
    const vfmTrend = Math.abs(vfmDelta) < 0.05 ? 'flat' : (vfmDelta > 0 ? 'rising' : 'falling');

    return { consecutiveBullish: bullStreak, consecutiveBearish: bearStreak, rangeCompressed, rangePct, vfmTrend };
}

// ============================================================
// MARKT-SESSIES (Azië / Europa / VS) - benaderende UTC-tijden
// ============================================================
// UOTAM §3 noemt zelf de "geografische overdracht van liquiditeit (Azië →
// Europa → VS)" als verklaring voor waarom de cyclus werkt. Crypto handelt
// 24/7 dus er is geen letterlijke open/close, maar deze tijden zijn de
// gangbare conventie voor waar doorgaans de liquiditeit merkbaar verschuift.
const SESSION_TRANSITIONS_UTC = [
    { name: 'ASIA_OPEN', minuteOfDay: 0 * 60 },
    { name: 'EU_OPEN', minuteOfDay: 8 * 60 },
    { name: 'US_OPEN', minuteOfDay: 13 * 60 },
    { name: 'US_CLOSE', minuteOfDay: 22 * 60 },
];

function getSessionContext(timestamp) {
    const d = new Date(timestamp);
    const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    let closest = null, minDist = Infinity;
    SESSION_TRANSITIONS_UTC.forEach(s => {
        let dist = Math.abs(minuteOfDay - s.minuteOfDay);
        dist = Math.min(dist, 1440 - dist); // cirkelvormig (23:50 ligt dicht bij 00:00)
        if (dist < minDist) { minDist = dist; closest = s.name; }
    });
    return { nearestSession: closest, minutesFromTransition: minDist };
}

// Hoeveel een sessie-overlap bijdraagt: max +6, lineair aflopend tot 0 op ±60 min.
function calculateSessionInfluence(timestamp) {
    const windowMinutes = 60;
    const ctx = getSessionContext(timestamp);
    const weight = Math.max(0, 1 - (ctx.minutesFromTransition / windowMinutes));
    return weight * 6;
}

// Node-gewichten: hoeveel elk node-type de probability score / sizing
// beïnvloedt. VOLA = oplopende volatiliteit verwacht -> hogere kans. RESET =
// mogelijk omslagpunt -> voorzichtiger. CORE (Vortex 3/6) = trend-bevestiging
// -> hogere kans. OSC/MIDPULSE hebben GEEN vast gewicht meer: die worden
// dynamisch bepaald door de actuele volume-shift (calculateVolumeShift) rond
// dat moment, zoals gevraagd - een OSC-node met een duidelijke volume-piek
// telt wél mee, eentje zonder beweging blijft neutraal.
const NODE_INFLUENCE_WEIGHTS = {
    RESET: -8,
    VOLA: 10,
    VORTEX3: 6,
    VORTEX6: 6
};

// Berekent één samengestelde invloedswaarde op basis van: (1) het type en de
// nabijheid van de dichtstbijzijnde nodes (asymmetrisch: countdown weegt 1.5x
// zwaarder dan tijd-sinds), (2) voor OSC/MIDPULSE specifiek: de live
// volume-shift i.p.v. een vast gewicht, en (3) of die nodes toevallig
// samenvallen met een markt-sessie-transitie (Azië/Europa/VS) - zo'n
// samenloop telt extra mee, zoals in de documenten beschreven.
// Welk gewicht krijgt de node-invloed in de kansscore? Handmatig vastgezet
// (incl. 0 = uit), of overgelaten aan het lerende systeem. Zie de toelichting
// bij nodeWeightMode in botSettings.
function effectiveNodeWeight() {
    if (botSettings.nodeWeightMode === 'manual') {
        return Math.max(0, botSettings.nodeWeightManual ?? 1);
    }
    return adaptiveWeights.nodeInfluence;
}

function calculateNodeInfluence(nodeContext) {
    const windowMinutes = T_PI_MS / 2 / 60000; // ~94.33 min, het volledige relevante venster
    const proximityWeight = (minutes) => Math.max(0, 1 - (minutes / windowMinutes));

    const nextWeight = proximityWeight(nodeContext.nextNode.minutesUntil) * 1.5;
    const lastWeight = proximityWeight(nodeContext.lastNode.minutesAgo) * 1.0;

    const weightForType = (type) => {
        if (type === 'OSC' || type === 'MIDPULSE') {
            // Dynamisch: begrensd tot -4..+6 zodat een "klein" node-type nooit
            // zwaarder kan wegen dan een "groot" type zoals VOLA.
            const shift = calculateVolumeShift(6);
            return Math.max(-4, Math.min(6, shift / 10));
        }
        return NODE_INFLUENCE_WEIGHTS[type] || 0;
    };

    const nextScore = weightForType(nodeContext.nextNode.type) * nextWeight;
    const lastScore = weightForType(nodeContext.lastNode.type) * lastWeight;

    // Sessie-samenloop op de node-momenten zelf (niet op "nu")
    const nextSessionScore = calculateSessionInfluence(nodeContext.nextNode.time) * nextWeight;
    const lastSessionScore = calculateSessionInfluence(nodeContext.lastNode.time) * lastWeight;

    return nextScore + lastScore + nextSessionScore + lastSessionScore;
}

function applyUOTAMGrid(chartData, opts = {}) {
    if (chartData.length === 0) return;
    const updateTrading = opts.updateTrading !== false; // default: trading bijwerken (bot-pad)
    const showOnChart = opts.display !== false;          // default: markers tekenen
    const viewIv = opts.viewInterval || currentInterval;
    const nodesLocal = [];

    // 1. Wis oude data (alleen wanneer dit de TRADING-aanroep is; een pure
    // view-aanroep mag de handelsstate nooit raken)
    if (updateTrading) allNodes = [];
    
    const markers = [];
    const minTimeSec = chartData[0].time;
    const maxTimeSec = chartData[chartData.length - 1].time;
    
    const startSearchIndex = Math.floor(((minTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil(((maxTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) + 5;

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        let relativeIndex = i % 8;
        if (relativeIndex < 0) relativeIndex += 8;

        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        const d = new Date(nodeTimeMs);
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
        const timeLabel = `${dateStr} ${timeStr}`;
        
        // Zoek de candle die het dichtst bij de berekende node tijd ligt.
        // De marge schaalt mee met de candle-breedte van deze dataset: op een
        // 4h-view valt een node anders bijna nooit binnen 15 min van een
        // candle-OPENING en verdwenen alle markers of stapelden ze verkeerd.
        const marge = intervalToSec(viewIv) / 2 + 1;
        const closestCandle = chartData.find(c => Math.abs(c.time - nodeTimeSec) <= marge);
        
        if (closestCandle) {
            // 1. Bepaal het nodeType voor de PriceLines
            let nodeType = 'osc';
            if (relativeIndex === 0) nodeType = 'reset';
            else if (relativeIndex === 1) nodeType = 'vola';
            else if (relativeIndex === 3) nodeType = 'vortex3';
            else if (relativeIndex === 6) nodeType = 'vortex6';

            // 2. Push naar allNodes inclusief het type veld
            nodesLocal.push({
                id: i,
                type: nodeType, 
                time: closestCandle.time,
                high: closestCandle.high,
                low: closestCandle.low,
                isBullish: closestCandle.close >= closestCandle.open
            });

            // 3. Tekst markers voor de grafiek (nodeTypeKey matcht activeNodeTypes voor de toggle-knoppen)
            if (relativeIndex === 0) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffffff',
                    shape: 'circle',
                    text: `RESET [Vortex 9] Node ${i} | ${timeLabel}`,
                    nodeTypeKey: 'RESET',
                });
            } else if (relativeIndex === 1) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffff00',
                    shape: 'circle',
                    text: `VOLA Node ${i} | ${timeLabel}`,
                    nodeTypeKey: 'VOLA',
                });
            } else if (relativeIndex === 3 || relativeIndex === 6) {
                let vortexValue = (relativeIndex === 3) ? "3" : "6";
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `CORE [Vortex ${vortexValue}] Node ${i} | ${timeLabel}`,
                    nodeTypeKey: relativeIndex === 3 ? 'VORTEX3' : 'VORTEX6',
                });
            } else {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#888888',
                    shape: 'square',
                    text: `Node ${i} | ${timeLabel}`,
                    nodeTypeKey: 'OSC',
                });
            }
        }
        
        // --- NIEUWE LOGICA: Mid-Pulse toevoeging (Wiskundig tussen nodes in) ---
        // We berekenen de Mid-Pulse positie gebaseerd op de vorige index
        const midIndex = i + 0.5;
        const midTimeMs = ANCHOR_TIME + (midIndex * T_PI_MS);
        const midTimeSec = Math.floor(midTimeMs / 1000);
        const midCandle = chartData.find(c => Math.abs(c.time - midTimeSec) <= 15 * 60);
        const midDate = new Date(midTimeMs);
        const midDateStr = `${String(midDate.getUTCDate()).padStart(2, '0')}-${String(midDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const midTimeStr = `${String(midDate.getUTCHours()).padStart(2, '0')}:${String(midDate.getUTCMinutes()).padStart(2, '0')} UTC`;
        const midTimeLabel = `${midDateStr} ${midTimeStr}`;

        if (midCandle) {
            nodesLocal.push({
                id: `mid_${i}`,
                type: 'mid-pulse',
                time: midCandle.time,
                high: midCandle.high,
                low: midCandle.low,
                isBullish: midCandle.close >= midCandle.open
            });
            markers.push({
                time: midCandle.time,
                position: 'aboveBar',
                color: '#ffcc00',
                shape: 'circle',
                text: `MID PULSE Node ${i} | ${midTimeLabel}`,
                nodeTypeKey: 'MIDPULSE',
            });
        }
    }
    
    // DISPLAY: markers gefilterd op view-dichtheid (max 1 label per candle,
    // zwaarste node-type wint; hogere timeframes tonen alleen CORE-types).
    if (showOnChart) {
        gridMarkers = filterMarkersForView(markers, viewIv);
        renderNodeMarkers();
    }

    // TRADING: nodes + fib-niveaus alleen bijwerken vanaf de bot-data (15m) -
    // een view-wissel mag currentFibLevels en allNodes nooit veranderen.
    if (updateTrading) {
        allNodes = nodesLocal;
        updateActiveNodeFibLines(allNodes, chartData);
    }

    if (typeof updateInfoPanel === 'function') updateInfoPanel();
}

// Tekent alleen de markers waarvan het node-type actief staat geselecteerd
// (activeNodeTypes) - aparte functie zodat handleNodeTypeSelect() dit kan
// hertekenen zonder de hele grid opnieuw te hoeven berekenen.
// Centrale helper: hergebruikt de bestaande markers-plugin via .setMarkers()
// zodra die bestaat, en maakt 'm alleen de allereerste keer aan. Dit is de
// enige plek in de code die createSeriesMarkers/setMarkers mag aanroepen.
function setChartMarkers(markers) {
    if (nodeMarkersPlugin) {
        nodeMarkersPlugin.setMarkers(markers);
    } else {
        nodeMarkersPlugin = LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
    }
}

function renderNodeMarkers() {
    updateAllChartMarkers();
}

// NIEUW: patroon-markers en node-markers delen hetzelfde onderliggende
// marker-systeem (nodeMarkersPlugin.setMarkers() vervangt de VORIGE set
// volledig) - dus moeten ze samengevoegd worden vóór het tekenen, anders
// overschrijft de een de ander.
let patternMarkers = [];
let showPatternMarkers = false;
const PATTERN_MARKER_STYLE = {
    hammer: { text: '\u{1F528} Hamer', color: '#14f195' },
    hanging_man: { text: '\u{1FAA2} Hanging Man', color: '#ff3b5c' },
    inverted_hammer: { text: '\u{1F528} Inv. Hammer', color: '#14f195' },
    shooting_star: { text: '\u2604 Shooting Star', color: '#ff3b5c' },
    doji: { text: '\u2716 Doji', color: '#ffb627' },
    dragonfly_doji: { text: '\u2716 Dragonfly Doji', color: '#14f195' },
    gravestone_doji: { text: '\u2716 Gravestone Doji', color: '#ff3b5c' },
    spinning_top: { text: '\u{1F300} Spinning Top', color: '#ffb627' },
    bullish_engulfing: { text: '\u25B2 Bull. Engulfing', color: '#14f195' },
    bearish_engulfing: { text: '\u25BC Bear. Engulfing', color: '#ff3b5c' },
    piercing_line: { text: '\u25B2 Piercing Line', color: '#14f195' },
    dark_cloud_cover: { text: '\u25BC Dark Cloud', color: '#ff3b5c' },
    harami_bull: { text: '\u25AB Harami (bull)', color: '#14f195' },
    harami_bear: { text: '\u25AB Harami (bear)', color: '#ff3b5c' },
    tweezer_top: { text: '\u{1F953} Tweezer Top', color: '#ff3b5c' },
    tweezer_bottom: { text: '\u{1F953} Tweezer Bottom', color: '#14f195' },
    three_white_soldiers: { text: '\u25B2\u25B2\u25B2 3 Soldiers', color: '#14f195' },
    three_black_crows: { text: '\u25BC\u25BC\u25BC 3 Crows', color: '#ff3b5c' },
    morning_star: { text: '\u2600 Morning Star', color: '#14f195' },
    evening_star: { text: '\u{1F319} Evening Star', color: '#ff3b5c' },
    marubozu_bull: { text: '\u25A0 Marubozu', color: '#14f195' },
    marubozu_bear: { text: '\u25A0 Marubozu', color: '#ff3b5c' }
};

function updateAllChartMarkers() {
    const visibleNodeMarkers = gridMarkers.filter(m => activeNodeTypes[m.nodeTypeKey] !== false);
    const combined = showPatternMarkers ? [...visibleNodeMarkers, ...patternMarkers] : visibleNodeMarkers;
    // Lightweight Charts vereist markers gesorteerd op tijd
    combined.sort((a, b) => a.time - b.time);
    setChartMarkers(combined);
}

// Scant de laatste SCAN_WINDOW candles op candlestick-patronen en zet voor
// elke treffer een marker onderaan de betreffende candle (nodes staan
// 'aboveBar', patronen bewust 'belowBar' zodat ze elkaar nooit overlappen).
function renderPatternMarkers() {
    patternMarkers = [];
    const src = (viewData && viewData.length) ? viewData : rawData;
    if (!showPatternMarkers || !src || src.length < 3) { updateAllChartMarkers(); return; }

    const SCAN_WINDOW = 150;
    const start = Math.max(2, src.length - SCAN_WINDOW);
    for (let i = start; i < src.length; i++) {
        const result = detectCandlestickPattern(i, src);
        if (!result.pattern) continue;
        const style = PATTERN_MARKER_STYLE[result.pattern];
        if (!style) continue;
        patternMarkers.push({
            time: Math.floor(src[i][0] / 1000),
            position: 'belowBar',
            color: style.color,
            shape: 'circle',
            text: style.text
        });
    }
    updateAllChartMarkers();
}

function handlePatternMarkersSelect(value) {
    showPatternMarkers = (value === 'VISIBLE');
    renderPatternMarkers();
}

// Schakelt een node-type aan/uit op de chart, net als handleFibScaleSelect()
// voor de MIC/MES/MAC-lijnen.
// Dropdown-gestuurd, exclusief: "ALL" toont alle node-types, "NONE" toont er
// geen, een specifiek type toont ALLEEN dat type - net als de fib-schaal
// dropdown, niet meer optellend zoals de oude knoppenrij.
function handleNodeTypeSelect(value) {
    const allTypes = ['RESET', 'VOLA', 'VORTEX3', 'VORTEX6', 'OSC', 'MIDPULSE'];
    if (value === 'ALL') {
        allTypes.forEach(t => activeNodeTypes[t] = true);
    } else if (value === 'NONE') {
        allTypes.forEach(t => activeNodeTypes[t] = false);
    } else {
        allTypes.forEach(t => activeNodeTypes[t] = (t === value));
    }
    renderNodeMarkers();
}

// --- 1. Historie lijst updaten ---
function updateHistoryList(rawData) {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    
    // We nemen de laatste 288 candles (3 dagen) en draaien ze om voor chronologische volgorde
    const recent = rawData.slice(-288).reverse();
    
    listEl.innerHTML = `
        <table style="width: 100%; font-family: monospace; font-size: 0.85em; border-collapse: collapse; color: #d1d4dc;">
            <thead>
                <tr style="border-bottom: 2px solid #333; text-align: left;">
                    <th style="padding: 5px;">Datum/Tijd</th>
                    <th>O</th><th>H</th><th>L</th><th>C</th><th>Vol</th>
                </tr>
            </thead>
            <tbody>
                ${recent.map(d => {
                    const date = new Date(d[0]);
                    const dateStr = date.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' });
                    const timeStr = date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
                    const isBullish = parseFloat(d[4]) >= parseFloat(d[1]);
                    
                    return `
                        <tr style="border-bottom: 1px solid #222;">
                            <td style="padding: 5px; color: #888;">${dateStr} ${timeStr}</td>
                            <td>${parseFloat(d[1]).toFixed(0)}</td>
                            <td>${parseFloat(d[2]).toFixed(0)}</td>
                            <td>${parseFloat(d[3]).toFixed(0)}</td>
                            <td style="color: ${isBullish ? '#26a69a' : '#ef5350'}; font-weight: bold;">
                                ${parseFloat(d[4]).toFixed(0)}
                            </td>
                            <td>${parseFloat(d[5]).toFixed(1)}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
}

// --- UOTAM LIVE ENGINE: WebSocket en Data Verwerking ---
function startLiveUpdates() {
    if (currentWs) { currentWs.close(); currentWs = null; }

    // METER-FIX (13-07): de stream stond op fstream (FUTURES) terwijl de
    // SMA20-noemer uit SPOT-klines komt - futures-volume is een veelvoud van
    // spot, waardoor ER structureel rond 4-9 hing i.p.v. rond 1.0 en de check
    // "ER>1.2" 87% van de tijd gratis aanstond. Teller en noemer komen nu uit
    // dezelfde markt (spot - waar de testnet-executie ook op handelt).
    const baseUrl = "wss://stream.binance.com:9443";
    currentWs = new WebSocket(`${baseUrl}/ws/btcusdt@kline_${BOT_INTERVAL}`);

    // RECONNECT (13-07): de bot-stream had géén onclose-handler - een korte
    // netwerkhapering of browser-hik (zoals vanavond gezien) liet de socket
    // stil sterven, waarna livePrice/liveVol bevroor en de bot blind verder
    // "draaide" op verouderde data. Nu: automatische herverbinding met
    // oplopende backoff (2s -> 4s -> ... -> max 60s), en na herstel wordt de
    // bot-data ververst zodat gemiste candles worden ingehaald.
    currentWs.onclose = () => {
        if (!currentWs) return; // bewust gesloten (bv. interval-herstart)
        const delay = Math.min(60000, (window._botWsRetryDelay = (window._botWsRetryDelay || 1000) * 2));
        console.warn(`Bot-stream verbroken - herverbinden over ${delay / 1000}s...`);
        setTimeout(() => {
            initDashboard(); // haalt gemiste candles op én start de stream opnieuw
        }, delay);
    };
    currentWs.onopen = () => { window._botWsRetryDelay = 1000; };
    
    currentWs.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            const candle = message.k;
            if (!candle) return;

            livePrice = parseFloat(candle.c); // Geen 'const' of 'let' hier!
            liveVol = parseFloat(candle.v);   // Hiermee overschrijf je de globale variabelen
            const high = parseFloat(candle.h);
            const low = parseFloat(candle.l);
            const openPrice = parseFloat(candle.o);
            isBullish = livePrice >= openPrice;

            // 1. Volume Rate Berekening
            // FIX: zelfde argument-mismatch als in botHeartbeat (zie fix hierboven).
            const priceDelta = openPrice !== 0 ? (livePrice - openPrice) / openPrice : 0;
            const volMetrics = calculateVolumeMetrics(liveVol, priceDelta, isBullish, 9);
            const volRateEl = document.getElementById('vol-rate');
            const volScoreEl = document.getElementById('vol-score');
            if (volRateEl) volRateEl.innerText = `${volMetrics.rate}%`;
            if (volScoreEl) {
                volScoreEl.innerText = `${volMetrics.score}/100`;
                volScoreEl.style.color = isBullish ? '#00ffcc' : '#ef5350';
            }

            // 2. Chart Update - ALLEEN als de view op het bot-interval staat;
            // andere views hebben hun eigen stream (startChartStream) of, voor
            // 45m, live aggregatie vanuit deze 15m-stream.
            if (currentInterval === BOT_INTERVAL) {
                candlestickSeries.update({
                    time: candle.t / 1000,
                    open: openPrice,
                    high: high,
                    low: low,
                    close: livePrice,
                });
            } else if (currentInterval === '45m') {
                update45mBucketFromLive(candle);
            }

            // 3. Live Volume UI
            const volEl = document.getElementById('live-volume');
            if (volEl) volEl.innerText = liveVol ? liveVol.toFixed(4) : "Wachten...";

            // 4. Data-afhankelijke berekeningen (VFM, ER, DB, Chaos)
            // METER-FIX (13-07, gemeten op sessiedata):
            // - ER gebruikte het volume van de NOG VORMENDE candle als teller:
            //   een oplopende teller die elke 15 min op nul begint. Gemeten:
            //   ER-mediaan 1.03 in de eerste 200s van een candle, 8.90 in de
            //   laatste 200s (spearman +0.52 met candle-leeftijd) - een
            //   zaagtand die candle-leeftijd mat, geen marktenergie. Nu wordt
            //   het vormende volume GEPRO-RATEERD naar een volle-candle-
            //   equivalent, met 90s minimumleeftijd tegen deling-door-bijna-0.
            // - chaos was |prijs vs. 288 candles terug| = 3-DAAGSE DRIFT (hing
            //   muurvast rond 2.0, check "<10" was 100% van de tijd waar). Nu:
            //   echte gerealiseerde volatiliteit = std van de laatste 96
            //   candle-returns (24h op 15m-basis), in % per candle.
            if (rawData && rawData.length >= 288) {
                const sma20Volume = rawData.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
                const candleAgeMs = Date.now() - candle.t;
                const candleFrac = Math.min(1, Math.max(candleAgeMs / BOT_INTERVAL_MS, 0.1));
                if (candleAgeMs >= 90000) {
                    er = (liveVol / candleFrac) / sma20Volume; // volle-candle-equivalent vs. SMA20
                } // eerste 90s: vorige er-waarde vasthouden (te weinig volume-info)
                db = (high - low !== 0) ? (2 * livePrice - (high + low)) / (high - low) : 0;
                vfm = er * db;
                const closes96 = rawData.slice(-97).map(d => parseFloat(d[4]));
                const rets = closes96.slice(1).map((c, j) => (c - closes96[j]) / closes96[j] * 100);
                const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
                chaos = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
            
                // UI Updates voor de meters
                const absVfm = Math.abs(vfm);
                const vfmEl = document.getElementById('vfm-display');
                const vfmStatusEl = document.getElementById('vfm-status');
                if (vfmEl) { vfmEl.innerText = vfm.toFixed(3); vfmEl.style.color = (absVfm < 0.1) ? "#808080" : ((vfm > 0) ? "#00ffcc" : "#ef5350"); }
                if (vfmStatusEl) { vfmStatusEl.innerText = (absVfm < 0.1) ? "NEUTRAAL" : (absVfm > 1.5 ? "EXTREME" : "SIGNIFICANT"); vfmStatusEl.style.color = vfmEl.style.color; }
            
                const updateMetric = (id, val, status) => {
                    const pEl = document.getElementById(`${id}-display`);
                    const sEl = document.getElementById(`${id}-status`);
                    if (pEl) pEl.innerText = val.toFixed(2);
                    if (sEl) { sEl.innerText = status; sEl.style.color = (val > 0) ? "#00ffcc" : "#ef5350"; }
                };
                updateMetric('er', er, er > 1.2 ? "HIGH ENERGY" : "LOW ENERGY");
                updateMetric('db', db, db > 0 ? "BULLISH" : "BEARISH");
            
                const chaosEl = document.getElementById('chaos-display');
                const chaosStatusEl = document.getElementById('chaos-status');
                // chaos is nu gerealiseerde volatiliteit in % per 15m-candle
                // (BTC-basis ~0.15-0.20); drempels geschaald op de nieuwe betekenis.
                if (chaosEl) chaosEl.innerText = chaos.toFixed(2) + '%';
                if (chaosStatusEl) { chaosStatusEl.innerText = chaos > CONF_CHAOS_TH ? "VOLATIEL" : "STABIEL"; chaosStatusEl.style.color = chaos > CONF_CHAOS_TH ? "#ef5350" : "#00ffcc"; }

                // FIX (13-07): rawData werd bij het laden één keer opgehaald en
                // daarna NOOIT ververst - na uren draaien rekenden structuur,
                // SMA20, chaos en fib op steeds oudere data. Elke VOLTOOIDE
                // candle (candle.x) wordt nu aan de bot-data toegevoegd, de
                // buffer blijft 672 candles (7 dagen), en de trading-
                // instrumenten (nodes + fib) worden op dat moment herrekend.
                if (candle.x) {
                    rawData.push([candle.t, candle.o, candle.h, candle.l, candle.c, candle.v]);
                    while (rawData.length > 672) rawData.shift();
                    // PERF-FIX (15-07): dit blok (applyUOTAMGrid over 672 candles +
                    // MA/RSI/patronen hertekenen) draaide SYNCHROON in de
                    // WebSocket-handler en blokkeerde de thread ~365ms - Chrome
                    // meldde dat als "[Violation] 'message' handler took 365ms".
                    // Nu uitgesteld naar een idle-moment: de socket-handler is
                    // meteen klaar, de bot-lus loopt door, en het zware werk
                    // gebeurt zodra de browser tijd over heeft.
                    const doHeavy = () => {
                    const freshBotChart = rawData.map(d => ({
                        time: Math.floor(d[0] / 1000),
                        open: parseFloat(d[1]),
                        high: parseFloat(d[2]),
                        low: parseFloat(d[3]),
                        close: parseFloat(d[4])
                    }));
                    applyUOTAMGrid(freshBotChart, { updateTrading: true, display: currentInterval === BOT_INTERVAL, viewInterval: currentInterval });
                    if (currentInterval === BOT_INTERVAL) {
                        viewData = rawData;
                        renderMovingAverage();
                        renderRSI();
                        renderPatternMarkers();
                    }
                    };
                    if (window.requestIdleCallback) requestIdleCallback(doHeavy, { timeout: 2000 });
                    else setTimeout(doHeavy, 0);
                }
            
                // 5. Orisis & Fibonacci Integratie
                if (typeof allNodes !== 'undefined' && allNodes.length > 0) {
                    const activeNode = allNodes[allNodes.length - 1];
                    const chartData = rawData.map(d => ({ time: Math.floor(d[0] / 1000), high: parseFloat(d[2]), low: parseFloat(d[3]) }));

                    if (activeNode.id !== lastProcessedNodeId) {
                        applyUOTAMGrid(chartData); 
                        lastProcessedNodeId = activeNode.id; 
                    }
                    updateActiveNodeFibLines(allNodes, chartData);

                    // BEREKEN HIER DE NIEUWE FRACTALE BESLISSING
                    const decisionResult = getOrisisDecisionData(
                        volMetrics, livePrice, vfm, er, db, chaos, isBullish
                    );

                    // UI Updates
                    const statusDisplay = document.getElementById('market-status-main');
                    if (statusDisplay) statusDisplay.innerText = `${decisionResult.decision}`;

                    // FRACTALE TARGETS UPDATE
                    if (decisionResult.targets) {
                        document.getElementById('mic-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.micro.bullish));
                        document.getElementById('mic-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.micro.bearish));
                        document.getElementById('mes-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.meso.bullish));
                        document.getElementById('mes-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.meso.bearish));
                        document.getElementById('mac-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.macro.bullish));
                        document.getElementById('mac-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.macro.bearish));
                    }

                    // Confidence Score
                    const confEl = document.getElementById('probability-score');
                    if (confEl) {
                        confEl.innerText = `Confidence: ${decisionResult.probability}`;
                        confEl.style.color = (decisionResult.probability.includes('hoog') || decisionResult.probability.includes('Hoog')) ? '#00ffcc' : '#aaa';
                    }
                } else {
                    console.warn("Orisis blokkeert update: allNodes leeg of undefined");
                }
            } else {
                const chaosEl = document.getElementById('chaos-display');
                if (chaosEl) chaosEl.innerText = `Laden (${rawData.length}/288)`;
            }
        } catch (err) { console.error("UOTAM Engine Fout:", err); }
    };
}

function startSentimentStream() {
    // Sluit eventuele oude verbinding
    if (sentimentWs) { sentimentWs.close(); }

    // Depth stream: @depth10@100ms geeft de top 10 bids/asks elke 100ms
    sentimentWs = new WebSocket(`wss://fstream.binance.com/ws/btcusdt@depth10@100ms`);

    sentimentWs.onmessage = (event) => {
        const depth = JSON.parse(event.data);
        
        // Bereken de totale liquiditeit aan beide kanten
        const bids = depth.b.reduce((sum, item) => sum + parseFloat(item[1]), 0);
        const asks = depth.a.reduce((sum, item) => sum + parseFloat(item[1]), 0);
        
        // Order Book Imbalance (OBI) - Waarde tussen -1 en 1
        const obi = (bids - asks) / (bids + asks);
        
        // Update de sentiment balk direct met deze nieuwe, zuivere data
        updateSentimentBar(obi);
    };
    
    sentimentWs.onerror = (err) => console.error("Sentiment Stream Fout:", err);
}

function calculateFibLevels(high, low, isBullish) {
    const range = high - low;

    // Hier vervang je de oude return door deze nieuwe, logische structuur:
    return {
        // --- BASIS NIVEAUS ---
        '1.0':    high,
        '0.786':  low + (range * 0.786),
        '0.618':  low + (range * 0.618),
        '0.500':  low + (range * 0.500),
        '0.382':  low + (range * 0.382),
        '0.236':  low + (range * 0.236),
        '0.0':    low,

        // --- EXTENSIES (TESTZONES BOVEN DE 1.0) ---
        '1.272':  high + (range * 0.272),
        '1.618':  high + (range * 0.618),

        // --- ONDERSTE EXTENSIES ---
        '-0.236': low - (range * 0.236),
        '-0.382': low - (range * 0.382),
        '-0.500': low - (range * 0.500),
        '-0.618': low - (range * 0.618),
        '-0.786': low - (range * 0.786)
    };
}



// Standaard instelling (kan later via UI veranderd worden)

function computeFibScaleLevels(targetNodes, processedData) {
    const allScalesConfig = [
        { id: 'MIC', harmonic: 9 },
        { id: 'MES', harmonic: 12 },
        { id: 'MAC', harmonic: 49 }
    ];
    allScalesConfig.forEach(scale => {
        if (!targetNodes || targetNodes.length < 2) { currentFibLevels[scale.id] = null; return; }
        const nodesInRange = targetNodes.slice(-scale.harmonic);
        const startTime = nodesInRange[0].time;
        const endTime = nodesInRange[nodesInRange.length - 1].time;
        const candlesInPeriod = processedData.filter(c => c.time >= startTime && c.time <= endTime);
        if (candlesInPeriod.length === 0) { currentFibLevels[scale.id] = null; return; }

        const rangeHigh = Math.max(...candlesInPeriod.map(c => c.high));
        const rangeLow = Math.min(...candlesInPeriod.map(c => c.low));
        const levels = calculateFibLevels(rangeHigh, rangeLow, nodesInRange[nodesInRange.length - 1].isBullish);
        currentFibLevels[scale.id] = { levels, rangeHigh, rangeLow };
    });
}

function updateActiveNodeFibLines(targetNodes, chartData = null) {
    // 1. Data voorbereiding
    let processedData = (chartData && Array.isArray(chartData)) ? chartData : rawData.map(d => ({
        time: Math.floor(d[0] / 1000), 
        high: parseFloat(d[2]), 
        low: parseFloat(d[3])
    }));

    if (!Array.isArray(processedData) || processedData.length === 0) return;

    // 2. Bereken ALLE schalen altijd (nodig voor de bot), ongeacht wat er
    // straks daadwerkelijk getekend wordt.
    computeFibScaleLevels(targetNodes, processedData);

    // 3. Wis oude lijnen
    activeFibLines.forEach(line => candlestickSeries.removePriceLine(line));
    activeFibLines = [];

    // 4. Definieer de schaal-configuratie (stijlen gescheiden van kleuren)
    const fibPalettes = {
        MIC: { width: 1, style: LightweightCharts.LineStyle.Dotted },
        MES: { width: 2, style: LightweightCharts.LineStyle.Dashed },
        MAC: { width: 3, style: LightweightCharts.LineStyle.Solid }
    };

    // 5. Teken alleen wat actief is (Fractaal TAM model)
    ['MIC', 'MES', 'MAC'].forEach(scaleId => {
        // Check of de gebruiker deze schaal aan heeft staan via de UI
        if (!activeFibScales[scaleId]) return;

        const data = currentFibLevels[scaleId];
        if (!data) return;

        const palette = fibPalettes[scaleId];

        Object.entries(data.levels).forEach(([ratio, price]) => {
            const levelStyle = fibStyles[ratio] || { color: '#cccccc', label: ratio };
            
            if (!isNaN(price)) {
                const line = candlestickSeries.createPriceLine({
                    price: price,
                    color: levelStyle.color, // Kleur per Fib-niveau
                    lineWidth: palette.width, // Dikte per schaal
                    lineStyle: palette.style, // Stijl (dotted/dashed/solid) per schaal
                    axisLabelVisible: true,
                    title: `${scaleId} ${levelStyle.label}` 
                });
                activeFibLines.push(line);
            }
        });
    });
}
/**
 * Schakelt Fibonacci schalen in/uit en ververst de chart.
 * Zorg dat deze functie op het hoogste niveau in app.js staat!
 */

// Dropdown-gestuurd: "ALL" toont alle drie schalen, "NONE" toont er geen,
// een specifieke waarde (MIC/MES/MAC) toont ALLEEN die schaal - exclusief,
// niet optellend zoals de oude knoppenrij.
function handleFibScaleSelect(value) {
    if (value === 'ALL') {
        activeFibScales = { MIC: true, MES: true, MAC: true };
    } else if (value === 'NONE') {
        activeFibScales = { MIC: false, MES: false, MAC: false };
    } else {
        activeFibScales = { MIC: false, MES: false, MAC: false };
        activeFibScales[value] = true;
    }

    if (typeof candlestickSeries !== 'undefined' && typeof allNodes !== 'undefined' && typeof rawData !== 'undefined') {
        updateActiveNodeFibLines(allNodes, rawData);
    } else {
        console.warn("Chart of data is nog niet klaar voor Fibonacci update.");
    }
}

// Globale array voor volume history
let volumeHistory = [];

function calculateVolumeMetrics(currentVol, priceDelta, isBullish, harmonic) {
    const windowSize = harmonic * 10;
    volumeHistory.push(currentVol);
    if (volumeHistory.length > windowSize) volumeHistory.shift();

    const avgVol = volumeHistory.reduce((a, b) => a + b, 0) / volumeHistory.length;
    const variance = volumeHistory.reduce((a, b) => a + Math.pow(b - avgVol, 2), 0) / volumeHistory.length;
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? (currentVol - avgVol) / stdDev : 0;
    const vpe = Math.abs(priceDelta) / (zScore + 1);

    let regime = "RANGE-BOUND";
    if (zScore > 1.5 && Math.abs(priceDelta) > 0.05) regime = isBullish ? "BULLISH_EXPANSION" : "BEARISH_CRASH";
    else if (zScore < -0.5) regime = "LOW_CONVICTION";
    else if (zScore > 0.5 && Math.abs(priceDelta) < 0.01) regime = "ACCUMULATION";

    // We geven alles terug: zowel de rauwe stats als de UI-ready formaten
    return { 
        zScore: zScore.toFixed(2), 
        vpe: vpe.toFixed(4), 
        regime,
        rate: (((currentVol - avgVol) / avgVol) * 100).toFixed(1),
        score: Math.max(0, Math.min((zScore + 1) * 50, 100)).toFixed(0)
    };
}

/**
 * Vernieuwde UOTAM Fractale Besluitvormingsmatrix
 * Berekent targets per schaal en integreert energetische markt-data.
 */
/**
 * Definitieve UOTAM Fractale Besluitvormingsmatrix
 * Gebruikt logaritmische demping om exponentiële uitschieters te voorkomen.
 */
// Gegradeerde markt-status i.p.v. de oude platte WAIT/TREND-FOLLOW/BREAKOUT-
// indeling. Gebruikt de momentum-context uit het geheugen (metricsHistory) om
// onderscheid te maken tussen een VERS signaal, een AANHOUDEND signaal (trend
// continuation) en een CONSOLIDERENDE (zijwaartse) markt - zodat "80% kans"
// niet meer instant verschijnt zodra confluence toevallig 4 raakt.
function classifyMarketStatus(confluence, isBullish, momentumContext) {
    const trendContinuing = isBullish
        ? (momentumContext.consecutiveBullish >= 3)
        : (momentumContext.consecutiveBearish >= 3);

    if (confluence >= 4) {
        if (trendContinuing) {
            return {
                decision: isBullish ? "🚀 BULLISH BREAKOUT (aanhoudend)" : "📉 BEARISH CRASH (aanhoudend)",
                probability: "Zeer hoog (80-85%)"
            };
        }
        return {
            decision: isBullish ? "🚀 BULLISH BREAKOUT (vers)" : "📉 BEARISH CRASH (vers)",
            probability: "Hoog (75-80%)"
        };
    }

    if (confluence <= 1) {
        if (momentumContext.rangeCompressed) {
            return { decision: "➡️ CONSOLIDATIE / SIDEWAYS", probability: "Laag (45-50%)" };
        }
        return { decision: "⏸️ WAIT", probability: "Laag (<45%)" };
    }

    // confluence 2-3: mild directioneel signaal
    if (trendContinuing) {
        return {
            decision: isBullish ? "📈 BULLISH CONTINUATION" : "📉 BEARISH CONTINUATION",
            probability: "Gemiddeld (62-68%)"
        };
    }
    return {
        decision: isBullish ? "↗️ BULLISH BIAS" : "↘️ BEARISH BIAS",
        probability: "Gemiddeld (55-60%)"
    };
}

function getOrisisDecisionData(metrics, currentPrice, vfm, er, db, chaos, isBullish) {
    
    // 1. Bereken de energetische factor met logaritmische demping
    // Dit voorkomt dat extreme VFM/ER waarden je targets naar oneindig sturen.
    const rawEnergy = Math.abs(vfm) * (er / 1.5);
    const dampedEnergy = Math.log1p(rawEnergy); 
    const chaosFactor = 1 + (Math.min(chaos, 10) / 100);
    const energyFactor = dampedEnergy * chaosFactor;

    // 2. Interne helper voor fractale scan per schaal
    const calculateScaleRange = (harmonic) => {
        const relevantData = rawData.slice(-harmonic);
        const scanHigh = Math.max(...relevantData.map(d => parseFloat(d[2])));
        const scanLow = Math.min(...relevantData.map(d => parseFloat(d[3])));
        const range = scanHigh - scanLow;
        
        // Gebruik 0.382 extensie, vermenigvuldigd met de gedempte energie
        return {
            bullish: (scanHigh + (range * 0.382 * energyFactor)).toFixed(0),
            bearish: (scanLow - (range * 0.382 * energyFactor)).toFixed(0)
        };
    };

    // 3. Bouw de target matrix
    const targets = {
        micro: calculateScaleRange(9),   // Micro-scalp bereik
        meso:  calculateScaleRange(36),  // Meso-trend bereik
        macro: calculateScaleRange(144)  // Macro-structuur bereik
    };

    // 4. Confluence: Orisis' "Brain"
    let confluence = 0;
    // Drempels herijkt (13-07) op de GEFIXTE meters: ER pendelt na de
    // pro-ratering en spot/spot-correctie weer rond 1.0, dus >1.2 is weer een
    // echte eis. |VFM| = ER x |DB| kan max ~ER worden; 0.8 = "duidelijke
    // energie in een duidelijke richting". Chaos is nu gerealiseerde vol in %
    // per 15m-candle (BTC-basis ~0.15-0.20): <0.30 = geen chaotische markt.
    if (Math.abs(vfm) > CONF_VFM_TH) confluence += 2;
    if (Math.abs(db) > CONF_DB_TH) confluence += 1;
    if (chaos < CONF_CHAOS_TH) confluence += 1;
    if (er > CONF_ER_TH) confluence += 1;
    // FIX: Volume Score (metrics.score, 0-100) werd voorheen alleen getoond,
    // nooit gebruikt in de beslissing - ondanks dat het al berekend werd hoe
    // huidig volume zich verhoudt tot zijn eigen recente geschiedenis
    // (z-score). Dat is precies "hoe volume live verandert t.o.v. het
    // verleden" - nu telt een duidelijk verhoogde score (>65) mee als extra
    // confluence-punt.
    if (metrics && metrics.score > 65) confluence += 1;
    // Moving Average (fast/slow) trend-bevestiging. Ligt de prijs aan de kant
    // van de fast-MA die overeenkomt met de gedetecteerde richting, dan is dat
    // een extra bevestiging. Een VERSE crossover (golden/death cross) in de
    // juiste richting weegt zwaarder (+1 extra) - dat is precies het moment
    // waarop MA-crossover-strategieën normaliter een omslag signaleren.
    const maValues = getCurrentMAValues();
    if (maValues.fast !== null) {
        if ((isBullish && currentPrice > maValues.fast) || (!isBullish && currentPrice < maValues.fast)) confluence += 1;
    }
    const crossover = detectMACrossover();
    if ((isBullish && crossover === 'bullish') || (!isBullish && crossover === 'bearish')) confluence += 1;
    // NIEUW: lineaire voorspelling (huidige horizon-instelling) als extra,
    // onafhankelijke bevestiging van de richting.
    const prediction = computeLinearPrediction(predictionHorizonMinutes);
    if (prediction && ((isBullish && prediction.direction === 'bullish') || (!isBullish && prediction.direction === 'bearish'))) {
        confluence += 1;
    }
    // Max confluence is nu 9 (vfm 2 + db 1 + chaos 1 + er 1 + volume 1 + MA 1 + crossover 1 + voorspelling 1)

    // Gegradeerd niveau i.p.v. platte WAIT/TREND-FOLLOW/BREAKOUT (zie classifyMarketStatus)
    const momentumContext = getMomentumContext();
    const status = classifyMarketStatus(confluence, isBullish, momentumContext);

    return { decision: status.decision, probability: status.probability, targets, confluence, momentumContext };
}

function updateDashboard(metrics) {
    // Updaten van de bestaande velden
    document.getElementById('vol-rate').innerText = metrics.rate + '%';
    document.getElementById('vol-score').innerText = metrics.score + '/100';
    
    // Optioneel: Visuele feedback op basis van regime
    const scoreEl = document.getElementById('vol-score');
    if (metrics.regime === "BULLISH_EXPANSION") scoreEl.style.color = "#00ffcc";
    else if (metrics.regime === "BEARISH_CRASH") scoreEl.style.color = "#ef5350";
    else scoreEl.style.color = "#ff9900";
}

function getLastActiveNode() {
    if (typeof allNodes !== 'undefined' && allNodes.length > 0) {
        return allNodes[allNodes.length - 1];
    }
    return null; 
}

// ... al je andere code en functies (updateActiveNodeFibLines, setHarmonic, etc.) ...

// INITIALISATIE:
// Zorg dat de visuele status van de knoppen overeenkomt met de start-instelling
// We wachten eventueel tot de DOM geladen is om zeker te zijn dat de knoppen bestaan
document.addEventListener('DOMContentLoaded', () => {
    // Zet de opacity van alle knoppen op 0.5 (inactief)
    document.querySelectorAll('.harmonic-selector button').forEach(btn => btn.style.opacity = '0.5');
    
    // Zet de opacity van de standaard actieve knop op 1
    const defaultBtn = document.getElementById(`btn-${uotamHarmonicSetting}`);
    if (defaultBtn) {
        defaultBtn.style.opacity = '1';
    }
});

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, getResponsiveChartHeight());
});

// FIX: de HUD-lettertypes (Orbitron/Chakra Petch/JetBrains Mono) laden async
// via Google Fonts - als dat NA de eerste chart.resize() klaar is, kan de
// tekst-layout van het paneel eromheen nog lichtjes verschuiven zonder dat er
// een 'resize'-event vuurt, waardoor de chart-canvas net iets buiten zijn
// container kon uitsteken. Corrigeer de afmeting nog eens zodra fonts klaar zijn.
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
        chart.resize(chartContainer.clientWidth, getResponsiveChartHeight());
    });
}

applyChartPriceFormat();
fetchEurUsdtRate();
setInterval(fetchEurUsdtRate, 5 * 60 * 1000); // elke 5 minuten verversen

initDashboard();
setInterval(updateInfoPanel, 1000);

// ============================================================
// OSIRIS LIVE DATAFLOW HUD (14-07)
// Jarvis-achtige visualisatie boven Wallet Status: datadeeltjes stromen van
// de meters via de confluence-kern naar de beslis-blokken, met live prijs.
// Alles read-only op bestaande state - de HUD raakt de handelslogica nooit.
// ============================================================
let _flowHudInit = false;
let _flowLastPrice = 0;
let _flowConsoleIdx = 0;
let _confCells = [];

// ============================================================
// SECTIE-NAVIGATIE (17-07): Hub / Markt / Leren / Engine.
// Toont/verbergt hele secties; alle panelen blijven in de DOM, dus alle
// bestaande update-functies en id's blijven werken zoals ze waren.
// ============================================================
function showSection(naam) {
    // Scroll-landing (18-07): secties staan nu allemaal onder elkaar. showSection
    // scrollt naar de gevraagde sectie i.p.v. te tonen/verbergen. Oude localStorage
    // 'engine' valt terug op hub. Alle secties blijven altijd in de DOM (nodig voor
    // de live-updates), dus niets wordt verborgen.
    const map = { engine: 'hub', hub: 'hub', markt: 'markt', leren: 'hub' };
    const target = document.getElementById('sec-' + (map[naam] || naam)) || document.getElementById('sec-hub');
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth' });
}

function toggleFlowHud() {
    const b = document.getElementById('flow-hud-body'), c = document.getElementById('flow-hud-chev');
    if (!b) return;
    const dicht = b.style.display === 'none';
    b.style.display = dicht ? '' : 'none';
    if (c) c.innerHTML = dicht ? '&#9662;' : '&#9656;';
}

// Bouwt het oog eenmalig op: melkweg-vortex (spiraalarmen + deeltjes +
// sterrenstof), binaire iris (ringen van enen en nullen die tegen elkaar in
// draaien), Jarvis-laag (tick-ring + tegendraaiende arc-segmenten) en de
// negen confluence-segmenten. Alles SVG/SMIL: de browser animeert dit buiten
// de JS-thread, dus het kost de bot-lus geen rekentijd.
// ============================================================
// OCULAR CORE (v4): mechanisch/cyber oog met binaire iris, melkweg-vortex,
// radar-sweep in de buitenband, bewegende confluence-ring, en een pupil +
// confluence-teller die met de kansscore mee-schalen. De binaire cijfers
// kleuren op market-sentiment (groen=buyers, rood=sellers); bull/bear-detectie
// kleurt de structurele elementen. Alles wordt in #w-eye gebouwd; de live
// data-updates in updateFlowHud() sturen pupil-r, conf-tekst, sentiment en
// bull/bear aan.
// ============================================================
const HUD_BLUE = ['#00d9ff', '#4fc3f7', '#81d4fa', '#0288d1', '#29b6f6', '#b3e5fc'];
let _eyeSig = [];          // elementen die op bull/bear verkleuren
let _allEyeSig = [];       // kleurbare elementen van ALLE ogen (hub + hero + engine)
let _eyeBits = [];         // binaire cijfers die op sentiment verkleuren
let _eyePupil = null, _eyeHalo = null, _eyeConf = null;
let _eyeCX = 500, _eyeCY = 200, _eyeR = 150;
let EYE_SIGNAL = 'neutral', EYE_BUYERS = 50;

function initFlowHud() {
    if (_flowHudInit) return;
    const host = document.getElementById('w-eye');
    if (!host) return;
    _flowHudInit = true;
    const NS = 'http://www.w3.org/2000/svg', XL = 'http://www.w3.org/1999/xlink';
    const mk = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const CX = _eyeCX, CY = _eyeCY, R = _eyeR;
    _eyeSig = []; _eyeBits = [];

    // --- melkweg-vortex ---
    for (let a = 0; a < 9; a++) {
        let d = ''; const off = a / 9 * Math.PI * 2;
        for (let t = 0; t <= 1; t += 0.03) { const r = R * 2.4 - (R * 2.4 - R * 0.95) * t, th = off + t * 2.7; d += (t ? 'L' : 'M') + (CX + Math.cos(th) * r).toFixed(1) + ',' + (CY + Math.sin(th) * r * 0.46).toFixed(1); }
        host.appendChild(mk('path', { d, fill: 'none', stroke: HUD_BLUE[a % 5], 'stroke-width': 0.9, opacity: 0.22, id: 'weArm' + a }));
        for (let k = 0; k < 5; k++) {
            const c = mk('circle', { r: (0.8 + Math.random() * 1.4).toFixed(1), fill: HUD_BLUE[a % 5] });
            const am = mk('animateMotion', { dur: (4 + Math.random() * 5).toFixed(1) + 's', repeatCount: 'indefinite', begin: (-Math.random() * 8).toFixed(2) + 's', calcMode: 'spline', keyPoints: '0;1', keyTimes: '0;1', keySplines: '0.3 0 0.9 0.6' });
            const mp = document.createElementNS(NS, 'mpath'); mp.setAttributeNS(XL, 'href', '#weArm' + a); am.appendChild(mp); c.appendChild(am);
            c.appendChild(mk('animate', { attributeName: 'opacity', values: '0;0.9;0.9;0', dur: am.getAttribute('dur'), begin: am.getAttribute('begin'), repeatCount: 'indefinite' }));
            host.appendChild(c);
        }
    }
    host.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.02, ry: R * 0.98, fill: 'rgba(0,217,255,0.05)' }));

    // --- CYBER-behuizing: snelle tegendraaiende streepjes-scanringen + data-runners + bouten/beugels/vents ---
    [[R * 1.16, '#00d9ff', 0.6, '3 6', 6], [R * 1.22, '#0288d1', 0.5, '2 10', -9]].forEach(([rr, col, w, dash, dur]) => {
        const ring = mk('g');
        ring.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: rr, ry: rr * 0.96, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-dasharray': dash, opacity: 0.55 }));
        ring.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `${dur > 0 ? 0 : 360} ${CX} ${CY}`, to: `${dur > 0 ? 360 : 0} ${CX} ${CY}`, dur: Math.abs(dur) + 's', repeatCount: 'indefinite' }));
        host.appendChild(ring);
    });
    [[R * 1.19, '#00d9ff', 2.5], [R * 1.19, '#4fc3f7', 3.5]].forEach(([rr, col, dur], i) => {
        const g = mk('g'); const a0 = i * Math.PI, a1 = a0 + 0.7;
        g.appendChild(mk('path', { d: `M${CX + Math.cos(a0) * rr},${CY + Math.sin(a0) * rr * 0.96} A${rr},${rr * 0.96} 0 0 1 ${CX + Math.cos(a1) * rr},${CY + Math.sin(a1) * rr * 0.96}`, fill: 'none', stroke: col, 'stroke-width': 2, opacity: 0.85, 'stroke-linecap': 'round' }));
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: dur + 's', repeatCount: 'indefinite' }));
        host.appendChild(g);
    });
    // gesegmenteerd pantser (verkleurt op signaal)
    for (let i = 0; i < 16; i++) { const a0 = i / 16 * Math.PI * 2 + 0.03, a1 = (i + 0.86) / 16 * Math.PI * 2, r0 = R * 1.04, r1 = R * 1.1;
        const seg = mk('path', { d: `M${CX + Math.cos(a0) * r0},${CY + Math.sin(a0) * r0 * 0.96} A${r0},${r0 * 0.96} 0 0 1 ${CX + Math.cos(a1) * r0},${CY + Math.sin(a1) * r0 * 0.96} L${CX + Math.cos(a1) * r1},${CY + Math.sin(a1) * r1 * 0.96} A${r1},${r1 * 0.96} 0 0 0 ${CX + Math.cos(a0) * r1},${CY + Math.sin(a0) * r1 * 0.96} Z`, fill: '#0a1a28', stroke: '#00d9ff', 'stroke-width': 0.5, opacity: 0.55 });
        _eyeSig.push(seg); host.appendChild(seg); }
    // hex-bouten + hoekbeugels
    [0.785, 2.356, 3.927, 5.498].forEach(a => {
        const x2 = CX + Math.cos(a) * R * 1.32, y2 = CY + Math.sin(a) * R * 1.28 * 0.96;
        const hb = mk('circle', { cx: x2, cy: y2, r: 3, fill: '#0a1a28', stroke: '#4fc3f7', 'stroke-width': 0.7, opacity: 0.75 }); _eyeSig.push(hb); host.appendChild(hb);
    });
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => { const bx = CX + sx * R * 1.26, by = CY + sy * R * 1.2 * 0.96;
        const br = mk('path', { d: `M${bx - sx * 16},${by} L${bx},${by} L${bx},${by - sy * 16}`, fill: 'none', stroke: '#00d9ff', 'stroke-width': 1.2, opacity: 0.6 }); _eyeSig.push(br); host.appendChild(br); });

    // --- binaire iris tot dicht bij het centrum (geen donker gat) ---
    for (let ring = 0; ring < 11; ring++) {
        const r = R * 0.12 + ring * R * 0.072, n = Math.round(2 * Math.PI * r / (R * 0.093)); const g = mk('g');
        for (let i = 0; i < n; i++) {
            const a = i / n * Math.PI * 2, x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r * 0.96;
            const t = mk('text', { x: x.toFixed(1), y: y.toFixed(1), 'font-size': (R * 0.05 + ring * 0.15).toFixed(1), 'font-family': "'JetBrains Mono', monospace", 'text-anchor': 'middle', fill: ring < 4 ? '#7fe9ff' : HUD_BLUE[ring % 5], opacity: (0.25 + Math.random() * 0.55).toFixed(2), transform: 'rotate(' + (a * 180 / Math.PI + 90).toFixed(0) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')' });
            t.textContent = Math.random() > 0.5 ? '1' : '0'; t.setAttribute('data-bit', '1'); _eyeBits.push(t);
            t.appendChild(mk('animate', { attributeName: 'opacity', values: '0.12;0.85;0.12', dur: (1.4 + Math.random() * 3).toFixed(1) + 's', begin: (-Math.random() * 5).toFixed(1) + 's', repeatCount: 'indefinite' }));
            g.appendChild(t);
        }
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: (ring % 2 ? 360 : 0) + ' ' + CX + ' ' + CY, to: (ring % 2 ? 0 : 360) + ' ' + CX + ' ' + CY, dur: (18 + ring * 5) + 's', repeatCount: 'indefinite' }));
        host.appendChild(g);
    }

    // --- Jarvis-arcs (cyaan verkleurt, goud vast) + tick-ring ---
    const arc = (r, a0, a1, col, w) => mk('path', { d: 'M' + (CX + Math.cos(a0) * r) + ',' + (CY + Math.sin(a0) * r * 0.96) + ' A' + r + ',' + (r * 0.96) + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + (CX + Math.cos(a1) * r) + ',' + (CY + Math.sin(a1) * r * 0.96), fill: 'none', stroke: col, 'stroke-width': w, opacity: 0.7 });
    [[R * 1.0, 0.25, 1.45, '#00d9ff', 1.4, 20], [R * 1.0, 3.4, 4.6, '#00d9ff', 1.4, 20], [R * 1.08, 2.05, 2.85, '#ffb627', 1, -30], [R * 1.08, 5.15, 5.95, '#ffb627', 1, -30]].forEach(([r, a0, a1, c, w, dur], idx) => {
        const g = mk('g'); const pth = arc(r, a0, a1, c, w); if (idx < 2) _eyeSig.push(pth); g.appendChild(pth);
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: (dur > 0 ? 0 : 360) + ' ' + CX + ' ' + CY, to: (dur > 0 ? 360 : 0) + ' ' + CX + ' ' + CY, dur: Math.abs(dur) + 's', repeatCount: 'indefinite' }));
        host.appendChild(g);
    });
    for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, big = i % 4 === 0; host.appendChild(mk('line', { x1: CX + Math.cos(a) * (big ? R * 0.96 : R * 0.99), y1: CY + Math.sin(a) * (big ? R * 0.96 : R * 0.99) * 0.96, x2: CX + Math.cos(a) * R * 1.02, y2: CY + Math.sin(a) * R * 1.02 * 0.96, stroke: big ? '#00d9ff' : '#0288d1', 'stroke-width': big ? 1 : 0.5, opacity: big ? 0.7 : 0.35 })); }

    // --- confluence-ring: draait rond + kleurt rood/groen op de data (zie updateFlowHud) ---
    _confCells = [];
    const confRing = mk('g');
    for (let i = 0; i < 9; i++) { const a0 = (i / 9) * Math.PI * 2 - Math.PI / 2 + 0.03, a1 = ((i + 1) / 9) * Math.PI * 2 - Math.PI / 2 - 0.03, r0 = R * 0.92, r1 = R * 0.98;
        const seg = mk('path', { d: 'M' + (CX + Math.cos(a0) * r0) + ',' + (CY + Math.sin(a0) * r0 * 0.96) + ' A' + r0 + ',' + (r0 * 0.96) + ' 0 0 1 ' + (CX + Math.cos(a1) * r0) + ',' + (CY + Math.sin(a1) * r0 * 0.96) + ' L' + (CX + Math.cos(a1) * r1) + ',' + (CY + Math.sin(a1) * r1 * 0.96) + ' A' + r1 + ',' + (r1 * 0.96) + ' 0 0 0 ' + (CX + Math.cos(a0) * r1) + ',' + (CY + Math.sin(a0) * r1 * 0.96) + ' Z', fill: '#123040', opacity: 0.4 });
        seg.setAttribute('class', 'w-cell'); _confCells.push(seg); confRing.appendChild(seg); }
    // de hele ring draait langzaam rond
    confRing.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: '24s', repeatCount: 'indefinite' }));
    host.appendChild(confRing);
    const sd = mk('circle', { r: R * 0.028, fill: '#7fe9ff' });
    const rp = mk('path', { id: 'weCr', d: `M${CX + R * 0.95},${CY} A${R * 0.95},${R * 0.91} 0 1 1 ${CX - R * 0.95},${CY} A${R * 0.95},${R * 0.91} 0 1 1 ${CX + R * 0.95},${CY}`, fill: 'none', stroke: 'none' });
    host.appendChild(rp);
    const sm = mk('animateMotion', { dur: '2.4s', repeatCount: 'indefinite' });
    const smp = document.createElementNS(NS, 'mpath'); smp.setAttributeNS(XL, 'href', '#weCr'); sm.appendChild(smp); sd.appendChild(sm);
    sd.appendChild(mk('animate', { attributeName: 'opacity', values: '0.3;1;0.3', dur: '1s', repeatCount: 'indefinite' }));
    host.appendChild(sd);

    // --- RADAR-sweep in de buitenband (SVG-mask = donut, laat iris intact) ---
    const defs = mk('defs'); const mask = mk('mask', { id: 'weRm' });
    mask.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.12, ry: R * 1.08, fill: '#fff' }));
    mask.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.0, ry: R * 0.96, fill: '#000' }));
    defs.appendChild(mask); host.appendChild(defs);
    const band = R * 1.12;
    // twee radars: groen met de klok mee, rood tegen de klok in
    [['#00ff9f', '#5dffb0', 0], ['#ff5f7e', '#ff9bb0', 360]].forEach(([wedgeCol, lineCol, fromDeg]) => {
        const sweep = mk('g', { mask: 'url(#weRm)' });
        sweep.appendChild(mk('path', { d: `M${CX},${CY} L${CX + Math.cos(-0.5) * band},${CY + Math.sin(-0.5) * band * 0.96} A${band},${band * 0.96} 0 0 1 ${CX + Math.cos(0.5) * band},${CY + Math.sin(0.5) * band * 0.96} Z`, fill: wedgeCol, opacity: 0.24 }));
        sweep.appendChild(mk('line', { x1: CX, y1: CY, x2: CX + band, y2: CY, stroke: lineCol, 'stroke-width': 1.4, opacity: 0.7 }));
        sweep.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `${fromDeg} ${CX} ${CY}`, to: `${fromDeg === 0 ? 360 : 0} ${CX} ${CY}`, dur: '3s', repeatCount: 'indefinite' }));
        host.appendChild(sweep);
    });
    for (let i = 0; i < 6; i++) { const a = Math.random() * Math.PI * 2, br = R * 1.06; const b = mk('circle', { cx: CX + Math.cos(a) * br, cy: CY + Math.sin(a) * br * 0.96, r: 1.6, fill: '#5dffb0' });
        b.appendChild(mk('animate', { attributeName: 'opacity', values: '0;1;0', dur: '3s', begin: (i * 0.5) + 's', repeatCount: 'indefinite' })); host.appendChild(b); }

    // --- pupil + halo + confluence-teller (schalen mee met de kans) ---
    _eyeHalo = mk('circle', { cx: CX, cy: CY, r: R * 0.22, fill: 'none', stroke: '#00d9ff', 'stroke-width': 2, opacity: 0.85 }); _eyeSig.push(_eyeHalo); host.appendChild(_eyeHalo);
    _eyePupil = mk('circle', { cx: CX, cy: CY, r: R * 0.18, fill: '#02050a', stroke: '#00d9ff', 'stroke-width': 1.2, opacity: 0.95 }); _eyeSig.push(_eyePupil); host.appendChild(_eyePupil);
    // de confluence-teller-tekst uit de HTML halen we naar voren zodat hij bovenop ligt
    _eyeConf = null;  // confluence-tekst verwijderd uit het live oog (alleen de rode kern blijft)
    const coreC = mk('circle', { cx: CX, cy: CY, r: R * 0.05, fill: '#ff5f7e', opacity: 0.85 });
    coreC.appendChild(mk('animate', { attributeName: 'r', values: (R * 0.04) + ';' + (R * 0.08) + ';' + (R * 0.04), dur: '3.2s', repeatCount: 'indefinite' }));
    host.appendChild(coreC);

    _allEyeSig = _allEyeSig.concat(_eyeSig);

    // --- DATAFLOW PACKAGES: 5 kanalen per kant. De startpunten liggen op de
    // ooglid-vormige labelposities (verste in het midden, paren erboven/eronder
    // steeds dichter bij het oog). Elk kanaal heeft een eigen kleur zoals fib-lijnen.
    // Links: [x-start, y] van de labels  |  Rechts idem (gespiegeld).
    const leftPts = [ [64, 200], [192, 105], [192, 295], [300, 40], [300, 360] ];   // VFM, ER, DB, CHAOS, SENT
    const rightPts = [ [936, 200], [808, 105], [808, 295], [700, 40], [700, 360] ]; // KANS, KAL, REGIME, NODE, MID
    const leftCols  = ['#00d9ff', '#4fc3f7', '#81d4fa', '#ffb627', '#c792ea'];
    const rightCols = ['#00ff9f', '#ffb627', '#14f195', '#c792ea', '#4fc3f7'];
    function maakStroom(idPrefix, x0, y0, x1, y1, col, i) {
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + (y0 - CY) * 0.15;  // lichte boog
        host.appendChild(mk('path', { d: `M${x0},${y0} Q${cx},${cy} ${x1},${y1}`, fill: 'none', stroke: col, 'stroke-width': 0.6, opacity: 0.16, 'stroke-dasharray': '2 4' }));
        const pid = idPrefix + i;
        host.appendChild(mk('path', { id: pid, d: `M${x0},${y0} Q${cx},${cy} ${x1},${y1}`, fill: 'none', stroke: 'none' }));
        for (let k = 0; k < 2; k++) {
            const pkt = mk('rect', { x: -2.2, y: -2.2, width: 4.4, height: 4.4, fill: col, rx: 1, opacity: 0 });
            const dur = (2.6 + i * 0.25).toFixed(1) + 's';
            const am = mk('animateMotion', { dur, repeatCount: 'indefinite', begin: (-(i * 0.4 + k * 1.3)).toFixed(1) + 's', rotate: 'auto' });
            const mp = document.createElementNS(NS, 'mpath'); mp.setAttributeNS(XL, 'href', '#' + pid); am.appendChild(mp); pkt.appendChild(am);
            pkt.appendChild(mk('animate', { attributeName: 'opacity', values: '0;1;1;0', keyTimes: '0;0.15;0.85;1', dur, begin: am.getAttribute('begin'), repeatCount: 'indefinite' }));
            host.appendChild(pkt);
        }
    }
    const edgeR = R * 1.14;
    // links: van label NAAR het oog. Eindig op de BUITENRAND van het oog (op de
    // label-hoogte geprojecteerd), zodat de pakketjes de iris/pupil niet doorkruisen.
    leftPts.forEach(([lx, ly], i) => {
        const dy = (ly - CY) * 0.6;                       // hoe hoger/lager het label, hoe hoger het inslagpunt
        const ex = CX - Math.sqrt(Math.max(0, edgeR * edgeR - dy * dy)), ey = CY + dy;
        maakStroom('flowInPath', lx, ly, ex, ey, leftCols[i], i);
    });
    // rechts: van de buitenrand van het oog NAAR het label.
    rightPts.forEach(([rx, ry], i) => {
        const dy = (ry - CY) * 0.6;
        const ex = CX + Math.sqrt(Math.max(0, edgeR * edgeR - dy * dy)), ey = CY + dy;
        maakStroom('flowOutPath', ex, ey, rx, ry, rightCols[i], i);
    });


    applyEyeSignal(); applyEyeSentiment();
}

// bull/bear kleurt de structurele elementen; iris-cijfers slaan we over (sentiment stuurt die)
function eyeColor() {
    if (EYE_SIGNAL === 'bull') return '#14f195';
    if (EYE_SIGNAL === 'bear') return '#ff5f7e';
    return '#00d9ff';
}
// Handmatige bull/bear/neutral-demo vanuit de hero-knoppen. Zodra de bot een
// echte beslissing neemt, overschrijft updateFlowHud() dit weer met de live richting.
let _manualSignalUntil = 0;
function setEyeSignalManual(s) {
    EYE_SIGNAL = s;
    _manualSignalUntil = Date.now() + 8000;  // hou de simulatie 8s vast
    const bull = document.getElementById('bull-btn'), bear = document.getElementById('bear-btn');
    if (bull) bull.classList.toggle('on-bull', s === 'bull');
    if (bear) bear.classList.toggle('on-bear', s === 'bear');
    applyEyeSignal();
}
function applyEyeSignal() {
    const c = eyeColor();
    (_allEyeSig.length ? _allEyeSig : _eyeSig).forEach(el => {
        if (el.getAttribute && el.getAttribute('data-bit') === '1') return;
        const stroke = el.getAttribute('stroke');
        if (stroke && stroke !== 'none') el.setAttribute('stroke', c);
        const fill = el.getAttribute('fill');
        if (fill && fill !== 'none' && fill !== '#02050a' && fill !== '#0a1a28' && fill !== '#123040') el.setAttribute('fill', c);
    });
}
// De binaire cijfers blijven Jarvis-stijl (cyaan/teal-mix). Sentiment kleurt niet
// langer de cijfers zelf - dat doet nu de confluence-ring (zie updateFlowHud).
function applyEyeSentiment() { /* no-op: cijfers houden hun Jarvis-kleur */ }

function readSmoothedProb(side) {
    const buf = _probBuffers[side];
    if (!buf || buf.length === 0) return null;
    const s = [...buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

// KPI-strip bovenin de hub: de zes cijfers die er werkelijk toe doen.
// "break-even" is de winrate die je bij je eigen payoff-verhouding nodig hebt
// om quitte te spelen - het enige eerlijke ijkpunt voor "kal. edge".
function updateKpiStrip() {
    const set = (id, txt, kleur) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = txt;
        if (kleur) el.style.color = kleur;
    };
    const eq = getBalance() + getUnrealizedPnL();
    const start = walletState.startingCapital || 0;
    const pct = start > 0 ? (eq - start) / start * 100 : 0;
    set('hub-equity', formatMoney(eq));
    set('hub-equity-pct', `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, pct >= 0 ? '#00d9ff' : '#ff5f7e');
    const pnlPct = start > 0 ? (walletState.realizedPnL / start * 100) : 0;
    set('kpi-pnl', `${formatMoney(walletState.realizedPnL)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`, walletState.realizedPnL >= 0 ? '#00d9ff' : '#ff5f7e');
    const totaal = (walletState.wins || 0) + (walletState.losses || 0);
    set('kpi-winrate', totaal > 0 ? `${walletState.wins || 0}/${totaal} ${(walletState.wins / totaal * 100).toFixed(0)}%` : '\u2014');
    // Gekalibreerde kans van de sterkste kant. Zonder live kansdata (bot staat
    // stil, buffers leeg) hoort hier een streepje: anders rekent de mapping op
    // een score van 0 en toont hij misleidend "1%".
    const pL = readSmoothedProb('LONG'), pS = readSmoothedProb('SHORT');
    const beste = (pL === null && pS === null) ? null : Math.max(pL ?? 0, pS ?? 0);
    const cal = beste === null ? null : calibrateProbability(beste);
    set('kpi-cal', cal === null ? '\u2014' : `${cal.toFixed(0)}%`);
    // break-even winrate uit de werkelijke payoff-verhouding van gesloten trades
    const bot = learningLog.filter(l => !l.manual && l.pnlPct != null);
    const wins = bot.filter(l => l.pnlPct > 0).map(l => l.pnlPct);
    const losses = bot.filter(l => l.pnlPct <= 0).map(l => Math.abs(l.pnlPct));
    if (wins.length >= 5 && losses.length >= 5) {
        const W = wins.reduce((a, b) => a + b, 0) / wins.length;
        const L = losses.reduce((a, b) => a + b, 0) / losses.length;
        set('kpi-breakeven', `${(L / (W + L) * 100).toFixed(0)}%`);
    } else {
        set('kpi-breakeven', '\u2014');
    }
    set('kpi-alloc', `${(getAllocatedPct() * 100).toFixed(0)}%`);
    set('kpi-pos', `${openPositions.length}/${botSettings.maxOpenPositions}`);
    const badge = document.getElementById('hub-engine-badge');
    if (badge) {
        const aan = botSettings.isRunning;
        badge.innerHTML = `&#9673; ${aan ? (botSettings.executionMode === 'TESTNET' ? 'TESTNET · live' : 'SIMULATIE · live') : 'STANDBY'}`;
        badge.style.color = aan ? '#00d9ff' : '#5b7a90';
    }
}

// ============================================================
// HUB-PANELEN (17-07): kalibratiecurve, exit-bijdrage en positielijst.
// Alles read-only op bestaande state; 1x per seconde ververst vanuit
// updateFlowHud(). Deze drie panelen tonen samen de kernvraag van het hele
// systeem: klopt de voorspelling (kalibratie), wat verdient/kost elk
// exit-mechanisme (bijdrage), en wat staat er nu open.
// ============================================================
function renderCalibrationCurve() {
    const plot = document.getElementById('calib-plot');
    const note = document.getElementById('calib-note');
    if (!plot) return;
    if (!_calibMap || _calibMap.length < 2) {
        plot.innerHTML = '';
        const n = learningLog.filter(l => !l.manual && l.entryProbabilityPct != null).length;
        if (note) note.textContent = `Wacht op 50+ trades met entry-kans (nu ${n}).`;
        return;
    }
    // x: ruwe score 50-100 -> 8..94 | y: gemeten winrate 0-100 -> 50..4
    const X = r => 8 + (Math.min(100, Math.max(50, r)) - 50) / 50 * 86;
    const Y = w => 50 - Math.min(100, Math.max(0, w)) / 100 * 46;
    const pts = _calibMap.map(([r, w]) => `${X(r).toFixed(1)},${Y(w).toFixed(1)}`).join(' ');
    let svg = `<polyline points="${pts}" fill="none" stroke="#ffb627" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>`;
    _calibMap.forEach(([r, w], i) => {
        const laatste = i === _calibMap.length - 1;
        svg += `<circle cx="${X(r).toFixed(1)}" cy="${Y(w).toFixed(1)}" r="${laatste ? 1.6 : 1.1}" fill="#ffb627"/>`;
        if (laatste) svg += `<text x="${(X(r) - 3).toFixed(1)}" y="${(Y(w) - 3).toFixed(1)}" font-size="4" font-weight="bold" fill="#ffb627" text-anchor="middle" font-family="'JetBrains Mono',monospace">${w.toFixed(0)}%</text>`;
    });
    plot.innerHTML = svg;
    const upd = document.getElementById('calib-updated');
    if (upd) {
        const nu = new Date();
        const d = String(nu.getDate()).padStart(2, '0'), m = String(nu.getMonth() + 1).padStart(2, '0');
        const hh = String(nu.getHours()).padStart(2, '0'), mm = String(nu.getMinutes()).padStart(2, '0'), ss = String(nu.getSeconds()).padStart(2, '0');
        const n = learningLog.filter(l => !l.manual && l.entryProbabilityPct != null).length;
        upd.textContent = `last updated ${d}-${m} ${hh}:${mm}:${ss} \u00b7 ${n} trades`;
    }
    if (note) {
        const n = learningLog.filter(l => !l.manual && l.entryProbabilityPct != null).length;
        note.textContent = `${n} bot-trades \u00b7 hoe verder onder de stippellijn, hoe overmoediger de score.`;
    }
}

function renderExitDistribution() {
    const el = document.getElementById('exit-dist');
    if (!el) return;
    const bot = learningLog.filter(l => l.exitReason && l.pnlPct != null);
    if (bot.length === 0) { el.textContent = 'Nog geen gesloten trades.'; return; }
    const som = {};
    bot.forEach(l => {
        const k = String(l.exitReason).replace('_EXIT', '').replace('PROFIT_', '').replace('SMALL_', '');
        som[k] = (som[k] || 0) + l.pnlPct * 100;
    });
    const paren = Object.entries(som).sort((a, b) => a[1] - b[1]).slice(0, 6);
    const max = Math.max(...paren.map(([, v]) => Math.abs(v)), 0.01);
    el.innerHTML = paren.map(([naam, v]) => {
        const breedte = Math.abs(v) / max * 48;
        const kleur = v >= 0 ? '#00d9ff' : '#ff5f7e';
        const kant = v >= 0 ? `left:50%; width:${breedte.toFixed(1)}%` : `right:50%; width:${breedte.toFixed(1)}%`;
        return `<div class="exit-row"><span class="naam" title="${naam}">${naam.slice(0, 9)}</span><span class="track"><span class="bar" style="${kant}; background:${kleur};"></span></span><span class="waarde" style="color:${kleur};">${v >= 0 ? '+' : ''}${v.toFixed(1)}</span></div>`;
    }).join('');
}

function renderHubPositions() {
    const el = document.getElementById('hub-positions');
    if (!el) return;
    if (openPositions.length === 0) { el.textContent = 'Geen open posities.'; return; }
    const kosten = roundTripCostPct() / 100;
    el.innerHTML = openPositions.map(p => {
        const bruto = livePrice ? (p.side === 'LONG' ? (livePrice - p.entryPrice) / p.entryPrice : (p.entryPrice - livePrice) / p.entryPrice) : 0;
        const netto = (bruto - kosten) * 100;
        const type = p.isManual ? 'MANUAL' : (p.isScalp ? 'SCALP' : 'TREND');
        const typeKleur = p.isManual ? '#ffb627' : (p.isScalp ? '#c678dd' : '#4287f5');
        return `<div class="pos-row">
            <span style="color:${typeKleur}; width:42px; flex:none;">${type}</span>
            <span style="color:${p.side === 'LONG' ? '#00d9ff' : '#ff5f7e'}; width:34px; flex:none;">${p.side}</span>
            <span style="color:#7d99ac; flex:1; min-width:0;">${formatChartPrice(p.entryPrice)}</span>
            <span style="color:${netto >= 0 ? '#00d9ff' : '#ff5f7e'}; flex:none;">${netto >= 0 ? '+' : ''}${netto.toFixed(2)}%</span>
            <button class="sluit" onclick="closePositionManually('${p.id}')" title="Sluit nu tegen de live prijs">sluit</button>
        </div>`;
    }).join('');
}

function updateFlowHud() {
    const priceEl = document.getElementById('flow-price');
    const navPriceEl = document.getElementById('nav-live-price');
    if (livePrice > 0 && navPriceEl) navPriceEl.textContent = '$' + livePrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (!priceEl) { updateKpiStrip(); return; }
    updateKpiStrip();
    const body = document.getElementById('flow-hud-body');
    if (body && body.style.display === 'none') {
        if (livePrice > 0) priceEl.textContent = '$' + livePrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        return;
    }
    initFlowHud();
    if (livePrice > 0) {
        priceEl.textContent = '$' + livePrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        if (_flowLastPrice > 0 && livePrice !== _flowLastPrice) {
            priceEl.style.color = livePrice > _flowLastPrice ? '#00d9ff' : '#ff5f7e';
            setTimeout(() => { priceEl.style.color = '#e3f6ff'; }, 600);
        }
        _flowLastPrice = livePrice;
    }
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('flow-vfm', isFinite(vfm) ? vfm.toFixed(2) : '\u2014');
    set('flow-er', isFinite(er) ? er.toFixed(2) : '\u2014');
    set('flow-db', isFinite(db) ? db.toFixed(2) : '\u2014');
    set('flow-chaos', isFinite(chaos) ? chaos.toFixed(2) + '%' : '\u2014');
    if (typeof getMarketSentiment === 'function') { try { const b = getMarketSentiment(); if (isFinite(b)) set('flow-sent', `${b.toFixed(0)}%`); } catch (e) {} }
    const R = _eyeR;
    if (lastOsirisDecision && lastOsirisDecision.confluence != null) {
        const c9 = Math.max(0, Math.min(9, lastOsirisDecision.confluence));
        set('flow-conf', `${c9}/9`);
        // confluence-segmenten kleuren mee met de markt: groen als buyers de
        // overhand hebben (net als de sentiment-loadbar), rood als sellers dat doen.
        const confCol = EYE_BUYERS >= 50 ? '#14f195' : '#ff5f7e';
        _confCells.forEach((c, i) => {
            const aan = i < c9;
            c.setAttribute('fill', aan ? confCol : '#123040');
            c.setAttribute('opacity', aan ? '0.9' : '0.4');
        });
        const dir = lastOsirisDecision.side || lastOsirisDecision.direction;
        const sig = dir === 'LONG' ? 'bull' : dir === 'SHORT' ? 'bear' : 'neutral';
        if (sig !== EYE_SIGNAL && Date.now() > _manualSignalUntil) { EYE_SIGNAL = sig; applyEyeSignal(); }
    }
    // Pupil + halo + confluence-teller schalen mee met de sterkste gedempte kans
    const pl = readSmoothedProb('LONG'), ps = readSmoothedProb('SHORT');
    if (pl !== null || ps !== null) {
        set('flow-prob', `${pl !== null ? pl.toFixed(0) : '\u2014'}/${ps !== null ? ps.toFixed(0) : '\u2014'}`);
        const best = Math.max(pl ?? 0, ps ?? 0);
        const pr = (R * 0.1 + best / 100 * R * 0.22);
        if (_eyePupil) _eyePupil.setAttribute('r', pr.toFixed(1));
        if (_eyeHalo) _eyeHalo.setAttribute('r', (pr + R * 0.04).toFixed(1));
        if (_eyeConf) _eyeConf.setAttribute('font-size', (pr * 0.9).toFixed(1));
        const cal = calibrateProbability(best);
        set('flow-cal', cal === null ? '\u2014' : cal.toFixed(0) + '%');
    }
    if (typeof getMarketSentiment === 'function') {
        try { const sBuy = getMarketSentiment(); if (isFinite(sBuy)) { EYE_BUYERS = sBuy; applyEyeSentiment(); } } catch (e) {}
    }
    const regimeEl = document.getElementById('flow-regime');
    if (regimeEl && typeof evaluateMarketRegime === 'function') {
        const r = evaluateMarketRegime();
        regimeEl.textContent = r.dead ? 'DOOD' : 'ACTIEF';
        regimeEl.setAttribute('fill', r.dead ? '#ffb627' : '#00d9ff');
    }
    set('flow-pos', `${openPositions.length}/${pendingOrders.length}`);
    try {
        const ctx = getNodeContext();
        if (ctx && ctx.nextNode) set('flow-node', `${(ctx.nextNode.type || '').slice(0, 8)} ${ctx.nextNode.minutesUntil.toFixed(0)}m`);
        const midEl = document.getElementById('mid-pulse-display'); if (midEl) set('flow-mid', (midEl.textContent || '\u2014').slice(0, 8));
    } catch (e) {}
    if (typeof getAllocatedPct === 'function') set('flow-alloc', (getAllocatedPct() * 100).toFixed(0) + '%');
    renderCalibrationCurve();
    renderExitDistribution();
    renderHubPositions();
    set('flow-scan', `${10 - (Math.floor(Date.now() / 1000) % 10)}s`);
    set('flow-buf', `${Math.min(100, Math.round(metricsHistory.length / 500 * 100))}%`);
    const sysEl = document.getElementById('flow-sys');
    if (sysEl) {
        const ok = livePrice > 0 && currentWs && currentWs.readyState === 1;
        sysEl.textContent = ok ? 'NOMINAAL' : 'STREAM DOWN';
        sysEl.style.color = ok ? '#00d9ff' : '#ff5f7e';
    }
    const consoleEl = document.getElementById('flow-console');
    if (consoleEl && Math.floor(Date.now() / 1000) % 6 === 0) {
        const regels = [];
        regels.push(`Kans-collaps ${botSettings.probCollapseEnabled ? 'AAN (' + botSettings.probCollapseThresholdPct + '%/' + botSettings.probCollapseConfirmSeconds + 's)' : 'UIT'} \u00b7 demping ${botSettings.probSmoothingSamples} metingen`);
        regels.push(`Bescherming vanaf +${(botSettings.profitProtectActivationPct * 100).toFixed(1)}% piek \u00b7 kosten ${roundTripCostPct().toFixed(2)}% r.t.`);
        regels.push(`MA ${maFastPeriod}/${maSlowPeriod} \u00b7 node-gewicht ${botSettings.nodeWeightMode === 'manual' ? botSettings.nodeWeightManual : 'adaptief'}`);
        if (botTradeLog.length > 0) {
            const l = botTradeLog[botTradeLog.length - 1];
            regels.push(`Laatste actie: ${l.action} ${l.side || ''} @ $${(l.price || 0).toFixed(0)}`);
        }
        _flowConsoleIdx = (_flowConsoleIdx + 1) % regels.length;
        consoleEl.textContent = regels[_flowConsoleIdx];
    }
}

// Scroll-landing: de pagina begint altijd bovenaan bij de intro (geen
// auto-scroll naar een opgeslagen sectie meer).
setInterval(updateFlowHud, 1000);

// ============================================================
// SCROLL-LANDING (v4): decoratief oog (hero/engine), starmap, jump-rails,
// scroll-spy en nav-prijs. De hub-eye is de LIVE variant (buildEye/updateFlowHud);
// deze decoratieve ogen delen dezelfde vormtaal maar zonder data-binding.
// ============================================================
function buildDecorEye(hostId, R, showConf) {
    const svg = document.getElementById(hostId);
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg', XL = 'http://www.w3.org/1999/xlink';
    const mk = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    const CX = vb[2] / 2, CY = vb[3] / 2 - 10;
    const BLUE = ['#00d9ff', '#4fc3f7', '#81d4fa', '#0288d1', '#29b6f6'];
    // vortex
    for (let a = 0; a < 9; a++) {
        let d = ''; const off = a / 9 * Math.PI * 2;
        for (let t = 0; t <= 1; t += 0.03) { const r = R * 2.4 - (R * 2.4 - R * 0.95) * t, th = off + t * 2.7; d += (t ? 'L' : 'M') + (CX + Math.cos(th) * r).toFixed(1) + ',' + (CY + Math.sin(th) * r * 0.46).toFixed(1); }
        svg.appendChild(mk('path', { d, fill: 'none', stroke: BLUE[a % 5], 'stroke-width': 0.9, opacity: 0.22, id: hostId + 'arm' + a }));
        for (let k = 0; k < 5; k++) {
            const c = mk('circle', { r: (0.8 + Math.random() * 1.4).toFixed(1), fill: BLUE[a % 5] });
            const am = mk('animateMotion', { dur: (4 + Math.random() * 5).toFixed(1) + 's', repeatCount: 'indefinite', begin: (-Math.random() * 8).toFixed(2) + 's', calcMode: 'spline', keyPoints: '0;1', keyTimes: '0;1', keySplines: '0.3 0 0.9 0.6' });
            const mp = document.createElementNS(NS, 'mpath'); mp.setAttributeNS(XL, 'href', '#' + hostId + 'arm' + a); am.appendChild(mp); c.appendChild(am);
            c.appendChild(mk('animate', { attributeName: 'opacity', values: '0;0.9;0.9;0', dur: am.getAttribute('dur'), begin: am.getAttribute('begin'), repeatCount: 'indefinite' }));
            svg.appendChild(c);
        }
    }
    svg.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.02, ry: R * 0.98, fill: 'rgba(0,217,255,0.05)' }));
    // cyber scan-rings
    [[R * 1.16, '#00d9ff', 0.6, '3 6', 6], [R * 1.22, '#0288d1', 0.5, '2 10', -9]].forEach(([rr, col, w, dash, dur]) => {
        const ring = mk('g');
        ring.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: rr, ry: rr * 0.96, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-dasharray': dash, opacity: 0.55 }));
        ring.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `${dur > 0 ? 0 : 360} ${CX} ${CY}`, to: `${dur > 0 ? 360 : 0} ${CX} ${CY}`, dur: Math.abs(dur) + 's', repeatCount: 'indefinite' }));
        svg.appendChild(ring);
    });
    [[R * 1.19, '#00d9ff', 2.5], [R * 1.19, '#4fc3f7', 3.5]].forEach(([rr, col, dur], i) => {
        const g = mk('g'); const a0 = i * Math.PI, a1 = a0 + 0.7;
        g.appendChild(mk('path', { d: `M${CX + Math.cos(a0) * rr},${CY + Math.sin(a0) * rr * 0.96} A${rr},${rr * 0.96} 0 0 1 ${CX + Math.cos(a1) * rr},${CY + Math.sin(a1) * rr * 0.96}`, fill: 'none', stroke: col, 'stroke-width': 2, opacity: 0.85, 'stroke-linecap': 'round' }));
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: dur + 's', repeatCount: 'indefinite' }));
        svg.appendChild(g);
    });
    // binaire iris
    for (let ring = 0; ring < 11; ring++) {
        const r = R * 0.12 + ring * R * 0.072, n = Math.round(2 * Math.PI * r / (R * 0.093)); const g = mk('g');
        for (let i = 0; i < n; i++) {
            const a = i / n * Math.PI * 2, x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r * 0.96;
            const t = mk('text', { x: x.toFixed(1), y: y.toFixed(1), 'font-size': (R * 0.05 + ring * 0.15).toFixed(1), 'font-family': "'JetBrains Mono', monospace", 'text-anchor': 'middle', fill: ring < 4 ? '#7fe9ff' : BLUE[ring % 5], opacity: (0.25 + Math.random() * 0.55).toFixed(2), transform: 'rotate(' + (a * 180 / Math.PI + 90).toFixed(0) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')' });
            t.textContent = Math.random() > 0.5 ? '1' : '0';
            t.appendChild(mk('animate', { attributeName: 'opacity', values: '0.12;0.85;0.12', dur: (1.6 + Math.random() * 4).toFixed(1) + 's', begin: (-Math.random() * 5).toFixed(1) + 's', repeatCount: 'indefinite' }));
            g.appendChild(t);
        }
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: (ring % 2 ? 360 : 0) + ' ' + CX + ' ' + CY, to: (ring % 2 ? 0 : 360) + ' ' + CX + ' ' + CY, dur: (30 + ring * 8) + 's', repeatCount: 'indefinite' }));
        svg.appendChild(g);
    }
    // Jarvis arcs + ticks
    const arc = (r, a0, a1, col, w) => mk('path', { d: 'M' + (CX + Math.cos(a0) * r) + ',' + (CY + Math.sin(a0) * r * 0.96) + ' A' + r + ',' + (r * 0.96) + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + (CX + Math.cos(a1) * r) + ',' + (CY + Math.sin(a1) * r * 0.96), fill: 'none', stroke: col, 'stroke-width': w, opacity: 0.7 });
    [[R * 1.0, 0.25, 1.45, '#00d9ff', 1.4, 22], [R * 1.0, 3.4, 4.6, '#00d9ff', 1.4, 22], [R * 1.08, 2.05, 2.85, '#ffb627', 1, -32], [R * 1.08, 5.15, 5.95, '#ffb627', 1, -32]].forEach(([r, a0, a1, c, w, dur]) => {
        const g = mk('g'); g.appendChild(arc(r, a0, a1, c, w));
        g.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: (dur > 0 ? 0 : 360) + ' ' + CX + ' ' + CY, to: (dur > 0 ? 360 : 0) + ' ' + CX + ' ' + CY, dur: Math.abs(dur) + 's', repeatCount: 'indefinite' }));
        svg.appendChild(g);
    });
    for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, big = i % 4 === 0; svg.appendChild(mk('line', { x1: CX + Math.cos(a) * (big ? R * 0.96 : R * 0.99), y1: CY + Math.sin(a) * (big ? R * 0.96 : R * 0.99) * 0.96, x2: CX + Math.cos(a) * R * 1.02, y2: CY + Math.sin(a) * R * 1.02 * 0.96, stroke: big ? '#00d9ff' : '#0288d1', 'stroke-width': big ? 1 : 0.5, opacity: big ? 0.7 : 0.35 })); }
    // confluence-ring (6/9 aan), draait rond, groen
    const confRing = mk('g');
    for (let i = 0; i < 9; i++) { const a0 = (i / 9) * Math.PI * 2 - Math.PI / 2 + 0.03, a1 = ((i + 1) / 9) * Math.PI * 2 - Math.PI / 2 - 0.03, r0 = R * 0.92, r1 = R * 0.98, on = i < 6;
        const seg = mk('path', { d: 'M' + (CX + Math.cos(a0) * r0) + ',' + (CY + Math.sin(a0) * r0 * 0.96) + ' A' + r0 + ',' + (r0 * 0.96) + ' 0 0 1 ' + (CX + Math.cos(a1) * r0) + ',' + (CY + Math.sin(a1) * r0 * 0.96) + ' L' + (CX + Math.cos(a1) * r1) + ',' + (CY + Math.sin(a1) * r1 * 0.96) + ' A' + r1 + ',' + (r1 * 0.96) + ' 0 0 0 ' + (CX + Math.cos(a0) * r1) + ',' + (CY + Math.sin(a0) * r1 * 0.96) + ' Z', fill: on ? '#14f195' : '#123040', opacity: on ? 0.85 : 0.4 });
        if (on) seg.appendChild(mk('animate', { attributeName: 'opacity', values: '0.5;1;0.5', dur: (1.6 + i * 0.15).toFixed(1) + 's', begin: (-i * 0.2).toFixed(1) + 's', repeatCount: 'indefinite' }));
        confRing.appendChild(seg); }
    confRing.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: '24s', repeatCount: 'indefinite' }));
    svg.appendChild(confRing);
    // radar sweep (mask donut)
    const defs = mk('defs'); const mask = mk('mask', { id: hostId + 'rm' });
    mask.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.12, ry: R * 1.08, fill: '#fff' }));
    mask.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: R * 1.0, ry: R * 0.96, fill: '#000' }));
    defs.appendChild(mask); svg.appendChild(defs);
    const band = R * 1.12; const sweep = mk('g', { mask: `url(#${hostId}rm)` });
    sweep.appendChild(mk('path', { d: `M${CX},${CY} L${CX + Math.cos(-0.5) * band},${CY + Math.sin(-0.5) * band * 0.96} A${band},${band * 0.96} 0 0 1 ${CX + Math.cos(0.5) * band},${CY + Math.sin(0.5) * band * 0.96} Z`, fill: '#00ff9f', opacity: 0.28 }));
    sweep.appendChild(mk('line', { x1: CX, y1: CY, x2: CX + band, y2: CY, stroke: '#5dffb0', 'stroke-width': 1.4, opacity: 0.7 }));
    sweep.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: '4s', repeatCount: 'indefinite' }));
    svg.appendChild(sweep);
    // pupil + teller
    const halo = mk('circle', { cx: CX, cy: CY, r: R * 0.22, fill: 'none', stroke: '#00d9ff', 'stroke-width': 2, opacity: 0.85 });
    halo.appendChild(mk('animate', { attributeName: 'r', values: `${R * 0.16};${R * 0.34};${R * 0.16}`, dur: '6.5s', repeatCount: 'indefinite' }));
    svg.appendChild(halo);
    const pupil = mk('circle', { cx: CX, cy: CY, r: R * 0.18, fill: '#02050a', stroke: '#00d9ff', 'stroke-width': 1.2, opacity: 0.95 });
    pupil.appendChild(mk('animate', { attributeName: 'r', values: `${R * 0.12};${R * 0.3};${R * 0.12}`, dur: '6.5s', repeatCount: 'indefinite' }));
    svg.appendChild(pupil);
    if (showConf) {
        const conf = mk('text', { x: CX, y: CY, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-weight': 'bold', 'font-family': "'JetBrains Mono', monospace", fill: '#7fe9ff' });
        conf.textContent = '6/9';
        conf.appendChild(mk('animate', { attributeName: 'font-size', values: `${R * 0.11};${R * 0.28};${R * 0.11}`, dur: '6.5s', repeatCount: 'indefinite' }));
        svg.appendChild(conf);
    }
    // registreer kleurbare elementen zodat de bull/bear-knoppen dit oog mee verkleuren
    svg.querySelectorAll('path, circle, ellipse, line').forEach(el => {
        const f = el.getAttribute('fill'), s = el.getAttribute('stroke');
        const kleurbaar = [f, s].some(c => c && ['#00d9ff', '#4fc3f7', '#14f195', '#ff5f7e', '#7fe9ff'].includes(c));
        if (kleurbaar) _allEyeSig.push(el);
    });
    applyEyeSignal();
}

// starmap: één grote ruimte waar je doorheen reist (depth-parallax)
function initStarmap() {
    const cv = document.getElementById('starmap'); if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H, stars, nodes, total;
    function init() {
        W = cv.width = innerWidth; H = cv.height = innerHeight; total = document.body.scrollHeight;
        stars = [...Array(150)].map(() => ({ x: Math.random(), y: Math.random() * total, z: Math.random(), r: Math.random() * 1.3 }));
        nodes = [...Array(28)].map(() => ({ x: Math.random() * W, y: Math.random() * total, vx: (Math.random() - 0.5) * 0.1, p: 0 }));
    }
    init(); addEventListener('resize', init);
    addEventListener('load', init);
    setTimeout(init, 400); setTimeout(init, 1200);
    let _lastFrame = 0;
    (function loop(ts) {
        requestAnimationFrame(loop);
        // throttle naar ~30fps: halveert de renderlast t.o.v. 60fps
        if (ts - _lastFrame < 33) return;
        _lastFrame = ts;
        ctx.clearRect(0, 0, W, H); const sy = scrollY;
        // alleen zichtbare sterren tekenen; vroege continue scheelt veel werk
        for (let i = 0; i < stars.length; i++) {
            const s = stars[i]; const y = s.y - sy * (0.2 + s.z * 0.8);
            if (y < -10 || y > H + 10) continue;
            ctx.globalAlpha = 0.35 + s.z * 0.6; ctx.fillStyle = s.z > 0.6 ? '#9fe4ff' : (s.z > 0.3 ? '#4a7a96' : '#2a4358');
            ctx.beginPath(); ctx.arc(s.x * W, y, s.r * (0.7 + s.z) + 0.3, 0, 6.28); ctx.fill();
        }
        const vis = [];
        for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; const yy = n.y - sy * 0.5; if (yy > -50 && yy < H + 50) vis.push({ x: n.x + (n.p += n.vx), y: yy }); }
        for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
            const dx = vis[i].x - vis[j].x, dy = vis[i].y - vis[j].y, d2 = dx * dx + dy * dy;
            if (d2 < 19600) { ctx.globalAlpha = (1 - Math.sqrt(d2) / 140) * 0.13; ctx.strokeStyle = '#00d9ff'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(vis[i].x, vis[i].y); ctx.lineTo(vis[j].x, vis[j].y); ctx.stroke(); }
        }
        ctx.globalAlpha = 0.55; ctx.fillStyle = '#00d9ff';
        for (let i = 0; i < vis.length; i++) ctx.fillRect(vis[i].x - 1, vis[i].y - 1, 2, 2);
    })();
}

// jump-rail: door de ruimte naar een gloeiende node reizen
function buildJump(id, hue) {
    const svg = document.getElementById(id); if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const CX = 590, CY = 80;
    for (let i = 0; i < 36; i++) {
        const a = Math.random() * Math.PI * 2, r0 = 30 + Math.random() * 25, r1 = 600 + Math.random() * 400;
        const ln = mk('line', { x1: (CX + Math.cos(a) * r0).toFixed(0), y1: (CY + Math.sin(a) * r0 * 0.5).toFixed(0), x2: (CX + Math.cos(a) * r1).toFixed(0), y2: (CY + Math.sin(a) * r1 * 0.5).toFixed(0), stroke: hue, 'stroke-width': (0.5 + Math.random()).toFixed(1), opacity: 0 });
        ln.appendChild(mk('animate', { attributeName: 'opacity', values: '0;0.5;0', dur: (2 + Math.random() * 3).toFixed(1) + 's', begin: (-Math.random() * 4).toFixed(1) + 's', repeatCount: 'indefinite' }));
        svg.appendChild(ln);
    }
    svg.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: 30, ry: 28, fill: 'none', stroke: hue, 'stroke-width': 1, opacity: 0.5 }));
    svg.appendChild(mk('ellipse', { cx: CX, cy: CY, rx: 48, ry: 18, fill: 'none', stroke: hue, 'stroke-width': 0.6, opacity: 0.35 }));
    const core = mk('circle', { cx: CX, cy: CY, r: 14, fill: hue, opacity: 0.18 });
    core.appendChild(mk('animate', { attributeName: 'r', values: '12;18;12', dur: '4s', repeatCount: 'indefinite' }));
    svg.appendChild(core);
    svg.appendChild(mk('circle', { cx: CX, cy: CY, r: 5, fill: hue, opacity: 0.7 }));
    const moon = mk('g');
    moon.appendChild(mk('circle', { cx: CX + 52, cy: CY, r: 3, fill: '#e3f6ff', opacity: 0.8 }));
    moon.appendChild(mk('animateTransform', { attributeName: 'transform', type: 'rotate', from: `0 ${CX} ${CY}`, to: `360 ${CX} ${CY}`, dur: '9s', repeatCount: 'indefinite' }));
    svg.appendChild(moon);
}

// nav scroll-spy + live prijs
function initScrollSpy() {
    // v4-nav: <nav id="scroll-nav"> met <a href="#..."> links; secties zijn de
    // top-level <section id="intro|market|data|engine|hub">.
    const secs = [...document.querySelectorAll('section[id]')];
    const links = [...document.querySelectorAll('#scroll-nav a[href^="#"]')];
    function spy() {
        let cur = secs.length ? secs[0].id : '';
        for (const s of secs) { if (scrollY >= s.offsetTop - 140) cur = s.id; }
        links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + cur));
    }
    addEventListener('scroll', spy); spy();
}

// alles opstarten zodra de DOM klaar is
(function bootLanding() {
    function go() {
        try { buildDecorEye('hero-eye', 150, false); } catch (e) {}
        try { buildDecorEye('engine-eye', 132, false); } catch (e) {}
        try { initStarmap(); } catch (e) {}
        // (v4 gebruikt waypoint-tekst i.p.v. SVG jump-rails)
        try { initScrollSpy(); } catch (e) {}
        try { initFlowHud(); } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
})();



// --- Testnet UI-koppeling (knoppen bestaan alleen als index.html up-to-date is) ---
document.getElementById('testnet-save-keys-btn')?.addEventListener('click', saveTestnetKeysFromInputs);
document.getElementById('testnet-test-btn')?.addEventListener('click', testTestnetConnection);
document.getElementById('testnet-sync-wallet-btn')?.addEventListener('click', syncWalletToTestnetBalance);
// Bij het wisselen naar TESTNET direct een verbindingscheck doen, zodat een
// ontbrekende key of CORS-blokkade meteen zichtbaar is - niet pas bij de
// eerste order die de bot probeert te plaatsen.
document.getElementById('execution-mode')?.addEventListener('change', (e) => {
    if (e.target.value === 'TESTNET') testTestnetConnection();
    else setTestnetStatus('');
});

// --- Adaptive Learning-paneel inklapbaar (zelfde patroon als de engine-config) ---
function toggleLearningPanel() {
    const body = document.getElementById('learning-body');
    const chev = document.getElementById('learning-chevron');
    if (!body) return;
    const open = body.classList.toggle('open');
    if (chev) chev.innerHTML = open ? '&#9662;' : '&#9656;';
}
function toggleCalibPanel() {
    const body = document.getElementById('calib-body');
    const chev = document.getElementById('calib-chevron');
    if (!body) return;
    const dicht = body.style.display === 'none';
    body.style.display = dicht ? 'grid' : 'none';
    if (chev) chev.innerHTML = dicht ? '&#9662;' : '&#9656;';
}

// --- Handmatige trade-knoppen (counterfactuele data, zie openManualPosition) ---
document.getElementById('manual-long-btn')?.addEventListener('click', () => openManualPosition('LONG'));
document.getElementById('manual-short-btn')?.addEventListener('click', () => openManualPosition('SHORT'));
