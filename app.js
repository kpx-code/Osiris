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
    // ---- ICT / Smart-Money cascade (4h bias -> 15m sweep -> 1m MSS -> FVG entry) ----
    ictEnabled: false,               // hoofdschakelaar voor de ICT-cascade
    ictHtfInterval: '4h',            // timeframe voor de directionele bias
    ictSweepInterval: '15m',         // timeframe waarop we liquidity sweeps zoeken
    ictEntryInterval: '1m',          // timeframe voor market-structure-shift + FVG-entry
    ictSweepLookback: 20,            // aantal candles terug voor swing-high/low (sweep-detectie)
    ictSweepValidMinutes: 45,        // hoe lang een sweep geldig blijft om MSS/FVG op af te wachten
    ictSwingLookback: 10,            // aantal candles voor MSS-swingpunten
    ictFvgMinGapPct: 0.03,           // minimale FVG-grootte als % van de prijs (0.03 = 0.03%)
    ictTargetSwingLookback: 15,      // hoever terug we de "nearest swing before the grab" zoeken
    ictMicroTargetPct: 0.15,         // micro-margin doelwinst per trade (0.15%)
    ictMicroStopPct: 0.12,           // krappe stop passend bij micro-targets
    ictUseSvpConfluence: true,       // weeg SVP-context mee in de FVG-kwaliteit
    ictAllocPct: 0.20,               // allocatie per ICT-trade
    isRunning: false
};

// Achtergrond-timeframes voor de ICT-cascade. Deze worden NIET gestreamd maar
// periodiek via REST opgehaald (klines zijn afgeleid van dezelfde trades, dus een
// 4h-candle is geaggregeerde 1m-data). De 4h-bias verandert traag -> elke 5 min;
// de 1m-data voor de MSS -> elke bot-tick (10s) mee. Ruim binnen Binance-limieten
// (klines kost 1-2 gewichtspunten van de 1200/min).
let _ictData = { htf: [], sweep: [], entry: [], lastHtfFetch: 0, lastEntryFetch: 0 };

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
let _testnetFiltersBySymbol = {};   // cache per munt
async function getTestnetSymbolFilters(symbol) {
    const sym = symbol || TESTNET_SYMBOL;
    if (_testnetFiltersBySymbol[sym]) return _testnetFiltersBySymbol[sym];
    // behoud de oude cache voor BTC (backwards-compat)
    if (sym === TESTNET_SYMBOL && testnetSymbolFilters) { _testnetFiltersBySymbol[sym] = testnetSymbolFilters; return testnetSymbolFilters; }
    const info = await testnetWsRequest('exchangeInfo', { symbol: sym });
    const s = info.symbols?.[0];
    const lot = s?.filters?.find(f => f.filterType === 'LOT_SIZE');
    const notional = s?.filters?.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    const filters = {
        stepSize: parseFloat(lot?.stepSize || '0.00001'),
        minQty: parseFloat(lot?.minQty || '0.00001'),
        minNotional: parseFloat(notional?.minNotional || '5'),
        baseAsset: s?.baseAsset || sym.replace('USDT', '')
    };
    _testnetFiltersBySymbol[sym] = filters;
    if (sym === TESTNET_SYMBOL) testnetSymbolFilters = filters;
    return filters;
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
    // munt-bewust: gebruik het meegegeven symbool (ETHUSDT/SOLUSDT) of standaard BTC.
    // Zo handelt Neo met dezelfde nepgeld-wallet op meerdere testnet-markten.
    const symbol = (opts && opts.symbol) ? opts.symbol : TESTNET_SYMBOL;
    const params = { symbol, side: orderSide, type: 'MARKET', newOrderRespType: 'FULL' };
    if (opts.quoteOrderQty != null) params.quoteOrderQty = opts.quoteOrderQty.toFixed(2);
    if (opts.quantity != null) params.quantity = String(opts.quantity);
    return testnetWsRequest('order.place', params, true);
}

// Gewogen gemiddelde fill-prijs + commissie (omgerekend naar USDT) uit een
// orderrespons. Commissie kan in USDT, BTC of BNB luiden; BNB is op het
// testnet zeldzaam en wordt conservatief op 0 gezet met een waarschuwing.
function summarizeTestnetFills(orderResponse, baseAsset) {
    const fills = orderResponse.fills || [];
    const base = baseAsset || 'BTC';
    let qty = 0, cost = 0, commissionQuote = 0;
    for (const f of fills) {
        const fQty = parseFloat(f.qty), fPrice = parseFloat(f.price), comm = parseFloat(f.commission || '0');
        qty += fQty; cost += fQty * fPrice;
        if (f.commissionAsset === 'USDT') commissionQuote += comm;
        else if (f.commissionAsset === base) commissionQuote += comm * fPrice;
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
        const usdtFloor = Math.floor(usdt * 100) / 100;   // NOOIT naar boven afronden (anders > saldo)
        const input = prompt(
            `Vrij testnet-saldo: ${usdt.toFixed(2)} USDT (en ${(bal.BTC || 0).toFixed(5)} BTC voor shorts).\n\n` +
            `Hoeveel USDT mag de bot als startkapitaal gebruiken?`,
            usdtFloor.toFixed(2)
        );
        if (input === null) { setTestnetStatus('Sync geannuleerd.'); return; }
        // komma-decimaal en spaties toestaan (NL-toetsenbord), en nooit meer dan het saldo
        let capital = parseFloat(String(input).replace(/\s/g, '').replace(',', '.'));
        if (isNaN(capital) || capital <= 0) { setTestnetStatus('Ongeldig bedrag - sync geannuleerd.', true); return; }
        if (capital > usdt) capital = usdtFloor;   // klem op het vrije saldo i.p.v. annuleren
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
let adaptiveWeights = { confluence: 1.0, nodeInfluence: 1.0, momentumInfluence: 1.0, fibConfluence: 1.0, pattern: 1.0, rsi: 1.0, ema: 1.0, cnn: 1.0, nn: 2.0, nodeconf: 2.0 };
let learningLog = []; // { timestampMs, side, factors: {confluence, nodeInfluence, momentumInfluence, fibConfluenceInfluence, probabilityPct}, outcome: 'win'|'loss', pnlPct }

// NETWERK-FOUTEN LOG (18-08): legt elk moment vast waarop een netwerk/verbinding faalt
// (bv. geen internet). Gemarkeerd met online/offline-status uit navigator.onLine.
let osirisNetworkErrors = [];
function logNetworkError(context, msg) {
    try {
        const online = (typeof navigator !== 'undefined') ? navigator.onLine : true;
        const rec = { ts: Date.now(), context, msg: String(msg || '').slice(0, 220), online };
        osirisNetworkErrors.unshift(rec); if (osirisNetworkErrors.length > 300) osirisNetworkErrors.pop();
        try { localStorage.setItem('osirisNetworkErrors', JSON.stringify(osirisNetworkErrors.slice(0, 150))); } catch (e) {}
        console.warn(`[NETWERK] ${context}: ${rec.msg}${online ? '' : ' (OFFLINE)'}`);
        try { if (typeof logBotAction === 'function') logBotAction('NET-ERROR', 0, '-', 0, 0, `${context}: ${rec.msg}${online ? '' : ' - GEEN INTERNET'}`); } catch (e) {}
        try { if (typeof marginState !== 'undefined') { marginState.reasoning.unshift({ ts: Date.now(), txt: `\u26a0 netwerk: ${context}${online ? '' : ' - GEEN INTERNET'}` }); if (marginState.reasoning.length > 40) marginState.reasoning.pop(); } } catch (e) {}
    } catch (e) {}
}
window.logNetworkError = logNetworkError; window.osirisNetworkErrors = osirisNetworkErrors;
try { osirisNetworkErrors = JSON.parse(localStorage.getItem('osirisNetworkErrors') || '[]'); } catch (e) {}
try {
    window.addEventListener('offline', () => logNetworkError('verbinding', 'internetverbinding verbroken (offline)'));
    window.addEventListener('online', () => logNetworkError('verbinding', 'internetverbinding hersteld (online)'));
} catch (e) {}let lastReallocationAt = 0; // timestamp (ms) van de laatste reallocatie - voor de cooldown-poort in tryReallocateForBetterOpportunity
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
let _calibProvisional = false; // true zodra de curve op een kleine steekproef leunt
let MIN_SAMPLE_SIZE = 10; // minimaal aantal trades per groep (autonoom bijstelbaar door Osiris)
let adaptiveWeightsMeta = {}; // per markt: { lastUpdate, trades, nextIn, adjusted }
try { window.adaptiveWeightsMeta = adaptiveWeightsMeta; } catch (e) {}
let osirisLearningFeed = [];
function logLearningEvent(txt) {
    try {
        osirisLearningFeed.unshift({ ts: Date.now(), txt }); if (osirisLearningFeed.length > 60) osirisLearningFeed.pop();
        try { localStorage.setItem('osirisLearningFeed', JSON.stringify(osirisLearningFeed.slice(0, 40))); } catch (e) {}
        const el = document.getElementById('cortex-autofeed');
        if (el) el.innerHTML = osirisLearningFeed.slice(0, 30).map(r => `<div>${new Date(r.ts).toLocaleTimeString('nl-NL')} \u00b7 ${r.txt}</div>`).join('');
    } catch (e) {}
}
window.logLearningEvent = logLearningEvent;
try { osirisLearningFeed = JSON.parse(localStorage.getItem('osirisLearningFeed') || '[]'); } catch (e) {}
// Autonome drempel: bij veel data verlaagt Osiris de drempel (sneller leren), bij weinig/
// ruizige data verhoogt hij 'm (voorzichtiger). Blijft tussen 8 en 25.
let _lastThreshTune = 0;
function osirisTuneLearningThreshold() {
    try {
        const now = Date.now(); if (now - _lastThreshTune < 10 * 60000) return; _lastThreshTune = now;
        const clean = learningLog.filter(l => !l.manual && l.factors && l.outcome).length;
        const old = MIN_SAMPLE_SIZE; let nv = old;
        if (clean >= 120 && MIN_SAMPLE_SIZE < 25) nv = Math.min(25, MIN_SAMPLE_SIZE + 2);
        else if (clean < 40 && MIN_SAMPLE_SIZE > 8) nv = Math.max(8, MIN_SAMPLE_SIZE - 1);
        if (nv !== old) { MIN_SAMPLE_SIZE = nv; logLearningEvent(`Osiris stelt L1-drempel bij: ${old} \u2192 ${nv} trades (${clean} schone trades beschikbaar)`); try { recalibrateAdaptiveWeights(); } catch (e) {} }
    } catch (e) {}
}
window.osirisTuneLearningThreshold = osirisTuneLearningThreshold;
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
    rightPriceScale: {
        visible: true,              // prijsschaal rechts
        borderVisible: true,
        borderColor: '#2a2e3e',
        scaleMargins: { top: 0.08, bottom: 0.12 },
    },
    timeScale: {
        timeVisible: true,          // tijdschaal onderaan
        secondsVisible: false,
        visible: true,
        borderVisible: true,
        borderColor: '#2a2e3e',
    },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
});

// Houd het SVP/COB-paneel uitgelijnd met de chart: bij elke zoom/pan opnieuw
// tekenen zodat de prijsniveaus exact met de candles meelopen.
try {
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (typeof renderDepthPanel === 'function') renderDepthPanel();
    });
} catch (e) { /* oudere chart-versie zonder deze API - paneel valt terug op eigen schaal */ }

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

// HEADLESS INDICATOREN (01-08): EMA/MA en RSI worden nu ALTIJD berekend uit de
// kline-data, los van of de indicator zichtbaar is op de chart. Voorheen las de
// EMA-invloed 'maCurrentValue', maar die werd nergens gezet -> EMA deed feitelijk
// niet mee. En RSI-render hing van showRSI af. Nu rekent Neo altijd door, ook als de
// gebruiker vergeet de indicator zichtbaar te maken. Cruciaal voor multi-crypto:
// elke munt heeft zijn eigen headless EMA/RSI, onafhankelijk van de zichtbare chart.
let maCurrentValue = null;       // laatste snelle MA-waarde (headless)
let maSlowCurrentValue = null;   // laatste trage MA-waarde (headless)
let rsiCurrentValue = null;      // laatste RSI-waarde (headless)
function computeHeadlessIndicators(kl) {
    const src = kl || rawData;
    if (!src || src.length < 3) return;
    const closes = src.map(d => parseFloat(d[4]));
    // MA/EMA (snel + traag) - onafhankelijk van showMovingAverage
    if (closes.length >= maFastPeriod) {
        const f = calculateSMA(closes, maFastPeriod);
        maCurrentValue = f.length ? f[f.length - 1] : null;
    }
    if (closes.length >= maSlowPeriod) {
        const s = calculateSMA(closes, maSlowPeriod);
        maSlowCurrentValue = s.length ? s[s.length - 1] : null;
    }
    // RSI - onafhankelijk van showRSI
    if (closes.length >= rsiPeriod + 1) {
        const series = calculateRSISeries(closes, rsiPeriod);
        rsiCurrentValue = series.length ? series[series.length - 1].rsi : null;
    }
}

function renderMovingAverage() {
    computeHeadlessIndicators();   // altijd eerst de waarden bijwerken (ook als verborgen)
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
        'min-loss-early-exit': 0.8, 'continuation-confirmation-sec': 10, 'profit-protect-activation': 0.5, 'profit-protect-keep': 80,
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
        'min-loss-early-exit': 0.6, 'continuation-confirmation-sec': 30, 'profit-protect-activation': 0.6, 'profit-protect-keep': 85,
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
        'min-loss-early-exit': 0.8, 'continuation-confirmation-sec': 20, 'profit-protect-activation': 0.5, 'profit-protect-keep': 80,
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

    // ICT staat standaard UIT bij elk preset - de gebruiker zet hem bewust aan
    // wanneer hij de cascade wil testen.
    const ictEl = document.getElementById('ict-enabled');
    if (ictEl) ictEl.value = 'false';

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
    // headless: altijd berekend, ongeacht of RSI zichtbaar is op de chart
    if (rsiCurrentValue != null) return rsiCurrentValue;
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

// ============================================================
// VEERKRACHTIGE BINANCE-FETCH met host-fallback (13-08)
// api.binance.com / fapi.binance.com kunnen door DNS- of regioblokkade
// onbereikbaar zijn (ERR_NAME_NOT_RESOLVED). bFetch probeert dan automatisch
// alternatieve Binance-mirrors die vaak wel resolven. Non-binance URLs gaan
// gewoon via de normale fetch. Signatuur == fetch(url, opts) -> Promise<Response>.
// ============================================================
const _BINANCE_HOSTS = {
    'api.binance.com': ['api.binance.com', 'api-gcp.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com', 'api4.binance.com', 'data-api.binance.vision'],
    'fapi.binance.com': ['fapi.binance.com', 'fapi1.binance.com', 'fapi2.binance.com']
};
const _binanceGoodHost = {};   // onthoudt per familie de laatst werkende mirror
async function bFetch(url, opts) {
    let fam = null;
    for (const key of Object.keys(_BINANCE_HOSTS)) { if (typeof url === 'string' && url.indexOf('https://' + key) === 0) { fam = key; break; } }
    if (!fam) return fetch(url, opts);   // geen binance-url -> normale fetch
    const hosts = _BINANCE_HOSTS[fam].slice();
    const good = _binanceGoodHost[fam];
    if (good) hosts.sort((a, b) => (a === good ? -1 : b === good ? 1 : 0)); // bekende goede host eerst
    let lastErr = null, lastRes = null;
    for (const h of hosts) {
        const u = url.replace('https://' + fam, 'https://' + h);
        try {
            const res = await fetch(u, opts);
            if (res.ok) { _binanceGoodHost[fam] = h; return res; }
            lastRes = res;                // niet-ok (bv. 451/5xx): probeer volgende mirror
        } catch (e) { lastErr = e; }      // netwerk/DNS: probeer volgende mirror
    }
    if (lastRes) return lastRes;          // geef laatste (niet-ok) response terug -> caller checkt r.ok
    throw lastErr || new Error('binance fetch faalde op alle mirrors');
}
window.bFetch = bFetch;

async function fetchEurUsdtRate() {
    try {
        const res = await bFetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT');
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
        // migratie: oude opgeslagen gewichten misten rsi/ema/cnn - vul ze aan op 1.0
        for (const k of ['confluence','nodeInfluence','momentumInfluence','fibConfluence','pattern','rsi','ema','cnn'])
            if (adaptiveWeights[k] == null) adaptiveWeights[k] = 1.0;
        if (adaptiveWeights.nn == null) adaptiveWeights.nn = 2.0;
        if (adaptiveWeights.nodeconf == null) adaptiveWeights.nodeconf = 2.0;
        // 31-07: regime-specifieke gewichten herstellen
        try { const rw = localStorage.getItem('osirisRegimeWeights'); if (rw) regimeWeights = JSON.parse(rw); } catch (e) {}
        computeCalibrationMap(); // pas NA het herstellen van alle state - zodat een
                                 // fout hier nooit meer een herstel-regel kan blokkeren
        // 29-07: teken de curve ook meteen bij het laden (de DOM is er mogelijk nog
        // niet, dus met een kleine vertraging + retry). Zonder dit bleef de chart
        // leeg tot de VOLGENDE trade sloot, ook al was er ruim genoeg historie.
        setTimeout(() => { try { renderCalibrationCurve(); } catch (e) {} }, 600);
        setTimeout(() => { try { computeCalibrationMap(); renderCalibrationCurve(); } catch (e) {} }, 2000);
    } catch (e) { console.warn("Kon wallet/positie-status niet laden:", e); }
}

// TDZ-FIX: loadPersistentState() -> computeCalibrationMap() gebruikt deze vlag al bij
// het opstarten, dus hij moet VOOR de aanroep gedeclareerd staan (stond op ~4362).
let _calibCurrentVersionOnly = false;   // toon ALLE trades (elke versie) - kalibratie accumuleert de hele historie
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
    setVal('ict-enabled', String(s.ictEnabled ?? false));
    setVal('ict-htf-interval', s.ictHtfInterval ?? '4h');
    setVal('ict-sweep-interval', s.ictSweepInterval ?? '15m');
    setVal('ict-entry-interval', s.ictEntryInterval ?? '1m');
    setVal('ict-sweep-lookback', s.ictSweepLookback ?? 20);
    setVal('ict-sweep-valid', s.ictSweepValidMinutes ?? 45);
    setVal('ict-swing-lookback', s.ictSwingLookback ?? 10);
    setVal('ict-fvg-min-gap', s.ictFvgMinGapPct ?? 0.03);
    setVal('ict-target-swing-lookback', s.ictTargetSwingLookback ?? 15);
    setVal('ict-micro-target', s.ictMicroTargetPct ?? 0.15);
    setVal('ict-micro-stop', s.ictMicroStopPct ?? 0.12);
    setVal('ict-use-svp', String(s.ictUseSvpConfluence ?? true));
    setVal('ict-alloc-pct', ((s.ictAllocPct ?? 0.20) * 100).toFixed(0));
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
    try { backfillOsirisLearning(); } catch (e) {}
    renderLearningPanel();
    try { OsirisDeepNet.startService(); updateDeepNetPanel(); } catch (e) {}
    if (isBotRunning) {
        startAutonomousBot(true); // true = herstart
    }
    // Multi-markt trading-schakelaar herstellen (was vluchtig en resette bij elke
    // reload/afsluiten). osirisShadowTick heeft de draaiende multi-engine nodig,
    // die start hierboven mee met de bot-herstart.
    try {
        if (localStorage.getItem('osirisLiveEnabled') !== 'false') {   // standaard AAN; alleen uit als je 'm bewust uitzet
            const cb = document.getElementById('osiris-shadow-toggle');
            if (cb) cb.checked = true;
            toggleOsirisShadow(true);
        }
    } catch (e) {}
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
    // ---- ICT / Smart-Money cascade ----
    const ictEn = document.getElementById('ict-enabled');
    if (ictEn) botSettings.ictEnabled = ictEn.value === 'true';
    const ictHtf = document.getElementById('ict-htf-interval');
    if (ictHtf) botSettings.ictHtfInterval = ictHtf.value;
    const ictSweepIv = document.getElementById('ict-sweep-interval');
    if (ictSweepIv) botSettings.ictSweepInterval = ictSweepIv.value;
    const ictEntryIv = document.getElementById('ict-entry-interval');
    if (ictEntryIv) botSettings.ictEntryInterval = ictEntryIv.value;
    const ictSwVal = document.getElementById('ict-sweep-valid');
    if (ictSwVal && !isNaN(parseInt(ictSwVal.value))) botSettings.ictSweepValidMinutes = Math.max(5, parseInt(ictSwVal.value));
    const ictSwLb = document.getElementById('ict-sweep-lookback');
    if (ictSwLb && !isNaN(parseInt(ictSwLb.value))) botSettings.ictSweepLookback = Math.max(5, parseInt(ictSwLb.value));
    const ictSwingLb = document.getElementById('ict-swing-lookback');
    if (ictSwingLb && !isNaN(parseInt(ictSwingLb.value))) botSettings.ictSwingLookback = Math.max(3, parseInt(ictSwingLb.value));
    const ictFvg = document.getElementById('ict-fvg-min-gap');
    if (ictFvg && !isNaN(parseFloat(ictFvg.value))) botSettings.ictFvgMinGapPct = Math.max(0, parseFloat(ictFvg.value));
    const ictTgtLb = document.getElementById('ict-target-swing-lookback');
    if (ictTgtLb && !isNaN(parseInt(ictTgtLb.value))) botSettings.ictTargetSwingLookback = Math.max(3, parseInt(ictTgtLb.value));
    const ictMt = document.getElementById('ict-micro-target');
    if (ictMt && !isNaN(parseFloat(ictMt.value))) botSettings.ictMicroTargetPct = Math.max(0.05, parseFloat(ictMt.value));
    const ictMs = document.getElementById('ict-micro-stop');
    if (ictMs && !isNaN(parseFloat(ictMs.value))) botSettings.ictMicroStopPct = Math.max(0.05, parseFloat(ictMs.value));
    const ictSvp = document.getElementById('ict-use-svp');
    if (ictSvp) botSettings.ictUseSvpConfluence = ictSvp.value === 'true';
    const ictAlloc = document.getElementById('ict-alloc-pct');
    if (ictAlloc && !isNaN(parseFloat(ictAlloc.value))) botSettings.ictAllocPct = Math.min(Math.max(parseFloat(ictAlloc.value) / 100, 0.01), 0.7);
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

    // Multi-markt shadow-trading (ETH/SOL) AAN zodra de bot draait. Zonder dit krijgt
    // Osiris wel een allocatie (bv. SOL/ETH 50/50) maar voert osirisShadowTick NIETS uit
    // (`if (!osirisLiveEnabled) return;`), en handelt de bot alleen BTC via de hoofd-engine.
    // We forceren AAN én overschrijven een eventueel op 'false' blijven hangen localStorage.
    osirisLiveEnabled = true;
    try { localStorage.setItem('osirisLiveEnabled', 'true'); } catch (e) {}
    try { const _shadowCb = document.getElementById('osiris-shadow-toggle'); if (_shadowCb) _shadowCb.checked = true; } catch (e) {}
    // Reset een eventueel vastgelopen circuit breaker bij elke start. Zonder recente
    // Osiris-trades kon die zichzelf nooit hervatten en blokkeerde hij ETH/SOL stil.
    try { if (typeof OsirisGuard !== 'undefined' && OsirisGuard.pausedMarkets && Object.keys(OsirisGuard.pausedMarkets).length) { OsirisGuard.pausedMarkets = {}; if (OsirisGuard._persist) OsirisGuard._persist(); try { logAdaptation('Circuit breaker: gereset bij start', 'vastgelopen pauze(s) opgeheven zodat ETH/SOL kunnen instappen'); } catch (e) {} } } catch (e) {}

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
    // AUTONOME ENGINE-AANPASSING (01-08): Neo herziet bij de start zijn eigen
    // engine-instellingen tegen de data en past ze waar nodig autonoom aan voor
    // betere winstkansen. Ook periodiek (elke 30 min) zodat hij mee-evolueert.
    setTimeout(() => { try { autonomousEngineAdapt('start'); } catch (e) {} }, 3000);
    if (window._engineAdapt) clearInterval(window._engineAdapt);
    window._engineAdapt = setInterval(() => { try { autonomousEngineAdapt('periodiek'); autonomousPresetAdaptAll(); } catch (e) {} }, 30 * 60 * 1000);
    // MULTI-ASSET (fase 2): start de achtergrond-scan van BTC/ETH/SOL voor de tabs.
    try { startMultiAssetEngine(); } catch (e) {}
    // Level 2: train het model bij de start (en elke 30 min opnieuw) op historische
    // candles + schone trades, zodat de gekalibreerde kans meegroeit met de data.
    l2BuildAndTrain().then(r => { if (r && r.ok) console.log(`Level 2 getraind op ${r.samples} samples (${r.trades} echte trades).`); });
    if (window._l2Retrain) clearInterval(window._l2Retrain);
    window._l2Retrain = setInterval(() => { l2BuildAndTrain(); }, 30 * 60 * 1000);
    // OSIRIS DEEPNET draait als achtergrond-service (idempotent; niets aanzetten nodig)
    try { OsirisDeepNet.startService(); } catch (e) {}
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
let _activeLearningBrain = 'OSIRIS';
function switchLearningBrain(sym) {
    _activeLearningBrain = sym;
    document.querySelectorAll('.learning-tab').forEach(b => b.classList.toggle('active', b.dataset.brain === sym));
    renderLearningPanel();
}
window.switchLearningBrain = switchLearningBrain;

function renderLearningPanel() {
    const el = document.getElementById('learning-panel');
    if (!el) return;
    const brain = _activeLearningBrain || 'BTC';

    const labels = {
        confluence: 'Confluence', nodeInfluence: 'Node-invloed',
        momentumInfluence: 'Momentum-invloed', fibConfluenceInfluence: 'Fib-confluentie',
        patternInfluence: 'Patroon/structuur',
        rsiInfluence: 'RSI-invloed', emaInfluence: 'EMA-invloed', cnnInfluence: 'CNN multi-candle',
        nnInfluence: "Neo's Node (NN)", nodeconfInfluence: 'Node-confluentie'
    };
    const weightKeys = { confluence: 'confluence', nodeInfluence: 'nodeInfluence', momentumInfluence: 'momentumInfluence', fibConfluenceInfluence: 'fibConfluence', patternInfluence: 'pattern', rsiInfluence: 'rsi', emaInfluence: 'ema', cnnInfluence: 'cnn', nnInfluence: 'nn', nodeconfInfluence: 'nodeconf' };

    // Kies de juiste databron per brein:
    // - BTC: de bewezen hoofd-engine (adaptiveWeights + volledige learningLog).
    // - ETH/SOL: het sub-brein (eigen weights + eigen trades uit botTradeLog).
    // - OSIRIS: de mainbrain - toont het gemiddelde/overzicht van de drie sub-breinen.
    let weightsSrc = adaptiveWeights;
    let brainTrades = learningLog.filter(l => l.market == null || l.market === 'BTC');
    let brainColor = '#f7931a', brainName = 'Neo BTC';
    if (brain === 'ETH' || brain === 'SOL') {
        const m = neoMultiState.markets[brain];
        const b = m && m.brain;
        weightsSrc = (b && b.weights) ? b.weights : {};
        brainTrades = learningLog.filter(l => l.market === brain);
        brainColor = brain === 'ETH' ? '#627eea' : '#14f195';
        brainName = b ? b.label : 'Neo ' + brain;
    } else if (brain === 'OSIRIS') {
        // Osiris toont het gemiddelde gewicht over de drie sub-breinen (mainbrain-overzicht)
        brainColor = '#00d9ff'; brainName = 'Osiris Mainbrain';
        const brains = ['BTC', 'ETH', 'SOL'].map(s => s === 'BTC' ? adaptiveWeights : (neoMultiState.markets[s] && neoMultiState.markets[s].brain && neoMultiState.markets[s].brain.weights) || {});
        weightsSrc = {};
        for (const wk of Object.values(weightKeys)) {
            const vals = brains.map(w => w[wk] != null ? w[wk] : 1.0);
            weightsSrc[wk] = vals.reduce((a, v) => a + v, 0) / vals.length;
        }
        brainTrades = learningLog;   // alle markten samen
    }

    const totalTrades = brainTrades.length;
    const sumW = Object.keys(labels).reduce((a, fk) => a + ((weightsSrc[weightKeys[fk]] != null) ? weightsSrc[weightKeys[fk]] : 1.0), 0);
    const osirisNote = brain === 'OSIRIS' ? ' Osiris toont het gemiddelde over de drie sub-breinen.' : '';
    let html = `<div style="font-size:0.72em; color:var(--text-dim); margin-bottom:10px;"><span style="color:${brainColor}; font-weight:700;">${brainName}</span> &middot; gebaseerd op ${totalTrades} trade(s). Elk percentage = het aandeel van die factor in de opbouw van de beslissing (contrafeitelijk geleerd).${osirisNote} ${(() => {
        try {
            const meta = (typeof adaptiveWeightsMeta !== 'undefined') ? adaptiveWeightsMeta[brain === 'OSIRIS' ? 'BTC' : brain] : null;
            const upd = meta && meta.lastUpdate ? new Date(meta.lastUpdate).toLocaleTimeString('nl-NL') : 'nog niet';
            const need = Math.max(0, MIN_SAMPLE_SIZE - totalTrades);
            const nextTxt = need > 0 ? `<b style="color:var(--amber)">nog ${need} trade(s)</b> tot de eerste bijstelling` : `<b style="color:#14f195">bijstelling actief</b> (drempel ${MIN_SAMPLE_SIZE})`;
            return `<br><span style="color:var(--dim);">Laatst bijgewerkt: <b>${upd}</b> &middot; ${nextTxt} &middot; drempel ${MIN_SAMPLE_SIZE} trades.</span>`;
        } catch (e) { return `Minimaal ${MIN_SAMPLE_SIZE} trades nodig voor bijstelling.`; }
    })()}</div>`;
    try { html += deepNetLearningHtml(); } catch (e) {}
    html += `<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px;">`;

    Object.keys(labels).forEach(fk => {
        const wKey = weightKeys[fk];
        const weight = (weightsSrc[wKey] != null) ? weightsSrc[wKey] : 1.0;
        const pct = sumW > 0 ? (weight / sumW * 100) : 0;
        const s = (brain === 'BTC' && lastCalibrationSummary) ? lastCalibrationSummary.summary[fk] : null;
        const n = s ? (s.n != null ? s.n : ((s.nPresent||0)+(s.nAbsent||0))) : 0;
        const avgPct = 100 / Object.keys(labels).length;
        const weightColor = pct > avgPct * 1.15 ? 'var(--teal)' : (pct < avgPct * 0.85 ? '#8899aa' : 'var(--text-primary)');
        const barW = Math.min(100, pct / (avgPct * 2) * 100);

        html += `<div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.08); padding:10px 12px;">
            <div style="font-size:0.7em; color:var(--text-dim); margin-bottom:4px;">${labels[fk]}</div>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:700; color:${weightColor}; font-size:1.05em;">${pct.toFixed(1)}%</div>
            <div style="height:4px; background:rgba(255,255,255,0.06); border-radius:2px; margin:5px 0 4px; overflow:hidden;"><div style="height:100%; width:${barW}%; background:${weightColor}; border-radius:2px;"></div></div>
            <div style="font-size:0.6em; color:var(--text-dimmer);">gewicht ${weight.toFixed(2)}x`;
        if (s && s.adjusted) {
            html += ` &middot; winst hoog/laag: ${(s.winRatePresent * 100).toFixed(0)}%/${(s.winRateAbsent * 100).toFixed(0)}% (n=${n})`;
        } else if (brain === 'BTC') {
            html += ` &middot; n=${n} (nog geen bijstelling)`;
        } else {
            html += ` &middot; sub-brein preset`;
        }
        html += `</div></div>`;
    });
    html += `</div>`;

    // KALIBRATIETABEL: alleen voor het gekozen brein (trades van die markt).
    // VERSIE-FILTER: standaard alleen de huidige config-versie, consistent met de curve,
    // zodat oude gebroken-versie-trades het beeld niet vertekenen (jouw n=373 was de
    // volledige historie over alle versies).
    const _curVer = (typeof currentConfigVersion === 'function') ? currentConfigVersion() : null;
    const _verOk = l => (typeof _calibCurrentVersionOnly === 'undefined' || !_calibCurrentVersionOnly) || l.configVersion == null || l.configVersion === _curVer;
    const withProb = brainTrades.filter(l => !l.manual && (l.entryProbabilityPct != null || (l.factors && l.factors.probabilityPct != null)) && _verOk(l));
    const _allVerCount = brainTrades.filter(l => !l.manual && (l.entryProbabilityPct != null || (l.factors && l.factors.probabilityPct != null))).length;
    if (withProb.length >= 10) {
        const buckets = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
        // "last updated" tijdstempel + versie-info
        const upd = (typeof _lastCalibUpdateMs !== 'undefined' && _lastCalibUpdateMs) ? new Date(_lastCalibUpdateMs) : null;
        const updTxt = upd ? `${String(upd.getDate()).padStart(2,'0')}-${String(upd.getMonth()+1).padStart(2,'0')} ${String(upd.getHours()).padStart(2,'0')}:${String(upd.getMinutes()).padStart(2,'0')}:${String(upd.getSeconds()).padStart(2,'0')}` : 'nog geen update deze sessie';
        const verNote = (typeof _calibCurrentVersionOnly !== 'undefined' && _calibCurrentVersionOnly && _allVerCount > withProb.length) ? ` &middot; huidige versie (${withProb.length} van ${_allVerCount} totaal)` : '';
        html += `<div style="display:flex; justify-content:space-between; align-items:baseline; margin:14px 0 6px; flex-wrap:wrap; gap:4px;">
            <span style="font-size:0.7em; color:var(--text-dim);">Kalibratie: voorspelde winkans vs. werkelijkheid (n=${withProb.length}${verNote})</span>
            <span style="font-size:0.6em; color:var(--text-dimmer);">last updated ${updTxt}</span>
        </div>`;
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
    } else {
        html += `<div style="font-size:0.66em; color:var(--text-dimmer); margin:14px 0 6px;">Kalibratietabel verschijnt vanaf ~10 trades voor dit brein (nu ${withProb.length}${_allVerCount > withProb.length ? `, ${_allVerCount} over alle versies` : ''}).</div>`;
    }

    // Het counterfactuele handmatige-trades blok en de export-knoppen tonen we alleen
    // voor BTC (de hoofd-engine); voor de sub-breinen is dat niet van toepassing.
    if (brain !== 'BTC') { el.innerHTML = html; return; }
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
    // stop ook de multi-markt engine (en de watchdog laat hem uit zolang de bot uit staat)
    try { stopMultiAssetEngine(); } catch (e) {}

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

// Geeft de live-prijs voor een specifieke positie. BTC-posities (en alles zonder
// eigen symbool) gebruiken de globale livePrice; Osiris ETH/SOL-posities gebruiken de
// prijs van HUN markt uit de multi-asset motor. Voorkomt de bug waarbij een ETH-positie
// tegen de BTC-prijs werd afgerekend (absurde P/L zoals +3263%).
function priceForPosition(p) {
    try {
        if (p && p.isOsiris && p.symbol && typeof MULTI_BINANCE !== 'undefined') {
            const symKey = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === p.symbol);
            const m = symKey ? neoMultiState.markets[symKey] : null;
            if (m && m.lastPrice != null) return m.lastPrice;
        }
    } catch (e) {}
    return livePrice;
}
window.priceForPosition = priceForPosition;

// Robuuste alloc-% berekening: gebruik de opgeslagen waarde als die er is, anders
// leid het af uit de notional t.o.v. de huidige equity. Zo toont een positie nooit
// 0% terwijl er wel een omvang is (ook voor oudere posities zonder opgeslagen alloc).
function positionAllocPct(p) {
    // ECHTE fractie van de gedeelde wallet - consistent met getAllocatedPct().
    // osirisAllocPct (Osiris' conviction) is een ANDER concept en wordt apart getoond.
    if (p.sizePct != null && p.sizePct > 0) return p.sizePct * 100;
    const eq = (typeof getEquity === 'function') ? getEquity() : (walletState.balance || 1000);
    if (eq > 0 && p.notional) return Math.min(100, p.notional / eq * 100);
    if (p.osirisAllocPct != null && p.osirisAllocPct > 0) return p.osirisAllocPct * 100; // laatste fallback
    return 0;
}
window.positionAllocPct = positionAllocPct;

// TYPE-LABELS: elke positie/trade heeft twee facetten die de breinen kunnen
// gebruiken om per herkomst en per strategie te leren:
//   herkomst  = BOT (hoofd-engine) / OSIRIS (multi-markt ETH/SOL) / MANUAL
//   strategie = TREND / SCALP / ICT
// Werkt zowel op een open-positie-object als op een gesloten-trade-entry (zelfde flags).
function typeFacetsFromFlags(f) {
    const origin = f.isManual ? { l: 'MANUAL', c: '#ffb627' }
                 : f.isOsiris ? { l: 'OSIRIS', c: '#00d9ff' }
                 : { l: 'BOT', c: '#4287f5' };
    const strat  = f.isIct   ? { l: 'ICT',   c: '#ff8fab' }
                 : f.isScalp ? { l: 'SCALP', c: '#c678dd' }
                 : { l: 'TREND', c: '#4287f5' };
    return { origin, strat };
}
window.typeFacetsFromFlags = typeFacetsFromFlags;


function getUnrealizedPnL() {
    const costFrac = roundTripCostPct() / 100;
    return openPositions.reduce((sum, p) => {
        const px = priceForPosition(p);
        if (!px) return sum;
        const grossPct = p.side === 'LONG'
            ? (px - p.entryPrice) / p.entryPrice
            : (p.entryPrice - px) / p.entryPrice;
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
    try { localStorage.removeItem('osirisSessionLog'); } catch (e) {}   // learningLog NIET wissen: dat is de kalibratie-/leerhistorie die moet accumuleren
    try { updateWalletUI(); updatePendingOrdersUI(); syncWalletLive(); } catch (e) {}
    try { renderOsirisShadowPanel(); } catch (e) {}
    try { console.log(`Wallet gereset naar ${walletSymbol()}${walletState.startingCapital} (${walletState.currency})`); } catch (e) { console.log('Wallet gereset.'); }
}
window.resetWallet = resetWallet;

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

    // FUNDAMENTALS + CROSS-MARKET (van de actieve munt): funding, long/short, open interest, BTC-correlatie
    try {
        const sym = (typeof neoMultiState !== 'undefined' && neoMultiState) ? neoMultiState.active : 'BTC';
        const m = neoMultiState.markets[sym];
        const f = m && m.fund;
        if (f && (f.fundingRate != null || f.longShortRatio != null)) {
            const parts = [];
            if (f.fundingRate != null) parts.push(`funding ${(f.fundingRate*100).toFixed(4)}% (${f.fundingRate > 0.0003 ? 'longs betalen \u2192 contrair bearish' : f.fundingRate < -0.0003 ? 'shorts betalen \u2192 contrair bullish' : 'neutraal'})`);
            if (f.longShortRatio != null) parts.push(`L/S ${f.longShortRatio.toFixed(2)}`);
            if (f.openInterest != null && f.oiPrev != null) { const chg = (f.openInterest - f.oiPrev) / f.oiPrev * 100; parts.push(`OI ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`); }
            if (sym !== 'BTC' && f.btcCorr != null) parts.push(`BTC-corr ${(f.btcCorr*100).toFixed(0)}%`);
            const fb = (typeof fundamentalsBias === 'function') ? fundamentalsBias(sym) : null;
            const biasTxt = fb ? ` \u2192 bias ${fb.bias >= 0 ? '+' : ''}${fb.bias.toFixed(2)}` : '';
            lines.push(`FUNDAMENTALS · ${parts.join(' \u00b7 ')}${biasTxt}`);
        }
    } catch (e) {}

    // LEVEL 3 (getraind net): alleen als het actief meebeslist
    try {
        if (_l3 && _l3.trained && _l3.valAcc != null && _l3.valAcc > 0.52) {
            const p3 = l3Predict(rawData, rawData.length - 1);
            if (p3 != null) lines.push(`NEURAAL NET (L3) · voorspelt LONG-kans ${(p3*100).toFixed(0)}% \u00b7 validatie ${(_l3.valAcc*100).toFixed(0)}% \u00b7 weegt ${(Math.max(0,Math.min(1,(_l3.valAcc-0.52)/0.13))*l3WeightCap().cap*100).toFixed(0)}% mee (cap ${(l3WeightCap().cap*100)|0}% bij ${l3WeightCap().n} schone trades)`);
        }
    } catch (e) {}

    // MULTI-MARKT (Osiris regie): welke munt heeft de beste kans nu
    try {
        if (typeof osirisState !== 'undefined' && osirisState.picks && osirisState.picks.length) {
            const best = osirisState.picks[0];
            const rank = osirisState.picks.map(p => `${p.sym} ${(p.prob*100|0)}%`).join(' > ');
            lines.push(`OSIRIS MULTI-MARKT · ${rank} \u00b7 ${osirisState.note || ''}`);
        }
    } catch (e) {}

    try { if (typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.reasoningLine) lines.push(OsirisDeepNet.reasoningLine); } catch (e) {}
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
                // MUNT-BEWUSTE P/L: gebruik de prijs van de eigen markt van de positie
                // (BTC via livePrice, ETH/SOL via de multi-asset motor). Lost de bug op
                // waarbij ETH/SOL tegen de BTC-prijs werd afgerekend.
                const px = priceForPosition(p);
                const grossPct = px ? (p.side === 'LONG'
                    ? (px - p.entryPrice) / p.entryPrice
                    : (p.entryPrice - px) / p.entryPrice) : 0;
                const pnlPct = grossPct - roundTripCostPct() / 100;
                const color = pnlPct >= 0 ? '#00ffcc' : '#ef5350';
                const entryTijd = p.openTime ? formatFullDateTime(p.openTime) : '-';
                // markt-label: welke munt is dit?
                let mkt = 'BTC';
                if (p.isOsiris && p.symbol && typeof MULTI_BINANCE !== 'undefined') {
                    mkt = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === p.symbol) || p.symbol.replace('USDT','');
                }
                const mktColor = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' }[mkt] || '#8b95a5';
                const ft = typeFacetsFromFlags(p);
                // alloc %: ECHTE wallet-fractie; voor Osiris tonen we de conviction erbij
                const allocPct = positionAllocPct(p);
                const convTxt = (p.isOsiris && p.osirisAllocPct != null)
                    ? ` <span style="color:var(--text-dimmer);">(conv ${(p.osirisAllocPct * 100).toFixed(0)}%)</span>` : '';
                return `<tr>
                    <td style="padding:4px; font-size:0.72em; font-weight:bold; white-space:nowrap;"><span style="color:${ft.origin.c};">${ft.origin.l}</span> <span style="color:var(--text-dimmer);">&middot;</span> <span style="color:${ft.strat.c};">${ft.strat.l}</span></td>
                    <td style="color:${mktColor}; font-weight:bold; font-size:0.8em;">${mkt}</td>
                    <td style="color:${p.side === 'LONG' ? '#26a69a' : '#ef5350'}; font-weight:bold;">${p.side}</td>
                    <td>${formatChartPrice(p.entryPrice)}</td>
                    <td style="font-size:0.9em; color:#aaa;">${entryTijd}</td>
                    <td>${formatMoney(p.notional)}</td>
                    <td style="white-space:nowrap;">${Math.min(100, allocPct).toFixed(1)}%${convTxt}</td>
                    <td style="color:${color};" title="netto na ${roundTripCostPct().toFixed(2)}% round-trip kosten (bruto ${(grossPct * 100).toFixed(2)}%)">${(pnlPct * 100).toFixed(2)}%</td>
                    <td style="color:${color};">${formatMoney(p.notional * pnlPct)}</td>
                    <td style="padding:2px 4px;"><button type="button" class="btn btn-ghost btn-mini" style="color:#ff5f7e; border-color:rgba(255,95,126,0.5); padding:2px 7px; font-size:0.7em;" onclick="closePositionManually('${p.id}')" title="Sluit deze positie nu">Sluit</button></td>
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
    const ft = typeFacetsFromFlags(entry);
    const mkt = entry.market || 'BTC';
    const mktColor = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' }[mkt] || '#8b95a5';
    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid #222';
    row.innerHTML = `
        <td style="padding:5px; color:#888;">${entry.timestamp}</td>
        <td style="font-weight:bold; font-size:0.85em; white-space:nowrap;"><span style="color:${ft.origin.c};">${ft.origin.l}</span> <span style="color:#666;">&middot;</span> <span style="color:${ft.strat.c};">${ft.strat.l}</span></td>
        <td style="color:${mktColor}; font-weight:bold; font-size:0.85em;">${mkt}</td>
        <td style="color:${entry.side === 'LONG' ? '#26a69a' : '#ef5350'};">${entry.side || '-'}</td>
        <td>${typeof entry.price === 'number' ? formatChartPrice(entry.price) : entry.price}</td>
        <td>${formatMoney(entry.notionalEUR || 0)}</td>
        <td style="color:#7d99ac;">${entry.sizePct != null ? (entry.sizePct * 100).toFixed(0) + '%' : '-'}</td>
        <td style="color:${pnlColor}; font-weight:bold;">${(entry.pnl * 100).toFixed(2)}% (${formatMoney(entry.pnlAmount || 0)})</td>
        <td style="color:#7d99ac; font-size:0.82em; white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis;" title="${(entry.reason || '').replace(/"/g, '&quot;')}">${entry.reason || '-'}</td>
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

function logBotAction(action, price, side, pnl = 0, amount = 0, reason = '', pnlAmount = 0, notionalEUR = 0, isScalp = false, market = 'BTC', isOsiris = false, isManual = false, isIct = false, sizePct = null) {
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
        isScalp,
        isOsiris, isManual, isIct,
        sizePct,
        market: market || 'BTC'
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

// ============================================================
// PER-FACTOR KANSSCHATTER (30-07)
// ============================================================
// Kern van de "elke factor berekent zijn eigen kans"-aanpak. Voor elke factor
// leren we uit de eigen bot-historie hoe vaak een trade WON wanneer die factor
// in een bepaalde toestand was (aanwezig/sterk vs. afwezig/zwak). Dat levert per
// factor een empirische winstkans (0..1). Neo combineert die kansen daarna tot
// één ensemble-score - naast de bestaande puntentelling, als versterking.
//
// Waarom sterker: een vaste puntentelling zegt "confluence = +9 punten". De
// kansschatter zegt "in de praktijk wint een trade met deze confluence 63% van
// de tijd" - dat is direct, meetbaar en zelf-corrigerend. Factoren die niet
// blijken te werken zakken vanzelf naar ~50% (geen informatie) en tellen dan
// nauwelijks mee in het ensemble.

let _factorProbCache = { at: 0, table: null };

// Bouw (gecachet) een kanstabel per factor uit de learningLog. Elke factor krijgt
// bins; per bin de gemeten winstkans + het aantal samples (voor betrouwbaarheid).
function buildFactorProbTable() {
    const now = Date.now();
    if (_factorProbCache.table && now - _factorProbCache.at < 20000) return _factorProbCache.table;
    const bot = learningLog.filter(l => !l.manual && l.factors && l.outcome);
    const globalWin = bot.length ? bot.filter(l => l.outcome === 'win').length / bot.length : 0.5;

    // definieer per factor hoe we de waarde in een bin vertalen
    const factorDefs = {
        confluence:   l => l.factors.confluence,
        node:         l => l.factors.nodeInfluence,
        momentum:     l => l.factors.momentumInfluence,
        fib:          l => l.factors.fibConfluenceInfluence,
        pattern:      l => l.factors.patternInfluence,
        rsi:          l => l.factors.rsiInfluence,
        ema:          l => l.factors.emaInfluence,
        cnn:          l => l.factors.cnnInfluence,
        vfm:          l => l.factors.snapVfm,
        er:           l => l.factors.snapEr,
        db:           l => l.factors.snapDb,
        chaos:        l => l.factors.snapChaos,
        volz:         l => l.factors.snapVolZ
    };

    const table = {};
    for (const [name, get] of Object.entries(factorDefs)) {
        const vals = bot.map(l => ({ v: get(l), win: l.outcome === 'win' })).filter(x => x.v != null && isFinite(x.v));
        if (vals.length < 8) { table[name] = { global: globalWin, bins: null, n: vals.length }; continue; }
        // 3 bins op basis van kwantielen (laag / midden / hoog)
        const sorted = vals.map(x => x.v).sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length / 3)], q2 = sorted[Math.floor(sorted.length * 2 / 3)];
        const bin = v => v <= q1 ? 0 : v <= q2 ? 1 : 2;
        const acc = [[0, 0], [0, 0], [0, 0]];
        for (const x of vals) { const b = bin(x.v); acc[b][0] += x.win ? 1 : 0; acc[b][1]++; }
        // Laplace-smoothing naar de globale winrate zodat kleine bins niet overdrijven
        const binProb = acc.map(([w, n]) => n ? (w + globalWin * 4) / (n + 4) : globalWin);
        table[name] = { global: globalWin, q1, q2, binProb, n: vals.length };
    }
    _factorProbCache = { at: now, table };
    return table;
}

// De eigen winstkans van één factor gegeven zijn huidige waarde (0..1).
function factorWinProbability(name, value) {
    const t = buildFactorProbTable()[name];
    if (!t || t.binProb == null || value == null || !isFinite(value)) return t ? t.global : 0.5;
    const b = value <= t.q1 ? 0 : value <= t.q2 ? 1 : 2;
    return t.binProb[b];
}

// RSI -> richtinggebonden influence (niet langer alleen een veto). Overbought
// steunt SHORT, oversold steunt LONG; lineair geschaald tot ±een paar punten.
function calculateRsiInfluence(side) {
    const rsi = getCurrentRSIValue();
    if (rsi == null) return 0;
    // gecentreerd rond 50; +1 = maximaal oversold (bullish), -1 = overbought (bearish)
    const norm = (50 - rsi) / 50;                 // rsi 0 -> +1 (oversold), rsi 100 -> -1 (overbought)
    const dir = side === 'LONG' ? norm : -norm;   // LONG profiteert van oversold, SHORT van overbought
    return Math.max(-6, Math.min(6, dir * 8));
}

// EMA -> trendbevestiging. Prijs boven EMA en stijgende EMA steunt LONG; eronder
// en dalend steunt SHORT. Gebruikt de bestaande MA-waarde als die er is.
function calculateEmaInfluence(side) {
    let ema = null;
    try { ema = (typeof maCurrentValue !== 'undefined' && maCurrentValue) ? maCurrentValue : null; } catch (e) {}
    if (ema == null || !isFinite(livePrice) || !ema) return 0;
    const rel = (livePrice - ema) / ema;          // + = boven EMA (bullish)
    const dir = side === 'LONG' ? rel : -rel;
    return Math.max(-6, Math.min(6, dir * 1500));  // ~0.4% afstand = volle bijdrage
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
    // 31-07: REGIME-BEWUST. Gebruik de gewichten van het HUIDIGE marktregime
    // (trend/range/dood) i.p.v. één globale set. In een trend telt momentum zwaarder,
    // in een range de mean-reversion-factoren - elk regime leert zijn eigen mix.
    const _w = (typeof activeWeights === 'function') ? activeWeights() : adaptiveWeights;
    confluenceContribution *= _w.confluence;
    nodeInfluence *= effectiveNodeWeight();
    momentumInfluence *= _w.momentumInfluence;
    fibConfluenceInfluence *= _w.fibConfluence;
    patternInfluence *= _w.pattern;

    let score = 50 + confluenceContribution; // confluence 0-9 -> tot 50-131 (aligned) of omlaag (tegengesteld), geclamped naar [0,100]
    if (chaosVal > 15) score -= 15;    // extreme volatiliteit = onbetrouwbaarder
    else if (chaosVal < 5) score += 5; // rustige markt = betrouwbaarder
    if (erVal > 1.5) score += 5;       // sterke volume-deelname = betrouwbaarder
    score += nodeInfluence;            // node-timing: VOLA/CORE verhogen, RESET verlaagt (zie calculateNodeInfluence)
    score += momentumInfluence;        // "geheugen": trend uit metricsHistory bevestigt of ontkracht het signaal
    score += fibConfluenceInfluence;   // MES/MAC fib-niveaus (dezelfde lijnen als op de chart) die de MIC-trigger bevestigen
    score += patternInfluence;         // candlestick-patronen (hamer/engulfing/etc.) + markt-structuur (HH/HL vs LH/LL)
    // NIEUW (30-07): RSI en EMA als VOLWAARDIGE gewogen factoren (niet langer enkel
    // een veto). Elk met een eigen adaptief gewicht zodat Neo leert hoeveel ze waard
    // zijn. Ze verschijnen hierdoor ook in de neural-net-weergave.
    let rsiInfluence = 0, emaInfluence = 0, cnnInfluence = 0, nnInfluence = 0;
    if (side !== null) {
        rsiInfluence = calculateRsiInfluence(side) * (_w.rsi ?? 1);
        emaInfluence = calculateEmaInfluence(side) * (_w.ema ?? 1);
        // CNN als APARTE factor met eigen gewicht (los van de oude pattern-weight)
        try {
            if (typeof rawData !== 'undefined' && rawData && rawData.length > 5) {
                const cnn = neoScanPatterns(rawData, 40).netBias || 0;
                cnnInfluence = (side === 'LONG' ? cnn : -cnn) * 6 * (_w.cnn ?? 1);
            }
        } catch (e) {}
        // NN (Neo's Node) als eigen factor met eigen adaptief gewicht. Standaardgewicht
        // start bewust LAAG (0.5) omdat NN nog experimenteel is - Neo bouwt het op of af
        // op basis van of NN-nabijheid in de praktijk met winst correleert.
        try { nnInfluence = calculateNNInfluence(side) * (_w.nn ?? 2.0); } catch (e) { nnInfluence = 0; }
        // NODE-CONFLUENTIE: extra bijdrage wanneer standaard-node en NN samenvallen.
        // Eigen gewicht (nodeconf), start laag - de "samenval = sterkste signaal"-these
        // is nog onbewezen, dus Neo bouwt dit gewicht zelf op of af.
        let confNodeInfl = 0;
        try { confNodeInfl = calculateConfluenceNodeInfluence(side) * (_w.nodeconf ?? 2.0); } catch (e) { confNodeInfl = 0; }
        nnInfluence += confNodeInfl;
        _lastNodeconfContrib = confNodeInfl;
        score += rsiInfluence + emaInfluence + cnnInfluence + nnInfluence;
    }
    // onthoud de losse bijdragen zodat de entry ze kan vastleggen + de neural net ze toont
    _lastFactorContrib = { confluence: confluenceContribution, node: nodeInfluence, momentum: momentumInfluence,
        fib: fibConfluenceInfluence, pattern: patternInfluence, rsi: rsiInfluence, ema: emaInfluence, cnn: cnnInfluence, nn: nnInfluence, nodeconf: (typeof _lastNodeconfContrib!=='undefined'?_lastNodeconfContrib:0) };
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
    const base = logisticCompress(score);
    // ENSEMBLE (30-07): naast de puntentelling berekent elke factor zijn EIGEN
    // empirische winstkans (uit de historie). We combineren die via een
    // log-odds-gemiddelde gewogen met betrouwbaarheid (aantal samples). Dit is
    // de "elke factor apart -> dan als 1 score"-versterking. Alleen actief zodra
    // er genoeg historie is; anders leunt Neo volledig op de puntentelling.
    let ensembleScore = base;
    try {
        const table = buildFactorProbTable();
        const dir = (side === 'SHORT') ? -1 : 1;
        // waarde per factor "in de richting van de trade" (zodat bearish metrics een SHORT steunen)
        const fvals = {
            confluence: confluence, node: nodeInfluence, momentum: momentumInfluence,
            fib: fibConfluenceInfluence, pattern: patternInfluence,
            rsi: rsiInfluence, ema: emaInfluence, cnn: cnnInfluence,
            vfm: (isBullishNow != null ? (isBullishNow ? 1 : -1) : 0) * dir
        };
        let logodds = 0, wsum = 0;
        for (const [name, val] of Object.entries(fvals)) {
            const t = table[name]; if (!t || t.n < 8) continue;
            const p = Math.max(0.05, Math.min(0.95, factorWinProbability(name, val)));
            const conf = Math.min(1, t.n / 40);            // betrouwbaarheid uit aantal samples
            logodds += Math.log(p / (1 - p)) * conf; wsum += conf;
        }
        if (wsum > 0.5) {
            const pEns = 1 / (1 + Math.exp(-logodds / Math.max(1, wsum)));   // terug naar kans
            ensembleScore = pEns * 100;
        }
    } catch (e) {}
    // meng: puntentelling en ensemble elk de helft (ensemble groeit mee met data)
    const blended = ensembleScore !== base ? (base * 0.5 + ensembleScore * 0.5) : base;
    // NIVEAU 2: als het getrainde model beschikbaar is, meng zijn gekalibreerde
    // kans mee. L2 voorspelt de LONG-winstkans; voor een SHORT draaien we hem om.
    if (_l2 && _l2.trained && rawData && rawData.length > 22) {
        const pl = l2Predict(rawData, rawData.length - 1);
        if (pl != null && isFinite(pl)) {
            const l2Pct = (side === 'SHORT' ? (1 - pl) : pl) * 100;
            // NIVEAU 3 (getraind net): weegt ADVISEREND mee met een klein gewicht, en
            // alleen als het op de validatie beter was dan gokken (valAcc > 0.52). Zo
            // krijgt het net pas invloed als het bewezen iets leert - een overfitting-rem.
            let l3Pct = null, l3w = 0;
            if (_l3 && _l3.trained && _l3.valAcc != null && _l3.valAcc > 0.52) {
                const p3 = l3Predict(rawData, rawData.length - 1);
                if (p3 != null && isFinite(p3)) {
                    l3Pct = (side === 'SHORT' ? (1 - p3) : p3) * 100;
                    // AUTONOME L3-WEGING: gewicht = kwaliteit x bewijs.
                    //  - kwaliteit: ramp met de validatie-accuraatheid (0 bij 52%, 1 bij >=65%)
                    //  - bewijs: een DYNAMISCHE cap die met het aantal schone trades meegroeit
                    //    (per ~20 trades +5%, tot 55%) en autonoom daalt als dat aantal daalt.
                    // Zo krijgt het net meer stem naarmate er echt bewijs is, en minder als dat
                    // bewijs wegvalt - de overfitting-rem beweegt nu mee met de data.
                    l3w = Math.max(0, Math.min(1, (_l3.valAcc - 0.52) / (0.65 - 0.52))) * l3WeightCap().cap;
                }
            }
            if (l3Pct != null && l3w > 0) {
                // rest verdeeld over basis en L2 in de oorspronkelijke 55:30-verhouding
                const rest = 1 - l3w;
                return Math.round(blended * rest * (0.55 / 0.85) + l2Pct * rest * (0.30 / 0.85) + l3Pct * l3w);
            }
            return Math.round(blended * 0.6 + l2Pct * 0.4);
        }
    }
    return Math.round(blended);
}
let _lastFactorContrib = null;
let _lastNodeconfContrib = 0;



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

// ============================================================
// NEO CNN — MULTI-CANDLE PATROONHERKENNING (29-07)
// ============================================================
// Aanvulling op detectCandlestickPattern (die blijft ongewijzigd). Deze module
// bekijkt COMBINATIES van 2 t/m 5 opeenvolgende candles - geen losse candles -
// en herkent een brede bibliotheek reversal- én continuation-patronen. Werkt als
// een sliding window (de "CNN"-benadering): het venster schuift over de recente
// candles, elke positie levert een feature-vector, en de patroon-detector geeft
// per venster een {pattern, bias, strength}. Referenties: Morning/Evening Star,
// Three White Soldiers/Black Crows, Engulfing, Harami(+Cross), Piercing/Dark Cloud,
// Three Inside/Outside Up-Down, Tri Star, Abandoned Baby, Rising/Falling Three
// Methods, Tweezers, Kicker, Belt Hold, Marubozu, Doji-familie, Three Line Strike,
// Tasuki Gap, Stick Sandwich, Matching High/Low, Separating Lines, e.v.a.
const NEO_CNN_PATTERNS = {
    // naam: {candles, bias, label} — voor de UI-legenda en het neurale net
    three_white_soldiers:{n:3,bias:'bullish',label:'Three White Soldiers'},
    three_black_crows:{n:3,bias:'bearish',label:'Three Black Crows'},
    morning_star:{n:3,bias:'bullish',label:'Morning Star'},
    evening_star:{n:3,bias:'bearish',label:'Evening Star'},
    morning_doji_star:{n:3,bias:'bullish',label:'Morning Doji Star'},
    evening_doji_star:{n:3,bias:'bearish',label:'Evening Doji Star'},
    bull_abandoned_baby:{n:3,bias:'bullish',label:'Bullish Abandoned Baby'},
    bear_abandoned_baby:{n:3,bias:'bearish',label:'Bearish Abandoned Baby'},
    three_inside_up:{n:3,bias:'bullish',label:'Three Inside Up'},
    three_inside_down:{n:3,bias:'bearish',label:'Three Inside Down'},
    three_outside_up:{n:3,bias:'bullish',label:'Three Outside Up'},
    three_outside_down:{n:3,bias:'bearish',label:'Three Outside Down'},
    tri_star_bull:{n:3,bias:'bullish',label:'Bottom Tri Star'},
    tri_star_bear:{n:3,bias:'bearish',label:'Top Tri Star'},
    upside_tasuki_gap:{n:3,bias:'bullish',label:'Upside Tasuki Gap'},
    downside_tasuki_gap:{n:3,bias:'bearish',label:'Downside Tasuki Gap'},
    stick_sandwich:{n:3,bias:'bullish',label:'Stick Sandwich'},
    bull_engulfing:{n:2,bias:'bullish',label:'Bullish Engulfing'},
    bear_engulfing:{n:2,bias:'bearish',label:'Bearish Engulfing'},
    piercing_line:{n:2,bias:'bullish',label:'Piercing Line'},
    dark_cloud_cover:{n:2,bias:'bearish',label:'Dark Cloud Cover'},
    harami_bull:{n:2,bias:'bullish',label:'Bullish Harami'},
    harami_bear:{n:2,bias:'bearish',label:'Bearish Harami'},
    harami_cross_bull:{n:2,bias:'bullish',label:'Bullish Harami Cross'},
    harami_cross_bear:{n:2,bias:'bearish',label:'Bearish Harami Cross'},
    tweezer_bottom:{n:2,bias:'bullish',label:'Tweezer Bottom'},
    tweezer_top:{n:2,bias:'bearish',label:'Tweezer Top'},
    bull_kicker:{n:2,bias:'bullish',label:'Bullish Kicker'},
    bear_kicker:{n:2,bias:'bearish',label:'Bearish Kicker'},
    matching_low:{n:2,bias:'bullish',label:'Matching Low'},
    matching_high:{n:2,bias:'bearish',label:'Matching High'},
    bull_separating:{n:2,bias:'bullish',label:'Bullish Separating Lines'},
    bear_separating:{n:2,bias:'bearish',label:'Bearish Separating Lines'},
    on_neck:{n:2,bias:'bearish',label:'On Neck'},
    rising_three:{n:5,bias:'bullish',label:'Rising Three Methods'},
    falling_three:{n:5,bias:'bearish',label:'Falling Three Methods'},
    bull_three_line_strike:{n:4,bias:'bullish',label:'Bullish Three Line Strike'},
    bear_three_line_strike:{n:4,bias:'bearish',label:'Bearish Three Line Strike'},
    bull_belt_hold:{n:1,bias:'bullish',label:'Bullish Belt Hold'},
    bear_belt_hold:{n:1,bias:'bearish',label:'Bearish Belt Hold'},
    marubozu_bull:{n:1,bias:'bullish',label:'Bullish Marubozu'},
    marubozu_bear:{n:1,bias:'bearish',label:'Bearish Marubozu'}
};

function _cnnMetrics(k){
    const body=Math.abs(k.close-k.open), range=(k.high-k.low)||1e-9;
    const up=k.high-Math.max(k.open,k.close), lo=Math.min(k.open,k.close)-k.low;
    const isBull=k.close>=k.open;
    return {o:k.open,h:k.high,l:k.low,c:k.close,body,range,up,lo,isBull,
            bodyPct:body/range,top:Math.max(k.open,k.close),bot:Math.min(k.open,k.close),mid:(k.open+k.close)/2};
}
// Detecteer het sterkste multi-candle patroon dat EINDIGT op index i.
// Retourneert {pattern,bias,label,n,strength} of null.
function neoDetectMultiCandle(src, i){
    if(!src||i<4) return null;
    const g=j=>{const d=src[j];return _cnnMetrics({open:+d[1],high:+d[2],low:+d[3],close:+d[4]});};
    const k=[g(i-4),g(i-3),g(i-2),g(i-1),g(i)];      // [c4,c3,c2,c1,c0], c0 = huidige
    const [c4,c3,c2,c1,c0]=k;
    const avgRange=(c4.range+c3.range+c2.range+c1.range+c0.range)/5;
    const tol=avgRange*0.12;
    const big=x=>x.bodyPct>0.55, small=x=>x.bodyPct<0.35, doji=x=>x.bodyPct<0.08;
    const upTrend=c3.c<c2.c&&c2.c<c1.c, downTrend=c3.c>c2.c&&c2.c>c1.c;
    const R=(pattern,strength)=>{const p=NEO_CNN_PATTERNS[pattern];return{pattern,bias:p.bias,label:p.label,n:p.n,strength:Math.max(0,Math.min(1,strength))};};

    // ===== 5-candle continuation =====
    // Rising Three Methods: grote groen, 3 kleine dalende binnen range, grote groen die hoger sluit
    if(c4.isBull&&big(c4) && !c3.isBull&&!c2.isBull&&!c1.isBull &&
       c3.top<c4.h&&c1.bot>c4.l && c0.isBull&&big(c0)&&c0.c>c4.h)
        return R('rising_three',0.9);
    if(!c4.isBull&&big(c4) && c3.isBull&&c2.isBull&&c1.isBull &&
       c3.bot>c4.l&&c1.top<c4.h && !c0.isBull&&big(c0)&&c0.c<c4.l)
        return R('falling_three',0.9);

    // ===== 4-candle =====
    // Three Line Strike: 3 in trend, 4e slokt ze in één keer op
    if(c3.isBull&&c2.isBull&&c1.isBull&&c1.c>c2.c&&c2.c>c3.c && !c0.isBull&&c0.o>=c1.c&&c0.c<=c3.o)
        return R('bull_three_line_strike',0.8);
    if(!c3.isBull&&!c2.isBull&&!c1.isBull&&c1.c<c2.c&&c2.c<c3.c && c0.isBull&&c0.o<=c1.c&&c0.c>=c3.o)
        return R('bear_three_line_strike',0.8);

    // ===== 3-candle reversal =====
    if(c2.isBull&&c1.isBull&&c0.isBull&&big(c2)&&big(c1)&&big(c0)&&c1.c>c2.c&&c0.c>c1.c&&c1.o>c2.o&&c0.o>c1.o)
        return R('three_white_soldiers',0.95);
    if(!c2.isBull&&!c1.isBull&&!c0.isBull&&big(c2)&&big(c1)&&big(c0)&&c1.c<c2.c&&c0.c<c1.c&&c1.o<c2.o&&c0.o<c1.o)
        return R('three_black_crows',0.95);
    // Tri Star: drie doji's op rij
    if(doji(c2)&&doji(c1)&&doji(c0)){
        if(c1.mid<c2.mid&&c0.mid>c1.mid) return R('tri_star_bull',0.7);
        if(c1.mid>c2.mid&&c0.mid<c1.mid) return R('tri_star_bear',0.7);
    }
    // Abandoned Baby: groot - gap-geïsoleerde doji - groot terug
    if(!c2.isBull&&big(c2)&&doji(c1)&&c1.h<c2.l&&c0.isBull&&c0.l>c1.h&&big(c0))
        return R('bull_abandoned_baby',0.85);
    if(c2.isBull&&big(c2)&&doji(c1)&&c1.l>c2.h&&!c0.isBull&&c0.h<c1.l&&big(c0))
        return R('bear_abandoned_baby',0.85);
    // Morning/Evening (Doji) Star
    if(!c2.isBull&&big(c2)&&small(c1)&&c0.isBull&&big(c0)&&c0.c>c2.mid){
        return R(doji(c1)?'morning_doji_star':'morning_star',0.85);
    }
    if(c2.isBull&&big(c2)&&small(c1)&&!c0.isBull&&big(c0)&&c0.c<c2.mid){
        return R(doji(c1)?'evening_doji_star':'evening_star',0.85);
    }
    // Three Inside Up/Down (harami + bevestiging)
    if(!c2.isBull&&big(c2)&&c1.isBull&&c1.top<c2.top&&c1.bot>c2.bot&&c0.isBull&&c0.c>c2.top)
        return R('three_inside_up',0.8);
    if(c2.isBull&&big(c2)&&!c1.isBull&&c1.top<c2.top&&c1.bot>c2.bot&&!c0.isBull&&c0.c<c2.bot)
        return R('three_inside_down',0.8);
    // Three Outside Up/Down (engulfing + bevestiging)
    if(!c2.isBull&&c1.isBull&&c1.o<c2.c&&c1.c>c2.o&&c0.isBull&&c0.c>c1.c)
        return R('three_outside_up',0.8);
    if(c2.isBull&&!c1.isBull&&c1.o>c2.c&&c1.c<c2.o&&!c0.isBull&&c0.c<c1.c)
        return R('three_outside_down',0.8);
    // Tasuki Gap (continuation)
    if(c2.isBull&&c1.isBull&&c1.l>c2.h&&!c0.isBull&&c0.o<c1.c&&c0.o>c1.o&&c0.c<c1.o&&c0.c>c2.h)
        return R('upside_tasuki_gap',0.65);
    if(!c2.isBull&&!c1.isBull&&c1.h<c2.l&&c0.isBull&&c0.o>c1.c&&c0.o<c1.o&&c0.c>c1.o&&c0.c<c2.l)
        return R('downside_tasuki_gap',0.65);
    // Stick Sandwich
    if(!c2.isBull&&c1.isBull&&!c0.isBull&&Math.abs(c0.c-c2.c)<=tol&&c1.c>c2.c)
        return R('stick_sandwich',0.6);

    // ===== 2-candle =====
    if(!c1.isBull&&c0.isBull&&c0.o<c1.c&&c0.c>c1.o){
        // engulfing; harami cross indien c0 doji binnen c1
        return R('bull_engulfing',0.8);
    }
    if(c1.isBull&&!c0.isBull&&c0.o>c1.c&&c0.c<c1.o)
        return R('bear_engulfing',0.8);
    if(!c1.isBull&&big(c1)&&c0.isBull&&c0.o<c1.l&&c0.c>c1.mid&&c0.c<c1.o)
        return R('piercing_line',0.7);
    if(c1.isBull&&big(c1)&&!c0.isBull&&c0.o>c1.h&&c0.c<c1.mid&&c0.c>c1.o)
        return R('dark_cloud_cover',0.7);
    // Harami (+cross)
    if(big(c1)&&c0.body<c1.body*0.5&&c0.top<c1.top&&c0.bot>c1.bot){
        if(doji(c0)) return R(c1.isBull?'harami_cross_bear':'harami_cross_bull',0.65);
        return R(c1.isBull?'harami_bear':'harami_bull',0.6);
    }
    // Kicker: tegengestelde marubozu's met gap
    if(!c1.isBull&&c1.bodyPct>0.8&&c0.isBull&&c0.bodyPct>0.8&&c0.o>=c1.o)
        return R('bull_kicker',0.85);
    if(c1.isBull&&c1.bodyPct>0.8&&!c0.isBull&&c0.bodyPct>0.8&&c0.o<=c1.o)
        return R('bear_kicker',0.85);
    // Tweezers
    if(c1.isBull&&!c0.isBull&&Math.abs(c0.h-c1.h)<=tol&&c1.bodyPct>0.3)
        return R('tweezer_top',0.55);
    if(!c1.isBull&&c0.isBull&&Math.abs(c0.l-c1.l)<=tol&&c1.bodyPct>0.3)
        return R('tweezer_bottom',0.55);
    // Matching high/low
    if(!c1.isBull&&!c0.isBull&&Math.abs(c0.c-c1.c)<=tol) return R('matching_low',0.5);
    if(c1.isBull&&c0.isBull&&Math.abs(c0.c-c1.c)<=tol) return R('matching_high',0.5);
    // Separating lines (continuation): zelfde open, tegengestelde richting terug in trend
    if(downTrend&&!c1.isBull&&c0.isBull&&Math.abs(c0.o-c1.o)<=tol) return R('bull_separating',0.5);
    if(upTrend&&c1.isBull&&!c0.isBull&&Math.abs(c0.o-c1.o)<=tol) return R('bear_separating',0.5);
    // On Neck (bearish continuation)
    if(!c1.isBull&&big(c1)&&c0.isBull&&Math.abs(c0.c-c1.l)<=tol) return R('on_neck',0.45);

    // ===== 1-candle (alleen sterke overtuiging) =====
    if(c0.bodyPct>0.92) return R(c0.isBull?'marubozu_bull':'marubozu_bear',0.6);
    if(c0.bodyPct>0.7&&c0.lo<c0.range*0.05&&c0.isBull&&downTrend) return R('bull_belt_hold',0.45);
    if(c0.bodyPct>0.7&&c0.up<c0.range*0.05&&!c0.isBull&&upTrend) return R('bear_belt_hold',0.45);
    return null;
}

// Sliding-window scan over de laatste `lookback` candles: verzamelt alle
// gedetecteerde multi-candle patronen (de "feature map" van de CNN-laag).
function neoScanPatterns(src, lookback=40){
    if(!src||src.length<5) return {hits:[], last:null, netBias:0};
    const start=Math.max(4, src.length-lookback);
    const hits=[];
    for(let i=start;i<src.length;i++){
        const r=neoDetectMultiCandle(src,i);
        if(r){ r.index=i; r.agoBars=src.length-1-i; hits.push(r); }
    }
    // netto bias-score: recentere + sterkere patronen wegen zwaarder
    let net=0;
    for(const h of hits){
        const recency=Math.exp(-h.agoBars/12);
        const w=h.strength*recency*(h.bias==='bullish'?1:h.bias==='bearish'?-1:0);
        net+=w;
    }
    const last=hits.length?hits[hits.length-1]:null;
    return {hits, last, netBias:Math.max(-1,Math.min(1,net))};
}
window.neoScanPatterns = neoScanPatterns;
window.neoDetectMultiCandle = neoDetectMultiCandle;
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

    // CNN multi-candle bias (29-07): de bredere sliding-window-detector voegt zijn
    // netto bias toe zodat Neo OOK van de combinatie-patronen leert, niet alleen van
    // de enkel-venster detector hierboven. Geschaald zodat het de bestaande factoren
    // aanvult (max ~2) i.p.v. overheerst. Dit gaat via de pattern-weight mee in het
    // adaptieve leren (adaptiveWeights.pattern) en in de kalibratie.
    try {
        if (typeof rawData !== 'undefined' && rawData && rawData.length > 5) {
            const scan = neoScanPatterns(rawData, 40);
            const cnn = scan.netBias || 0;                 // -1..1, + = bullish
            influence += (side === 'LONG' ? cnn : -cnn) * 2;
            // onthoud de laatste sterke CNN-hit voor de UI/legenda
            if (scan.last) _lastCnnHit = scan.last;
        }
    } catch (e) {}

    return Math.max(-6, Math.min(6, influence));
}
let _lastCnnHit = null;

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
    try { probabilityPct = Math.max(0, Math.min(100, probabilityPct + sentimentTilt(side, 'BTC'))); } catch (e) {}   // Fear & Greed SENT-tilt
    const regime = evaluateMarketRegime();
    const eligible = probabilityPct >= (botSettings.minProbabilityPct + fsoRiskAdjust()) &&   // FSO: strenger bij stress
                      projectedProfitPct > (botSettings.minProjectedProfitPct + roundTripCostPct()) &&
                      !regime.dead;

    // NIEUW (30-07): oogst de losse factor-bijdragen (rsi/ema/cnn) die
    // calculateProbabilityScore net heeft berekend, plus de ruwe metric-waarden,
    // zodat ze bij entry worden vastgelegd en de per-factor kansschatter erop leert.
    const fc = _lastFactorContrib || {};
    const snap = (typeof lastOsirisMetrics !== 'undefined' && lastOsirisMetrics) ? lastOsirisMetrics : {};
    const lv = (typeof lastVolumeMetrics !== 'undefined' && lastVolumeMetrics) ? lastVolumeMetrics : {};
    return { eligible, triggerPrice, targetPrice, projectedProfitPct, probabilityPct, nodeContext, nodeInfluence, momentumContext, momentumInfluence, fibConfluenceInfluence, confluence: decision.confluence, patternInfluence,
        rsiInfluence: fc.rsi ?? 0, emaInfluence: fc.ema ?? 0, cnnInfluence: fc.cnn ?? 0, nnInfluence: fc.nn ?? 0, nodeconfInfluence: fc.nodeconf ?? 0,
        snapVfm: snap.vfm ?? null, snapEr: snap.er ?? null, snapDb: snap.db ?? null, snapChaos: snap.chaos ?? null,
        snapVolZ: (lv.zScore != null ? parseFloat(lv.zScore) : null) };
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
    // 31-07: drempel van mediaan (50e pct) -> 30e percentiel. De mediaan triggerde de
    // poort ~de helft van de tijd (per definitie ligt 50% eronder), waardoor Neo in
    // elke rustige markt vastliep. Het 30e percentiel betekent: alleen pauzeren als de
    // markt tot de 30% STILSTE momenten behoort - echt dood, niet slechts "kalm".
    const pIdx = a => a[Math.floor(a.length * 0.30)];
    const loChaos = pIdx(chaosVals);
    const loVfm = pIdx(vfmVals);
    const lowNow = chaos < loChaos && Math.abs(vfm) < loVfm;
    if (!lowNow) { _regimeDeadSince = null; return { dead: false, reason: 'regime actief' }; }
    if (!_regimeDeadSince) _regimeDeadSince = Date.now();
    const deadMinutes = (Date.now() - _regimeDeadSince) / 60000;
    if (deadMinutes < (botSettings.regimeGateConfirmMinutes || 0)) return { dead: false, reason: 'dood regime, nog niet bevestigd' };
    // Throttled loggen (max 1x per 5 min) - anders vult dit de tradelog met SKIPPED-spam
    if (Date.now() - _lastRegimeSkipLog > 5 * 60000) {
        _lastRegimeSkipLog = Date.now();
        logBotAction("SKIPPED", livePrice, isBullish ? 'LONG' : 'SHORT', 0, 0, `REGIME_GATE: vol ${chaos.toFixed(2)} < p30 ${loChaos.toFixed(2)} en |VFM| ${Math.abs(vfm).toFixed(2)} < p30 ${loVfm.toFixed(2)} - al ${deadMinutes.toFixed(0)} min dood, TREND-entries gepauzeerd (scalps lopen door)`);
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

    // Kies MAXIMAAL EEN richting: een tegengestelde LONG+SHORT pending tegelijk is
    // tegenstrijdig ("long en short klopt niet"). Evalueer beide kanten, neem die met
    // de hoogste kans, en annuleer een eventuele pending aan de andere kant.
    const _sideEvals = ['LONG', 'SHORT']
        .map(sd => ({ side: sd, evalResult: evaluateEntryOpportunity(sd, decision, metrics, livePrice) }))
        .filter(e => e.evalResult && e.evalResult.eligible)
        .sort((a, b) => (b.evalResult.probabilityPct || 0) - (a.evalResult.probabilityPct || 0));
    if (_sideEvals.length) {
        const _opp = _sideEvals[0].side === 'LONG' ? 'SHORT' : 'LONG';
        for (let _i = pendingOrders.length - 1; _i >= 0; _i--) {
            if (pendingOrders[_i].side === _opp) { try { logBotAction('CANCELLED', 'tegengestelde kant sterker (' + _sideEvals[0].side + ')'); } catch (e) {} pendingOrders.splice(_i, 1); }
        }
    }
    _sideEvals.slice(0, 1).forEach(({ side, evalResult }) => {
        const hasPending = pendingOrders.some(p => p.side === side);
        if (hasPending) return;

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
            rsiInfluence: evalResult.rsiInfluence ?? 0,
            emaInfluence: evalResult.emaInfluence ?? 0,
            cnnInfluence: evalResult.cnnInfluence ?? 0,
            nnInfluence: evalResult.nnInfluence ?? 0, nodeconfInfluence: evalResult.nodeconfInfluence ?? 0,
            snapVfm: evalResult.snapVfm ?? null,
            snapEr: evalResult.snapEr ?? null,
            snapDb: evalResult.snapDb ?? null,
            snapChaos: evalResult.snapChaos ?? null,
            snapVolZ: evalResult.snapVolZ ?? null,
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

    // RSI als bevestiging voor de mean-reversion-thesis, maar niet langer een HARDE
    // eis van volledig oversold/overbought (31-07). Dat blokkeerde geldige scalps aan
    // de range-rand in rustige markten waar RSI zelden <30 / >70 komt. Nu: een LONG
    // aan de bodem wil LAGE RSI (oversold = goed) - blokkeer alleen als RSI juist hoog
    // staat (>58, geen mean-reversion-kans). Een SHORT aan de top wil HOGE RSI -
    // blokkeer alleen als RSI laag staat (<42). Echt oversold/overbought blijft een
    // sterker signaal maar is geen strikte voorwaarde meer.
    const rsiValue = getCurrentRSIValue();
    if (rsiValue !== null) {
        if (side === 'SHORT' && rsiValue < 42) return { eligible: false };  // top-short wil hoge RSI
        if (side === 'LONG' && rsiValue > 58) return { eligible: false };   // bodem-long wil lage RSI
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
    // VEILIGHEIDS-HALT (meta-laag): geen nieuwe entries bij data-integriteitsalarm of
    // een getripte risk-breaker. Bestaande posities blijven gewoon beheerd (exits draaien door).
    try { if (typeof osirisSafetyHalt === 'function' && osirisSafetyHalt()) { logBotAction('SKIPPED', livePrice, order.side, 0, 0, 'veiligheids-halt actief: ' + (typeof osirisSafetyReason === 'function' ? osirisSafetyReason() : 'guard/risk')); return; } } catch (e) {}
    // adaptieve predict-poort (schaalt met bewezen out-of-sample trust)
    try { if (typeof osirisPredictGate === 'function') { const g = osirisPredictGate('BTC', order.side); if (!g.allow) { logBotAction('SKIPPED', livePrice, order.side, 0, 0, g.reason); return; } } } catch (e) {}
    // trend-alignment veto: geen counter-trend entry bij een sterke trend
    try { if (typeof osirisTrendVeto === 'function') { const tv = osirisTrendVeto('BTC', order.side); if (tv.veto) { logBotAction('SKIPPED', livePrice, order.side, 0, 0, tv.reason); return; } } } catch (e) {}
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
    // FIX (19-08, alloc-bug): dit is de BTC-hoofd-engine, dus "de andere kant heeft al een
    // positie" mag alleen tellen voor een ANDERE BTC-positie - niet voor een Osiris ETH/SOL-
    // positie die toevallig de tegenovergestelde 'side' heeft. Voorheen telde bv. een Osiris
    // ETH LONG als hedge voor een BTC SHORT, waardoor de hedge-reserve (15%) wegviel en er
    // structureel te veel werd toegewezen aan de BTC-shorts (zie ook de her-check in
    // commitPositionEntry, die de 150%-overallocatie hiervan mede veroorzaakte).
    const oppositeHasPosition = openPositions.some(p => p.side === oppositeSide && !p.isOsiris);
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
            // NIEUW (30-07): RSI, EMA en CNN als eigen vastgelegde factoren + de ruwe
            // metric-waarden bij entry. Hierdoor kan elke factor zijn EIGEN winstkans
            // leren (zie factorWinProbability) i.p.v. alleen een gewicht te krijgen.
            rsiInfluence: order.rsiInfluence ?? 0,
            emaInfluence: order.emaInfluence ?? 0,
            cnnInfluence: order.cnnInfluence ?? 0,
            nnInfluence: order.nnInfluence ?? 0, nodeconfInfluence: order.nodeconfInfluence ?? 0,
            snapVfm: order.snapVfm ?? null,
            snapEr: order.snapEr ?? null,
            snapDb: order.snapDb ?? null,
            snapChaos: order.snapChaos ?? null,
            snapVolZ: order.snapVolZ ?? null,
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
// ============================================================
// ICT-ENTRY: opent een positie op basis van een geslaagde cascade.
// Gebruikt de ICT-specifieke micro-target, krappe stop en eigen allocatie,
// en loopt via dezelfde commitPositionEntry-laag (SIM of TESTNET).
// ============================================================
let _ictLastSignalNote = 'ICT uit';
let _ictLastEntryBar = 0;   // voorkomt dubbele entries op dezelfde 1m-candle

// Toont de voortgang van de cascade in het status-vak onder de ICT-instellingen.
function updateIctStatusUI(sig) {
    const el = document.getElementById('ict-status');
    if (!el) return;
    if (!botSettings.ictEnabled) { el.textContent = 'ICT-cascade staat uit.'; el.style.color = 'var(--dim)'; return; }
    if (!sig) { el.textContent = 'ICT actief - wacht op data...'; el.style.color = 'var(--dim)'; return; }
    const stages = ['0 HTF-bias', '1 Liquidity sweep', '2 Market structure shift', '3 FVG/orderblock', '4 Entry klaar'];
    const done = sig.ok ? 4 : sig.stage;
    const bar = stages.map((s, i) => `<span style="color:${i < done ? 'var(--teal)' : (i === done ? 'var(--amber)' : 'var(--dimmer)')};">${i <= done || sig.ok ? '&#9679;' : '&#9675;'}</span>`).join(' ');
    el.innerHTML = `${bar} &nbsp; <span style="color:${sig.ok ? 'var(--teal)' : 'var(--dim)'};">${sig.ok ? `${sig.side} @ ${sig.entry.toFixed(0)} &rarr; target ${sig.target.toFixed(0)}` : sig.reason}</span>`;
}

function scanForIctSetup() {
    if (!botSettings.ictEnabled) { _ictLastSignalNote = 'ICT uit'; return; }
    const sig = evaluateIctCascade();
    if (!sig) { _ictLastSignalNote = 'ICT uit'; return; }
    // toon de voortgang van de cascade in de reasoning/statustekst
    _ictLastSignalNote = sig.ok
        ? `ICT stap 4/4 klaar: ${sig.side} @ ${sig.entry.toFixed(0)} (q ${(sig.quality * 100).toFixed(0)}%)`
        : `ICT stap ${sig.stage}/4: ${sig.reason}`;
    if (typeof updateIctStatusUI === 'function') updateIctStatusUI(sig);
    if (!sig.ok) return;

    // Eén entry per 1m-candle voorkomen (de cascade blijft "waar" zolang de FVG open is).
    const entryBar = _ictData.entry.length ? _ictData.entry[_ictData.entry.length - 1][0] : Date.now();
    if (entryBar === _ictLastEntryBar) return;

    // Al een open ICT-positie aan deze kant? Niet stapelen.
    if (openPositions.some(p => p.isIct && p.side === sig.side)) return;

    // Allocatie tegen de balance, met dezelfde currency-afhandeling als de trend-entry.
    const price = livePrice;
    if (!isFinite(price) || price <= 0) return;
    const balance = getBalance();
    const availablePct = Math.max(0, 1 - getAllocatedPct());
    const sizePct = Math.min(botSettings.ictAllocPct, availablePct);
    if (sizePct <= 0.001) { logBotAction('SKIPPED', price, sig.side, 0, 0, 'ICT: onvoldoende allocatie'); return; }
    const notional = balance * sizePct;
    let notionalUSD;
    if (isQuoteCurrencyWallet()) notionalUSD = notional;
    else notionalUSD = eurUsdtRate ? (notional * eurUsdtRate) : notional;
    const amount = parseFloat((notionalUSD / price).toFixed(6));
    if (amount <= 0) return;

    const position = {
        id: `ict_${Date.now()}_${sig.side}`,
        side: sig.side,
        entryPrice: price,
        amount,
        notional,
        sizePct,
        targetPrice: sig.target,
        ictStopPrice: sig.stop,
        probabilityPct: Math.round(sig.quality * 100),
        nodeInfluence: 0,
        openTime: Date.now(),
        closeTime: null,
        peakPnlPct: 0,
        trailingStopPct: null,
        isIct: true,                    // markeert dit als ICT-trade (aparte exit-regels)
        ictChain: sig.chain,
        factorsAtEntry: {
            confluence: null, nodeInfluence: 0, momentumInfluence: 0,
            fibConfluenceInfluence: 0, patternInfluence: 0,
            probabilityPct: Math.round(sig.quality * 100)
        }
    };
    _ictLastEntryBar = entryBar;
    commitPositionEntry(position, `ICT | ${sig.reason} | target ${sig.target.toFixed(0)} stop ${sig.stop.toFixed(0)}`);
}

// ICT-posities hebben hun eigen, strakke exit: micro-target of krappe stop.
// Wordt vanuit checkOpenPositionsExits aangeroepen vóór de reguliere exit-logica.
function checkIctExit(pos) {
    if (!pos.isIct) return false;
    const price = livePrice;
    if (!isFinite(price)) return false;
    const pnlPct = pos.side === 'LONG' ? (price - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - price) / pos.entryPrice;
    const hitTarget = pos.side === 'LONG' ? price >= pos.targetPrice : price <= pos.targetPrice;
    const hitStop = pos.side === 'LONG' ? price <= pos.ictStopPrice : price >= pos.ictStopPrice;
    if (hitTarget) { closePosition(pos, pnlPct, 'ICT_TARGET'); return true; }
    if (hitStop) { closePosition(pos, pnlPct, 'ICT_STOP'); return true; }
    return false;
}

function commitPositionEntry(position, reasonText) {
    // ANTI-CHURN (15-08): geen tweede positie in dezelfde markt + richting. Voorheen
    // kon een wachtende order een near-identieke positie openen terwijl de oude nog
    // (net) open was -> sluiten + heropenen van hetzelfde. Bestaat die al, dan is dit
    // een continuation: laat de bestaande positie staan i.p.v. te dupliceren.
    try {
        const dupMkt = position.symbol || position.market;
        if (dupMkt && openPositions.some(p => (p.symbol || p.market) === dupMkt && p.side === position.side)) {
            try { logBotAction('CANCELLED', 'duplicaat vermeden - zelfde markt+richting al open (continuation)'); } catch (e) {}
            return;
        }
    } catch (e) {}
    // FIX (19-08, alloc-bug 150%): her-valideer de allocatie vlak vóór commit, dit is het
    // ENE punt waar alle entry-paden doorheen lopen (hoofd-engine, ICT, range-scalp, Osiris
    // shadow-tick, sweep-resolutie). Een positie kan tot ~35s eerder gesized zijn (sweep-
    // wachtvenster) of via een async TESTNET-fill vertraagd zijn, terwijl een ANDERE engine
    // ondertussen al ruimte heeft opgesoupeerd. Zonder deze her-check kan de som van alle
    // sizePct% boven 100% van de wallet uitkomen - concreet gezien: 4x BTC-short (80.8%) +
    // een Osiris ETH-sweep die met een 35s-oude 70%-allocatie alsnog committede => 150.8%.
    try {
        if (position.sizePct != null && position.sizePct > 0) {
            const oppSide = position.side === 'LONG' ? 'SHORT' : 'LONG';
            const oppHasPos = openPositions.some(p => p.side === oppSide && (p.isOsiris === position.isOsiris));
            const hedgeReserveNow = oppHasPos ? 0 : (botSettings.minHedgeReservePct || 0);
            const freshAvailablePct = Math.max(0, 1 - getAllocatedPct() - hedgeReserveNow);
            if (position.sizePct > freshAvailablePct + 0.0005) {
                if (freshAvailablePct <= 0.001) {
                    logBotAction('CANCELLED', position.entryPrice, position.side, 0, 0, `her-check: geen vrije allocatie meer (gepland ${(position.sizePct * 100).toFixed(1)}%) - entry geannuleerd`);
                    return;
                }
                const shrink = freshAvailablePct / position.sizePct;
                logBotAction('SKIPPED', position.entryPrice, position.side, 0, 0, `her-check: allocatie verkleind van ${(position.sizePct * 100).toFixed(1)}% naar ${(freshAvailablePct * 100).toFixed(1)}% (andere engine had ondertussen ruimte gebruikt)`);
                position.sizePct = freshAvailablePct;
                if (position.notional) position.notional *= shrink;
                if (position.amount) position.amount = parseFloat((position.amount * shrink).toFixed(6));
            }
        }
    } catch (e) {}
    // 31-07: leg het marktregime vast waarin deze positie wordt geopend, zodat de
    // regime-bewuste laag er later per regime van kan leren.
    if (!position.regimeAtEntry) { try { position.regimeAtEntry = classifyRegime(); } catch (e) { position.regimeAtEntry = 'RANGE'; } }
    if (botSettings.executionMode !== 'TESTNET') {
        openPositions.push(position);
        const _entMkt = (position.isOsiris && position.symbol && typeof MULTI_BINANCE !== 'undefined') ? (Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === position.symbol) || 'BTC') : 'BTC';
        logBotAction("ENTRY", position.entryPrice, position.side, 0, position.amount, reasonText, 0, position.notional, position.isScalp || false, _entMkt, position.isOsiris === true, position.isManual === true, position.isIct === true, (position.sizePct != null ? position.sizePct : null));
        savePersistentState();
        updateWalletUI();
        updatePositionLines();
        return;
    }
    commitPositionEntryOnTestnet(position, reasonText); // async - positie verschijnt pas na een geslaagde fill
}

async function commitPositionEntryOnTestnet(position, reasonText) {
    try {
        // munt-bewust: de positie draagt zijn eigen symbool (standaard BTC). Zo handelt
        // Neo met dezelfde nepgeld-wallet op meerdere testnet-markten (BTC/ETH/SOL).
        const symbol = position.symbol || TESTNET_SYMBOL;
        const filters = await getTestnetSymbolFilters(symbol);
        const notionalUSD = position.amount * position.entryPrice; // amount is al in USD-termen gesized
        if (notionalUSD < filters.minNotional) {
            logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: order (${notionalUSD.toFixed(2)} USDT) onder minNotional (${filters.minNotional})`);
            return;
        }
        let res;
        if (position.side === 'LONG') {
            res = await testnetMarketOrder('BUY', { quoteOrderQty: notionalUSD, symbol });
        } else {
            // SHORT op spot = de base-asset uit het testnet-saldo verkopen ("inventory short").
            const qty = roundToStep(position.amount, filters.stepSize);
            const bal = await getTestnetBalances();
            const baseAsset = filters.baseAsset || 'BTC';
            if ((bal[baseAsset] || 0) < qty) {
                logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: onvoldoende ${baseAsset}-saldo voor SHORT (nodig ${qty}, vrij ${(bal[baseAsset] || 0).toFixed(5)}) - wacht op maandelijkse testnet-reset of koop eerst ${baseAsset}`);
                try { const _bsym = (typeof MULTI_BINANCE !== 'undefined') ? (Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === symbol) || null) : null; if (_bsym) { _osirisShortBlock[_bsym] = Date.now(); delete _osirisSweep[_bsym]; } } catch (e) {}   // blokkeer SHORTs -> geen sweep-loop
                return;
            }
            if (qty < filters.minQty) {
                logBotAction("SKIPPED", position.entryPrice, position.side, 0, 0, `TESTNET: hoeveelheid ${qty} onder minQty (${filters.minQty})`);
                return;
            }
            res = await testnetMarketOrder('SELL', { quantity: qty, symbol });
        }
        const fill = summarizeTestnetFills(res, filters.baseAsset);
        if (!fill.executedQty || !fill.avgPrice) throw new Error('order gaf geen fills terug');
        position.entryPrice = fill.avgPrice;
        position.amount = fill.executedQty;
        position.baseQty = fill.executedQty;
        position.entryCommissionQuote = fill.commissionQuote;
        position.isTestnet = true;
        position.symbol = symbol;
        openPositions.push(position);
        (() => { const _em = (position.isOsiris && position.symbol && typeof MULTI_BINANCE !== 'undefined') ? (Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === position.symbol) || 'BTC') : 'BTC'; logBotAction("ENTRY", fill.avgPrice, position.side, 0, fill.executedQty, `${reasonText} [TESTNET ${symbol} fill]`, 0, position.notional, position.isScalp || false, _em, position.isOsiris === true, position.isManual === true, position.isIct === true, (position.sizePct != null ? position.sizePct : null)); })();
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
        const symbol = pos.symbol || TESTNET_SYMBOL;
        const filters = await getTestnetSymbolFilters(symbol);
        const orderSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
        const qty = roundToStep(pos.baseQty || pos.amount, filters.stepSize);
        if (qty < filters.minQty) throw new Error(`hoeveelheid ${qty} onder minQty (${filters.minQty})`);
        const res = await testnetMarketOrder(orderSide, { quantity: qty, symbol });
        const fill = summarizeTestnetFills(res, filters.baseAsset);
        if (!fill.executedQty || !fill.avgPrice) throw new Error('order gaf geen fills terug');
        const grossPnlPct = pos.side === 'LONG'
            ? (fill.avgPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - fill.avgPrice) / pos.entryPrice;
        const notionalUSD = pos.entryPrice * (pos.baseQty || pos.amount);
        const commPct = notionalUSD > 0 ? ((pos.entryCommissionQuote || 0) + fill.commissionQuote) / notionalUSD : 0;
        finalizeClosePosition(pos, grossPnlPct - commPct, `${reason} [TESTNET ${symbol} fill]`);
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
        // Welke markt was dit? Osiris ETH/SOL-trades mogen NIET meetellen voor Neo BTC's
        // Level 1 kalibratie - die moet zuiver op BTC blijven. We leggen de markt vast
        // zodat recalibrateAdaptiveWeights alleen BTC-trades gebruikt.
        let posMarket = 'BTC';
        if (pos.isOsiris && pos.symbol && typeof MULTI_BINANCE !== 'undefined') {
            posMarket = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) || 'BTC';
        }
        learningLog.push({
            timestampMs: Date.now(),
            side: pos.side,
            market: posMarket,
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
            botWouldEnter: pos.botWouldEnter ?? null,
            // ---- Datahygiëne voor Level 2 ----
            // Een vingerafdruk van de config die actief was bij deze trade. Zo kan
            // de leerlaag automatisch alleen trainen op trades uit hetzelfde regime
            // (bijv. collapse-uit) en nooit meer oude en nieuwe data mengen.
            configVersion: currentConfigVersion(),
            entryHourUTC: pos.openTime ? new Date(pos.openTime).getUTCHours() : new Date().getUTCHours(),
            isIct: pos.isIct === true,
            isOsiris: pos.isOsiris === true,   // herkomst-label voor per-brein/per-type leren
            isScalp: pos.isScalp === true,
            // 31-07: regime waarin deze trade werd geopend, zodat de regime-bewuste
            // laag per regime apart kan leren welke factoren daar werken.
            regime: pos.regimeAtEntry || _lastActiveRegime || 'RANGE'
        });
        if (learningLog.length > 2000) learningLog = learningLog.slice(-2000);
        _lastCalibUpdateMs = Date.now(); try { localStorage.setItem('osirisLastCalibMs', String(_lastCalibUpdateMs)); } catch (e) {}   // stempel voor "last updated" in de kalibratietabel
        recalibrateAdaptiveWeights();
        // FIX (29-07): de kalibratie-kaart werd wel bij het laden berekend, maar
        // NIET opnieuw wanneer er tijdens het draaien een trade sloot - de chart
        // bleef dus staan op de waarde van de page-load. Nu herberekenen + hertekenen
        // we zodra er nieuwe learning binnenkomt, zodat de curve live meebeweegt.
        try { computeCalibrationMap(); renderCalibrationCurve(); } catch (e) { /* chart niet in beeld */ }
    } else if (pos.isOsiris) {
        // FIX: Osiris ETH/SOL-trades hebben geen confluence-factoren, maar we loggen ze
        // WEL (markt + uitkomst + entry-kans) zodat de per-brein Adaptive Learning EN de
        // kalibratie-curve voor ETH/SOL/mainbrain updaten. Ze tellen NIET mee voor Neo
        // BTC's factor-gewichten (die filteren op market==='BTC' + aanwezige factors).
        let osMarket = 'BTC';
        if (pos.symbol && typeof MULTI_BINANCE !== 'undefined') osMarket = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) || 'BTC';
        learningLog.push({
            timestampMs: Date.now(), side: pos.side, market: osMarket,
            outcome: pnlPct > 0 ? 'win' : 'loss', pnlPct,
            exitReason: (reason || '').split(' ')[0],
            holdMinutes: pos.openTime ? Math.round((Date.now() - pos.openTime) / 60000) : null,
            entryProbabilityPct: pos.probabilityPct ?? null,
            manual: false, botWouldEnter: null,
            configVersion: currentConfigVersion(),
            entryHourUTC: pos.openTime ? new Date(pos.openTime).getUTCHours() : new Date().getUTCHours(),
            isIct: false, isOsiris: true, isScalp: false,
            factors: pos.factorsAtEntry || null,
            regime: pos.regimeAtEntry || 'MULTI'
        });
        if (learningLog.length > 2000) learningLog = learningLog.slice(-2000);
        _lastCalibUpdateMs = Date.now(); try { localStorage.setItem('osirisLastCalibMs', String(_lastCalibUpdateMs)); } catch (e) {}
        try { recalibrateSubBrain(osMarket); } catch (e) {}   // per-markt zelf-kalibratie op deze trade
        try { renderLearningPanel(); computeCalibrationMap(); renderCalibrationCurve(); } catch (e) {}
    } else if (!pos.isScalp) {
        console.warn(`Level 1: trend-positie ${pos.id} gesloten ZONDER factorsAtEntry - deze trade telt niet mee voor adaptief leren.`);
    }

    // munt-bewuste prijs + markt in de log (BTC via livePrice, ETH/SOL via multi-state)
    const exitPrice = priceForPosition(pos);
    let posMarket = 'BTC';
    if (pos.isOsiris && pos.symbol && typeof MULTI_BINANCE !== 'undefined') {
        posMarket = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) || 'BTC';
    }
    logBotAction("EXIT", exitPrice, pos.side, pnlPct, pos.amount, reason, pnlAmount, pos.notional, pos.isScalp || false, posMarket, pos.isOsiris === true, pos.isManual === true, pos.isIct === true, (pos.sizePct != null ? pos.sizePct : null));
    try { if (botTradeLog.length) { const _e = botTradeLog[botTradeLog.length - 1]; _e.mfePct = (pos.mfe != null ? +(pos.mfe * 100).toFixed(3) : null); _e.maePct = (pos.mae != null ? +(pos.mae * 100).toFixed(3) : null); _e.walletFill = (typeof getEquity === 'function' ? +getEquity().toFixed(2) : null); _e.executionSource = (botSettings && botSettings.executionMode) || 'TESTNET'; _e.botVersion = OSIRIS_VERSION; _e.entryPrice = pos.entryPrice; _e.holdMinutes = pos.openTime ? +(((Date.now() - pos.openTime) / 60000).toFixed(1)) : null; } } catch (e) {}
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
// _calibCurrentVersionOnly is nu bovenin gedeclareerd (vóór loadPersistentState) - TDZ-fix
let _lastCalibUpdateMs = (function(){ try { return +localStorage.getItem('osirisLastCalibMs') || 0; } catch(e){ return 0; } })();   // persistent "last updated"-stempel
// Generieke bouwer: maakt een predicted-vs-measured mapping voor de trades die door
// filterFn komen. Teruggegeven: { map, n, provisional }.
function _buildCalibMap(filterFn) {
    const withProb = learningLog.filter(filterFn);
    const provisional = withProb.length < 50;
    if (withProb.length < 10) return { map: null, n: withProb.length, provisional };
    // QUANTIEL-BINNING (22-08): gelijk-gevulde bins over de werkelijke entry-kansen -> meer,
    // betrouwbaardere punten dan de oude vaste 10%-vakken (die vaak maar 4 punten gaven).
    const arr = withProb.map(l => ({ p: l.entryProbabilityPct, win: l.outcome === 'win' ? 1 : 0 })).sort((a, b) => a.p - b.p);
    const nBins = Math.max(2, Math.min(10, Math.floor(arr.length / 10)));   // ~10 per bin
    const per = Math.floor(arr.length / nBins);
    const pts = [];
    for (let b = 0; b < nBins; b++) {
        const seg = arr.slice(b * per, b === nBins - 1 ? arr.length : (b + 1) * per);
        if (seg.length < 4) continue;
        const px = seg.reduce((a, x) => a + x.p, 0) / seg.length;
        const py = seg.filter(x => x.win).length / seg.length * 100;
        pts.push([px, py]);
    }
    if (pts.length < 1) return { map: null, n: withProb.length, provisional };
    for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]);   // monotoon
    return { map: pts, n: withProb.length, provisional };
}
// Neo BTC (global _calibMap, blijft BTC-zuiver + versie-zuiver).
function computeCalibrationMap() {
    const curVer = currentConfigVersion();
    const versionOk = l => !_calibCurrentVersionOnly || l.configVersion == null || l.configVersion === curVer;
    const res = _buildCalibMap(l => l.entryProbabilityPct != null && !l.manual && (l.market == null || l.market === 'BTC') && versionOk(l));
    _calibMap = res.map; _calibProvisional = res.provisional;
}
// Per-brein: 'ETH'/'SOL' filtert op die markt, 'OSIRIS' aggregeert alle Osiris-trades
// (ETH+SOL) = de kalibratie van de mainbrain-beslissing.
function computeCalibrationMapFor(brain) {
    const curVer = currentConfigVersion();
    const versionOk = l => !_calibCurrentVersionOnly || l.configVersion == null || l.configVersion === curVer;
    let filt;
    if (brain === 'OSIRIS') filt = l => l.entryProbabilityPct != null && !l.manual && l.isOsiris === true && versionOk(l);
    else filt = l => l.entryProbabilityPct != null && !l.manual && l.market === brain && versionOk(l);
    return _buildCalibMap(filt);
}


// BACKFILL: zet oude Osiris ETH/SOL-trades uit de tradeLog alsnog in de learningLog,
// zodat de per-brein Adaptive Learning-tellers/winrate ook je historie tonen. Zonder
// entry-kans (die is nooit opgeslagen), dus deze tellen NIET mee voor de kalibratie-
// curve - alleen voor de tellingen. Idempotent: dubbele runs voegen niets dubbel toe.
function backfillOsirisLearning() {
    try {
        if (!Array.isArray(botTradeLog) || !Array.isArray(learningLog)) return;
        const seen = new Set(learningLog.filter(l => l.isOsiris)
            .map(l => `${l.market}|${l.side}|${Math.round((l.timestampMs || 0) / 1000)}`));
        let added = 0;
        for (const t of botTradeLog) {
            if (t.action !== 'EXIT') continue;
            const isOs = t.isOsiris === true || (t.market && t.market !== 'BTC');
            if (!isOs) continue;
            const market = t.market || 'BTC';
            const key = `${market}|${t.side}|${Math.round((t.timestampMs || 0) / 1000)}`;
            if (seen.has(key)) continue;
            const pnlPct = (typeof t.pnl === 'number') ? t.pnl : 0;
            learningLog.push({
                timestampMs: t.timestampMs || Date.now(),
                side: t.side, market,
                outcome: pnlPct > 0 ? 'win' : 'loss', pnlPct,
                exitReason: (t.reason || '').split(' ')[0],
                mfePct: t.mfePct != null ? t.mfePct : null,
                maePct: t.maePct != null ? t.maePct : null,
                walletFill: t.walletFill != null ? t.walletFill : null,
                executionSource: t.executionSource || null,
                botVersion: t.botVersion || null,
                holdMinutes: null, entryProbabilityPct: null,
                manual: false, botWouldEnter: null,
                configVersion: currentConfigVersion(),
                entryHourUTC: t.timestampMs ? new Date(t.timestampMs).getUTCHours() : new Date().getUTCHours(),
                isIct: t.isIct === true, isOsiris: true, isScalp: t.isScalp === true,
                regime: 'MULTI', backfilled: true
            });
            seen.add(key); added++;
        }
        if (added) {
            learningLog.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
            if (learningLog.length > 2000) learningLog = learningLog.slice(-2000);
            try { localStorage.setItem('osirisLearningLog', JSON.stringify(learningLog)); } catch (e) {}
            console.log(`[backfill] ${added} Osiris-trades toegevoegd aan de learningLog.`);
            try { renderLearningPanel(); } catch (e) {}
        }
    } catch (e) { console.warn('backfill-fout', e); }
}
window.backfillOsirisLearning = backfillOsirisLearning;

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

// ============================================================
// REGIME-BEWUSTE LAAG (31-07)
// ============================================================
// BTC gedraagt zich fundamenteel anders in een trending markt dan in een range of
// een dode markt. Eén set gewichten op alle condities is suboptimaal: momentum is
// goud in een trend maar een valstrik in een range (waar mean-reversion wint).
// Deze laag classificeert het huidige regime en houdt APARTE adaptieve gewichten
// per regime bij. calculateProbabilityScore gebruikt de gewichten van het regime
// dat op dat moment actief is. Alles blijft transparant en zelf-lerend.

// drie werkbare regimes voor de weight-scheiding
function classifyRegime() {
    // gebruikt live chaos (volatiliteit), |vfm| (richtingskracht) en de recente
    // trend-consistentie. Valt terug op RANGE als er te weinig data is.
    try {
        if (typeof chaos === 'undefined') return 'RANGE';
        const mc = (lastOsirisMetrics && lastOsirisMetrics.momentumContext) || null;
        const consec = mc ? Math.max(mc.consecutiveBullish || 0, mc.consecutiveBearish || 0) : 0;
        const compressed = mc ? mc.rangeCompressed : false;
        // DOOD: heel lage volatiliteit en weinig richtingskracht
        if (chaos < 6 && Math.abs(vfm) < 0.4 && consec < 3) return 'DEAD';
        // TREND: duidelijke aanhoudende richting of hoge chaos met kracht
        if (consec >= 4 || (chaos > 10 && Math.abs(vfm) > 1.0)) return 'TREND';
        // anders RANGE (incl. samengedrukte markten - domein van de scalps)
        return 'RANGE';
    } catch (e) { return 'RANGE'; }
}

// aparte gewichten-set per regime; elk start als kopie van de globale defaults en
// evolueert onafhankelijk op basis van de trades die IN dat regime plaatsvonden.
let regimeWeights = {
    TREND: null, RANGE: null, DEAD: null
};
function ensureRegimeWeights() {
    for (const r of ['TREND', 'RANGE', 'DEAD']) {
        if (!regimeWeights[r]) regimeWeights[r] = Object.assign({}, adaptiveWeights);
        // vul ontbrekende sleutels aan (migratie)
        for (const k of ['confluence','nodeInfluence','momentumInfluence','fibConfluence','pattern','rsi','ema','cnn'])
            if (regimeWeights[r][k] == null) regimeWeights[r][k] = 1.0;
        if (regimeWeights[r].nn == null) regimeWeights[r].nn = 2.0;
        if (regimeWeights[r].nodeconf == null) regimeWeights[r].nodeconf = 2.0;
    }
}
// geef de actieve gewichten-set terug (regime-specifiek als beschikbaar, anders globaal)
function activeWeights() {
    ensureRegimeWeights();
    const r = classifyRegime();
    _lastActiveRegime = r;
    return regimeWeights[r] || adaptiveWeights;
}
let _lastActiveRegime = 'RANGE';

// ============================================================
// GEWICHT-KALIBRATIE — contrafeitelijk per-trade leren (01-08)
// ============================================================
// HERBOUWD op basis van de credit-assignment discussie. In plaats van "won de trade
// waar factor X aanwezig was", meten we of de WAARDE van factor X op het instapmoment
// CORRELEERT met de uitkomst - over ALLE trades, ongeacht of X de trade dreef. Zo
// leert bijv. de NN-pulse zijn waarde ook uit trades die hij niet triggerde (het gat
// dat de gebruiker terecht aanwees).
//
// DRIE OVERFITTING-REMMEN:
//  1. Leersnelheid: elk gewicht schuift per herijking maar een klein stukje.
//  2. Krimp naar neutraal: zonder blijvend bewijs zakt een gewicht terug naar 1.0.
//  3. Vertrouwen schaalt met samples: met weinig data blijft het gewicht dicht bij
//     neutraal; pas met veel trades mag het ver uitwijken (Bayesiaans shrinkage).
const NEUTRAL_W = 1.0;
// ============================================================
// AUTONOME ENGINE-AANPASSING (01-08) — Osiris/Neo herziet zelf de instellingen
// ============================================================
// Bij start (en periodiek) evalueert Neo de engine-instellingen tegen alle
// beschikbare data en past ze autonoom aan voor betere winstkansen. Elke aanpassing
// + de redenering wordt gelogd naar het "Autonomous Adaptation"-paneel. Volledig
// dynamisch, maar binnen veilige grenzen zodat het nooit onverantwoord wordt.
let _adaptationLog = [];
function logAdaptation(what, why) {
    const t = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _adaptationLog.unshift({ t, what, why });
    if (_adaptationLog.length > 40) _adaptationLog.pop();
    const el = document.getElementById('bot-adaptation');
    if (el) {
        el.innerHTML = _adaptationLog.map(a =>
            `<div style="margin-bottom:7px;"><span style="color:#ffb627;">[${a.t}]</span> <span style="color:#ffe9b8;">${a.what}</span><br><span style="color:#9a8a66; font-size:0.92em;">&rarr; ${a.why}</span></div>`
        ).join('');
    }
}

// LIVE FEED (22-08): elke tool die Osiris autonoom bijstelt krijgt zijn EIGEN feed. We
// classificeren de adaptatie-log per tool en renderen aparte divs; spot- en margin-
// beredenering staan gescheiden. Puur weergave - verandert geen logica.
function _toolOf(what) {
    const s = (what || '').toLowerCase();
    if (/governor/.test(s)) return 'governor';
    if (/guardian|risk-breaker|veiligheids|drawdown|exposure-cap/.test(s)) return 'guard';
    if (/zelf-review|self-review/.test(s)) return 'selfreview';
    if (/deepnet|poort|exit-sturing/.test(s)) return 'deepnet';
    if (/leverage|exposure|margin/.test(s)) return 'margin';
    if (/osiris|preset|sub-brein|abstain/.test(s)) return 'osiris';
    if (/drempel|stop|target|time-stop|engine|instap|harvest|trail/.test(s)) return 'engine';
    return 'overig';
}
function renderLiveFeeds() {
    try {
        const fmt = arr => (arr && arr.length) ? arr.map(a => `<div style="margin-bottom:6px;"><span style="color:#ffb627;">[${a.t || (a.ts ? new Date(a.ts).toLocaleTimeString('nl-NL') : '')}]</span> <span style="color:#ffe9b8;">${a.what || a.txt}</span>${a.why ? `<br><span style="color:#9a8a66; font-size:0.9em;">&rarr; ${a.why}</span>` : ''}</div>`).join('') : '<span style="color:var(--text-dim); font-size:0.85em;">nog geen aanpassingen&hellip;</span>';
        const buckets = { engine: [], osiris: [], margin: [], deepnet: [], governor: [], guard: [], selfreview: [], overig: [] };
        for (const a of (typeof _adaptationLog !== 'undefined' ? _adaptationLog : [])) { const b = _toolOf(a.what); (buckets[b] || buckets.overig).push(a); }
        try { for (const a of ((typeof marginState !== 'undefined' && marginState.adaptation) || [])) buckets.margin.push({ t: new Date(a.ts).toLocaleTimeString('nl-NL'), what: a.txt }); } catch (e) {}
        let govFeed = [], guardFeed = [];
        try { govFeed = (OsirisGovernor.log || []).map(l => ({ t: new Date(l.ts).toLocaleTimeString('nl-NL'), what: `'${l.name}' trust &rarr; ${(l.w * 100 | 0)}%`, why: `hit-rate ${(l.acc * 100 | 0)}% · Brier ${l.brier} · n=${l.n}` })); } catch (e) {}
        try { guardFeed = (OsirisGuardian.log || []).map(l => ({ t: new Date(l.ts).toLocaleTimeString('nl-NL'), what: 'data-integriteit alarm', why: (l.alerts || []).join(' · ') })); } catch (e) {}
        const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
        set('feed-tool-engine', fmt(buckets.engine.slice(0, 20)));
        set('feed-tool-osiris', fmt(buckets.osiris.slice(0, 20)));
        set('feed-tool-margin', fmt(buckets.margin.slice(0, 20)));
        set('feed-tool-deepnet', fmt(buckets.deepnet.slice(0, 20)));
        set('feed-tool-governor', fmt((govFeed.length ? govFeed : buckets.governor).slice(0, 20)));
        set('feed-tool-guard', fmt(guardFeed.concat(buckets.guard).slice(0, 20)));
        let srFeed = [];
        try { srFeed = (OsirisSelfReview.history || []).map(r => ({ t: new Date(r.ts).toLocaleTimeString('nl-NL'), what: `review @ ${r.atTrades} trades · winrate ${r.winrate != null ? (r.winrate * 100 | 0) + '%' : 'n/a'} · aggr ${r.aggr}`, why: (r.changes && r.changes.length ? r.changes.join('; ') : (r.notes || []).join('; ')) })); } catch (e) {}
        set('feed-tool-selfreview', fmt((srFeed.length ? srFeed : buckets.selfreview).slice(0, 20)));
        set('feed-margin-reasoning', (typeof marginState !== 'undefined' && marginState.reasoning && marginState.reasoning.length) ? marginState.reasoning.slice(0, 40).map(r => `<div>${new Date(r.ts).toLocaleTimeString('nl-NL')} &middot; ${r.txt}</div>`).join('') : '<span style="color:var(--text-dim); font-size:0.85em;">wacht op margin-beredenering&hellip;</span>');
    } catch (e) {}
}
window.renderLiveFeeds = renderLiveFeeds;

function autonomousEngineAdapt(reason = 'start') {
    try {
        const bot = learningLog.filter(l => !l.manual && l.outcome);
        if (bot.length < 5) {
            logAdaptation('Nog te weinig data om de engine te herzien', `wacht op meer trades (nu ${bot.length}, drempel 5) voordat autonome aanpassing veilig is`);
            return;
        }
        const wins = bot.filter(l => l.outcome === 'win');
        const winRate = wins.length / bot.length;
        const avgWin = wins.length ? wins.reduce((a, l) => a + (l.pnlPct || 0), 0) / wins.length : 0;
        const losses = bot.filter(l => l.outcome !== 'win');
        const avgLoss = losses.length ? losses.reduce((a, l) => a + (l.pnlPct || 0), 0) / losses.length : 0;

        // 1) MIN-PROBABILITY: als de kalibratie laat zien dat Neo overmoedig is
        //    (hoge scores maar lagere echte winrate), verhoog de instap-drempel.
        if (_calibMap && _calibMap.length >= 2) {
            const overconf = _calibMap.every(([raw, act]) => act < raw - 10);
            if (overconf && botSettings.minProbabilityPct < 80) {
                const old = botSettings.minProbabilityPct;
                botSettings.minProbabilityPct = Math.min(80, old + 2);
                logAdaptation(`Instap-drempel ${old}% &rarr; ${botSettings.minProbabilityPct}%`, `kalibratie toont overmoedige scores (werkelijke winrate ligt structureel onder de voorspelde) - strengere drempel filtert zwakke trades`);
            }
        }

        // 2) SCALP-ECONOMIE: als het scalp-winstdoel na kosten te krap is, verhoog het.
        const roundtrip = 2 * ((botSettings.feePct || 0.1) + (botSettings.slippagePct || 0.02));
        if (botSettings.minProjectedProfitPct < roundtrip * 1.3) {
            const old = botSettings.minProjectedProfitPct;
            botSettings.minProjectedProfitPct = +(roundtrip * 1.4).toFixed(2);
            logAdaptation(`Min. winstdoel ${old}% &rarr; ${botSettings.minProjectedProfitPct}%`, `winstdoel lag onder de round-trip kosten (${roundtrip.toFixed(2)}%) - trades met te weinig marge na kosten worden nu vermeden`);
        }

        // 3) RISICO: als de gemiddelde verliezer veel groter is dan de winnaar,
        //    trek de stop-loss iets strakker aan (asymmetrie herstellen).
        if (avgLoss < 0 && avgWin > 0 && Math.abs(avgLoss) > avgWin * 1.8 && botSettings.stopLossPct > 0.8) {
            const old = botSettings.stopLossPct;
            botSettings.stopLossPct = Math.max(0.8, +(old * 0.9).toFixed(2));
            logAdaptation(`Stop-loss ${old}% &rarr; ${botSettings.stopLossPct}%`, `gemiddeld verlies (${(avgLoss*100).toFixed(2)}%) was veel groter dan gemiddelde winst (${(avgWin*100).toFixed(2)}%) - strakkere stop herstelt de risk/reward`);
        }

        // 4) samenvatting als er niets aangepast hoefde te worden
        if (_adaptationLog.length === 0 || reason === 'start') {
            logAdaptation(`Engine herzien (winrate ${(winRate*100).toFixed(0)}%, ${bot.length} trades)`, `Neo heeft de instellingen tegen de data getoetst${_adaptationLog.length <= 1 ? ' - geen wijziging nodig, de huidige instellingen passen bij de data' : ''}`);
        }
        try { savePersistentState(); } catch (e) {}
    } catch (e) { /* stil */ }
}
window.autonomousEngineAdapt = autonomousEngineAdapt;

// Uniforme factor-lezer: leest een gewicht-factor uit BEIDE formaten in de learningLog
// (oude BTC influence-keys EN de korte ETH/SOL/margin-keys), zodat alle trades meetellen.
function _factorVal(factors, wKey) {
    if (!factors) return null;
    const map = { confluence: ['confluence'], nodeInfluence: ['nodeInfluence'], momentumInfluence: ['momentumInfluence', 'vfm'], fibConfluence: ['fibConfluenceInfluence'], pattern: ['patternInfluence'], rsi: ['rsiInfluence', 'rsi'], ema: ['emaInfluence', 'ema'], cnn: ['cnnInfluence'], nn: ['nnInfluence', 'nn'], nodeconf: ['nodeconfInfluence'], fundamentals: ['fundamentals'] };
    for (const k of (map[wKey] || [wKey])) { if (factors[k] != null && isFinite(factors[k])) return factors[k]; }
    return null;
}
// Herijkt de gewichten van EEN markt op basis van zijn eigen schone trades (contrafeitelijk,
// mediaan-split). Retourneert het aantal bijgestelde factoren.
function _recalibMarket(trades, weights, homeFor) {
    const wKeys = ['confluence', 'nodeInfluence', 'momentumInfluence', 'fibConfluence', 'pattern', 'rsi', 'ema', 'cnn', 'nn', 'nodeconf', 'fundamentals'];
    let adjusted = 0;
    for (const wKey of wKeys) {
        if (weights[wKey] == null) continue;
        const home = homeFor(wKey), isNode = (wKey === 'nn' || wKey === 'nodeconf');
        const vals = trades.map(l => ({ v: Math.abs(_factorVal(l.factors, wKey) ?? NaN), win: l.outcome === 'win' })).filter(x => isFinite(x.v));
        if (vals.length < MIN_SAMPLE_SIZE) continue;
        const sorted = vals.map(x => x.v).sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        let high = vals.filter(x => x.v > med), low = vals.filter(x => x.v <= med);
        if (high.length < 4 || low.length < 4) { const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length; high = vals.filter(x => x.v > mean); low = vals.filter(x => x.v <= mean); }
        if (high.length < 4 || low.length < 4) continue;
        const wHigh = high.filter(x => x.win).length / high.length, wLow = low.filter(x => x.win).length / low.length;
        const edge = wHigh - wLow, conf = Math.min(1, vals.length / 50);
        const target = home + edge * 2.0 * conf; const lr = 0.15, shrink = 0.03;
        let cur = weights[wKey]; cur = cur + (target - cur) * lr + (home - cur) * shrink;
        const loW = 0.5, hiW = isNode ? 3.0 : 1.6;
        weights[wKey] = Math.max(loW, Math.min(hiW, cur)); adjusted++;
    }
    return adjusted;
}

function recalibrateAdaptiveWeights() {
    computeCalibrationMap();
    for (const k of ['rsi', 'ema', 'cnn']) if (adaptiveWeights[k] == null) adaptiveWeights[k] = 1.0;
    if (adaptiveWeights.nn == null) adaptiveWeights.nn = 2.0;
    if (adaptiveWeights.nodeconf == null) adaptiveWeights.nodeconf = 2.0;
    const homeFor = (wKey) => (wKey === 'nn' || wKey === 'nodeconf') ? 2.0 : NEUTRAL_W;
    const clean = learningLog.filter(l => !l.manual && l.factors && l.outcome);
    const ts = Date.now();
    // BTC -> globale weights
    const btc = clean.filter(l => l.market == null || l.market === 'BTC');
    const nB = _recalibMarket(btc, adaptiveWeights, homeFor);
    adaptiveWeightsMeta.BTC = { lastUpdate: ts, trades: btc.length, nextIn: Math.max(0, MIN_SAMPLE_SIZE - btc.length), adjusted: nB };
    // ETH/SOL -> eigen sub-brein weights
    for (const mkt of ['ETH', 'SOL']) {
        const b = neoMultiState.markets[mkt] && neoMultiState.markets[mkt].brain;
        if (!b || !b.weights) continue;
        const tr = clean.filter(l => l.market === mkt);
        const nA = _recalibMarket(tr, b.weights, homeFor);
        adaptiveWeightsMeta[mkt] = { lastUpdate: ts, trades: tr.length, nextIn: Math.max(0, MIN_SAMPLE_SIZE - tr.length), adjusted: nA };
    }
    lastCalibrationSummary = { timestamp: formatFullDateTime(), summary: {} };
    try { const tot = (nB || 0) + Object.keys(adaptiveWeightsMeta).reduce((a, k) => a + (k !== 'BTC' && adaptiveWeightsMeta[k].adjusted || 0), 0); if (tot > 0) logLearningEvent(`L1 herijkt \u00b7 ${nB} BTC + ETH/SOL factoren bijgesteld (drempel ${MIN_SAMPLE_SIZE})`); } catch (e) {}
    try { renderLearningPanel(); } catch (e) {}
}

// ============================================================
// REGIME-GEWICHTEN HERIJKING (31-07)
// ============================================================
// Zelfde mechaniek als de globale recalibratie, maar toegepast PER regime: voor
// elk regime (trend/range/dood) vergelijkt het de winrate mét vs. zónder elke
// factor, maar alleen over de trades die in DAT regime zijn geopend. Zo leert
// bijv. het TREND-regime dat momentum zwaar telt, terwijl het RANGE-regime leert
// dat de mean-reversion-factoren (rsi/ema) daar belangrijker zijn.
function recalibrateRegimeWeights() {
    ensureRegimeWeights();
    const MIN = (typeof MIN_SAMPLE_SIZE !== 'undefined') ? MIN_SAMPLE_SIZE : 12;
    const factorMap = { confluence: 'confluence', nodeInfluence: 'nodeInfluence', momentumInfluence: 'momentumInfluence', fibConfluenceInfluence: 'fibConfluence', patternInfluence: 'pattern', rsiInfluence: 'rsi', emaInfluence: 'ema', cnnInfluence: 'cnn', nnInfluence: 'nn' };
    for (const regime of ['TREND', 'RANGE', 'DEAD']) {
        const trades = learningLog.filter(l => !l.manual && l.outcome && l.factors && (l.regime || 'RANGE') === regime);
        if (trades.length < MIN) continue;   // te weinig data voor dit regime -> ongewijzigd
        for (const [fk, wk] of Object.entries(factorMap)) {
            const present = trades.filter(l => l.factors[fk] != null && Math.abs(l.factors[fk]) > 1);
            const absent = trades.filter(l => l.factors[fk] != null && Math.abs(l.factors[fk]) <= 1);
            if (present.length < MIN || absent.length < 4) continue;
            const wPresent = present.filter(l => l.outcome === 'win').length / present.length;
            const wAbsent = absent.filter(l => l.outcome === 'win').length / absent.length;
            const edge = wPresent - wAbsent;             // positief = factor helpt in dit regime
            const cur = regimeWeights[regime][wk] ?? 1.0;
            // langzame bijstelling; node-factoren (nn/nodeconf) mogen tot 3.0 (starten op 2x),
            // de overige factoren blijven 0.3..2.0.
            const hiW = (wk === 'nn' || wk === 'nodeconf') ? 3.0 : 2.0;
            const next = Math.max(0.3, Math.min(hiW, cur + edge * 0.5));
            regimeWeights[regime][wk] = cur + (next - cur) * 0.3;   // demping
        }
    }
    try { localStorage.setItem('osirisRegimeWeights', JSON.stringify(regimeWeights)); } catch (e) {}
}

// ============================================================
// EXIT-OPTIMALISATIE-LAAG (31-07)
// ============================================================
// Leert systematisch welke EXIT-mechanismes winst opleveren en welke bloeden,
// uit de gesloten trades. De data liet zien dat exits (SMALL_PROFIT_HARVEST,
// EARLY_STOP_TREND) een grote invloed op de P/L hebben. Deze laag berekent per
// exit-reden de gemiddelde P/L en de trefkans, en stelt op basis daarvan een paar
// exit-parameters voorzichtig bij (binnen veilige grenzen). Transparant + gelogd.
let exitPolicy = { stats: {}, lastTune: 0 };
function recalibrateExitPolicy() {
    const bot = learningLog.filter(l => !l.manual && l.outcome && l.exitReason);
    if (bot.length < 15) return;
    // aggregeer per exit-reden
    const stats = {};
    for (const l of bot) {
        const r = l.exitReason;
        if (!stats[r]) stats[r] = { n: 0, wins: 0, sumPnl: 0, sumHold: 0 };
        stats[r].n++; stats[r].wins += l.outcome === 'win' ? 1 : 0;
        stats[r].sumPnl += l.pnlPct || 0; stats[r].sumHold += l.holdMinutes || 0;
    }
    for (const r in stats) { const s = stats[r]; s.winRate = s.wins / s.n; s.avgPnl = s.sumPnl / s.n; s.avgHold = s.sumHold / s.n; }
    exitPolicy.stats = stats;

    // AUTONOME BIJSTELLING (hooguit elke 5 min), binnen veilige grenzen:
    const now = Date.now();
    if (now - exitPolicy.lastTune < 5 * 60 * 1000) return;
    exitPolicy.lastTune = now;
    let changed = [];

    // 1) EARLY_STOP_TREND bloedt structureel? -> vroege trend-stop minder gevoelig
    //    maken (hogere minLossForEarlyExit = later pas uitstappen).
    const est = stats['EARLY_STOP_TREND'];
    if (est && est.n >= 8) {
        if (est.avgPnl < -0.004) {   // gemiddeld verlies bij deze exit -> te vroeg eruit
            const old = botSettings.minLossForEarlyExit;
            botSettings.minLossForEarlyExit = Math.min(0.02, botSettings.minLossForEarlyExit + 0.001);
            if (botSettings.minLossForEarlyExit !== old) changed.push(`early-stop drempel -> ${(botSettings.minLossForEarlyExit*100).toFixed(2)}%`);
        } else if (est.avgPnl > 0.002 && est.winRate > 0.55) {   // werkt juist goed -> mag gevoeliger
            const old = botSettings.minLossForEarlyExit;
            botSettings.minLossForEarlyExit = Math.max(0.004, botSettings.minLossForEarlyExit - 0.001);
            if (botSettings.minLossForEarlyExit !== old) changed.push(`early-stop drempel -> ${(botSettings.minLossForEarlyExit*100).toFixed(2)}%`);
        }
    }
    // 2) SMALL_PROFIT_HARVEST te gulzig (pakt te vroeg kleine winst)? Als de gemiddelde
    //    winst mager is EN de hold kort, geef trades meer tijd (langere harvest-window).
    const sph = stats['SMALL_PROFIT'] || stats['SMALL_PROFIT_HARVEST'];
    if (sph && sph.n >= 8) {
        if (sph.avgPnl > 0 && sph.avgPnl < 0.003) {
            const old = botSettings.smallProfitHarvestMinutes;
            botSettings.smallProfitHarvestMinutes = Math.min(90, botSettings.smallProfitHarvestMinutes + 5);
            if (botSettings.smallProfitHarvestMinutes !== old) changed.push(`harvest-window -> ${botSettings.smallProfitHarvestMinutes}min`);
        }
    }
    if (changed.length) {
        try { logBotAction('EXIT_TUNE', livePrice, '-', 0, 0, 'exit-optimalisatie: ' + changed.join(', ')); } catch (e) {}
        try { savePersistentState(); } catch (e) {}
    }
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
// AUTONOOM ZELF-STRETCHENDE WINST-GREEP (30-07)
// Berekent hoeveel % van de piekwinst Neo wil vasthouden. Basis = de door de
// gebruiker ingestelde profitProtectKeepPct. Die wordt omhoog gestretcht (winst
// laten lopen) als de kans op verdere winst hoog is, en strakker aangetrokken
// als de kans wegzakt. Alles begrensd zodat het nooit onveilig wordt.
function dynamicProfitKeepPct(pos) {
    const baseKeep = botSettings.profitProtectKeepPct;   // bijv. 80
    // 1) hoe hoog is de kans dat deze richting doorzet? (live-continuation)
    let contProb = null;
    try {
        const c = evaluateContinuationWithConfirmation ? null : null;   // niet de bevestigde variant (die heeft cooldown)
    } catch (e) {}
    // gebruik de directe kans-score voor deze richting als proxy voor "gaat het door?"
    let dirProb = 50;
    try {
        if (lastOsirisDecision) {
            const chaos = lastOsirisMetrics?.chaos ?? 0, er = lastOsirisMetrics?.er ?? 0;
            const isBull = lastOsirisMetrics?.isBullish ?? null;
            dirProb = calculateProbabilityScore(lastOsirisDecision.confluence ?? 0, chaos, er, 0, 0, 0, pos.side, isBull, 0);
        }
    } catch (e) {}
    // 2) momentum aligned met de positie?
    let aligned = 0;
    try {
        const mc = lastOsirisMetrics?.momentumContext;
        if (mc) {
            if (pos.side === 'LONG' && mc.consecutiveBullish > mc.consecutiveBearish) aligned = 1;
            else if (pos.side === 'SHORT' && mc.consecutiveBearish > mc.consecutiveBullish) aligned = 1;
            else aligned = -1;
        }
    } catch (e) {}
    // 3) hoe groter de piekwinst, hoe meer we durven laten lopen (winst beschermt zichzelf al)
    const peakBonus = Math.min(8, (pos.peakPnlPct || 0) * 100 * 4);   // +8% keep bij ~2% piek

    // stretch: hoge kans + aligned momentum => hogere keep (laat lopen).
    // dirProb 50 => 0 effect; 85 => +~10; plus momentum ±4; plus peakBonus.
    let keep = baseKeep + (dirProb - 60) * 0.35 + aligned * 4 + peakBonus;
    // veilige grenzen: nooit lager dan 40% (anders te los) of hoger dan 95% (anders te strak op de piek)
    keep = Math.max(40, Math.min(95, keep));

    // AUTONOME PRESET-BIJSTELLING: als deze stretch-strategie in de praktijk goed
    // uitpakt, mag Neo de BASIS-preset langzaam mee laten schuiven (binnen grenzen).
    maybeAutoTuneProfitKeep();
    return keep;
}

// Neo stelt zijn eigen profitProtectKeepPct-basis heel langzaam bij op basis van
// of PROFIT_PROTECT-exits gemiddeld winst of spijt opleverden. Zeer voorzichtig,
// begrensd, en alleen met genoeg data - transparant, geen black box.
let _lastKeepTune = 0;
function maybeAutoTuneProfitKeep() {
    const now = Date.now();
    if (now - _lastKeepTune < 5 * 60 * 1000) return;      // hooguit elke 5 min
    const pp = learningLog.filter(l => !l.manual && (l.exitReason || '').startsWith('PROFIT'));
    if (pp.length < 20) return;
    _lastKeepTune = now;
    // gemiddelde pnl van profit-protect exits; als sterk positief -> we mogen losser
    // (hoger laten lopen); als mager -> strakker grijpen.
    const avg = pp.reduce((a, l) => a + (l.pnlPct || 0), 0) / pp.length;
    let delta = 0;
    if (avg > 0.006) delta = -1;        // winsten groot => greep iets losser (lager keep%) om meer te laten lopen
    else if (avg < 0.002) delta = +1;   // winsten mager => greep strakker
    if (delta !== 0) {
        botSettings.profitProtectKeepPct = Math.max(50, Math.min(90, botSettings.profitProtectKeepPct + delta));
        try { logBotAction('AUTO_TUNE', livePrice, '-', 0, 0, `winst-greep basis -> ${botSettings.profitProtectKeepPct}% (avg PP-exit ${(avg * 100).toFixed(2)}%)`); } catch (e) {}
        try { savePersistentState(); } catch (e) {}
    }
}

function checkOpenPositionsExits() {
    if (openPositions.length === 0 || !livePrice) return;

    const survivors = [];
    openPositions.forEach(pos => {
        // ICT-posities hebben hun eigen strakke micro-target/stop en slaan de
        // reguliere (te vroeg sluitende) trend-exitlogica volledig over.
        if (pos.isIct) {
            if (checkIctExit(pos)) return;
            survivors.push(pos);
            return;
        }
        // MUNT-BEWUSTE PRIJS: BTC-posities gebruiken livePrice; Osiris ETH/SOL-posities
        // gebruiken de prijs van hun eigen markt uit de multi-asset motor. Zo worden
        // stops/targets/P-L voor elke munt op de JUISTE prijs berekend.
        let posPrice = livePrice;
        if (pos.isOsiris && pos.symbol) {
            const symKey = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol);
            const mm = symKey ? neoMultiState.markets[symKey] : null;
            if (mm && mm.lastPrice != null) posPrice = mm.lastPrice;
        }
        // effectieve engine-config: BTC gebruikt de globale botSettings, Osiris ETH/SOL
        // gebruiken hun eigen munt-preset (stop, doel, trailing, exits, drempels).
        const cfg = effectiveConfig(pos);
        const pnlPct = pos.side === 'LONG'
            ? (posPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - posPrice) / pos.entryPrice;
        pos.mfe = Math.max(pos.mfe != null ? pos.mfe : 0, pnlPct);
        pos.mae = Math.min(pos.mae != null ? pos.mae : 0, pnlPct);
        // RL SCHAAL-BIJ (live): zegt de agent SCHAAL met zekerheid en staat de positie in
        // winst, laad dan bounded bij (+deel van de huidige grootte, gewogen entry, max 1×
        // per positie, alleen als er vrije equity is). Zo laat de RL-policy winnaars groeien.
        try {
            if (typeof OsirisRL !== 'undefined' && OsirisRL.ENABLED && OsirisRL.INFLUENCE && OsirisRL.episodes > 2000 && (pos.scaleCount || 0) < 1 && pnlPct > 0.0015 && posPrice) {
                const _ssym = (pos.isOsiris && pos.symbol && typeof MULTI_BINANCE !== 'undefined') ? Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) : 'BTC';
                const _sm = neoMultiState.markets[_ssym];
                const _sage = (Date.now() - (pos.openTime || 0)) / 60000;
                const _dec = OsirisRL.decide(pos, _sm, pnlPct, _sage);
                if (_dec && _dec.action === 3 && _dec.conf > 0.5) {
                    const freePct = Math.max(0, 1 - getAllocatedPct() - (botSettings.minHedgeReservePct || 0));
                    const addPct = Math.min((pos.sizePct || 0.1) * 0.5, freePct);
                    if (addPct > 0.02) {
                        const addNotional = getEquity() * addPct;
                        const addAmount = addNotional / posPrice;
                        pos.entryPrice = (pos.entryPrice * pos.amount + posPrice * addAmount) / (pos.amount + addAmount);
                        pos.amount += addAmount; pos.notional = (pos.notional || 0) + addNotional; pos.sizePct = (pos.sizePct || 0) + addPct;
                        pos.scaleCount = (pos.scaleCount || 0) + 1;
                        try { logBotAction('SCALE', posPrice, pos.side, 0, addAmount, `RL SCHAAL-BIJ (+${(addPct * 100 | 0)}% op winnaar, zekerheid ${(_dec.conf * 100 | 0)}%)`, 0, addNotional, false, (pos.isOsiris && pos.symbol ? _ssym : 'BTC'), pos.isOsiris === true); } catch (e) {}
                        try { logAdaptation('RL laadt bij op winnaar', `${_ssym} ${pos.side} +${(addPct * 100 | 0)}% (RL SCHAAL, zekerheid ${(_dec.conf * 100 | 0)}%, winst +${(pnlPct * 100).toFixed(2)}%)`); } catch (e) {}
                        try { updatePositionLines(); updateWalletUI(); } catch (e) {}
                    }
                }
            }
        } catch (e) {}

        // 1. Harde stop-loss: -2% (of, voor een range-scalp, de eigen krappere
        // stop) - niet onderhandelbaar.
        const activeStopLossPct = pos.customStopLossPct ?? cfg.stopLossPct;
        if (pnlPct <= -activeStopLossPct) {
            closePosition(pos, pnlPct, "STOP_LOSS");
            return;
        }

        // 1b. Piek ALTIJD bijhouden - voorheen gebeurde dit pas boven de
        // profitHoldTriggerPct (2%), waardoor de hele 0.3-0.8%-zone (waar in
        // de praktijk vrijwel alle winnaars leven) geen piekregistratie en
        // dus geen giveback-bescherming had.
        pos.peakPnlPct = Math.max(pos.peakPnlPct || 0, pnlPct);

        // 1c. WINST-BESCHERMING (30-07: AUTONOOM ZELF-STRETCHEND).
        // De greep is niet langer een vaste 80%. Neo berekent hem dynamisch: staat
        // de positie in winst EN blijft de kans op verdere winst hoog (live-kans,
        // momentum aligned, sterke confluence in dezelfde richting), dan STRETCHT de
        // greep omhoog (bijv. 80% -> 92%) zodat de winst kan doorlopen. Zakt de kans,
        // dan trekt de greep strakker aan om de winst veilig te stellen. De basis
        // blijft de door de gebruiker ingestelde profitProtectKeepPct.
        if (!pos.isScalp && (pos.peakPnlPct || 0) >= cfg.profitProtectActivationPct) {
            const dynKeep = dynamicProfitKeepPct(pos);
            pos._dynKeep = dynKeep;   // voor de UI/logging zichtbaar
            if (pnlPct <= pos.peakPnlPct * (dynKeep / 100)) {
                closePosition(pos, pnlPct, `PROFIT_PROTECT (piek +${(pos.peakPnlPct * 100).toFixed(2)}%, ${dynKeep.toFixed(0)}%-greep${dynKeep > cfg.profitProtectKeepPct + 1 ? ' \u2191gestretcht' : ''})`);
                return;
            }
        }

        // 2. Winst >= 2%: Osiris mag zelf beslissen om te blijven zitten als
        // trend/momentum/kans nog steeds gunstig zijn (evaluateContinuation,
        // drempel = minProbabilityPct, GEEN "ruimte tot doel"-eis meer - die
        // hoort bij nieuwe instappen, niet bij het vasthouden van een
        // al winstgevende positie). Een trailing stop borgt de winst zodat
        // "laten lopen" niet alsnog in een verlies kan eindigen.
        if (pnlPct >= cfg.profitHoldTriggerPct) {
            pos.peakPnlPct = Math.max(pos.peakPnlPct || 0, pnlPct);
            const floorPct = cfg.profitHoldTriggerPct - cfg.trailBufferPct;
            pos.trailingStopPct = Math.max(pos.trailingStopPct ?? floorPct, pos.peakPnlPct - cfg.trailBufferPct);

            if (pnlPct <= pos.trailingStopPct) {
                closePosition(pos, pnlPct, "TRAILING_STOP");
                return;
            }

            const continuation = evaluateContinuationWithConfirmation(pos, pos.side, cfg.holdContinuationMinProbabilityPct);
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
        if (pnlPct >= cfg.minProfitForTrendExit) {
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
        if (pnlPct < 0 && Math.abs(pnlPct) >= cfg.minLossForEarlyExit) {
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
        if (!pos.isScalp && cfg.smallProfitHarvestMinutes > 0) {
            const ageMinH = (Date.now() - (pos.openTime || 0)) / 60000;
            // LET WINNERS RUN (16-08): oogst de kleine winst NIET als de richting nog
            // steeds in ons voordeel is - laat 'm doorlopen (richting de trailing-zone)
            // i.p.v. sluiten en meteen dezelfde kant weer openen.
            let _stillFavored = false;
            try {
                const _wsym = (pos.isOsiris && pos.symbol && typeof MULTI_BINANCE !== 'undefined') ? Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) : 'BTC';
                const _wm = neoMultiState.markets[_wsym];
                const _wthr = (typeof osirisTune !== 'undefined' && osirisTune.minProb) ? osirisTune.minProb : 0.55;
                if (_wm && _wm.bestSide === pos.side && (_wm.bestProb || 0) >= _wthr) _stillFavored = true;
                // RL-agent (advies): zegt hij HOLD/TRAIL met zekerheid, laat dan doorlopen;
                // zegt hij SLUIT, dan mag geoogst worden. Harde stops blijven altijd staan.
                try {
                    if (typeof OsirisRL !== 'undefined' && OsirisRL.ENABLED && OsirisRL.INFLUENCE && OsirisRL.episodes > 2000) {
                        const dec = OsirisRL.decide(pos, _wm, pnlPct, ageMinH);
                        if (dec && dec.conf > 0.4) {
                            if (dec.action === 0 || dec.action === 2) _stillFavored = true;   // HOLD/TRAIL -> laten lopen
                            else if (dec.action === 1) _stillFavored = false;                 // SLUIT -> oogsten toegestaan
                        }
                    }
                } catch (e) {}
            } catch (e) {}
            if (pnlPct >= roundTripCostPct() / 100 &&
                (pos.peakPnlPct || 0) < cfg.profitProtectActivationPct &&
                ageMinH >= cfg.smallProfitHarvestMinutes && !_stillFavored) {
                closePosition(pos, pnlPct, `SMALL_PROFIT_HARVEST (+${(pnlPct * 100).toFixed(2)}% na ${ageMinH.toFixed(0)} min - doorstoten statistisch onwaarschijnlijk)`);
                return;
            }
        }

        // 4a-bis. TIJD-STOP: positie hangt na maxPositionAgeMinutes nog binnen
        // de kostenband rond break-even - de these is niet uitgekomen, het
        // kapitaal kan beter opnieuw beoordeeld worden. (Alleen trend-posities;
        // scalps hebben hun eigen krappe doel/stop.)
        if (!pos.isScalp && cfg.maxPositionAgeMinutes > 0) {
            const ageMin = (Date.now() - (pos.openTime || 0)) / 60000;
            const costBand = roundTripCostPct() / 100;
            // DYNAMISCHE TIJD-STOP met A/B: elke positie krijgt eenmalig een modus
            // (DYN vs FIXED). Osiris meet welke betere break-even-exits geeft en zet de
            // dynamische stop autonoom terug als hij slechter blijkt (zie evaluateTimeStopAB).
            let deadline = cfg.maxPositionAgeMinutes, dyn = false;
            try {
                if (typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.LIVE) {
                    if (!pos._tsMode) pos._tsMode = OsirisDeepNet.assignTsMode();
                    if (pos._tsMode === 'DYN') {
                        deadline = OsirisDeepNet.dynamicTimeStopMinutes(pos, cfg.maxPositionAgeMinutes);
                        dyn = true;
                    }
                }
            } catch (e) {}
            if (ageMin >= deadline && Math.abs(pnlPct) < costBand) {
                // TIME-STOP KALIBRATIE (16-08): staat de positie (licht) negatief maar is de
                // kans op succes in dezelfde richting ECHT groot, houd dan langer vast i.p.v.
                // sluiten en meteen dezelfde kant weer openen. Alleen bij zeer sterk signaal.
                try {
                    if (pnlPct < 0) {
                        const _tsym = (pos.isOsiris && pos.symbol && typeof MULTI_BINANCE !== 'undefined') ? Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) : 'BTC';
                        const _tm = neoMultiState.markets[_tsym];
                        const _rlHold = (typeof OsirisRL !== 'undefined' && OsirisRL.episodes > 2000) ? (() => { const dd = OsirisRL.decide(pos, _tm, pnlPct, ageMin); return dd && (dd.action === 0 || dd.action === 2) && dd.conf > 0.55; })() : false;
                        if (_tm && _tm.bestSide === pos.side && ((_tm.bestProb || 0) >= 0.65 || _rlHold) && (pos._tsHoldCount || 0) < 2) {
                            pos._tsHoldCount = (pos._tsHoldCount || 0) + 1;
                            pos.openTime = (pos.openTime || Date.now()) + deadline * 0.5 * 60000;   // deadline verlengen
                            try { logAdaptation('Osiris houdt langer vast', `${_tsym} ${pos.side} negatief maar kans ${(( _tm.bestProb||0)*100|0)}%${_rlHold ? ' + RL-HOLD' : ''} - time-stop uitgesteld i.p.v. sluiten+heropenen`); } catch (e) {}
                            return;
                        }
                    }
                } catch (e) {}
                try { if (typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.LIVE) OsirisDeepNet.recordTimeStop(pos._tsMode || 'FIXED', pnlPct); } catch (e) {}
                closePosition(pos, pnlPct, `TIME_STOP (${ageMin.toFixed(0)}/${deadline.toFixed(0)} min${dyn ? ' dyn-EV' : ' vast'} - these niet uitgekomen)`);
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
        if (!pos.isScalp && cfg.probCollapseEnabled) {
            const liveProb = smoothProb(pos.side, evaluateContinuation(pos.side).probabilityPct);
            if (liveProb !== null && liveProb <= cfg.probCollapseThresholdPct) {
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
                if ((Date.now() - pos.probCollapseSince) / 1000 >= cfg.probCollapseConfirmSeconds) {
                    closePosition(pos, pnlPct, `PROB_COLLAPSE_EXIT (winkans ${liveProb.toFixed(0)}% al ${cfg.probCollapseConfirmSeconds}s onder ${cfg.probCollapseThresholdPct}%)`);
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
    // munt-bewust: exporteer de historie van de actieve tab-munt (BTC = rawData,
    // ETH/SOL = de klines uit de multi-asset motor).
    const sym = (typeof neoMultiState !== 'undefined' && neoMultiState) ? neoMultiState.active : 'BTC';
    let src = rawData;
    if (sym !== 'BTC') {
        const m = neoMultiState.markets[sym];
        src = (m && m.klines && m.klines.length) ? m.klines : null;
    }
    if (!src || src.length === 0) {
        alert(`Geen prijs/volume-data beschikbaar voor ${sym}.`);
        return;
    }
    const headers = ["Datum/Tijd (UTC)", "Open", "High", "Low", "Close", "Volume"];
    const rows = src.map(d => [
        new Date(d[0]).toISOString(), d[1], d[2], d[3], d[4], d[5]
    ].join(","));
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `osiris_price_volume_history_${sym}.csv`);
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
        })),
        // MULTI-MARKT: volledige per-munt state (ETH/SOL/BTC) incl. candle-buffers
        multiMarket: (typeof neoMultiState !== 'undefined' && neoMultiState.markets) ? Object.fromEntries(
            Object.keys(neoMultiState.markets).map(k => {
                const m = neoMultiState.markets[k];
                return [k, { lastPrice: m.lastPrice, ema: m.ema, emaSlow: m.emaSlow, rsi: m.rsi, vfm: m.vfm, chaos: m.chaos, bestProb: m.bestProb, bestSide: m.bestSide, subBrainLabel: m.subBrainLabel, nnRitmeMin: m.nnRitmeMin, nnCaps: m.nnCaps, sentScore: m.sentScore != null ? m.sentScore : null, fund: m.fund || null, candles: m.candles }];
            })
        ) : null,
        // ZELF-LERENDE MODELLEN: DeepNet (per markt) + L2/L3 + HMM-regime + shadow-backtest
        deepNetModels: (typeof OsirisDeepNet !== 'undefined') ? { markets: OsirisDeepNet.markets, last: OsirisDeepNet.last, abstainMargin: OsirisDeepNet.ABSTAIN_MARGIN } : null,
        regimeHMM: (typeof OsirisRegimeHMM !== 'undefined') ? { label: OsirisRegimeHMM.label, prob: OsirisRegimeHMM.prob, stable: OsirisRegimeHMM.stable, current: OsirisRegimeHMM.current, order: OsirisRegimeHMM.order, means: OsirisRegimeHMM.means, trans: OsirisRegimeHMM.trans } : null,
        shadowBacktest: (typeof OsirisShadowBacktest !== 'undefined') ? OsirisShadowBacktest.best : null,
        osirisTune: (typeof osirisTune !== 'undefined') ? osirisTune : null,
        pendingSweeps: (typeof _osirisSweep !== 'undefined') ? _osirisSweep : null,
        margin: (typeof marginState !== 'undefined') ? {
            enabled: marginEngineEnabled, leverage: marginLeverage, minProb: MARGIN_MIN_PROB, targetMult: MARGIN_TARGET_MULT, fsoPause: MARGIN_FSO_PAUSE,
            equity: (typeof marginEquity === 'function' ? marginEquity() : marginState.equity),
            equitySource: marginState.equitySource || 'sim', walletBalance: marginState.walletBalance != null ? marginState.walletBalance : null, exchangeStart: marginState.exchangeStart != null ? marginState.exchangeStart : null, equitySyncedAt: marginState.equitySyncedAt || null, hasFuturesKeys: (typeof marginKeys === 'function' ? !!marginKeys().apiKey : null),
            wsState: marginState.wsState || null, wsReconnects: marginState.wsReconnects || 0, wsLastError: marginState.wsLastError || null,
            realizedPnL: marginState.realizedPnL, wins: marginState.wins, losses: marginState.losses,
            openPositions: marginState.positions, closed: marginState.closed, tradeLog: marginState.tradeLog.slice(0, 200),
            reasoning: marginState.reasoning, adaptation: marginState.adaptation, startEquity: marginState.startEquity, startTime: marginState.startTime
        } : null,
        networkErrors: (typeof osirisNetworkErrors !== 'undefined') ? osirisNetworkErrors.slice(0, 150) : [],
        fso: (typeof OsirisFSO !== 'undefined') ? {
            current: (typeof osirisStress !== 'undefined') ? osirisStress : null,
            scales: Object.fromEntries(['micro', 'meso', 'macro', 'full'].map(k => { const S = OsirisFSO.scales[k]; return [k, S ? { regime: S.regime, stress: +S.current.toFixed(4), variance: +S.curVar.toFixed(5), marketsUsed: S.marketsUsed, points: S.stress.length, oscillators: S.names, lastTime: S.times ? S.times[S.times.length - 1] : null } : null]; })),
            history: (typeof osirisFSOLog !== 'undefined') ? osirisFSOLog.slice(0, 300) : [],
            oscillatorsUsed: 'per munt: realized-vol, drawdown, volume-Z, range, RSI-extremiteit; cross-market: correlatie-breuk, return-dispersie (OHLCV-afgeleid, Binance BTC/ETH/SOL)'
        } : null,
        // KINETISCHE BREAKPOINT-ENGINE: per-munt PE/KE/Loading/Shock + synchronie, de
        // afgevuurde breakpoint-voorspellingen, hun scoring en de kalibratie/metrieken.
        kinetic: (typeof OsirisKinetic !== 'undefined') ? OsirisKinetic.exportBundle() : null,
        // META-LAAG: governor-trustgewichten (out-of-sample), voorspellingen + scoring,
        // guardian data-integriteit en portfolio-risico.
        meta: (typeof osirisMetaBundle === 'function') ? osirisMetaBundle() : null,
        // SCHEMA: beschrijft de velden in metricsHistory/learningLog voor runtime-reconstructie
        datasetSchema: {
            metricsHistory: 'timestamp, symbol, botVersion, executionSource, price, vfm, er, db, chaos, liveVol, volRate, rsi, emaFast, emaSlow, volumeShiftPct, nodeInfluence, lastNodeType, nextNodeType, minutesSinceLastNode, minutesUntilNextNode, probabilityPct, isBullish',
            learningLog: 'timestampMs, side, market, outcome, pnlPct, exitReason, mfePct, maePct, walletFill, executionSource, botVersion, holdMinutes, entryProbabilityPct, configVersion, entryHourUTC, regimeAtEntry',
            tradeLog: 'action, price, side, pnlPct, amount, reason, pnlAmount, notional, market, isOsiris, mfePct, maePct, walletFill, executionSource, botVersion, entryPrice, holdMinutes, timestamp/timestampMs'
        }
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

// IMPORT (30-07): zet Neo's geleerde geheugen terug uit een eerder geexporteerd
// JSON-bestand. Dit maakt de export een ECHTE back-up: raak je localStorage kwijt
// (cache/site-data gewist, ander apparaat), dan laad je hier je learningLog,
// adaptieve gewichten, trade-historie en wallet weer in. Vraagt eerst bevestiging.
function importOsirisData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const d = JSON.parse(e.target.result);
            const n = (d.learningLog || []).length;
            const ok = confirm(
                `Import: ${n} learning-entries, ${(d.tradeLog || []).length} trades.\n\n` +
                `Dit VERVANGT Neo's huidige geheugen (learning, gewichten, trade-historie, wallet) ` +
                `door de inhoud van dit bestand. Doorgaan?`
            );
            if (!ok) return;
            if (Array.isArray(d.learningLog)) learningLog = d.learningLog;
            if (d.adaptiveWeights) {
                adaptiveWeights = d.adaptiveWeights;
                for (const k of ['confluence','nodeInfluence','momentumInfluence','fibConfluence','pattern','rsi','ema','cnn'])
                    if (adaptiveWeights[k] == null) adaptiveWeights[k] = 1.0;
            }
            if (Array.isArray(d.tradeLog)) botTradeLog = d.tradeLog;
            if (Array.isArray(d.sessionLog)) sessionLog = d.sessionLog;
            if (d.wallet && typeof d.wallet === 'object') {
                // alleen de kernvelden overnemen, defensief
                if (isFinite(d.wallet.balance)) walletState.balance = d.wallet.balance;
                if (isFinite(d.wallet.realized ?? d.wallet.realizedPnL)) walletState.realizedPnL = d.wallet.realized ?? d.wallet.realizedPnL;
                if (isFinite(d.wallet.wins)) walletState.wins = d.wallet.wins;
                if (isFinite(d.wallet.losses)) walletState.losses = d.wallet.losses;
            }
            _factorProbCache = { at: 0, table: null };   // forceer herberekening op de nieuwe data
            try { computeCalibrationMap(); } catch (er) {}
            try { savePersistentState(); } catch (er) {}
            try { renderLearningPanel(); renderCalibrationCurve(); updateWalletUI(); } catch (er) {}
            alert(`Import geslaagd: ${n} learning-entries teruggezet. Neo gebruikt nu deze historie.`);
        } catch (err) {
            alert('Import mislukt: kon het bestand niet lezen (' + err.message + ').');
        }
    };
    reader.readAsText(file);
}
window.importOsirisData = importOsirisData;
// HEARTBEAT
// ============================================================
// Globale variabele om de 10-seconden cyclus bij te houden
let botTickCounter = 0;

// Live neuraal-net tab: per-markt core-gauges (conf-ring, calProb, meta+reden,
// walk-forward-stats), het L1/L2/L3-ensemble en de live signalen per markt.
// Read-only op bestaande state; raakt geen trading-logica.
function syncNetTab() {
    try {
        if (typeof OsirisDeepNet === 'undefined') return;
        const COL = { BTC: '#f7931a', ETH: '#8aa0ff', SOL: '#14f195' };
        for (const K of ['BTC', 'ETH', 'SOL']) {
            const k = K.toLowerCase();
            const ring = document.getElementById('cc-ring-' + k);
            if (!ring) continue;
            const p = OsirisDeepNet.last[K];
            const wf = (OsirisDeepNet.markets[K] || {}).wf;
            const sideEl = document.getElementById('cc-side-' + k);
            const valEl = document.getElementById('cc-val-' + k);
            const metaEl = document.getElementById('cc-meta-' + k);
            const statsEl = document.getElementById('cc-stats-' + k);
            const cardEl = ring.closest ? ring.closest('.core-card') : null;
            if (!p) { if (valEl) valEl.textContent = '--'; ring.style.setProperty('--cc-pct', '0'); continue; }
            const sideCol = p.side === 'SHORT' ? '#ff5f7e' : '#14f195';
            const col = p.meta ? sideCol : '#5c7488';
            const conf = Math.round((p.conf || 0) * 100);
            ring.style.setProperty('--cc-pct', String(conf));
            ring.style.setProperty('--cc-col', col);
            if (cardEl) cardEl.style.setProperty('--cc-col', col);
            const arrow = p.side === 'SHORT' ? '\u2193' : '\u2191';
            // Bij onzekerheid (geen trade, bijna 50/50) tonen we NEUTRAL i.p.v. LONG/SHORT,
            // anders staat er "51% LONG" terwijl de poort "uncertain" is - dat klopt niet.
            const dirLabel = p.trade ? `${arrow} ${p.side}` : '&middot; NEUTRAL';
            const dirCol = p.trade ? col : '#7d99ac';
            if (valEl) valEl.innerHTML = `${(p.calProb * 100).toFixed(0)}%<br><span style="font-size:0.5rem;color:${dirCol}">${dirLabel}</span>`;
            if (sideEl) { sideEl.textContent = p.meta ? 'meta open' : 'dicht'; sideEl.style.color = p.meta ? '#14f195' : '#ff5f7e'; }
            if (metaEl) {
                if (p.meta) metaEl.innerHTML = `<span style="color:#14f195">gate open &middot; conf ${conf}%</span>`;
                else {
                    let reden = 'low wf-precision';
                    if (!p.trade) reden = 'uncertain (\u226440% or \u226560%)';
                    else if (p.agree === false) reden = 'core disagrees';
                    metaEl.innerHTML = `<span style="color:#ff8a94">gate closed &middot; ${reden}</span>`;
                }
            }
            if (statsEl && wf) statsEl.innerHTML = `<span>prec <b>${(wf.precision * 100).toFixed(0)}%</b></span><span>acc <b>${(wf.acc * 100).toFixed(0)}%</b></span><span>cov <b>${(wf.coverage * 100).toFixed(0)}%</b></span>`;
        }
        const ens = document.getElementById('net-ensemble');
        if (ens) {
            const l2 = (typeof _l2 !== 'undefined') ? _l2 : null;
            const l3 = (typeof _l3 !== 'undefined') ? _l3 : null;
            ens.innerHTML =
                `<div>L1 &middot; factor weights &mdash; <b style="color:#14f195">adaptive active</b></div>` +
                `<div>L2 &middot; logistic &mdash; ${(l2 && l2.trained) ? `<b style="color:#14f195">trained</b> &middot; n=${l2.trainedOn || '?'}` : '<span class="muted">not trained</span>'}</div>` +
                `<div>L3 &middot; neural &mdash; ${(l3 && l3.trained) ? `<b style="color:#14f195">val ${(l3.valAcc * 100).toFixed(0)}%</b> &middot; blend ${((((l3.weightCap && l3.weightCap.cap) || 0.15)) * 100).toFixed(0)}%` : '<span class="muted">not trained</span>'}</div>`;
        }
        const sig = document.getElementById('net-signals');
        if (sig && typeof neoMultiState !== 'undefined') {
            sig.innerHTML = ['BTC', 'ETH', 'SOL'].map(K => {
                const m = neoMultiState.markets[K];
                if (!m) return `<span style="color:${COL[K]}">${K}</span> <span class="muted">--</span>`;
                const rsi = m.rsi != null ? m.rsi.toFixed(0) : '--';
                const vfm = m.vfm != null ? m.vfm.toFixed(2) : '--';
                const chaos = m.chaos != null ? m.chaos.toFixed(2) : '--';
                const prob = m.bestProb != null ? (m.bestProb * 100).toFixed(0) + '%' : '--';
                return `<span style="color:${COL[K]}">${K}</span> ${prob} ${m.bestSide || ''} &middot; RSI ${rsi} &middot; VFM ${vfm} &middot; CHAOS ${chaos}`;
            }).join('<br>');
        }
        // HMM regime-paneel + system-badge
        if (typeof OsirisRegimeHMM !== 'undefined') {
            const H = OsirisRegimeHMM;
            const rc = { trending: '#14f195', volatiel: '#ffb627', compressie: '#7fd8ff', kalm: '#8aa0ff' };
            const label = (H.label || 'kalibreert…');
            const col = rc[label] || '#c792ea';
            const rEl = document.getElementById('hmm-regime'); if (rEl) { rEl.textContent = label.toUpperCase(); rEl.style.color = col; }
            const sEl = document.getElementById('hmm-stable'); if (sEl) { sEl.textContent = H.trained ? `${H.stable} candles stabiel` : 'kalibreert'; sEl.style.color = H.stable >= 3 ? '#14f195' : '#5c7488'; }
            const dEl = document.getElementById('hmm-detail'); if (dEl && H.trained) dEl.innerHTML = `zekerheid <b style="color:${col}">${(H.prob * 100).toFixed(0)}%</b> &middot; Gaussian HMM (Baum-Welch) &middot; 4 states op de candle-buffer`;
            const badge = document.getElementById('sys-hmm-regime'); if (badge) { badge.innerHTML = `Regime (HMM): <b style="color:${col}">${label.toUpperCase()}</b>${H.trained ? ` &middot; ${(H.prob * 100).toFixed(0)}% &middot; ${H.stable} stabiel` : ''}`; }
        }
        // Shadow-backtest-paneel
        if (typeof OsirisShadowBacktest !== 'undefined') {
            const B = OsirisShadowBacktest;
            const bEl = document.getElementById('bt-best');
            const shEl = document.getElementById('bt-sharpe');
            const btd = document.getElementById('bt-detail');
            if (B.best) {
                if (bEl) bEl.innerHTML = `target <b style="color:#14f195">${B.best.target}%</b> &middot; stop <b style="color:#ff8a94">${B.best.stop}%</b>`;
                if (shEl) { shEl.textContent = `Sharpe ${B.best.sharpe.toFixed(2)}`; shEl.style.color = B.best.sharpe > 0.3 ? '#14f195' : '#ffb627'; }
                if (btd) btd.innerHTML = `beste van ${B.tested} combinaties &middot; ${B.best.n} sim-trades &middot; gem ${B.best.mean.toFixed(3)}%/trade`;
            }
        }
        // SWEEP-ENTRY status: welke munten wachten op hun liquidatie-/stop-niveau
        const swEl = document.getElementById('net-sweep');
        if (swEl && typeof _osirisSweep !== 'undefined') {
            const keys = Object.keys(_osirisSweep);
            if (!keys.length) { swEl.innerHTML = '<span class="muted">geen wachtende sweeps</span>'; }
            else {
                swEl.innerHTML = keys.map(k => {
                    const sw = _osirisSweep[k]; const m = neoMultiState.markets[k];
                    const px = m ? m.lastPrice : null; const dp = (px && px < 10) ? 3 : 2;
                    const dist = (px && sw.refPrice) ? Math.abs((px - sw.level) / sw.level * 100).toFixed(2) : '—';
                    const col = sw.side === 'LONG' ? '#14f195' : '#ff8a94';
                    return `<span style="color:${col}">${k} ${sw.side}</span> → wacht op ${sw.level.toFixed(dp)} <span class="muted">(nu ${px != null ? px.toFixed(dp) : '—'}, ${dist}% weg)</span>`;
                }).join('<br>');
            }
        }
        // RL EXIT-AGENT paneel
        if (typeof OsirisRL !== 'undefined') {
            const R = OsirisRL;
            const set = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
            set('rl-episodes', R.episodes.toLocaleString());
            set('rl-states', R.statesLearned);
            set('rl-reward', (R.avgReward != null ? R.avgReward.toFixed(3) : '\u2014'));
            const d = R.lastDecision;
            if (d) {
                set('rl-action', `<span style="color:${R.ACTION_COL[d.action]}">${R.ACTIONS[d.action]}</span>`);
                set('rl-conf', `&middot; zekerheid ${(d.conf * 100 | 0)}%`);
                set('rl-state', `state: ${d.state} <span class="muted">(regime · pnl-zone · momentum · leeftijd)</span>`);
                // begrijpbare uitleg van de huidige toestand + wat het advies betekent
                try {
                    const parts = d.state.split('|');
                    const regN = ['compressie', 'kalm', 'trending', 'volatiel'][parts[0]] || '—';
                    const pnlN = ['fors verlies', 'licht verlies', 'kleine winst', 'winst', 'grote winst'][parts[1]] || '—';
                    const momN = ['tegen', 'neutraal', 'mee'][parts[2]] || '—';
                    const ageN = ['vers', 'halverwege', 'oud'][parts[3]] || '—';
                    const meaning = { 0: 'positie aanhouden', 1: 'nu sluiten/oogsten', 2: 'trailing (winst beschermen)', 3: 'bijladen op de winnaar' }[d.action];
                    const uEl = document.getElementById('rl-explain');
                    if (uEl) uEl.innerHTML = `Situatie: <b style="color:#eafcff">${regN}</b>-markt, <b style="color:#eafcff">${pnlN}</b>, momentum <b style="color:#eafcff">${momN}</b>, positie <b style="color:#eafcff">${ageN}</b>.<br>De agent leerde uit ${R.episodes.toLocaleString()} scenario's dat hier <b style="color:${R.ACTION_COL[d.action]}">${meaning}</b> gemiddeld het beste uitpakt.`;
                } catch (e) {}
                const mx = Math.max(1e-6, Math.max.apply(null, d.q.map(Math.abs)));
                set('rl-qbars', d.q.map((v, i) => {
                    const w = Math.max(2, Math.abs(v) / mx * 100);
                    const on = i === d.action;
                    return `<div style="display:flex; align-items:center; gap:6px; font-family:'JetBrains Mono',monospace; font-size:0.5rem;"><span style="width:42px; color:${R.ACTION_COL[i]}; ${on ? 'font-weight:bold;' : ''}">${R.ACTIONS[i]}</span><span style="flex:1; height:7px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;"><span style="display:block; height:100%; width:${w}%; background:${R.ACTION_COL[i]}; opacity:${on ? 1 : 0.5};"></span></span><span style="width:34px; text-align:right; color:var(--dim);">${v.toFixed(2)}</span></div>`;
                }).join(''));
            } else if (R.episodes === 0) { set('rl-action', 'traint&hellip;'); }
            const at = R.actionDist, tot = at.reduce((a, b) => a + b, 0) || 1;
            set('rl-adist', R.ACTIONS.map((n, i) => `<span style="color:${R.ACTION_COL[i]}">${n} ${(at[i] / tot * 100 | 0)}%</span>`).join(' &middot; '));
        }
    } catch (e) {}
}

// Live wallet-strip: runtime, laatste actie en mini trade-feed. Leest bestaande
// bronnen (botStartTime / botTradeLog), raakt geen trading-logica. ADD-only.
function syncMarginWallet() {
    try {
        const set = (id, v, col) => { const e = document.getElementById(id); if (e) { e.innerHTML = v; if (col) e.style.color = col; } };
        const eq = marginEquity();
        // P/L t.o.v. de juiste baseline: in exchange-modus het echte futures-startsaldo
        // (exchangeStart), anders het lokale startEquity. Voorkomt onzin-P/L wanneer de
        // equity uit een groot testnet-futures-saldo komt.
        const baseline = (marginState.equitySource === 'exchange' && marginState.exchangeStart != null) ? marginState.exchangeStart : marginState.startEquity;
        const pnl = eq - baseline;
        set('m-leverage', marginLeverage + 'x'); set('m-lev2', marginLeverage + 'x');
        set('m-pnl', `\u20ae${pnl.toFixed(2)}`, pnl >= 0 ? '#14f195' : '#ff8a94');
        const totC = marginState.wins + marginState.losses;
        // break-even winrate uit de werkelijke avg win / avg loss van de gesloten trades:
        // BE-WR = avgLoss / (avgWin + avgLoss). Staat de echte winrate erboven, dan is er een edge.
        const _cl = marginState.closed || [];
        const _w = _cl.filter(t => (t.pnl || 0) > 0), _l = _cl.filter(t => (t.pnl || 0) <= 0);
        const _avgW = _w.length ? _w.reduce((a, t) => a + (t.pnl || 0), 0) / _w.length : 0;
        const _avgL = _l.length ? Math.abs(_l.reduce((a, t) => a + (t.pnl || 0), 0) / _l.length) : 0;
        const _beWR = (_avgW + _avgL) > 0 ? _avgL / (_avgW + _avgL) : null;
        const _actWR = totC ? marginState.wins / totC : null;
        set('m-winrate', totC ? `${(_actWR * 100 | 0)}% <span style="font-size:0.62em; color:var(--dim);">(${marginState.wins}W / ${marginState.losses}L \u00b7 ${totC})</span>` : '\u2014');
        if (_beWR != null && _actWR != null) set('m-breakeven', `<span style="color:${_actWR > _beWR ? '#14f195' : '#ff8a94'};">${(_beWR * 100).toFixed(0)}%</span> <span style="font-size:0.62em; color:var(--dim);">nodig \u00b7 nu ${(_actWR * 100 | 0)}%${_actWR > _beWR ? ' \u2713 edge' : ''}</span>`);
        else set('m-breakeven', '\u2014');
        set('m-open', marginState.positions.length);
        set('m-equity', `\u20ae${eq.toFixed(2)}`);
        const _mStart = (typeof _dispMarginStart === 'function') ? _dispMarginStart() : marginState.startTime;
        const rt = Math.max(0, Date.now() - (_mStart || Date.now())); const hh = String(Math.floor(rt / 3600000)).padStart(2, '0'), mm = String(Math.floor(rt / 60000) % 60).padStart(2, '0'), ss = String(Math.floor(rt / 1000) % 60).padStart(2, '0');
        const _viewerM = (typeof window._osirisEngineActive === 'function') && !window._osirisEngineActive();
        const _startTxt = _mStart ? (typeof formatFullDateTime === 'function' ? formatFullDateTime(_mStart) : new Date(_mStart).toLocaleString('nl-NL')) : '\u2014';
        set('m-runtime', `${hh}:${mm}:${ss} <span style="font-size:0.82em; color:var(--dim);">\u00b7 sinds ${_startTxt}${_viewerM ? ' \u00b7 kijk-modus' : ''}</span>`);
        // totale notional-exposure t.o.v. equity (na de alloc-fix)
        const _eqNow = marginEquity() || 1; let _notTot = 0; for (const _p of marginState.positions) _notTot += (_p.notional || 0);
        set('m-exposure', `${(_notTot / _eqNow * 100).toFixed(0)}% <span style="font-size:0.62em; color:var(--dim);">notional / ${(MARGIN_MAX_EXPOSURE * 100 | 0)}% cap</span>`);
        set('m-last-action', marginState.lastAction || '\u2014');
        // WS-verbindingsstatus (futures-testnet) - toont of de echte-fill-verbinding leeft
        const keyedNow = (() => { try { return !!marginKeys().apiKey; } catch (e) { return false; } })();
        const wsSt = marginState.wsState || (keyedNow ? 'disconnected' : 'geen keys');
        const wsCol = wsSt === 'connected' ? '#14f195' : wsSt === 'connecting' ? '#ffb627' : '#ff8a94';
        const wsTxt = !keyedNow ? '<span style="color:#7d99ac;">\u25cc geen futures-keys (sim)</span>'
            : `<span style="color:${wsCol};">${wsSt === 'connected' ? '\u25cf' : wsSt === 'connecting' ? '\u25d0' : '\u25cb'} futures-WS ${wsSt}</span>${marginState.wsReconnects ? ` <span style="color:var(--dim);">\u00b7 ${marginState.wsReconnects} reconnects</span>` : ''}`;
        set('m-ws', wsTxt);
        // badge: echte testnet-fill (groen) vs. simulatie (amber)
        const fillBadge = (real) => real
            ? '<span title="Echte order-fill van het Binance futures-testnet-account" style="color:#14f195; font-size:0.9em;">\u2713 testnet</span>'
            : '<span title="Gesimuleerd op de live prijsfeed - geen echte futures-order" style="color:#ffb627; font-size:0.9em;">~ sim</span>';
        const dp = (v) => (v != null && v < 10) ? v.toFixed(3) : (v != null ? v.toFixed(2) : '\u2014');
        const feed = document.getElementById('m-feed');
        if (feed) {
            if (!marginState.tradeLog.length) feed.innerHTML = marginEngineEnabled ? '<span class="muted">wacht op eerste margin-trade\u2026</span>' : 'Margin-engine staat uit.';
            else feed.innerHTML = marginState.tradeLog.slice(0, 20).map(t => { const tm = new Date(t.ts).toLocaleTimeString(); const col = t.action === 'ENTRY' ? '#7fd8ff' : ((t.pnl || 0) >= 0 ? '#14f195' : '#ff8a94'); const extra = t.action === 'ENTRY' ? `${t.leverage}x` : `${((t.pnl || 0) * 100).toFixed(2)}% ${t.reason || ''}`; return `<div style="color:${col}">${tm} \u00b7 ${t.action} ${t.sym} ${t.side} @ ${dp(t.price)} \u00b7 ${extra} \u00b7 ${fillBadge(t.filled === true)}</div>`; }).join('');
        }
        set('m-reasoning', marginState.reasoning.length ? marginState.reasoning.slice(0, 40).map(r => `<div>${new Date(r.ts).toLocaleTimeString('nl-NL')} \u00b7 ${r.txt}</div>`).join('') : '<span style="color:var(--dim);">Wacht op beredenering\u2026</span>');
        set('m-adaptation', marginState.adaptation.length ? marginState.adaptation.slice(0, 40).map(r => `<div>\u21bb ${new Date(r.ts).toLocaleTimeString('nl-NL')} \u00b7 ${r.txt}</div>`).join('') : '<span style="color:var(--dim);">Nog geen aanpassingen\u2026</span>');
        const orows = document.getElementById('m-open-rows');
        if (orows) {
            if (!marginState.positions.length) orows.innerHTML = '<tr><td colspan="10" style="color:var(--dim); padding:8px;">Geen open margin-posities.</td></tr>';
            else orows.innerHTML = marginState.positions.map((p, i) => {
                const mm = neoMultiState.markets[p.sym]; const price = mm ? mm.lastPrice : p.entryPrice;
                const raw = p.side === 'SHORT' ? (p.entryPrice - price) / p.entryPrice : (price - p.entryPrice) / p.entryPrice;
                const lev = raw * p.leverage; const sc = p.side === 'SHORT' ? '#ff8a94' : '#14f195'; const pc = lev >= 0 ? '#14f195' : '#ff8a94';
                const tijd = new Date(p.openTime).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
                return '<tr style="border-top:1px solid var(--line);">'
                    + '<td style="padding:6px;"><span style="color:#c792ea;">OSIRIS \u00b7 MARGIN</span> <span style="color:#ffb627;">' + p.leverage + 'x</span> ' + fillBadge(p.entryFilled === true) + '</td>'
                    + '<td style="color:#c792ea;">' + p.sym + '</td>'
                    + '<td style="text-align:center; color:' + sc + '; font-weight:bold;">' + p.side + '</td>'
                    + '<td style="text-align:center;">$' + dp(p.entryPrice) + '</td>'
                    + '<td style="text-align:center; color:var(--dim);">' + tijd + '</td>'
                    + '<td style="text-align:center;">\u20ae' + p.notional.toFixed(2) + '</td>'
                    + '<td style="text-align:center;">' + Math.min(100, (p.marginUSD / (marginEquity() || 1)) * 100).toFixed(1) + '% <span style="color:var(--dim);">(' + p.leverage + 'x)</span></td>'
                    + '<td style="text-align:center; color:' + pc + ';">' + (lev * 100).toFixed(2) + '%</td>'
                    + '<td style="text-align:center; color:' + pc + ';">\u20ae' + (p.marginUSD * lev).toFixed(2) + '</td>'
                    + '<td style="text-align:center;"><button type="button" onclick="marginCloseManual(' + i + ')" class="btn btn-ghost btn-mini" style="color:#ff8a94; border-color:rgba(255,138,148,0.4); font-size:0.72em;">SLUIT</button></td>'
                    + '</tr>';
            }).join('');
        }
        const crows = document.getElementById('m-closed-rows');
        if (crows) {
            if (!marginState.closed.length) crows.innerHTML = '<tr><td colspan="6" style="color:var(--dim); padding:8px;">Nog geen gesloten margin-trades.</td></tr>';
            else crows.innerHTML = marginState.closed.slice(0, 30).map(t => { const pc = (t.pnl || 0) >= 0 ? '#14f195' : '#ff8a94'; return `<tr style="border-top:1px solid var(--line);"><td style="padding:6px; white-space:nowrap;">${typeof formatFullDateTime === 'function' ? formatFullDateTime(t.ts) : new Date(t.ts).toLocaleString('nl-NL')}</td><td style="text-align:center; color:#c792ea;">${t.sym}</td><td style="text-align:center;">${t.side}</td><td style="text-align:center;">${t.leverage}x</td><td style="text-align:center; color:var(--dim);">${t.reason} \u00b7 ${fillBadge(t.filled === true)}</td><td style="text-align:center; color:${pc};">${(t.pnl * 100).toFixed(2)}% (\u20ae${(t.pnlUSD || 0).toFixed(2)})</td></tr>`; }).join('');
        }
        const tg = document.getElementById('m-toggle'); if (tg) { tg.textContent = marginEngineEnabled ? 'MARGIN AAN' : 'MARGIN UIT'; tg.style.color = marginEngineEnabled ? '#14f195' : '#7d99ac'; }
        // Exit-bijdrage · margin (verdeling van exit-redenen over gesloten trades)
        const exEl = document.getElementById('m-exit-dist');
        if (exEl) {
            if (!marginState.closed.length) exEl.innerHTML = 'Nog geen gesloten margin-trades.';
            else {
                const agg = {}; for (const t of marginState.closed) { const r = t.reason || '?'; if (!agg[r]) agg[r] = { n: 0, pnl: 0 }; agg[r].n++; agg[r].pnl += (t.pnl || 0) * 100; }
                exEl.innerHTML = Object.keys(agg).sort((a, b) => agg[b].n - agg[a].n).map(r => { const c = agg[r].pnl >= 0 ? '#14f195' : '#ff8a94'; return `<div>${r}: <b>${agg[r].n}\\u00d7</b> \\u00b7 <span style="color:${c}">${agg[r].pnl >= 0 ? '+' : ''}${agg[r].pnl.toFixed(2)}%</span></div>`; }).join('');
            }
        }
        // Equity-verdeling · margin
        const opEl = document.getElementById('m-osiris-panel');
        if (opEl) {
            if (!marginState.positions.length) opEl.innerHTML = '<span style="color:var(--dim); font-size:0.62rem;">Nog geen open margin-posities.</span>';
            else {
                const totEq = marginEquity() || 1;
                opEl.innerHTML = marginState.positions.map(p => {
                    const share = Math.min(100, (p.marginUSD / totEq) * 100);
                    const sc = p.side === 'SHORT' ? '#ff8a94' : '#14f195';
                    return `<div style="margin-bottom:6px;"><div style="display:flex; justify-content:space-between; font-size:0.6rem;"><span style="color:${sc};">${p.sym} ${p.side} <span style="color:var(--dim);">${p.leverage}x</span></span><span style="color:var(--dim);">${share.toFixed(0)}% equity</span></div><div style="height:5px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden; margin-top:2px;"><span style="display:block; height:100%; width:${share}%; background:${sc};"></span></div></div>`;
                }).join('');
            }
        }
    } catch (e) {}
}
window.syncMarginWallet = syncMarginWallet;

// Runtime-starttijd voor de WEERGAVE: op het engine-apparaat de lokale start; op een puur
// kijk-apparaat (mobiel) de authoritatieve start uit de cloud, zodat de runtime niet uit de
// lokale (verouderde) botStartTime wordt afgeleid (dat gaf bv. 400u op mobiel vs 64u op pc).
function _dispSpotStart() {
    try { const eng = (typeof window._osirisEngineActive === 'function') ? window._osirisEngineActive() : true; if (!eng && window._osirisAuthSpotStart) return window._osirisAuthSpotStart; } catch (e) {}
    return botStartTime;
}
function _dispMarginStart() {
    try { const eng = (typeof window._osirisEngineActive === 'function') ? window._osirisEngineActive() : true; if (!eng && window._osirisAuthMarginStart) return window._osirisAuthMarginStart; } catch (e) {}
    return (typeof marginState !== 'undefined') ? marginState.startTime : null;
}
window._dispSpotStart = _dispSpotStart; window._dispMarginStart = _dispMarginStart;

function syncWalletLive() {
    try {
        const rt = document.getElementById('wallet-runtime');
        if (rt) {
            const _bst = _dispSpotStart();
            if (_bst) {
                const d = Math.max(0, Date.now() - _bst);
                const h = Math.floor(d / 3600000).toString().padStart(2, '0');
                const m = Math.floor((d % 3600000) / 60000).toString().padStart(2, '0');
                const s = Math.floor((d % 60000) / 1000).toString().padStart(2, '0');
                const _viewer = (typeof window._osirisEngineActive === 'function') && !window._osirisEngineActive();
                rt.innerHTML = `${h}:${m}:${s} <span style="font-size:0.82em; color:var(--dim);">· sinds ${typeof formatFullDateTime === 'function' ? formatFullDateTime(_bst) : new Date(_bst).toLocaleString('nl-NL')}${_viewer ? ' · kijk-modus' : ''}</span>`;
            } else rt.textContent = 'gestopt';
        }
        const log = (typeof botTradeLog !== 'undefined' && botTradeLog) ? botTradeLog : [];
        const la = document.getElementById('wallet-last-action');
        if (la) {
            if (log.length) {
                const l = log[log.length - 1];
                let mk = l.market;
                if (!mk) { const _pn = (typeof l.price === 'number') ? l.price : parseFloat(l.price); mk = _pn > 10000 ? 'BTC' : (_pn > 200 ? 'ETH' : 'SOL'); }
                const pr = (typeof l.price === 'number') ? (l.price >= 1000 ? l.price.toFixed(0) : l.price.toFixed(2)) : l.price;
                const pnl = (l.action === 'EXIT' && typeof l.pnl === 'number') ? ` \u00b7 ${(l.pnl * 100 >= 0 ? '+' : '')}${(l.pnl * 100).toFixed(2)}%` : '';
                la.textContent = `${l.action} ${mk} ${l.side || ''} @ $${pr}${pnl} \u00b7 ${l.timestamp || ''}`.replace(/\s+/g, ' ').trim();
            } else la.textContent = 'nog geen acties';
        }
        // Wallet-eye: ronddraaiende market-balken + mini-gauges (BTC/ETH/SOL live).
        // Balklengte ~ confidence, kleur = kant (groen long / rood short) als de meta-poort
        // open is, anders gedimd de basiskleur van de markt.
        if (typeof OsirisDeepNet !== 'undefined') {
            const BASECOL = { btc: '#f7931a', eth: '#8aa0ff', sol: '#14f195' };
            for (const key of ['BTC', 'ETH', 'SOL']) {
                const k = key.toLowerCase();
                const pp = OsirisDeepNet.last[key];
                const bar = document.getElementById('we-bar-' + k);
                const ring = document.getElementById('we-ring-' + k);
                const rval = document.getElementById('we-val-' + k);
                if (!pp) {
                    if (bar) { const c = parseFloat(bar.dataset.circ) || 1000; bar.setAttribute('stroke-dasharray', `${(c * 0.05).toFixed(0)} ${(c * 0.95).toFixed(0)}`); bar.setAttribute('opacity', '0.25'); }
                    if (ring) ring.style.setProperty('--cc-pct', '0');
                    if (rval) rval.textContent = '--';
                    continue;
                }
                const col = pp.meta ? (pp.side === 'SHORT' ? '#ff5f7e' : '#14f195') : '#5c7488';
                if (bar) {
                    const circ = parseFloat(bar.dataset.circ) || 1000;
                    const conf = Math.max(0.05, Math.min(1, pp.conf || 0));
                    const barLen = circ * (0.08 + 0.34 * conf);   // langer = meer confidence
                    bar.setAttribute('stroke-dasharray', `${barLen.toFixed(0)} ${(circ - barLen).toFixed(0)}`);
                    bar.setAttribute('stroke', pp.meta ? col : BASECOL[k]);
                    bar.setAttribute('opacity', pp.meta ? '0.95' : '0.4');
                }
                if (ring) { ring.style.setProperty('--cc-pct', String(Math.round((pp.conf || 0) * 100))); ring.style.setProperty('--cc-col', col); }
                if (rval) { rval.textContent = `${(pp.calProb * 100).toFixed(0)}%`; rval.style.color = col; }
            }
        }
        const wf = document.getElementById('wallet-feed');
        if (wf && log.length) {
            wf.innerHTML = log.slice(-8).reverse().map(l => {
                let mk = l.market;
                if (!mk) { const _pn = (typeof l.price === 'number') ? l.price : parseFloat(l.price); mk = _pn > 10000 ? 'BTC' : (_pn > 200 ? 'ETH' : 'SOL'); }
                const side = l.side || '';
                const pr = (typeof l.price === 'number') ? (l.price >= 1000 ? l.price.toFixed(0) : l.price.toFixed(2)) : l.price;
                const isExit = l.action === 'EXIT';
                const col = isExit ? ((l.pnl || 0) >= 0 ? '#14f195' : '#ff5f7e') : '#7fd8ff';
                const pnl = (isExit && typeof l.pnl === 'number') ? ` ${(l.pnl * 100 >= 0 ? '+' : '')}${(l.pnl * 100).toFixed(2)}%` : '';
                const tijd = (l.timestamp || '').slice(-8);
                return `<div style="color:${col};">${tijd} \u00b7 ${l.action} ${mk} ${side} @ $${pr}${pnl}</div>`;
            }).join('');
        }
        // spiegel de reasoning-feed en de autonome-aanpassingen-feed naar de wallet
        const _rs = document.getElementById('bot-reasoning'), _rd = document.getElementById('wallet-reasoning');
        if (_rs && _rd && _rs.innerHTML) _rd.innerHTML = _rs.innerHTML;
        const _as = document.getElementById('bot-adaptation'), _ad = document.getElementById('wallet-adaptation');
        if (_as && _ad && _as.innerHTML) _ad.innerHTML = _as.innerHTML;
        // RL-agent scenario-samenvatting
        const _wrl = document.getElementById('wallet-rl');
        if (_wrl && typeof OsirisRL !== 'undefined') {
            const R = OsirisRL;
            if (R.episodes === 0) { _wrl.innerHTML = '<span style="color:#5c7488;">RL-agent traint op de achtergrond&hellip;</span>'; }
            else {
                const at = R.actionDist, tot = at.reduce((a, b) => a + b, 0) || 1;
                const d = R.lastDecision;
                const adv = d ? `<span style="color:${R.ACTION_COL[d.action]}">${R.ACTIONS[d.action]}</span> (${(d.conf * 100 | 0)}%)` : '\u2014';
                _wrl.innerHTML =
                    `Scenario's doorgespeeld: <b style="color:#eafcff;">${R.episodes.toLocaleString()}</b><br>` +
                    `Geleerde toestanden: <b style="color:#eafcff;">${R.statesLearned}</b> &middot; gem. reward <b style="color:${R.avgReward >= 0 ? '#14f195' : '#ff8a94'};">${R.avgReward.toFixed(3)}</b><br>` +
                    `Huidig advies open positie: <b>${adv}</b><br>` +
                    `<span style="color:#5c7488;">verdeling &mdash; ${R.ACTIONS.map((n, i) => `${n} ${(at[i] / tot * 100 | 0)}%`).join(' · ')}</span>`;
            }
        }
    } catch (e) {}
}

function botHeartbeat() {
    try { syncWalletLive(); } catch (e) {}
    try { syncMarginWallet(); } catch (e) {}
    try { syncNetTab(); } catch (e) {}
    // 1. Runtime UI Update (elke seconde) - via _dispSpotStart zodat een kijk-apparaat de
    // authoritatieve sessie-start toont i.p.v. zijn lokale (verouderde) botStartTime.
    const _rtStart = (typeof _dispSpotStart === 'function') ? _dispSpotStart() : botStartTime;
    if (_rtStart) {
        const diff = Math.max(0, Date.now() - _rtStart);
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');

        const runtimeEl = document.getElementById('bot-runtime');
        if (runtimeEl) runtimeEl.innerText = `Runtime: ${h}:${m}:${s}  (gestart: ${formatFullDateTime(_rtStart)})`;
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
        computeHeadlessIndicators();   // EMA/RSI altijd vers, ook als indicatoren verborgen zijn

        const metrics = calculateVolumeMetrics(liveVol, db, isBullish, 9);
        const decision = getOrisisDecisionData(metrics, livePrice, vfm, er, db, chaos, isBullish);

        lastOsirisDecision = decision;
        lastOsirisMetrics = metrics;

        logSystemState(metrics, decision.targets, livePrice, liveVol, chaos, db, isBullish);

        scanForOpportunities(decision, metrics);
        scanForRangeScalps();
        if (botSettings.ictEnabled) { fetchIctTimeframes().then(() => scanForIctSetup()); }
        renderMovingAverage();
        renderRSI();
        renderPrediction();
        renderPatternMarkers();
        updatePatternStructureCard();
        // OSIRIS DEEPNET (shadow): voorspel per markt, log en visualiseer - raakt niks live
        try { OsirisDeepNet.tick(); } catch (e) {}
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
        const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000`);
        return aggregate15mTo45m(await r.json());
    }
    const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=672`);
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
let _btcVolumeProfile = null; // ALTIJD op BTC-data - de handelslogica gebruikt DEZE, zodat
                              // het bekijken van de ETH/SOL-tab de BTC-trades nooit beinvloedt.
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
        // munt-bewust: gebruik de actieve tab-munt (BTC standaard)
        const sym = (typeof neoMultiState !== 'undefined' && neoMultiState) ? neoMultiState.active : 'BTC';
        const pair = (typeof MULTI_BINANCE !== 'undefined' && MULTI_BINANCE[sym]) ? MULTI_BINANCE[sym] : 'BTCUSDT';
        const r = await bFetch(`https://api.binance.com/api/v3/depth?symbol=${pair}&limit=1000`);
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
    // Handelslogica gebruikt ALTIJD het BTC-profiel (valt terug op _volumeProfile als
    // het BTC-profiel nog niet gezet is, bv. vroeg bij het opstarten).
    const vp = _btcVolumeProfile || _volumeProfile;
    if (!vp || !isFinite(price)) return { bias: 0, note: 'geen profiel' };
    const { poc, vah, val } = vp;
    if (price < val) return { bias: +0.5, note: `onder value area (VAL ${val.toFixed(0)})` };
    if (price > vah) return { bias: -0.5, note: `boven value area (VAH ${vah.toFixed(0)})` };
    const range = vah - val;
    const bias = range > 0 ? (poc - price) / range * 0.3 : 0;
    return { bias, note: `binnen value area, POC ${poc.toFixed(0)}` };
}

// ============================================================
// LEVEL 2 — logistische regressie ("het eerste neuron")
// ============================================================
// Doel: een GEKALIBREERDE winstkans leren uit data, in plaats van de vaste,
// overmoedige confluence-score. Draait volledig client-side, kosteloos.
//
// Twee databronnen:
//   1) echte trades (learningLog) — weinig maar direct relevant
//   2) historische candles — duizenden gratis "labels": van elke candle kunnen
//      we achteraf berekenen of de prijs daarna steeg of daalde. Zo heeft het
//      model genoeg data om stabiele gewichten te leren.
//
// Het model is bewust klein (1 neuron, 6 features + bias). Bij >500 schone
// trades kan hier later een verborgen laag bovenop. Nu eerst stabiel en eerlijk.

let _l2 = {
    weights: null,        // [w_vfm, w_mom, w_er, w_fib, w_pattern, w_svp]
    bias: 0,
    mean: null, std: null, // feature-normalisatie
    trained: false,
    trainedOn: 0,         // aantal samples
    lastTrainMs: 0,
    lastActivation: null  // laatste forward-pass (voor de visualisatie)
};
const L2_FEATURES = ['vfm', 'momentum', 'er', 'fib', 'pattern', 'svp'];

// Config-vingerafdruk: welke instellingen bepalen of trades vergelijkbaar zijn.
function currentConfigVersion() {
    const s = botSettings;
    return `pc${s.probCollapseEnabled ? 1 : 0}_es${Math.round((s.minLossForEarlyExit || 0) * 1000)}_mp${s.minProbabilityPct}`;
}

// --- feature-vector uit een reeks candles op index i (kijkt alleen naar het
// verleden t/m i, nooit vooruit) ---
function l2ExtractFeatures(kl, i) {
    if (i < 20 || i >= kl.length) return null;
    const c = kl.slice(i - 20, i + 1).map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const last = c[c.length - 1], prev = c[c.length - 2];
    const closes = c.map(x => x.c), vols = c.map(x => x.v);
    // vfm: prijsverandering gewogen met volume (genormaliseerd)
    const priceChg = (last.c - c[0].c) / c[0].c;
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    const volRatio = avgVol > 0 ? last.v / avgVol : 1;
    const vfm = Math.tanh(priceChg * 40) * Math.min(2, volRatio);
    // momentum: helling van de laatste 5 closes
    const mom = closes.length >= 6 ? (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
    const momentum = Math.tanh(mom * 60);
    // er (efficiency ratio): netto beweging / totale beweging (0..1)
    let pathLen = 0; for (let j = 1; j < closes.length; j++) pathLen += Math.abs(closes[j] - closes[j - 1]);
    const er = pathLen > 0 ? Math.abs(closes[closes.length - 1] - closes[0]) / pathLen : 0;
    // fib: nabijheid van een 0.5/0.618-retracement in het venster (0..1)
    const hi = Math.max(...c.map(x => x.h)), lo = Math.min(...c.map(x => x.l));
    const rng = hi - lo;
    let fib = 0;
    if (rng > 0) { const pos = (last.c - lo) / rng; fib = 1 - Math.min(Math.abs(pos - 0.5), Math.abs(pos - 0.382), Math.abs(pos - 0.618)) * 2; }
    // pattern: eenvoudige candle-signaalsterkte (bullish/bearish body vs wick)
    const body = last.c - last.o, range = last.h - last.l || 1;
    const pattern = Math.tanh((body / range) * 2);
    // svp: positie t.o.v. value area indien beschikbaar, anders 0
    let svp = 0;
    if (_volumeProfile) { const b = volumeProfileBias(last.c); svp = b.bias * 2; }
    return [vfm, momentum, er, fib, pattern, svp];
}

// --- label: steeg de prijs in de volgende `horizon` candles met > drempel? ---
function l2Label(kl, i, horizon = 5, thr = 0.001) {
    if (i + horizon >= kl.length) return null;
    const entry = +kl[i][4], future = +kl[i + horizon][4];
    return (future - entry) / entry > thr ? 1 : 0;   // 1 = long zou gewonnen hebben
}

function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }

// --- training via gradient descent op genormaliseerde features ---
function l2Train(samples, epochs = 220, lr = 0.12) {
    if (!samples || samples.length < 40) return false;
    const n = L2_FEATURES.length;
    // normalisatie
    const mean = Array(n).fill(0), std = Array(n).fill(0);
    samples.forEach(s => s.x.forEach((v, k) => mean[k] += v));
    mean.forEach((_, k) => mean[k] /= samples.length);
    samples.forEach(s => s.x.forEach((v, k) => std[k] += (v - mean[k]) ** 2));
    std.forEach((_, k) => std[k] = Math.sqrt(std[k] / samples.length) || 1);
    const norm = x => x.map((v, k) => (v - mean[k]) / std[k]);

    let w = Array(n).fill(0), b = 0;
    for (let ep = 0; ep < epochs; ep++) {
        const gw = Array(n).fill(0); let gb = 0;
        for (const s of samples) {
            const xn = norm(s.x);
            const p = sigmoid(xn.reduce((a, v, k) => a + v * w[k], b));
            const err = p - s.y;
            for (let k = 0; k < n; k++) gw[k] += err * xn[k];
            gb += err;
        }
        for (let k = 0; k < n; k++) w[k] -= lr * gw[k] / samples.length;
        b -= lr * gb / samples.length;
    }
    _l2 = { weights: w, bias: b, mean, std, trained: true, trainedOn: samples.length, lastTrainMs: Date.now(), lastActivation: null };
    try { localStorage.setItem('osirisL2', JSON.stringify({ weights: w, bias: b, mean, std, trainedOn: samples.length, lastTrainMs: _l2.lastTrainMs })); } catch (e) {}
    return true;
}

// --- bouw de trainingsset: historische candles (veel) + echte trades (weinig) ---
async function l2BuildAndTrain() {
    const samples = [];
    // 1) historische candles over meerdere timeframes voor variatie
    for (const iv of ['15m', '1h']) {
        try {
            const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=1000`);
            const kl = await r.json();
            for (let i = 20; i < kl.length - 6; i += 1) {
                const x = l2ExtractFeatures(kl, i);
                const y = l2Label(kl, i);
                if (x && y !== null) samples.push({ x, y });
            }
        } catch (e) { console.warn('L2 historische fetch faalde', iv, e); }
    }
    // 2) echte schone trades zwaarder laten meewegen (dupliceren) - dezelfde
    //    config, geen handmatige, met factoren.
    const cfg = currentConfigVersion();
    const schoon = learningLog.filter(l => !l.manual && l.factors && l.outcome);   // alle schone trades (niet alleen huidige config-versie) zodat L2 met de data meebeweegt
    schoon.forEach(l => {
        const f = l.factors;
        const x = [
            Math.tanh((f.confluence || 0) / 5), Math.tanh((f.momentumInfluence || 0)),
            (f.erAtEntry || 0.5), (f.fibConfluenceInfluence || 0), Math.tanh((f.patternInfluence || 0)), 0
        ];
        const y = l.outcome === 'win' ? 1 : 0;
        for (let d = 0; d < 8; d++) samples.push({ x, y });   // echte trades tellen 8x
    });
    const ok = l2Train(samples);
    // Level 3 (getraind net) traint op dezelfde samples, maar heeft meer data nodig.
    // Draait adviserend; faalt stil als er te weinig trades zijn.
    try { l3Train(samples); } catch (e) { console.warn('L3-training overgeslagen:', e.message); }
    if (typeof updateL2UI === 'function') updateL2UI();
    return ok ? { ok: true, samples: samples.length, trades: schoon.length } : { ok: false, samples: samples.length };
}

// --- voorspelling: gekalibreerde winstkans voor de huidige markt ---
function l2Predict(kl, i) {
    if (!_l2.trained || !_l2.weights) return null;
    const x = (Array.isArray(kl) && typeof i === 'number') ? l2ExtractFeatures(kl, i) : kl;
    if (!x) return null;
    const xn = x.map((v, k) => (v - _l2.mean[k]) / _l2.std[k]);
    const contrib = xn.map((v, k) => v * _l2.weights[k]);
    const z = contrib.reduce((a, v) => a + v, _l2.bias);
    const p = sigmoid(z);
    _l2.lastActivation = { features: x, normalized: xn, contrib, z, prob: p };
    return p;
}

// herstel een eerder getraind model bij het laden
try {
    const saved = localStorage.getItem('osirisL2');
    if (saved) { const o = JSON.parse(saved); _l2 = { ..._l2, ...o, trained: true }; }
} catch (e) {}

// ============================================================
// LEVEL 3 — ECHT GETRAIND NEURAAL NETWERK (01-08)
// ============================================================
// Een tweelaags feedforward-net (input -> verborgen laag (tanh) -> sigmoid output) dat
// via BACKPROPAGATION traint op dezelfde features als L2. Anders dan de logistische
// regressie (L2, lineair) kan dit NIET-LINEAIRE combinaties leren - bv. "hoge VFM ALLEEN
// als de chaos laag is". Het draait ADVISEREND naast L2, niet als vervanging.
//
// RISICO (belangrijk): met een verborgen laag en beperkte trades kan dit OVERFITTEN -
// het leert de ruis van je historie i.p.v. echte patronen. Daarom: (1) kleine verborgen
// laag (6 neuronen), (2) L2-regularisatie (weight decay) tegen te grote gewichten,
// (3) een aparte validatie-split die de training stopt als het net begint te overfitten
// (early stopping), (4) het blend-gewicht in de eindkans is bewust klein gehouden.
let _l3 = { W1: null, b1: null, W2: null, b2: null, mean: null, std: null, trained: false, trainedOn: 0, valAcc: null, lastTrainMs: 0, H: 6 };

function _l3Forward(xn, net) {
    // verborgen laag: h = tanh(W1 . x + b1)
    const H = net.b1.length, nIn = xn.length;
    const h = new Array(H);
    for (let j = 0; j < H; j++) {
        let z = net.b1[j];
        for (let k = 0; k < nIn; k++) z += net.W1[j][k] * xn[k];
        h[j] = Math.tanh(z);
    }
    // output: p = sigmoid(W2 . h + b2)
    let zo = net.b2;
    for (let j = 0; j < H; j++) zo += net.W2[j] * h[j];
    const p = sigmoid(zo);
    return { h, p };
}

function l3Train(samples, opts) {
    opts = opts || {};
    const H = opts.H || 6, epochs = opts.epochs || 2000, lr = opts.lr || 0.15, l2reg = opts.l2reg || 0.001;
    if (!samples || samples.length < 60) return false;   // meer data nodig dan L2 (complexer model)
    const nIn = samples[0].x.length;
    // normalisatie
    const mean = Array(nIn).fill(0), std = Array(nIn).fill(0);
    samples.forEach(s => s.x.forEach((v, k) => mean[k] += v));
    mean.forEach((_, k) => mean[k] /= samples.length);
    samples.forEach(s => s.x.forEach((v, k) => std[k] += (v - mean[k]) ** 2));
    std.forEach((_, k) => std[k] = Math.sqrt(std[k] / samples.length) || 1);
    const norm = x => x.map((v, k) => (v - mean[k]) / std[k]);
    const data = samples.map(s => ({ x: norm(s.x), y: s.y }));
    // shuffle + 80/20 train/validatie-split voor early stopping
    for (let i = data.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [data[i], data[j]] = [data[j], data[i]]; }
    const split = Math.floor(data.length * 0.8);
    const train = data.slice(0, split), val = data.slice(split);

    // Xavier-achtige init
    const rnd = () => (Math.random() * 2 - 1);
    let W1 = Array.from({ length: H }, () => Array.from({ length: nIn }, () => rnd() * Math.sqrt(1 / nIn)));
    let b1 = Array(H).fill(0);
    let W2 = Array.from({ length: H }, () => rnd() * Math.sqrt(1 / H));
    let b2 = 0;
    const net = () => ({ W1, b1, W2, b2 });

    const valLoss = () => {
        if (!val.length) return 0;
        let L = 0;
        for (const s of val) { const { p } = _l3Forward(s.x, net()); const q = Math.max(1e-6, Math.min(1 - 1e-6, p)); L += -(s.y * Math.log(q) + (1 - s.y) * Math.log(1 - q)); }
        return L / val.length;
    };
    let bestVal = Infinity, bestSnap = null, patience = 0;

    for (let ep = 0; ep < epochs; ep++) {
        // gradiënten
        const gW1 = Array.from({ length: H }, () => Array(nIn).fill(0));
        const gb1 = Array(H).fill(0);
        const gW2 = Array(H).fill(0); let gb2 = 0;
        for (const s of train) {
            const { h, p } = _l3Forward(s.x, net());
            const dOut = p - s.y;                        // dL/dz_out
            for (let j = 0; j < H; j++) {
                gW2[j] += dOut * h[j];
                const dH = dOut * W2[j] * (1 - h[j] * h[j]);  // door tanh'
                for (let k = 0; k < nIn; k++) gW1[j][k] += dH * s.x[k];
                gb1[j] += dH;
            }
            gb2 += dOut;
        }
        const m = train.length;
        // update met weight decay (L2-regularisatie)
        for (let j = 0; j < H; j++) {
            for (let k = 0; k < nIn; k++) W1[j][k] -= lr * (gW1[j][k] / m + l2reg * W1[j][k]);
            b1[j] -= lr * gb1[j] / m;
            W2[j] -= lr * (gW2[j] / m + l2reg * W2[j]);
        }
        b2 -= lr * gb2 / m;
        // early stopping op validatie-verlies
        if (ep % 20 === 0) {
            const vl = valLoss();
            if (vl < bestVal - 1e-4) { bestVal = vl; bestSnap = JSON.parse(JSON.stringify({ W1, b1, W2, b2 })); patience = 0; }
            else if (++patience >= 12) break;   // 240 epochs geen verbetering -> stop (overfitting-rem)
        }
    }
    if (bestSnap) { W1 = bestSnap.W1; b1 = bestSnap.b1; W2 = bestSnap.W2; b2 = bestSnap.b2; }
    // validatie-accuraatheid rapporteren (eerlijke maat, niet op trainingsdata)
    let correct = 0;
    for (const s of val) { const { p } = _l3Forward(s.x, net()); if ((p >= 0.5 ? 1 : 0) === s.y) correct++; }
    const valAcc = val.length ? correct / val.length : null;
    _l3 = { W1, b1, W2, b2, mean, std, trained: true, trainedOn: samples.length, valAcc, lastTrainMs: Date.now(), H };
    try { localStorage.setItem('osirisL3', JSON.stringify({ W1, b1, W2, b2, mean, std, trainedOn: samples.length, valAcc, lastTrainMs: _l3.lastTrainMs, H })); } catch (e) {}
    return true;
}

function l3Predict(kl, i) {
    if (!_l3.trained || !_l3.W1) return null;
    const x = (Array.isArray(kl) && typeof i === 'number') ? l2ExtractFeatures(kl, i) : kl;
    if (!x) return null;
    const xn = x.map((v, k) => (v - _l3.mean[k]) / _l3.std[k]);
    const { p } = _l3Forward(xn, _l3);
    _l3.lastActivation = { prob: p };
    return p;
}
window.l3Predict = l3Predict;

// herstel een eerder getraind L3-net
try {
    const saved3 = localStorage.getItem('osirisL3');
    if (saved3) { const o = JSON.parse(saved3); _l3 = { ..._l3, ...o, trained: true }; }
} catch (e) {}



// ============================================================
// ICT / SMART-MONEY CASCADE
// ============================================================
// Volledige cascade in vier stappen, elk op zijn eigen timeframe:
//   stap 0  HTF-bias        (4h)   -> welke richting mogen we handelen?
//   stap 1  liquidity sweep (15m)  -> is een swing-high/low geveegd + hersteld?
//   stap 2  market str. shift(1m)  -> draait de structuur na de sweep?
//   stap 3  FVG/orderblock entry(1m) -> instap op de gap, target de nearest swing
// De timeframes komen via REST (fetchIctTimeframes), niet via aparte streams.

// --- REST-fetch van de achtergrond-timeframes (binnen Binance-limieten) ---
async function fetchIctKlines(iv, limit) {
    const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=${limit}`);
    if (!r.ok) throw new Error('klines ' + iv + ' status ' + r.status);
    return r.json();  // [ [openTime,o,h,l,c,v,...], ... ]
}

async function fetchIctTimeframes() {
    if (!botSettings.ictEnabled) return;
    const nu = Date.now();
    try {
        // 4h-bias traag verversen (elke 5 min); 1m-entry snel (elke tick ~10s)
        if (nu - _ictData.lastHtfFetch > 5 * 60 * 1000 || _ictData.htf.length === 0) {
            _ictData.htf = await fetchIctKlines(botSettings.ictHtfInterval, 60);
            _ictData.sweep = await fetchIctKlines(botSettings.ictSweepInterval, 60);
            _ictData.lastHtfFetch = nu;
        }
        if (nu - _ictData.lastEntryFetch > 8 * 1000 || _ictData.entry.length === 0) {
            _ictData.entry = await fetchIctKlines(botSettings.ictEntryInterval, 60);
            _ictData.lastEntryFetch = nu;
        }
    } catch (e) { console.warn('ICT timeframes fetch faalde:', e); }
}

// --- stap 0: HTF directionele bias (4h) ---
// Simpel en robuust: hogere highs + hogere lows = bullish bias; omgekeerd bearish.
// Gebruikt de laatste swingpunten op de 4h; geen bias => geen trade.
function ictHtfBias() {
    const k = _ictData.htf;
    if (!k || k.length < 6) return { dir: null, reason: 'te weinig 4h-data' };
    const closes = k.map(c => +c[4]);
    const n = closes.length;
    // eenvoudige structuur: vergelijk het gemiddelde van de laatste 3 met de 3 ervoor
    const recent = (closes[n - 1] + closes[n - 2] + closes[n - 3]) / 3;
    const older = (closes[n - 4] + closes[n - 5] + closes[n - 6]) / 3;
    const hi = Math.max(...k.slice(-10).map(c => +c[2]));
    const lo = Math.min(...k.slice(-10).map(c => +c[3]));
    if (recent > older) return { dir: 'LONG', reason: `4h bullish (${lo.toFixed(0)}-${hi.toFixed(0)})` };
    if (recent < older) return { dir: 'SHORT', reason: `4h bearish (${lo.toFixed(0)}-${hi.toFixed(0)})` };
    return { dir: null, reason: '4h neutraal' };
}

// --- stap 1: liquidity sweep op 15m ---
// Een sweep = de prijs breekt een recente swing-high (of -low), maar sluit er
// weer terug binnen -> de "liquidity" boven/onder is opgehaald en afgewezen.
// De sweep wordt ONTHOUDEN als toestand. In de praktijk gebeurt een sweep eerst,
// daarna volgt (minuten later) de MSS en pas daarna de retracement in de FVG.
// Eisen dat alle drie op hetzelfde moment waar zijn, laat de cascade vrijwel
// nooit vuren - dat was de fout in de eerste versie.
let _ictSweepState = { active: false, side: null, level: null, atMs: 0, note: '', barTime: 0 };

function ictDetectSweep(bias) {
    const k = _ictData.sweep;
    const lb = botSettings.ictSweepLookback;
    const geldigMs = (botSettings.ictSweepValidMinutes || 45) * 60 * 1000;

    // 1) verlopen sweep opruimen
    if (_ictSweepState.active && Date.now() - _ictSweepState.atMs > geldigMs) {
        _ictSweepState = { active: false, side: null, level: null, atMs: 0, note: '', barTime: 0 };
    }
    if (!k || k.length < lb + 2 || !bias) {
        return _ictSweepState.active ? { swept: true, ..._ictSweepState, vers: false } : { swept: false };
    }

    // 2) nieuwe sweep zoeken op de laatst AFGESLOTEN candle (niet de vormende)
    const closed = k.slice(0, -1);                       // laatste candle is nog in wording
    const last = closed[closed.length - 1];
    const recent = closed.slice(-(lb + 1), -1);
    if (last && recent.length >= 3) {
        const barTime = +last[0];
        const lastHigh = +last[2], lastLow = +last[3], lastClose = +last[4];
        const swingHigh = Math.max(...recent.map(c => +c[2]));
        const swingLow = Math.min(...recent.map(c => +c[3]));
        // alleen registreren als dit een NIEUWE candle is (niet dezelfde al bekende)
        if (barTime !== _ictSweepState.barTime) {
            if (bias === 'SHORT' && lastHigh > swingHigh && lastClose < swingHigh) {
                _ictSweepState = { active: true, side: 'SHORT', level: swingHigh, atMs: Date.now(), barTime,
                                   note: `sweep swing-high ${swingHigh.toFixed(0)}` };
            } else if (bias === 'LONG' && lastLow < swingLow && lastClose > swingLow) {
                _ictSweepState = { active: true, side: 'LONG', level: swingLow, atMs: Date.now(), barTime,
                                   note: `sweep swing-low ${swingLow.toFixed(0)}` };
            }
        }
    }

    // 3) alleen een sweep gebruiken die past bij de huidige HTF-bias
    if (_ictSweepState.active && _ictSweepState.side === bias) {
        const minutenGeleden = Math.round((Date.now() - _ictSweepState.atMs) / 60000);
        return { swept: true, side: _ictSweepState.side, level: _ictSweepState.level,
                 note: `${_ictSweepState.note} (${minutenGeleden}m geleden)` };
    }
    return { swept: false };
}

// --- stap 2: market structure shift op 1m ---
// Na de sweep willen we bevestiging dat de structuur draait: bij een LONG-setup
// moet de prijs een recente 1m-swing-high breken (higher high); bij SHORT een
// recente swing-low (lower low).
// Ook de MSS wordt onthouden: hij bevestigt de draai ná de sweep, waarna we nog
// even de tijd krijgen om de retracement in de FVG af te wachten.
let _ictMssState = { active: false, side: null, atMs: 0, note: '' };

function ictDetectMSS(side, sweepAtMs) {
    const k = _ictData.entry;
    const lb = botSettings.ictSwingLookback;
    const geldigMs = (botSettings.ictSweepValidMinutes || 45) * 60 * 1000;

    // MSS vervalt met de sweep mee, of als de richting omdraait
    if (_ictMssState.active && (Date.now() - _ictMssState.atMs > geldigMs || _ictMssState.side !== side)) {
        _ictMssState = { active: false, side: null, atMs: 0, note: '' };
    }
    if (k && k.length >= lb + 2 && side && !_ictMssState.active) {
        const recent = k.slice(-(lb + 1), -1);
        const last = k[k.length - 1];
        const lastClose = +last[4];
        const swingHigh = Math.max(...recent.map(c => +c[2]));
        const swingLow = Math.min(...recent.map(c => +c[3]));
        // de MSS moet ná de sweep plaatsvinden
        const naSweep = !sweepAtMs || Date.now() >= sweepAtMs;
        if (naSweep && side === 'LONG' && lastClose > swingHigh) {
            _ictMssState = { active: true, side: 'LONG', atMs: Date.now(), note: `MSS: 1m break boven ${swingHigh.toFixed(0)}` };
        } else if (naSweep && side === 'SHORT' && lastClose < swingLow) {
            _ictMssState = { active: true, side: 'SHORT', atMs: Date.now(), note: `MSS: 1m break onder ${swingLow.toFixed(0)}` };
        }
    }
    if (_ictMssState.active && _ictMssState.side === side) {
        return { shifted: true, note: _ictMssState.note };
    }
    return { shifted: false };
}

// --- stap 3a: FVG / orderblock-detectie op 1m ---
// Een (bullish) FVG is een 3-candle-gat waarbij de low van candle 3 boven de high
// van candle 1 ligt: er is een prijszone die niet verhandeld is -> magneet/entry.
// SVP-confluentie (optioneel): een FVG die samenvalt met een volumeknoop of juist
// een volumegat krijgt een hogere kwaliteitsscore.
function ictDetectFVG(side) {
    const k = _ictData.entry;
    if (!k || k.length < 4 || !side) return { found: false };
    const minGap = botSettings.ictFvgMinGapPct / 100;
    // loop van recent naar ouder; pak de dichtstbijzijnde geldige FVG
    for (let i = k.length - 2; i >= 2; i--) {
        const c1 = k[i - 2], c3 = k[i];
        const c1High = +c1[2], c1Low = +c1[3], c3High = +c3[2], c3Low = +c3[3];
        if (side === 'LONG') {
            // bullish FVG: low van c3 boven high van c1
            if (c3Low > c1High) {
                const gap = (c3Low - c1High) / c1High;
                if (gap >= minGap) {
                    const entry = (c3Low + c1High) / 2;   // midden van de gap
                    let quality = Math.min(1, gap / (minGap * 4));
                    if (botSettings.ictUseSvpConfluence && _volumeProfile) {
                        const b = volumeProfileBias(entry).bias;   // onder value area = koopzone
                        quality *= (1 + Math.max(0, b));           // koopzone versterkt bullish FVG
                    }
                    return { found: true, entry, gapLo: c1High, gapHi: c3Low, quality, side, note: `bullish FVG ${entry.toFixed(0)}` };
                }
            }
        } else {
            // bearish FVG: high van c3 onder low van c1
            if (c3High < c1Low) {
                const gap = (c1Low - c3High) / c3High;
                if (gap >= minGap) {
                    const entry = (c3High + c1Low) / 2;
                    let quality = Math.min(1, gap / (minGap * 4));
                    if (botSettings.ictUseSvpConfluence && _volumeProfile) {
                        const b = volumeProfileBias(entry).bias;   // boven value area = verkoopzone
                        quality *= (1 + Math.max(0, -b));
                    }
                    return { found: true, entry, gapLo: c3High, gapHi: c1Low, quality, side, note: `bearish FVG ${entry.toFixed(0)}` };
                }
            }
        }
    }
    return { found: false };
}

// --- stap 3b: target = nearest swing vóór de liquidity grab ---
// We mikken op het dichtstbijzijnde swingpunt in de richting van de trade, maar
// begrenzen door de micro-margin: consistent klein pakken wint van groot mikken.
function ictComputeTarget(side, entry) {
    const k = _ictData.entry;
    const lb = botSettings.ictTargetSwingLookback;
    const micro = botSettings.ictMicroTargetPct / 100;
    let swingTarget;
    if (k && k.length >= lb) {
        const win = k.slice(-lb);
        swingTarget = side === 'LONG' ? Math.max(...win.map(c => +c[2])) : Math.min(...win.map(c => +c[3]));
    }
    const microTarget = side === 'LONG' ? entry * (1 + micro) : entry * (1 - micro);
    // pak de dichtstbijzijnde van de twee -> micro-margin economics
    let target = microTarget;
    if (swingTarget != null) {
        target = side === 'LONG' ? Math.min(swingTarget, microTarget) : Math.max(swingTarget, microTarget);
    }
    const stop = side === 'LONG' ? entry * (1 - botSettings.ictMicroStopPct / 100) : entry * (1 + botSettings.ictMicroStopPct / 100);
    return { target, stop };
}

// --- de volledige cascade -> geeft een kant-en-klaar entry-signaal of null ---
function evaluateIctCascade() {
    if (!botSettings.ictEnabled) return null;
    const bias = ictHtfBias();
    if (!bias.dir) return { stage: 0, ok: false, reason: bias.reason };
    const sweep = ictDetectSweep(bias.dir);
    if (!sweep.swept) return { stage: 1, ok: false, reason: `wacht op sweep (${bias.reason})` };
    const mss = ictDetectMSS(sweep.side, _ictSweepState.atMs);
    if (!mss.shifted) return { stage: 2, ok: false, reason: `${sweep.note} - wacht op MSS` };
    const fvg = ictDetectFVG(sweep.side);
    if (!fvg.found) return { stage: 3, ok: false, reason: `MSS OK, geen geldige FVG` };
    const tgt = ictComputeTarget(sweep.side, fvg.entry);
    return {
        stage: 4, ok: true, side: sweep.side,
        entry: fvg.entry, target: tgt.target, stop: tgt.stop,
        quality: fvg.quality,
        reason: `${bias.reason} -> ${sweep.note} -> ${mss.note} -> ${fvg.note}`,
        chain: { bias: bias.reason, sweep: sweep.note, mss: mss.note, fvg: fvg.note }
    };
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

    // Prijs->Y die de PRIJSSCHAAL VAN DE CHART volgt zodat de niveaus exact
    // gelijklopen met de candles. Valt terug op het eigen profielbereik als de
    // chart (nog) geen coordinaat kan geven (bv. buiten het zichtbare bereik).
    function makePriceToY(loFallback, hiFallback) {
        let chartOK = false;
        if (typeof candlestickSeries !== 'undefined' && candlestickSeries.priceToCoordinate) {
            const a = candlestickSeries.priceToCoordinate(loFallback);
            const b = candlestickSeries.priceToCoordinate(hiFallback);
            chartOK = (a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) > 4);
        }
        if (chartOK) {
            // canvas kan hoger zijn dan de chart; schaal de chart-coordinaat naar canvas-hoogte
            const cRect = chartContainer.getBoundingClientRect();
            return p => {
                const c = candlestickSeries.priceToCoordinate(p);
                if (c == null) { return H - ((p - loFallback) / (hiFallback - loFallback)) * H; }
                return (c / cRect.height) * H;   // chart-pixels -> canvas-pixels
            };
        }
        return p => H - ((p - loFallback) / (hiFallback - loFallback)) * H;
    }

    if (_depthMode === 'svp') {
        const vp = _volumeProfile;
        if (!vp) { if (legend) legend.textContent = 'Wacht op chartdata...'; return; }
        const bins = vp.bins, n = bins.length;
        const priceToY = makePriceToY(bins[0].price, bins[n - 1].price);
        const binPx = Math.max(1, Math.abs(priceToY(bins[0].price) - priceToY(bins[1] ? bins[1].price : bins[0].price + vp.binSize)));
        bins.forEach((b) => {
            const y = priceToY(b.price + vp.binSize / 2);   // bovenrand van de bin
            const buyW = (b.buy / vp.maxTotal) * W;
            const sellW = (b.sell / vp.maxTotal) * W;
            ctx.fillStyle = 'rgba(20,241,149,0.55)'; ctx.fillRect(0, y + 0.5, buyW, binPx - 1);
            ctx.fillStyle = 'rgba(255,95,126,0.55)'; ctx.fillRect(buyW, y + 0.5, sellW, binPx - 1);
        });
        const yVAH = priceToY(vp.vah), yVAL = priceToY(vp.val);
        ctx.fillStyle = 'rgba(0,217,255,0.06)'; ctx.fillRect(0, yVAH, W, yVAL - yVAH);
        ctx.strokeStyle = 'rgba(0,217,255,0.3)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, yVAH); ctx.lineTo(W, yVAH); ctx.moveTo(0, yVAL); ctx.lineTo(W, yVAL); ctx.stroke();
        const yPOC = priceToY(vp.poc);
        ctx.strokeStyle = '#ffb627'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, yPOC); ctx.lineTo(W, yPOC); ctx.stroke();
        if (price) { const yP = priceToY(price); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(0, yP); ctx.lineTo(W, yP); ctx.stroke(); ctx.setLineDash([]); }
        if (legend) {
            const bias = price ? volumeProfileBias(price) : { note: '' };
            legend.innerHTML = `<span style="color:#ffb627;">POC ${vp.poc.toFixed(0)}</span> &middot; VA ${vp.val.toFixed(0)}-${vp.vah.toFixed(0)}<br><span style="color:var(--dimmer);">${bias.note}</span>`;
        }
    } else {
        const ob = _orderBookDepth;
        if (!ob) { if (legend) legend.textContent = 'Order book laden...'; return; }
        const bins = ob.bins, n = bins.length;
        const priceToY = makePriceToY(bins[0].price, bins[n - 1].price);
        const binPx = Math.max(1, Math.abs(priceToY(bins[0].price) - priceToY(bins[1] ? bins[1].price : bins[0].price + ob.binSize)));
        bins.forEach((b) => {
            const y = priceToY(b.price + ob.binSize / 2);
            const bidW = (b.bid / ob.maxSize) * W;
            const askW = (b.ask / ob.maxSize) * W;
            ctx.fillStyle = 'rgba(20,241,149,0.55)'; ctx.fillRect(0, y + 0.5, bidW, binPx - 1);
            ctx.fillStyle = 'rgba(255,95,126,0.55)'; ctx.fillRect(bidW, y + 0.5, askW, binPx - 1);
        });
        if (ob.mid) { const yM = priceToY(ob.mid); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(0, yM); ctx.lineTo(W, yM); ctx.stroke(); ctx.setLineDash([]); }
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
        _btcVolumeProfile = _volumeProfile;   // handelslogica-profiel altijd op BTC
        if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
        updateHistoryList(viewData);
        applyUOTAMGrid(chartData, { updateTrading: false, viewInterval: currentInterval });
        renderMovingAverage();
        renderRSI();
        renderPatternMarkers();
        renderNNMarkers();
        startChartStream(currentInterval);
    } catch (e) {
        console.error('View-wissel mislukt:', e);
    }
}

// ============================================================
// COIN-TABS (01-08) — wissel de chart + system-data tussen BTC/ETH/SOL
// ============================================================
// BTC gedraagt zich exact zoals voorheen (de volledige handelslogica draait erop).
// ETH/SOL tonen de achtergrond-data uit de multi-asset motor als WEERGAVE. De bot
// verhandelt in deze fase alleen BTC; de tabs zijn puur om de markten te bekijken.
async function switchCoin(sym) {
    if (!MULTI_SYMBOLS.includes(sym)) return;
    neoMultiState.active = sym;
    // tab-knoppen bijwerken (actieve duidelijk markeren)
    document.querySelectorAll('.coin-tab').forEach(b => b.classList.toggle('active', b.dataset.coin === sym));
    const statusEl = document.getElementById('coin-tab-status');

    if (sym === 'BTC') {
        // terug naar de volledige BTC-chart (de echte handels-chart)
        if (statusEl) statusEl.textContent = 'BTC · live handels-chart';
        try {
            const btcView = (viewData && viewData.length ? viewData : rawData);
            const chartData = btcView.map(d => ({
                time: Math.floor(d[0] / 1000), open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
            }));
            candlestickSeries.setData(chartData);
            // CRUCIAAL: herstel _volumeProfile op BTC-data zodat de handelslogica (die
            // volumeProfileBias gebruikt) weer op BTC rekent en niet op ETH/SOL blijft hangen.
            try { _volumeProfile = computeVolumeProfile(btcView); } catch (e) {}
            if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
            try { updateHistoryList(btcView); } catch (e) {}
            renderMovingAverage(); renderRSI(); renderPatternMarkers(); renderNNMarkers();
        } catch (e) {}
        renderSystemDataTab('BTC');
        return;
    }

    // ETH/SOL: toon de achtergrond-data (weergave)
    const m = neoMultiState.markets[sym];
    if (statusEl) statusEl.textContent = `${sym} · weergave (achtergrond-scan, niet verhandeld)`;
    if (!m || !m.klines.length) {
        // nog niet geladen -> nu ophalen
        if (statusEl) statusEl.textContent = `${sym} · data laden...`;
        await multiRefreshSymbol(sym);
    }
    try {
        const km = neoMultiState.markets[sym];
        if (km && km.klines.length) {
            const chartData = km.klines.map(d => ({
                time: Math.floor(d[0] / 1000), open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
            }));
            candlestickSeries.setData(chartData);
            // Wis de BTC fib-price-lines + node-markers: die zitten op $62k-$63k en zouden
            // de ETH/SOL-chart ($1878 / $75) volledig uit schaal trekken (afbeelding 2).
            try { activeFibLines.forEach(l => candlestickSeries.removePriceLine(l)); activeFibLines = []; } catch (e) {}
            try { candlestickSeries.setMarkers([]); } catch (e) {}
            try { candlestickSeries.priceScale().applyOptions({ autoScale: true }); } catch (e) {}
            // SVP (volume profile) uit de klines van DEZE munt. We schrijven naar de
            // globale _volumeProfile zodat renderDepthPanel hem tekent - maar de
            // BTC-handelslogica draait op zijn eigen data, dus dit is puur weergave.
            // Bij terugkeer naar BTC wordt _volumeProfile weer op BTC-data herbouwd.
            try { _volumeProfile = computeVolumeProfile(km.klines); } catch (e) {}
            // order book depth van deze munt (fetchOrderBookDepth is nu munt-bewust)
            if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
            // history-lijst van deze munt
            try { updateHistoryList(km.klines); } catch (e) {}
            // NN-markers voor deze weergave-munt (op zijn eigen data)
            renderNNMarkers();
            if (statusEl) statusEl.textContent = `${sym} · weergave (achtergrond-scan, niet verhandeld)`;
        }
    } catch (e) {}
    renderSystemDataTab(sym);
}
window.switchCoin = switchCoin;

// Werk de System Data-sectie bij voor de gekozen munt (headless waarden uit de motor).
// Vult ALLE system-panelen (METERS, fib micro/meso/macro, market status, live
// volume, NN-ritme) met de data van de gekozen munt. Voor BTC doet de live
// BTC-loop dit met de volledige engine; dit is voor ETH/SOL (uit neoMultiState).
function _fillSystemForCoin(m, sym) {
    try {
        const C = m.candles; if (!C || !C.length) return;
        const price = m.lastPrice || parseFloat(C[C.length - 1][4]);
        const set = (id, txt, col) => { const e = document.getElementById(id); if (e) { e.innerText = txt; if (col) e.style.color = col; } };
        const vfm = m.vfm || 0, chaos = m.chaos || 0;
        // ER (efficiency ratio) uit de laatste 15 closes
        const closes = C.slice(-15).map(c => parseFloat(c[4]));
        let er = 0;
        if (closes.length > 2) { const net = Math.abs(closes[closes.length - 1] - closes[0]); let vol = 0; for (let i = 1; i < closes.length; i++) vol += Math.abs(closes[i] - closes[i - 1]); er = vol > 0 ? (net / vol) * 2 : 0; }
        // DB (delta balance): netto (close-open) over laatste 10 candles, in %
        let db = 0; for (const c of C.slice(-10)) db += (parseFloat(c[4]) - parseFloat(c[1])); db = db / (price || 1) * 100;
        const vfmCol = Math.abs(vfm) < 0.1 ? '#808080' : (vfm > 0 ? '#00ffcc' : '#ef5350');
        set('vfm-display', vfm.toFixed(3), vfmCol);
        set('vfm-status', Math.abs(vfm) < 0.1 ? 'NEUTRAAL' : (Math.abs(vfm) > 1.5 ? 'EXTREME' : 'SIGNIFICANT'), vfmCol);
        set('er-display', er.toFixed(2)); set('er-status', er > 1.2 ? 'HIGH ENERGY' : 'LOW ENERGY', er > 1.2 ? '#00ffcc' : '#ef5350');
        set('db-display', db.toFixed(2)); set('db-status', db > 0 ? 'BULLISH' : 'BEARISH', db > 0 ? '#00ffcc' : '#ef5350');
        set('chaos-display', chaos.toFixed(2) + '%'); set('chaos-status', chaos > CONF_CHAOS_TH ? 'VOLATIEL' : 'STABIEL', chaos > CONF_CHAOS_TH ? '#ef5350' : '#00ffcc');
        // FIB micro/meso/macro: hoog/laag over 9/36/144 candles
        const hiLo = (nn) => { const seg = C.slice(-nn); let hi = -Infinity, lo = Infinity; for (const c of seg) { const h = parseFloat(c[2]), l = parseFloat(c[3]); if (h > hi) hi = h; if (l < lo) lo = l; } return { hi, lo }; };
        const fmt = (typeof formatChartPrice === 'function') ? formatChartPrice : (v => '$' + Number(v).toLocaleString());
        const mic = hiLo(9), mes = hiLo(36), mac = hiLo(144);
        set('mic-bull', fmt(mic.hi)); set('mic-bear', fmt(mic.lo));
        set('mes-bull', fmt(mes.hi)); set('mes-bear', fmt(mes.lo));
        set('mac-bull', fmt(mac.hi)); set('mac-bear', fmt(mac.lo));
        // Market status uit sub-brein
        const side = m.bestSide, prob = m.bestProb || 0.5;
        const strong = prob >= 0.6 ? 'zeer hoog' : (prob >= 0.55 ? 'hoog' : 'gemiddeld');
        set('market-status-main', side === 'SHORT' ? 'BEARISH DRUK' : (side === 'LONG' ? 'BULLISH DRUK' : 'NEUTRAAL'), side === 'SHORT' ? '#ef5350' : (side === 'LONG' ? '#00ffcc' : '#aaa'));
        set('probability-score', `Confidence: ${strong} (${(prob * 100).toFixed(0)}%)`, prob >= 0.55 ? '#00ffcc' : '#aaa');
        // Live volume (laatste candle) + score uit vfm
        const lastVol = parseFloat(C[C.length - 1][5]) || 0;
        set('live-volume', lastVol.toFixed(4));
        set('vol-score', Math.round(50 + Math.max(-50, Math.min(50, vfm * 30))) + '/100');
        set('vol-rate', chaos.toFixed(1) + '%');
        // NN-ritme
        const nnState = (typeof _nnState !== 'undefined') ? _nnState[sym] : null;
        if (nnState && nnState.period) set('nn-display', `~${Math.round(nnState.period / 60000)}min ritme \u00b7 ${nnState.caps.length} caps`);
        else if (m.nnRitmeMin) set('nn-display', `~${m.nnRitmeMin}min ritme \u00b7 ${m.nnCaps || 0} caps`);
    } catch (e) {}
}
window._fillSystemForCoin = _fillSystemForCoin;

function renderSystemDataTab(sym) {
    const m = neoMultiState.markets[sym];
    if (sym !== 'BTC') { try { _fillSystemForCoin(m, sym); } catch (e) {} }   // vul alle system-panelen per munt
    const el = document.getElementById('system-data-multi');
    if (!el) return;
    if (!m || m.lastPrice == null) { el.innerHTML = `<span style="color:var(--text-dim);">${sym}: nog geen data</span>`; return; }
    const upd = m.lastUpdate ? Math.round((Date.now() - m.lastUpdate) / 1000) + 's geleden' : '-';
    const nn = _nnState[sym];
    const nnTxt = (nn && nn.period) ? `~${Math.round(nn.period / 60000)}min ritme, ${nn.caps.length} caps` : 'verzamelt...';
    const b = m.brain;
    const probTxt = b ? `${(b.lastProb * 100).toFixed(0)}% ${b.lastSide || ''}` : '-';
    const probColor = b && b.lastProb > 0.6 ? 'var(--teal)' : (b && b.lastProb < 0.45 ? '#ff4f6d' : 'var(--text-primary)');
    el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span style="font-family:'JetBrains Mono',monospace; font-size:0.66rem; color:#c792ea; font-weight:700;">${b ? b.label : 'Neo ' + sym}</span>
            <span style="font-family:'JetBrains Mono',monospace; font-size:0.72rem; font-weight:700; color:${probColor};">kans ${probTxt}</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; font-family:'JetBrains Mono',monospace; font-size:0.62rem;">
            <div><span style="color:var(--text-dim);">Prijs</span><br><b>$${m.lastPrice.toLocaleString()}</b></div>
            <div><span style="color:var(--text-dim);">VFM</span><br><b style="color:${m.vfm > 0 ? 'var(--teal)' : '#ff4f6d'};">${m.vfm.toFixed(2)}</b></div>
            <div><span style="color:var(--text-dim);">Chaos</span><br><b>${m.chaos.toFixed(2)}</b></div>
            <div><span style="color:var(--text-dim);">RSI</span><br><b>${m.rsi != null ? m.rsi.toFixed(0) : '-'}</b></div>
            <div><span style="color:var(--text-dim);">EMA</span><br><b>${m.ema != null ? '$' + m.ema.toFixed(0) : '-'}</b></div>
            <div><span style="color:var(--text-dim);">NN</span><br><b style="color:#c792ea;">${nnTxt}</b></div>
        </div>
        <div style="margin-top:8px; font-size:0.56rem; color:var(--text-dimmer);">${b ? b.preset.note + ' · ' : ''}bijgewerkt: ${upd}${m.error ? ' · fout: ' + m.error : ''}</div>
        ${(() => {
            const f = m.fund;
            if (!f || (f.fundingRate == null && f.openInterest == null)) return '<div style="margin-top:6px; font-size:0.56rem; color:var(--text-dimmer);">fundamentals laden (futures-API, elke 60s)...</div>';
            const fr = f.fundingRate != null ? (f.fundingRate * 100).toFixed(4) + '%' : '-';
            const frColor = f.fundingRate > 0 ? '#ff8fa3' : (f.fundingRate < 0 ? '#8fffb0' : 'var(--text-dim)');
            const ls = f.longShortRatio != null ? f.longShortRatio.toFixed(2) : '-';
            const corr = f.btcCorr != null ? (f.btcCorr * 100).toFixed(0) + '%' : '-';
            const oi = f.openInterest != null ? (f.openInterest >= 1e6 ? (f.openInterest/1e6).toFixed(1)+'M' : (f.openInterest/1e3).toFixed(0)+'K') : '-';
            return `<div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:0.56rem; color:#00d9ff; letter-spacing:1px; margin-bottom:5px;">FUNDAMENTALS &middot; CROSS-MARKT</div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); gap:6px; font-family:'JetBrains Mono',monospace; font-size:0.6rem;">
                    <div><span style="color:var(--text-dim);">Funding</span><br><b style="color:${frColor};" title="mean-reverting: hoog+ = te bullish gepositioneerd">${fr}</b></div>
                    <div><span style="color:var(--text-dim);">L/S ratio</span><br><b>${ls}</b></div>
                    <div><span style="color:var(--text-dim);">Open Int.</span><br><b>${oi}</b></div>
                    ${sym !== 'BTC' ? `<div><span style="color:var(--text-dim);">BTC-corr</span><br><b style="color:#f7931a;">${corr}</b></div>` : ''}
                </div>
            </div>`;
        })()}`;

    // De VFM/ER/DB/Chaos meter-cards munt-bewust maken: voor ETH/SOL vullen we ze uit de
    // multi-asset motor; voor BTC laat de live-loop ze met de volledige berekening staan.
    if (sym !== 'BTC') {
        const setCard = (id, val, statusEl, statusTxt, color) => {
            const p = document.getElementById(id + '-display'); const s = document.getElementById(id + '-status');
            if (p) { p.innerText = val; p.style.color = color; }
            if (s) { s.innerText = statusTxt; s.style.color = color; }
        };
        const vfmColor = Math.abs(m.vfm) < 0.1 ? '#808080' : (m.vfm > 0 ? '#00ffcc' : '#ef5350');
        setCard('vfm', m.vfm.toFixed(3), true, `${sym} · ${Math.abs(m.vfm) < 0.1 ? 'NEUTRAAL' : (Math.abs(m.vfm) > 1.5 ? 'EXTREME' : 'SIGNIFICANT')}`, vfmColor);
        // ER/DB worden voor sub-breinen niet los berekend; toon ze als afgeleid/neutraal met munt-tag
        setCard('er', '—', true, `${sym} · niet los berekend`, '#5c7488');
        setCard('db', '—', true, `${sym} · niet los berekend`, '#5c7488');
        setCard('chaos', m.chaos.toFixed(2) + '%', true, `${sym} · ${m.chaos < 8 ? 'STABIEL' : 'HOOG'}`, m.chaos < 8 ? '#00ffcc' : '#ffb627');
    }
}
window.renderSystemDataTab = renderSystemDataTab;

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        setChartMarkers([]);

        // 1. BOT-DATA: altijd 672 x 15m spot-candles (7 dagen) - de vaste basis
        // voor alle handelslogica (structuur, meters, nodes, fib), ongeacht
        // welke view de chart toont.
        const response = await bFetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${BOT_INTERVAL}&limit=672`);
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
        _btcVolumeProfile = _volumeProfile;   // handelslogica-profiel altijd op BTC
        if (typeof renderDepthPanel === 'function') { if (_depthMode === 'cob') fetchOrderBookDepth().then(renderDepthPanel); else renderDepthPanel(); }
        updateHistoryList(viewData);
        if (currentInterval !== BOT_INTERVAL) {
            applyUOTAMGrid(chartData, { updateTrading: false, viewInterval: currentInterval });
        }
        renderMovingAverage();
        renderRSI();
        renderPatternMarkers();
        renderNNMarkers();
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

    // Neo's Node (NN) live-info: countdown tot de volgende NN-node + trefzekerheid.
    // Passief meet-instrument; toont alleen wat NN uit de data heeft afgeleid.
    const nnEl = document.getElementById('nn-display');
    if (nnEl) {
        try {
            const ctx = nnContext('BTC', now);
            if (!ctx) {
                nnEl.innerText = showNNMarkers ? 'NN verzamelt capitulaties...' : 'Zet NN zichtbaar op de chart om te meten...';
            } else {
                const acc = ctx.accuracy;
                const accTxt = acc ? ` | trefzekerheid: \u00b1${acc.avgErrorMin}min over ${acc.samples} reset(s)` : ' | nog geen reset gemeten';
                const anchorTxt = ctx.anchorDir === 'low' ? 'bodem' : 'top';
                nnEl.innerText = `volgende NN over ${formatCountdown(ctx.nextNode)} | ritme ~${Math.round(ctx.periodMin)}min | anker: ${anchorTxt} (${ctx.capsFound} caps)${accTxt}`;
            }
        } catch (e) { nnEl.innerText = 'NN: wachten op data'; }
    }

    // Node-confluentie: countdown tot het volgende moment waarop standaard-node en NN
    // samenvallen (dynamisch - verschuift wanneer NN herankert).
    const confEl = document.getElementById('nodeconf-display');
    if (confEl) {
        try {
            const c = computeNodeConfluence(now);
            if (!c || c.minsTo == null || c.score < 0.05) {
                confEl.innerText = 'geen nabije samenval standaard-node \u00d7 NN';
            } else {
                const when = now + c.minsTo * 60000;
                const sterk = c.score > 0.6 ? 'STERK' : c.score > 0.3 ? 'matig' : 'zwak';
                confEl.innerText = `samenval over ${formatCountdown(when)} | overlap ${sterk} (${(c.score*100|0)}%, gap ${c.gapMin}min)`;
            }
        } catch (e) { confEl.innerText = 'confluentie: wachten op data'; }
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
const OSIRIS_VERSION = 'jarvis7-2026-08';
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
    let _nc = null, _ma = { fast: null, slow: null }, _rsi = null, _vs = null, _ni = null, _prob = null;
    try { _nc = getNodeContext(); } catch (e) {}
    try { _ma = getCurrentMAValues() || _ma; } catch (e) {}
    try { _rsi = getCurrentRSIValue(); } catch (e) {}
    try { _vs = +calculateVolumeShift(6).toFixed(2); } catch (e) {}
    try { if (_nc) _ni = +calculateNodeInfluence(_nc).toFixed(2); } catch (e) {}
    try { const pl = readSmoothedProb('LONG'), ps = readSmoothedProb('SHORT'); const bb = (pl == null && ps == null) ? null : Math.max(pl == null ? 0 : pl, ps == null ? 0 : ps); _prob = bb; } catch (e) {}
    metricsHistory.push({
        timestamp: Date.now(), symbol: 'BTC', botVersion: OSIRIS_VERSION,
        executionSource: (typeof botSettings !== 'undefined' && botSettings.executionMode) ? botSettings.executionMode : 'TESTNET',
        price: livePrice, vfm, er, db, chaos, liveVol, volRate,
        rsi: _rsi, emaFast: _ma.fast, emaSlow: _ma.slow, volumeShiftPct: _vs, nodeInfluence: _ni,
        lastNodeType: (_nc && _nc.lastNode) ? _nc.lastNode.type : null,
        nextNodeType: (_nc && _nc.nextNode) ? _nc.nextNode.type : null,
        minutesSinceLastNode: (_nc && _nc.lastNode && _nc.lastNode.minutesAgo != null) ? +(_nc.lastNode.minutesAgo).toFixed(1) : null,
        minutesUntilNextNode: (_nc && _nc.nextNode && _nc.nextNode.minutesUntil != null) ? +(_nc.nextNode.minutesUntil).toFixed(1) : null,
        probabilityPct: _prob, isBullish
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

// ============================================================
// NEO'S NODE (NN) — passieve, zelf-herankererende node-detector (31-07)
// ============================================================
// EXPERIMENTEEL MEET-INSTRUMENT. NN raakt de handelsbeslissing NIET aan. Het detecteert
// de ECHTE energie-ontladingen (capitulaties) in de data van een munt, ankert op de
// meest recente, meet uit de afstanden tussen recente ontladingen het EMPIRISCHE ritme
// van díe munt, en projecteert de volgende verwachte node. Anders dan de standaard
// UOTAM-node (vaste klok, vast T_pi) is NN een BEWEGENDE klok: bij elke nieuwe echte
// capitulatie herankert hij en kan het ritme verschuiven - dus geen vaste countdown,
// maar een reeks opnieuw-geankerde segmenten (parallelle tijdslijnen, zoals besproken).
//
// NN houdt zijn eigen TREFZEKERHEID bij: bij elke reset logt hij hoe ver zijn vorige
// voorspelde node afweek van de werkelijke capitulatie. Zo bouwt zich een trackrecord
// op waarmee je kunt TOETSEN of NN waarde toevoegt - vóórdat hij ooit meebeslist.

let _nnState = {
    BTC: null, ETH: null, SOL: null   // per munt een eigen NN-staat
};
function _emptyNN() {
    return { caps: [], anchor: null, period: null, nextNode: null, log: [], lastComputedAt: 0 };
}

// ============================================================
// MULTI-ASSET DATAMOTOR (01-08) — Fase 2
// ============================================================
// Houdt de drie markten (BTC/ETH/SOL) in het GEHEUGEN bij: per munt een kline-buffer,
// headless EMA/RSI, laatste VFM/chaos en NN-staat. Draait op de ACHTERGROND naast de
// bestaande BTC-engine - die blijft onaangeroerd de "actieve" munt aansturen. ETH/SOL
// worden (nog) niet verhandeld; deze fase verzamelt alleen data en maakt ze zichtbaar
// via de tabs. Round-robin verversing houdt elke tick licht en blijft ver onder de
// Binance rate limit (3 munten x 2 intervallen x gewicht 2 = 12/cyclus, ~1% van 6000/min).
const MULTI_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const MULTI_BINANCE = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
let neoMultiState = {
    active: 'BTC',                 // welke munt de UI toont (chart/system tabs)
    rrIndex: 0,                    // round-robin teller voor achtergrond-verversing
    markets: {
        BTC: _emptyMarket(), ETH: _emptyMarket(), SOL: _emptyMarket()
    }
};
function _emptyMarket() {
    return {
        klines: [], lastPrice: null, lastVol: null,
        ema: null, emaSlow: null, rsi: null, vfm: 0, chaos: 0,
        bestProb: 0.5, bestSide: null, lastUpdate: 0, loading: false, error: null,
        brain: null   // sub-brein (fase 3) - eigen gewichten/learning per munt
    };
}

// ============================================================
// SUB-BREINEN (01-08) — Fase 3
// ============================================================
// Elk sub-brein draait het volledige Neo-arsenaal maar kalibreert op ZIJN EIGEN munt.
// Preset-profielen geven elke munt een startkarakter dat past bij zijn volatiliteit
// (SOL beweegt heftiger dan BTC, ETH zit ertussenin). Vanaf daar leert elk sub-brein
// zelfstandig - eigen adaptieve gewichten, eigen learningLog. BTC blijft de bestaande
// hoofd-engine gebruiken (die is al bewezen); ETH/SOL krijgen hun eigen sub-brein.
const SUBBRAIN_PRESETS = {
    BTC: { label: 'Neo BTC', minProbabilityPct: 65, microMinProbPct: 72, stopLossPct: 2.0, rangeScalpProfitTargetPct: 0.7, minProjectedProfitPct: 0.3, trailBufferPct: 0.01, maxPositionAgeMinutes: 90, profitProtectActivationPct: 0.005, note: 'basis-profiel (bewezen)' },
    ETH: { label: 'Neo ETH', minProbabilityPct: 67, microMinProbPct: 73, stopLossPct: 2.4, rangeScalpProfitTargetPct: 0.85, minProjectedProfitPct: 0.35, trailBufferPct: 0.012, maxPositionAgeMinutes: 80, profitProtectActivationPct: 0.006, note: 'iets ruimer - ETH volatieler dan BTC' },
    SOL: { label: 'Neo SOL', minProbabilityPct: 70, microMinProbPct: 75, stopLossPct: 3.0, rangeScalpProfitTargetPct: 1.1, minProjectedProfitPct: 0.45, trailBufferPct: 0.015, maxPositionAgeMinutes: 70, profitProtectActivationPct: 0.008, note: 'ruimste stops - SOL sterk volatiel' }
};
function _emptySubBrain(sym) {
    const preset = SUBBRAIN_PRESETS[sym] || SUBBRAIN_PRESETS.BTC;
    return {
        label: preset.label,
        preset: Object.assign({}, preset),
        // eigen adaptieve gewichten (start als kopie van de globale defaults)
        weights: { confluence: 1.0, nodeInfluence: 1.0, momentumInfluence: 1.0, fibConfluence: 1.0, pattern: 1.0, rsi: 1.0, ema: 1.0, cnn: 1.0, nn: 2.0, nodeconf: 2.0, fundamentals: 1.0 },
        learningLog: [],           // eigen trade-historie voor kalibratie
        lastProb: 0.5, lastSide: null,
        wins: 0, losses: 0, calibratedAt: 0
    };
}
function _saveSubBrainWeights() {
    try {
        const out = {};
        for (const s of ['ETH', 'SOL']) { const b = neoMultiState.markets[s] && neoMultiState.markets[s].brain; if (b && b.weights) out[s] = b.weights; }
        localStorage.setItem('osirisSubBrainWeights', JSON.stringify(out));
    } catch (e) {}
}
function ensureSubBrain(sym) {
    const m = neoMultiState.markets[sym];
    if (!m) return null;
    if (!m.brain) {
        m.brain = _emptySubBrain(sym);
        try {   // herstel eerder geleerde factor-gewichten zodat ze een reload overleven
            const saved = JSON.parse(localStorage.getItem('osirisSubBrainWeights') || '{}');
            if (saved[sym] && m.brain.weights) Object.assign(m.brain.weights, saved[sym]);
        } catch (e) {}
    }
    return m.brain;
}

// Geeft de EFFECTIEVE engine-config voor een positie. BTC-posities (en alles wat niet
// van Osiris komt) gebruiken de globale botSettings. Osiris ETH/SOL-posities gebruiken
// het volledige preset van hun sub-brein, met terugval op de globale waarde als een
// veld ontbreekt. Zo loopt elke munt volledig volgens ZIJN EIGEN regels.
function effectiveConfig(pos) {
    if (!pos || !pos.isOsiris || !pos.symbol) return botSettings;
    const symKey = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol);
    const m = symKey ? neoMultiState.markets[symKey] : null;
    const preset = (m && m.brain && m.brain.preset) ? m.brain.preset : null;
    if (!preset) return botSettings;
    // preset-velden overschrijven de globale; ontbrekende velden vallen terug op globaal
    return Object.assign({}, botSettings, preset);
}
window.effectiveConfig = effectiveConfig;

// Bereken de beste kans/kant voor een sub-brein uit zijn markt-data. Dit is een
// LICHTE variant van de hoofd-kansberekening: hij gebruikt de kern-signalen (VFM,
// momentum via EMA, RSI, NN-nabijheid) gewogen met de eigen sub-brein-gewichten.
// De zware, bewezen hoofd-engine blijft exclusief voor BTC; dit geeft ETH/SOL een
// eigen, zelfstandig kansoordeel zonder de BTC-logica te raken.
// PER-MARKT ZELF-KALIBRATIE: stelt de factor-gewichten van een sub-brein bij op basis
// van gewonnen/verloren trades IN DIE MARKT. Een factor die vaker aanwezig was bij winst
// dan bij verlies krijgt iets meer gewicht; andersom minder. Klein en begrensd (0.3-2.5),
// gated via SUBBRAIN_LEARN. Zo corrigeert elk brein zich op zijn eigen marktgedrag.
let SUBBRAIN_LEARN = (function(){ try { const v = localStorage.getItem('osirisSubbrainLearn'); return v == null ? true : v === 'true'; } catch (e) { return true; } })();
function recalibrateSubBrain(sym) {
    if (!SUBBRAIN_LEARN || sym === 'BTC') return;
    const b = neoMultiState.markets[sym] && neoMultiState.markets[sym].brain;
    if (!b || !b.weights) return;
    const trades = (typeof learningLog !== 'undefined' ? learningLog : []).filter(l => l.market === sym && l.factors && l.outcome);
    if (trades.length < 15) return;                 // pas leren met genoeg data
    const recent = trades.slice(-40);
    const map = { vfm: 'momentumInfluence', rsi: 'rsi', ema: 'ema', nn: 'nn', fundamentals: 'fundamentals' };
    const changes = [];
    for (const fk in map) {
        const wk = map[fk];
        const absVals = recent.map(t => Math.abs((t.factors && t.factors[fk]) || 0));
        const thr = absVals.slice().sort((a, c) => a - c)[Math.floor(absVals.length / 2)] || 0;
        if (thr <= 0) continue;
        const present = recent.filter(t => Math.abs((t.factors && t.factors[fk]) || 0) > thr);
        const absent = recent.filter(t => Math.abs((t.factors && t.factors[fk]) || 0) <= thr);
        if (present.length < 5 || absent.length < 5) continue;
        const wrP = present.filter(t => t.outcome === 'win').length / present.length;
        const wrA = absent.filter(t => t.outcome === 'win').length / absent.length;
        const edge = wrP - wrA;                     // >0 = factor helpt in deze markt
        const cur = b.weights[wk] != null ? b.weights[wk] : 1;
        let next = Math.max(0.3, Math.min(2.5, cur + edge * 0.15));   // kleine, begrensde stap
        if (Math.abs(next - cur) >= 0.03) { b.weights[wk] = next; changes.push(`${wk} ${cur.toFixed(2)}\u2192${next.toFixed(2)}`); }
    }
    if (changes.length) {
        _saveSubBrainWeights();   // persistent maken (overleeft reload)
        try { logAdaptation(`Neo ${sym}: factor-gewichten bijgesteld`, `zelf-kalibratie op ${recent.length} ${sym}-trades: ${changes.join(', ')}`); } catch (e) {}
        try { renderLearningPanel(); } catch (e) {}
    }
}
window.recalibrateSubBrain = recalibrateSubBrain;
window.subbrainLearnToggle = (on) => { SUBBRAIN_LEARN = !!on; try { localStorage.setItem('osirisSubbrainLearn', on ? 'true' : 'false'); } catch (e) {} };

function subBrainEvaluate(sym) {
    const m = neoMultiState.markets[sym];
    const b = ensureSubBrain(sym);
    if (!m || !b || !m.klines || m.klines.length < 40) return { prob: 0.5, side: null };
    try {
        const w = b.weights;
        const closes = m.klines.map(d => parseFloat(d[4]));
        // richting-bepaling: EMA-helling + laatste momentum
        const emaUp = (m.ema != null && m.emaSlow != null) ? (m.ema > m.emaSlow) : (closes[closes.length-1] > closes[closes.length-10]);
        const side = emaUp ? 'LONG' : 'SHORT';
        // score-opbouw (0..100), elk signaal met eigen gewicht
        let score = 50;
        const factors = {};   // per-factor bijdrage (voor per-markt zelf-kalibratie)
        // VFM (richting-bewust)
        const vfmDir = (side === 'LONG' ? 1 : -1) * m.vfm;
        factors.vfm = vfmDir * 8 * (w.momentumInfluence || 1); score += factors.vfm;
        // RSI mean-reversion aan de randen
        factors.rsi = 0;
        if (m.rsi != null) {
            if (side === 'LONG' && m.rsi < 40) factors.rsi = (40 - m.rsi) * 0.4 * (w.rsi || 1);
            if (side === 'SHORT' && m.rsi > 60) factors.rsi = (m.rsi - 60) * 0.4 * (w.rsi || 1);
        }
        score += factors.rsi;
        // EMA-afstand (trend-sterkte)
        factors.ema = 0;
        if (m.ema != null && m.lastPrice) {
            const emaDist = (m.lastPrice - m.ema) / m.ema * 100;
            factors.ema = (side === 'LONG' ? emaDist : -emaDist) * 3 * (w.ema || 1);
        }
        score += factors.ema;
        // NN-nabijheid (eigen munt)
        factors.nn = 0;
        try { const pr = nnProximity(sym); if (pr && pr.prox > 0.15) factors.nn = pr.prox * (pr.strength||0.5) * 6 * (w.nn || 2); } catch (e) {}
        score += factors.nn;
        // FUNDAMENTALS + CROSS-MARKET: funding, OI, long/short, BTC-correlatie (richting-bewust)
        factors.fundamentals = 0;
        try {
            const fb = fundamentalsBias(sym);
            if (fb && fb.bias) { factors.fundamentals = (side === 'LONG' ? 1 : -1) * fb.bias * 10 * (w.fundamentals || 1); b.lastFundBias = fb; }
        } catch (e) {}
        score += factors.fundamentals;
        // chaos-rem: te veel chaos -> lagere zekerheid
        factors.chaos = -Math.min(15, m.chaos * 2);
        score += factors.chaos;
        const prob = Math.max(0, Math.min(100, score)) / 100;
        b.lastProb = prob; b.lastSide = side; b.lastFactors = factors;
        m.bestProb = prob; m.bestSide = side; m.bestFactors = factors;
        return { prob, side };
    } catch (e) { return { prob: 0.5, side: null }; }
}
window.subBrainEvaluate = subBrainEvaluate;

// ============================================================
// OSIRIS MAINBRAIN (01-08) — Fase 4
// ============================================================
// Osiris is het centrale brein ("the mother/father of all"). Het vergelijkt de drie
// sub-breinen (Neo BTC/ETH/SOL), kiest welke munt(en) de beste trade-kans hebben, en
// verdeelt de equity KANS-GEWOGEN over de markten die tegelijk een positie willen:
// de munt met de hoogste kans krijgt de meeste equity, de laagste het minst; bij
// gelijke kansen elk een gelijk deel. Osiris leert van alle drie de sub-breinen.
// In deze fase BEREKENT Osiris de allocatie en toont die (transparantie); het
// autonoom uitvoeren van ETH/SOL-trades komt in een latere stap - BTC blijft leidend.
let osirisState = {
    lastReview: 0,
    allocations: {},      // { BTC: 0.5, ETH: 0.3, SOL: 0.2 }
    picks: [],            // gesorteerde munten op kans
    note: ''
};

// ============================================================
// ============================================================
// OSIRIS · INTERACTIEVE BRAIN (16-08) - Overzicht-tab
// Cirkelvormig hersen-design met twee helften en vertakkende "zenuwbanen" per
// subsysteem. Hover over een gebied -> dat gebied + zijn banen lichten op en een
// paneel toont de data/tools die de bot daar gebruikt. Volledig SVG, client-side.
// ============================================================
const BRAIN_REGIONS = [
    { id: 'perceptie', name: 'PERCEPTIE', cx: 175, cy: 150, col: '#00d9ff', tools: ['Candles · bFetch (mirror-fallback)', 'VFM · ER · DB · Chaos-meters', 'RSI · EMA · volume-shift', 'UOTAM-nodes · fib micro/meso/macro'] },
    { id: 'regime', name: 'REGIME · HMM', cx: 255, cy: 128, col: '#7fd8ff', tools: ['Gaussian HMM (Baum-Welch + Viterbi)', 'TRENDING / VOLATIEL / COMPRESSIE / KALM', 'per-regime parameter-nudge'] },
    { id: 'cores', name: 'SUB-BREINEN', cx: 225, cy: 235, col: '#c792ea', tools: ['Neo BTC (hoofd-engine)', 'Neo ETH · Neo SOL (cores)', 'bestProb / bestSide per markt'] },
    { id: 'geheugen', name: 'GEHEUGEN · L1/L2', cx: 150, cy: 250, col: '#8aa0ff', tools: ['L1 adaptieve factor-gewichten', 'L2 logistische regressie (Platt)', 'learningLog · kalibratie-curve'] },
    { id: 'deepnet', name: 'DEEPNET · L3', cx: 465, cy: 150, col: '#14f195', tools: ['Feedforward net 15-14-8-1 per markt', 'ECE + monotonie-kalibratie', 'meta-poort (confidence + wf-precisie)'] },
    { id: 'tuning', name: 'TUNING', cx: 385, cy: 128, col: '#ffb627', tools: ['Auto-tuner: kans-drempels + exit-timing', 'Shadow-backtest: target/stop op Sharpe', 'osirisTune · elke 5 min'] },
    { id: 'executie', name: 'EXECUTIE', cx: 415, cy: 235, col: '#2bd47f', tools: ['osirisReview: equity-verdeling', 'osirisShadowTick: ETH/SOL', 'Sweep-entry op stop-/liquidatie-niveau'] },
    { id: 'risico', name: 'RISICO', cx: 490, cy: 250, col: '#ff5f7e', tools: ['OsirisGuard circuit breaker', 'Hedge-reserve · BTC-reserve 15%', 'Regime-gate (dode markt)'] },
];

function buildOsirisBrain() {
    const svg = document.getElementById('osiris-brain');
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';
    const stemX = 320, stemY = 372;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const mk = (t, at) => { const e = document.createElementNS(NS, t); for (const k in at) e.setAttribute(k, at[k]); return e; };

    // defs: zachte gloed
    const defs = mk('defs', {});
    defs.innerHTML = '<radialGradient id="brainGlow" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color="#0f2740" stop-opacity="0.9"/><stop offset="100%" stop-color="#060a12" stop-opacity="0"/></radialGradient><filter id="brainBlur"><feGaussianBlur stdDeviation="2.2"/></filter>';
    svg.appendChild(defs);
    svg.appendChild(mk('ellipse', { cx: 320, cy: 200, rx: 250, ry: 150, fill: 'url(#brainGlow)' }));

    // hersen-omtrek: twee helften (organische bezier-blobs)
    const outlineL = 'M320,70 C250,58 190,70 150,110 C110,150 108,210 140,255 C168,295 235,320 300,300 C314,296 320,285 320,270 Z';
    const outlineR = 'M320,70 C390,58 450,70 490,110 C530,150 532,210 500,255 C472,295 405,320 340,300 C326,296 320,285 320,270 Z';
    for (const d of [outlineL, outlineR]) {
        svg.appendChild(mk('path', { d, fill: 'rgba(10,20,32,0.55)', stroke: 'rgba(0,217,255,0.18)', 'stroke-width': '1' }));
    }
    // middenscheiding + brainstem
    svg.appendChild(mk('line', { x1: 320, y1: 74, x2: 320, y2: 300, stroke: 'rgba(0,217,255,0.14)', 'stroke-width': '1' }));
    svg.appendChild(mk('path', { d: `M312,296 C312,330 308,352 ${stemX - 6},${stemY} M328,296 C328,330 332,352 ${stemX + 6},${stemY}`, fill: 'none', stroke: 'rgba(120,216,255,0.4)', 'stroke-width': '3', 'stroke-linecap': 'round' }));

    // ambient achtergrond-vezels (dim)
    const amb = mk('g', { opacity: '0.28' });
    for (let i = 0; i < 46; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const ex = 320 + side * rnd(30, 195), ey = rnd(95, 285);
        const mx = (stemX + ex) / 2 + rnd(-40, 40), my = (stemY + ey) / 2 - rnd(20, 90);
        amb.appendChild(mk('path', { d: `M${stemX},${stemY} Q${mx},${my} ${ex},${ey}`, fill: 'none', stroke: 'rgba(120,150,180,0.5)', 'stroke-width': (Math.random() * 0.6 + 0.3).toFixed(2) }));
        amb.appendChild(mk('circle', { cx: ex, cy: ey, r: (Math.random() * 1.2 + 0.6).toFixed(1), fill: 'rgba(160,190,215,0.6)' }));
    }
    svg.appendChild(amb);

    // per subsysteem: een groep met oplichtende banen + node + label
    for (const r of BRAIN_REGIONS) {
        const g = mk('g', { class: 'brain-region', 'data-id': r.id, style: 'cursor:pointer;' });
        const branches = mk('g', { class: 'br-branches', opacity: '0.5' });
        const N = 9;
        for (let i = 0; i < N; i++) {
            const ang = (i / N) * Math.PI * 2, rad = rnd(14, 40);
            const ex = r.cx + Math.cos(ang) * rad, ey = r.cy + Math.sin(ang) * rad * 0.8;
            const mx = (stemX + ex) / 2 + rnd(-30, 30), my = (stemY + ey) / 2 - rnd(30, 80);
            branches.appendChild(mk('path', { d: `M${stemX},${stemY} Q${mx},${my} ${ex.toFixed(1)},${ey.toFixed(1)}`, fill: 'none', stroke: r.col, 'stroke-width': (Math.random() * 0.8 + 0.5).toFixed(2), 'stroke-linecap': 'round' }));
            branches.appendChild(mk('circle', { cx: ex.toFixed(1), cy: ey.toFixed(1), r: (Math.random() * 1.4 + 0.8).toFixed(1), fill: r.col }));
        }
        g.appendChild(branches);
        // hoofd-node + label
        const glow = mk('circle', { cx: r.cx, cy: r.cy, r: '13', fill: r.col, opacity: '0.12', class: 'br-halo' });
        const node = mk('circle', { cx: r.cx, cy: r.cy, r: '4.5', fill: r.col, stroke: '#060a12', 'stroke-width': '1.4' });
        const lbl = mk('text', { x: r.cx, y: r.cy - 17, 'text-anchor': 'middle', fill: r.col, 'font-family': "'JetBrains Mono',monospace", 'font-size': '7.5', 'font-weight': 'bold', class: 'br-label', opacity: '0.75' });
        lbl.textContent = r.name;
        g.appendChild(glow); g.appendChild(node); g.appendChild(lbl);
        g.addEventListener('mouseenter', () => _brainHover(r, true));
        g.addEventListener('mouseleave', () => _brainHover(r, false));
        svg.appendChild(g);
    }
    // centrale kern
    svg.appendChild(mk('circle', { cx: 320, cy: 200, r: '5', fill: '#eafcff', opacity: '0.85' }));
    svg.appendChild(mk('circle', { cx: 320, cy: 200, r: '11', fill: 'none', stroke: 'rgba(0,217,255,0.5)', 'stroke-width': '1' }));
}

function _brainHover(r, on) {
    const g = document.querySelector(`.brain-region[data-id="${r.id}"]`);
    if (g) {
        g.querySelector('.br-branches').setAttribute('opacity', on ? '1' : '0.5');
        g.querySelector('.br-halo').setAttribute('opacity', on ? '0.32' : '0.12');
        g.querySelector('.br-halo').setAttribute('r', on ? '20' : '13');
        g.querySelector('.br-label').setAttribute('opacity', on ? '1' : '0.75');
        if (on) { g.style.filter = `drop-shadow(0 0 6px ${r.col})`; } else { g.style.filter = ''; }
    }
    const info = document.getElementById('brain-info');
    if (info && on) {
        info.querySelector('.bi-title').textContent = r.name;
        info.querySelector('.bi-title').style.color = r.col;
        info.querySelector('.bi-sub').textContent = 'data & tools in dit gebied';
        info.querySelector('.bi-tools').innerHTML = r.tools.map(t => `<div style="border-left:2px solid ${r.col}; padding-left:8px; margin:5px 0;">${t}</div>`).join('');
    } else if (info && !on) {
        info.querySelector('.bi-title').textContent = 'OSIRIS · MAINBRAIN';
        info.querySelector('.bi-title').style.color = '#eafcff';
        info.querySelector('.bi-sub').textContent = 'hover over een hersengebied';
        info.querySelector('.bi-tools').innerHTML = '';
    }
}
window.buildOsirisBrain = buildOsirisBrain;

// OSIRIS · AUTONOME DREMPELS (13-08)
// ============================================================
let osirisTune = { minProb: 0.53, abstain: 0.56, lastAdjust: 0 };
window.osirisTune = osirisTune;

// ---- SWEEP-ENTRY (15-08): stap in op het verwachte stop-/liquidatie-niveau ----
// I.p.v. direct at-market wacht Osiris tot de prijs terugkomt naar waar de stops/
// liquidaties liggen (een fractie van de stop-afstand) en stapt dáár in. Zo krijg je
// een betere entry en voorkom je dat een positie die je toch zou uitstoppen juist je
// instap wordt. Fallback: niet geraakt binnen het venster => alsnog at-market.
const OSIRIS_BTC_RESERVE = 0.15;   // deel van de gedeelde wallet dat ETH/SOL vrijlaten voor BTC's eigen engine
let osirisSweepEnabled = true;
const OSIRIS_SWEEP_FRAC = 0.35;              // ondiepe sweep (deel van de stop-afstand) - vult snel
const OSIRIS_SWEEP_WINDOW_MS = 35 * 1000;    // max 35s wachten, dan at-market (traden valt niet stil)
let _osirisSweep = {};
let _osirisShortBlock = {};   // munt -> ts: SHORTs tijdelijk geblokkeerd (onvoldoende testnet-saldo)
window.osirisSweepEnabled = osirisSweepEnabled;
window._osirisSweep = _osirisSweep;

function osirisSweepCheck() {
    try {
        for (const sym of Object.keys(_osirisSweep)) {
            const sw = _osirisSweep[sym]; if (!sw) continue;
            const m = neoMultiState.markets[sym];
            const price = m ? m.lastPrice : null;
            const binSym = (typeof MULTI_BINANCE !== 'undefined') ? MULTI_BINANCE[sym] : sym;
            // al een positie open in deze markt+richting? sweep laten vallen (anti-dup)
            if (openPositions.some(x => (x.symbol || x.market) === binSym && x.side === sw.side)) { delete _osirisSweep[sym]; continue; }
            if (price == null) continue;
            const hit = sw.side === 'LONG' ? (price <= sw.level) : (price >= sw.level);
            const expired = Date.now() > sw.expiry;
            if (hit || expired) {
                sw.position.entryPrice = price;   // instappen op het (betere) huidige niveau
                try { logAdaptation(`Osiris sweep ${hit ? 'geraakt' : 'venster verlopen'} · ${sym} ${sw.side}`, hit ? `prijs raakte ${sw.level.toFixed(price < 10 ? 3 : 2)} - instap op het liquidatie-/stop-niveau` : `niet geraakt binnen venster - alsnog at-market (${price.toFixed(price < 10 ? 3 : 2)})`); } catch (e) {}
                commitPositionEntry(sw.position, sw.reason + (hit ? ' [sweep]' : ' [market-fallback]'));
                delete _osirisSweep[sym];
            }
        }
    } catch (e) {}
}
window.osirisSweepCheck = osirisSweepCheck;


function osirisAutoTune() {
    try {
        const now = Date.now();
        if (now - (osirisTune.lastAdjust || 0) < 5 * 60000) return;
        const entries = Object.values(_osirisLastEntry || {}).filter(v => v);
        const lastEntry = entries.length ? Math.max.apply(null, entries) : 0;
        const idleMin = lastEntry ? (now - lastEntry) / 60000 : Infinity;
        const closed = (botTradeLog || []).filter(t => t.action === 'EXIT' && t.isOsiris).slice(-15);
        const wins = closed.filter(t => (t.pnl || 0) > 0).length;
        const wr = closed.length >= 6 ? wins / closed.length : null;
        let changed = false, why = '';
        if (wr != null && wr < 0.42) {
            osirisTune.minProb = Math.min(0.60, +(osirisTune.minProb + 0.01).toFixed(3));
            osirisTune.abstain = Math.min(0.62, +(osirisTune.abstain + 0.01).toFixed(3));
            changed = true; why = `winrate ${(wr * 100 | 0)}% te laag - drempels omhoog`;
        } else if (idleMin > 20) {
            osirisTune.minProb = Math.max(0.51, +(osirisTune.minProb - 0.01).toFixed(3));
            osirisTune.abstain = Math.max(0.53, +(osirisTune.abstain - 0.01).toFixed(3));
            changed = true; why = (isFinite(idleMin) ? `${idleMin | 0} min geen trade` : 'nog geen trade') + ' - drempels omlaag';
        }
        if (changed) {
            if (typeof OsirisDeepNet !== 'undefined') OsirisDeepNet.ABSTAIN_MARGIN = osirisTune.abstain;
            osirisTune.lastAdjust = now;
            try { logAdaptation('Osiris stelt drempels bij', `${why} (kans-drempel ${(osirisTune.minProb * 100).toFixed(0)}%, abstain ${(osirisTune.abstain * 100).toFixed(0)}%)`); } catch (e) {}
        }
        // BTC-DREMPEL (16-08): BTC draait op zijn eigen engine met de globale
        // minProbabilityPct. Osiris stelt die nu ook autonoom bij, zodat BTC blijft
        // meedoen: lang geen BTC-trade -> drempel omlaag; recente BTC-verliezen -> omhoog.
        try {
            const bl = (botTradeLog || []);
            const btcEnt = bl.filter(t => t.action === 'ENTRY' && ((t.market === 'BTC') || (!t.isOsiris && (t.price || 0) > 10000)));
            const lastBtc = btcEnt.length ? (btcEnt[btcEnt.length - 1].timestampMs || 0) : 0;
            const btcIdleMin = lastBtc ? (now - lastBtc) / 60000 : Infinity;
            const btcEx = bl.filter(t => t.action === 'EXIT' && ((t.market === 'BTC') || (!t.isOsiris && (t.price || 0) > 10000))).slice(-10);
            const btcWins = btcEx.filter(t => (t.pnl || 0) > 0).length;
            const btcWr = btcEx.length >= 5 ? btcWins / btcEx.length : null;
            const cur = botSettings.minProbabilityPct != null ? botSettings.minProbabilityPct : 64;
            let nb = cur, bwhy = '';
            if (btcWr != null && btcWr < 0.42) { nb = Math.min(75, cur + 2); bwhy = `BTC-winrate ${(btcWr * 100 | 0)}% te laag`; }
            else if (btcIdleMin > 30) { nb = Math.max(55, cur - 2); bwhy = (isFinite(btcIdleMin) ? `${btcIdleMin | 0} min` : 'nog') + ' geen BTC-trade'; }
            if (nb !== cur) { botSettings.minProbabilityPct = nb; try { logAdaptation('Osiris stelt BTC-drempel bij', `${bwhy} - BTC kans-drempel ${cur}% -> ${nb}%`); } catch (e) {} }
        } catch (e) {}
        // EXIT-KALIBRATIE (14-08): analyse toonde dat trades op breakeven uit-TIME_STOP-en
        // (micro-marges niet vastgehouden). Zit >60% van de recente exits op TIME_STOP,
        // dan houdt Osiris te lang vast -> sneller oogsten + korter vasthouden. Dit vangt
        // de micro-marges EN verhoogt de omloop (meer traden). Zelfcorrigerend: zodra er
        // meer echte oogsten/targets zijn, stopt het bijstellen.
        const recentEx = (botTradeLog || []).filter(t => t.action === 'EXIT').slice(-20);
        if (recentEx.length >= 10) {
            const ts = recentEx.filter(t => (t.reason || '').indexOf('TIME_STOP') === 0).length;
            const tsRatio = ts / recentEx.length;
            let exChanged = false;
            if (tsRatio > 0.6) {
                if ((botSettings.smallProfitHarvestMinutes || 30) > 10) { botSettings.smallProfitHarvestMinutes = Math.max(10, (botSettings.smallProfitHarvestMinutes || 30) - 5); exChanged = true; }
                if ((botSettings.maxPositionAgeMinutes || 90) > 40) { botSettings.maxPositionAgeMinutes = Math.max(40, (botSettings.maxPositionAgeMinutes || 90) - 15); exChanged = true; }
            }
            if (exChanged) {
                osirisTune.lastAdjust = now;
                try { logAdaptation('Osiris stelt exit-timing bij', `${(tsRatio * 100 | 0)}% recente exits waren TIME_STOP op breakeven - sneller oogsten (${botSettings.smallProfitHarvestMinutes}min) + korter vasthouden (${botSettings.maxPositionAgeMinutes}min) om micro-marges vast te houden`); } catch (e) {}
            }
        }
    } catch (e) {}
}
window.osirisAutoTune = osirisAutoTune;

// ============================================================
// ============================================================
// ---- FEAR & GREED SENTIMENT (16-08): externe marktsentiment-feed als SENT-input ----
let osirisSentiment = { value: 50, label: 'Neutral', ts: 0 };
function fetchFearGreed() {
    try {
        fetch('https://api.alternative.me/fng/?limit=1').then(r => r.json()).then(j => {
            if (j && j.data && j.data[0]) {
                osirisSentiment = { value: parseInt(j.data[0].value, 10) || 50, label: j.data[0].value_classification || 'Neutral', ts: Date.now() };
                try { const e = document.getElementById('flow-sent'); if (e) e.textContent = `${osirisSentiment.value} ${osirisSentiment.label}`; } catch (x) {}
            }
        }).catch((e) => { try { logNetworkError('fear&greed', e && e.message || 'fetch mislukt'); } catch (x) {} });
    } catch (e) {}
}
try { fetchFearGreed(); setInterval(fetchFearGreed, 30 * 60000); } catch (e) {}
// Contrarian sentiment-tilt: extreme angst steunt LONG, extreme hebzucht steunt SHORT.
// PER-MARKT SENTIMENT (16-08): de crypto-brede Fear & Greed is de basis; per munt
// verfijnd met de funding rate en long/short-ratio (die we al per munt ophalen).
// Hoog = hebzuchtig/overwegend long, laag = angstig/overwegend short. 0..100.
function marketSentiment(sym) {
    let sc = osirisSentiment.value;   // crypto-brede F&G als basis
    try {
        const f = neoMultiState.markets[sym] && neoMultiState.markets[sym].fund;
        if (f) {
            if (f.fundingRate != null) sc += Math.max(-20, Math.min(20, f.fundingRate * 40000));       // +funding = greedy
            if (f.longShortRatio != null) sc += Math.max(-15, Math.min(15, (f.longShortRatio - 1) * 30)); // >1 = greedy
        }
    } catch (e) {}
    sc = Math.max(0, Math.min(100, sc));
    try { if (neoMultiState.markets[sym]) neoMultiState.markets[sym].sentScore = Math.round(sc); } catch (e) {}
    return sc;
}
window.marketSentiment = marketSentiment;
// Contrarian tilt op basis van het sentiment van DIE markt.
function sentimentTilt(side, sym) {
    const v = sym ? marketSentiment(sym) : osirisSentiment.value;
    if (v <= 25) return side === 'LONG' ? 3 : -3;   // extreme angst -> bodem-bias
    if (v >= 75) return side === 'SHORT' ? 3 : -3;   // extreme hebzucht -> top-bias
    if (v <= 40) return side === 'LONG' ? 1.5 : -1.5;
    if (v >= 60) return side === 'SHORT' ? 1.5 : -1.5;
    return 0;
}
window.osirisSentiment = osirisSentiment;

// ============================================================
// OSIRIS DEEPNET - RADIALE WEERGAVE (about-pagina, 18-08)
// Cirkelvormig, DATA-TRUE: leest de echte input-activaties (neoNetInputs) en de
// live beslissing (zelfde data-true bias als het hoofd-net). Buitenring = 16 inputs,
// naar binnen: integratie -> cores -> osiris -> beslissing in het midden.
// ============================================================
let _radialRaf = null, _radialT = 0;
function drawOsirisRadial() {
    const cv = document.getElementById('about-radial'); if (!cv) return;
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    _radialT += 0.016;
    let inp = {}; try { inp = (typeof neoNetInputs === 'function') ? neoNetInputs() : {}; } catch (e) { inp = {}; }
    const keys = (typeof NEONET_INPUTS !== 'undefined') ? NEONET_INPUTS : [];

    // DATA-TRUE beslissing (zelfde bias als het hoofd-net)
    let decisionBias = 0;
    try {
        let wsum = 0, dsum = 0;
        for (const p of (typeof openPositions !== 'undefined' ? openPositions : [])) { const dir = p.side === 'SHORT' ? -1 : 1; const w = (p.sizePct || 0.1) * 2.2; dsum += w * dir; wsum += w; }
        for (const sym of ['BTC', 'ETH', 'SOL']) { const m = neoMultiState.markets[sym]; if (m && m.bestSide && m.bestProb != null) { const w = 0.2; const dir = m.bestSide === 'SHORT' ? -1 : 1; const conv = Math.min(1, Math.max(0, (m.bestProb - 0.5) * 3)); dsum += w * dir * conv; wsum += w; } }
        if (wsum > 0) decisionBias = Math.max(-1, Math.min(1, dsum / wsum));
    } catch (e) {}
    const decCol = decisionBias > 0.15 ? '#14f195' : decisionBias < -0.15 ? '#ff4f6d' : '#7fd8ff';
    const decTxt = decisionBias > 0.15 ? 'LONG' : decisionBias < -0.15 ? 'SHORT' : 'NEUTRAAL';
    const actLevel = Math.min(1, Object.keys(inp).reduce((a, k) => a + Math.min(1, Math.abs(inp[k] || 0)), 0) / 8);

    const Rmax = Math.min(W, H) * 0.42, ZN = 4, SQUASH = 0.60;   // verticale squash -> 3D-trechter
    const rot = _radialT * 0.28;
    // VORTEX-lagen: inputs -> integratie -> mid -> cores -> beslissing (kern)
    const layerDefs = [
        { count: keys.length || 16, z: 0, kind: 'input' },
        { count: 9, z: 1, kind: 'mid' },
        { count: 5, z: 2, kind: 'mid' },
        { count: 3, z: 3, kind: 'core' },
        { count: 1, z: 4, kind: 'decision' }
    ];
    function nodePos(z, i, count) {
        const depthT = z / ZN;
        const R = Rmax * (1 - depthT * 0.9);
        const twist = z * 1.15 + rot;                    // getwiste ringen -> spiraal
        const persp = 1 - depthT * 0.30;
        const ang = (i / count) * Math.PI * 2 + twist;
        const wob = 1 + 0.06 * Math.sin(_radialT * 2 + i + z);
        return { x: cx + Math.cos(ang) * R * persp * wob, y: cy + Math.sin(ang) * R * persp * SQUASH * wob - depthT * 26, ang, depthT };
    }
    const layers = layerDefs.map(L => { const ns = []; for (let i = 0; i < L.count; i++) { const p = nodePos(L.z, i, L.count); let act = 0.4, col = '#7fd8ff'; if (L.kind === 'input' && keys[i]) { act = Math.min(1, Math.abs(inp[keys[i].key] || 0)); col = keys[i].c; } else if (L.kind === 'core') { const sym = ['BTC', 'ETH', 'SOL'][i]; const m = neoMultiState.markets[sym]; act = m && m.bestProb != null ? m.bestProb : 0.5; col = { BTC: '#f7931a', ETH: '#8fb8ff', SOL: '#14f195' }[sym]; p.sym = sym; } else if (L.kind === 'decision') { act = Math.abs(decisionBias); col = decCol; } p.act = act; p.col = col; p.kind = L.kind; ns.push(p); } return ns; });

    // SPIRAAL-VERBINDINGEN tussen opeenvolgende lagen (getwist -> vortex-armen)
    for (let li = 0; li < layers.length - 1; li++) {
        const A = layers[li], B = layers[li + 1];
        for (let a = 0; a < A.length; a++) {
            // verbind met de 2 dichtstbijzijnde knopen van de volgende laag (op hoek)
            const order = B.map((n, bi) => ({ bi, d: Math.abs(Math.atan2(Math.sin(n.ang - A[a].ang), Math.cos(n.ang - A[a].ang))) })).sort((x, y) => x.d - y.d).slice(0, B.length <= 1 ? 1 : 2);
            for (const o of order) {
                const nb = B[o.bi]; const sig = (A[a].act + nb.act) / 2;
                const mx = (A[a].x + nb.x) / 2 + (cy - (A[a].y + nb.y) / 2) * 0.12;
                const my = (A[a].y + nb.y) / 2 + ((A[a].x + nb.x) / 2 - cx) * 0.12;   // curve -> spiraal
                ctx.beginPath(); ctx.moveTo(A[a].x, A[a].y); ctx.quadraticCurveTo(mx, my, nb.x, nb.y);
                ctx.strokeStyle = _rgba(A[a].col, 0.04 + 0.28 * sig); ctx.lineWidth = 0.5 + 1.4 * sig; ctx.stroke();
                // datastroom-deeltje langs de arm (naar binnen)
                const ph = (_radialT * (0.5 + sig) + a * 0.11 + li * 0.2) % 1;
                const t = ph, u = 1 - t;
                const px = u * u * A[a].x + 2 * u * t * mx + t * t * nb.x, py = u * u * A[a].y + 2 * u * t * my + t * t * nb.y;
                ctx.beginPath(); ctx.arc(px, py, 0.8 + 1.8 * sig, 0, 6.283); ctx.fillStyle = _rgba(A[a].col, 0.3 + 0.6 * sig); ctx.fill();
            }
        }
    }

    // TESLA-BOGEN: gekartelde bliksem van de sterkste inputs naar de kern (flikkerend)
    const core = layers[layers.length - 1][0];
    const strong = layers[0].slice().sort((a, b) => b.act - a.act).slice(0, 3);
    for (const sN of strong) {
        if (sN.act < 0.15) continue;
        if (Math.sin(_radialT * 9 + sN.ang * 3) < 0.3) continue;   // flikker
        ctx.beginPath(); ctx.moveTo(sN.x, sN.y);
        const seg = 7;
        for (let k = 1; k <= seg; k++) {
            const t = k / seg; const bx = sN.x + (core.x - sN.x) * t, by = sN.y + (core.y - sN.y) * t;
            const jag = (1 - t) * 15; const ox = (Math.random() - 0.5) * jag, oy = (Math.random() - 0.5) * jag;   // (22-08) minder grillig
            ctx.lineTo(bx + ox, by + oy);
        }
        // (22-08) dunner + lichter bliksem-effect: minder storend
        ctx.strokeStyle = _rgba(sN.col, 0.22 + 0.22 * sN.act); ctx.lineWidth = 0.5; ctx.shadowColor = sN.col; ctx.shadowBlur = 3; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // KNOPEN tekenen (van buiten naar binnen), inputs met labels
    for (let li = 0; li < layers.length; li++) {
        for (const nd of layers[li]) {
            const r = (nd.kind === 'decision') ? 0 : (nd.kind === 'core') ? (5 + 9 * Math.max(0, nd.act - 0.4)) : (2.5 + 4 * nd.act);
            if (r > 0) {
                ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, 6.283); ctx.fillStyle = _rgba(nd.col, 0.35 + 0.55 * nd.act); ctx.fill();
                if (nd.act > 0.12) { ctx.save(); ctx.shadowColor = nd.col; ctx.shadowBlur = 9 * nd.act; ctx.beginPath(); ctx.arc(nd.x, nd.y, Math.max(1.5, r * 0.5), 0, 6.283); ctx.fillStyle = nd.col; ctx.fill(); ctx.restore(); }
            }
            if (nd.kind === 'core') { ctx.fillStyle = _rgba(nd.col, 0.9); ctx.font = "8px 'JetBrains Mono',monospace"; ctx.textAlign = 'center'; ctx.fillText(nd.sym, nd.x, nd.y - r - 4); }
            if (nd.kind === 'input' && keys[li === 0 ? layers[0].indexOf(nd) : 0]) {
                const idx = layers[0].indexOf(nd); const lbl = keys[idx] ? keys[idx].label : '';
                const lr = Rmax + 16; const lx = cx + Math.cos(nd.ang) * lr, ly = cy + Math.sin(nd.ang) * lr * SQUASH;
                ctx.fillStyle = _rgba(nd.col, 0.7); ctx.font = "7.5px 'JetBrains Mono',monospace";
                ctx.textAlign = Math.cos(nd.ang) > 0.3 ? 'left' : Math.cos(nd.ang) < -0.3 ? 'right' : 'center';
                ctx.fillText(lbl, lx, ly + 3);
            }
        }
    }

    // VORTEX-KERN: pulserende beslissing (data-true kleur), met roterende gloed-ringen
    const pulse = 1 + 0.08 * Math.sin(_radialT * 3);
    for (let g = 3; g >= 1; g--) { ctx.beginPath(); ctx.arc(core.x, core.y, (10 + g * 9) * pulse, 0, 6.283); ctx.fillStyle = _rgba(decCol, 0.05 * g * (0.4 + actLevel)); ctx.fill(); }
    ctx.save(); ctx.shadowColor = decCol; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(core.x, core.y, 14 * pulse, 0, 6.283); ctx.fillStyle = _rgba(decCol, 0.95); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#eafcff'; ctx.font = "bold 11px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
    ctx.fillText(decTxt, core.x, core.y - 30);
    ctx.fillStyle = _rgba(decCol, 0.9); ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`${Math.round(Math.abs(decisionBias) * 100)}%`, core.x, core.y + 4);

    _radialRaf = requestAnimationFrame(drawOsirisRadial);
}
function _rgba(hex, a) { try { const h = hex.replace('#', ''); const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return `rgba(${r},${g},${b},${a})`; } catch (e) { return `rgba(127,216,255,${a})`; } }
function startOsirisRadial() { if (!_radialRaf && document.getElementById('about-radial')) drawOsirisRadial(); }
window.startOsirisRadial = startOsirisRadial; window.drawOsirisRadial = drawOsirisRadial;
try { window.addEventListener('DOMContentLoaded', () => setTimeout(startOsirisRadial, 800)); } catch (e) {}

// ============================================================
// OSIRIS · FINANCIAL STRESS OSCILLATOR (FSO) - UOTAM-framework (19-08)
// Meet systeem-stress over de cryptomarkt op DRIE tijdschalen (micro/meso/macro) +
// een volledige-historie chart. Per tijdschaal: N genormeerde oscillatoren S_i(t) in
// [0,1] (per munt: realized vol, drawdown, volume-shock, range, RSI-extremiteit; cross-
// market: correlatie-breuk + return-dispersie). Global Stress = gemiddelde (S̄), System
// Variance = variantie tussen de oscillatoren (chaos/asynchronie, early-warning).
// FASE 1: puur meten + visualiseren. Verandert NIETS aan de trading. Data-true (Binance).
// ============================================================
const FSO_SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const FSO_SCALES = {
    micro: { interval: '1m', limit: 360, win: 20, label: 'MICRO · 1m (~6u)' },
    meso: { interval: '1h', limit: 336, win: 24, label: 'MESO · 1h (~2wk)' },
    macro: { interval: '1d', limit: 1000, win: 20, label: 'MACRO · 1d (~3jr)' },
    full: { interval: '1d', limit: 1000, win: 20, label: 'VOLLEDIG · 1d (sinds notering)', paged: 3 }
};
const OsirisFSO = {
    scales: {},              // per schaal: { times, stress, variance, osc:[[...]], names, regime }
    _last: {}, _busy: false,
    BANDS: [{ to: 0.15, c: 'rgba(20,241,149,0.05)', name: 'RUST' }, { to: 0.30, c: 'rgba(255,182,39,0.06)', name: 'SPANNING' }, { to: 1, c: 'rgba(255,79,109,0.07)', name: 'CRISIS' }],

    async _klines(sym, interval, limit, endTime) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;
        const r = await bFetch(url); const j = await r.json();
        if (!Array.isArray(j)) throw new Error('geen klines');
        return j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    },
    async _fetchScale(key) {
        const cfg = FSO_SCALES[key];
        const byMkt = {};
        for (const sym of FSO_SYMS) {
            try {
                let all = [];
                if (cfg.paged) {
                    let end = undefined;
                    for (let p = 0; p < cfg.paged; p++) {
                        const chunk = await this._klines(sym, cfg.interval, cfg.limit, end);
                        if (!chunk.length) break;
                        all = chunk.concat(all); end = chunk[0].t - 1;
                        if (chunk.length < cfg.limit) break;
                    }
                } else { all = await this._klines(sym, cfg.interval, cfg.limit); }
                byMkt[sym] = all;
            } catch (e) { byMkt[sym] = []; try { if (typeof logNetworkError === 'function') logNetworkError('FSO-klines', `${sym} ${cfg.interval}: ${e.message}`); } catch (x) {} }
        }
        return byMkt;
    },
    // oscillatoren + global stress + variance uit uitgelijnde OHLCV per munt
    _compute(byMkt, win) {
        // lijn uit op de kortste reeks (op index, recent-gealigneerd)
        const series = FSO_SYMS.map(s => byMkt[s] || []).filter(a => a.length > win + 5);
        if (series.length === 0) return null;
        const L = Math.min(...series.map(a => a.length));
        const marketsUsed = series.length;
        const aligned = series.map(a => a.slice(a.length - L));
        const names = [], oscArrays = [];
        const clamp01 = x => Math.max(0, Math.min(1, x));
        // per munt: 5 oscillatoren
        const perMktFns = [
            { n: 'vol', f: (c, i) => { let s = 0, m = 0, k = 0; for (let j = Math.max(1, i - win); j <= i; j++) { const r = Math.log(c[j].c / c[j - 1].c); m += r; k++; } m /= k || 1; for (let j = Math.max(1, i - win); j <= i; j++) { const r = Math.log(c[j].c / c[j - 1].c); s += (r - m) ** 2; } return clamp01(Math.sqrt(s / (k || 1)) * 14); } },
            { n: 'ddown', f: (c, i) => { let pk = -Infinity; for (let j = Math.max(0, i - win); j <= i; j++) pk = Math.max(pk, c[j].h); return clamp01((pk - c[i].c) / (pk || 1) * 4); } },
            { n: 'volz', f: (c, i) => { let m = 0, k = 0; for (let j = Math.max(0, i - win); j <= i; j++) { m += c[j].v; k++; } m /= k || 1; let sd = 0; for (let j = Math.max(0, i - win); j <= i; j++) sd += (c[j].v - m) ** 2; sd = Math.sqrt(sd / (k || 1)) || 1; return clamp01(Math.abs(c[i].v - m) / sd / 3); } },
            { n: 'range', f: (c, i) => clamp01((c[i].h - c[i].l) / (c[i].c || 1) * 10) },
            { n: 'rsi', f: (c, i) => { let up = 0, dn = 0; for (let j = Math.max(1, i - 14); j <= i; j++) { const d = c[j].c - c[j - 1].c; if (d > 0) up += d; else dn -= d; } const rs = dn === 0 ? 100 : up / dn; const rsi = 100 - 100 / (1 + rs); return clamp01(Math.abs(rsi - 50) / 50); } }
        ];
        const symShort = FSO_SYMS.map(s => s.replace('USDT', ''));
        for (let mi = 0; mi < aligned.length; mi++) {
            for (const fn of perMktFns) {
                names.push(`${symShort[mi]}·${fn.n}`);
                const arr = new Array(L).fill(0);
                for (let i = 0; i < L; i++) arr[i] = fn.f(aligned[mi], i);
                oscArrays.push(arr);
            }
        }
        // cross-market: correlatie-breuk + dispersie (alleen als >1 munt)
        if (marketsUsed > 1) {
            const rets = aligned.map(c => { const r = new Array(L).fill(0); for (let i = 1; i < L; i++) r[i] = Math.log(c[i].c / c[i - 1].c); return r; });
            const corrBreak = new Array(L).fill(0), disp = new Array(L).fill(0);
            for (let i = 0; i < L; i++) {
                let cs = 0, cc = 0;
                for (let a = 0; a < rets.length; a++) for (let b = a + 1; b < rets.length; b++) {
                    let ma = 0, mb = 0, k = 0; for (let j = Math.max(1, i - win); j <= i; j++) { ma += rets[a][j]; mb += rets[b][j]; k++; } ma /= k || 1; mb /= k || 1;
                    let cov = 0, va = 0, vb = 0; for (let j = Math.max(1, i - win); j <= i; j++) { cov += (rets[a][j] - ma) * (rets[b][j] - mb); va += (rets[a][j] - ma) ** 2; vb += (rets[b][j] - mb) ** 2; }
                    const corr = (va && vb) ? cov / Math.sqrt(va * vb) : 0; cs += corr; cc++;
                }
                corrBreak[i] = clamp01((1 - (cc ? cs / cc : 1)) / 2);
                const vals = rets.map(r => r[i]); const mm = vals.reduce((a, b) => a + b, 0) / vals.length; disp[i] = clamp01(Math.sqrt(vals.reduce((a, b) => a + (b - mm) ** 2, 0) / vals.length) * 20);
            }
            names.push('X·corr-break'); oscArrays.push(corrBreak);
            names.push('X·dispersie'); oscArrays.push(disp);
        }
        // Global Stress (S̄) + System Variance (σ²) per tijdstip
        const N = oscArrays.length, stress = new Array(L).fill(0), variance = new Array(L).fill(0);
        for (let i = 0; i < L; i++) {
            let m = 0; for (let o = 0; o < N; o++) m += oscArrays[o][i]; m /= N; stress[i] = m;
            let v = 0; for (let o = 0; o < N; o++) v += (oscArrays[o][i] - m) ** 2; variance[i] = v / N;
        }
        const times = aligned[0].map(c => c.t);
        const cur = stress[L - 1] || 0;
        const regime = cur > 0.30 ? 'CRISIS' : cur > 0.15 ? 'SPANNING' : 'RUST';
        return { times, stress, variance, osc: oscArrays, names, regime, current: cur, curVar: variance[L - 1] || 0, marketsUsed };
    },
    async update(key) {
        try {
            const byMkt = await this._fetchScale(key);
            const res = this._compute(byMkt, FSO_SCALES[key].win);
            if (res) { res._raw = byMkt; this.scales[key] = res; this._last[key] = Date.now(); try { drawFSOChart('fso-' + key, key); } catch (e) {} }
        } catch (e) { try { if (typeof logNetworkError === 'function') logNetworkError('FSO-update', `${key}: ${e.message}`); } catch (x) {} }
    },
    async refreshAll() {
        if (this._busy) return; this._busy = true;
        try { for (const k of ['micro', 'meso', 'macro', 'full']) { await this.update(k); } } finally { this._busy = false; }
    }
};
window.OsirisFSO = OsirisFSO;

// ---- CANVAS-RENDERER: pastel-oscillatoren + dikke Global-Stress-lijn + variance (2e as) ----
const _FSO_PASTEL = ['#f7931a', '#ffb27a', '#ffd19a', '#8fb8ff', '#a5c8ff', '#14f195', '#7af0b8', '#c792ea', '#e0a3f0', '#7fd8ff', '#a3e4ff', '#ff8a94', '#ffb0b6', '#f0d97a', '#b8e986', '#9ad0c2', '#d0a3ff'];
function drawFSOChart(canvasId, key) {
    const cv = document.getElementById(canvasId); if (!cv) return;
    const S = OsirisFSO.scales[key]; const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, padL = 36, padR = 44, padT = 12, padB = 18;
    ctx.clearRect(0, 0, W, H);
    if (!S) { ctx.fillStyle = '#5c7488'; ctx.font = "10px 'JetBrains Mono',monospace"; ctx.textAlign = 'center'; ctx.fillText('FSO laadt marktdata\u2026', W / 2, H / 2); return; }
    const L = S.stress.length; if (L < 2) return;
    const now = Date.now() / 1000;
    const x = i => padL + (i / (L - 1)) * (W - padL - padR);
    const yS = v => padT + (1 - Math.max(0, Math.min(1, v / 0.6))) * (H - padT - padB);
    const vmax = Math.max(0.01, Math.max.apply(null, S.variance)) * 1.15; const yV = v => padT + (1 - v / vmax) * (H - padT - padB);

    // regime-banden (subtiel)
    let prev = 0; for (const bnd of OsirisFSO.BANDS) { const y1 = yS(Math.min(0.6, bnd.to)), y0 = yS(prev); ctx.fillStyle = bnd.c; ctx.fillRect(padL, y1, W - padL - padR, y0 - y1); prev = bnd.to; }
    // horizontale gridlijnen op de regime-grenzen
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    [0.15, 0.30, 0.45].forEach(v => { ctx.beginPath(); ctx.moveTo(padL, yS(v)); ctx.lineTo(W - padR, yS(v)); ctx.stroke(); }); ctx.setLineDash([]);

    // i.p.v. 17 losse lijnen: een LICHTE min-max ENVELOPPE (de spreiding = asynchronie,
    // visueel veel rustiger en leesbaarder). Boven- en ondergrens van alle oscillatoren.
    const mn = new Array(L), mx = new Array(L);
    for (let i = 0; i < L; i++) { let a2 = 1, b2 = 0; for (let o = 0; o < S.osc.length; o++) { const v = S.osc[o][i]; if (v < a2) a2 = v; if (v > b2) b2 = v; } mn[i] = a2; mx[i] = b2; }
    ctx.beginPath(); for (let i = 0; i < L; i++) { const px = x(i), py = yS(mx[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    for (let i = L - 1; i >= 0; i--) ctx.lineTo(x(i), yS(mn[i])); ctx.closePath();
    ctx.fillStyle = 'rgba(127,180,255,0.08)'; ctx.fill();

    // System Variance (blauw, 2e as) - duidelijke lijn met eigen gebied
    ctx.beginPath(); for (let i = 0; i < L; i++) { const px = x(i), py = yV(S.variance[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.lineTo(x(L - 1), H - padB); ctx.lineTo(x(0), H - padB); ctx.closePath();
    ctx.fillStyle = 'rgba(127,180,255,0.06)'; ctx.fill();
    ctx.strokeStyle = 'rgba(127,180,255,0.9)'; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let i = 0; i < L; i++) { const px = x(i), py = yV(S.variance[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke();

    // Global Stress: gevuld gebied + dikke lijn (het hoofdsignaal, maximaal leesbaar)
    const grd = ctx.createLinearGradient(0, padT, 0, H - padB);
    grd.addColorStop(0, 'rgba(255,95,126,0.28)'); grd.addColorStop(1, 'rgba(255,95,126,0.02)');
    ctx.beginPath(); for (let i = 0; i < L; i++) { const px = x(i), py = yS(S.stress[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.lineTo(x(L - 1), H - padB); ctx.lineTo(x(0), H - padB); ctx.closePath(); ctx.fillStyle = grd; ctx.fill();
    ctx.strokeStyle = '#ff5f7e'; ctx.lineWidth = 2.4; ctx.shadowColor = '#ff5f7e'; ctx.shadowBlur = 5; ctx.beginPath();
    for (let i = 0; i < L; i++) { const px = x(i), py = yS(S.stress[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke(); ctx.shadowBlur = 0;

    // TIKKENDE huidige-waarde marker (pulseert per seconde) rechts
    const cx = x(L - 1), cyv = yS(S.stress[L - 1]);
    const pulse = 3 + 1.6 * Math.sin(now * 3);
    ctx.beginPath(); ctx.arc(cx, cyv, pulse + 3, 0, 6.283); ctx.fillStyle = 'rgba(255,95,126,0.2)'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cyv, 3.2, 0, 6.283); ctx.fillStyle = '#ffd0d8'; ctx.fill();

    // as-labels (y)
    ctx.fillStyle = '#7d99ac'; ctx.font = "8px 'JetBrains Mono',monospace"; ctx.textAlign = 'right';
    [0, 0.15, 0.3, 0.45, 0.6].forEach(v => ctx.fillText(v.toFixed(2), padL - 4, yS(v) + 3));
    // TIJDAS (x): labels afgeleid uit S.times, geformatteerd per schaal
    try {
        if (S.times && S.times.length === L) {
            const fmt = (ms) => { const dt = new Date(ms); const p = n => String(n).padStart(2, '0'); if (key === 'micro') return `${p(dt.getHours())}:${p(dt.getMinutes())}`; if (key === 'meso') return `${p(dt.getDate())}/${p(dt.getMonth() + 1)} ${p(dt.getHours())}h`; return `${p(dt.getMonth() + 1)}/${String(dt.getFullYear()).slice(2)}`; };
            ctx.fillStyle = '#6d8296'; ctx.font = "7.5px 'JetBrains Mono',monospace";
            const steps = 5;
            for (let s2 = 0; s2 <= steps; s2++) {
                const i = Math.round((s2 / steps) * (L - 1)); const px = x(i);
                ctx.textAlign = s2 === 0 ? 'left' : s2 === steps ? 'right' : 'center';
                ctx.fillText(fmt(S.times[i]), px, H - 4);
                ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, H - padB); ctx.stroke();
            }
        }
    } catch (e) {}
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(127,180,255,0.85)'; ctx.fillText('\u03c3\u00b2', W - padR + 5, padT + 8);
    // regime-badge bovenin (verplaatst zodat de tijdas onderaan vrij is)
    const rc = S.regime === 'CRISIS' ? '#ff4f6d' : S.regime === 'SPANNING' ? '#ffb627' : '#14f195';
    ctx.textAlign = 'left'; ctx.fillStyle = rc; ctx.font = "bold 10px 'JetBrains Mono',monospace";
    ctx.fillText(`\u25cf ${S.regime}`, padL + 2, padT + 9);
    ctx.fillStyle = '#9fb2c4'; ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.fillText(`stress ${S.current.toFixed(3)} \u00b7 \u03c3\u00b2 ${S.curVar.toFixed(4)}${S.marketsUsed < 3 ? ' \u00b7 ' + S.marketsUsed + ' munten' : ''}`, padL + 74, padT + 9);
}
window.drawFSOChart = drawFSOChart;

let _fsoInterval = null, _fsoTick = null;
// globale stress-signalen die Osiris in Fase 2 gebruikt (uit de MESO-schaal = swing-regime)
let osirisStress = { level: 0, variance: 0, regime: 'RUST', ts: 0 };
window.osirisStress = osirisStress;
let osirisFSOLog = [];
try { osirisFSOLog = JSON.parse(localStorage.getItem('osirisFSOLog') || '[]'); } catch (e) { osirisFSOLog = []; }
window.osirisFSOLog = osirisFSOLog;
// FASE 2: Osiris gebruikt de FSO. Retourneert een voorzichtigheids-opslag (0..10%) op de
// entry-drempel bij hoge systeem-stress/asynchronie. 0 als er geen verse FSO-data is.
function fsoRiskAdjust() {
    try {
        if (!osirisStress.ts || Date.now() - osirisStress.ts > 30 * 60000) return 0;
        let bump = 0;
        if (osirisStress.level > 0.30) bump += 6; else if (osirisStress.level > 0.20) bump += 3;
        if (osirisStress.variance > 0.02) bump += 3;      // hoge asynchronie = early warning
        return Math.min(10, bump);
    } catch (e) { return 0; }
}
window.fsoRiskAdjust = fsoRiskAdjust;
function _fsoUpdateGlobal() {
    try {
        const m = OsirisFSO.scales.meso || OsirisFSO.scales.micro;
        if (m) { osirisStress.level = m.current; osirisStress.variance = m.curVar; osirisStress.regime = m.regime; osirisStress.ts = Date.now(); }
        // rolling FSO-log (per minuut): stress/variance/regime per schaal - voor de export
        const snap = { ts: Date.now() };
        for (const k of ['micro', 'meso', 'macro', 'full']) { const S = OsirisFSO.scales[k]; if (S) snap[k] = { s: +S.current.toFixed(4), v: +S.curVar.toFixed(5), r: S.regime }; }
        if (osirisFSOLog.length === 0 || Date.now() - osirisFSOLog[0].ts > 55000) {
            osirisFSOLog.unshift(snap); if (osirisFSOLog.length > 500) osirisFSOLog.pop();
            try { localStorage.setItem('osirisFSOLog', JSON.stringify(osirisFSOLog.slice(0, 300))); } catch (e) {}
        }
    } catch (e) {}
}
// LIVE TICK (per seconde): werk het laatste micro-punt bij met de live prijzen en herteken,
// zodat de charts echt per seconde bewegen (klines zijn 1m, dit interpoleert de laatste bar).
function fsoLiveTick() {
    try {
        const S = OsirisFSO.scales.micro;
        if (S && S.stress && S.stress.length > 5 && S._raw) {
            // gebruik live lastPrice per munt om de laatste bar-close te verversen
            let changed = false;
            for (let mi = 0; mi < FSO_SYMS.length; mi++) {
                const sym = FSO_SYMS[mi].replace('USDT', '');
                const mk = neoMultiState.markets[sym];
                if (mk && mk.lastPrice && S._raw[FSO_SYMS[mi]] && S._raw[FSO_SYMS[mi]].length) {
                    const arr = S._raw[FSO_SYMS[mi]]; const last = arr[arr.length - 1];
                    last.c = mk.lastPrice; last.h = Math.max(last.h, mk.lastPrice); last.l = Math.min(last.l, mk.lastPrice); changed = true;
                }
            }
            if (changed) { const res = OsirisFSO._compute(S._raw, FSO_SCALES.micro.win); if (res) { res._raw = S._raw; OsirisFSO.scales.micro = res; } }
        }
        drawFSOChart('fso-micro', 'micro'); drawFSOChart('fso-meso', 'meso'); drawFSOChart('fso-macro', 'macro'); drawFSOChart('fso-full', 'full');
        _fsoUpdateGlobal();
    } catch (e) {}
}
window.fsoLiveTick = fsoLiveTick;
function startOsirisFSO() {
    try {
        if (typeof OsirisFSO === 'undefined') return;
        OsirisFSO.refreshAll();
        if (!_fsoInterval) _fsoInterval = setInterval(() => {
            OsirisFSO.update('micro');
            if (Date.now() % (15 * 60000) < 60000) OsirisFSO.update('meso');
            if (Date.now() % (6 * 3600000) < 60000) { OsirisFSO.update('macro'); OsirisFSO.update('full'); }
            _fsoUpdateGlobal();
        }, 60000);
        if (!_fsoTick) _fsoTick = setInterval(fsoLiveTick, 1000);   // per-seconde herteken
    } catch (e) {}
}
window.startOsirisFSO = startOsirisFSO;
try { window.addEventListener('DOMContentLoaded', () => setTimeout(startOsirisFSO, 2500)); } catch (e) {}

// ============================================================
// OSIRIS · KINETIC BREAKPOINT-ENGINE (19-08) - UOTAM "kinetische energie"
// ------------------------------------------------------------
// Vertaalt het UOTAM-frame (2-maart case study) naar de crypto-markt en voorspelt
// per munt (BTC/ETH/SOL) het DICHTSTBIJZIJNDE breakpoint (niveau + richting + ETA):
//
//   POTENTIELE ENERGIE (opgeslagen veer)  PE = wA·asynchronie(σ²) + wC·compressie
//     - asynchronie σ²_m = variantie van de 5 eigen oscillatoren van de munt
//       (vol, drawdown, volume-Z, range, RSI) -> de UOTAM-voorbode.
//     - compressie = 1 - percentiel(realized-vol) -> hoog bij een samengedrukt bandje.
//   KINETISCHE ENERGIE (de beweging)       KE = ½·massa·snelheid²
//     - snelheid v = EWMA %/bar (met richting); massa μ = 1 + volume-Z⁺ (deelname).
//   LOADING (nabij breakpoint)             L  = PE·(1 - KE_norm)   (veer gespannen, nog niet los)
//   SCHOK-SUBINDEX (ontsteking)            Shock = release-gewogen snel venster
//     (|rendement|-z, volume-Z⁺, range, drawdown-versnelling) - BEWUST zonder RSI/corr,
//     de termen die de brede FSO tegen de prijs in lieten lopen.
//   SYNCHRONIE (besmetting)                Sync hoog = alle 3 munten ontsteken tegelijk
//     -> de "synchrone stress-explosie" (fasetransitie) uit de case study.
//
// Breakpoint = dichtstbijzijnde barrière (Donchian/compressie-band) in de richting van
// v, die binnen het energie-bereik Ř valt. ETA ≈ afstand/|v|. p_break = gekalibreerd.
// ALLES wordt gelogd (per update + elke voorspelling + de uitkomst-scoring) en is
// downloadbaar (in de volledige export én los via downloadKineticData()).
// Puur additief en volledig gewrapt: raakt de bestaande engines niet.
// ============================================================
const OsirisKinetic = {
    SYMS: ['BTC', 'ETH', 'SOL'],
    P: { wA: 0.6, wC: 0.4, eta: 0.8, win: 14, donch: 20, shockWin: 4, velBars: 3, barMin: 15,
         fireP: 0.5, maxEtaMin: 240, k1: 3.0, k2: 8.0, a0: -2.2, aL: 2.4, aShk: 1.8, aSync: 1.2, aReach: 1.0 },
    state: {},           // per sym: laatste berekende grootheden
    log: [],             // rollende snapshots (per update, cap 600)
    predictions: [],     // open voorspellingen (nog niet afgelopen)
    resolved: [],        // afgeronde voorspellingen + hit/miss (cap 800)
    calib: {},           // kalibratie-bins: decile -> {n, hits, pSum}
    _norm: {},           // per sym rollende schaal voor KE/Shock-normalisatie
    _lastUpd: 0,

    _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; },
    _std(a) { const n = a.length; if (!n) return 0; const m = a.reduce((x, y) => x + y, 0) / n; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / n); },
    _pctRank(arr, v) { let c = 0; for (let i = 0; i < arr.length; i++) if (arr[i] <= v) c++; return arr.length ? c / arr.length : 0.5; },

    // de 5 per-munt oscillatoren op bar i (zelfde definities als de FSO), plus ruwe volume-z
    _osc(K, i, win) {
        const c = j => parseFloat(K[j][4]), h = j => parseFloat(K[j][2]), l = j => parseFloat(K[j][3]), v = j => parseFloat(K[j][5]);
        const cl01 = this._clamp01;
        let m = 0, k = 0; for (let j = Math.max(1, i - win); j <= i; j++) { m += Math.log(c(j) / c(j - 1)); k++; } m /= (k || 1);
        let s = 0; for (let j = Math.max(1, i - win); j <= i; j++) { const r = Math.log(c(j) / c(j - 1)); s += (r - m) * (r - m); }
        const vol = cl01(Math.sqrt(s / (k || 1)) * 14);
        let pk = -Infinity; for (let j = Math.max(0, i - win); j <= i; j++) pk = Math.max(pk, h(j)); const ddown = cl01((pk - c(i)) / (pk || 1) * 4);
        let mv = 0, kk = 0; for (let j = Math.max(0, i - win); j <= i; j++) { mv += v(j); kk++; } mv /= (kk || 1);
        let sd = 0; for (let j = Math.max(0, i - win); j <= i; j++) sd += (v(j) - mv) * (v(j) - mv); sd = Math.sqrt(sd / (kk || 1)) || 1;
        const volzRaw = (v(i) - mv) / sd; const volz = cl01(Math.abs(volzRaw) / 3);
        const range = cl01((h(i) - l(i)) / (c(i) || 1) * 10);
        let up = 0, dn = 0; for (let j = Math.max(1, i - 14); j <= i; j++) { const d = c(j) - c(j - 1); if (d > 0) up += d; else dn -= d; } const rs = dn === 0 ? 100 : up / dn; const rsiOsc = cl01(Math.abs((100 - 100 / (1 + rs)) - 50) / 50);
        return { vol, ddown, volz, range, rsi: rsiOsc, volzRaw, ret: Math.log(c(i) / c(i - 1)) };
    },

    _market(sym) {
        try {
            const m = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[sym] : null;
            const K = m && m.klines && m.klines.length > 40 ? m.klines : null;
            if (!K) return null;
            const N = K.length, i = N - 1, win = this.P.win, cl01 = this._clamp01;
            const c = j => parseFloat(K[j][4]), h = j => parseFloat(K[j][2]), l = j => parseFloat(K[j][3]);
            const o = this._osc(K, i, win), oPrev = this._osc(K, i - 1, win);
            const oscVec = [o.vol, o.ddown, o.volz, o.range, o.rsi];
            const S_local = oscVec.reduce((a, b) => a + b, 0) / 5;
            let vv = 0; for (const x of oscVec) vv += (x - S_local) * (x - S_local); const sigma2 = vv / 5;         // asynchronie (UOTAM-voorbode)
            const sigma2n = cl01(sigma2 / 0.25);                                                                   // -> 0..1
            // compressie: realized-vol percentiel over ~200 bars (laag = samengedrukt)
            const rvHist = []; for (let j = Math.max(win + 1, N - 200); j <= i; j++) { const oo = this._osc(K, j, win); rvHist.push(oo.vol); }
            const compression = 1 - this._pctRank(rvHist, o.vol);
            const PE = cl01(this.P.wA * sigma2n + this.P.wC * compression);
            // snelheid (EWMA %/bar, richting) + massa
            let ew = 0, a = 0.5; for (let j = i - this.P.velBars + 1; j <= i; j++) { const r = Math.log(c(j) / c(j - 1)) * 100; ew = a * r + (1 - a) * ew; }
            const vel = ew;                                                                                        // %/bar
            const mass = Math.max(0.2, 1 + Math.max(0, o.volzRaw));
            const KE = 0.5 * mass * vel * vel;
            // schok-subindex (release-gewogen, snel venster)
            let retAbsAvg = 0, ck = 0; for (let j = Math.max(1, i - this.P.shockWin * 3); j <= i; j++) { retAbsAvg += Math.abs(Math.log(c(j) / c(j - 1))); ck++; } retAbsAvg = (retAbsAvg / (ck || 1)) || 1e-9;
            const retShock = cl01(Math.abs(o.ret) / retAbsAvg / 3);
            const volShock = cl01(Math.max(0, o.volzRaw) / 3);
            const ddownAccel = cl01(Math.max(0, o.ddown - oPrev.ddown) * 8);
            const Shock = (retShock + volShock + o.range + ddownAccel) / 4;
            // normalisatie-schaal (EWMA van magnitudes) voor KE
            const nrm = this._norm[sym] || { ke: KE || 1e-6, shock: Shock || 1e-6 };
            nrm.ke = 0.98 * nrm.ke + 0.02 * Math.max(KE, 1e-6); nrm.shock = 0.98 * nrm.shock + 0.02 * Math.max(Shock, 1e-6); this._norm[sym] = nrm;
            const KEnorm = cl01(KE / (nrm.ke * 3));
            const Loading = PE * (1 - KEnorm);
            // barrières: Donchian(donch) + compressie-band (Bollinger 20,2)
            let hi = -Infinity, lo = Infinity; for (let j = Math.max(0, i - this.P.donch); j <= i; j++) { hi = Math.max(hi, h(j)); lo = Math.min(lo, l(j)); }
            const price = c(i);
            const dir = Math.abs(vel) > 0.02 ? (vel > 0 ? 1 : -1) : ((m.bestSide === 'SHORT') ? -1 : (m.bestSide === 'LONG') ? 1 : (vel >= 0 ? 1 : -1));
            const barrierPrice = dir > 0 ? hi : lo;
            const dist = Math.abs(barrierPrice - price) / price * 100;                                             // % tot barrière
            const reach = this.P.k1 * Math.abs(vel) + this.P.k2 * Math.sqrt(Math.max(0, this.P.eta * PE * Shock));  // % bereik
            const reachable = dist <= reach;
            // ROBUUSTE ETA (22-08): niet delen door de grillige moment-snelheid (die sprong van
            // 80min → 4u → 2u), maar door de TYPISCHE snelheid = gemiddelde |1-bar %-beweging|
            // over ~20 bars (stabiel, ATR-achtig). Daarna een EWMA per munt zodat de ETA niet
            // frame-tot-frame verspringt en Osiris' beslissingen er niet door heen en weer geslingerd worden.
            let spd = 0, sc = 0; for (let j = Math.max(1, i - 20); j <= i; j++) { spd += Math.abs((c(j) - c(j - 1)) / c(j - 1) * 100); sc++; } spd = (spd / (sc || 1)) || 1e-3;
            const etaBars = dist / Math.max(spd, 1e-3);
            let etaMin = Math.min(this.P.maxEtaMin, etaBars * this.P.barMin);
            this._etaEwma = this._etaEwma || {};
            const _eprev = (this._etaEwma[sym] != null) ? this._etaEwma[sym] : etaMin;
            etaMin = 0.7 * _eprev + 0.3 * etaMin;                     // demping: 70% geheugen
            this._etaEwma[sym] = etaMin;
            // gekalibreerde breakpoint-kans
            const reachMargin = (reach - dist) / Math.max(dist, 1e-3);
            const z = this.P.a0 + this.P.aL * Loading + this.P.aShk * Shock + this.P.aReach * cl01(reachMargin);
            let pBreak = 1 / (1 + Math.exp(-z));
            pBreak = this._calibrate(pBreak);
            return {
                sym, price, ts: Date.now(),
                sigma2: +sigma2.toFixed(5), asynchrony: +sigma2n.toFixed(4), compression: +compression.toFixed(4),
                PE: +PE.toFixed(4), KE: +KE.toFixed(5), KEnorm: +KEnorm.toFixed(4), velocity: +vel.toFixed(4), mass: +mass.toFixed(3),
                Loading: +Loading.toFixed(4), Shock: +Shock.toFixed(4), localStress: +S_local.toFixed(4),
                dir, barrierPrice: +barrierPrice.toFixed(price < 10 ? 4 : 2), distPct: +dist.toFixed(3), reachPct: +reach.toFixed(3),
                reachable, etaMin: +etaMin.toFixed(1), pBreak: +pBreak.toFixed(4)
            };
        } catch (e) { return null; }
    },

    _calibrate(p) {
        try { const b = Math.max(0, Math.min(9, Math.floor(p * 10))); const c = this.calib[b]; if (c && c.n >= 12) { return 0.5 * p + 0.5 * (c.hits / c.n); } } catch (e) {}
        return p;
    },

    update() {
        try {
            const now = Date.now();
            if (now - this._lastUpd < 9000) return; this._lastUpd = now;
            const snap = { ts: now, markets: {}, system: null };
            const shocks = [], loads = [];
            for (const sym of this.SYMS) {
                const r = this._market(sym); if (!r) continue;
                this.state[sym] = r; snap.markets[sym] = r; shocks.push(r.Shock); loads.push(r.Loading);
                this._maybeFire(r, now);
            }
            // systeem: synchronie/besmetting
            if (shocks.length >= 2) {
                const meanShock = shocks.reduce((a, b) => a + b, 0) / shocks.length;
                const disp = this._std(shocks);
                const sync = this._clamp01(meanShock * 2) * (1 - this._clamp01(disp / (meanShock + 0.05)));
                const contagion = meanShock > 0.35 && sync > 0.5 && (loads.reduce((a, b) => a + b, 0) / loads.length) > 0.2;
                snap.system = { meanShock: +meanShock.toFixed(4), shockDispersion: +disp.toFixed(4), sync: +sync.toFixed(4), contagion };
                this.system = snap.system;
            }
            this._resolve(now);
            this.log.unshift(snap); if (this.log.length > 600) this.log.pop();
            if (now % 60000 < 10000) this._save();
        } catch (e) {}
    },

    // vuur een voorspelling af zodra p_break de drempel haalt en er nog geen open voorspelling
    // voor deze munt loopt. Legt alles vast wat nodig is om 'm later te scoren.
    _maybeFire(r, now) {
        try {
            if (r.pBreak < this.P.fireP || !r.reachable) return;
            if (this.predictions.some(p => p.sym === r.sym)) return;   // al een open voorspelling
            this.predictions.push({
                id: r.sym + '-' + now, sym: r.sym, tsFired: now, entryPrice: r.price, dir: r.dir,
                barrierPrice: r.barrierPrice, distPct: r.distPct, etaMin: r.etaMin, deadline: now + r.etaMin * 60000,
                pBreak: r.pBreak, features: { PE: r.PE, KE: r.KE, Loading: r.Loading, Shock: r.Shock, asynchrony: r.asynchrony, compression: r.compression, reachPct: r.reachPct },
                extremeReached: r.price, hit: null
            });
        } catch (e) {}
    },

    // scoor open voorspellingen: barrière in de richting geraakt vóór de deadline = hit
    _resolve(now) {
        try {
            const still = [];
            for (const p of this.predictions) {
                const m = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[p.sym] : null;
                const px = m && m.lastPrice != null ? m.lastPrice : null;
                if (px != null) p.extremeReached = p.dir > 0 ? Math.max(p.extremeReached, px) : Math.min(p.extremeReached, px);
                const hit = px != null && (p.dir > 0 ? px >= p.barrierPrice : px <= p.barrierPrice);
                if (hit) { p.hit = 1; p.resolvedTs = now; p.timeToHitMin = +((now - p.tsFired) / 60000).toFixed(1); this._score(p); this._recordEta(p); this.resolved.unshift(p); }
                else if (now > p.deadline) { p.hit = 0; p.resolvedTs = now; p.timeToHitMin = null; this._score(p); this._recordEta(p); this.resolved.unshift(p); }
                else still.push(p);
            }
            this.predictions = still;
            if (this.resolved.length > 800) this.resolved.length = 800;
        } catch (e) {}
    },
    _score(p) {
        try { const b = Math.max(0, Math.min(9, Math.floor(p.pBreak * 10))); const c = this.calib[b] || { n: 0, hits: 0, pSum: 0 }; c.n++; c.hits += p.hit; c.pSum += p.pBreak; this.calib[b] = c; } catch (e) {}
    },
    // (22-08) ETA-BETROUWBAARHEID -> Governor: telt de ETA als "geraakt binnen het venster" (hit vóór deadline).
    // De Governor leert hieruit autonoom een 'eta'-gewicht [0..1]; predictFor gebruikt dat gewicht om te bepalen
    // hoe ver vooruit een ETA nog mee mag tellen in beslissingen. Zo kalibreert Osiris de ETA zelf, doorlopend.
    _recordEta(p) {
        try { if (typeof OsirisGovernor !== 'undefined' && OsirisGovernor.record) OsirisGovernor.record('eta', (p.pBreak != null ? p.pBreak : 0.5), p.hit); } catch (e) {}
    },

    // samenvattende validatie-metrieken (hit-rate, Brier, kalibratietabel)
    metrics() {
        try {
            const R = this.resolved; const n = R.length;
            if (!n) return { n: 0 };
            const hits = R.reduce((a, p) => a + (p.hit || 0), 0);
            const brier = R.reduce((a, p) => a + (p.pBreak - p.hit) * (p.pBreak - p.hit), 0) / n;
            const calib = Object.keys(this.calib).sort().map(b => { const c = this.calib[b]; return { bin: +b / 10, n: c.n, voorspeld: +(c.pSum / c.n).toFixed(3), werkelijk: +(c.hits / c.n).toFixed(3) }; });
            const byMkt = {}; for (const s of this.SYMS) { const g = R.filter(p => p.sym === s); if (g.length) byMkt[s] = { n: g.length, hitRate: +(g.reduce((a, p) => a + p.hit, 0) / g.length).toFixed(3) }; }
            return { n, hitRate: +(hits / n).toFixed(3), brier: +brier.toFixed(4), perMarkt: byMkt, kalibratie: calib };
        } catch (e) { return { n: 0 }; }
    },

    exportBundle() {
        return {
            exportedAt: new Date().toISOString(), params: this.P,
            huidig: this.state, systeem: this.system || null,
            openVoorspellingen: this.predictions, afgerondeVoorspellingen: this.resolved.slice(0, 400),
            kalibratie: this.calib, metrieken: this.metrics(), log: this.log.slice(0, 400),
            uitleg: 'PE=potentiele energie (asynchronie σ² + compressie); KE=½·massa·snelheid²; Loading=PE·(1-KEnorm); Shock=release-gewogen schok-subindex; Sync=synchronie/besmetting; pBreak=gekalibreerde kans dat de dichtstbijzijnde barrière binnen ETA in de richting van v geraakt wordt.'
        };
    },

    _save() { try { localStorage.setItem('osirisKineticLog', JSON.stringify({ log: this.log.slice(0, 400), predictions: this.predictions, resolved: this.resolved.slice(0, 400), calib: this.calib, norm: this._norm, ts: Date.now() })); } catch (e) {} },
    _restore() { try { const raw = localStorage.getItem('osirisKineticLog'); if (!raw) return; const d = JSON.parse(raw); if (!d) return; this.log = d.log || []; this.predictions = d.predictions || []; this.resolved = d.resolved || []; this.calib = d.calib || {}; this._norm = d.norm || {}; } catch (e) {} }
};
window.OsirisKinetic = OsirisKinetic;
try { OsirisKinetic._restore(); } catch (e) {}
// losse download van de volledige kinetische dataset (voorspellingen + scoring + log)
function downloadKineticData() { try { _downloadJSON(OsirisKinetic.exportBundle(), `osiris_kinetic_${Date.now()}.json`); } catch (e) { try { alert('Kinetic-export mislukt: ' + e.message); } catch (x) {} } }
window.downloadKineticData = downloadKineticData;

// ============================================================
// OSIRIS · META-LAAG (20-08) — autonomer & completer, met zelf-governance
// ------------------------------------------------------------
// Vier additieve, gewrapte subsystemen die de bestaande engines NIET aanpassen:
//   GOVERNOR (D)  - geeft elke nieuwe tool een trust-gewicht [0..1] dat AUTONOOM wordt
//                   bijgesteld op basis van OUT-OF-SAMPLE validatie (hit-rate + Brier).
//                   Zwak presterende tools worden vanzelf afgeschaald, sterke opgeschaald.
//   PREDICT (B)   - per munt een gekalibreerde richting-voorspelling + verwachte beweging,
//                   breakpoint (uit de Kinetic-engine) en ETA. Elke voorspelling wordt later
//                   out-of-sample gescoord -> voedt de Governor. Toont alles in de Neural-net-tab.
//   GUARDIAN (E)  - data-integriteit: detecteert bevroren/stale feeds en prijs-divergentie
//                   tussen engines, en zet dan een veiligheids-halt (geen nieuwe entries).
//   RISK (C)      - portfolio-breed: gecombineerde exposure (spot+margin), drawdown-breaker
//                   en dag-verlieslimiet. Trekt bij overschrijding ook de veiligheids-halt.
// De halt wordt gelezen door een kleine poort in de entry-paden (spot/osiris/margin).
// Alles is downloadbaar (export + downloadMetaData()) en persistent (localStorage).
// ============================================================
const OsirisGovernor = {
    weights: {}, stats: {}, log: [], DEFAULT: 0.5, MINN: 12,
    weight(name) { const w = this.weights[name]; return (w != null) ? w : this.DEFAULT; },
    // registreer één out-of-sample uitkomst: predProb = kans die de tool aan de GEKOZEN
    // richting gaf, hit = of die richting klopte. Herberekent daarna het trust-gewicht.
    record(name, predProb, hit) {
        try {
            const s = this.stats[name] || { n: 0, hits: 0, brier: 0, pSum: 0 };
            const h = hit ? 1 : 0;
            s.n++; s.hits += h; s.brier += (predProb - h) * (predProb - h); s.pSum += predProb;
            this.stats[name] = s; this._recompute(name);
        } catch (e) {}
    },
    _recompute(name) {
        const s = this.stats[name]; if (!s || s.n < this.MINN) { this.weights[name] = this.DEFAULT; return; }
        const acc = s.hits / s.n;                         // out-of-sample hit-rate
        const brier = s.brier / s.n;                      // 0=perfect, 0.25=willekeur
        const skill = Math.max(0, (acc - 0.5) * 2);       // hoe ver boven kans
        const cal = Math.max(0, 1 - brier * 4);           // kalibratie (0.25->0)
        const prev = this.weights[name] != null ? this.weights[name] : this.DEFAULT;
        const w = Math.max(0.05, Math.min(1, 0.5 * skill + 0.5 * cal));
        this.weights[name] = w;
        if (Math.abs(w - prev) >= 0.08) {
            this.log.unshift({ ts: Date.now(), name, w: +w.toFixed(3), acc: +acc.toFixed(3), brier: +brier.toFixed(4), n: s.n });
            if (this.log.length > 60) this.log.pop();
            try { logAdaptation(`Governor stelt '${name}' bij → gewicht ${(w * 100 | 0)}%`, `out-of-sample hit-rate ${(acc * 100 | 0)}% · Brier ${brier.toFixed(3)} over ${s.n} validaties`); } catch (e) {}
        }
    },
    metrics() { const o = {}; for (const k of Object.keys(this.stats)) { const s = this.stats[k]; o[k] = { weight: +this.weight(k).toFixed(3), n: s.n, hitRate: s.n ? +(s.hits / s.n).toFixed(3) : null, brier: s.n ? +(s.brier / s.n).toFixed(4) : null }; } return o; }
};
window.OsirisGovernor = OsirisGovernor;

const OsirisPredict = {
    SYMS: ['BTC', 'ETH', 'SOL'], H_BARS: 8, BAR_MIN: 15, FIRE_MIN: 15,
    state: {}, open: [], resolved: [], _lastFire: {}, _fsoPrev: null,
    _clamp(x, a, b) { return x < a ? a : x > b ? b : x; },
    _closes(sym) { try { const m = neoMultiState.markets[sym]; const K = m && m.klines && m.klines.length > 30 ? m.klines : null; return K ? K.map(d => parseFloat(d[4])) : null; } catch (e) { return null; } },
    _ema(a, p) { const k = 2 / (p + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; },
    _rsi(a, p) { let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { if (i < 1) continue; const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; } const rs = l === 0 ? 100 : g / l; return 100 - 100 / (1 + rs); },
    predictFor(sym) {
        try {
            const cl = this._closes(sym); if (!cl || cl.length < 30) return null;
            const m = neoMultiState.markets[sym]; const price = m.lastPrice || cl[cl.length - 1];
            const emaF = this._ema(cl.slice(-40), 12), emaS = this._ema(cl.slice(-40), 26);
            const crossPct = (emaF - emaS) / emaS * 100;
            const mom = (cl[cl.length - 1] - cl[cl.length - 4]) / cl[cl.length - 4] * 100;
            const rsiTilt = (this._rsi(cl, 14) - 50) / 50;
            // brein-kans meenemen als de sub-brein/DeepNet een richting heeft
            const brainDir = (m.bestSide === 'SHORT') ? -1 : (m.bestSide === 'LONG') ? 1 : 0;
            const brainTilt = brainDir * ((m.bestProb != null ? m.bestProb : 0.5) - 0.5) * 2;
            // FSO-INTEGRATIE (22-08, herzien): de Financial Stress Oscillator is een KANS, geen
            // rem. Stijgende stress + hoge asynchronie (variance) = een naderende fasetransitie
            // (UOTAM): er staat juist iets GROOTS te gebeuren. Dempen/niets doen in CRISIS is een
            // gemiste vooruitzicht-kans. Daarom: in CRISIS/SPANNING de conviction NIET verlagen
            // maar de VERWACHTE BEWEGING opschalen (opportunity), en de richting scherper stellen
            // op basis van waar de druk zich opbouwt (drawdown-lean). fsoOpp voedt de expected move.
            let fsoConf = 1, fsoRegime = null, fsoLevel = null, fsoVar = null, fsoOpp = 0, fsoRising = 0;
            try {
                if (typeof osirisStress !== 'undefined' && osirisStress.ts && (Date.now() - osirisStress.ts < 30 * 60000)) {
                    fsoLevel = osirisStress.level; fsoVar = osirisStress.variance; fsoRegime = osirisStress.regime;
                    const prev = (OsirisPredict._fsoPrev != null ? OsirisPredict._fsoPrev : fsoLevel);
                    fsoRising = fsoLevel - prev;                                                   // stijgende stress = fasetransitie nadert
                    // opportunity 0..1: PER MARKT (kinetische opportunity van díe munt) gecombineerd
                    // met de systeem-brede stress. Zo onderscheidt Osiris welke munt de echte
                    // bliksem-kans biedt i.p.v. één globale waarde voor alle drie.
                    const sysOpp = fsoLevel * 0.7 + fsoVar * 6 + Math.max(0, fsoRising) * 10;
                    const mktOpp = (typeof osirisMarketOpportunity === 'function') ? osirisMarketOpportunity(sym) : 0;
                    fsoOpp = Math.max(0, Math.min(1, mktOpp * 0.7 + sysOpp * 0.45));
                    // conviction: RUST licht versterken; SPANNING/CRISIS NIET dempen, licht opschalen
                    fsoConf = fsoRegime === 'CRISIS' ? 1.18 : fsoRegime === 'SPANNING' ? 1.08 : 1.1;
                }
            } catch (e) {}
            const sig = Math.tanh((crossPct * 0.8 + mom * 0.3 + rsiTilt * 0.5 + brainTilt * 0.6) * fsoConf);
            const rawUp = 1 / (1 + Math.exp(-3 * sig));          // ruwe P(omhoog)
            const dir = sig >= 0 ? 1 : -1;
            const pDir = dir > 0 ? rawUp : 1 - rawUp;            // kans op de gekozen richting (ruw, voor scoring)
            const gw = OsirisGovernor.weight('predict');
            const pShown = 0.5 + (pDir - 0.5) * gw;              // naar 0.5 getrokken als de tool nog niet vertrouwd is
            // breakpoint + verwachte beweging uit de Kinetic-engine (indien beschikbaar)
            let breakpoint = null, etaMin = null, reachPct = null, pBreak = null;
            try { const ks = (typeof OsirisKinetic !== 'undefined') ? OsirisKinetic.state[sym] : null; if (ks) { breakpoint = ks.barrierPrice; etaMin = ks.etaMin; reachPct = ks.reachPct; pBreak = ks.pBreak; } } catch (e) {}
            // VERWACHTE BEWEGING: basis uit de kinetische reach, opgeschaald door de FSO-opportunity
            // (in CRISIS verwacht Osiris dus een GROTERE beweging i.p.v. te dempen).
            let expectedMovePct = reachPct != null ? reachPct : null;
            if (expectedMovePct != null) expectedMovePct = +(expectedMovePct * (1 + 1.2 * fsoOpp)).toFixed(3);
            // (22-08) ETA-ACTIONABLE: de ETA telt ALLEEN mee bij beslissingen als het signaal echt sterk is
            // én de breakpoint dichtbij ligt. Het venster schaalt met de door de Governor geleerde
            // ETA-betrouwbaarheid (etaWeight [0..1]): vertrouwt Osiris de ETA weinig, dan telt alleen een
            // zeer nabije ETA mee; leert hij dat ETA's kloppen, dan mag hij verder vooruit handelen.
            // etaStable dempt bovendien bij sterk wisselende ETA's (de "80min→4u→2u"-sprongen).
            let etaWeight = 0.5, etaStable = 1, etaActionable = false;
            try {
                etaWeight = (typeof OsirisGovernor !== 'undefined') ? OsirisGovernor.weight('eta') : 0.5;
                const ks2 = (typeof OsirisKinetic !== 'undefined') ? OsirisKinetic.state[sym] : null;
                const ew = (ks2 && ks2.etaEwma != null) ? ks2.etaEwma : (OsirisKinetic && OsirisKinetic._etaEwma ? OsirisKinetic._etaEwma[sym] : null);
                if (etaMin != null && ew != null && ew > 0) {
                    const rel = Math.abs(etaMin - ew) / ew;                    // relatieve ETA-afwijking t.o.v. EWMA
                    etaStable = Math.max(0, Math.min(1, 1 - rel));            // 1 = zeer stabiel, 0 = wild wisselend
                }
                const etaWindow = 20 + 40 * etaWeight;                        // minuten; groeit met geleerd vertrouwen
                etaActionable = (pBreak != null && etaMin != null &&
                    pBreak >= 0.60 && fsoOpp >= 0.50 && etaStable >= 0.55 &&
                    etaMin <= etaWindow);
            } catch (e) {}
            return { sym, ts: Date.now(), price, dir, rawUp: +rawUp.toFixed(4), pDir: +pDir.toFixed(4), pShown: +pShown.toFixed(4), sig: +sig.toFixed(4), govWeight: +gw.toFixed(3), breakpoint, etaMin, reachPct, pBreak, expectedMovePct, etaActionable, etaWeight: +etaWeight.toFixed(3), etaStable: +etaStable.toFixed(3), fsoRegime, fsoLevel: fsoLevel != null ? +fsoLevel.toFixed(4) : null, fsoConf: +fsoConf.toFixed(3), fsoOpp: +fsoOpp.toFixed(3), fsoRising: +fsoRising.toFixed(4) };
        } catch (e) { return null; }
    },
    update() {
        try {
            const now = Date.now();
            for (const sym of this.SYMS) {
                const p = this.predictFor(sym); if (!p) continue;
                this.state[sym] = p;
                if (!this._lastFire[sym] || (now - this._lastFire[sym]) >= this.FIRE_MIN * 60000) {
                    this._lastFire[sym] = now;
                    this.open.push({ sym, ts: now, entryPrice: p.price, dir: p.dir, pDir: p.pDir, deadline: now + this.H_BARS * this.BAR_MIN * 60000 });
                    if (this.open.length > 200) this.open.shift();
                }
            }
            this._resolve(now);
            try { if (typeof osirisStress !== 'undefined' && osirisStress.level != null) this._fsoPrev = osirisStress.level; } catch (e) {}
        } catch (e) {}
    },
    _resolve(now) {
        try {
            const still = [];
            for (const o of this.open) {
                if (now < o.deadline) { still.push(o); continue; }
                const m = neoMultiState.markets[o.sym]; const px = m ? m.lastPrice : null;
                if (px == null) { still.push(o); continue; }
                const realizedUp = px >= o.entryPrice;
                const hit = (o.dir > 0) === realizedUp;
                OsirisGovernor.record('predict', o.pDir, hit);   // OUT-OF-SAMPLE -> Governor
                o.hit = hit ? 1 : 0; o.exitPrice = px; o.resolvedTs = now; o.movePct = +((px - o.entryPrice) / o.entryPrice * 100).toFixed(3);
                this.resolved.unshift(o); if (this.resolved.length > 500) this.resolved.pop();
            }
            this.open = still;
        } catch (e) {}
    },
    metrics() { const R = this.resolved, n = R.length; if (!n) return { n: 0 }; const hits = R.reduce((a, p) => a + (p.hit || 0), 0); const brier = R.reduce((a, p) => a + (p.pDir - p.hit) * (p.pDir - p.hit), 0) / n; const bym = {}; for (const s of this.SYMS) { const g = R.filter(p => p.sym === s); if (g.length) bym[s] = { n: g.length, hitRate: +(g.reduce((a, p) => a + p.hit, 0) / g.length).toFixed(3) }; } return { n, hitRate: +(hits / n).toFixed(3), brier: +brier.toFixed(4), perMarkt: bym }; }
};
window.OsirisPredict = OsirisPredict;

const OsirisGuardian = {
    FREEZE_MS: 180000, STALE_MS: 150000, DIVERGE_PCT: 1.5,
    alerts: [], paused: false, _mainRef: null, log: [],
    update() {
        try {
            const now = Date.now(); const a = [];
            // 1) hoofd-feed bevroren? (livePrice onveranderd terwijl multi-BTC wél beweegt)
            const mb = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets.BTC : null;
            if (typeof livePrice !== 'undefined' && livePrice) {
                if (!this._mainRef || this._mainRef.price !== livePrice) { this._mainRef = { price: livePrice, ts: now }; }
                const frozenMs = now - this._mainRef.ts;
                if (frozenMs > this.FREEZE_MS && mb && mb.lastPrice && Math.abs(mb.lastPrice - livePrice) / livePrice > 0.001) {
                    a.push(`hoofd-prijsfeed bevroren (${Math.round(frozenMs / 1000)}s op ${livePrice}, markt staat op ${mb.lastPrice})`);
                }
            }
            // 2) multi-feed stale?
            for (const s of ['BTC', 'ETH', 'SOL']) { const m = neoMultiState && neoMultiState.markets[s]; if (m && m.lastUpdate && (now - m.lastUpdate) > this.STALE_MS) a.push(`${s}-feed stale (${Math.round((now - m.lastUpdate) / 1000)}s geen update)`); }
            // 3) prijs-divergentie tussen hoofd- en multi-engine
            if (typeof livePrice !== 'undefined' && livePrice && mb && mb.lastPrice) { const dv = Math.abs(mb.lastPrice - livePrice) / livePrice * 100; if (dv > this.DIVERGE_PCT) a.push(`prijs-divergentie BTC ${dv.toFixed(2)}% tussen engines (${livePrice} vs ${mb.lastPrice})`); }
            const wasPaused = this.paused;
            this.alerts = a; this.paused = a.length > 0;
            if (this.paused && !wasPaused) { this.log.unshift({ ts: now, alerts: a.slice() }); if (this.log.length > 50) this.log.pop(); try { logAdaptation('⚠ Guardian: data-integriteit', a.join(' · ') + ' — nieuwe entries gepauzeerd'); } catch (e) {} }
            else if (!this.paused && wasPaused) { try { logAdaptation('✓ Guardian: data hersteld', 'feeds weer vers en consistent — handel hervat'); } catch (e) {} }
        } catch (e) {}
    }
};
window.OsirisGuardian = OsirisGuardian;

const OsirisRisk = {
    MAX_DD_PCT: 25, MAX_DAILY_LOSS_PCT: 10, MAX_EXPOSURE_PCT: 180,
    peakEquity: null, dayKey: null, dayStartEquity: null, breaker: false, reasons: [], state: {},
    _combinedEquity() { let e = 0; try { e += (typeof getEquity === 'function') ? getEquity() : 0; } catch (x) {} try { e += (typeof marginEquity === 'function') ? marginEquity() : 0; } catch (x) {} return e; },
    _combinedExposurePct(eq) {
        let exp = 0;
        try { exp += (typeof getAllocatedPct === 'function' ? getAllocatedPct() : 0) * ((typeof getEquity === 'function') ? getEquity() : 0); } catch (x) {}
        try { for (const p of (marginState.positions || [])) exp += (p.notional || 0); } catch (x) {}   // margin notional = geleveraged exposure
        return eq > 0 ? (exp / eq) * 100 : 0;
    },
    update() {
        try {
            const now = new Date(); const dk = now.getUTCFullYear() + '-' + now.getUTCMonth() + '-' + now.getUTCDate();
            const eq = this._combinedEquity(); if (!(eq > 0)) return;
            if (this.peakEquity == null || eq > this.peakEquity) this.peakEquity = eq;
            if (this.dayKey !== dk) { this.dayKey = dk; this.dayStartEquity = eq; }
            const ddPct = this.peakEquity > 0 ? (this.peakEquity - eq) / this.peakEquity * 100 : 0;
            const dayPnlPct = this.dayStartEquity > 0 ? (eq - this.dayStartEquity) / this.dayStartEquity * 100 : 0;
            const expPct = this._combinedExposurePct(eq);
            const reasons = [];
            if (ddPct >= this.MAX_DD_PCT) reasons.push(`drawdown ${ddPct.toFixed(1)}% ≥ ${this.MAX_DD_PCT}%`);
            if (dayPnlPct <= -this.MAX_DAILY_LOSS_PCT) reasons.push(`dagverlies ${dayPnlPct.toFixed(1)}% ≤ -${this.MAX_DAILY_LOSS_PCT}%`);
            const exposureBlock = expPct >= this.MAX_EXPOSURE_PCT;
            if (exposureBlock) reasons.push(`exposure ${expPct.toFixed(0)}% ≥ ${this.MAX_EXPOSURE_PCT}%`);
            const wasBreaker = this.breaker;
            this.breaker = (ddPct >= this.MAX_DD_PCT) || (dayPnlPct <= -this.MAX_DAILY_LOSS_PCT);   // exposure blokkeert entries maar is geen volledige breaker
            this.reasons = reasons;
            this.state = { equity: +eq.toFixed(2), peak: +this.peakEquity.toFixed(2), drawdownPct: +ddPct.toFixed(2), dayPnlPct: +dayPnlPct.toFixed(2), exposurePct: +expPct.toFixed(1), exposureBlock, breaker: this.breaker };
            if (this.breaker && !wasBreaker) { try { logAdaptation('⚠ Risk-breaker actief', reasons.join(' · ') + ' — entries gepauzeerd'); } catch (e) {} }
            else if (!this.breaker && wasBreaker) { try { logAdaptation('✓ Risk-breaker vrijgegeven', 'drawdown/dagverlies terug binnen limieten'); } catch (e) {} }
        } catch (e) {}
    },
    // mag er een nieuwe entry geopend worden? (exposure-blok telt hier mee)
    entriesAllowed() { return !this.breaker && !(this.state && this.state.exposureBlock); }
};
window.OsirisRisk = OsirisRisk;

// PER-MARKT FSO-OPPORTUNITY (22-08): welke munt biedt de échte "bliksem"-kans? De
// kinetische engine berekent per munt PE (opgeslagen veer), Shock (ontsteking), asynchronie
// (σ²) en p(break). Een gespannen veer die begint te ontsteken = een naderende grote beweging
// in JUIST die munt. Deze score stuurt de autonome equity-verdeling (spot-multi én margin).
function osirisMarketOpportunity(sym) {
    try {
        const k = (typeof OsirisKinetic !== 'undefined') ? OsirisKinetic.state[sym] : null;
        if (!k) return 0;
        // (22-08) ETA-PROXIMITEIT: de p(break)-bijdrage telt VOL mee als de breakpoint dichtbij
        // is, en wordt gedempt naarmate de ETA verder weg ligt — zodat Osiris niet handelt op een
        // barrière die pas over uren geraakt wordt ("te ver vooruit"). Het venster schaalt met het
        // door de Governor geleerde ETA-vertrouwen: leert Osiris dat verre ETA's toch kloppen, dan
        // groeit het venster autonoom. PE/Shock/asynchronie (het NÚ-signaal) blijven vol meetellen.
        let etaFactor = 1;
        try {
            const etaW = (typeof OsirisGovernor !== 'undefined') ? OsirisGovernor.weight('eta') : 0.5;
            const win = 30 + 90 * etaW;                                  // minuten; 30..120 al naar gelang vertrouwen
            if (k.etaMin != null && k.etaMin > win) etaFactor = Math.max(0.25, win / k.etaMin);
        } catch (e) {}
        const v = (k.PE || 0) * 0.35 + (k.Shock || 0) * 0.35 + (k.asynchrony || 0) * 0.35 + (k.pBreak || 0) * 0.25 * etaFactor;
        return Math.max(0, Math.min(1, v));
    } catch (e) { return 0; }
}
window.osirisMarketOpportunity = osirisMarketOpportunity;

// ADAPTIEVE PREDICT-POORT: laat de gekalibreerde voorspeller entries mee-sturen, maar met
// een invloed die AUTONOOM meebeweegt met zijn eigen out-of-sample trust (Governor). Zolang
// de voorspeller zich niet bewezen heeft (trust < 55%) blokkeert hij niets. Bewijst hij zich,
// dan blokkeert hij trades die tégen zijn richting ingaan, met een drempel die met de trust
// meestijgt. Zo corrigeert Osiris zichzelf: goede voorspellingen krijgen meer stem, slechte minder.
function osirisPredictGate(sym, side) {
    try {
        if (typeof OsirisPredict === 'undefined' || typeof OsirisGovernor === 'undefined') return { allow: true };
        if (typeof _osirisStallRelax !== 'undefined' && _osirisStallRelax) return { allow: true };   // stall-bescherming: niet blokkeren als er al te lang niks gebeurt
        const p = OsirisPredict.state[sym]; if (!p) return { allow: true };
        const gw = OsirisGovernor.weight('predict');
        if (gw < 0.55) return { allow: true };                          // nog niet vertrouwd -> niet gaten
        const wantDir = side === 'SHORT' ? -1 : 1;
        const pForSide = wantDir > 0 ? p.rawUp : (1 - p.rawUp);         // modelkans voor DEZE richting
        const thresh = 0.5 + (gw - 0.5) * 0.4;                          // trust 55%->0.52 ... 100%->0.70
        if (p.dir !== wantDir && pForSide < thresh) return { allow: false, reason: `predict tegengesteld (${(pForSide * 100 | 0)}% voor ${side} < drempel ${(thresh * 100 | 0)}%, trust ${(gw * 100 | 0)}%)` };
        return { allow: true };
    } catch (e) { return { allow: true }; }
}
window.osirisPredictGate = osirisPredictGate;

// TREND-ALIGNMENT VETO (22-08): blokkeer een entry die tégen een STERKE prijstrend ingaat.
// Dit is de kern-fix voor het gevonden probleem: de core stond hardnekkig SHORT terwijl de
// markt opliep (SOL +2.5%, ETH stijgend), de DeepNet zag LONG maar werd genegeerd -> onnodige
// verliezen + gemiste long. Osiris neemt nu geen counter-trend trade bij een duidelijke trend.
// Alleen actief bij een STERKE, bevestigde trend (raakt chop/zijwaarts niet), en niet tijdens
// een stall-relax (trades mogen niet stilvallen). Extra bevestiging als de DeepNet meebeweegt.
function osirisTrendVeto(sym, side) {
    try {
        if (typeof _osirisStallRelax !== 'undefined' && _osirisStallRelax) return { veto: false };
        const m = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[sym] : null;
        const K = (m && m.klines && m.klines.length > 40) ? m.klines : null; if (!K) return { veto: false };
        const cl = K.map(d => parseFloat(d[4])); const n = cl.length;
        const ema = (p) => { const k = 2 / (p + 1); let e = cl[n - 40]; for (let i = n - 39; i < n; i++) e = cl[i] * k + e * (1 - k); return e; };
        const emaF = ema(12), emaS = ema(26);
        const net = (cl[n - 1] - cl[n - 20]) / cl[n - 20] * 100;      // %-beweging over ~20 bars
        let up = 0; for (let i = n - 20; i < n; i++) if (cl[i] >= cl[i - 1]) up++; const persist = up / 20;
        const strongUp = (emaF > emaS && net >= 1.0) || (emaF > emaS && persist >= 0.62);
        const strongDown = (emaF < emaS && net <= -1.0) || (emaF < emaS && persist <= 0.38);
        let dnNote = '';
        try { const dnp = OsirisDeepNet.last[sym]; if (dnp) { if (strongUp && dnp.side === 'LONG') dnNote = ', DeepNet LONG bevestigt'; if (strongDown && dnp.side === 'SHORT') dnNote = ', DeepNet SHORT bevestigt'; } } catch (e) {}
        if (side === 'SHORT' && strongUp) return { veto: true, reason: `anti-trend: SHORT tegen sterke uptrend (net ${net.toFixed(2)}%${dnNote})` };
        if (side === 'LONG' && strongDown) return { veto: true, reason: `anti-trend: LONG tegen sterke downtrend (net ${net.toFixed(2)}%${dnNote})` };
        return { veto: false };
    } catch (e) { return { veto: false }; }
}
window.osirisTrendVeto = osirisTrendVeto;

// centrale veiligheids-halt: waar (spot/osiris/margin) leest deze vlag vóór een entry.
function osirisSafetyHalt() {
    try { return (OsirisGuardian && OsirisGuardian.paused) || (OsirisRisk && !OsirisRisk.entriesAllowed()); } catch (e) { return false; }
}
window.osirisSafetyHalt = osirisSafetyHalt;
function osirisSafetyReason() {
    try { const r = []; if (OsirisGuardian && OsirisGuardian.paused) r.push('guardian: ' + OsirisGuardian.alerts.join(', ')); if (OsirisRisk && !OsirisRisk.entriesAllowed()) r.push('risk: ' + (OsirisRisk.reasons.join(', ') || 'exposure/drawdown')); return r.join(' | '); } catch (e) { return ''; }
}
window.osirisSafetyReason = osirisSafetyReason;

// AUTONOME TOOL-GOVERNANCE (22-08): Osiris zet de DeepNet-entry-poort en exit-sturing zélf
// aan/uit op basis van de walk-forward-precisie, met een STALL-BESCHERMING zodat trades niet
// nodeloos stilvallen (te lang geen entry -> poorten tijdelijk los). Geen handmatige knopjes meer.
let _osirisStallRelax = false;
const OSIRIS_STALL_MIN = 25;
function _lastAnyEntryTs() {
    let t = 0;
    try { for (const e of (typeof botTradeLog !== 'undefined' ? botTradeLog : [])) if (e.action === 'ENTRY' && e.timestampMs > t) t = e.timestampMs; } catch (e) {}
    try { for (const e of ((marginState && marginState.tradeLog) || [])) if (e.action === 'ENTRY' && e.ts > t) t = e.ts; } catch (e) {}
    return t;
}
function osirisAutoGovernTools() {
    try {
        const dn = (typeof OsirisDeepNet !== 'undefined') ? OsirisDeepNet : null; if (!dn) return;
        let precs = []; for (const k of ['BTC', 'ETH', 'SOL']) { const m = dn.markets[k]; if (m && m.wf && m.wf.n >= 30) precs.push(m.wf.precision || 0); }
        const avgPrec = precs.length ? precs.reduce((a, b) => a + b, 0) / precs.length : null;
        const engineOn = (typeof isBotRunning !== 'undefined' && isBotRunning) || (typeof osirisLiveEnabled !== 'undefined' && osirisLiveEnabled) || (typeof marginEngineEnabled !== 'undefined' && marginEngineEnabled);
        const lastEntry = _lastAnyEntryTs();
        const idleMin = lastEntry ? (Date.now() - lastEntry) / 60000 : Infinity;
        const stall = engineOn && idleMin > OSIRIS_STALL_MIN;
        _osirisStallRelax = stall;
        let wantGate = (avgPrec == null) ? true : (avgPrec >= 0.52);
        if (stall) wantGate = false;                                      // niet nog een poort dicht bij stilstand
        let wantLive = (avgPrec != null && avgPrec >= 0.55);
        if (dn.GATE_ENTRIES !== wantGate) { try { deepNetGate(wantGate); } catch (e) { dn.GATE_ENTRIES = wantGate; } logAdaptation(`DeepNet-poort ${wantGate ? 'AAN' : 'UIT'} (autonoom)`, stall ? `geen entry in ${idleMin | 0}min - poort tijdelijk los zodat trades niet stilvallen` : `walk-forward precisie ${avgPrec != null ? (avgPrec * 100 | 0) + '%' : 'n/a'}`); }
        if (dn.LIVE !== wantLive) { try { deepNetToggle(wantLive); } catch (e) { dn.LIVE = wantLive; } logAdaptation(`DeepNet live exit-sturing ${wantLive ? 'AAN' : 'UIT'} (autonoom)`, `walk-forward precisie ${avgPrec != null ? (avgPrec * 100 | 0) + '%' : 'n/a'} ${wantLive ? 'boven' : 'onder'} 55%`); }
        const el = document.getElementById('deepnet-auto-status');
        if (el) el.innerHTML = `autonoom &middot; poort <b style="color:${dn.GATE_ENTRIES ? '#14f195' : '#7d99ac'}">${dn.GATE_ENTRIES ? 'AAN' : 'UIT'}</b> &middot; live-exits <b style="color:${dn.LIVE ? '#14f195' : '#7d99ac'}">${dn.LIVE ? 'AAN' : 'UIT'}</b> &middot; wf-prec ${avgPrec != null ? (avgPrec * 100 | 0) + '%' : '—'}${stall ? ' &middot; <span style="color:#ffb627;">⏱ stall-relax</span>' : ''}`;
    } catch (e) {}
}
window.osirisAutoGovernTools = osirisAutoGovernTools;

// de tick die alle meta-subsystemen bijwerkt + het paneel hertekent
let _osirisMetaLast = 0, _kinSeenTs = null;
function osirisMetaTick() {
    try {
        const now = Date.now(); if (now - _osirisMetaLast < 9000) return; _osirisMetaLast = now;
        OsirisGuardian.update(); OsirisRisk.update(); OsirisPredict.update();
        // Kinetic-breakpoint uitkomsten óók out-of-sample naar de Governor voeren, zodat de
        // breakpoint-tool net als predict een autonoom trust-gewicht opbouwt.
        try {
            const R = (typeof OsirisKinetic !== 'undefined') ? OsirisKinetic.resolved : null;
            if (R && R.length) {
                if (_kinSeenTs == null) { _kinSeenTs = R[0] ? (R[0].resolvedTs || R[0].tsFired || 0) : 0; }
                for (const p of R) { const ts = p.resolvedTs || p.tsFired || 0; if (ts > _kinSeenTs) { OsirisGovernor.record('kinetic', (p.pBreak != null ? p.pBreak : 0.5), p.hit === 1); } }
                _kinSeenTs = R[0] ? (R[0].resolvedTs || R[0].tsFired || _kinSeenTs) : _kinSeenTs;
            }
        } catch (e) {}
        try { osirisAutoGovernTools(); } catch (e) {}
        try { OsirisSelfReview.tick(); } catch (e) {}
        try { renderOsirisPredictPanel(); } catch (e) {}
        try { renderLiveFeeds(); } catch (e) {}
        try { if (now % 60000 < 10000) _osirisMetaSave(); } catch (e) {}
    } catch (e) {}
}
window.osirisMetaTick = osirisMetaTick;

function _osirisMetaSave() { try { localStorage.setItem('osirisMetaState', JSON.stringify({ gov: { weights: OsirisGovernor.weights, stats: OsirisGovernor.stats, log: OsirisGovernor.log }, predict: { resolved: OsirisPredict.resolved.slice(0, 200), open: OsirisPredict.open }, risk: { peakEquity: OsirisRisk.peakEquity, dayKey: OsirisRisk.dayKey, dayStartEquity: OsirisRisk.dayStartEquity }, ts: Date.now() })); } catch (e) {} }
function _osirisMetaRestore() { try { const r = localStorage.getItem('osirisMetaState'); if (!r) return; const d = JSON.parse(r); if (!d) return; if (d.gov) { OsirisGovernor.weights = d.gov.weights || {}; OsirisGovernor.stats = d.gov.stats || {}; OsirisGovernor.log = d.gov.log || []; } if (d.predict) { OsirisPredict.resolved = d.predict.resolved || []; OsirisPredict.open = d.predict.open || []; } if (d.risk) { OsirisRisk.peakEquity = d.risk.peakEquity != null ? d.risk.peakEquity : null; OsirisRisk.dayKey = d.risk.dayKey || null; OsirisRisk.dayStartEquity = d.risk.dayStartEquity != null ? d.risk.dayStartEquity : null; } } catch (e) {} }
try { _osirisMetaRestore(); } catch (e) {}

// ZELF-REVIEW (22-08): elke 5 gesloten trades weegt Osiris de recente data af en stelt zich
// autonoom bij. De data + redenering wordt opgeslagen (localStorage + export) zodat het
// naleesbaar en beschikbaar is. Cadans loopt mee met het aantal trades (5, 10, 15, ...):
// bij zwakke recente resultaten voorzichtiger (kleinere exposure, strengere drempel), bij
// sterke resultaten agressiever - bounded en omkeerbaar.
const OsirisSelfReview = {
    everyN: 5, lastCount: 0, history: [], aggr: 1.0,
    _closed() { let n = 0; try { n += (typeof botTradeLog !== 'undefined' ? botTradeLog : []).filter(t => t.action === 'EXIT').length; } catch (e) {} try { n += ((marginState && marginState.closed) || []).length; } catch (e) {} return n; },
    tick() { try { const n = this._closed(); if (n >= this.lastCount + this.everyN) { this.lastCount = n; this.run(n); } } catch (e) {} },
    run(n) {
        try {
            const spot = (typeof botTradeLog !== 'undefined' ? botTradeLog : []).filter(t => t.action === 'EXIT').slice(0, 10).map(t => t.pnl);
            const marg = ((marginState && marginState.closed) || []).slice(0, 10).map(t => t.pnl);
            const all = spot.concat(marg).filter(x => typeof x === 'number');
            const wins = all.filter(x => x > 0).length; const wr = all.length ? wins / all.length : null;
            const avg = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
            const changes = [], notes = [];
            if (wr != null && all.length >= 5) {
                if (wr < 0.40) { this.aggr = Math.max(0.5, +(this.aggr - 0.1).toFixed(2)); MARGIN_PER_TRADE_EXPO = Math.max(0.3, +(MARGIN_PER_TRADE_EXPO * 0.9).toFixed(3)); MARGIN_MIN_PROB = Math.min(0.6, +(MARGIN_MIN_PROB + 0.01).toFixed(3)); changes.push(`voorzichtiger: per-trade expo → ${MARGIN_PER_TRADE_EXPO}, margin-minProb → ${MARGIN_MIN_PROB}`); notes.push(`recente winrate ${(wr * 100 | 0)}% te laag`); }
                else if (wr > 0.58) { this.aggr = Math.min(1.5, +(this.aggr + 0.1).toFixed(2)); MARGIN_PER_TRADE_EXPO = Math.min(0.8, +(MARGIN_PER_TRADE_EXPO * 1.08).toFixed(3)); MARGIN_MIN_PROB = Math.max(0.5, +(MARGIN_MIN_PROB - 0.01).toFixed(3)); changes.push(`agressiever: per-trade expo → ${MARGIN_PER_TRADE_EXPO}, margin-minProb → ${MARGIN_MIN_PROB}`); notes.push(`recente winrate ${(wr * 100 | 0)}% sterk`); }
                else notes.push(`winrate ${(wr * 100 | 0)}% neutraal — geen wijziging`);
            } else notes.push('te weinig data voor bijstelling');
            const rec = { ts: Date.now(), atTrades: n, window: all.length, winrate: wr != null ? +wr.toFixed(3) : null, avgPnl: +avg.toFixed(4), aggr: this.aggr, governor: (typeof OsirisGovernor !== 'undefined') ? OsirisGovernor.metrics() : null, predict: (typeof OsirisPredict !== 'undefined') ? OsirisPredict.metrics() : null, marginExpoCap: MARGIN_MAX_EXPOSURE, perTradeExpo: MARGIN_PER_TRADE_EXPO, marginMinProb: MARGIN_MIN_PROB, changes, notes };
            this.history.unshift(rec); if (this.history.length > 200) this.history.pop();
            try { localStorage.setItem('osirisSelfReview', JSON.stringify({ history: this.history.slice(0, 120), lastCount: this.lastCount, aggr: this.aggr })); } catch (e) {}
            try { logAdaptation(`Osiris zelf-review bij ${n} trades`, notes.concat(changes).join(' · ')); } catch (e) {}
        } catch (e) {}
    },
    bundle() { return { everyN: this.everyN, atTradesLast: this.lastCount, aggr: this.aggr, history: this.history.slice(0, 120) }; },
    _restore() { try { const r = localStorage.getItem('osirisSelfReview'); if (!r) return; const d = JSON.parse(r); if (d) { this.history = d.history || []; this.lastCount = d.lastCount || 0; this.aggr = d.aggr || 1.0; } } catch (e) {} }
};
window.OsirisSelfReview = OsirisSelfReview;
try { OsirisSelfReview._restore(); } catch (e) {}

function osirisMetaBundle() {
    return { exportedAt: new Date().toISOString(), governor: { weights: OsirisGovernor.weights, metrics: OsirisGovernor.metrics(), log: OsirisGovernor.log }, predict: { huidig: OsirisPredict.state, metrieken: OsirisPredict.metrics(), open: OsirisPredict.open, afgerond: OsirisPredict.resolved.slice(0, 300) }, selfReview: (typeof OsirisSelfReview !== 'undefined') ? OsirisSelfReview.bundle() : null, opportunity: (typeof osirisState !== 'undefined') ? (osirisState.opportunity || null) : null, guardian: { paused: OsirisGuardian.paused, alerts: OsirisGuardian.alerts, log: OsirisGuardian.log }, risk: OsirisRisk.state, uitleg: 'Governor stelt trust-gewichten autonoom bij op out-of-sample hit-rate + Brier; Predict levert gekalibreerde richting/breakpoint per munt; Guardian bewaakt data-integriteit; Risk bewaakt drawdown/dagverlies/exposure. Halt-vlag pauzeert entries in alle engines.' };
}
window.osirisMetaBundle = osirisMetaBundle;
function downloadMetaData() { try { _downloadJSON(osirisMetaBundle(), `osiris_meta_${Date.now()}.json`); } catch (e) { try { alert('Meta-export mislukt: ' + e.message); } catch (x) {} } }
window.downloadMetaData = downloadMetaData;

// ---- Neural-net-tab: uitgebreid voorspellings-infopaneel ----
function renderOsirisPredictPanel() {
    try {
        const el = document.getElementById('osiris-predict-panel'); if (!el) return;
        const gm = OsirisPredict.metrics(); const gw = OsirisGovernor.weight('predict');
        const dirTxt = (d) => d > 0 ? '<span style="color:#14f195;">▲ LONG</span>' : '<span style="color:#ff8a94;">▼ SHORT</span>';
        const halt = osirisSafetyHalt();
        let rows = OsirisPredict.SYMS.map(s => {
            const p = OsirisPredict.state[s]; if (!p) return `<tr><td style="padding:6px;color:var(--dim);">${s}</td><td colspan="6" style="color:var(--dim);">wacht op data…</td></tr>`;
            const bp = p.breakpoint != null ? (p.price < 10 ? p.breakpoint.toFixed(3) : p.breakpoint.toFixed(2)) : '—';
            const eta = p.etaMin != null ? (p.etaMin < 90 ? p.etaMin.toFixed(0) + 'm' : (p.etaMin / 60).toFixed(1) + 'u') : '—';
            // ETA telt alleen mee bij beslissingen als etaActionable (sterk signaal + nabij + stabiel).
            // Anders is de ETA louter informatief (grijs). Zo handelt Osiris niet te ver vooruit.
            const etaAct = !!p.etaActionable;
            const etaTitle = `ETA-vertrouwen ${p.etaWeight != null ? (p.etaWeight*100).toFixed(0) : '—'}% · stabiliteit ${p.etaStable != null ? (p.etaStable*100).toFixed(0) : '—'}% · ${etaAct ? 'telt mee in beslissing' : 'alleen informatief'}`;
            const etaCell = `<span title="${etaTitle}" style="color:${etaAct ? '#14f195' : 'var(--dim)'}; font-weight:${etaAct ? 'bold' : 'normal'};">${eta}${etaAct ? ' ⚡' : ''}</span>`;
            return `<tr style="border-top:1px solid var(--line);">
                <td style="padding:6px; color:#7fd8ff;">${s}</td>
                <td style="text-align:center;">${dirTxt(p.dir)}</td>
                <td style="text-align:center; font-weight:bold;">${(p.pShown * 100).toFixed(0)}%</td>
                <td style="text-align:center; color:var(--dim);">${(p.rawUp * 100).toFixed(0)}%</td>
                <td style="text-align:center;">${bp}</td>
                <td style="text-align:center;">${etaCell}</td>
                <td style="text-align:center; color:${(p.expectedMovePct || 0) > 1.5 ? '#ffb627' : 'var(--dim)'};">${p.expectedMovePct != null ? '±' + p.expectedMovePct.toFixed(2) + '%' : '—'}</td>
                <td style="text-align:center; color:${(p.pBreak || 0) > 0.5 ? '#ffb627' : 'var(--dim)'};">${p.pBreak != null ? (p.pBreak * 100).toFixed(0) + '%' : '—'}</td>
            </tr>`;
        }).join('');
        const trust = (gm.n || 0) < OsirisGovernor.MINN
            ? `<span style="color:var(--dim);">kalibreert… ${gm.n || 0}/${OsirisGovernor.MINN} out-of-sample</span>`
            : `hit-rate <b style="color:${gm.hitRate >= 0.5 ? '#14f195' : '#ff8a94'};">${(gm.hitRate * 100).toFixed(0)}%</b> · Brier <b>${gm.brier}</b> · n=${gm.n}`;
        // FSO-context (momentum-modulator) uit de eerste beschikbare markt
        let fsoLine = '';
        try { const anyp = OsirisPredict.state.BTC || OsirisPredict.state.ETH || OsirisPredict.state.SOL; if (anyp && anyp.fsoRegime) { const rc = anyp.fsoRegime === 'CRISIS' ? '#ff4f6d' : anyp.fsoRegime === 'SPANNING' ? '#ffb627' : '#14f195'; const opp = anyp.fsoOpp || 0; fsoLine = `<span style="color:var(--dim);">FSO-momentum:</span> <b style="color:${rc};">${anyp.fsoRegime}</b> <span style="color:var(--dim);">stress ${anyp.fsoLevel != null ? anyp.fsoLevel.toFixed(3) : '—'} · signaal ×${anyp.fsoConf} · </span><b style="color:${opp > 0.5 ? '#ffb627' : 'var(--dim)'};">opportunity ${(opp * 100).toFixed(0)}%</b>${opp > 0.55 ? ' <span style="color:#ffb627;">⚡ grote beweging verwacht</span>' : ''}`; } } catch (e) {}
        el.innerHTML =
            `<div style="display:flex; flex-wrap:wrap; gap:14px; align-items:center; font-size:0.62rem; margin-bottom:8px;">
                <span>Governor-trust <b style="color:${gw >= 0.5 ? '#14f195' : '#ffb627'};">${(gw * 100).toFixed(0)}%</b></span>
                <span style="color:var(--dim);">out-of-sample: ${trust}</span>
                <span style="margin-left:auto; color:${halt ? '#ff5f7e' : '#14f195'};">${halt ? '⚠ VEILIGHEIDS-HALT: ' + osirisSafetyReason() : '● systemen gezond'}</span>
            </div>
            ${fsoLine ? `<div style="font-size:0.6rem; margin-bottom:8px;">${fsoLine}</div>` : ''}
            <div style="overflow:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.62rem;">
                <thead><tr style="color:var(--dim);"><th style="text-align:left; padding:6px;">Markt</th><th>Richting</th><th title="Governor-gewogen kans">Kans</th><th title="Ruwe modelkans (voor scoring)">Ruw</th><th>Breakpoint</th><th>ETA</th><th title="Verwachte beweging, opgeschaald door FSO-opportunity">verw. move</th><th title="Kinetic: kans dat breakpoint geraakt wordt">p(break)</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; font-size:0.58rem;">
                <div class="meter"><div class="l">RISK · drawdown</div><div class="v" style="font-size:0.8rem; color:${(OsirisRisk.state.drawdownPct||0) >= OsirisRisk.MAX_DD_PCT ? '#ff5f7e' : '#eafcff'};">${OsirisRisk.state.drawdownPct != null ? OsirisRisk.state.drawdownPct + '%' : '—'}</div></div>
                <div class="meter"><div class="l">RISK · dag P/L</div><div class="v" style="font-size:0.8rem; color:${(OsirisRisk.state.dayPnlPct||0) < 0 ? '#ff8a94' : '#14f195'};">${OsirisRisk.state.dayPnlPct != null ? OsirisRisk.state.dayPnlPct + '%' : '—'}</div></div>
                <div class="meter"><div class="l">RISK · exposure</div><div class="v" style="font-size:0.8rem; color:${OsirisRisk.state.exposureBlock ? '#ff5f7e' : '#eafcff'};">${OsirisRisk.state.exposurePct != null ? OsirisRisk.state.exposurePct + '%' : '—'}</div></div>
            </div>
            ${OsirisGuardian.paused ? `<div style="margin-top:8px; font-size:0.58rem; color:#ff8a94;">⚠ Guardian: ${OsirisGuardian.alerts.join(' · ')}</div>` : ''}`;
    } catch (e) {}
}
window.renderOsirisPredictPanel = renderOsirisPredictPanel;

// OSIRIS · RL EXIT/HOLD-AGENT (16-08) - lokaal, geen backend
// Tabular Q-learning over gediscretiseerde toestand (regime × pnl × momentum ×
// leeftijd). Acties: HOLD · SLUIT · TRAIL · SCHAAL. De zware buffer-replay
// (duizenden episodes) draait in een INLINE Web Worker (blob, geen extra bestand),
// zodat de UI niet bevriest. De geleerde policy adviseert de exit-beslissing
// (veilig: harde stops blijven; RL stuurt alleen de discretionaire hold/oogst).
// ============================================================
const OsirisRL = {
    ACTIONS: ['HOLD', 'SLUIT', 'TRAIL', 'SCHAAL'],
    ACTION_COL: ['#7fd8ff', '#ff5f7e', '#ffb627', '#14f195'],
    Q: {}, episodes: 0, avgReward: 0, statesLearned: 0, actionDist: [0, 0, 0, 0],
    lastDecision: null, history: [], _worker: null, _training: false, lastTrain: 0,
    ENABLED: true, INFLUENCE: true,   // INFLUENCE=of de agent de live exit mag sturen

    RL_VERSION: 2,   // bump wanneer de toestand-codering wijzigt -> oude, verkeerd-geschaalde Q-tabel wordt weggegooid
    // deterministische regime-proxy uit een candle-venster (vol + richtingskracht).
    // 0=compressie 1=kalm 2=trending 3=volatiel — zelfde semantiek als de HMM-mapping,
    // maar IDENTIEK bruikbaar in de training-worker, zodat de regime-as niet langer RUIS is
    // (voorheen: reg = Math.random()*4 tijdens training).
    _regimeFromCloses(cl, i, win) {
        try {
            i = (i == null) ? cl.length - 1 : i;
            let w = Math.min(win || 20, i);
            if (w < 5) return 1;
            let m = 0, k = 0;
            for (let j = i - w + 1; j <= i; j++) { m += Math.log(cl[j] / cl[j - 1]); k++; }
            m /= (k || 1);
            let s = 0; for (let j = i - w + 1; j <= i; j++) { const r = Math.log(cl[j] / cl[j - 1]); s += (r - m) * (r - m); }
            const volPct = Math.sqrt(s / (k || 1)) * 100;
            let up = 0; for (let j = i - w + 1; j <= i; j++) if (cl[j] >= cl[j - 1]) up++;
            const persist = up / (k || 1);
            const netMovePct = Math.abs((cl[i] - cl[i - w]) / cl[i - w]) * 100;
            if (volPct < 0.5 && netMovePct < 0.8) return 0;                       // compressie
            if (netMovePct >= 1.5 || persist > 0.62 || persist < 0.38) return 2;  // trending (beide kanten)
            if (volPct >= 1.4) return 3;                                          // volatiel
            return 1;                                                             // kalm
        } catch (e) { return 1; }
    },
    _regimeIdx() {
        try { const m = { compressie: 0, kalm: 1, trending: 2, volatiel: 3 }; return (typeof OsirisRegimeHMM !== 'undefined' && OsirisRegimeHMM.trained) ? (m[OsirisRegimeHMM.label] != null ? m[OsirisRegimeHMM.label] : 1) : 1; } catch (e) { return 1; }
    },
    _momDirPct(cl, i, side) {
        try { i = (i == null) ? cl.length - 1 : i; if (i < 2) return 0; return side * (cl[i] - cl[i - 2]) / cl[i - 2] * 100; } catch (e) { return 0; }
    },
    // GEDEELDE toestand-codering (BYTE-VOOR-BYTE identiek aan de worker). pnlPct is een FRACTIE
    // (0.008 = 0.8%); momDirPct is een PERCENTAGE in de trade-richting. Cruciaal: exact dezelfde
    // schalen en grenzen in training én live - anders vraag je live toestanden op die in de
    // training nooit gevuld zijn (dat was de kern-bug: worker gebruikte fracties + ruwe dollar-
    // momentum, live gebruikte percenten + vfm -> vrijwel geen enkele sleutel matchte).
    _state(reg, pnlPct, momDirPct, ageMin) {
        const p = pnlPct * 100;
        const pz = p < -0.4 ? 0 : p < 0 ? 1 : p < 0.2 ? 2 : p < 0.5 ? 3 : 4;
        const mz = momDirPct < -0.15 ? 0 : momDirPct < 0.15 ? 1 : 2;
        const az = ageMin < 10 ? 0 : ageMin < 40 ? 1 : 2;
        return `${reg}|${pz}|${mz}|${az}`;
    },
    // live-beslissing (greedy) voor een open positie
    decide(pos, mkt, pnlPct, ageMin) {
        try {
            const side = (pos && pos.side === 'SHORT') ? -1 : 1;
            let reg, mom;
            const cl = (mkt && mkt.klines && mkt.klines.length > 25) ? mkt.klines.map(d => parseFloat(d[4])) : null;
            if (cl) { reg = this._regimeFromCloses(cl, cl.length - 1, 20); mom = this._momDirPct(cl, cl.length - 1, side); }
            else { reg = this._regimeIdx(); mom = side * (mkt ? (mkt.vfm || 0) : 0) * 0.3; }   // fallback: benader %-momentum uit vfm
            const sk = this._state(reg, pnlPct, mom, ageMin);
            const q = this.Q[sk];
            let act = 0, conf = 0;
            if (q) {
                let bi = 0, bv = q[0], mx = -Infinity;
                for (let i = 0; i < 4; i++) { if (q[i] > bv) { bv = q[i]; bi = i; } if (q[i] > mx) mx = q[i]; }
                // softmax-achtige zekerheid
                let z = 0; const e = q.map(v => { const x = Math.exp((v - mx)); z += x; return x; });
                conf = z > 0 ? e[bi] / z : 0.25;
                act = bi;
            }
            this.lastDecision = { state: sk, action: act, q: q ? q.slice() : [0, 0, 0, 0], conf, regime: reg, ts: Date.now() };
            return this.lastDecision;
        } catch (e) { return null; }
    },

    _ensureWorker() {
        if (this._worker) return true;
        try {
            // ECHTE simulator (19-08): OHLC per markt, entries zoals de bot ze neemt (signaal-
            // gated, beide richtingen), intrabar harde stop/target, realistische kosten, en een
            // ECHTE schaal-actie (verhoogt exposure + risico i.p.v. de oude nep 1.5x-close).
            // st() is byte-voor-byte gelijk aan OsirisRL._state (schalen matchen live).
            const code = `
            let Q = {};
            const A = 4, GAMMA = 0.95, ALPHA = 0.12, EXPO_MAX = 2.5;
            function st(reg,pnlFrac,momDirPct,age){var p=pnlFrac*100;var pz=p<-0.4?0:p<0?1:p<0.2?2:p<0.5?3:4;var mz=momDirPct<-0.15?0:momDirPct<0.15?1:2;var az=age<10?0:age<40?1:2;return reg+'|'+pz+'|'+mz+'|'+az;}
            function q(s){ if(!Q[s]) Q[s]=[0,0,0,0]; return Q[s]; }
            function regimeOf(cl,i,w){try{if(i<w+1)w=Math.max(2,i-1);var m=0,k=0,j;for(j=i-w+1;j<=i;j++){m+=Math.log(cl[j]/cl[j-1]);k++;}m/=(k||1);var s=0;for(j=i-w+1;j<=i;j++){var r=Math.log(cl[j]/cl[j-1]);s+=(r-m)*(r-m);}var volPct=Math.sqrt(s/(k||1))*100;var up=0;for(j=i-w+1;j<=i;j++)if(cl[j]>=cl[j-1])up++;var persist=up/(k||1);var net=Math.abs((cl[i]-cl[i-w])/cl[i-w])*100;if(volPct<0.5&&net<0.8)return 0;if(net>=1.5||persist>0.62||persist<0.38)return 2;if(volPct>=1.4)return 3;return 1;}catch(e){return 1;}}
            function ema(arr,p){var kk=2/(p+1);var out=new Array(arr.length);out[0]=arr[0];for(var i=1;i<arr.length;i++)out[i]=arr[i]*kk+out[i-1]*(1-kk);return out;}
            function rsiArr(cl,p){var out=new Array(cl.length);out[0]=50;var g=0,l=0;for(var i=1;i<cl.length;i++){var dd=cl[i]-cl[i-1];var u=dd>0?dd:0,dn=dd<0?-dd:0;if(i<=p){g+=u;l+=dn;out[i]=50;if(i===p){g/=p;l/=p;out[i]=100-100/(1+(l===0?100:g/l));}}else{g=(g*(p-1)+u)/p;l=(l*(p-1)+dn)/p;out[i]=100-100/(1+(l===0?100:g/l));}}return out;}
            onmessage=function(ev){
              var d=ev.data; if(d.Q) Q=d.Q;
              var MK=d.markets||[]; var EP=d.episodes||3000; var eps=d.eps!=null?d.eps:0.15;
              var cost=d.cost!=null?d.cost:0.24; var funding=d.funding||0; var lev=d.lev||1;
              var ENTER=0.22, HORIZON=22, TRAILGIVE=0.003;
              var books=[];
              for(var mi=0;mi<MK.length;mi++){
                var Cm=MK[mi]; var Nm=Cm.c.length; if(Nm<80) continue;
                var emaF=ema(Cm.c,12), emaS=ema(Cm.c,26), rsi=rsiArr(Cm.c,14);
                var rng=0,rk=0; for(var ri=Math.max(1,Nm-200);ri<Nm;ri++){rng+=Math.abs(Cm.c[ri]-Cm.c[ri-1])/Cm.c[ri-1];rk++;} rng=(rk?rng/rk:0.004);
                var STOP=Math.max(0.003,Math.min(0.03,rng*3)); var TARGET=STOP*1.2;
                books.push({c:Cm.c,h:Cm.h,l:Cm.l,N:Nm,emaF:emaF,emaS:emaS,rsi:rsi,STOP:STOP,TARGET:TARGET});
              }
              if(!books.length){postMessage({Q:Q,episodes:0,avgReward:0,states:Object.keys(Q).length,actionDist:[0,0,0,0]});return;}
              function sig(b,i){var cross=(b.emaF[i]-b.emaS[i])/b.emaS[i]*100;var mom=(b.c[i]-b.c[i-3])/b.c[i-3]*100;var rt=(b.rsi[i]-50)/50;return Math.tanh(cross*0.8+mom*0.3+rt*0.5);}
              var totR=0, ep=0; var adist=[0,0,0,0];
              for(var e=0;e<EP;e++){
                var b=books[Math.floor(Math.random()*books.length)]; var N=b.N;
                var i0=-1;
                for(var tr=0;tr<8;tr++){var cand=30+Math.floor(Math.random()*(N-HORIZON-31));if(cand>3&&Math.abs(sig(b,cand))>=ENTER){i0=cand;break;}}
                if(i0<0) continue;
                var s0=sig(b,i0); var side=s0>0?1:-1; var entry=b.c[i0]; var reg=regimeOf(b.c,i0,20);
                var expo=1, trailStop=null, j=i0+1, epR=0, held=true; var lim=Math.min(i0+HORIZON,N);
                while(held && j<lim){
                  var hi=b.h[j], lo=b.l[j], px=b.c[j];
                  var worst=side>0?lo:hi;
                  var pnlWorst=side>0?(worst-entry)/entry:(entry-worst)/entry;
                  if(pnlWorst<=-b.STOP){ var rS=(-b.STOP*100-cost)*expo*lev; var qh=q(st(reg,-b.STOP,0,(j-i0)*15)); qh[0]=qh[0]+ALPHA*(rS-qh[0]); epR+=rS; held=false; break; }
                  var best=side>0?hi:lo;
                  var pnl=side>0?(px-entry)/entry:(entry-px)/entry;
                  var mom=side*(b.c[j]-b.c[j-2])/b.c[j-2]*100;
                  var age=(j-i0)*15; var s=st(reg,pnl,mom,age); var qq=q(s);
                  var a; if(Math.random()<eps){a=Math.floor(Math.random()*A);}else{a=0;var bv=qq[0];for(var k2=1;k2<A;k2++)if(qq[k2]>bv){bv=qq[k2];a=k2;}}
                  adist[a]++;
                  var r=0, done=false;
                  if(a===1){ r=(pnl*100-cost)*expo*lev; done=true; }
                  else if(a===0){ r=-0.01-funding*expo; var pb=side>0?(best-entry)/entry:(entry-best)/entry; if(pb>=b.TARGET){ r=(b.TARGET*100-cost)*expo*lev; done=true; } }
                  else if(a===2){ trailStop=Math.max(trailStop==null?-Infinity:trailStop, pnl-TRAILGIVE); if(pnl<=trailStop){ r=(trailStop*100-cost)*expo*lev; done=true; } else { r=-0.005-funding*expo; } }
                  else { if(expo<EXPO_MAX && pnl>0){ expo=Math.min(EXPO_MAX,expo+0.5); r=-cost*0.5; } else { r=-0.02; } }
                  var jn=j+1, nextS=s;
                  if(!done && jn<lim){ var pn=b.c[jn]; var pnl2=side>0?(pn-entry)/entry:(entry-pn)/entry; var m2=side*(b.c[jn]-b.c[jn-2])/b.c[jn-2]*100; nextS=st(reg,pnl2,m2,(jn-i0)*15); }
                  var qn=q(nextS); var maxn=Math.max(qn[0],qn[1],qn[2],qn[3]);
                  qq[a]=qq[a]+ALPHA*(r+(done?0:GAMMA*maxn)-qq[a]);
                  epR+=r; if(done)held=false; j++;
                }
                if(held){ var pe=b.c[Math.min(i0+HORIZON-1,N-1)]; var pf=side>0?(pe-entry)/entry:(entry-pe)/entry; var qf=q(st(reg,pf,0,HORIZON*15)); var rf=(pf*100-cost)*expo*lev; qf[1]=qf[1]+ALPHA*(rf-qf[1]); epR+=rf; }
                totR+=epR; ep++;
              }
              postMessage({Q:Q,episodes:ep,avgReward:ep?totR/ep:0,states:Object.keys(Q).length,actionDist:adist});
            };`;
            const blob = new Blob([code], { type: 'application/javascript' });
            this._worker = new Worker(URL.createObjectURL(blob));
            this._worker.onmessage = (ev) => this._onDone(ev.data);
            return true;
        } catch (e) { this._worker = null; return false; }
    },
    _onDone(d) {
        try {
            this.Q = d.Q || this.Q;
            this.episodes += (d.episodes || 0);
            this.avgReward = d.avgReward != null ? d.avgReward : this.avgReward;
            this.statesLearned = d.states || Object.keys(this.Q).length;
            if (d.actionDist) for (let i = 0; i < 4; i++) this.actionDist[i] += d.actionDist[i];
            this._training = false;
            this._save();
            try { logAdaptation('RL-agent getraind', `+${d.episodes} episodes (totaal ${this.episodes}) · ${this.statesLearned} states · gem reward ${(this.avgReward).toFixed(3)}`); } catch (e) {}
        } catch (e) { this._training = false; }
    },
    _save() {
        // bewaar de getrainde Q-tabel + stats zodat scenario's behouden blijven bij
        // refresh / herstart / wallet-reset (RL-model is opgebouwde kennis, geen sessie-data).
        try { localStorage.setItem('osirisRLModel', JSON.stringify({ v: this.RL_VERSION, Q: this.Q, episodes: this.episodes, avgReward: this.avgReward, statesLearned: this.statesLearned, actionDist: this.actionDist, ts: Date.now() })); } catch (e) {}
    },
    _restore() {
        try {
            const raw = localStorage.getItem('osirisRLModel');
            if (raw) {
                const d = JSON.parse(raw);
                // Alleen herstellen als de codering-versie matcht. Een Q-tabel uit de oude
                // (verkeerd-geschaalde) codering zou live nooit matchen en de nieuwe training
                // vervuilen - die gooien we weg zodat de agent schoon opnieuw leert.
                if (d && d.Q && d.v === this.RL_VERSION) { this.Q = d.Q; this.episodes = d.episodes || 0; this.avgReward = d.avgReward || 0; this.statesLearned = d.statesLearned || Object.keys(this.Q).length; this.actionDist = d.actionDist || [0, 0, 0, 0]; }
                else if (d && d.v !== this.RL_VERSION) { try { localStorage.removeItem('osirisRLModel'); } catch (e) {} }
            }
        } catch (e) {}
    },
    train() {
        try {
            if (!this.ENABLED || this._training) return;
            if (!this._ensureWorker()) return;
            // ECHTE simulator: OHLC van alle 3 de markten (elk 672×15m), niet alleen 400 BTC-closes.
            const markets = [];
            try {
                for (const sym of (typeof MULTI_SYMBOLS !== 'undefined' ? MULTI_SYMBOLS : ['BTC'])) {
                    const mk = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[sym] : null;
                    const kl = (mk && mk.klines && mk.klines.length > 80) ? mk.klines : null;
                    if (kl) markets.push({ sym, o: kl.map(d => +d[1]), h: kl.map(d => +d[2]), l: kl.map(d => +d[3]), c: kl.map(d => +d[4]) });
                }
            } catch (e) {}
            // fallback: hoofd-BTC rawData als de multi-markten nog niet geladen zijn
            if (!markets.length && typeof rawData !== 'undefined' && rawData && rawData.length > 80) {
                const s = rawData.slice(-672);
                markets.push({ sym: 'BTC', o: s.map(d => +d[1]), h: s.map(d => +d[2]), l: s.map(d => +d[3]), c: s.map(d => +d[4]) });
            }
            if (!markets.length) return;
            const fee = (typeof botSettings !== 'undefined' && botSettings.feePct != null) ? botSettings.feePct : 0.1;
            const slip = (typeof botSettings !== 'undefined' && botSettings.slippagePct != null) ? botSettings.slippagePct : 0.02;
            const cost = (fee + slip) * 2;   // round-trip in %
            this._training = true; this.lastTrain = Date.now();
            this._worker.postMessage({ Q: this.Q, markets, episodes: 3000, eps: 0.15, cost });
        } catch (e) { this._training = false; }
    }
};
window.OsirisRL = OsirisRL;
try { OsirisRL._restore(); } catch (e) {}   // behoud getrainde scenario's over refresh/herstart

let _osirisRLLast = 0;
function osirisRLTick() {
    try {
        const now = Date.now();
        if (now - _osirisRLLast < 3 * 60000) return;   // hertrain elke 3 min in de worker
        _osirisRLLast = now;
        OsirisRL.train();
    } catch (e) {}
}
window.osirisRLTick = osirisRLTick;

// ============================================================
// OSIRIS · MARGIN ENGINE (17-08) - Binance Futures-testnet (USDⓈ-M)
// Aparte, toggle-bare execution-engine NAAST spot. Handelt exact dezelfde 3 markten
// (BTC/ETH/SOL) met dezelfde brein-signalen (neoMultiState/osirisReview), maar via
// futures met leverage (3x standaard, Osiris mag 3<->5 autonoom bijstellen). Echte
// short is hier wel mogelijk (geen inventory nodig). Eigen wallet-state + feeds,
// zodat spot 100% onaangeroerd blijft. Alles gewrapt: kan de spot-engine nooit breken.
// !! De futures-execution vereist aparte futures-testnet-keys en moet live geverifieerd
//    worden - dit draaide niet in de buildomgeving. Standaard staat de engine UIT.
// ============================================================
const MARGIN_BASE = 'https://testnet.binancefuture.com';
let marginEngineEnabled = false;
let marginLeverage = 3;                 // Osiris stelt dit autonoom bij tussen MIN..MAX
const MARGIN_LEV_MIN = 3, MARGIN_LEV_MAX = 5;
// KALIBRATIE (19-08): margin is leveraged -> strengere entry, strakker target, FSO-pauze.
// AANPASSING (19-08, op verzoek): margin moet VAKER traden dan spot. De oude drempel
// (0.58) lag BOVEN spot's live minProbabilityPct (0.55) en de FSO-pauze sloeg al dicht
// zodra de MESO-schaal in SPANNING zat met variance > 0.02 - in de praktijk zat de
// variance daar zo goed als altijd boven (geobserveerd 0.043-0.058), dus margin stond
// vrijwel continu stil terwijl spot gewoon doorhandelde. Let op: dit vergroot het
// leverage-risico (3-5x) bewust - zie de toelichting in het rapport.
let MARGIN_MAX_EXPOSURE = 1.5;              // (22-08) max totale NOTIONAL-exposure = 1.5× equity (i.p.v. 266%); schaalt autonoom terug bij drawdown
let MARGIN_PER_TRADE_EXPO = 0.6;            // max notional per losse trade = 0.6× equity
let MARGIN_MIN_PROB = 0.50;                 // was 0.58 - nu ONDER spot's drempel i.p.v. erboven
let MARGIN_TARGET_MULT = 0.75;              // dichter target (winst vaker vastklikken -> sneller weer vrij voor een nieuwe trade)
let MARGIN_FSO_PAUSE = true;                // blijft aan, maar triggert nu alleen nog bij ECHTE CRISIS (zie marginTick)
let marginState = {
    equity: 1000, startEquity: 1000, realizedPnL: 0, wins: 0, losses: 0,
    positions: [], tradeLog: [], closed: [], reasoning: [], adaptation: [],
    startTime: Date.now(), lastAction: null, _levSet: {}
};
window.marginState = marginState;
function marginSave() {
    try { localStorage.setItem('osirisMarginState', JSON.stringify({
        equity: marginState.equity, startEquity: marginState.startEquity, realizedPnL: marginState.realizedPnL,
        wins: marginState.wins, losses: marginState.losses, positions: marginState.positions,
        closed: marginState.closed.slice(0, 100), tradeLog: marginState.tradeLog.slice(0, 200),
        reasoning: marginState.reasoning.slice(0, 40), adaptation: marginState.adaptation.slice(0, 40),
        startTime: marginState.startTime, lastAction: marginState.lastAction, _levSet: marginState._levSet, ts: Date.now()
    })); } catch (e) {}
}
function marginRestore() {
    try {
        const r = localStorage.getItem('osirisMarginState'); if (!r) return;
        const d = JSON.parse(r); if (!d) return;
        Object.assign(marginState, {
            equity: d.equity != null ? d.equity : 1000, startEquity: d.startEquity != null ? d.startEquity : 1000,
            realizedPnL: d.realizedPnL || 0, wins: d.wins || 0, losses: d.losses || 0,
            positions: d.positions || [], closed: d.closed || [], tradeLog: d.tradeLog || [],
            reasoning: d.reasoning || [], adaptation: d.adaptation || [], startTime: d.startTime || Date.now(), lastAction: d.lastAction || null, _levSet: d._levSet || {}
        });
    } catch (e) {}
}
window.marginSave = marginSave; window.marginRestore = marginRestore;
window.marginEngineEnabled = marginEngineEnabled;

function marginKeys() { try { const r = localStorage.getItem('osirisFuturesKeys'); return r ? JSON.parse(r) : { apiKey: '', secret: '' }; } catch (e) { return { apiKey: '', secret: '' }; } }
function saveMarginKeys() {
    const apiKey = (document.getElementById('futures-api-key')?.value || '').trim();
    const secret = (document.getElementById('futures-api-secret')?.value || '').trim();
    if (!apiKey || !secret) { try { document.getElementById('futures-key-status').textContent = 'Vul zowel key als secret in.'; } catch (e) {} return; }
    localStorage.setItem('osirisFuturesKeys', JSON.stringify({ apiKey, secret }));
    try { document.getElementById('futures-key-status').textContent = 'Futures-keys opgeslagen.'; } catch (e) {}
}
window.saveMarginKeys = saveMarginKeys;

// Gesigneerde REST-call tegen de futures-testnet (HMAC-SHA256, hergebruikt hmacSha256Hex).
// --- Futures WebSocket-API (ws-fapi/v1): geen CORS, net als de spot-WS ---
const MARGIN_WS_URL = 'wss://testnet.binancefuture.com/ws-fapi/v1';
let _mws = null, _mwsConnecting = null, _mwsId = 0, _mwsKeepalive = null;
const _mwsPending = new Map();
// WS-toestand voor de UI/export (connected / connecting / disconnected + tellers).
function _mwsSetState(s, err) { try { marginState.wsState = s; if (err) marginState.wsLastError = err; if (s === 'connected') marginState.wsConnectedAt = Date.now(); } catch (e) {} }
// verbind (of hergebruik) de futures-WS. Met een harde connect-timeout zodat _mwsConnecting
// nooit eeuwig blijft hangen als 'open' nooit komt (dat blokkeerde anders alle latere calls).
function ensureMarginWs() {
    if (_mws && _mws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (_mwsConnecting) return _mwsConnecting;
    _mwsSetState('connecting');
    _mwsConnecting = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, err) => { if (settled) return; settled = true; _mwsConnecting = null; if (ok) resolve(); else reject(err); };
        let sock; try { sock = new WebSocket(MARGIN_WS_URL); } catch (e) { _mwsSetState('disconnected', e.message); finish(false, e); return; }
        const to = setTimeout(() => { if (!settled) { try { sock.close(); } catch (e) {} _mwsSetState('disconnected', 'connect-timeout'); finish(false, new Error('WS connect-timeout (8s)')); } }, 8000);
        sock.onopen = () => { clearTimeout(to); _mws = sock; _mwsSetState('connected'); finish(true); };
        sock.onmessage = (ev) => {
            let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
            const pend = msg.id != null ? _mwsPending.get(msg.id) : null; if (!pend) return;
            _mwsPending.delete(msg.id);
            if (msg.status === 200) pend.resolve(msg.result);
            else pend.reject(new Error(`Futures ${msg.status}: ${msg.error && msg.error.msg || 'onbekende fout'} (code ${msg.error && msg.error.code || '?'})`));
        };
        sock.onerror = () => { try { logNetworkError('futures-WS', 'verbinding met testnet.binancefuture.com mislukt'); } catch (e) {} clearTimeout(to); _mwsSetState('disconnected', 'verbinding mislukt'); finish(false, new Error('WebSocket-verbinding met testnet.binancefuture.com mislukt')); };
        sock.onclose = () => { clearTimeout(to); try { if (typeof navigator !== 'undefined' && !navigator.onLine) logNetworkError('futures-WS', 'WS gesloten terwijl offline'); } catch (e) {} if (_mws === sock) _mws = null; _mwsConnecting = null; _mwsSetState('disconnected', 'gesloten'); for (const [, pp] of _mwsPending) pp.reject(new Error('Futures-WS gesloten')); _mwsPending.clear(); finish(false, new Error('Futures-WS gesloten tijdens verbinden')); };
    });
    return _mwsConnecting;
}
// AUTO-RECONNECT: bij een verbindingsfout (val weg / gesloten / timeout) forceren we een
// nieuwe socket en proberen we de call opnieuw, met oplopende backoff. Echte API-fouten
// (bv. -2019 onvoldoende marge) worden NIET herhaald - die gooien meteen door.
async function marginWsRequest(method, params, signed) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await ensureMarginWs();
            const k = marginKeys();
            const p = {}; for (const [kk, vv] of Object.entries(params || {})) p[kk] = String(vv);
            if (signed) {
                if (!k.apiKey || !k.secret) throw new Error('geen futures-keys');
                p.apiKey = k.apiKey; p.timestamp = String(Date.now()); p.recvWindow = '10000';
                const payload = Object.keys(p).sort().map(x => `${x}=${p[x]}`).join('&');
                p.signature = await hmacSha256Hex(k.secret, payload);
            }
            const id = `osiris-m-${_mwsId++}`;
            return await new Promise((resolve, reject) => {
                _mwsPending.set(id, { resolve, reject });
                setTimeout(() => { if (_mwsPending.has(id)) { _mwsPending.delete(id); reject(new Error(`timeout (15s) op ${method}`)); } }, 15000);
                try { _mws.send(JSON.stringify({ id, method, params: p })); } catch (e) { _mwsPending.delete(id); reject(e); }
            });
        } catch (e) {
            lastErr = e; const msg = String((e && e.message) || e || '');
            const connIssue = /gesloten|mislukt|timeout|connect|offline|geen futures-keys/i.test(msg) && !/geen futures-keys/i.test(msg);
            if (connIssue && attempt < 2) {
                try { if (_mws) _mws.close(); } catch (x) {} _mws = null; _mwsConnecting = null;
                try { marginState.wsReconnects = (marginState.wsReconnects || 0) + 1; } catch (x) {}
                await new Promise(r => setTimeout(r, [400, 1500][attempt] || 1500));   // backoff
                continue;
            }
            throw e;
        }
    }
    throw lastErr;
}
// KEEPALIVE: check elke 30s of de socket nog leeft; is-ie dicht en zijn er keys + een
// draaiende engine (of open posities), dan meteen opnieuw verbinden - zodat een korte
// netwerkonderbreking automatisch herstelt zonder dat je iets hoeft te doen.
function startMarginWsKeepalive() {
    if (_mwsKeepalive) return;
    _mwsKeepalive = setInterval(() => {
        try {
            if (!marginKeys().apiKey) return;
            if (!marginEngineEnabled && (!marginState.positions || marginState.positions.length === 0)) return;
            if (!_mws || _mws.readyState !== WebSocket.OPEN) { ensureMarginWs().catch(() => {}); }
        } catch (e) {}
    }, 30000);
}
window.startMarginWsKeepalive = startMarginWsKeepalive;
try { window.addEventListener('DOMContentLoaded', () => setTimeout(startMarginWsKeepalive, 4000)); } catch (e) {}
// Leverage wijzigen kan alleen via REST (CORS-geblokkeerd vanuit de browser). Stel de
// leverage per munt in de futures-testnet-UI in; Osiris gebruikt zijn interne leverage-
// getal voor sizing/P&L. Deze functie is daarom een no-op-registratie.
async function marginSetLeverage(symbol, lev) { marginState._levSet[symbol] = lev; }
// Futures-precisie per munt (quantityPrecision). -1111 "Precision over maximum" ontstaat
// door te veel decimalen. We halen de echte waarden via WS exchangeInfo (met fallback).
const MARGIN_PREC_FALLBACK = { BTCUSDT: 3, ETHUSDT: 2, SOLUSDT: 0, BNBUSDT: 2, XRPUSDT: 1, DOGEUSDT: 0 };
let _marginPrec = {};
async function marginLoadPrec() {
    try {
        const info = await marginWsRequest('exchangeInfo', {}, false);
        for (const sm of (info.symbols || [])) { if (sm.quantityPrecision != null) _marginPrec[sm.symbol] = sm.quantityPrecision; }
    } catch (e) { /* WS exchangeInfo niet beschikbaar -> fallback wordt gebruikt */ }
}
function marginRoundQty(symbol, qty) {
    const prec = (_marginPrec[symbol] != null) ? _marginPrec[symbol] : (MARGIN_PREC_FALLBACK[symbol] != null ? MARGIN_PREC_FALLBACK[symbol] : 3);
    const f = Math.pow(10, prec);
    return Math.floor(qty * f) / f;   // altijd naar beneden -> nooit te veel decimalen
}

async function marginOrder(symbol, side, qty) {
    // newOrderRespType RESULT -> de respons draagt de ECHTE fill (avgPrice/executedQty/cumQuote),
    // zodat we posities en P/L op de werkelijke futures-testnet-fill baseren i.p.v. op de lokale prijs.
    return marginWsRequest('order.place', { symbol, side, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' }, true);
}
// parse een futures order.place-RESULT naar een echte fill.
//   executed = de exchange HEEFT de order uitgevoerd (status FILLED/PARTIALLY of executedQty>0)
//   filled   = executed EN we hebben een bruikbare avgPrice
// Cruciaal: op de testnet is avgPrice bij een FILLED order soms 0. We mogen zo'n order dan
// NIET eindeloos 'niet bevestigd - retry' geven (dat was de bug: posities bleven eeuwig open
// en schoten voorbij hun stop). executed==true telt als afgehandeld; ontbreekt avgPrice, dan
// valt de aanroeper terug op de lokale prijs voor de boekhouding.
function _marginFill(r) {
    try {
        if (!r) return null;
        const status = r.status || null;
        const executedQty = parseFloat(r.executedQty != null ? r.executedQty : (r.origQty || 0)) || 0;
        let avg = parseFloat(r.avgPrice || 0) || 0;
        const cumQuote = parseFloat(r.cumQuote != null ? r.cumQuote : 0) || 0;
        if (!avg && cumQuote && executedQty) avg = cumQuote / executedQty;
        const executed = (status === 'FILLED' || status === 'PARTIALLY_FILLED') || executedQty > 0;
        return { filled: executed && avg > 0, executed, status, executedQty, avgPrice: avg, cumQuote: cumQuote || (avg * executedQty) };
    } catch (e) { return null; }
}
async function marginAccount() { return marginWsRequest('account.status', {}, true); }
async function marginPositionRisk() { return marginWsRequest('account.position', {}, true); }

// haal het ECHTE futures-testnet-saldo op en zet marginState.equity daarop (exchange = waarheid).
async function marginSyncEquityFromExchange() {
    try {
        if (!marginKeys().apiKey) return false;
        const acc = await marginAccount();
        let bal = null;
        if (acc && Array.isArray(acc.assets)) { const u = acc.assets.find(a => a.asset === 'USDT'); if (u) bal = parseFloat(u.walletBalance != null ? u.walletBalance : (u.marginBalance || 0)); }
        if (bal == null && acc && acc.totalWalletBalance != null) bal = parseFloat(acc.totalWalletBalance);
        if (bal != null && isFinite(bal) && bal > 0) {
            // FIX (20-08): meet P/L t.o.v. het ECHTE startsaldo van het futures-account (dat
            // begint doorgaans op ~15000 USDT, niet op de lokale 1000). Zonder deze baseline
            // toonde P/L = saldo - 1000 een onzin-winst. exchangeStart wordt één keer vastgelegd.
            if (marginState.exchangeStart == null) { marginState.exchangeStart = bal; }
            marginState.walletBalance = bal; marginState.equity = bal; marginState.equitySource = 'exchange'; marginState.equitySyncedAt = Date.now();
            marginState.realizedPnL = bal - marginState.exchangeStart;   // gerealiseerd = echt saldoverschil
            try { marginSave(); } catch (e) {}
            return true;
        }
    } catch (e) { /* stil - WS kan even weg zijn */ }
    return false;
}
window.marginSyncEquityFromExchange = marginSyncEquityFromExchange;

function _marginLog(kind, txt) {
    try {
        const arr = kind === 'adaptation' ? marginState.adaptation : marginState.reasoning;
        arr.unshift({ ts: Date.now(), txt }); if (arr.length > 40) arr.pop();
        try { marginSave(); } catch (e) {}
    } catch (e) {}
}
window.marginAdapt = (t) => _marginLog('adaptation', t);

// Autonome leverage: Osiris verhoogt bij een sterk, kalm regime + goede winrate, verlaagt
// bij volatiliteit of verliezen. Blijft binnen 3..5.
function marginAutoLeverage() {
    try {
        if (!marginEngineEnabled) return;
        const ex = marginState.closed.slice(-10);
        const wr = ex.length >= 5 ? ex.filter(t => (t.pnl || 0) > 0).length / ex.length : null;
        const reg = (typeof OsirisRegimeHMM !== 'undefined' && OsirisRegimeHMM.trained) ? OsirisRegimeHMM.label : null;
        const stressed = (typeof osirisStress !== 'undefined' && osirisStress.ts && (Date.now() - osirisStress.ts < 30 * 60000) && (osirisStress.regime === 'CRISIS' || osirisStress.variance > 0.02));
        let nv = marginLeverage;
        if ((wr != null && wr < 0.4) || reg === 'volatiel' || stressed) nv = MARGIN_LEV_MIN;
        else if (wr != null && wr >= 0.6 && (reg === 'trending' || reg === 'kalm') && (typeof osirisStress === 'undefined' || osirisStress.regime === 'RUST')) nv = MARGIN_LEV_MAX;
        if (nv !== marginLeverage) { marginLeverage = nv; marginState._levSet = {}; _marginLog('adaptation', `Osiris zet leverage -> ${nv}x (${reg || 'regime ?'}${wr != null ? `, winrate ${(wr * 100 | 0)}%` : ''}${stressed ? ', FSO-stress' : ''})`); }
    } catch (e) {}
}
window.marginAutoLeverage = marginAutoLeverage;

// --- Wallet-helpers (gespiegeld van spot, maar op marginState) ---
function marginEquity() { let eq = marginState.equity; for (const p of marginState.positions) eq += (p.uPnl || 0); return eq; }
function marginAllocatedPct() { let a = 0; for (const p of marginState.positions) a += (p.sizePct || 0); return a; }

// Entry: gebruikt DEZELFDE osiris-picks (neoMultiState bestSide/bestProb) maar opent een
// futures-positie met leverage. Long en short beide mogelijk.
let _marginLastEntry = {};
// FIX (19-08, alloc-race): marginTick doet echte netwerk-calls (await marginOrder, ...)
// vóórdat de positie in marginState.positions.push()'t. Zonder deze vlag kan de volgende
// setInterval-tick (elke 10s, zie multiRoundRobinTick) een NIEUWE marginTick() starten
// terwijl de vorige nog op een fill wacht - dan telt marginAllocatedPct() de net geplaatste
// (nog niet gepushte) order niet mee en kan er dubbel worden toegewezen. Zelfde klasse bug
// als de 150%-overallocatie die op de spot-kant is gevonden.
let _marginTickBusy = false;
async function marginTick() {
    if (_marginTickBusy) return;
    _marginTickBusy = true;
    try {
        if (!marginEngineEnabled && marginState.positions.length === 0) return;   // niets te beheren
        const now = Date.now();
        if (now - _marginReconcileLast > 60000) { _marginReconcileLast = now; try { marginReconcile(); } catch (e) {} }   // exchange = bron van waarheid
        // ENTRIES alleen als de engine AAN staat; EXITS draaien altijd (geen orphan-posities)
        // VEILIGHEIDS-HALT (meta-laag): geen nieuwe margin-entries bij data/risk-alarm.
        const _metaHalt = (typeof osirisSafetyHalt === 'function') && osirisSafetyHalt();
        if (_metaHalt) { marginState.lastAction = 'entries gepauzeerd (veiligheids-halt: ' + (typeof osirisSafetyReason === 'function' ? osirisSafetyReason() : 'guard/risk') + ')'; }
        if (marginEngineEnabled && !_metaHalt) {
            const _tuneP = (typeof osirisTune !== 'undefined' && osirisTune.minProb) ? osirisTune.minProb : 0.55;
            const MINP = Math.max(MARGIN_MIN_PROB, _tuneP);   // margin nooit onder zijn eigen drempel
            // FSO-PAUZE (19-08, versoepeld op verzoek): alleen nog een harde stop bij ECHTE
            // CRISIS. De oude SPANNING+variance>0.02-clausule sloot margin bijna permanent af
            // (variance zat doorgaans al boven 0.02 in SPANNING) - spot heeft sowieso geen
            // vergelijkbare harde stop, dus dit hield margin structureel achter op spot.
            const _fsoStop = MARGIN_FSO_PAUSE && (typeof osirisStress !== 'undefined') && osirisStress.ts && (Date.now() - osirisStress.ts < 30 * 60000) && (osirisStress.regime === 'CRISIS');
            if (_fsoStop) { marginState.lastAction = `entries gepauzeerd (FSO ${osirisStress.regime})`; }
            for (const sym of (_fsoStop ? [] : (typeof MULTI_SYMBOLS !== 'undefined' ? MULTI_SYMBOLS : ['BTC', 'ETH', 'SOL']))) {
            const m = neoMultiState.markets[sym]; if (!m || m.bestProb == null || !m.bestSide) continue;
            const binSym = MULTI_BINANCE[sym];
            if (marginState.positions.some(p => p.symbol === binSym)) continue;                 // al open
            if (_marginLastEntry[sym] && (now - _marginLastEntry[sym]) < 30000) continue;        // cooldown verkort 60s -> 30s (vaker traden dan spot)
            if (m.bestProb < MINP) continue;
            // adaptieve predict-poort: blokkeert tegengestelde trades zodra de voorspeller vertrouwd is
            try { if (typeof osirisPredictGate === 'function') { const _g = osirisPredictGate(sym, m.bestSide); if (!_g.allow) { marginState.lastAction = `${sym} overgeslagen: ${_g.reason}`; continue; } } } catch (e) {}
            // trend-alignment veto: geen counter-trend margin-entry bij een sterke trend
            try { if (typeof osirisTrendVeto === 'function') { const _tv = osirisTrendVeto(sym, m.bestSide); if (_tv.veto) { marginState.lastAction = `${sym} overgeslagen: ${_tv.reason}`; continue; } } } catch (e) {}
            // FIX (20-08, runaway-P/L): size op de GEREALISEERDE equity (marginState.equity).
            const sizingBase = (marginState.equity != null && marginState.equity > 0) ? marginState.equity : marginEquity();
            // FIX (22-08, alloc-bug): begrens de totale NOTIONAL-EXPOSURE, niet de marge-fractie.
            // Voorheen: 3 posities × 0.35 marge × 3x leverage = 266% notional t.o.v. de wallet
            // (veel te veel hefboom). Nu cappen we de som van de notional op MARGIN_MAX_EXPOSURE×
            // equity, en dat schaalt AUTONOOM terug bij drawdown (risk-adaptief).
            const _dd = (typeof OsirisRisk !== 'undefined' && OsirisRisk.state && OsirisRisk.state.drawdownPct) ? OsirisRisk.state.drawdownPct : 0;
            const effMaxExpo = MARGIN_MAX_EXPOSURE * Math.max(0.3, 1 - _dd / 50);                 // 25% drawdown -> halveert
            let curNotionalPct = 0; for (const _p of marginState.positions) curNotionalPct += (_p.notional || 0); curNotionalPct = sizingBase > 0 ? curNotionalPct / sizingBase : 0;
            const availExpo = Math.max(0, effMaxExpo - curNotionalPct);                            // resterende notional-ruimte (× equity)
            // FSO-OPPORTUNITY-TILT: meer notional naar de munt met de echte bliksem-kans.
            const _opp = (typeof osirisMarketOpportunity === 'function') ? osirisMarketOpportunity(sym) : 0;
            const perCap = MARGIN_PER_TRADE_EXPO * (0.6 + 0.9 * _opp);                             // 0.6×..1.5× de basis afhankelijk van opportunity
            const perTradeExpo = Math.min(perCap, availExpo);                                      // per trade max notional (× equity)
            const sizePct = perTradeExpo / marginLeverage;                                         // bijhorende marge-fractie
            if (sizePct < 0.03) { marginState.lastAction = `exposure-cap bereikt (${(curNotionalPct * 100 | 0)}% / ${(effMaxExpo * 100 | 0)}% notional)`; continue; }
            const marginUSD = sizingBase * sizePct;
            const notional = marginUSD * marginLeverage;                                          // leverage!
            const price = m.lastPrice; let qty = marginRoundQty(binSym, notional / price);
            if (!(qty > 0)) { _marginLog('reasoning', `${sym}: hoeveelheid te klein (${(notional / price).toFixed(4)}) na afronding - overslaan`); continue; }
            _marginLastEntry[sym] = now;
            await marginSetLeverage(binSym, marginLeverage);
            const side = m.bestSide === 'SHORT' ? 'SELL' : 'BUY';
            const keyed = !!marginKeys().apiKey;   // echte futures-modus alleen met keys
            let entryPrice = price, filledQty = qty, entryFilled = false;
            try {
                const r = await marginOrder(binSym, side, qty);
                const fill = _marginFill(r);
                if (keyed) {
                    // ECHTE futures-modus: positie aanmaken zodra de exchange de order UITVOERT.
                    // (avgPrice mag op de testnet 0 zijn -> val terug op de lokale prijs.)
                    if (!fill || !fill.executed) { _marginLog('reasoning', `${sym} ${m.bestSide} order NIET uitgevoerd door exchange (${fill ? (fill.status || 'geen fill') : 'geen respons'}) - overslaan`); continue; }
                    entryPrice = fill.avgPrice > 0 ? fill.avgPrice : price; filledQty = fill.executedQty > 0 ? fill.executedQty : qty; entryFilled = true;
                } else if (fill && fill.filled) { entryPrice = fill.avgPrice; filledQty = fill.executedQty; entryFilled = true; }
                else if (r && r.avgPrice) { entryPrice = parseFloat(r.avgPrice) || price; }
            }
            catch (e) { _marginLog('reasoning', `${sym} ${m.bestSide} order mislukt: ${e.message}`); continue; }
            qty = filledQty;                                        // ECHTE gevulde hoeveelheid
            const notionalReal = entryPrice * qty;                  // notional op de echte fill
            const marginReal = notionalReal / marginLeverage;
            const preset = (typeof MARKET_PRESETS !== 'undefined' && MARKET_PRESETS[sym]) ? MARKET_PRESETS[sym] : { stopLossPct: 0.5, microTargetPct: 0.4 };
            const pos = { symbol: binSym, sym, side: m.bestSide, entryPrice, entryFillPrice: entryPrice, entryFilled, qty, notional: notionalReal, marginUSD: marginReal, sizePct, leverage: marginLeverage, openTime: now, uPnl: 0, mfe: 0, mae: 0, stopPct: (preset.stopLossPct || 0.5) / 100, targetPct: (preset.microTargetPct || 0.4) / 100 * MARGIN_TARGET_MULT, entryProb: (m.bestProb * 100), regimeAtEntry: ((typeof OsirisRegimeHMM !== 'undefined' && OsirisRegimeHMM.trained) ? OsirisRegimeHMM.label : null),
                factorsAtEntry: (() => { try { return { vfm: m.vfm || 0, rsi: (m.rsi != null ? (m.rsi - 50) / 10 : 0), ema: (m.ema != null && m.emaSlow) ? ((m.ema - m.emaSlow) / m.emaSlow * 100) : 0, nn: 0, fundamentals: (m.fund && m.fund.fundingRate != null ? -Math.tanh(m.fund.fundingRate * 2000) * 3 : 0), chaos: m.chaos || 0 }; } catch (e) { return null; } })() };
            marginState.positions.push(pos);
            marginState.tradeLog.unshift({ action: 'ENTRY', ts: now, sym, side: m.bestSide, price: entryPrice, notional: notionalReal, leverage: marginLeverage, filled: entryFilled });
            marginState.lastAction = `ENTRY ${sym} ${m.bestSide} ${marginLeverage}x @ ${entryPrice}${entryFilled ? ' [fill]' : ' [sim]'}`;
            _marginLog('reasoning', `opent ${sym} ${m.bestSide} ${marginLeverage}x (kans ${(m.bestProb * 100 | 0)}%, $${marginReal.toFixed(0)} margin${entryFilled ? ', echte fill @ ' + entryPrice : ', sim'})`);
            if (entryFilled && keyed) { try { await marginSyncEquityFromExchange(); } catch (e) {} }
        }
        }   // einde entries-gate
        // exits (mirror spot: stop/target/time-stop op de leveraged pnl) - draaien ALTIJD
        for (const pos of [...marginState.positions]) {
            const m = neoMultiState.markets[pos.sym]; if (!m) continue;
            const price = m.lastPrice;
            const raw = pos.side === 'SHORT' ? (pos.entryPrice - price) / pos.entryPrice : (price - pos.entryPrice) / pos.entryPrice;
            const lev = raw * pos.leverage;                         // leveraged rendement op de margin
            pos.uPnl = pos.marginUSD * lev;
            pos.mfe = Math.max(pos.mfe, lev); pos.mae = Math.min(pos.mae, lev);
            const ageMin = (now - pos.openTime) / 60000;
            // RL/HMM-sturing: de agent stuurt de discretionaire exit (harde stop/target blijven).
            let rlClose = false, rlHold = false;
            try { if (typeof OsirisRL !== 'undefined' && OsirisRL.episodes > 2000) { const dec = OsirisRL.decide(pos, m, lev, ageMin); if (dec && dec.conf > 0.4) { if (dec.action === 1) rlClose = true; else if (dec.action === 0 || dec.action === 2) rlHold = true; } } } catch (e) {}
            let reason = null;
            if (raw <= -pos.stopPct) reason = 'STOP_LOSS';                         // harde stop blijft altijd
            else if (raw >= pos.targetPct && !rlHold) reason = 'TARGET';           // RL mag de winnaar laten lopen
            else if (rlClose && lev > 0.0005) reason = 'RL_EXIT';                  // RL zegt sluiten (in winst)
            else if (ageMin > (botSettings.maxPositionAgeMinutes || 90) && Math.abs(lev) < 0.02 && !rlHold) {
                // sterk aanhoudend signaal dezelfde kant? geef de trade meer tijd (max 1x) i.p.v.
                // sluiten+heropenen. Anders: sneller oogsten (breekt de TIME_STOP-churn).
                const _sm = neoMultiState.markets[pos.sym];
                if (_sm && _sm.bestSide === pos.side && (_sm.bestProb || 0) >= 0.66 && (pos._mTsExt || 0) < 1) { pos._mTsExt = 1; pos.openTime += (botSettings.maxPositionAgeMinutes || 90) * 0.5 * 60000; _marginLog('reasoning', `${pos.sym}: sterk signaal (${((_sm.bestProb||0)*100|0)}%) - time-stop uitgesteld i.p.v. sluiten`); }
                else reason = 'TIME_STOP';
            }
            if (reason) { await marginClose(pos, price, lev, reason); }
        }
    } catch (e) {
    } finally { _marginTickBusy = false; }
}
async function marginClose(pos, price, lev, reason) {
    try {
        const closeSide = pos.side === 'SHORT' ? 'BUY' : 'SELL';
        const keyed = !!marginKeys().apiKey;
        let exitFill = null;
        try { const r = await marginOrder(pos.symbol, closeSide, pos.qty); exitFill = _marginFill(r); }
        catch (e) { _marginLog('reasoning', `sluiten ${pos.sym} mislukt: ${e.message}`); }
        // ECHTE futures-modus: alleen behouden+retry als de exchange de order NIET uitvoerde.
        // Is de order wél uitgevoerd (FILLED, ook als avgPrice 0), dan sluiten we af - anders
        // bleef de positie eeuwig 'niet bevestigd - retry' hangen en schoot ze voorbij haar stop.
        if (keyed && !(exitFill && exitFill.executed)) {
            _marginLog('reasoning', `${pos.sym}: close NIET uitgevoerd door exchange (${exitFill ? (exitFill.status || 'geen fill') : 'geen respons'}) - positie behouden, retry`);
            return;
        }
        let exitPrice = price, pnlUSD, exitFilled = false;
        if (exitFill && exitFill.executed) {
            exitFilled = true;
            exitPrice = exitFill.avgPrice > 0 ? exitFill.avgPrice : price;               // fallback naar lokale prijs als avgPrice ontbreekt
            const sign = pos.side === 'SHORT' ? -1 : 1;
            const entryPx = (pos.entryFillPrice != null ? pos.entryFillPrice : pos.entryPrice);
            const qtyClosed = exitFill.executedQty > 0 ? exitFill.executedQty : pos.qty;
            pnlUSD = (exitPrice - entryPx) * qtyClosed * sign;                            // ECHT gerealiseerd uit de fills
        } else {
            pnlUSD = pos.marginUSD * lev;                                                 // sim-fallback (geen keys)
        }
        const realizedLevPct = (pos.marginUSD > 0) ? (pnlUSD / pos.marginUSD) : lev;      // geleveraged rendement op de margin
        marginState.equity += pnlUSD; marginState.realizedPnL += pnlUSD;
        if (pnlUSD > 0) marginState.wins++; else marginState.losses++;
        marginState.positions = marginState.positions.filter(p => p !== pos);
        lev = realizedLevPct;   // vanaf hier: het ECHTE geleveraged rendement gebruiken voor log/leren
        const rawPnl = lev / (pos.leverage || 1);   // unleveraged rendement (vergelijkbaar met spot)
        try {
            if (typeof learningLog !== 'undefined' && learningLog) {
                learningLog.push({
                    timestampMs: Date.now(), side: pos.side, market: pos.sym,
                    factors: (pos.factorsAtEntry || null),
                    outcome: rawPnl > 0 ? 'win' : 'loss', pnlPct: rawPnl,
                    exitReason: reason, holdMinutes: +(((Date.now() - (pos.openTime || 0)) / 60000).toFixed(1)),
                    entryProbabilityPct: (pos.entryProb != null ? pos.entryProb : null),
                    manual: reason === 'MANUAL', botWouldEnter: null,
                    configVersion: (typeof currentConfigVersion === 'function' ? currentConfigVersion() : null),
                    entryHourUTC: new Date(pos.openTime || Date.now()).getUTCHours(),
                    isOsiris: true, isMargin: true, leverage: pos.leverage, regime: (pos.regimeAtEntry || null),
                    mfePct: pos.mfe != null ? +(pos.mfe * 100).toFixed(3) : null, maePct: pos.mae != null ? +(pos.mae * 100).toFixed(3) : null
                });
                if (learningLog.length > 5000) learningLog.shift();
                try { localStorage.setItem('osirisLearningLog', JSON.stringify(learningLog)); } catch (e) {}
                try { if (typeof recalibrateAdaptiveWeights === 'function') recalibrateAdaptiveWeights(); } catch (e) {}
            }
        } catch (e) {}
        const rec = { ts: Date.now(), sym: pos.sym, side: pos.side, price: exitPrice, entryPrice: (pos.entryFillPrice != null ? pos.entryFillPrice : pos.entryPrice), qty: pos.qty, pnl: lev, pnlUSD, reason, leverage: pos.leverage, filled: exitFilled, mfe: pos.mfe, mae: pos.mae };
        marginState.closed.unshift(rec); if (marginState.closed.length > 100) marginState.closed.pop();
        marginState.tradeLog.unshift({ action: 'EXIT', ts: Date.now(), sym: pos.sym, side: pos.side, price: exitPrice, pnl: lev, pnlUSD, reason, filled: exitFilled });
        marginState.lastAction = `EXIT ${pos.sym} ${reason} ${(lev * 100).toFixed(2)}%${exitFilled ? ' [fill]' : ' [sim]'}`;
        try { marginSave(); } catch (e) {}
        _marginLog('reasoning', `sluit ${pos.sym} · ${reason} · ${(lev * 100).toFixed(2)}% ($${pnlUSD.toFixed(2)})${exitFilled ? ' [echte fill @ ' + exitPrice + ']' : ' [sim]'}`);
        if (exitFilled && keyed) { try { await marginSyncEquityFromExchange(); } catch (e) {} }   // equity opnieuw uit exchange (waarheid)
    } catch (e) {}
}
window.marginTick = marginTick;
// RECONCILE: haal de ECHTE open futures-posities van de exchange en maak marginState
// daaraan gelijk (exchange = bron van waarheid). Voegt ontbrekende posities toe, werkt
// entry/qty/leverage bij, en verwijdert lokale posities die niet meer op de exchange staan.
let _marginReconcileLast = 0;
async function marginReconcile() {
    try {
        if (!marginKeys().apiKey) return;
        const res = await marginPositionRisk();
        const arr = Array.isArray(res) ? res : (res && res.positions ? res.positions : []);
        const live = {};
        for (const pr of arr) {
            const amt = parseFloat(pr.positionAmt != null ? pr.positionAmt : (pr.positionAmount || 0));
            if (!amt) continue;
            const symbol = pr.symbol;
            const sym = (typeof MULTI_BINANCE !== 'undefined') ? Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === symbol) : null;
            if (!sym) continue;
            live[symbol] = true;
            const side = amt > 0 ? 'LONG' : 'SHORT';
            const mkt = neoMultiState.markets[sym];
            const entryPrice = parseFloat(pr.entryPrice || 0) || (mkt ? mkt.lastPrice : 0);
            const lev = parseInt(pr.leverage, 10) || marginLeverage;
            const qty = Math.abs(amt); const notional = qty * entryPrice;
            const uPnlEx = parseFloat(pr.unRealizedProfit != null ? pr.unRealizedProfit : (pr.unrealizedProfit != null ? pr.unrealizedProfit : NaN));
            const ex = marginState.positions.find(p => p.symbol === symbol);
            if (ex) { ex.entryPrice = entryPrice; ex.entryFillPrice = entryPrice; ex.entryFilled = true; ex.qty = qty; ex.notional = notional; ex.side = side; ex.leverage = lev; if (ex.marginUSD == null) ex.marginUSD = notional / lev; if (isFinite(uPnlEx)) ex.uPnl = uPnlEx; }
            else {
                const preset = (typeof MARKET_PRESETS !== 'undefined' && MARKET_PRESETS[sym]) ? MARKET_PRESETS[sym] : { stopLossPct: 0.5, microTargetPct: 0.4 };
                const marginUSD = notional / lev;
                marginState.positions.push({ symbol, sym, side, entryPrice, qty, notional, marginUSD, sizePct: marginUSD / Math.max(1, marginEquity()), leverage: lev, openTime: Date.now(), uPnl: 0, mfe: 0, mae: 0, stopPct: (preset.stopLossPct || 0.5) / 100, targetPct: (preset.microTargetPct || 0.4) / 100, _reconciled: true });
                _marginLog('reasoning', `reconcile: ${sym} ${side} ${lev}x van exchange overgenomen (${qty} @ ${entryPrice})`);
            }
        }
        const before = marginState.positions.length;
        marginState.positions = marginState.positions.filter(p => live[p.symbol]);
        const removed = before - marginState.positions.length;
        if (removed > 0) _marginLog('reasoning', `reconcile: ${removed} lokale positie(s) verwijderd (niet meer op de exchange)`);
        try { await marginSyncEquityFromExchange(); } catch (e) {}   // equity = echt futures-saldo
        try { marginSave(); } catch (e) {}
        try { syncMarginWallet(); } catch (e) {}
    } catch (e) { _marginLog('reasoning', `reconcile mislukt: ${e.message}`); }
}
window.marginReconcile = marginReconcile;

async function marginCloseManual(idx) {
    try {
        const pos = marginState.positions[idx]; if (!pos) return;
        const m = neoMultiState.markets[pos.sym]; const price = m ? m.lastPrice : pos.entryPrice;
        const raw = pos.side === 'SHORT' ? (pos.entryPrice - price) / pos.entryPrice : (price - pos.entryPrice) / pos.entryPrice;
        await marginClose(pos, price, raw * pos.leverage, 'MANUAL');
        try { syncMarginWallet(); } catch (e) {}
    } catch (e) {}
}
window.marginCloseManual = marginCloseManual;

// RESET margin-wallet (spiegel van resetWallet voor spot). Wist equity/P&L/telling/logs en
// zet de starttijd opnieuw. Laat de learningLog met opzet staan (kalibratie-/leerhistorie).
// Een optioneel invoerveld 'margin-start-equity' bepaalt het startkapitaal (default 1000).
function resetMarginWallet() {
    try {
        if (marginEngineEnabled && marginState.positions.length) {
            if (!confirm('De margin-engine staat AAN met ' + marginState.positions.length + ' open positie(s). Reset wist de lokale wallet-boekhouding (niet je futures-testnet-saldo). Doorgaan?')) return;
        } else if (!confirm('Weet je zeker dat je de margin-wallet wilt resetten? Alle lokale margin-posities, gesloten trades en logs worden gewist.')) return;
    } catch (e) { return; }
    const inp = (typeof document !== 'undefined') ? document.getElementById('margin-start-equity') : null;
    let start = inp ? parseFloat(inp.value) : NaN; if (!(start > 0)) start = 1000;
    marginState = {
        equity: start, startEquity: start, realizedPnL: 0, wins: 0, losses: 0,
        positions: [], tradeLog: [], closed: [], reasoning: [], adaptation: [],
        startTime: Date.now(), lastAction: null, _levSet: {}
    };
    window.marginState = marginState;
    try { localStorage.removeItem('osirisMarginState'); } catch (e) {}
    _marginLog('adaptation', `Margin-wallet gereset naar ₮${start.toFixed(2)}`);
    try { marginSave(); } catch (e) {}
    try { syncMarginWallet(); } catch (e) {}
    // ook direct de kern-metrics verversen
    try { const set = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; }; set('m-pnl', '₮0.00'); set('m-equity', `₮${start.toFixed(2)}`); set('m-winrate', '—'); set('m-open', '0'); } catch (e) {}
}
window.resetMarginWallet = resetMarginWallet;

function setMarginEngine(on) {
    marginEngineEnabled = !!on; window.marginEngineEnabled = marginEngineEnabled;
    if (on) { try { startMarginWsKeepalive(); } catch (e) {} try { ensureMarginWs().catch(() => {}); } catch (e) {} try { marginLoadPrec(); } catch (e) {} try { marginReconcile(); } catch (e) {} }
    try { localStorage.setItem('osirisMarginEnabled', on ? '1' : '0'); } catch (e) {}
    _marginLog('adaptation', on ? 'Margin-engine AAN (futures-testnet)' : 'Margin-engine UIT');
}
window.setMarginEngine = setMarginEngine;

async function marginTestConnection() {
    const st = document.getElementById('futures-key-status');
    const set = (t, err) => { if (st) { st.textContent = t; st.style.color = err ? '#ff8a94' : '#14f195'; } };
    set('Verbinden met testnet.binancefuture.com\u2026');
    try {
        const acc = await marginAccount();
        const u = (acc.assets || []).find(a => a.asset === 'USDT');
        const bal = u ? parseFloat(u.walletBalance || u.marginBalance || 0) : parseFloat(acc.totalWalletBalance || 0);
        set(`Verbonden. Futures-saldo: ${bal.toFixed(2)} USDT. Klaar voor margin-modus.`);
        try { marginLoadPrec(); } catch (e) {}
        try { marginReconcile(); } catch (e) {}
        return true;
    } catch (e) { set(`Verbinding mislukt: ${e.message} - check je futures-keys en netwerk.`, true); return false; }
}
window.marginTestConnection = marginTestConnection;

async function marginSyncWallet() {
    const st = document.getElementById('futures-key-status');
    const set = (t, err) => { if (st) { st.textContent = t; st.style.color = err ? '#ff8a94' : '#7d99ac'; } };
    try {
        set('Futures-saldo ophalen\u2026');
        const acc = await marginAccount();
        const u = (acc.assets || []).find(a => a.asset === 'USDT');
        const bal = u ? parseFloat(u.availableBalance || u.walletBalance || 0) : parseFloat(acc.availableBalance || acc.totalWalletBalance || 0);
        if (!(bal > 0)) { set('Geen vrij USDT-saldo op de futures-testnet.', true); return; }
        const balFloor = Math.floor(bal * 100) / 100;   // NOOIT naar boven afronden (anders > saldo)
        const input = prompt(`Vrij futures-saldo: ${bal.toFixed(2)} USDT.\n\nHoeveel mag de margin-engine als startkapitaal gebruiken?`, balFloor.toFixed(2));
        if (input === null) { set('Sync geannuleerd.'); return; }
        // komma-decimaal en spaties toestaan (NL-toetsenbord), en nooit meer dan het saldo
        let cap = parseFloat(String(input).replace(/\s/g, '').replace(',', '.'));
        if (isNaN(cap) || cap <= 0) { set('Ongeldig bedrag - sync geannuleerd.', true); return; }
        if (cap > bal) cap = balFloor;   // klem op het vrije saldo i.p.v. annuleren
        marginState.equity = cap; marginState.startEquity = cap; marginState.exchangeStart = null; marginState.equitySource = 'sim'; marginState.realizedPnL = 0; marginState.wins = 0; marginState.losses = 0;
        marginState.positions = []; marginState.closed = []; marginState.tradeLog = []; marginState.startTime = Date.now();
        set(`Margin-startkapitaal: ${cap.toFixed(2)} van ${bal.toFixed(2)} USDT.`);
        try { syncMarginWallet(); } catch (e) {}
    } catch (e) { set(`Sync mislukt: ${e.message}`, true); }
}
window.marginSyncWallet = marginSyncWallet;
try { marginRestore(); } catch (e) {}
try { marginEngineEnabled = localStorage.getItem('osirisMarginEnabled') === '1'; window.marginEngineEnabled = marginEngineEnabled; } catch (e) {}
try { if (marginEngineEnabled) { const rt = marginState.startTime ? Math.round((Date.now() - marginState.startTime) / 60000) : 0; marginState.reasoning.unshift({ ts: Date.now(), txt: `Margin-engine HERVAT na refresh/deploy (was al aan) - ${marginState.positions.length} positie(s), runtime ~${rt}min behouden` }); } } catch (e) {}
try { const lv = parseInt(localStorage.getItem('osirisMarginLeverage'), 10); if (lv >= MARGIN_LEV_MIN && lv <= MARGIN_LEV_MAX) marginLeverage = lv; } catch (e) {}
try { window.addEventListener('DOMContentLoaded', () => { try { const k = marginKeys(); if (k.apiKey) { const a = document.getElementById('futures-api-key'); if (a) a.value = k.apiKey; } if (k.secret) { const b = document.getElementById('futures-api-secret'); if (b) b.value = k.secret; } const tg = document.getElementById('m-toggle'); if (tg) { tg.textContent = marginEngineEnabled ? 'MARGIN AAN' : 'MARGIN UIT'; tg.style.color = marginEngineEnabled ? '#14f195' : '#7d99ac'; } } catch (e) {} }); } catch (e) {}

// OSIRIS · HMM REGIME-DETECTIE + SHADOW-BACKTEST TUNER (14-08)
// Twee zelf-lerende, volledig client-side modules die Osiris autonoom bijstellen
// en in de feeds loggen. Alles is gewrapt in try/catch en raakt de trading pas als
// het signaal stabiel/zeker is - het kan de werkende bot nooit breken.
// ============================================================
const OsirisRegimeHMM = {
    K: 4, D: 3,
    means: null, vars: null, trans: null, startP: null,
    trained: false, current: -1, label: 'kalibreert…', prob: 0, stable: 0,
    lastTrain: 0, _mu: null, _sd: null, order: null,

    _features(buf) {
        const F = [];
        for (let i = 1; i < buf.length; i++) {
            const c0 = parseFloat(buf[i - 1][4]), c1 = parseFloat(buf[i][4]);
            const o = parseFloat(buf[i][1]), h = parseFloat(buf[i][2]), l = parseFloat(buf[i][3]), c = parseFloat(buf[i][4]);
            const ret = c0 > 0 ? (c1 - c0) / c0 * 100 : 0;
            const rng = h - l, body = Math.abs(c - o);
            F.push([ret, Math.abs(ret), rng > 0 ? body / rng : 0]);
        }
        return F;
    },
    _standardize(F) {
        const D = this.D, n = F.length, mu = new Array(D).fill(0), sd = new Array(D).fill(0);
        for (const f of F) for (let d = 0; d < D; d++) mu[d] += f[d];
        for (let d = 0; d < D; d++) mu[d] /= n;
        for (const f of F) for (let d = 0; d < D; d++) sd[d] += (f[d] - mu[d]) ** 2;
        for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d] / n) || 1;
        this._mu = mu; this._sd = sd;
        return F.map(f => f.map((v, d) => (v - mu[d]) / sd[d]));
    },
    _gauss(x, mean, varr) {
        let lp = 0;
        for (let d = 0; d < this.D; d++) { const v = Math.max(varr[d], 1e-3); lp += -0.5 * (Math.log(6.2831853 * v) + (x[d] - mean[d]) ** 2 / v); }
        return lp;
    },
    _init(F) {
        const K = this.K, D = this.D, n = F.length;
        this.means = []; this.vars = [];
        for (let k = 0; k < K; k++) {
            const seed = F[Math.floor((k + 0.5) / K * n)] || F[0];
            this.means.push(seed.slice());
            this.vars.push(new Array(D).fill(1));
        }
        this.trans = Array.from({ length: K }, () => new Array(K).fill(1 / K));
        this.startP = new Array(K).fill(1 / K);
    },
    _logsumexp(arr) { let m = -Infinity; for (const v of arr) if (v > m) m = v; if (m === -Infinity) return -Infinity; let s = 0; for (const v of arr) s += Math.exp(v - m); return m + Math.log(s); },

    train(buf, iters) {
        try {
            if (!buf || buf.length < 80) return false;
            const src = buf.slice(-320);            // laatste ~320 candles voor snelheid
            let F = this._standardize(this._features(src));
            const T = F.length, K = this.K, D = this.D;
            if (T < 40) return false;
            if (!this.trained || !this.means) this._init(F);
            iters = iters || 8;
            for (let it = 0; it < iters; it++) {
                const B = new Array(T);
                for (let t = 0; t < T; t++) { const row = new Array(K); for (let k = 0; k < K; k++) row[k] = this._gauss(F[t], this.means[k], this.vars[k]); B[t] = row; }
                const logA = this.trans.map(r => r.map(x => Math.log(x + 1e-12)));
                const logPi = this.startP.map(x => Math.log(x + 1e-12));
                const alpha = new Array(T); alpha[0] = logPi.map((lp, k) => lp + B[0][k]);
                for (let t = 1; t < T; t++) { const row = new Array(K); for (let k = 0; k < K; k++) { const terms = new Array(K); for (let j = 0; j < K; j++) terms[j] = alpha[t - 1][j] + logA[j][k]; row[k] = this._logsumexp(terms) + B[t][k]; } alpha[t] = row; }
                const beta = new Array(T); beta[T - 1] = new Array(K).fill(0);
                for (let t = T - 2; t >= 0; t--) { const row = new Array(K); for (let k = 0; k < K; k++) { const terms = new Array(K); for (let j = 0; j < K; j++) terms[j] = logA[k][j] + B[t + 1][j] + beta[t + 1][j]; row[k] = this._logsumexp(terms); } beta[t] = row; }
                // gamma
                const gamma = new Array(T);
                for (let t = 0; t < T; t++) { const g = new Array(K); let norm = this._logsumexp(alpha[t].map((a, k) => a + beta[t][k])); for (let k = 0; k < K; k++) g[k] = Math.exp(alpha[t][k] + beta[t][k] - norm); gamma[t] = g; }
                // M-step: means, vars
                for (let k = 0; k < K; k++) {
                    let gsum = 0; const mnew = new Array(D).fill(0);
                    for (let t = 0; t < T; t++) { gsum += gamma[t][k]; for (let d = 0; d < D; d++) mnew[d] += gamma[t][k] * F[t][d]; }
                    gsum = gsum || 1e-6; for (let d = 0; d < D; d++) mnew[d] /= gsum;
                    const vnew = new Array(D).fill(0);
                    for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) vnew[d] += gamma[t][k] * (F[t][d] - mnew[d]) ** 2;
                    for (let d = 0; d < D; d++) vnew[d] = Math.max(vnew[d] / gsum, 1e-3);
                    this.means[k] = mnew; this.vars[k] = vnew;
                }
                // M-step: transitions
                const Anew = Array.from({ length: K }, () => new Array(K).fill(1e-6));
                for (let t = 0; t < T - 1; t++) {
                    const denom = [];
                    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) denom.push(alpha[t][i] + logA[i][j] + B[t + 1][j] + beta[t + 1][j]);
                    const z = this._logsumexp(denom);
                    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) Anew[i][j] += Math.exp(alpha[t][i] + logA[i][j] + B[t + 1][j] + beta[t + 1][j] - z);
                }
                for (let i = 0; i < K; i++) { let r = 0; for (let j = 0; j < K; j++) r += Anew[i][j]; for (let j = 0; j < K; j++) Anew[i][j] /= (r || 1); }
                this.trans = Anew;
                this.startP = gamma[0].slice();
            }
            this.trained = true;
            // Viterbi voor de huidige state (laatste candle)
            const st = this._viterbi(F);
            const now = st[st.length - 1];
            // label-mapping: rangschik states op volatiliteit (mean |ret|) en richting (bodyRatio)
            this._relabel();
            const newLabel = this.order[now] || 'kalm';
            this.stable = (newLabel === this.label) ? this.stable + 1 : 1;
            this.label = newLabel;
            this.current = now;
            // zekerheid = gamma van de laatste candle voor deze state
            this.prob = 0;
            try { const bl = new Array(K); for (let k = 0; k < K; k++) bl[k] = this._gauss(F[T - 1], this.means[k], this.vars[k]); const z = this._logsumexp(bl); this.prob = Math.exp(bl[now] - z); } catch (e) { }
            return true;
        } catch (e) { return false; }
    },
    _viterbi(F) {
        const T = F.length, K = this.K;
        const logA = this.trans.map(r => r.map(x => Math.log(x + 1e-12)));
        const logPi = this.startP.map(x => Math.log(x + 1e-12));
        const delta = new Array(T), psi = new Array(T);
        delta[0] = logPi.map((lp, k) => lp + this._gauss(F[0], this.means[k], this.vars[k])); psi[0] = new Array(K).fill(0);
        for (let t = 1; t < T; t++) { const dr = new Array(K), pr = new Array(K); for (let k = 0; k < K; k++) { let best = -Infinity, arg = 0; for (let j = 0; j < K; j++) { const v = delta[t - 1][j] + logA[j][k]; if (v > best) { best = v; arg = j; } } dr[k] = best + this._gauss(F[t], this.means[k], this.vars[k]); pr[k] = arg; } delta[t] = dr; psi[t] = pr; }
        let last = 0, bv = -Infinity; for (let k = 0; k < K; k++) if (delta[T - 1][k] > bv) { bv = delta[T - 1][k]; last = k; }
        const path = new Array(T); path[T - 1] = last; for (let t = T - 2; t >= 0; t--) path[t] = psi[t + 1][path[t + 1]];
        return path;
    },
    _relabel() {
        // means zijn gestandaardiseerd; index 1 = |ret| (volatiliteit), index 2 = bodyRatio (richting)
        const K = this.K;
        const vol = this.means.map(m => m[1]), dir = this.means.map(m => m[2]);
        const byVol = [...Array(K).keys()].sort((a, b) => vol[a] - vol[b]);
        const lowest = byVol[0], highest = byVol[K - 1], second = byVol[K - 2];
        this.order = new Array(K).fill('kalm');
        this.order[lowest] = 'compressie';
        // hoogste volatiliteit: trending als richting sterk, anders volatiel-zijwaarts
        this.order[highest] = dir[highest] >= 0 ? 'trending' : 'volatiel';
        this.order[second] = dir[second] >= 0 ? 'trending' : 'volatiel';
    }
};
window.OsirisRegimeHMM = OsirisRegimeHMM;

const OsirisShadowBacktest = {
    best: null, lastRun: 0, sharpe: null, tested: 0,
    // Simpele momentum-strategie over de buffer; grid over (target, stop) -> beste Sharpe.
    run(buf) {
        try {
            if (!buf || buf.length < 120) return null;
            const src = buf.slice(-360).map(d => ({ o: parseFloat(d[1]), h: parseFloat(d[2]), l: parseFloat(d[3]), c: parseFloat(d[4]) }));
            const targets = [0.15, 0.25, 0.35, 0.5], stops = [0.2, 0.3, 0.4, 0.5];
            const cost = 0.05; // % round-trip proxy
            let best = null;
            for (const tg of targets) for (const sl of stops) {
                const pnls = [];
                for (let i = 3; i < src.length - 8; i++) {
                    // signaal: momentum van laatste 3 candles
                    const mom = src[i].c - src[i - 3].c;
                    if (Math.abs(mom) / src[i].c * 100 < 0.05) continue;
                    const dir = mom > 0 ? 1 : -1, entry = src[i].c;
                    let pnl = null;
                    for (let j = i + 1; j <= i + 8 && j < src.length; j++) {
                        const up = (src[j].h - entry) / entry * 100, dn = (src[j].l - entry) / entry * 100;
                        if (dir > 0) { if (up >= tg) { pnl = tg; break; } if (dn <= -sl) { pnl = -sl; break; } }
                        else { if (-dn >= tg) { pnl = tg; break; } if (-up <= -sl) { pnl = -sl; break; } }
                    }
                    if (pnl == null) pnl = dir * (src[Math.min(i + 8, src.length - 1)].c - entry) / entry * 100; // time-out
                    pnls.push(pnl - cost);
                }
                if (pnls.length < 8) continue;
                const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
                const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length) || 1e-6;
                const sharpe = mean / sd * Math.sqrt(pnls.length);
                if (!best || sharpe > best.sharpe) best = { target: tg, stop: sl, sharpe, n: pnls.length, mean };
            }
            if (best) { this.best = best; this.sharpe = best.sharpe; this.tested = (targets.length * stops.length); this.lastRun = Date.now(); }
            return best;
        } catch (e) { return null; }
    }
};
window.OsirisShadowBacktest = OsirisShadowBacktest;

// Driver: laat de HMM + backtest periodiek draaien en Osiris zich autonoom aanpassen.
let _osirisLearnLast = 0;
function osirisAdaptiveLearn() {
    try {
        const now = Date.now();
        if (now - _osirisLearnLast < 5 * 60000) return;   // elke 5 min
        _osirisLearnLast = now;
        const buf = (typeof rawData !== 'undefined' && rawData && rawData.length) ? rawData : null;
        if (!buf) return;
        // 1) HMM regime
        const okH = OsirisRegimeHMM.train(buf, 8);
        if (okH && OsirisRegimeHMM.stable >= 3) {
            // per-regime zachte parameter-nudge (alleen als het regime stabiel is)
            const reg = OsirisRegimeHMM.label; let nudge = '';
            if (reg === 'trending') { if ((botSettings.maxPositionAgeMinutes || 90) < 80) { botSettings.maxPositionAgeMinutes = Math.min(90, (botSettings.maxPositionAgeMinutes || 90) + 10); nudge = 'langer vasthouden (trend laten lopen)'; } }
            else if (reg === 'compressie') { if ((botSettings.maxPositionAgeMinutes || 90) > 35) { botSettings.maxPositionAgeMinutes = Math.max(35, (botSettings.maxPositionAgeMinutes || 90) - 10); nudge = 'korter vasthouden (compressie -> snel oogsten)'; } }
            else if (reg === 'volatiel') { if ((botSettings.smallProfitHarvestMinutes || 30) > 10) { botSettings.smallProfitHarvestMinutes = Math.max(10, (botSettings.smallProfitHarvestMinutes || 30) - 5); nudge = 'sneller oogsten (volatiel -> winst pakken)'; } }
            if (nudge && OsirisRegimeHMM.stable === 3) { try { logAdaptation(`HMM-regime: ${reg.toUpperCase()}`, `zekerheid ${(OsirisRegimeHMM.prob * 100 | 0)}% (${OsirisRegimeHMM.stable} candles stabiel) - ${nudge}`); } catch (e) { } }
        }
        // 2) Shadow-backtest tuner (Bayesian-lite): nudge micro target/stop naar de beste Sharpe
        const b = OsirisShadowBacktest.run(buf);
        if (b && b.sharpe > 0.3) {
            const curT = botSettings.microTargetPct != null ? botSettings.microTargetPct : 0.25;
            const curS = botSettings.microStopPct != null ? botSettings.microStopPct : 0.3;
            const nT = +(curT + Math.sign(b.target - curT) * Math.min(0.05, Math.abs(b.target - curT))).toFixed(3);
            const nS = +(curS + Math.sign(b.stop - curS) * Math.min(0.05, Math.abs(b.stop - curS))).toFixed(3);
            if (Math.abs(nT - curT) > 0.001 || Math.abs(nS - curS) > 0.001) {
                botSettings.microTargetPct = nT; botSettings.microStopPct = nS;
                try { logAdaptation('Shadow-backtest optimaliseert', `beste Sharpe ${b.sharpe.toFixed(2)} bij target ${b.target}% / stop ${b.stop}% (n=${b.n}) - micro target->${nT}% stop->${nS}%`); } catch (e) { }
            }
        }
        // RL -> AUTONOME TIME-STOP HERKALIBRATIE (16-08): Osiris gebruikt wat de RL-agent
        // leerde. Verkiest de policy overwegend HOLD/TRAIL (winnaars laten lopen), dan langer
        // vasthouden; verkiest hij SLUIT, dan korter. Zo herkalibreert de time-stop zichzelf
        // op basis van duizenden doorgespeelde scenario's i.p.v. alleen recente exits.
        try {
            if (typeof OsirisRL !== 'undefined' && OsirisRL.episodes > 5000) {
                const ad = OsirisRL.actionDist, tot = ad.reduce((a, x) => a + x, 0) || 1;
                const holdShare = (ad[0] + ad[2]) / tot;   // HOLD + TRAIL
                const closeShare = ad[1] / tot;            // SLUIT
                let cur = botSettings.maxPositionAgeMinutes || 90;
                try { if (osirisStress.ts && (Date.now() - osirisStress.ts < 30 * 60000) && (osirisStress.regime === 'CRISIS' || osirisStress.variance > 0.02) && cur > 40) { const c0 = cur; botSettings.maxPositionAgeMinutes = Math.max(40, cur - 15); cur = botSettings.maxPositionAgeMinutes; logAdaptation('FSO verkort time-stop', `systeem-stress (${osirisStress.regime}, σ² ${osirisStress.variance.toFixed(4)}) - vasthoudtijd ${c0}min → ${cur}min`); } } catch (e) {}
                let nv = cur, why = '';
                if (holdShare > 0.6 && cur < 120) { nv = Math.min(120, cur + 10); why = `RL verkiest vasthouden (${(holdShare * 100 | 0)}% HOLD/TRAIL)`; }
                else if (closeShare > 0.45 && cur > 35) { nv = Math.max(35, cur - 10); why = `RL verkiest sluiten (${(closeShare * 100 | 0)}% SLUIT)`; }
                if (nv !== cur) { botSettings.maxPositionAgeMinutes = nv; try { logAdaptation('RL herkalibreert time-stop', `${why} - vasthoudtijd ${cur}min -> ${nv}min (uit ${OsirisRL.episodes.toLocaleString()} scenario's)`); } catch (e) { } }
            }
        } catch (e) { }
    } catch (e) { }
}
window.osirisAdaptiveLearn = osirisAdaptiveLearn;


function osirisReview() {
    try {
        // verzamel de kans/kant per munt uit de sub-breinen
        const cands = [];
        for (const sym of MULTI_SYMBOLS) {
            const m = neoMultiState.markets[sym];
            if (!m) continue;
            // BTC gebruikt de bewezen hoofd-engine-kans indien beschikbaar, anders sub-brein
            let prob = m.bestProb != null ? m.bestProb : 0.5;
            let side = m.bestSide || null;
            if (sym === 'BTC') {
                try {
                    if (typeof lastOsirisDecision !== 'undefined' && lastOsirisDecision && lastOsirisDecision.probabilityPct != null) {
                        prob = lastOsirisDecision.probabilityPct / 100;
                        side = lastOsirisDecision.side || side;
                    }
                } catch (e) {}
            }
            // per-markt sentiment-tilt (Fear & Greed + funding + L/S van DEZE munt)
            try { if (side) prob = Math.max(0, Math.min(1, prob + sentimentTilt(side, sym) / 100)); } catch (e) {}
            cands.push({ sym, prob, side });
        }
        if (!cands.length) return osirisState;

        // sorteer op kans (hoogste eerst)
        cands.sort((a, b) => b.prob - a.prob);
        osirisState.picks = cands;

        // EQUITY-STRATEGIE (aangepast 01-08): het doel is de BESTE kans traden, niet
        // de equity spreiden. Osiris kiest daarom standaard de munt met de hoogste kans
        // en zet daar de volledige equity op. Alleen als de top-kansen NAGENOEG GELIJK
        // zijn (binnen een kleine marge) wordt verdeeld - want dan is er geen duidelijke
        // beste keuze en spreidt verdelen het risico zonder verwachte winst op te geven.
        const MIN_PROB = (typeof osirisTune !== 'undefined' && osirisTune.minProb) ? osirisTune.minProb : 0.55;
        const EQUAL_MARGIN = 0.05;   // kansen binnen 5 procentpunt = "gelijk"
        // BTC draait op zijn EIGEN hoofd-engine en wordt door osirisShadowTick overgeslagen.
        // Namen we BTC mee in de winner-take-all, dan "won" een sterk BTC-signaal de
        // allocatie zonder dat er iets mee gedaan werd, en verhongerden ETH/SOL (0%).
        // Osiris verdeelt daarom alleen de markten die hij daadwerkelijk shadow-trade.
        const eligible = cands.filter(c => c.side && c.prob >= MIN_PROB && c.sym !== 'BTC');
        const alloc = {};
        for (const c of cands) alloc[c.sym] = 0;
        if (eligible.length === 0) {
            osirisState.note = 'Geen munt boven de drempel - Osiris wacht.';
        } else if (eligible.length === 1) {
            osirisState.note = `${eligible[0].sym} is de enige kans (${(eligible[0].prob * 100 | 0)}%) - volledige equity.`;
            alloc[eligible[0].sym] = 1;
        } else {
            // MICRO-MARGINS (15-08): geen winner-take-all meer. Verdeel de equity KANS-GEWOGEN
            // over ALLE geschikte munten, zodat ETH EN SOL tegelijk (kleiner) handelen - meer,
            // snellere trades met kleinere allocaties i.p.v. alles op één markt.
            // FSO-OPPORTUNITY-TILT (22-08): kans-gewogen \u00e9n getilt naar de munt met de echte
            // bliksem-kans (kinetische opportunity). Osiris verdeelt de equity zo autonoom meer
            // naar de markt waar een grote beweging op komst is.
            const weights = eligible.map(c => { const opp = (typeof osirisMarketOpportunity === 'function') ? osirisMarketOpportunity(c.sym) : 0; return { sym: c.sym, opp, w: c.prob * c.prob * (1 + 1.6 * opp) }; });
            const sumW = weights.reduce((a, x) => a + x.w, 0);
            for (const x of weights) alloc[x.sym] = sumW > 0 ? x.w / sumW : 1 / eligible.length;
            const rank = weights.map(x => `${x.sym} ${(alloc[x.sym] * 100 | 0)}%${x.opp > 0.5 ? '\u26a1' : ''}`).join(' \u00b7 ');
            osirisState.note = `${eligible.length} munten geschikt - equity kans+opportunity-gewogen (${rank}); \u26a1 = FSO-bliksemkans.`;
            osirisState.opportunity = Object.fromEntries(weights.map(x => [x.sym, +x.opp.toFixed(3)]));
        }
        osirisState.allocations = alloc;
        osirisState.lastReview = Date.now();
        try { renderOsirisPanel(); } catch (e) {}
        return osirisState;
    } catch (e) { return osirisState; }
}
window.osirisReview = osirisReview;

// Toon Osiris' oordeel: de rangschikking van de munten + de equity-verdeling.
function renderOsirisPanel() {
    const el = document.getElementById('osiris-panel');
    if (!el) return;
    const picks = osirisState.picks || [];
    const alloc = osirisState.allocations || {};
    if (!picks.length) { el.innerHTML = '<span style="color:var(--text-dim); font-size:0.62rem;">Osiris verzamelt data van de sub-breinen...</span>'; return; }
    const colors = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };
    let html = `<div style="font-family:'JetBrains Mono',monospace; font-size:0.62rem;">`;
    for (const p of picks) {
        const a = (alloc[p.sym] || 0) * 100;
        const barCol = colors[p.sym] || '#00d9ff';
        const skip = (osirisState.skip && p.sym !== 'BTC') ? osirisState.skip[p.sym] : null;
        const skipHtml = (skip && a > 0) ? ` <span style="color:#ff8a94; font-size:0.54rem;">&middot; ${skip}</span>` : '';
        html += `<div style="margin-bottom:7px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
                <span style="color:${barCol}; font-weight:700;">${p.sym} ${p.side || ''}${skipHtml}</span>
                <span>kans ${(p.prob*100|0)}% &middot; equity ${a.toFixed(0)}%</span>
            </div>
            <div style="height:5px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;"><div style="height:100%; width:${a}%; background:${barCol};"></div></div>
        </div>`;
    }
    html += `<div style="margin-top:6px; color:var(--text-dim); font-size:0.58rem;">${osirisState.note}</div>`;
    html += `</div>`;
    el.innerHTML = html;
}
window.renderOsirisPanel = renderOsirisPanel;

// ============================================================
// OSIRIS TRANSPARANTIE & BACKUP (01-08) — Fase 5
// ============================================================
// Via Osiris (de mainbrain) kun je ALLE VIER de breinen tegelijk backuppen en
// herstellen: de BTC-hoofdengine (bestaande osiris-export) + de drie sub-breinen
// (Neo BTC/ETH/SOL gewichten, learning, presets). Plus: alle multi-markt data en
// candle-historie downloaden, en het overzicht van wat Osiris autonoom heeft aangepast.

// Volledige backup van alles onder Osiris v1.
function osirisFullBackup() {
    try {
        const backup = {
            version: 'osiris-v1',
            exportedAt: new Date().toISOString(),
            // de bewezen BTC-hoofdengine (zelfde velden als de losse export)
            mainbrain: {
                walletState, openPositions, botTradeLog, botSettings,
                adaptiveWeights, regimeWeights,
                learningLog: (typeof learningLog !== 'undefined') ? learningLog : [],
                l2: (typeof _l2 !== 'undefined') ? _l2 : null
            },
            // de drie sub-breinen (gewichten, learning, presets, NN-staat)
            subbrains: {},
            // Osiris' eigen staat + autonome aanpassingen
            osiris: {
                state: osirisState,
                adaptationLog: (typeof _adaptationLog !== 'undefined') ? _adaptationLog : []
            }
        };
        for (const sym of MULTI_SYMBOLS) {
            const m = neoMultiState.markets[sym];
            backup.subbrains[sym] = {
                brain: m ? m.brain : null,
                nn: _nnState[sym] || null,
                lastPrice: m ? m.lastPrice : null
            };
        }
        _downloadJSON(backup, `osiris_v1_volledige_backup_${Date.now()}.json`);
        try { logAdaptation('Volledige backup gemaakt', 'alle 4 breinen (mainbrain + 3 sub-breinen) + Osiris-staat opgeslagen'); } catch (e) {}
    } catch (e) { alert('Backup mislukt: ' + e.message); }
}
window.osirisFullBackup = osirisFullBackup;

// Herstel alles uit een Osiris v1 backup-bestand.
function osirisFullRestore(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const b = JSON.parse(ev.target.result);
            if (b.version !== 'osiris-v1') { alert('Geen geldig Osiris v1 backup-bestand.'); return; }
            // mainbrain herstellen
            if (b.mainbrain) {
                const mb = b.mainbrain;
                if (mb.walletState) Object.assign(walletState, mb.walletState);
                if (mb.botSettings) Object.assign(botSettings, mb.botSettings);
                if (mb.adaptiveWeights) adaptiveWeights = mb.adaptiveWeights;
                if (mb.regimeWeights) regimeWeights = mb.regimeWeights;
                if (mb.openPositions) openPositions = mb.openPositions;
                if (mb.botTradeLog) botTradeLog = mb.botTradeLog;
                if (mb.learningLog && typeof learningLog !== 'undefined') learningLog = mb.learningLog;
                if (mb.l2 && typeof _l2 !== 'undefined') _l2 = mb.l2;
            }
            // sub-breinen herstellen
            if (b.subbrains) {
                for (const sym of MULTI_SYMBOLS) {
                    const sb = b.subbrains[sym];
                    if (!sb) continue;
                    const m = neoMultiState.markets[sym];
                    if (m && sb.brain) m.brain = sb.brain;
                    if (sb.nn) _nnState[sym] = sb.nn;
                }
            }
            // Osiris-staat
            if (b.osiris) {
                if (b.osiris.state) osirisState = b.osiris.state;
                if (b.osiris.adaptationLog && typeof _adaptationLog !== 'undefined') _adaptationLog = b.osiris.adaptationLog;
            }
            try { savePersistentState(); } catch (e) {}
            try { renderOsirisPanel(); renderLearningPanel(); updateWalletUI(); } catch (e) {}
            alert('Osiris v1 backup hersteld: alle 4 breinen teruggezet.');
        } catch (e) { alert('Herstel mislukt: ' + e.message); }
    };
    reader.readAsText(file);
}
window.osirisFullRestore = osirisFullRestore;

// Download alle multi-markt data + candle-historie van alle drie de markten.
function downloadAllMarketData() {
    try {
        const out = { exportedAt: new Date().toISOString(), markets: {} };
        for (const sym of MULTI_SYMBOLS) {
            const m = neoMultiState.markets[sym];
            if (!m) continue;
            out.markets[sym] = {
                lastPrice: m.lastPrice, ema: m.ema, emaSlow: m.emaSlow, rsi: m.rsi,
                vfm: m.vfm, chaos: m.chaos, bestProb: m.bestProb, bestSide: m.bestSide,
                subBrainLabel: m.brain ? m.brain.label : null,
                nnRitmeMin: (_nnState[sym] && _nnState[sym].period) ? Math.round(_nnState[sym].period / 60000) : null,
                nnCaps: (_nnState[sym] && _nnState[sym].caps) ? _nnState[sym].caps.length : 0,
                // volledige candle-historie [tijd, o, h, l, c, v]
                candles: m.klines || []
            };
        }
        _downloadJSON(out, `osiris_multimarkt_data_${Date.now()}.json`);
    } catch (e) { alert('Download mislukt: ' + e.message); }
}
window.downloadAllMarketData = downloadAllMarketData;

// Download het overzicht van wat Osiris autonoom heeft aangepast.
function downloadAdaptationLog() {
    try {
        const log = (typeof _adaptationLog !== 'undefined') ? _adaptationLog : [];
        _downloadJSON({ exportedAt: new Date().toISOString(), adaptations: log }, `osiris_autonome_aanpassingen_${Date.now()}.json`);
    } catch (e) { alert('Download mislukt: ' + e.message); }
}
window.downloadAdaptationLog = downloadAdaptationLog;

// ============================================================
// OSIRIS LIVE MULTI-MARKT TRADING (01-08) — Fase 5, deel 2
// ============================================================
// Osiris opent nu ECHTE testnet-posities voor ETH/SOL met dezelfde nepgeld-wallet als
// BTC (één equity-pot, meerdere markten). Standaard UIT achter een veiligheidsschakelaar
// - jij zet het bewust aan. BTC blijft altijd via de hoofd-engine handelen; Osiris voegt
// ETH/SOL toe volgens zijn equity-verdeling. De echte executie loopt via dezelfde
// (nu munt-bewuste) order-keten als BTC.
let osirisLiveEnabled = false;     // veiligheidsschakelaar - standaard uit
let _osirisLastEntry = {};         // cooldown per munt (voorkomt over-trading)

function toggleOsirisShadow(on) {
    // (schakelaar bestuurt nu de LIVE multi-markt trading; naam behouden voor de UI-binding)
    osirisLiveEnabled = !!on;
    try { localStorage.setItem('osirisLiveEnabled', on ? 'true' : 'false'); } catch (e) {}
    try { logAdaptation(`Osiris multi-markt trading ${on ? 'AAN' : 'UIT'}`, on ? 'Osiris handelt nu ETH/SOL op de testnet met de gedeelde wallet volgens zijn equity-verdeling' : 'multi-markt trading gepauzeerd - alleen BTC handelt'); } catch (e) {}
    renderOsirisShadowPanel();
}
window.toggleOsirisShadow = toggleOsirisShadow;

function osirisShadowTick() {
    if (!osirisLiveEnabled) return;
    if (botSettings.executionMode !== 'TESTNET') return;   // alleen op de testnet
    if (typeof osirisSafetyHalt === 'function' && osirisSafetyHalt()) return;   // veiligheids-halt: geen nieuwe ETH/SOL-entries
    try {
        const alloc = osirisState.allocations || {};
        const picks = osirisState.picks || [];
        const now = Date.now();
        try { if (typeof OsirisGuard !== 'undefined') OsirisGuard.evaluate(); } catch (e) {}
        let allocSoFar = getAllocatedPct();   // lopende allocatie: voorkomt >100% binnen 1 tick
        osirisState.skip = osirisState.skip || {};   // zichtbare 'waarom niet'-reden per munt
        for (const p of picks) {
            const sym = p.sym;
            if (sym === 'BTC') continue;                    // BTC loopt via de hoofd-engine
            // INGREEP 2 - circuit breaker PER MARKT: pauzeert alleen de munt die zelf
            // onderpresteert, en nooit een munt met open meta + FSO-bliksemkans.
            if (typeof OsirisGuard !== 'undefined' && OsirisGuard.ENABLED && typeof OsirisGuard.isPaused === 'function' && OsirisGuard.isPaused(sym)) { osirisState.skip[sym] = 'circuit breaker gepauzeerd (deze munt)'; continue; }
            const a = alloc[sym] || 0;
            if (a <= 0 || !p.side) { if (a <= 0 && p.side) osirisState.skip[sym] = 'geen allocatie (andere munt won)'; continue; }
            // al een open positie op deze munt? niet dubbelen
            if (openPositions.some(x => (x.symbol === MULTI_BINANCE[sym]))) { osirisState.skip[sym] = 'al open'; continue; }
            if (typeof _osirisSweep !== 'undefined' && _osirisSweep[sym]) { osirisState.skip[sym] = 'wacht op sweep-niveau'; continue; }
            // SHORT geblokkeerd (onvoldoende testnet-saldo)? sla over - anders sweep->skip->loop.
            if (p.side === 'SHORT' && _osirisShortBlock[sym] && (now - _osirisShortBlock[sym]) < 15 * 60000) { osirisState.skip[sym] = 'SHORT geblokkeerd (onvoldoende saldo op testnet)'; continue; }
            // cooldown: max 1 nieuwe entry per munt per 60s
            if (_osirisLastEntry[sym] && (now - _osirisLastEntry[sym]) < 60000) { osirisState.skip[sym] = '60s cooldown'; continue; }
            try { if (typeof osirisPredictGate === 'function') { const _pg = osirisPredictGate(sym, p.side); if (!_pg.allow) { osirisState.skip[sym] = _pg.reason; continue; } } } catch (e) {}
            try { if (typeof osirisTrendVeto === 'function') { const _tv = osirisTrendVeto(sym, p.side); if (_tv.veto) { osirisState.skip[sym] = _tv.reason; continue; } } } catch (e) {}
            const m = neoMultiState.markets[sym];
            if (!m || m.lastPrice == null) { osirisState.skip[sym] = 'geen verse prijs (multi-engine?)'; continue; }
            // INGREEP 1 - DeepNet-poort: alleen instappen als de per-markt DeepNet het eens
            // is met de richting EN zijn meta-poort open staat (genoeg walk-forward-precisie).
            // Zo vallen zwakke, over-getraden ETH/SOL-setups weg. We gebruiken bovendien de
            // GEKALIBREERDE DeepNet-kans i.p.v. de ruwe, geclusterde pick-kans.
            let dnCalProb = null;
            try {
                if (typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.GATE_ENTRIES && OsirisDeepNet.markets[sym] && OsirisDeepNet.markets[sym].model) {
                    const dnp = OsirisDeepNet.last[sym] || OsirisDeepNet.predict(sym);
                    if (dnp) {
                        // ZACHTE POORT: alleen blokkeren als de DeepNet MET open meta-poort
                        // de ANDERE kant op wijst (confident tegen). Is de DeepNet onzeker
                        // (meta dicht), dan laten we de Osiris-pick door - anders ligt bijna
                        // alles stil zodra de DeepNet even geen sterk signaal heeft.
                        // Alleen blokkeren als de DeepNet STERK de andere kant op wijst
                        // (conf >= 55%). Bij een matige onenigheid volgen we de sub-brein-pick,
                        // anders blijven ETH/SOL eeuwig geblokkeerd zodra DeepNet en cores het
                        // oneens zijn (DeepNet SHORT vs sub-brein LONG) en handelt alleen BTC.
                        if (dnp.meta && dnp.side !== p.side && (dnp.conf || 0) >= 0.55) {
                            try { logAdaptation(`Osiris slaat ${sym} ${p.side} over`, `DeepNet wijst STERK de andere kant op (${dnp.side}, conf ${((dnp.conf || 0) * 100 | 0)}%) - tegengestelde trade vermeden`); } catch (e) {}
                            osirisState.skip[sym] = `DeepNet sterk tegengesteld (${dnp.side})`;
                            continue;
                        }
                        if (dnp.meta && dnp.side === p.side) dnCalProb = dnp.calProb;   // gekalibreerde kans bij bevestiging
                    }
                }
            } catch (e) {}
            const preset = (m.brain && m.brain.preset) ? m.brain.preset : {};
            // grootte uit de gedeelde wallet met de munt-eigen max-allocatie (valt terug
            // op de globale als het preset die niet definieert).
            const freeEquity = (walletState.balance != null ? walletState.balance : walletState.realizedPnL + 1000);
            const maxAlloc = preset.maxAllocationPct != null ? preset.maxAllocationPct : (botSettings.maxAllocationPct || 0.7);
            // FIX over-allocatie (140%-bug): begrens op de VRIJE equity - wat al in open
            // posities zit plus de hedge-reserve. Twee winner-take-all entries kunnen zo
            // nooit samen meer dan de wallet claimen.
            const reservePct = botSettings.minHedgeReservePct || 0;
            // BTC-RESERVE (15-08): ETH/SOL zijn veel volatieler en zouden anders de hele
            // wallet vullen, waardoor BTC's eigen engine nooit ruimte krijgt en Osiris niet
            // meer op de BTC-markt leert. Daarom laten ETH/SOL 15% ongemoeid - MAAR alleen
            // zolang BTC nog geen positie heeft (staat BTC al open, dan is die ruimte al benut).
            const _btcOpen = openPositions.some(x => ((x.symbol === 'BTCUSDT') || (x.market === 'BTC')) && !x.isOsiris);
            const btcReserve = _btcOpen ? 0 : (typeof OSIRIS_BTC_RESERVE !== 'undefined' ? OSIRIS_BTC_RESERVE : 0.15);
            const availablePct = Math.max(0, 1 - allocSoFar - reservePct - btcReserve);
            const sizePct = Math.min(a * maxAlloc, availablePct);
            if (sizePct <= 0) { osirisState.skip[sym] = 'geen vrije equity'; continue; }   // wallet al vol
            const notionalUSD = freeEquity * sizePct;
            if (notionalUSD < 5) { osirisState.skip[sym] = 'order < $5'; continue; }
            const amount = notionalUSD / m.lastPrice;
            const position = {
                id: 'osiris-' + sym + '-' + now,
                symbol: MULTI_BINANCE[sym],
                side: p.side,
                entryPrice: m.lastPrice,
                amount,
                notional: notionalUSD,
                sizePct: sizePct,
                osirisAllocPct: a,
                probabilityPct: (dnCalProb != null ? dnCalProb * 100 : (p.prob != null ? p.prob * 100 : null)),   // gekalibreerde DeepNet-kans indien poort meesprak, anders de pick-kans
                factorsAtEntry: (m.bestFactors ? Object.assign({}, m.bestFactors) : null),   // per-markt factor-uitsplitsing voor zelf-kalibratie
                openTime: now,
                isScalp: false,
                isOsiris: true,
                regimeAtEntry: 'MULTI',
                targetPrice: null,
                stopLossPct: preset.stopLossPct != null ? preset.stopLossPct : null,
                customStopLossPct: preset.stopLossPct != null ? preset.stopLossPct / 100 : null
            };
            _osirisLastEntry[sym] = now;
            osirisState.skip[sym] = null;   // succesvol geopend -> geen blokkade-reden
            allocSoFar += sizePct;   // lokaal reserveren, ongeacht async-timing van de commit
            const _swReason = `OSIRIS ${sym} ${p.side} (kans ${(p.prob * 100 | 0)}%)`;
            // STERK MOMENTUM: dan komt de pullback naar het stop-niveau waarschijnlijk niet -
            // direct at-market instappen i.p.v. wachten op een sweep die de move mist.
            const _mom = m.vfm || 0;
            const _strongMom = (p.side === 'LONG' && _mom > 0.6) || (p.side === 'SHORT' && _mom < -0.6);
            if (typeof osirisSweepEnabled !== 'undefined' && osirisSweepEnabled && !_strongMom) {
                // SWEEP-ENTRY: stap pas in op het verwachte stop-/liquidatie-niveau (waar de
                // liquidaties zitten) i.p.v. direct at-market -> betere entry. Fallback:
                // niet geraakt binnen het venster => alsnog at-market (traden valt niet stil).
                const stopDist = ((preset.stopLossPct != null ? preset.stopLossPct : 0.5) / 100) * OSIRIS_SWEEP_FRAC;
                const level = p.side === 'LONG' ? m.lastPrice * (1 - stopDist) : m.lastPrice * (1 + stopDist);
                _osirisSweep[sym] = { side: p.side, level, refPrice: m.lastPrice, position, reason: _swReason, created: now, expiry: now + OSIRIS_SWEEP_WINDOW_MS };
                try { logAdaptation(`Osiris wacht op sweep · ${sym} ${p.side}`, `entry pas bij ${level.toFixed(m.lastPrice < 10 ? 3 : 2)} (verwacht liquidatie-/stop-niveau); anders at-market binnen ${(OSIRIS_SWEEP_WINDOW_MS / 60000) | 0} min`); } catch (e) {}
            } else {
                try { logAdaptation(`Osiris opent ${sym} ${p.side}`, `${_strongMom ? 'sterk momentum (vfm ' + _mom.toFixed(2) + ') - sweep overgeslagen, direct at-market; ' : ''}kans ${(p.prob * 100 | 0)}%, allocatie ${(a * 100 | 0)}% van de gedeelde wallet ($${notionalUSD.toFixed(0)})`); } catch (e) {}
                commitPositionEntry(position, _swReason + (_strongMom ? ' [momentum]' : ''));
            }
        }
        renderOsirisShadowPanel();
    } catch (e) { /* stil */ }
}
window.osirisShadowTick = osirisShadowTick;

// Read-only diagnose: waarom handelen ETH/SOL (nu) niet? Typ osirisWhyIdle()
// in de console. Raakt niets aan de logica; leest alleen de live gate-status.
function osirisWhyIdle() {
    const st = (typeof osirisState !== 'undefined') ? osirisState : {};
    const alloc = st.allocations || {};
    const out = {
        multiMarktTradingAan: (typeof osirisLiveEnabled !== 'undefined') ? osirisLiveEnabled : null,
        executionMode: botSettings.executionMode,
        engineDraait: (typeof _multiEngineRunning !== 'undefined') ? _multiEngineRunning : null,
        picks: (st.picks || []).map(p => ({ sym: p.sym, side: p.side, prob: p.prob })),
        allocaties: alloc,
        perMarkt: {}
    };
    for (const sym of ['ETH', 'SOL']) {
        const m = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[sym] : null;
        const dnp = (typeof OsirisDeepNet !== 'undefined') ? OsirisDeepNet.last[sym] : null;
        const bin = (typeof MULTI_BINANCE !== 'undefined') ? MULTI_BINANCE[sym] : null;
        const alOpen = openPositions.some(x => x.symbol === bin);
        const cd = !!(typeof _osirisLastEntry !== 'undefined' && _osirisLastEntry[sym] && (Date.now() - _osirisLastEntry[sym]) < 60000);
        const a = alloc[sym] || 0;
        let reden = 'zou instappen bij kans';
        if (!out.multiMarktTradingAan) reden = 'multi-markt trading staat UIT (schakelaar in wallet)';
        else if (a <= 0) reden = 'allocatie 0% - kans < 55% of geen richting, dus niet geschikt';
        else if (!m || m.lastPrice == null) reden = 'geen verse prijs - multi-engine niet actief?';
        else if (alOpen) reden = 'al een open positie op deze munt';
        else if (cd) reden = '60s cooldown na vorige entry';
        else if (dnp && dnp.meta && st.picks && (st.picks.find(p => p.sym === sym) || {}).side && dnp.side !== (st.picks.find(p => p.sym === sym) || {}).side) reden = 'DeepNet wijst met open meta-poort de andere kant op';
        out.perMarkt[sym] = { allocatiePct: +(a * 100).toFixed(1), versePrijs: m ? m.lastPrice : null, alReedsOpen: alOpen, cooldownActief: cd, deepnetMeta: dnp ? dnp.meta : null, deepnetSide: dnp ? dnp.side : null, waarschijnlijkeReden: reden };
    }
    console.log('%c[Osiris why-idle]', 'color:#00d9ff', out);
    return out;
}
window.osirisWhyIdle = osirisWhyIdle;

// ============================================================
// AUTONOME PRESET-AANPASSING PER MUNT (01-08)
// ============================================================
// Neo/Osiris herziet niet alleen de BTC-engine, maar ook de preset-config van elk
// sub-brein (ETH/SOL) op basis van hun eigen schaduw/live-resultaten en marktkarakter.
// Elke aanpassing wordt gelogd en in het display getoond. Zo worden de munt-configs
// zelf-lerend in plaats van vast. Veilige grenzen voorkomen ontsporing.
let _presetAdaptLog = {};   // per munt een lijst recente aanpassingen
function autonomousPresetAdapt(sym) {
    try {
        const m = neoMultiState.markets[sym];
        const b = m && m.brain;
        if (!b || !b.preset) return;
        const preset = b.preset;
        // gebruik de gesloten Osiris-trades van deze munt als bewijs
        const closed = openPositions.filter(() => false); // (echte gesloten trades komen via de tradelog)
        const symTrades = (typeof botTradeLog !== 'undefined' ? botTradeLog : []).filter(t => t.action === 'EXIT' && t.market === sym);
        if (symTrades.length < 8) return;   // te weinig data voor een veilige aanpassing
        const wins = symTrades.filter(t => (t.pnlPct || 0) > 0);
        const winRate = wins.length / symTrades.length;
        const avgWin = wins.length ? wins.reduce((a, t) => a + (t.pnlPct || 0), 0) / wins.length : 0;
        const losses = symTrades.filter(t => (t.pnlPct || 0) <= 0);
        const avgLoss = losses.length ? losses.reduce((a, t) => a + (t.pnlPct || 0), 0) / losses.length : 0;
        const changes = [];

        // 1) stop te strak? (gemiddeld verlies raakt bijna altijd de stop) -> ruimer
        if (avgLoss < 0 && Math.abs(avgLoss) >= preset.stopLossPct * 0.9 / 100 && preset.stopLossPct < 5) {
            const old = preset.stopLossPct;
            preset.stopLossPct = Math.min(5, +(preset.stopLossPct * 1.1).toFixed(2));
            if (preset.stopLossPct !== old) changes.push(`stop ${old}%\u2192${preset.stopLossPct}%`);
        }
        // 2) winrate laag ondanks trades -> instap-drempel omhoog (strenger)
        if (winRate < 0.45 && preset.minProbabilityPct < 80) {
            const old = preset.minProbabilityPct;
            preset.minProbabilityPct = Math.min(80, old + 2);
            changes.push(`instap ${old}%\u2192${preset.minProbabilityPct}%`);
        }
        // 3) winrate hoog en winst mager -> winstdoel iets omhoog (laat lopen)
        if (winRate > 0.6 && avgWin > 0 && avgWin < preset.rangeScalpProfitTargetPct / 100 * 0.7) {
            const old = preset.rangeScalpProfitTargetPct;
            preset.rangeScalpProfitTargetPct = Math.min(2.5, +(old * 1.1).toFixed(2));
            changes.push(`doel ${old}%\u2192${preset.rangeScalpProfitTargetPct}%`);
        }

        if (changes.length) {
            if (!_presetAdaptLog[sym]) _presetAdaptLog[sym] = [];
            _presetAdaptLog[sym].unshift({ t: new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }), changes, winRate: (winRate * 100).toFixed(0), n: symTrades.length });
            if (_presetAdaptLog[sym].length > 20) _presetAdaptLog[sym].pop();
            try { logAdaptation(`${b.label}: preset aangepast`, `${changes.join(', ')} (winrate ${(winRate*100).toFixed(0)}%, ${symTrades.length} trades)`); } catch (e) {}
            try { renderOsirisPanel(); } catch (e) {}
        }
    } catch (e) { /* stil */ }
}
window.autonomousPresetAdapt = autonomousPresetAdapt;

// Herzie alle munt-presets periodiek (aangeroepen vanuit de engine-adapt-cyclus).
function autonomousPresetAdaptAll() {
    for (const sym of MULTI_SYMBOLS) if (sym !== 'BTC') autonomousPresetAdapt(sym);
}
window.autonomousPresetAdaptAll = autonomousPresetAdaptAll;

// Toon het overzicht van de sub-brein-presets per munt (Neo BTC/ETH/SOL) + de
// recente autonome aanpassingen, zodat zichtbaar is welk brein welke config heeft.
function renderSubBrainPresets() {
    const el = document.getElementById('subbrain-presets-body');
    if (!el) return;
    const colors = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };
    let html = '';
    for (const sym of MULTI_SYMBOLS) {
        const m = neoMultiState.markets[sym];
        const b = m && m.brain;
        const preset = b ? b.preset : (SUBBRAIN_PRESETS[sym] || {});
        const adapts = (_presetAdaptLog && _presetAdaptLog[sym]) ? _presetAdaptLog[sym] : [];
        html += `<div style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="color:${colors[sym]}; font-weight:700; margin-bottom:3px;">&#9679; ${b ? b.label : 'Neo ' + sym}</div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); gap:3px 10px; color:var(--text-dim);">
                <span>instap: <b style="color:var(--text-primary);">${preset.minProbabilityPct || '-'}%</b></span>
                <span>stop: <b style="color:var(--text-primary);">${preset.stopLossPct || '-'}%</b></span>
                <span>doel: <b style="color:var(--text-primary);">${preset.rangeScalpProfitTargetPct || '-'}%</b></span>
                <span>min.winst: <b style="color:var(--text-primary);">${preset.minProjectedProfitPct || '-'}%</b></span>
            </div>
            ${adapts.length ? `<div style="margin-top:4px; color:#ffb627; font-size:0.56rem;">autonoom: ${adapts[0].changes.join(', ')} (${adapts[0].t}, winrate ${adapts[0].winRate}%)</div>` : `<div style="margin-top:4px; color:var(--text-dimmer); font-size:0.56rem;">${preset.note || ''}</div>`}
        </div>`;
    }
    el.innerHTML = html;
}
window.renderSubBrainPresets = renderSubBrainPresets;

// Wissel de kalibratie-weergave tussen de breinen (Neo BTC/ETH/SOL).
let _activeCalibBrain = 'BTC';
function switchCalibBrain(sym) {
    _activeCalibBrain = sym;
    document.querySelectorAll('.calib-tab').forEach(b => b.classList.toggle('active', b.dataset.brain === sym));
    const svg = document.getElementById('calib-svg');
    const plot = document.getElementById('calib-plot');
    const note = document.getElementById('calib-note');
    if (svg) svg.style.display = '';   // curve-assen altijd tonen, ook voor ETH/SOL/OSIRIS
    if (plot) plot.innerHTML = '';     // eerst leeg zodat er niets van het vorige brein blijft staan
    if (note) note.textContent = '';
    renderCalibrationCurve();          // tekent nu voor elk brein een echte curve
}
window.switchCalibBrain = switchCalibBrain;




function renderOsirisShadowPanel() {
    const el = document.getElementById('osiris-shadow-panel');
    if (!el) return;
    const colors = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };
    const osirisPos = openPositions.filter(p => p.isOsiris);
    let html = `<div style="font-family:'JetBrains Mono',monospace; font-size:0.6rem;">`;
    if (!osirisLiveEnabled) {
        html += `<div style="color:var(--text-dimmer);">multi-markt trading staat uit - alleen BTC handelt</div>`;
    } else if (!osirisPos.length) {
        html += `<div style="color:var(--text-dim);">Osiris actief - wacht op een ETH/SOL-kans boven de drempel</div>`;
    } else {
        html += `<div style="color:var(--text-dim); margin-bottom:3px;">Osiris open posities (gedeelde wallet):</div>`;
        for (const pos of osirisPos) {
            const symKey = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === pos.symbol) || pos.symbol;
            const m = neoMultiState.markets[symKey];
            const px = m ? m.lastPrice : pos.entryPrice;
            const grossPct = (pos.side === 'LONG' ? (px - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - px) / pos.entryPrice) * 100;
            html += `<div style="display:flex; justify-content:space-between;"><span style="color:${colors[symKey]||'#00d9ff'};">${symKey} ${pos.side} $${(pos.notional||0).toFixed(0)}</span><span style="color:${grossPct>=0?'var(--teal)':'#ff4f6d'};">${grossPct>=0?'+':''}${grossPct.toFixed(2)}%</span></div>`;
        }
    }
    html += `</div>`;
    el.innerHTML = html;
}
window.renderOsirisShadowPanel = renderOsirisShadowPanel;



// Hulpfunctie: download een object als JSON-bestand.
function _downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}




// Haal de klines voor één munt op en werk zijn markt-staat bij (headless).
async function multiRefreshSymbol(sym) {
    const m = neoMultiState.markets[sym];
    if (!m || m.loading) return;
    m.loading = true;
    try {
        const pair = MULTI_BINANCE[sym];
        const iv = (typeof BOT_INTERVAL !== 'undefined') ? BOT_INTERVAL : '15m';
        const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${iv}&limit=672`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const kl = await r.json();
        if (!Array.isArray(kl) || kl.length < 30) throw new Error('te weinig candles');
        m.klines = kl;
        const closes = kl.map(d => parseFloat(d[4]));
        // headless EMA/RSI voor deze munt (los van de zichtbare chart)
        if (closes.length >= maFastPeriod) { const f = calculateSMA(closes, maFastPeriod); m.ema = f.length ? f[f.length - 1] : null; }
        if (closes.length >= maSlowPeriod) { const s = calculateSMA(closes, maSlowPeriod); m.emaSlow = s.length ? s[s.length - 1] : null; }
        if (closes.length >= rsiPeriod + 1) { const rs = calculateRSISeries(closes, rsiPeriod); m.rsi = rs.length ? rs[rs.length - 1].rsi : null; }
        // laatste prijs/volume + VFM/chaos
        const last = kl[kl.length - 1];
        m.lastPrice = parseFloat(last[4]);
        m.lastVol = parseFloat(last[5]);
        try { m.vfm = calculateVFM(m.lastPrice, m.lastVol, kl.slice(-21)); } catch (e) { m.vfm = 0; }
        // chaos = |3-candle % verandering| (zelfde definitie als UOTAM)
        if (closes.length > 3) { const p3 = closes[closes.length - 4]; m.chaos = Math.abs((m.lastPrice - p3) / p3) * 100; }
        // NN per munt (op zijn eigen data)
        try { nnCompute(sym, kl); } catch (e) {}
        // sub-brein-evaluatie: eigen kansoordeel voor deze munt (fase 3)
        try { subBrainEvaluate(sym); } catch (e) {}
        m.error = null; m.lastUpdate = Date.now();
    } catch (e) {
        m.error = e.message || 'fetch-fout';
    } finally {
        m.loading = false;
    }
}

// Round-robin: ververs per aanroep één munt (BTC tick1, ETH tick2, SOL tick3, ...).
// Zo blijft elke tick licht. BTC wordt daarnaast al door de hoofd-engine ververst,
// dus we prioriteren ETH/SOL die anders geen updates krijgen.
function multiRoundRobinTick() {
    const sym = MULTI_SYMBOLS[neoMultiState.rrIndex % MULTI_SYMBOLS.length];
    neoMultiState.rrIndex++;
    multiRefreshSymbol(sym).then(() => {
        // als de zojuist ververste munt de actieve tab is, werk de weergave bij
        try { if (neoMultiState.active === sym && typeof renderSystemDataTab === 'function') renderSystemDataTab(sym); } catch (e) {}
        // Osiris herziet de rangschikking + equity-verdeling na elke verse munt
        try { osirisReview(); } catch (e) {}
        // schaduw-trading (indien aan): simuleer ETH/SOL-trades met echte prijzen
        try { osirisShadowTick(); } catch (e) {}
        try { osirisSweepCheck(); } catch (e) {}
        try { marginTick(); } catch (e) {}
        try { if (typeof marginAutoLeverage === 'function' && Date.now() % 60000 < 11000) marginAutoLeverage(); } catch (e) {}
        try { osirisAutoTune(); } catch (e) {}
        try { osirisAdaptiveLearn(); } catch (e) {}
        try { osirisRLTick(); } catch (e) {}
        try { if (typeof OsirisKinetic !== 'undefined') OsirisKinetic.update(); } catch (e) {}   // kinetische breakpoint-engine + validatie
        try { if (typeof osirisMetaTick === 'function') osirisMetaTick(); } catch (e) {}          // meta-laag: predict + guardian + risk + governor
        try { osirisTuneLearningThreshold(); } catch (e) {}
        // sub-brein presets-overzicht bijwerken
        try { renderSubBrainPresets(); } catch (e) {}
    });
}

// Start de achtergrond-scan van alle markten (elke 10s één munt via round-robin).
let _multiInterval = null;
let _multiEngineRunning = false;
function startMultiAssetEngine() {
    // meteen alle drie één keer laden zodat de tabs direct data hebben
    MULTI_SYMBOLS.forEach((s, i) => setTimeout(() => { try { multiRefreshSymbol(s); } catch (e) {} }, i * 400));
    if (_multiInterval) clearInterval(_multiInterval);
    _multiInterval = setInterval(multiRoundRobinTick, 10 * 1000);
    // FUNDAMENTALS + CROSS-MARKET (01-08): aparte, trage lus (elke 60s). Deze data komt
    // van de FUTURES API (fapi.binance.com) - een APARTE rate-limit-pool (2400/min), dus
    // los van de spot-calls. Funding verandert maar elke 8u en open interest langzaam,
    // dus 60s is ruim voldoende. Verbruik: 3 munten x 3 calls = ~9 gewicht/min (~0.4%).
    if (window._fundInterval) clearInterval(window._fundInterval);
    setTimeout(() => { try { refreshFundamentalsAll(); } catch (e) {} }, 2500);
    window._fundInterval = setInterval(() => { try { refreshFundamentalsAll(); } catch (e) {} }, 60 * 1000);
    _multiEngineRunning = true;
    try { localStorage.setItem('multiEngineRunning', 'true'); } catch (e) {}
    try { updateMultiEngineStatus(); } catch (e) {}
}
function stopMultiAssetEngine() {
    if (_multiInterval) { clearInterval(_multiInterval); _multiInterval = null; }
    if (window._fundInterval) { clearInterval(window._fundInterval); window._fundInterval = null; }
    _multiEngineRunning = false;
    try { localStorage.setItem('multiEngineRunning', 'false'); } catch (e) {}
    try { updateMultiEngineStatus(); } catch (e) {}
}
window.stopMultiAssetEngine = stopMultiAssetEngine;

// Toon de status van de multi-markt engine (klein indicatortje bij de coin-tabs).
function updateMultiEngineStatus() {
    const el = document.getElementById('multi-engine-status');
    if (!el) return;
    if (_multiEngineRunning) {
        const upd = neoMultiState.markets.BTC && neoMultiState.markets.BTC.lastUpdate ? Math.round((Date.now() - neoMultiState.markets.BTC.lastUpdate) / 1000) : null;
        el.innerHTML = `<span style="color:#14f195;">&#9679;</span> multi-markt engine actief${upd != null ? ` &middot; ${upd}s geleden ververst` : ''}`;
        el.style.color = 'var(--text-dim)';
    } else {
        el.innerHTML = `<span style="color:#ff4f6d;">&#9679;</span> multi-markt engine uit`;
        el.style.color = 'var(--text-dim)';
    }
}
window.updateMultiEngineStatus = updateMultiEngineStatus;

// WATCHDOG: als de bot draait maar de multi-engine (na een refresh/crash) niet, herstart
// hem automatisch. Draait elke 15s en is idempotent - lost de "engine lijkt uit na
// refresh"-situatie op zonder dat je hem handmatig moet aanzetten.
function _multiEngineWatchdog() {
    try {
        const botOn = (typeof isBotRunning !== 'undefined' && isBotRunning) || (botSettings && botSettings.isRunning);
        if (botOn && !_multiEngineRunning) {
            console.log('Watchdog: multi-markt engine herstart (bot draait, engine lag stil).');
            startMultiAssetEngine();
        }
        updateMultiEngineStatus();
    } catch (e) {}
}
if (window._multiWatchdog) clearInterval(window._multiWatchdog);
window._multiWatchdog = setInterval(_multiEngineWatchdog, 15 * 1000);

// ============================================================
// FUNDAMENTALS & CROSS-MARKET MOTOR (01-08)
// ============================================================
// Crypto heeft geen winst/omzet zoals aandelen, maar wél datasignalen die op korte
// termijn voorspellend zijn: funding rate (of longs/shorts de markt domineren - sterk
// mean-reverting), open interest (hoeveel hefboom er in zit), en de long/short account
// ratio. Plus cross-market: BTC leidt de markt, dus BTC-momentum voorspelt deels ETH/SOL.
// Elk signaal krijgt bewust een BESCHEIDEN gewicht - ze zijn nuttig maar niet heilig
// (funding kan lang extreem blijven, order book is manipuleerbaar, correlatie ontkoppelt).
const FUND_BINANCE = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
function _emptyFund() {
    return { fundingRate: null, openInterest: null, oiPrev: null, longShortRatio: null, btcCorr: null, lastUpdate: 0, error: null };
}

async function refreshFundamentals(sym) {
    const m = neoMultiState.markets[sym];
    if (!m) return;
    if (!m.fund) m.fund = _emptyFund();
    const pair = FUND_BINANCE[sym];
    try {
        // 1) funding rate (premiumIndex) - gewicht 1
        const fr = await bFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`).then(r => r.ok ? r.json() : null);
        if (fr && fr.lastFundingRate != null) m.fund.fundingRate = parseFloat(fr.lastFundingRate);
        // 2) open interest - gewicht 1
        const oi = await bFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`).then(r => r.ok ? r.json() : null);
        if (oi && oi.openInterest != null) {
            const val = parseFloat(oi.openInterest);
            m.fund.oiPrev = m.fund.openInterest;
            m.fund.openInterest = val;
        }
        // 3) long/short account ratio (laatste 5m-punt) - gewicht 1
        const ls = await bFetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=5m&limit=1`).then(r => r.ok ? r.json() : null);
        if (Array.isArray(ls) && ls.length && ls[0].longShortRatio != null) m.fund.longShortRatio = parseFloat(ls[0].longShortRatio);
        m.fund.error = null; m.fund.lastUpdate = Date.now();
    } catch (e) {
        m.fund.error = e.message || 'futures-fetch-fout';
    }
}

// BTC-correlatie: hoe sterk volgt deze munt de recente BTC-beweging? Simpele maat via
// de richting-overeenkomst van de laatste candle-returns. +1 = beweegt met BTC mee.
function computeBtcCorrelation(sym) {
    try {
        if (sym === 'BTC') return 1;
        const btc = neoMultiState.markets.BTC, m = neoMultiState.markets[sym];
        if (!btc || !m || !btc.klines || !m.klines || btc.klines.length < 30 || m.klines.length < 30) return null;
        const rets = (kl) => { const c = kl.slice(-30).map(d => parseFloat(d[4])); return c.slice(1).map((x, i) => (x - c[i]) / c[i]); };
        const rb = rets(btc.klines), rm = rets(m.klines);
        const n = Math.min(rb.length, rm.length);
        if (n < 10) return null;
        // Pearson-correlatie van de returns
        let mb = 0, mm = 0; for (let i = 0; i < n; i++) { mb += rb[i]; mm += rm[i]; }
        mb /= n; mm /= n;
        let cov = 0, vb = 0, vm = 0;
        for (let i = 0; i < n; i++) { const a = rb[i] - mb, b = rm[i] - mm; cov += a * b; vb += a * a; vm += b * b; }
        const denom = Math.sqrt(vb * vm);
        return denom > 0 ? cov / denom : null;
    } catch (e) { return null; }
}

async function refreshFundamentalsAll() {
    for (const sym of MULTI_SYMBOLS) {
        await refreshFundamentals(sym);
        const m = neoMultiState.markets[sym];
        if (m && m.fund) m.fund.btcCorr = computeBtcCorrelation(sym);
    }
    try { if (typeof renderSystemDataTab === 'function' && neoMultiState.active) renderSystemDataTab(neoMultiState.active); } catch (e) {}
}
window.refreshFundamentalsAll = refreshFundamentalsAll;

// Vertaal de fundamentals naar een richting-bias (-1..+1) voor een munt. Positief =
// bullish. Elk deel-signaal is klein en genormaliseerd; samen vormen ze een bescheiden
// duwtje bovenop de technische score, geen dominante factor.
function fundamentalsBias(sym) {
    const m = neoMultiState.markets[sym];
    if (!m || !m.fund) return { bias: 0, parts: {} };
    const f = m.fund;
    const parts = {};
    let bias = 0;
    // Funding rate: MEAN-REVERTING. Hoge positieve funding = longs betalen veel = markt
    // te bullish gepositioneerd = contrair bearish signaal (en omgekeerd).
    if (f.fundingRate != null) {
        const fr = Math.max(-0.0015, Math.min(0.0015, f.fundingRate));  // clamp extremen
        parts.funding = -Math.tanh(fr * 2000) * 0.4;   // tegengesteld, bescheiden
        bias += parts.funding;
    }
    // Long/short ratio: ook contrair. Veel meer longs dan shorts = overvol aan één kant.
    if (f.longShortRatio != null) {
        const dev = f.longShortRatio - 1;   // >1 = meer longs
        parts.longShort = -Math.tanh(dev * 1.5) * 0.3;
        bias += parts.longShort;
    }
    // Open interest verandering: stijgende OI + stijgende prijs = sterke trend (bevestigend).
    if (f.openInterest != null && f.oiPrev != null && f.oiPrev > 0) {
        const oiChg = (f.openInterest - f.oiPrev) / f.oiPrev;
        const priceUp = (m.ema != null && m.emaSlow != null) ? (m.ema > m.emaSlow) : true;
        parts.oi = Math.tanh(oiChg * 20) * (priceUp ? 0.2 : -0.2);
        bias += parts.oi;
    }
    // BTC-correlatie x BTC-momentum: als deze munt sterk met BTC correleert en BTC stijgt,
    // dan is dat een cross-market rugwind (en omgekeerd). Alleen voor ETH/SOL.
    if (sym !== 'BTC' && f.btcCorr != null) {
        const btc = neoMultiState.markets.BTC;
        if (btc && btc.ema != null && btc.emaSlow != null && btc.emaSlow > 0) {
            const btcMom = Math.tanh((btc.ema - btc.emaSlow) / btc.emaSlow * 200);
            parts.crossBtc = f.btcCorr * btcMom * 0.35;
            bias += parts.crossBtc;
        }
    }
    return { bias: Math.max(-1, Math.min(1, bias)), parts };
}
window.fundamentalsBias = fundamentalsBias;



// Detecteer capitulaties in een kline-serie: candles met een extreme |VFM| die tevens
// een lokale prijs-omkering markeren. Geeft een lijst {time, price, vfm, dir}.
function nnDetectCapitulations(kl) {
    if (!kl || kl.length < 40) return [];
    const caps = [];
    // rolling VFM per candle
    const vfmSeries = [];
    for (let i = 20; i < kl.length; i++) {
        const hist = kl.slice(i - 20, i + 1);
        const c = parseFloat(kl[i][4]), v = parseFloat(kl[i][5]);
        const vfm = calculateVFM(c, v, hist);
        vfmSeries.push({ i, t: kl[i][0], price: c, vfm: isFinite(vfm) ? vfm : 0 });
    }
    // drempel: |VFM| in de top ~20% van de recente reeks (was top 10%). Meer NN-punten
    // detecteren zoals gevraagd - lagere drempel vangt ook de kleinere ontladingen.
    const absSorted = vfmSeries.map(s => Math.abs(s.vfm)).sort((a, b) => a - b);
    const thr = Math.max(0.9, absSorted[Math.floor(absSorted.length * 0.80)] || 1.2);
    for (let k = 2; k < vfmSeries.length - 2; k++) {
        const s = vfmSeries[k];
        if (Math.abs(s.vfm) < thr) continue;
        // lokale omkering: prijs draait binnen ±1 candle (soepeler = meer punten)
        const p0 = vfmSeries[k - 1].price, p1 = s.price, p2 = vfmSeries[k + 1].price;
        const isLow = p1 <= p0 && p1 <= p2, isHigh = p1 >= p0 && p1 >= p2;
        if (!isLow && !isHigh) continue;
        // niet te dicht op de vorige (minstens 3 candles ertussen, was 5)
        if (caps.length && (s.i - caps[caps.length - 1].i) < 3) {
            if (Math.abs(s.vfm) > Math.abs(caps[caps.length - 1].vfm)) caps[caps.length - 1] = { i: s.i, time: s.t, price: s.price, vfm: s.vfm, dir: isLow ? 'low' : 'high' };
            continue;
        }
        caps.push({ i: s.i, time: s.t, price: s.price, vfm: s.vfm, dir: isLow ? 'low' : 'high' });
    }
    return caps;
}

// Bereken/actualiseer de NN-staat voor een munt uit zijn kline-serie.
function nnCompute(sym, kl) {
    if (!_nnState[sym]) _nnState[sym] = _emptyNN();
    const st = _nnState[sym];
    const caps = nnDetectCapitulations(kl);
    if (caps.length < 3) { st.caps = caps; st.anchor = caps[caps.length - 1] || null; st.period = null; st.nextNode = null; return st; }
    // empirisch ritme = mediaan van de afstanden tussen recente capitulaties (in ms)
    const recent = caps.slice(-8);
    const gaps = [];
    for (let i = 1; i < recent.length; i++) gaps.push(recent[i].time - recent[i - 1].time);
    gaps.sort((a, b) => a - b);
    const periodMs = gaps[Math.floor(gaps.length / 2)];
    const newAnchor = caps[caps.length - 1];

    // TREFZEKERHEID: als er een vorige voorspelde node was, log hoe ver de nieuwe
    // werkelijke capitulatie ervan afweek (alleen bij een echt nieuw anker).
    if (st.anchor && newAnchor.time > st.anchor.time && st.nextNode) {
        const errMin = Math.abs(newAnchor.time - st.nextNode) / 60000;
        const periodMin = (st.period || periodMs) / 60000;
        st.log.push({
            at: newAnchor.time,
            predicted: st.nextNode,
            actual: newAnchor.time,
            errorMin: Math.round(errMin),
            errorPct: periodMin ? Math.round((errMin / periodMin) * 100) : null,
            dir: newAnchor.dir
        });
        if (st.log.length > 200) st.log = st.log.slice(-200);
    }

    st.caps = caps;
    st.anchor = newAnchor;
    st.period = periodMs;
    st.nextNode = newAnchor.time + periodMs;   // volgende verwachte node (reset bij nieuwe capitulatie)
    st.lastComputedAt = Date.now();

    // UITGEBREID (01-08): projecteer een REEKS toekomstige NN-nodes op het gemeten
    // ritme, plus tussenliggende sub-nodes (halve-node punten, zoals de standaard
    // OSC-punten tussen de hoofdnodes). Elk krijgt een type + relatieve sterkte.
    const proj = [];
    const HALF = periodMs / 2;
    // NN-node-types cyclus (afgeleid uit de anker-richting): een reeks die om en om
    // een verwachte omkering (RESET) en tussenliggende oscillatie (OSC/PULSE) markeert.
    const nnTypes = ['NN-RESET', 'NN-OSC', 'NN-PULSE', 'NN-OSC'];
    for (let k = 1; k <= 12; k++) {
        const t = newAnchor.time + k * HALF;
        const isMain = (k % 2 === 0);                  // hele node = verwachte omkering
        const typeIdx = ((k / 2) | 0) % nnTypes.length;
        proj.push({
            time: t,
            main: isMain,
            type: isMain ? nnTypes[typeIdx] : 'NN-SUB',
            strength: isMain ? 1.0 : 0.5
        });
    }
    st.projected = proj;
    return st;
}

// Meet hoe dicht de huidige tijd bij een NN-node zit (0..1), voor de trade-invloed.
// Retourneert ook of het een hoofd- of sub-node is en het type.
function nnProximity(sym = 'BTC', now = Date.now()) {
    const st = _nnState[sym];
    if (!st || !st.projected || !st.period) return { prox: 0, main: false, type: null, minsTo: null };
    let best = null, bestDist = Infinity;
    // check ook de eerstvolgende reeds-voorbije en komende nodes
    for (const p of st.projected) {
        const d = Math.abs(p.time - now);
        if (d < bestDist) { bestDist = d; best = p; }
    }
    if (!best) return { prox: 0, main: false, type: null, minsTo: null };
    const minsTo = (best.time - now) / 60000;
    // nabijheids-gewicht: piek als we op de node zitten, valt af met ~halve node-breedte
    const widthMin = (st.period / 60000) * 0.35;
    const prox = Math.exp(-Math.pow((bestDist / 60000) / widthMin, 2));
    return { prox, main: best.main, type: best.type, minsTo, strength: best.strength };
}

// NN-context voor de UI: countdown tot de volgende NN-node (kan resetten) + trefzekerheid.
// NN-HANDELSINVLOED (01-08): vertaalt de nabijheid van een NN-node naar een kleine,
// begrensde bijdrage aan de kans-score. Een NN-hoofdnode (verwachte omkering) dicht bij
// nu versterkt een tegengesteld signaal (mean-reversion aan een verwacht keerpunt); een
// NN-sub-node (oscillatie) geeft een zwakkere bijdrage. Begrensd op ±6, met eigen gewicht.
function calculateNNInfluence(side) {
    try {
        const p = nnProximity('BTC');
        if (!p || p.prox < 0.15) return 0;
        // richting: bij een verwachte NN-omkering (hoofdnode) is een keerpunt waarschijnlijker.
        // We laten NN het huidige signaal licht bevestigen naar rato van nabijheid+sterkte.
        const base = p.prox * (p.strength || 0.5) * 6;
        return Math.max(-6, Math.min(6, base));
    } catch (e) { return 0; }
}

// NODE-CONFLUENTIE (01-08): detecteert wanneer een STANDAARD UOTAM-node en een NEO'S
// NODE (NN) dicht bij elkaar in de tijd vallen. De hypothese (nog te toetsen) is dat
// zo'n samenval het sterkste signaal geeft. Geeft een confluentie-score 0..1 + de tijd
// tot het volgende confluentie-moment, met een eigen adaptief gewicht.
let _nodeConfluenceState = { nextConfluence: null, lastComputed: 0, log: [] };
function computeNodeConfluence(now = Date.now()) {
    try {
        const st = _nnState['BTC'];
        if (!st || !st.projected || !st.period) return { score: 0, minsTo: null };
        // standaard node-tijden in de komende periode
        const HALF_MS = T_PI_MS / 2;
        const stdNodes = [];
        for (let k = 0; k <= 12; k++) {
            const idx = Math.ceil((now - ANCHOR_TIME) / HALF_MS) + k;
            stdNodes.push(ANCHOR_TIME + idx * HALF_MS);
        }
        // zoek het dichtstbijzijnde paar (standaard-node, NN-node)
        let bestGap = Infinity, bestTime = null;
        for (const nn of st.projected) {
            for (const sd of stdNodes) {
                const gap = Math.abs(nn.time - sd);
                if (gap < bestGap) { bestGap = gap; bestTime = Math.min(nn.time, sd); }
            }
        }
        if (bestTime == null) return { score: 0, minsTo: null };
        // confluentie-score: hoog als de twee node-systemen samenvallen (kleine gap)
        const tolMin = (st.period / 60000) * 0.20;                 // 20% van de NN-periode als tolerantie
        const gapMin = bestGap / 60000;
        const score = Math.exp(-Math.pow(gapMin / tolMin, 2));
        _nodeConfluenceState.nextConfluence = bestTime;
        return { score, minsTo: (bestTime - now) / 60000, gapMin: Math.round(gapMin) };
    } catch (e) { return { score: 0, minsTo: null }; }
}

// Confluentie-invloed op de trade (eigen gewicht). Sterkste bijdrage precies wanneer
// standaard-node en NN-node samenvallen EN we daar dichtbij zitten in de tijd.
function calculateConfluenceNodeInfluence(side) {
    try {
        const c = computeNodeConfluence();
        if (!c || c.score < 0.2 || c.minsTo == null) return 0;
        // alleen invloed als het confluentie-moment dichtbij is
        const st = _nnState['BTC'];
        const periodMin = st && st.period ? st.period / 60000 : 180;
        const nearTime = Math.exp(-Math.pow(c.minsTo / (periodMin * 0.3), 2));
        return Math.max(-6, Math.min(6, c.score * nearTime * 6));
    } catch (e) { return 0; }
}
window.computeNodeConfluence = computeNodeConfluence;

function nnContext(sym = 'BTC', now = Date.now()) {
    const st = _nnState[sym];
    if (!st || !st.nextNode || !st.period) return null;
    // als de voorspelde node al voorbij is zonder nieuwe capitulatie, projecteer door
    // op hetzelfde ritme (de klok tikt door tot de echte capitulatie hem reset)
    let next = st.nextNode;
    while (next < now) next += st.period;
    const acc = nnAccuracy(sym);
    return {
        anchorTime: st.anchor ? st.anchor.time : null,
        anchorDir: st.anchor ? st.anchor.dir : null,
        periodMin: st.period / 60000,
        nextNode: next,
        minutesUntil: Math.max(0, (next - now) / 60000),
        capsFound: st.caps.length,
        accuracy: acc
    };
}

// Samenvattende trefzekerheid: gemiddelde absolute fout (min) en als % van de periode.
function nnAccuracy(sym = 'BTC') {
    const st = _nnState[sym];
    if (!st || !st.log.length) return null;
    const n = st.log.length;
    const avgErrMin = st.log.reduce((a, l) => a + l.errorMin, 0) / n;
    const avgErrPct = st.log.filter(l => l.errorPct != null).reduce((a, l, _, arr) => a + l.errorPct / arr.length, 0);
    return { samples: n, avgErrorMin: Math.round(avgErrMin), avgErrorPct: Math.round(avgErrPct) };
}
window.nnContext = nnContext;
window.nnAccuracy = nnAccuracy;

function renderNodeMarkers() {
    updateAllChartMarkers();
}

// NIEUW: patroon-markers en node-markers delen hetzelfde onderliggende
// marker-systeem (nodeMarkersPlugin.setMarkers() vervangt de VORIGE set
// volledig) - dus moeten ze samengevoegd worden vóór het tekenen, anders
// overschrijft de een de ander.
let patternMarkers = [];
let showPatternMarkers = false;
let nnMarkers = [];              // Neo's Node markers (capitulaties + volgende voorspelde node)
let showNNMarkers = false;      // toggle via de chart-dropdown
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
    let combined = showPatternMarkers ? [...visibleNodeMarkers, ...patternMarkers] : [...visibleNodeMarkers];
    if (showNNMarkers) combined = [...combined, ...nnMarkers];
    // Lightweight Charts vereist markers gesorteerd op tijd
    combined.sort((a, b) => a.time - b.time);
    setChartMarkers(combined);
}

// Teken Neo's Node markers: de gedetecteerde capitulaties (echte ontladingen) +
// de eerstvolgende voorspelde NN-node. Passief - beïnvloedt geen trades.
function renderNNMarkers() {
    nnMarkers = [];
    // munt-bewust: BTC gebruikt de handels-data, ETH/SOL de achtergrond-klines
    const sym = (typeof neoMultiState !== 'undefined' && neoMultiState) ? neoMultiState.active : 'BTC';
    let src;
    if (sym === 'BTC') {
        src = (viewData && viewData.length) ? viewData : rawData;
    } else {
        const m = neoMultiState.markets[sym];
        src = (m && m.klines && m.klines.length) ? m.klines : null;
    }
    if (!showNNMarkers || !src || src.length < 40) { updateAllChartMarkers(); return; }
    try {
        const st = nnCompute(sym, src);
        // capitulatie-markers (laatste ~12) in NN-kleur (amber/violet)
        const recentCaps = (st.caps || []).slice(-12);
        for (const c of recentCaps) {
            nnMarkers.push({
                time: Math.floor(c.time / 1000),
                position: c.dir === 'low' ? 'belowBar' : 'aboveBar',
                color: c.dir === 'low' ? '#14f195' : '#ff4fd8',
                shape: c.dir === 'low' ? 'arrowUp' : 'arrowDown',
                text: `NN ${c.dir === 'low' ? '\u25B2' : '\u25BC'} cap`
            });
        }
        // volgende voorspelde NN-nodes (reeks) + sub-nodes
        const st2 = _nnState[sym];
        if (st2 && st2.projected) {
            for (const p of st2.projected.slice(0, 6)) {
                nnMarkers.push({
                    time: Math.floor(p.time / 1000),
                    position: 'aboveBar',
                    color: p.main ? '#c792ea' : 'rgba(199,146,234,0.5)',
                    shape: 'circle',
                    text: p.main ? `NN \u25C9 ${p.type.replace('NN-','')}` : 'NN \u00b7'
                });
            }
        }
        // node-confluentie: markeer het volgende samenval-moment (standaard \u00d7 NN)
        // (alleen voor BTC - de standaard UOTAM-nodes zijn op de BTC-anker gebaseerd)
        if (sym === 'BTC') try {
            const c = computeNodeConfluence();
            if (c && c.minsTo != null && c.score > 0.3) {
                const when = Date.now() + c.minsTo * 60000;
                nnMarkers.push({
                    time: Math.floor(when / 1000),
                    position: 'belowBar',
                    color: '#ffb627',
                    shape: 'arrowUp',
                    text: `\u2605 CONFLUENTIE ${(c.score*100|0)}%`
                });
            }
        } catch (e) {}
    } catch (e) { /* stil - NN is passief */ }
    updateAllChartMarkers();
}
window.renderNNMarkers = renderNNMarkers;

function handleNNMarkersSelect(value) {
    showNNMarkers = (value === 'VISIBLE');
    renderNNMarkers();
}
window.handleNNMarkersSelect = handleNNMarkersSelect;

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
            
                // UI Updates voor de meters (alleen als de BTC-tab actief is; anders
                // toont renderSystemDataTab de waarden van de gekozen munt en zou de
                // live BTC-loop die telkens overschrijven).
                const _btcTabActive = (typeof neoMultiState === 'undefined') || !neoMultiState || neoMultiState.active === 'BTC';
                const absVfm = Math.abs(vfm);
                const vfmEl = document.getElementById('vfm-display');
                const vfmStatusEl = document.getElementById('vfm-status');
                if (_btcTabActive && vfmEl) { vfmEl.innerText = vfm.toFixed(3); vfmEl.style.color = (absVfm < 0.1) ? "#808080" : ((vfm > 0) ? "#00ffcc" : "#ef5350"); }
                if (_btcTabActive && vfmStatusEl) { vfmStatusEl.innerText = (absVfm < 0.1) ? "NEUTRAAL" : (absVfm > 1.5 ? "EXTREME" : "SIGNIFICANT"); vfmStatusEl.style.color = vfmEl.style.color; }
            
                const updateMetric = (id, val, status) => {
                    if (!_btcTabActive) return;
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
                    if (_btcTabActive && statusDisplay) statusDisplay.innerText = `${decisionResult.decision}`;

                    // FRACTALE TARGETS UPDATE
                    if (_btcTabActive && decisionResult.targets) {
                        document.getElementById('mic-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.micro.bullish));
                        document.getElementById('mic-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.micro.bearish));
                        document.getElementById('mes-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.meso.bullish));
                        document.getElementById('mes-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.meso.bearish));
                        document.getElementById('mac-bull').innerText = formatChartPrice(parseFloat(decisionResult.targets.macro.bullish));
                        document.getElementById('mac-bear').innerText = formatChartPrice(parseFloat(decisionResult.targets.macro.bearish));
                    }

                    // Confidence Score
                    const confEl = document.getElementById('probability-score');
                    if (_btcTabActive && confEl) {
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

// DYNAMISCHE L3-CAP: het maximale gewicht dat het getrainde net (L3) in de
// beslissing mag krijgen, gekoppeld aan het aantal SCHONE trades van de huidige
// config. Meer bewijs -> hoger plafond (per ~20 trades +5%, tot 55%); daalt het
// aantal (bv. na een config-wijziging die de schone-telling reset), dan zakt de cap
// autonoom mee. Het uiteindelijke L3-gewicht = deze cap x de accuraatheids-ramp.
function l3WeightCap() {
    let n = 0;
    try {
        const cfg = (typeof currentConfigVersion === 'function') ? currentConfigVersion() : null;
        n = learningLog.filter(l => !l.manual && l.outcome && (cfg == null || l.configVersion === cfg)).length;
    } catch (e) {}
    const cap = Math.min(0.55, 0.10 + Math.floor(n / 20) * 0.05);
    return { cap, n };
}
window.l3WeightCap = l3WeightCap;

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
let _eyeBits = [], _eyeCX = 500, _eyeCY = 200, _eyeR = 150, _eyePupil = null, _eyeHalo = null, _eyeConf = null;
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
        host.appendChild(mk('path', { d, fill: 'none', stroke: HUD_BLUE[a % 5], 'stroke-width': 0.5, opacity: 0.1, id: 'weArm' + a }));
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

// De actuele oog-richting ('bull' | 'bear' | 'neutral') - stuurt de kleuren
// van alle ogen. Hersteld: deze declaratie verdween per ongeluk bij het
// verwijderen van de bouwgolf-code.
let EYE_SIGNAL = 'neutral';

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
    let cal = beste === null ? null : calibrateProbability(beste);
    // Fallback: heeft BTC geen live kans (ETH/SOL zijn nu de workhorse), gebruik dan de
    // beste gekalibreerde kans over alle markten (Osiris/DeepNet) zodat de edge waarde toont.
    if (cal === null && typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.last) {
        let best = 0;
        for (const k of ['BTC', 'ETH', 'SOL']) { const p = OsirisDeepNet.last[k]; if (p && p.calProb != null) best = Math.max(best, p.calProb * 100, (1 - p.calProb) * 100); }
        if (best > 0) cal = best;
    }
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
const _CALIB_COL = { BTC: '#ffb627', ETH: '#627eea', SOL: '#14f195', OSIRIS: '#00d9ff' };
// Tekent één predicted-vs-measured curve in #calib-plot.
function _drawCalibCurve(map, n, provisional, col, label, xMin) {
    const plot = document.getElementById('calib-plot');
    const note = document.getElementById('calib-note');
    if (!plot) return;
    xMin = (xMin == null) ? 50 : xMin;
    const xlo = document.getElementById('calib-xlab-lo'), xhi = document.getElementById('calib-xlab-hi');
    if (xlo) xlo.textContent = xMin; if (xhi) xhi.textContent = 100;
    const head = document.getElementById('calib-headline');
    if (!map || map.length < 1) {
        plot.innerHTML = '';
        if (head) { head.textContent = `${label} \u2014 nog geen data`; head.style.color = '#5c7488'; }
        if (note) note.textContent = `${label}: wacht op trades m\u00e9t entry-kans (nu ${n}).`;
        return;
    }
    const single = map.length < 2;   // weinig spreiding -> 1 kalibratiepunt i.p.v. een curve
    if (head) {
        const gap = map.reduce((a, [r, w]) => a + (r - w), 0) / map.length;
        if (gap > 5) { head.textContent = `${label} is overconfident.`; head.style.color = 'var(--amber)'; }
        else if (gap < -5) { head.textContent = `${label} onderschat zichzelf.`; head.style.color = 'var(--teal)'; }
        else { head.textContent = `${label} is goed gekalibreerd.`; head.style.color = 'var(--teal)'; }
    }
    const X = r => 8 + (Math.min(100, Math.max(xMin, r)) - xMin) / (100 - xMin) * 86;
    const Y = w => 50 - Math.min(100, Math.max(0, w)) / 100 * 46;
    let svg = '';
    if (!single) {
        const pts = map.map(([r, w]) => `${X(r).toFixed(1)},${Y(w).toFixed(1)}`).join(' ');
        svg += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    map.forEach(([r, w], i) => {
        const toon = single || i === map.length - 1;
        svg += `<circle cx="${X(r).toFixed(1)}" cy="${Y(w).toFixed(1)}" r="${toon ? 1.8 : 1.1}" fill="${col}"/>`;
        if (toon) svg += `<text x="${(X(r) - 3).toFixed(1)}" y="${(Y(w) - 3).toFixed(1)}" font-size="4" font-weight="bold" fill="${col}" text-anchor="middle" font-family="'JetBrains Mono',monospace">${w.toFixed(0)}%</text>`;
    });
    plot.innerHTML = svg;
    const upd = document.getElementById('calib-updated');
    if (upd) {
        const nu = new Date();
        const d = String(nu.getDate()).padStart(2, '0'), m = String(nu.getMonth() + 1).padStart(2, '0');
        const hh = String(nu.getHours()).padStart(2, '0'), mm = String(nu.getMinutes()).padStart(2, '0'), ss = String(nu.getSeconds()).padStart(2, '0');
        upd.textContent = `last updated ${d}-${m} ${hh}:${mm}:${ss} \u00b7 ${n} trades`;
    }
    if (note) {
        if (single) note.textContent = `${label} \u00b7 ${n} trades \u00b7 voorspellingen clusteren rond ${map[0][0].toFixed(0)}% \u2014 1 kalibratiepunt (te weinig spreiding voor een curve). Gemeten winrate daar: ${map[0][1].toFixed(0)}%.`;
        else note.textContent = `${label} \u00b7 ${n} trades \u00b7 ${provisional ? 'VOORLOPIG (kleine steekproef) \u00b7 ' : ''}hoe verder onder de stippellijn, hoe overmoediger de score.`;
    }
}
// Tekent de curve van het ACTIEVE brein (wordt ook door de live-loop aangeroepen).
function _calibInsight(rel) {
    if (!rel || !rel.map || !rel.map.length) return 'onvoldoende data';
    const pts = rel.map.slice().sort((a, b) => a[0] - b[0]); // [voorspeldPct, gemetenPct]
    if (pts.length < 2) return 'onvoldoende data';
    const bias = pts.reduce((a, p) => a + (p[0] - p[1]), 0) / pts.length;        // + = voorspelt hoger dan werkelijk
    const ece  = pts.reduce((a, p) => a + Math.abs(p[0] - p[1]), 0) / pts.length; // absolute fout (ECE)
    const trend = pts[pts.length - 1][1] - pts[0][1];                             // stijgt gemeten mee met voorspeld?
    let up = 0, down = 0;
    for (let i = 1; i < pts.length; i++) { const d = pts[i][1] - pts[i - 1][1]; if (d > 0.5) up++; else if (d < -0.5) down++; }
    // 1) INVERSIE: gemeten daalt terwijl voorspeld stijgt -> model omgekeerd, niet vertrouwen (bv. ETH)
    if (pts.length >= 3 && trend < -8 && down >= up)
        return `INVERSIE (ECE ${ece.toFixed(0)}pt) - curve omgekeerd, niet vertrouwen`;
    // 2) geen bruikbare rangschikking (vlak/ruis)
    if (pts.length >= 3 && up === 0 && down === 0)
        return `geen discriminatie (ECE ${ece.toFixed(0)}pt)`;
    // 3) systematische bias (herstelbaar via kalibratie)
    if (bias > 5)  return `overconfident (+${bias.toFixed(0)}pt, ECE ${ece.toFixed(0)}pt) - voorspelt hoger dan werkelijk`;
    if (bias < -5) return `onderconfident (${bias.toFixed(0)}pt, ECE ${ece.toFixed(0)}pt) - voorspelt lager dan werkelijk`;
    if (ece > 12)  return `wisselvallig (ECE ${ece.toFixed(0)}pt)`;
    return 'goed gekalibreerd';
}
// Downloadt de volledige Adaptive Learning-staat als leesbaar JSON-rapport.
function downloadAdaptiveLearning() {
    try {
        const now = new Date();
        const dn = (typeof OsirisDeepNet !== 'undefined') ? OsirisDeepNet : null;
        const ll = (typeof learningLog !== 'undefined') ? learningLog : [];
        const nms = (typeof neoMultiState !== 'undefined') ? neoMultiState : null;
        const report = {
            exportedAt: now.toISOString(),
            configVersion: (typeof currentConfigVersion === 'function') ? currentConfigVersion() : null,
            wallet: (typeof walletState !== 'undefined' && walletState) ? {
                balance: walletState.balance,
                equity: (typeof getEquity === 'function') ? getEquity() : null,
                realizedPnL: walletState.realizedPnL, wins: walletState.wins, losses: walletState.losses
            } : null,
            brains: {}, level2: {}, level3: {}, osirisMainbrain: {}
        };
        for (const b of ['BTC', 'ETH', 'SOL']) {
            const trades = ll.filter(l => b === 'BTC' ? (l.market == null || l.market === 'BTC') : l.market === b);
            const wins = trades.filter(l => l.outcome === 'win').length;
            const m = (dn && dn.markets[b]) ? dn.markets[b] : {};
            const last = (dn && dn.last[b]) ? dn.last[b] : null;
            const rel = dn ? dn.calibrationCurve(b) : null;
            report.brains[b] = {
                trades: trades.length, wins, losses: trades.length - wins,
                winratePct: trades.length ? +(wins / trades.length * 100).toFixed(1) : null,
                level1_weights: b === 'BTC'
                    ? ((typeof adaptiveWeights !== 'undefined') ? adaptiveWeights : null)
                    : ((nms && nms.markets && nms.markets[b] && nms.markets[b].brain) ? (nms.markets[b].brain.weights || null) : null),
                deepNet: {
                    walkForward: m.wf || null,
                    trainedAt: m.trainedMs ? new Date(m.trainedMs).toISOString() : null,
                    liveCalibratedPct: last ? +(last.calProb * 100).toFixed(1) : null,
                    liveSide: last ? last.side : null,
                    rawSide: last ? last.rawSide : null,
                    inverted: last ? !!last.inverted : false,
                    proven: last ? !!last.proven : false,
                    dirHitRate: (dn && dn._dirRes && dn._dirRes[b] && dn._dirRes[b].length) ? +(dn._dirRes[b].reduce((a, x) => a + x, 0) / dn._dirRes[b].length).toFixed(3) : null,
                    dirN: (dn && dn._dirRes && dn._dirRes[b]) ? dn._dirRes[b].length : 0,
                    metaPoortOpen: last ? last.meta : null,
                    reliabilityCurve: (rel && rel.map) ? rel.map.map(p => ({ predictedPct: +p[0].toFixed(1), measuredPct: +p[1].toFixed(1) })) : null,
                    kalibratieOordeel: _calibInsight(rel)
                }
            };
        }
        report.level2 = (typeof _l2 !== 'undefined' && _l2 && _l2.trained)
            ? { trained: true, trainedOn: _l2.trainedOn, lastTrainMs: _l2.lastTrainMs || null } : { trained: false, note: 'BTC-only model' };
        report.level3 = (typeof _l3 !== 'undefined' && _l3 && _l3.trained)
            ? { trained: true, valAcc: _l3.valAcc, trainedOn: _l3.trainedOn, weightCap: (typeof l3WeightCap === 'function' ? l3WeightCap() : null) } : { trained: false, note: 'BTC-only net' };
        const osRel = dn ? dn.calibrationCurve('OSIRIS') : null;
        report.osirisMainbrain = {
            reliabilityCurve: (osRel && osRel.map) ? osRel.map.map(p => ({ predictedPct: +p[0].toFixed(1), measuredPct: +p[1].toFixed(1) })) : null,
            kalibratieOordeel: _calibInsight(osRel)
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `osiris_adaptive_learning_${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { console.warn('download-fout', e); alert('Download mislukt: ' + e.message); }
}
window.downloadAdaptiveLearning = downloadAdaptiveLearning;

// Losse export van de getrainde DeepNet-modellen (per markt: model-gewichten,
// Platt-kalibratie, walk-forward) + L2/L3. Best-effort serialisatie: typed
// arrays -> gewone arrays, functies weggelaten, per markt in eigen try zodat
// een enkel kapot model de rest niet blokkeert. ADD-only, raakt geen trading.
function downloadDeepNetModels() {
    try {
        const dn = (typeof OsirisDeepNet !== 'undefined') ? OsirisDeepNet : null;
        if (!dn) { alert('DeepNet nog niet ge\u00efnitialiseerd.'); return; }
        const safe = (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);
        const out = { exportedAt: new Date().toISOString(), markets: {}, level2: null, level3: null };
        for (const b of ['BTC', 'ETH', 'SOL']) {
            const m = (dn.markets && dn.markets[b]) ? dn.markets[b] : {};
            const rec = {
                trainedMs: m.trainedMs || null,
                trainedAt: m.trainedMs ? new Date(m.trainedMs).toISOString() : null,
                walkForward: m.wf || null,
                platt: (m.platt != null) ? m.platt : null,
                reliabilityCurve: (typeof dn.calibrationCurve === 'function' && dn.calibrationCurve(b)) ? dn.calibrationCurve(b).map : null,
                kalibratieOordeel: (typeof dn.calibrationCurve === 'function') ? _calibInsight(dn.calibrationCurve(b)) : null,
                model: null
            };
            try { rec.model = m.model ? JSON.parse(JSON.stringify(m.model, safe)) : null; }
            catch (e) { rec.model = '(niet-serialiseerbaar)'; }
            out.markets[b] = rec;
        }
        try { if (typeof _l2 !== 'undefined' && _l2) out.level2 = JSON.parse(JSON.stringify(_l2, safe)); } catch (e) {}
        try { if (typeof _l3 !== 'undefined' && _l3) out.level3 = JSON.parse(JSON.stringify(_l3, safe)); } catch (e) {}
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `osiris_deepnet_modellen_${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { console.warn('deepnet-export', e); alert('DeepNet-export mislukt: ' + e.message); }
}
window.downloadDeepNetModels = downloadDeepNetModels;

function _drawCalibInto(plotId, headId, map, n, provisional, col, label, xMin, unit){
    var plot=document.getElementById(plotId); if(!plot) return;
    unit=unit||'trades';
    xMin=(xMin==null)?50:xMin;
    var lc=plotId.replace('calib-plot-','');
    var xlo=document.getElementById('calib-xlo-'+lc); if(xlo) xlo.textContent=xMin;
    var head=document.getElementById(headId);
    if(!map||map.length<1){ plot.innerHTML=''; if(head){head.innerHTML=label+' <span style="color:#5c7488;font-weight:400">\u2014 no data yet</span>';} return; }
    var single=map.length<2;
    // kop: verdict + gemeten eindpercentage
    var gap=map.reduce(function(x,p){return x+(p[0]-p[1]);},0)/map.length;
    if(head){
        var verdict,vcol;
        if(gap>5){verdict='overconfident +'+gap.toFixed(0)+'pt';vcol='#ffb627';}
        else if(gap<-5){verdict='underconfident '+gap.toFixed(0)+'pt';vcol='#14f195';}
        else{verdict='well calibrated';vcol='#14f195';}
        head.innerHTML=label+' <span style="color:'+vcol+';font-weight:400">\u00b7 '+verdict+' \u00b7 '+n+' '+unit+'</span>';
        head.style.color=col;
    }
    // plot-area binnen de viewBox: x[30..228], y[120..12]  (0..100%)
    var X=function(r){return 30+(Math.min(100,Math.max(xMin,r))-xMin)/(100-xMin)*198;};
    var Y=function(w){return 120-Math.min(100,Math.max(0,w))/100*108;};
    var svg='';
    if(!single){
        var pts=map.map(function(p){return X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1);}).join(' ');
        // zachte glow-onderlaag + heldere progress-lijn vanaf het eerste punt
        svg+='<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.18"/>';
        svg+='<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    map.forEach(function(p,i){
        var isLast=i===map.length-1, isFirst=i===0;
        var r=isLast?4.2:2.6;
        svg+='<circle cx="'+X(p[0]).toFixed(1)+'" cy="'+Y(p[1]).toFixed(1)+'" r="'+r+'" fill="'+col+'"/>';
        if(isLast||isFirst||single){
            svg+='<text x="'+X(p[0]).toFixed(1)+'" y="'+(Y(p[1])-6).toFixed(1)+'" font-size="10" font-weight="bold" fill="'+col+'" text-anchor="middle" font-family="\'JetBrains Mono\',monospace">'+p[1].toFixed(0)+'%</text>';
        }
    });
    plot.innerHTML=svg;
}
function renderAllCalibrationCurves(){
    var C={BTC:'#f7931a',ETH:'#627eea',SOL:'#14f195',OSIRIS:'#00d9ff'};
    var dn=null; try{ if(typeof OsirisDeepNet!=='undefined') dn=OsirisDeepNet; }catch(e){}
    try{ computeCalibrationMap();
        var nb=learningLog.filter(function(l){return !l.manual&&l.entryProbabilityPct!=null&&(l.market==null||l.market==='BTC');}).length;
        _drawCalibInto('calib-plot-btc','calib-head-btc',_calibMap,nb,_calibProvisional,C.BTC,'Neo BTC',50);
    }catch(e){}
    ['ETH','SOL'].forEach(function(sym){ try{
        var c=dn?dn.calibrationCurve(sym):null; var lc=sym.toLowerCase();
        // voorkeur: de trade-gebaseerde per-markt-curve (echte trades). Alleen als die te
        // weinig data heeft, val terug op de DeepNet walk-forward-curve (label 'wf-samples').
        var r=computeCalibrationMapFor(sym);
        if(r&&r.map) _drawCalibInto('calib-plot-'+lc,'calib-head-'+lc,r.map,r.n,r.provisional,C[sym],'Neo '+sym,0,'trades');
        else if(c&&c.map) _drawCalibInto('calib-plot-'+lc,'calib-head-'+lc,c.map,c.n,c.n<60,C[sym],'Neo '+sym,0,'wf-samples');
        else _drawCalibInto('calib-plot-'+lc,'calib-head-'+lc,null,(r?r.n:0),true,C[sym],'Neo '+sym,0,'trades');
    }catch(e){} });
    try{ var o=dn?dn.calibrationCurve('OSIRIS'):null;
        var ro=computeCalibrationMapFor('OSIRIS');
        if(ro&&ro.map) _drawCalibInto('calib-plot-osiris','calib-head-osiris',ro.map,ro.n,ro.provisional,C.OSIRIS,'Osiris Mainbrain',0,'trades');
        else if(o&&o.map) _drawCalibInto('calib-plot-osiris','calib-head-osiris',o.map,o.n,o.n<60,C.OSIRIS,'Osiris Mainbrain',0,'wf-samples');
    }catch(e){}
}
function renderCalibrationCurve() {
    try{ renderAllCalibrationCurves(); }catch(e){}
    const sym = (typeof _activeCalibBrain !== 'undefined') ? _activeCalibBrain : 'BTC';
    const col = _CALIB_COL[sym] || '#ffb627';
    const label = sym === 'OSIRIS' ? 'Osiris mainbrain' : ('Neo ' + sym);
    if (sym === 'BTC') {
        computeCalibrationMap();
        const n = learningLog.filter(l => !l.manual && l.entryProbabilityPct != null && (l.market == null || l.market === 'BTC')).length;
        _drawCalibCurve(_calibMap, n, _calibProvisional, col, label, 50);
        return;
    }
    // OPTIE A: kalibreer op de DeepNet-kans (die spreidt 0-100%) i.p.v. de Osiris-pick (~55%).
    let dn = null;
    try { if (typeof OsirisDeepNet !== 'undefined') dn = OsirisDeepNet.calibrationCurve(sym); } catch (e) {}
    if (dn && dn.map) { _drawCalibCurve(dn.map, dn.n, dn.n < 60, col, label + ' (DeepNet)', 0); return; }
    // fallback zolang de DeepNet nog niet genoeg getraind heeft
    const r = computeCalibrationMapFor(sym);
    _drawCalibCurve(r.map, r.n, r.provisional, col, label, 50);
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
        const px = priceForPosition(p);   // munt-bewuste prijs
        const bruto = px ? (p.side === 'LONG' ? (px - p.entryPrice) / p.entryPrice : (p.entryPrice - px) / p.entryPrice) : 0;
        const netto = (bruto - kosten) * 100;
        let mkt = 'BTC';
        if (p.isOsiris && p.symbol && typeof MULTI_BINANCE !== 'undefined') mkt = Object.keys(MULTI_BINANCE).find(k => MULTI_BINANCE[k] === p.symbol) || 'BTC';
        const mktColor = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' }[mkt] || '#8b95a5';
        const type = p.isManual ? 'MANUAL' : (p.isOsiris ? 'OSIRIS' : (p.isScalp ? 'SCALP' : 'TREND'));
        const typeKleur = p.isManual ? '#ffb627' : (p.isOsiris ? '#00d9ff' : (p.isScalp ? '#c678dd' : '#4287f5'));
        const allocPct = positionAllocPct(p);
        return `<div class="pos-row">
            <span style="color:${typeKleur}; width:48px; flex:none;">${type}</span>
            <span style="color:${mktColor}; width:30px; flex:none; font-weight:700;">${mkt}</span>
            <span style="color:${p.side === 'LONG' ? '#00d9ff' : '#ff5f7e'}; width:30px; flex:none;">${p.side}</span>
            <span style="color:#7d99ac; width:34px; flex:none;">${allocPct.toFixed(0)}%</span>
            <span style="color:${netto >= 0 ? '#00d9ff' : '#ff5f7e'}; flex:1; text-align:right;">${netto >= 0 ? '+' : ''}${netto.toFixed(2)}%</span>
            <button class="sluit" onclick="closePositionManually('${p.id}')" title="Sluit nu">sluit</button>
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
setInterval(() => { try {
    if (_l2 && _l2.trained && typeof rawData !== 'undefined' && rawData && rawData.length > 22) l2Predict(rawData, rawData.length - 1);
    if (typeof updateL2UI === 'function') updateL2UI();
} catch (e) {} }, 2000);

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
        svg.appendChild(mk('path', { d, fill: 'none', stroke: BLUE[a % 5], 'stroke-width': 0.5, opacity: 0.1, id: hostId + 'arm' + a }));
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


// ============================================================
// NEO MARK 1 — digitaal gezicht dat zichzelf bouwt uit datastromen
// ============================================================
// Realistische 3D-kop op zwarte achtergrond (zwevend). Opgebouwd uit scan-
// ringen; gezichtskenmerken (wenkbrauwen, neusrug, neusgaten, mond, lippen,
// oren) zijn expliciete heldere contourlijnen zodat het gezicht echt leesbaar
// is. De OGEN zijn miniaturen van het Osiris-oog (draaiende iris-ringen + rode
// pulserende kern) die realistisch met het gezicht mee-roteren en alleen
// zichtbaar zijn wanneer de gezichtskant naar de kijker staat. Datastromen in
// vijf kleuren vloeien van alle kanten naar binnen; synapsen (lijnen en
// driehoeken) flitsen over hoofd, hals en schouders; circuit-traces omlijsten
// het geheel. De kop voltooit zichzelf met schone trades. Canvas, 30fps.

let _neo = { pts: [], rings: [], links: [], tris: [], syn: [], amb: [], streams: [], feats: [], eyes: [], bridge: [],
             formed: 0, formStart: null, rotY: Math.PI / 2, raf: null, lastFrame: 0, actMul: 0.6 };

const NEO_FACE = [
    [1.00, 0.02], [0.93, 0.34], [0.76, 0.55], [0.56, 0.63], [0.50, 0.545],
    [0.40, 0.575], [0.24, 0.66], [0.155, 0.80], [0.10, 0.62], [0.045, 0.585],
    [-0.02, 0.635], [-0.075, 0.575], [-0.13, 0.615], [-0.22, 0.545],
    [-0.32, 0.585], [-0.44, 0.46], [-0.56, 0.26], [-0.72, 0.14], [-0.90, 0.12]
];
const NEO_SMOOTH = [
    [1.00, 0.02], [0.93, 0.34], [0.76, 0.55], [0.56, 0.58], [0.40, 0.53],
    [0.24, 0.50], [0.045, 0.47], [-0.13, 0.46], [-0.32, 0.49],
    [-0.44, 0.42], [-0.56, 0.24], [-0.72, 0.12], [-0.90, 0.10]
];
const NEO_BACK = [
    [1.00, -0.12], [0.86, -0.50], [0.58, -0.66], [0.24, -0.65],
    [-0.06, -0.56], [-0.32, -0.40], [-0.56, -0.28], [-0.90, -0.24]
];
const NEO_WIDTH = [
    [1.00, 0.10], [0.90, 0.36], [0.70, 0.53], [0.45, 0.59], [0.20, 0.57],
    [0.00, 0.52], [-0.20, 0.45], [-0.32, 0.35], [-0.44, 0.29], [-0.55, 0.24]
];
const NEO_PALET = ['#00d9ff', '#ff4fd8', '#ffb627', '#14f195', '#c792ea'];

function _neoInterp(tbl, y) {
    if (y >= tbl[0][0]) return tbl[0][1];
    for (let i = 1; i < tbl.length; i++) {
        if (y >= tbl[i][0]) {
            const y1 = tbl[i - 1][0], v1 = tbl[i - 1][1], y0 = tbl[i][0], v0 = tbl[i][1];
            return v0 + (v1 - v0) * ((y - y0) / (y1 - y0));
        }
    }
    return tbl[tbl.length - 1][1];
}

function _neoSurface(y, phi) {
    const w = _neoInterp(NEO_WIDTH, y);
    const smooth = _neoInterp(NEO_SMOOTH, y), back = _neoInterp(NEO_BACK, y);
    const zc = (smooth + back) / 2, d = (smooth - back) / 2;
    let x = w * Math.sin(phi);
    let z = zc + d * Math.cos(phi);
    const detail = _neoInterp(NEO_FACE, y) - smooth;
    const fw = Math.exp(-Math.pow(x / 0.15, 2)) * Math.max(0, Math.cos(phi));
    z += detail * fw;
    const earW = Math.exp(-Math.pow((Math.abs(phi) - Math.PI / 2) / 0.24, 2)) * Math.exp(-Math.pow((y - 0.18) / 0.16, 2));
    x += Math.sign(Math.sin(phi) || 1) * 0.11 * earW;
    const glow = (Math.abs(detail) > 0.05 && fw > 0.45) || earW > 0.5;
    return { x, y: y * 1.02, z, glow };
}

// ============================================================
// OSIRIS CORE — LEARNING ASCENSION (01-08)
// ============================================================
// Vervangt de 3-body orb door iets dat past bij het thema: de leerhierarchie en de
// autonome mainbrain. Drie concentrische ringen = de drie Adaptive-Learning-niveaus
// (L1 factor-weging, L2 logistisch model, L3 getraind net). Nodes cirkelen op elke
// ring; energie-pulsen stromen van buiten naar binnen richting de heldere OSIRIS-kern,
// die pulseert met de bot-activiteit. Kleur volgt de live bias (groen=bull, rood=bear).
let _orb = { raf: null, last: 0, rings: null, formStart: null, rot: 0, pulses: [] };

function buildQuantumOrb() {
    // drie ringen (van binnen naar buiten): L3 (dichtst bij de kern), L2, L1
    _orb.rings = [
        { level: 3, radius: 0.34, nodes: 3, speed: 0.55, phase: Math.random() * 6.28, label: 'L3' },
        { level: 2, radius: 0.58, nodes: 5, speed: -0.34, phase: Math.random() * 6.28, label: 'L2' },
        { level: 1, radius: 0.84, nodes: 8, speed: 0.20, phase: Math.random() * 6.28, label: 'L1' }
    ];
    _orb.pulses = [];
    _orb.formStart = null; _orb.rot = 0;
}

function _orbFrame(now) {
    _orb.raf = requestAnimationFrame(_orbFrame);
    if (now - _orb.last < 33) return;
    const dtReal = Math.min(0.05, (now - _orb.last) / 1000) || 0.033; _orb.last = now;
    const cv = document.getElementById('neo-canvas'); if (!cv || !_orb.rings) return;
    const r = cv.getBoundingClientRect(); if (r.width < 10) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (Math.abs(cv.width - r.width * dpr) > 2) { cv.width = Math.max(2, r.width * dpr); cv.height = Math.max(2, r.height * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height; ctx.clearRect(0, 0, w, h);
    if (_orb.formStart == null) _orb.formStart = now;
    const F = Math.min(1, Math.max(0, (now - _orb.formStart - 150) / 1500));
    const cx = w / 2, cy = h * 0.5, base = Math.min(w, h) * 0.5;

    // activiteit: hoger als L2/L3 getraind zijn en de bot draait
    const l2on = (typeof _l2 !== 'undefined' && _l2 && _l2.trained) ? 1 : 0.5;
    const l3on = (typeof _l3 !== 'undefined' && _l3 && _l3.trained && _l3.valAcc > 0.52) ? 1 : 0;
    const act = l2on * ((typeof _neo !== 'undefined' && _neo && _neo.actMul) || 0.7);
    // live bias voor de kleur
    let bias = 0; try { const inp = neoNetInputs(); bias = inp.cnn * 0.5 + inp.momentum * 0.3 + (inp.funding || 0) * 0.2; } catch (e) {}
    const core = bias > 0.12 ? [20, 255, 159] : bias < -0.12 ? [255, 60, 100] : [120, 210, 255];
    const ringCols = { 1: [130, 200, 255], 2: [199, 146, 234], 3: [0, 217, 255] };

    _orb.rot += dtReal * 0.12;
    const tilt = 0.5, ct = Math.cos(tilt), st = Math.sin(tilt);
    // projecteer een punt op een gekantelde ring (3D-gevoel)
    const projRing = (radius, ang) => {
        const x = Math.cos(ang) * radius, z = Math.sin(ang) * radius;
        const sx = cx + x * base;
        const sy = cy + z * base * st;          // z-as afgeplat door tilt
        const depth = (Math.sin(ang) + 1) / 2;  // 0=achter, 1=voor
        return { sx, sy, depth };
    };

    // ---- ringen tekenen (elliptische banen) ----
    for (const ring of _orb.rings) {
        const col = ringCols[ring.level];
        ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.12 * F).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let a = 0; a <= 6.29; a += 0.12) {
            const p = projRing(ring.radius, a);
            if (a === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke();
    }

    // ---- energie-pulsen: spawnen op de buitenste ring, stromen naar de kern ----
    if (Math.random() < 0.04 + 0.10 * act) {
        _orb.pulses.push({ t: 0, ang: Math.random() * 6.28, speed: 0.6 + Math.random() * 0.5 });
    }
    for (let i = _orb.pulses.length - 1; i >= 0; i--) {
        const pl = _orb.pulses[i];
        pl.t += dtReal * pl.speed;
        if (pl.t >= 1) { _orb.pulses.splice(i, 1); continue; }
        const radius = 0.84 * (1 - pl.t);   // van buitenring naar kern
        const p = projRing(radius, pl.ang + _orb.rot);
        const a = Math.sin(pl.t * Math.PI) * 0.8 * F;
        ctx.fillStyle = `rgba(${core[0]},${core[1]},${core[2]},${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 1.6 + 1.5 * (1 - pl.t), 0, 6.28); ctx.fill();
        // spoortje
        ctx.strokeStyle = `rgba(${core[0]},${core[1]},${core[2]},${(a * 0.4).toFixed(3)})`;
        ctx.lineWidth = 0.8;
        const p2 = projRing(radius + 0.05, pl.ang + _orb.rot);
        ctx.beginPath(); ctx.moveTo(p2.sx, p2.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
    }

    // ---- nodes op de ringen (met diepte-sortering) ----
    const allNodes = [];
    for (const ring of _orb.rings) {
        ring.phase += dtReal * ring.speed * (0.6 + 0.6 * act);
        for (let n = 0; n < ring.nodes; n++) {
            const ang = ring.phase + (n / ring.nodes) * 6.28 + _orb.rot;
            const p = projRing(ring.radius, ang);
            allNodes.push({ p, ring, ang });
        }
    }
    allNodes.sort((a, b) => a.p.depth - b.p.depth);   // achter eerst
    for (const nd of allNodes) {
        const col = ringCols[nd.ring.level];
        const sz = (1.6 + nd.p.depth * 2.2) * (nd.ring.level === 3 ? 1.3 : 1);
        const alpha = (0.3 + 0.6 * nd.p.depth) * F;
        // gloed
        const g = ctx.createRadialGradient(nd.p.sx, nd.p.sy, 0, nd.p.sx, nd.p.sy, sz * 3);
        g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${alpha.toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(nd.p.sx, nd.p.sy, sz * 3, 0, 6.28); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(nd.p.sx, nd.p.sy, sz * 0.6, 0, 6.28); ctx.fill();
    }

    // ---- OSIRIS-kern in het midden: pulseert met de activiteit ----
    const pulse = 0.85 + 0.15 * Math.sin(now / 380);
    const coreR = base * 0.13 * pulse * (0.7 + 0.3 * act);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
    cg.addColorStop(0, `rgba(255,255,255,${(0.95 * F).toFixed(3)})`);
    cg.addColorStop(0.3, `rgba(${core[0]},${core[1]},${core[2]},${(0.7 * F).toFixed(3)})`);
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, coreR * 3, 0, 6.28); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${F})`; ctx.beginPath(); ctx.arc(cx, cy, coreR * 0.55, 0, 6.28); ctx.fill();
    // L3-actief: extra buitenrand-halo om de kern
    if (l3on) {
        ctx.strokeStyle = `rgba(${core[0]},${core[1]},${core[2]},${(0.4 * F * pulse).toFixed(3)})`;
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, coreR * 1.8, 0, 6.28); ctx.stroke();
    }
    // label
    ctx.fillStyle = `rgba(${core[0]},${core[1]},${core[2]},${(0.9 * F).toFixed(3)})`;
    ctx.font = "bold 7px 'JetBrains Mono', monospace"; ctx.textAlign = 'center';
    ctx.fillText('OSIRIS', cx, cy + coreR * 3 + 8);
}
function startQuantumOrb() { if (!_orb.rings) buildQuantumOrb(); if (!_orb.raf) _orb.raf = requestAnimationFrame(_orbFrame); }
window.startQuantumOrb = startQuantumOrb;

function buildCortex() {
    const cv = document.getElementById('neo-canvas');
    if (!cv) return;
    // CYBER-ROBOT (31-07): hoekig/geometrisch silhouet (facet-panelen) maar in de
    // originele cyaan-kleur. Herkenbaar menselijk, subtiel robot-achtig.
    const RINGS = 54, pts = [], rings = [];
    const ringIdx = y => Math.max(0, Math.min(RINGS - 1, Math.round((1.0 - y) / 1.92 * (RINGS - 1))));
    function addPt(x, y, z, c, glow, ring) {
        const ang0 = Math.random() * Math.PI * 2, rad0 = 2.6 + Math.random() * 2.6, el0 = (Math.random() - 0.5) * Math.PI;
        pts.push({
            tx: x, ty: y, tz: z, glow, ring,
            x: Math.cos(el0) * Math.cos(ang0) * rad0, y: Math.sin(el0) * rad0, z: Math.cos(el0) * Math.sin(ang0) * rad0,
            tw: Math.random() * Math.PI * 2, sp: 0.5 + Math.random() * 1.5, fl: 0, c
        });
        return pts.length - 1;
    }
    // scan-ringen kop — nu met lichte FACETTERING (hoekig): quantiseer de hoek zodat
    // ronde ringen kantige veelhoeken worden (paneel-look).
    const FACETS = 9;   // minder facet-hoeken + sterkere snap -> duidelijk kantige robot-kop
    for (let ri = 0; ri < RINGS; ri++) {
        const y = 1.0 - (ri / (RINGS - 1)) * 1.52;   // kruin -> kin, niet verder
        const w = _neoInterp(NEO_WIDTH, y);
        const n = Math.max(12, Math.round(64 * (w + 0.25)));
        const ring = [];
        for (let k = 0; k < n; k++) {
            let phi = -Math.PI + (k / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.03;
            // facet-kwantisatie: trek de hoek sterk naar de dichtstbijzijnde facet-rand
            // zodat het silhouet duidelijk kantig wordt (robot-panelen).
            const fstep = (Math.PI * 2) / FACETS;
            const snapped = Math.round(phi / fstep) * fstep;
            phi = phi + (snapped - phi) * 0.75;   // 75% naar facet -> uitgesproken hoekig
            const q = _neoSurface(y, phi);
            ring.push(addPt(q.x, q.y, q.z, q.glow ? '#eaffff' : '#9fdcff', q.glow, ri));
        }
        rings.push(ring);
    }
    // KORTE hals (ca. kwart hoofdhoogte) die snel overgaat in brede schouders
    for (let j = 0; j < 12; j++) {
        const t = j / 12, y = -0.54 - t * 0.56;               // hals -0.54..-0.78, schouders tot ~-1.10
        const nek = 0.23;
        const schouder = 1.02 * Math.pow(Math.max(0, (t - 0.40) / 0.60), 1.5);
        const w = nek + schouder;
        const n = Math.max(16, Math.round(40 * (w + 0.35)));
        const ring = [];
        for (let k = 0; k < n; k++) {
            const phi = -Math.PI + (k / n) * Math.PI * 2;
            // ronde hals: diepte ~ breedte (0.22 vs 0.23) zodat het zijaanzicht klopt;
            // schouders worden geleidelijk platter (ellips), licht naar voren gecentreerd
            const depth = 0.05 + (0.22 + 0.18 * t) * Math.cos(phi) * (1 - 0.30 * t);
            const sag = schouder > 0 ? 0.06 * Math.abs(Math.sin(phi)) * (schouder / 1.02) : 0;  // subtiele trapezius
            ring.push(addPt(w * Math.sin(phi), (y - sag) * 1.02, depth, '#6fb8e8', false, RINGS + j));
        }
        rings.push(ring);
    }
    // GEZICHTSKENMERKEN als heldere contourlijnen (goed zichtbaar)
    const feats = [];
    function featLine(list, vis) {
        const idx = list.map(([y, phi, dz]) => {
            const q = _neoSurface(y, phi);
            return addPt(q.x, q.y, q.z + (dz != null ? dz : 0.015), '#dff4ff', true, ringIdx(y));
        });
        feats.push({ idx, vis });
    }
    // wenkbrauwen (boven de ogen)
    featLine([[0.505, 0.14], [0.515, 0.24], [0.52, 0.34], [0.515, 0.44], [0.50, 0.52]], 'front');
    featLine([[0.505, -0.14], [0.515, -0.24], [0.52, -0.34], [0.515, -0.44], [0.50, -0.52]], 'front');
    // neusrug + neuspunt + neusgaten
    featLine([[0.36, 0], [0.30, 0], [0.24, 0], [0.19, 0], [0.155, 0], [0.125, 0]], 'front');
    featLine([[0.09, 0.09], [0.082, 0.15], [0.09, 0.20]], 'front');
    featLine([[0.09, -0.09], [0.082, -0.15], [0.09, -0.20]], 'front');
    // mond: bovenlip, mondnaad, onderlip
    featLine([[-0.018, -0.28], [-0.025, -0.14], [-0.03, 0], [-0.025, 0.14], [-0.018, 0.28]], 'front');
    featLine([[-0.072, -0.36], [-0.076, -0.18], [-0.078, 0], [-0.076, 0.18], [-0.072, 0.36]], 'front');
    featLine([[-0.128, -0.26], [-0.136, -0.13], [-0.14, 0], [-0.136, 0.13], [-0.128, 0.26]], 'front');
    // kinlijn
    featLine([[-0.30, -0.20], [-0.33, 0], [-0.30, 0.20]], 'front');
    // kaaklijnen: van onder het oor naar de kin (beide zijden) - geeft het
    // gezicht zijn herkenbare onderrand
    featLine([[-0.06, 1.30], [-0.16, 1.02], [-0.25, 0.72], [-0.31, 0.42], [-0.335, 0.18]], 'front');
    featLine([[-0.06, -1.30], [-0.16, -1.02], [-0.25, -0.72], [-0.31, -0.42], [-0.335, -0.18]], 'front');
    // oren (beide zijden, boog + lel)
    function ear(side) {
        const arr = [];
        for (let a = 0; a <= 1; a += 0.125) {
            const ang = a * Math.PI * 1.45 - 0.35;
            arr.push([0.19 + 0.135 * Math.cos(ang), side * (Math.PI / 2 + 0.10 * Math.sin(ang)), 0.01]);
        }
        featLine(arr, side > 0 ? 'xpos' : 'xneg');
        featLine([[0.10, side * (Math.PI / 2 - 0.05)], [0.065, side * (Math.PI / 2)], [0.09, side * (Math.PI / 2 + 0.08)]], side > 0 ? 'xpos' : 'xneg');
    }
    ear(1); ear(-1);
    // OGEN: Osiris-oog-ankers op het gezichtsoppervlak (roteren realistisch mee)
    const eyes = [];
    for (const side of [-1, 1]) {
        const q = _neoSurface(0.435, side * 0.34);
        eyes.push({ x: q.x, y: q.y, z: q.z + 0.03 });
    }
    // ---- MESH die het GEZICHT opbouwt (29-07) ----
    // Alleen de essentiele structuurlijnen: de ring-contouren (horizontaal) plus één
    // korte verticale verbinding per punt naar de volgende ring. Dun en rustig - de
    // lange creatie-streams (hieronder) voeren het "opbouwende" effect, niet kriskras.
    const mesh = [];
    for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        for (let k = 0; k < ring.length; k++) {
            mesh.push({ a: ring[k], b: ring[(k + 1) % ring.length] });
        }
        const nxt = rings[ri + 1];
        if (nxt && ri < RINGS - 1) {
            for (let k = 0; k < ring.length; k += 2) {
                const p = pts[ring[k]];
                let best = -1, bd = 1e9;
                for (let j = 0; j < nxt.length; j++) {
                    const q = pts[nxt[j]];
                    const d = (p.tx - q.tx) ** 2 + (p.ty - q.ty) ** 2 + (p.tz - q.tz) ** 2;
                    if (d < bd) { bd = d; best = nxt[j]; }
                }
                if (best >= 0 && bd < 0.09) mesh.push({ a: ring[k], b: best });
            }
        }
    }
    // ---- BREIN (30-07): Trinity-stijl ultra-realistisch orgaan ----
    // Overgenomen van het betere Trinity-brein: echte hersengroeven (sulci) met
    // pulserend licht, gyri-schaduw via een fold-waarde per punt, gradient-synapsen,
    // en een bouwgolf die de contouren "tekent". Uitgebreid palet (niet enkel
    // rood/groen): de particles, synapsen en sulci-pulsen putten uit BR_PAL.
    buildNeoBrain2();
    // (de oude brainAmb/brainStripes/brainLinks blijven ongebruikt maar bestaan niet
    //  meer hier; het nieuwe brein leeft in _neo.brain2 en wordt door _neoBrainFrame getekend)
    // links + synapsen voor het HOOFD: alleen nog een handvol voor de flikkerende
    // synaps-accenten (30-07: 70 -> 24; de dichtere face-mesh levert de structuur).
    const links = [];
    let guard = 0;
    while (links.length < 24 && guard++ < 5000) {
        const a = (Math.random() * pts.length) | 0, b = (Math.random() * pts.length) | 0;
        const dx = pts[a].tx - pts[b].tx, dy = pts[a].ty - pts[b].ty, dz = pts[a].tz - pts[b].tz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 0.05 && d < 0.26) links.push({ a, b });
    }
    const tris = [];
    for (let i = 0; i < 120 && tris.length < 11; i++) {
        const l1 = links[(Math.random() * links.length) | 0]; if (!l1) break;
        const b = l1.b, cand = links.filter(l => l.a === b || l.b === b);
        if (!cand.length) continue;
        const l2 = cand[(Math.random() * cand.length) | 0];
        const c = l2.a === b ? l2.b : l2.a;
        if (c === l1.a) continue;
        tris.push({ a: l1.a, b, c, t: Math.random() * 3, dur: 2.4 + Math.random() * 1.6 });
    }
    const syn = [];
    for (let i = 0; i < 5; i++) {   // 30-07: minder ruis-flitsen; de creatie-lijnen (streams) voeren nu de boventoon
        const l = links[(Math.random() * links.length) | 0];
        if (l) syn.push({ a: l.a, b: l.b, t: Math.random() * 3, dur: 2.0 + Math.random() * 1.5 });
    }
    // zwevende deeltjes overal (29-07: teruggebracht van 80 -> 34 zodat de nieuwe
    // mesh-structuurlijnen de boventoon voeren i.p.v. de ruis-animatie)
    const amb = [];
    for (let i = 0; i < 34; i++) {
        amb.push({
            x: Math.random(), y: Math.random(),
            vx: (Math.random() - 0.5) * 0.014, vy: (Math.random() - 0.5) * 0.012,
            r: 0.7 + Math.random() * 1.9, tw: Math.random() * Math.PI * 2, sp: 0.3 + Math.random(),
            c: NEO_PALET[(Math.random() * NEO_PALET.length) | 0]
        });
    }
    // brug-synapsen: verbindingen die vanaf de oog-kant (links) de kop invoeden
    const bridge = [];
    for (let i = 0; i < 5; i++) {
        bridge.push({ oy: 0.30 + Math.random() * 0.45, tgt: (Math.random() * pts.length) | 0, t: Math.random() * 3, dur: 2.0 + Math.random() * 1.6 });
    }
    // datastromen van alle kanten (links = vanuit het oog)
    const streams = [];
    // CREATIE-LIJNEN (30-07): meer bronpunten + meer deeltjes, zodat het hoofd
    // duidelijk wordt "opgebouwd" door lijnen die de puntjes raken - i.p.v. losse
    // ruis. 12 origins rondom, elk 14 deeltjes = ~168 creatie-lijnen.
    const origins = [
        [0.0, 0.25], [0.0, 0.45], [0.0, 0.65], [0.0, 0.85],
        [1.0, 0.15], [1.0, 0.38], [1.0, 0.62], [1.0, 0.85],
        [0.30, 0.0], [0.70, 0.0], [0.30, 1.0], [0.70, 1.0]
    ];
    for (let s = 0; s < origins.length; s++) {
        const deeltjes = [];
        for (let k = 0; k < 14; k++) deeltjes.push({ t: Math.random(), sp: 0.22 + Math.random() * 0.3, tgt: (Math.random() * pts.length) | 0, bow: (Math.random() - 0.5) * 0.5, px: 0, py: 0 });
        streams.push({ ox: origins[s][0], oy: origins[s][1], c: NEO_PALET[s % NEO_PALET.length], deeltjes });
    }
    _neo = { pts, rings, links, tris, syn, amb, streams, feats, eyes, bridge, mesh,
             formed: 0, formStart: null, rotY: Math.PI / 2, raf: _neo.raf, lastFrame: 0, actMul: 0.6 };
    if (!_neo.raf) _neo.raf = requestAnimationFrame(_neoFrame);
}

function _neoPickTri(f) {
    const L = _neo.links; if (!L.length) return;
    const l1 = L[(Math.random() * L.length) | 0];
    const b = l1.b, cand = L.filter(l => l.a === b || l.b === b);
    const l2 = cand.length ? cand[(Math.random() * cand.length) | 0] : l1;
    const c = l2.a === b ? l2.b : l2.a;
    f.a = l1.a; f.b = b; f.c = (c === l1.a ? l1.b : c); f.t = 0;
}

function _neoFrame(now) {
    _neo.raf = requestAnimationFrame(_neoFrame);
    if (now - _neo.lastFrame < 33) return;
    const dt = Math.min(0.1, (now - _neo.lastFrame) / 1000) || 0.033;
    _neo.lastFrame = now;
    const cv = document.getElementById('neo-canvas');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    if (rect.width < 10) return;
    if (cv.width !== Math.round(rect.width * 2)) { cv.width = rect.width * 2; cv.height = rect.height * 2; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    const w = rect.width, h = rect.height;

    if (_neo.formStart === null) _neo.formStart = now;
    const tSec = Math.max(0, (now - _neo.formStart - 300) / 1000);
    // CONTINUE OPBOUW: een bouwgolf trekt eindeloos van kruin naar schouders.
    // Ringen vallen vlak voor de golf uiteen en vormen zich er direct achter
    // opnieuw - de strepen-animatie van de vorming blijft dus altijd zichtbaar.
    const NEO_CYCLE = 18, NEO_BUILD = 10, NEO_PRE = 5;
    const F = Math.min(1, tSec / 5.2);
    _neo.formed = F;
    _neo.rotY += dt * 0.18;
    const cosr = Math.cos(_neo.rotY), sinr = Math.sin(_neo.rotY);

    // transparant wissen: de gedeelde zwarte achtergrond van het blok toont door,
    // zodat oog en hoofd in dezelfde ruimte zweven
    ctx.clearRect(0, 0, w, h);

    // zwevende deeltjes
    for (const a of _neo.amb) {
        a.x = (a.x + a.vx * dt + 1) % 1; a.y = (a.y + a.vy * dt + 1) % 1;
        const tw = 0.20 + 0.5 * (0.5 + 0.5 * Math.sin(now / 900 * a.sp + a.tw));
        ctx.globalAlpha = tw; ctx.fillStyle = a.c;
        ctx.fillRect(a.x * w - a.r / 2, a.y * h - a.r / 2, a.r, a.r);
    }
    ctx.globalAlpha = 1;

    const cx = w * 0.5, cy = h * 0.43, scale = Math.min(w, h) * 0.43;
    const totalRings = _neo.rings.length;
    const NEO_L = totalRings + NEO_BUILD + NEO_PRE;
    const waveAbs = (tSec / NEO_CYCLE) * NEO_L;

    const proj = new Array(_neo.pts.length);
    for (let i = 0; i < _neo.pts.length; i++) {
        const p = _neo.pts[i];
        let e = 0;
        if (waveAbs >= p.ring) {
            const db = (waveAbs - p.ring) % NEO_L;
            if (db < NEO_BUILD) { const k = db / NEO_BUILD; e = 1 - Math.pow(1 - k, 3); }        // in aanbouw
            else if (db > NEO_L - NEO_PRE) { const k = (NEO_L - db) / NEO_PRE; e = k * k; }      // valt uiteen voor de golf
            else e = 1;                                                                          // volledig gevormd
        }
        const x3 = p.x + (p.tx - p.x) * e, y3 = p.y + (p.ty - p.y) * e, z3 = p.z + (p.tz - p.z) * e;
        const rx = x3 * cosr + z3 * sinr, rz = -x3 * sinr + z3 * cosr;
        const persp = 1 / (2.5 - rz * 0.62);
        proj[i] = { sx: cx + rx * scale * persp, sy: cy - y3 * scale * persp, persp, e };
        if (p.fl > 0) p.fl = Math.max(0, p.fl - dt * 2);
    }

    const scanY = ((now / 2600) % 1.3) * 2.6 - 1.4;
    const act = ((_l2 && _l2.trained) ? 1 : 0.6) * (_neo.actMul || 0.6);   // synaps-tempo (voor brug en synapsen)

    // scan-ringen
    for (let ri = 0; ri < totalRings; ri++) {
        const ring = _neo.rings[ri];
        const e0 = proj[ring[0]].e;
        if (e0 < 0.35) continue;
        const py = _neo.pts[ring[0]].ty;
        const scanGlow = F >= 1 ? Math.exp(-Math.pow((py - scanY) / 0.10, 2)) : 0;
        const bouwGlow = (e0 > 0.35 && e0 < 0.98) ? (1 - e0) : 0;
        ctx.strokeStyle = `rgba(120,200,255,${(0.10 + 0.35 * scanGlow + 0.5 * bouwGlow) * e0})`;
        ctx.lineWidth = 0.5 + scanGlow * 0.5;
        ctx.beginPath();
        for (let k = 0; k < ring.length; k++) {
            const q = proj[ring[k]];
            if (k === 0) ctx.moveTo(q.sx, q.sy); else ctx.lineTo(q.sx, q.sy);
        }
        ctx.closePath(); ctx.stroke();
    }

    // FACE-MESH: de paneel-randen van de cyber-robot-kop (facet-structuur), maar in
    // de originele cyaan-kleur i.p.v. regenboog. Scan laat de randen mee-oplichten.
    if (_neo.mesh) {
        ctx.lineWidth = 0.35;
        for (const m of _neo.mesh) {
            const qa = proj[m.a], qb = proj[m.b];
            if (qa.e < 0.4 || qb.e < 0.4) continue;
            const ee = Math.min(qa.e, qb.e);
            const depth = (qa.persp + qb.persp) / 2;
            const scanGlow = F >= 1 ? Math.exp(-Math.pow((_neo.pts[m.a].ty - scanY) / 0.10, 2)) : 0;
            const a = (0.06 + 0.11 * (depth - 0.3)) * ee + scanGlow * 0.5;
            ctx.strokeStyle = `rgba(110,190,240,${a.toFixed(3)})`;
            ctx.beginPath(); ctx.moveTo(qa.sx, qa.sy); ctx.lineTo(qb.sx, qb.sy); ctx.stroke();
        }
    }

    // (brein wordt nu in een eigen paneel getekend: _neoBrainFrame op neo-brain-canvas)

    // punten — origineel blauw + scan (robot-facet-vorm blijft, kleur terug naar cyaan)
    for (let i = 0; i < _neo.pts.length; i++) {
        const p = _neo.pts[i];
        const q = proj[i];
        if (q.e <= 0.01) continue;
        const tw = 0.32 + 0.5 * (0.5 + 0.5 * Math.sin(now / 700 * p.sp + p.tw));
        const scanGlow = F >= 1 ? Math.exp(-Math.pow((p.ty - scanY) / 0.10, 2)) : 0;
        const s = ((p.glow ? 1.6 : 0.95) + 1.1 * q.persp) * (0.55 + 0.45 * tw) + p.fl * 1.6 + scanGlow * 0.7;
        ctx.globalAlpha = Math.min(1, q.e * ((p.glow ? Math.max(tw, 0.6) : tw * 0.9) + p.fl + scanGlow * 0.4));
        ctx.fillStyle = (p.fl > 0.3 || scanGlow > 0.55) ? '#ffffff' : p.c;   // origineel: wit accent, verder p.c (cyaan)
        ctx.fillRect(q.sx - s / 2, q.sy - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    // GEZICHTSKENMERK-LIJNEN: wenkbrauwen, neus, mond, lippen, kin, oren
    const visF = { front: Math.max(0, cosr), xpos: Math.max(0, -sinr), xneg: Math.max(0, sinr) };
    for (const ftr of _neo.feats) {
        const vf = visF[ftr.vis] || 0;
        if (vf < 0.05) continue;
        const e0 = proj[ftr.idx[0]].e;
        if (e0 < 0.4) continue;
        ctx.strokeStyle = '#cfeeff';
        ctx.globalAlpha = Math.min(1, vf * e0 * 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ftr.idx.forEach((pi, k) => { const q = proj[pi]; if (k === 0) ctx.moveTo(q.sx, q.sy); else ctx.lineTo(q.sx, q.sy); });
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // OSIRIS-OGEN: mee-roterend, alleen zichtbaar als het gezicht naar voren staat
    const eyeVis = Math.max(0, cosr - 0.08);
    if (eyeVis > 0 && F > 0.5) {
        for (const eye of _neo.eyes) {
            const rx = eye.x * cosr + eye.z * sinr, rz = -eye.x * sinr + eye.z * cosr;
            const persp = 1 / (2.5 - rz * 0.62);
            const ex = cx + rx * scale * persp, ey = cy - eye.y * scale * persp;
            const re = scale * persp * 0.052;
            ctx.globalAlpha = Math.min(1, eyeVis * 1.4) * F;
            ctx.strokeStyle = '#00d9ff'; ctx.lineWidth = 0.9;
            ctx.setLineDash([re * 0.55, re * 0.35]); ctx.lineDashOffset = -now / 40;
            ctx.beginPath(); ctx.arc(ex, ey, re, 0, 6.283); ctx.stroke();
            ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 0.6;
            ctx.setLineDash([re * 0.22, re * 0.4]); ctx.lineDashOffset = now / 55;
            ctx.beginPath(); ctx.arc(ex, ey, re * 0.62, 0, 6.283); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#ff5f7e';
            ctx.beginPath(); ctx.arc(ex, ey, re * (0.30 + 0.10 * Math.sin(now / 450)), 0, 6.283); ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // datastromen
    for (const st of _neo.streams) {
        const ox = st.ox * w, oy = st.oy * h;
        for (const d of st.deeltjes) {
            d.t += d.sp * dt;
            const tgtQ = proj[d.tgt];
            if (d.t >= 1 || !tgtQ) {
                if (tgtQ) { _neo.pts[d.tgt].fl = 1; }
                d.t = 0; d.tgt = (Math.random() * _neo.pts.length) | 0;
                d.sp = 0.25 + Math.random() * 0.3; d.bow = (Math.random() - 0.5) * 0.5;
                continue;
            }
            const t = d.t, mt = 1 - t;
            const mx = (ox + tgtQ.sx) / 2 - (tgtQ.sy - oy) * d.bow;
            const my = (oy + tgtQ.sy) / 2 + (tgtQ.sx - ox) * d.bow;
            const x = mt * mt * ox + 2 * mt * t * mx + t * t * tgtQ.sx;
            const y = mt * mt * oy + 2 * mt * t * my + t * t * tgtQ.sy;
            if (d.px) {
                ctx.strokeStyle = st.c; ctx.globalAlpha = 0.55 * t; ctx.lineWidth = 1.0;
                ctx.beginPath(); ctx.moveTo(d.px, d.py); ctx.lineTo(x, y); ctx.stroke();
            }
            ctx.globalAlpha = 0.5 + 0.5 * t;
            ctx.fillStyle = st.c;
            const sz = 1.4 + t * 1.4;
            ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
            d.px = x; d.py = y;
        }
    }
    ctx.globalAlpha = 1;

    // BRUG-SYNAPSEN: flitsen tussen de oog-kant en de kop (zelfde ruimte)
    for (const f of _neo.bridge) {
        f.t += dt * (act || 0.6);
        if (f.t > f.dur) { f.tgt = (Math.random() * _neo.pts.length) | 0; f.oy = 0.30 + Math.random() * 0.45; f.t = 0; continue; }
        const k = f.t / f.dur, glow = Math.sin(k * Math.PI);
        if (glow < 0.03) continue;
        const B = proj[f.tgt];
        if (!B || B.e < 0.5) continue;
        ctx.strokeStyle = `rgba(127,232,255,${glow * 0.7 * F})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(0, f.oy * h); ctx.lineTo(B.sx, B.sy); ctx.stroke();
        ctx.fillStyle = '#bfeeff'; ctx.globalAlpha = glow;
        ctx.beginPath(); ctx.arc(B.sx, B.sy, 1.8, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
    }

    // synaps-LIJNEN (extra flitsen)
    for (const f of _neo.syn) {
        f.t += dt * act;
        if (f.t > f.dur) {
            const l = _neo.links[(Math.random() * _neo.links.length) | 0];
            if (l) { f.a = l.a; f.b = l.b; } f.t = 0; continue;
        }
        const k = f.t / f.dur, glow = Math.sin(k * Math.PI);
        if (glow < 0.03) continue;
        const A = proj[f.a], B = proj[f.b];
        if (!A || !B || A.e < 0.5) continue;
        ctx.strokeStyle = `rgba(220,250,255,${glow * 0.8 * F})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
        ctx.fillStyle = '#eaffff'; ctx.globalAlpha = glow;
        ctx.beginPath(); ctx.arc(B.sx, B.sy, 1.6, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
    }
    // synaps-DRIEHOEKEN
    for (const f of _neo.tris) {
        f.t += dt * act;
        if (f.t > f.dur) { _neoPickTri(f); continue; }
        const k = f.t / f.dur, glow = Math.sin(k * Math.PI);
        if (glow < 0.03) continue;
        const A = proj[f.a], B = proj[f.b], C = proj[f.c];
        if (!A || !B || !C || A.e < 0.5) continue;
        ctx.strokeStyle = `rgba(234,255,255,${glow * 0.8 * F})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.lineTo(C.sx, C.sy); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = '#eaffff'; ctx.globalAlpha = glow;
        for (const Pn of [A, B, C]) { ctx.beginPath(); ctx.arc(Pn.sx, Pn.sy, 1.7, 0, 6.283); ctx.fill(); }
        ctx.globalAlpha = 1;
    }
}

// ============================================================
// NEO ACTIEF NEURAAL NETWERK (29-07)
// ============================================================
// Een gelaagde netwerkvisualisatie die de ECHTE verwerking van Neo toont, geen
// decoratie. Lagen: input-features (VFM, ER, DB, chaos, momentum, volume-Z,
// CNN-patroonbias, fib-confluence) -> twee verborgen lagen (confluence-integratie)
// -> adaptieve-gewichten-laag -> output (LONG / NEUTRAAL / SHORT). Verbindingen
// swingen en lichten op terwijl Neo "rekent"; de kleur en dikte volgen het teken
// en de grootte van de echte factor-waarden uit liveSnapshot / adaptiveWeights /
// de CNN-scan. Rood = negatieve/bearish bijdrage, blauw = positieve/bullish.
let _neonet = { raf: null, last: 0, layers: null, conns: null, pulse: 0, built: false, actLevel: 0 };

const NEONET_INPUTS = [
    { key: 'vfm',      label: 'VFM',      c: '#00d9ff' },
    { key: 'er',       label: 'ER',       c: '#4fc3f7' },
    { key: 'db',       label: 'DB',       c: '#81d4fa' },
    { key: 'chaos',    label: 'CHAOS',    c: '#ffb627' },
    { key: 'momentum', label: 'MOM',      c: '#14f195' },
    { key: 'volz',     label: 'VOL-Z',    c: '#c792ea' },
    { key: 'rsi',      label: 'RSI',      c: '#ff6ec7' },
    { key: 'ema',      label: 'EMA',      c: '#7fffd4' },
    { key: 'cnn',      label: 'CNN',      c: '#ff4fd8' },
    { key: 'fib',      label: 'FIB',      c: '#ffd54a' },
    { key: 'nn',       label: 'NN',       c: '#c792ea' },
    { key: 'nodeconf', label: 'CONF',     c: '#ffb627' },
    { key: 'funding',  label: 'FUND',     c: '#ff8fa3' },
    { key: 'longshort',label: 'L/S',      c: '#8fb8ff' },
    { key: 'btccorr',  label: 'BTC-COR',  c: '#f7931a' },
    { key: 'sent',     label: 'SENT',     c: '#c792ea' }
];

function buildNeoNet() {
    // UITGEBREIDE MULTI-BREIN ARCHITECTUUR (01-08):
    // laag 0 = alle 12 data-inputs (VFM/ER/DB/chaos/mom/volz/rsi/ema/cnn/fib/nn/conf)
    // laag 1 = integratie-laag (verwerkt de inputs)
    // laag 2 = de DRIE sub-breinen (Neo BTC / ETH / SOL) - elk een knoop die zijn munt weegt
    // laag 3 = Osiris mainbrain-integratie (vergelijkt de sub-breinen)
    // laag 4 = output: LONG / NEUTRAAL / SHORT + equity-keuze
    // laag 5 = HET ENE EINDPUNT (alle 3 outputs convergeren tot 1 beslissing)
    const layerSizes = [NEONET_INPUTS.length, 14, 3, 4, 3, 1];
    const layers = layerSizes.map((n, li) => {
        const nodes = [];
        for (let i = 0; i < n; i++) nodes.push({ li, i, act: 0, tw: Math.random() * 6.28 });
        return nodes;
    });
    const conns = [];
    for (let li = 0; li < layers.length - 1; li++) {
        for (const a of layers[li]) {
            for (const b of layers[li + 1]) {
                conns.push({ li, a: a.i, b: b.i, w: (Math.random() * 2 - 1), flow: Math.random(), sp: 0.5 + Math.random() });
            }
        }
    }
    _neonet.layers = layers; _neonet.conns = conns; _neonet.built = true;
    // labels voor de betekenisvolle lagen
    _neonet.layerLabels = ['INPUTS', 'INTEGRATION', 'CORES', 'OSIRIS', 'DECISION', 'OUTPUT'];
    _neonet.subBrainLabels = ['BTC', 'ETH', 'SOL'];
    _neonet.outputLabels = ['LONG', 'NEUTRAAL', 'SHORT'];
}

// haal de echte, genormaliseerde input-activaties op uit Neo's live-state
function neoNetInputs() {
    const snap = (typeof lastOsirisMetrics !== 'undefined' && lastOsirisMetrics) ? lastOsirisMetrics : {};
    const lv = (typeof lastVolumeMetrics !== 'undefined' && lastVolumeMetrics) ? lastVolumeMetrics : {};
    const norm = (v, s) => Math.max(-1, Math.min(1, (v || 0) / s));
    // CNN-patroonbias uit de recente candles
    let cnnBias = 0;
    try { if (typeof rawData !== 'undefined' && rawData && rawData.length > 5) cnnBias = neoScanPatterns(rawData, 40).netBias; } catch (e) {}
    return {
        vfm: norm(snap.vfm, 1.5),
        er: norm(snap.er, 1),
        db: norm(snap.db, 1),
        chaos: norm(snap.chaos, 1),
        momentum: norm(snap.momentum != null ? snap.momentum : (snap.isBullish ? 0.6 : -0.6), 1),
        volz: norm(lv.zScore, 2.5),
        rsi: (() => { try { const r = getCurrentRSIValue(); return r == null ? 0 : (50 - r) / 50; } catch (e) { return 0; } })(),
        ema: (() => { try { const e = (typeof maCurrentValue !== 'undefined' && maCurrentValue) ? maCurrentValue : null; return (e && isFinite(livePrice)) ? Math.max(-1, Math.min(1, (livePrice - e) / e * 200)) : 0; } catch (er) { return 0; } })(),
        cnn: cnnBias,
        fib: norm(snap.fibConfluence != null ? snap.fibConfluence : 0, 5),
        // Neo's Node nabijheid (0..1, hoofdnode telt zwaarder) + node-confluentie score
        nn: (() => { try { const p = nnProximity('BTC'); return p ? p.prox * (p.main ? 1 : 0.6) : 0; } catch (e) { return 0; } })(),
        nodeconf: (() => { try { const c = computeNodeConfluence(); return c ? (c.score || 0) : 0; } catch (e) { return 0; } })(),
        // FUNDAMENTALS (van de actieve munt in de multi-state): funding, long/short, BTC-corr
        funding: (() => { try { const f = neoMultiState.markets[neoMultiState.active].fund; return f && f.fundingRate != null ? Math.max(-1, Math.min(1, -Math.tanh(f.fundingRate * 2000))) : 0; } catch (e) { return 0; } })(),
        longshort: (() => { try { const f = neoMultiState.markets[neoMultiState.active].fund; return f && f.longShortRatio != null ? Math.max(-1, Math.min(1, -Math.tanh((f.longShortRatio - 1) * 1.5))) : 0; } catch (e) { return 0; } })(),
        btccorr: (() => { try { const f = neoMultiState.markets[neoMultiState.active].fund; return f && f.btcCorr != null ? f.btcCorr : 0; } catch (e) { return 0; } })(),
        sent: (() => { try { return Math.max(-1, Math.min(1, (marketSentiment(neoMultiState.active) - 50) / 50)); } catch (e) { return 0; } })()
    };
}

function _hexToRgba(hex, a) {
    try {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${a})`;
    } catch (e) { return `rgba(130,200,255,${a})`; }
}
function _neoNetFrame(now) {
    _neonet.raf = requestAnimationFrame(_neoNetFrame);
    if (now - _neonet.last < 33) return;
    _neonet.last = now;
    // render zowel het kleine kwadrant-canvas als het grote multi-brein-canvas
    _neoNetDraw(now, 'neo-net-canvas', 'neo-net-out');
    _neoNetDraw(now, 'neo-net-canvas-big', 'neo-net-out-big');
    _neoNetDraw(now, 'neo-net-canvas-wal', 'neo-net-out-wal');
    // DEEPNET-integratie: leg de gekalibreerde per-markt-kansen + mainbrain-keuze
    // als band onderop het grote multi-brein-canvas (breidt de bestaande visual uit).
    try { _deepnetOverlayBig(); } catch (e) {}
}
function _neoNetDraw(now, canvasId, outId) {
    const cv = document.getElementById(canvasId);
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    if (rect.width < 10) return;
    if (cv.width !== Math.round(rect.width * 2)) { cv.width = rect.width * 2; cv.height = rect.height * 2; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    if (!_neonet.built) buildNeoNet();
    _neonet._outId = outId;

    const layers = _neonet.layers, conns = _neonet.conns;
    const _isBigNet = (canvasId === 'neo-net-canvas-big' || canvasId === 'neo-net-canvas-wal');
    // (22-08) padTop groter zodat de inputs ONDER de titel/subtitel beginnen (geen overlap);
    // padBot groter zodat de laag-labels + status-regel ruim boven de panel-hoeken/randen vallen.
    const padX = w * 0.13, padTop = h * 0.135, padBot = h * 0.18, padY = padTop;
    const _FX = [0, 0.32, 0.49, 0.66, 0.83, 1.0];
    const _fxOf = li => (_FX[li] != null ? _FX[li] : li / (layers.length - 1));
    // Per-laag verticale spreiding: inputs/integratie vol uitgespreid (meer ruimte tussen
    // de punten), en cores/osiris/beslissing compacter EN gecentreerd zodat die punten
    // dichter bij elkaar staan. Alles blijft binnen het canvas zichtbaar.
    const colH = h - padTop - padBot, cyMid = padTop + colH / 2;
    const _SPREAD = [1.0, 0.98, 0.52, 0.60, 0.52, 0.40];
    const _spreadOf = li => (_SPREAD[li] != null ? _SPREAD[li] : 1.0);
    const pos = layers.map((nodes, li) => {
        const h2 = colH * _spreadOf(li), top = cyMid - h2 / 2, gap = h2 / Math.max(1, nodes.length - 1);
        return nodes.map((nd, i) => ({ x: padX + _fxOf(li) * (w - padX * 2), y: nodes.length === 1 ? cyMid : top + i * gap }));
    });

    // ---- echte input-activaties injecteren + forward-propagatie (visueel) ----
    const inp = neoNetInputs();
    const running = (typeof botState !== 'undefined' && botState && botState.isRunning) ||
                    (typeof isRunning !== 'undefined' && isRunning) || false;
    // "compute-puls": loopt continu door de lagen; sneller als de bot actief rekent
    _neonet.actLevel += (( (_l2 && _l2.trained) ? 1 : 0.6) * (running ? 1 : 0.7) - _neonet.actLevel) * 0.05;
    _neonet.pulse = (_neonet.pulse + 0.010 + 0.012 * _neonet.actLevel) % 1;
    const wavePos = _neonet.pulse * (layers.length - 1);
    // FEEDBACK-PULS: 2.5x sneller, en DATA-TRUE - vuurt een verse flits precies wanneer de
    // bot echt leert (een trade sluit -> learningLog groeit, of de RL-agent hertraint).
    try {
        const _lc = (typeof learningLog !== 'undefined' && learningLog ? learningLog.length : 0)
            + (typeof OsirisRL !== 'undefined' ? Math.floor((OsirisRL.episodes || 0) / 3000) : 0);
        if (_neonet._lastLearn == null) _neonet._lastLearn = _lc;
        if (_lc > _neonet._lastLearn) { _neonet.fbPulse = 0; _neonet._lastLearn = _lc; }   // leer-event -> flits vuurt vers
    } catch (e) {}
    _neonet.fbPulse = (_neonet.fbPulse || 0) + 0.0075 + 0.005 * _neonet.actLevel;   // true snelheid (zichtbaar)
    const _fbCycle = _neonet.fbPulse % 1.7;                 // deel actief, deel rust
    const _fbActive = _fbCycle < 1.0;
    const _fbPos = _fbActive ? (1 - _fbCycle) * (layers.length - 1) : -1;   // hoog(output) -> laag(input)

    // zet input-laag activaties
    layers[0].forEach((nd, i) => { nd.act = Math.abs(inp[NEONET_INPUTS[i].key] || 0); nd.sign = Math.sign(inp[NEONET_INPUTS[i].key] || 0); });
    // laag 1 (integratie): propageer uit de inputs
    layers[1].forEach((nd, j) => {
        let s = 0, wsum = 0, sgn = 0;
        for (const a of layers[0]) {
            const cn = conns.find(c => c.li === 0 && c.a === a.i && c.b === j);
            if (cn) { s += a.act * cn.w; wsum += Math.abs(cn.w); sgn += a.act * a.sign * cn.w; }
        }
        nd.act = Math.max(0, Math.min(1, wsum ? Math.abs(s) / wsum : 0));
        nd.sign = Math.sign(sgn);
    });
    // laag 2 (SUB-BREINEN): elk knooppunt = een munt, gevoed met zijn ECHTE sub-brein-kans
    try {
        const syms = ['BTC', 'ETH', 'SOL'];
        layers[2].forEach((nd, i) => {
            const m = neoMultiState.markets[syms[i]];
            const prob = m && m.bestProb != null ? m.bestProb : 0.5;
            nd.act = Math.max(0.1, Math.min(1, prob));
            nd.sign = (m && m.bestSide === 'SHORT') ? -1 : 1;
            nd.label = syms[i];
        });
    } catch (e) {}
    // laag 3 (OSIRIS): gevoed met de equity-verdeling per munt + een integratie-knoop
    try {
        const alloc = (typeof osirisState !== 'undefined' && osirisState.allocations) ? osirisState.allocations : {};
        const syms = ['BTC', 'ETH', 'SOL'];
        layers[3].forEach((nd, i) => {
            if (i < 3) { nd.act = Math.max(0.1, Math.min(1, alloc[syms[i]] || 0)); nd.label = syms[i]; }
            else { nd.act = Math.max(...syms.map(s => alloc[s] || 0), 0.2); nd.label = 'OSIRIS'; }  // mainbrain-integratie
        });
    } catch (e) {}
    // output-laag: LONG / NEUTRAAL / SHORT uit de laatste beslissing
    // DATA-TRUE BESLISSING (16-08): de uitkomst weerspiegelt wat de bot ECHT doet -
    // gewogen naar de open posities (zwaarst) + de core-allocatie (bestSide x conviction),
    // niet BTC's ruwe momentum. Zo kan het net niet SHORT tonen terwijl hij LONG zit.
    let decisionBias = 0;
    try {
        let wsum = 0, dsum = 0;
        for (const p of (typeof openPositions !== 'undefined' ? openPositions : [])) {
            const dir = p.side === 'SHORT' ? -1 : 1; const w = (p.sizePct || 0.1) * 2.2;
            dsum += w * dir; wsum += w;
        }
        for (const sym of ['BTC', 'ETH', 'SOL']) {
            const m = neoMultiState.markets[sym];
            if (m && m.bestSide && m.bestProb != null) {
                const w = ((typeof alloc !== 'undefined' && alloc[sym]) || 0.1) + 0.1;
                const dir = m.bestSide === 'SHORT' ? -1 : 1; const conv = Math.min(1, Math.max(0, (m.bestProb - 0.5) * 3));
                dsum += w * dir * conv; wsum += w;
            }
        }
        if (wsum > 0) decisionBias = Math.max(-1, Math.min(1, dsum / wsum));
    } catch (e) {}
    // val terug op BTC-momentum + lastDecision alleen als de cores/posities niets zeggen
    if (Math.abs(decisionBias) < 0.02) {
        decisionBias = inp.momentum * 0.3 + inp.vfm * 0.2;
        try { if (typeof lastDecision !== 'undefined' && lastDecision && typeof lastDecision.decision === 'string') {
            if (/bull|long|stijg/i.test(lastDecision.decision)) decisionBias = Math.max(decisionBias, 0.3);
            else if (/bear|short|crash|daal/i.test(lastDecision.decision)) decisionBias = Math.min(decisionBias, -0.3);
        } } catch (e) {}
    }
    layers[4][0].act = Math.max(0, decisionBias);       // LONG
    layers[4][1].act = Math.max(0.05, 1 - Math.abs(decisionBias)); // NEUTRAAL
    layers[4][2].act = Math.max(0, -decisionBias);      // SHORT
    if (layers[5] && layers[5][0]) layers[5][0].act = Math.max(Math.abs(decisionBias), 0.2); // het ene eindpunt

    // ---- verbindingen: swingen + oplichten waar de compute-golf is ----
    // Elke verbinding krijgt een duidelijke grondlaag (altijd zichtbaar, zodat de hele
    // netwerkstructuur leesbaar is - ook tussen confluence/integratie/gewichten), plus
    // een oplicht-component waar de compute-golf en activatie doorheen trekken.
    // KLEUR: in rust volgt elke verbinding de kleur van zijn HERKOMST-input (geel/groen/
    // paars/cyaan/...); zodra hij oplicht terwijl Neo rekent, kleurt hij Osiris-neonblauw.
    const OSIRIS_NEON = '80,240,255';
    // bepaal per node in de eerste laag zijn kleur (rgb), propageer die als "signaalkleur"
    if (!_neonet._srcCol) {
        // signaalkleur per node per laag: laag 0 = input-kleur, dieper = gemengd/overgeërfd
        const hex2rgb = h => { const n = parseInt(h.slice(1), 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; };
        const src = layers.map(l => l.map(() => '130,180,230'));
        layers[0].forEach((nd, i) => src[0][i] = hex2rgb(NEONET_INPUTS[i].c));
        // elke diepere node erft de kleur van de sterkst-verbonden bron ervoor (grof, 1x)
        for (let li = 1; li < layers.length; li++) {
            layers[li].forEach((nd, j) => {
                let best = null, bw = -1;
                for (const cn of conns) if (cn.li === li - 1 && cn.b === j) { if (Math.abs(cn.w) > bw) { bw = Math.abs(cn.w); best = cn.a; } }
                src[li][j] = best != null ? src[li - 1][best] : '130,180,230';
            });
        }
        _neonet._srcCol = src;
    }
    const srcCol = _neonet._srcCol;
    // DATA-WARE VERBINDINGEN (12-08): helderheid + dikte volgen de ECHTE co-activatie
    // (bron-activatie x doel-activatie). Inactieve edges blijven een zwakke structuurlijn;
    // actieve edges dragen een gerichte data-puls die van bron -> doel reist (links -> rechts),
    // met snelheid en helderheid evenredig aan het signaal. Geen sweep-golf meer.
    for (const cn of conns) {
        const A = pos[cn.li][cn.a], B = pos[cn.li + 1][cn.b];
        const aAct = layers[cn.li][cn.a].act || 0;
        const bAct = layers[cn.li + 1][cn.b].act || 0;
        const signal = Math.max(0, Math.min(1, aAct * bAct));     // echte signaalsterkte over deze edge
        const baseCol = srcCol[cn.li][cn.a];
        const hot = signal > 0.28;
        const col = hot ? OSIRIS_NEON : baseCol;
        // De LIJN zelf flasht: de verbinding tussen de parameters licht op, helderheid
        // pulseert (data bepaalt de basis + hoe fel). Geen los reizend deeltje meer.
        const flash = 0.5 + 0.5 * Math.sin(now / 340 * (0.7 + cn.sp) + cn.flow * 6.28);
        // (22-08b) standaard-verbindingslijnen iets duidelijker: hogere basis-helderheid + -dikte,
        // zodat de vaste netwerkstructuur beter leesbaar is; actieve edges blijven feller pulseren.
        const a = 0.13 + 0.30 * signal + (0.10 + 0.34 * signal) * flash;
        ctx.strokeStyle = `rgba(${col},${a.toFixed(3)})`;
        ctx.lineWidth = 0.6 + 0.8 * signal;
        // (22-08) lightning/gloed VERWIJDERD op verzoek: schone lijnen, geen shadowBlur-crackle.
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
        // CONTINUE DATA-FLOW: klein deeltje reist voorwaarts (A -> B) langs ELKE lijn, zodat de
        // hele stroom van inputs naar uitkomst continu zichtbaar beweegt (kleur = herkomst).
        {
            const _ft = ((now / 760) + cn.li * 0.16 + (cn.flow || 0)) % 1;
            const _fx = A.x + (B.x - A.x) * _ft, _fy = A.y + (B.y - A.y) * _ft;
            const _fa = 0.16 + 0.6 * signal;
            ctx.beginPath(); ctx.arc(_fx, _fy, 0.7 + 1.5 * signal, 0, 6.283);
            ctx.fillStyle = `rgba(${hot ? OSIRIS_NEON : baseCol},${_fa.toFixed(3)})`;
            ctx.fill();
        }
        // FEEDBACK-FLITS: groen deeltje reist achterwaarts (B -> A) langs deze bestaande lijn
        // wanneer de feedback-golf door deze laag trekt - de uitkomst die terugvloeit.
        if (_fbActive && _fbPos >= cn.li && _fbPos <= cn.li + 1) {
            const _t = _fbPos - cn.li;
            const _px = A.x + (B.x - A.x) * _t, _py = A.y + (B.y - A.y) * _t;
            ctx.strokeStyle = `rgba(20,241,149,${(0.14 * (1 - Math.abs(_t - 0.5))).toFixed(3)})`;
            ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
            // (22-08b) geen gloed meer + terugflits-deeltje HEEL klein op verzoek
            ctx.beginPath(); ctx.arc(_px, _py, 0.35, 0, 6.283); ctx.fillStyle = 'rgba(170,255,215,0.65)'; ctx.fill();
        }
    }

    // ---- neuronen ----
    const outLabels = ['LONG', 'NEUT', 'SHORT'], outCols = ['#00ff9f', '#5c7488', '#ff4f6d'];
    const isBig = (canvasId === 'neo-net-canvas-big' || canvasId === 'neo-net-canvas-wal');   // meer detail op het grote canvas
    for (let li = 0; li < layers.length; li++) {
        for (let i = 0; i < layers[li].length; i++) {
            const p = pos[li][i], nd = layers[li][i];
            const puls = 0.5 + 0.5 * Math.sin(now / 620 + (nd.tw || 0));   // zachte eigen-puls
            const glow = nd.act * (0.55 + 0.45 * puls);                     // helderheid ~ echte activatie
            const r = (li === layers.length - 1 ? 12 : 5) + nd.act * 4 + nd.act * puls * 1.6;
            // input-knopen krijgen hun eigen signaalkleur (rijker beeld)
            let baseCol = 'rgba(130,200,255,GLOW)';
            if (li === 0) { const c = NEONET_INPUTS[i].c; baseCol = _hexToRgba(c, '__A__'); }
            // ring
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283);
            const _endLi = layers.length - 1, _outLi = layers.length - 2;
            if (li === 0) ctx.fillStyle = baseCol.replace('__A__', (0.15 + 0.6 * glow).toFixed(3));
            else if (li === _endLi) ctx.fillStyle = `rgba(0,217,255,${(0.45 + 0.55 * nd.act).toFixed(3)})`;  // het ene eindpunt
            else if (li === _outLi && layers[li].length === 3) ctx.fillStyle = outCols[i];
            else ctx.fillStyle = `rgba(130,200,255,${0.12 + 0.6 * glow})`;
            if (li === _outLi && layers[li].length === 3) ctx.globalAlpha = 0.3 + 0.7 * nd.act;
            ctx.fill(); ctx.globalAlpha = 1;
            if (li === _endLi) { ctx.save(); ctx.shadowColor = 'rgba(0,217,255,0.9)'; ctx.shadowBlur = 12 + 14 * nd.act; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.strokeStyle = 'rgba(0,217,255,0.8)'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore(); }
            ctx.lineWidth = 1; ctx.strokeStyle = `rgba(200,235,255,${0.2 + 0.6 * glow})`; ctx.stroke();
            // kern-flits op sterk-actieve knopen (data-gedreven, niet golf)
            if (nd.act > 0.5) { ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.4, 0, 6.283); ctx.fillStyle = `rgba(255,255,255,${(0.5 * nd.act * puls).toFixed(3)})`; ctx.fill(); }
            // ACTIVATIE-WAARDE als percentage (alleen groot canvas, waar ruimte is)
            if (isBig && nd.act > 0.08) {
                ctx.font = "6px 'JetBrains Mono', monospace"; ctx.textAlign = 'center';
                ctx.fillStyle = `rgba(220,240,255,${(0.4 + 0.5 * nd.act).toFixed(2)})`;
                const valTxt = li === 0 ? `${(nd.sign < 0 ? '-' : '')}${Math.round(nd.act * 100)}` : `${Math.round(nd.act * 100)}`;
                ctx.fillText(valTxt, p.x, p.y + r + 7);
            }
        }
    }

    // ---- laag-labels (in de ondermarge, boven de HTML-voettekst) ----
    ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = 'center';
    const lnames = (_neonet.layerLabels) || ['INPUTS', 'INTEGRATION', 'CORES', 'OSIRIS', 'DECISION', 'OUTPUT'];
    for (let li = 0; li < layers.length; li++) {
        ctx.fillStyle = 'rgba(92,116,136,0.85)';
        ctx.fillText(lnames[li], pos[li][0].x, h - padBot * 0.62);   // (22-08) verder onder de dataflow, ruim boven de status-regel
    }
    // ---- HMM-regime + shadow-backtest OP HET NETWERK (alleen groot canvas) ----
    if (isBig) {
        const rc = { trending: '#14f195', volatiel: '#ffb627', compressie: '#7fd8ff', kalm: '#8aa0ff' };
        const cx = w / 2;
        if (typeof OsirisRegimeHMM !== 'undefined') {
            const H = OsirisRegimeHMM;
            const label = H.trained ? (H.label || 'kalm') : 'kalibreert';
            const col = rc[label] || '#c792ea';
            ctx.textAlign = 'center';
            ctx.font = "bold 11px 'Orbitron','JetBrains Mono',monospace";
            ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillStyle = col;
            ctx.fillText(`REGIME · ${label.toUpperCase()}`, cx, 18); ctx.restore();
            if (H.trained) {
                ctx.font = "8px 'JetBrains Mono',monospace"; ctx.fillStyle = 'rgba(180,200,220,0.7)';
                ctx.fillText(`HMM · zekerheid ${(H.prob * 100 | 0)}% · ${H.stable} candles stabiel`, cx, 31);
            }
            // 4 verborgen-state dots, de actieve state opgelicht in zijn regime-kleur
            const K = H.K || 4, dotY = 42, gap = 16, x0 = cx - (K - 1) * gap / 2;
            for (let k = 0; k < K; k++) {
                const active = (H.current === k);
                const scol = (H.order && rc[H.order[k]]) ? rc[H.order[k]] : '#5a6b7a';
                ctx.beginPath(); ctx.arc(x0 + k * gap, dotY, active ? 4.2 : 2.3, 0, 6.283);
                if (active) { ctx.save(); ctx.shadowColor = scol; ctx.shadowBlur = 9; ctx.fillStyle = scol; ctx.fill(); ctx.restore(); }
                else { ctx.fillStyle = 'rgba(120,140,160,0.35)'; ctx.fill(); }
            }
        }
        if (typeof OsirisShadowBacktest !== 'undefined' && OsirisShadowBacktest.best) {
            const B = OsirisShadowBacktest.best;
            ctx.textAlign = 'right'; ctx.font = "8px 'JetBrains Mono',monospace"; ctx.fillStyle = 'rgba(20,241,149,0.85)';
            ctx.fillText(`SHADOW-BT · tgt ${B.target}% / stop ${B.stop}% · Sharpe ${B.sharpe.toFixed(2)}`, w - 14, h - 20);
        }
        // RL-agent advies-badge (linksonder)
        if (typeof OsirisRL !== 'undefined' && OsirisRL.episodes > 0) {
            const R = OsirisRL; const d = R.lastDecision;
            ctx.textAlign = 'left'; ctx.font = "8px 'JetBrains Mono',monospace";
            ctx.fillStyle = 'rgba(127,216,255,0.85)';
            const adv = d ? `${R.ACTIONS[d.action]} ${(d.conf * 100 | 0)}%` : '\u2014';
            ctx.fillText(`RL · ${(R.episodes / 1000).toFixed(0)}k scenario's · advies ${adv}`, 14, h - 20);
        }
        // FSO SYSTEEM-STRESS: badge (regime + niveau) rechtsboven + subtiele stress-aura.
        try {
            if (typeof osirisStress !== 'undefined' && osirisStress.ts && (Date.now() - osirisStress.ts < 60 * 60000)) {
                const lvl = osirisStress.level || 0;
                const rc = osirisStress.regime === 'CRISIS' ? '#ff4f6d' : osirisStress.regime === 'SPANNING' ? '#ffb627' : '#14f195';
                // aura: hoe hoger de stress, hoe roder de rand-gloed van het net
                if (lvl > 0.15) {
                    const ag = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.62);
                    ag.addColorStop(0, 'rgba(0,0,0,0)'); ag.addColorStop(1, `rgba(255,79,109,${Math.min(0.16, (lvl - 0.15) * 0.5)})`);
                    ctx.fillStyle = ag; ctx.fillRect(0, 0, w, h);
                }
                // (22-08) verplaatst naar onder de HTML 'Osiris decision'-badge (rechtsboven),
                // zodat de FSO-stress-tekst en de SHORT/LONG-uitkomst elkaar niet meer overlappen.
                ctx.textAlign = 'right'; ctx.font = "bold 9px 'JetBrains Mono',monospace"; ctx.fillStyle = rc;
                ctx.fillText(`◉ FSO ${osirisStress.regime} · stress ${lvl.toFixed(3)}`, w - 14, 62);
                ctx.font = "8px 'JetBrains Mono',monospace"; ctx.fillStyle = 'rgba(127,180,255,0.85)';
                ctx.fillText(`σ² ${(osirisStress.variance || 0).toFixed(4)} · asynchronie`, w - 14, 74);
            }
        } catch (e) {}
        // TESLA-LIGHTNING: gekartelde bliksem ALLEEN tussen de laatste lagen
        // (Osiris -> Decision -> Output), flikkerend en data-true. Puur visueel.
        try {
            const _bolt = (A, B, col, act, seed) => {
                if (!A || !B || act < 0.12) return;
                if (Math.sin(now / 90 + seed * 2.3) < 0.35) return;   // flikker
                ctx.save(); ctx.beginPath(); ctx.moveTo(A.x, A.y);
                const seg = 8;
                for (let k = 1; k <= seg; k++) {
                    const t = k / seg; const bx = A.x + (B.x - A.x) * t, by = A.y + (B.y - A.y) * t;
                    const jag = Math.sin(Math.PI * t) * 16; const ox = (Math.random() - 0.5) * jag, oy = (Math.random() - 0.5) * jag;
                    ctx.lineTo(bx + ox, by + oy);
                }
                ctx.strokeStyle = _rgba(col, 0.4 + 0.45 * act); ctx.lineWidth = 1.1;
                ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.stroke(); ctx.restore();
            };
            const _n = pos.length;
            if (_n >= 3) {
                const osi = pos[_n - 3], dec = pos[_n - 2], out = pos[_n - 1];
                const osiA = layers[_n - 3], decA = layers[_n - 2];
                // De Osiris-laag = de parameters zelf: 0=BTC, 1=ETH, 2=SOL, 3=OSIRIS-mainbrain.
                // Kleur elke boog naar zijn BRON-knoop, zodat de kleuren data-true zijn.
                const _coreCol = ['#f7931a', '#8fb8ff', '#14f195', '#7fd8ff'];
                // dominante parameter (sterkste osiris-knoop) bepaalt de kleur van het laatste stuk
                let _di = 0, _dv = -1; for (let a = 0; a < osiA.length; a++) { const v = (osiA[a] && osiA[a].act) || 0; if (v > _dv) { _dv = v; _di = a; } }
                const _domCol = _coreCol[_di] || '#7fd8ff';
                // Osiris -> Decision (kleur = bron-parameter)
                for (let a = 0; a < osi.length; a++) for (let b = 0; b < dec.length; b++) {
                    const act = Math.min(1, ((osiA[a] && osiA[a].act || 0) + (decA[b] && decA[b].act || 0)) / 2);
                    _bolt(osi[a], dec[b], _coreCol[a] || '#7fd8ff', act, a * 3 + b);
                }
                // Decision -> Output (kleur = dominante parameter)
                for (let b = 0; b < dec.length; b++) {
                    _bolt(dec[b], out[0], _domCol, Math.min(1, (decA[b] && decA[b].act || 0)), 20 + b);
                }
            }
        } catch (e) {}
        // FEEDBACK-LUS: de puls flitst nu TERUG langs de bestaande netwerklijnen (zie de
        // groene deeltjes in de verbindingen hierboven). Alleen nog een label onderaan.
        try {
            ctx.save();
            const _lblOn = (typeof _fbActive !== 'undefined' && _fbActive);
            ctx.fillStyle = _lblOn ? 'rgba(20,241,149,0.85)' : 'rgba(20,241,149,0.4)';
            ctx.font = "7.5px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
            ctx.fillText('\u21bb feedback \u00b7 uitkomst flitst terug door het net \u00b7 leert van elke trade', w / 2, h - 20);
            ctx.restore();
        } catch (e) {}
    }
    // input-labels links van de eerste kolom
    ctx.textAlign = 'right'; ctx.font = "7px 'JetBrains Mono', monospace";
    layers[0].forEach((nd, i) => { ctx.fillStyle = NEONET_INPUTS[i].c; ctx.fillText(NEONET_INPUTS[i].label, pos[0][i].x - 9, pos[0][i].y + 2.5); });
    // SUB-BREIN labels (laag 2): BTC/ETH/SOL in hun eigen kleur, op de knoop
    const brainCols = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };
    ctx.textAlign = 'center'; ctx.font = "bold 7px 'JetBrains Mono', monospace";
    if (layers[2]) layers[2].forEach((nd) => {
        if (nd.label) { ctx.fillStyle = brainCols[nd.label] || '#8b95a5'; ctx.fillText(nd.label, pos[2][nd.i].x, pos[2][nd.i].y - 8); }
    });
    // OSIRIS labels (laag 3): equity-aandeel per munt + mainbrain
    if (layers[3]) layers[3].forEach((nd) => {
        if (nd.label) { ctx.fillStyle = nd.label === 'OSIRIS' ? '#00d9ff' : (brainCols[nd.label] || '#8b95a5'); ctx.fillText(nd.label, pos[3][nd.i].x, pos[3][nd.i].y - 8); }
    });
    // output-labels rechts
    ctx.textAlign = 'left'; ctx.font = "7px 'JetBrains Mono', monospace";
    layers[4].forEach((nd, i) => { ctx.fillStyle = outCols[i]; ctx.fillText(outLabels[i], pos[4][i].x + 9, pos[4][i].y + 2.5); });

    // beslissing-tekst onderin het paneel bijwerken (id hangt af van welk canvas rendert)
    const outEl = document.getElementById(_neonet._outId || 'neo-net-out');
    if (outEl) {
        const dz = decisionBias;
        outEl.textContent = dz > 0.15 ? `LONG (${Math.round(Math.abs(dz) * 100)}%)` : dz < -0.15 ? `SHORT (${Math.round(Math.abs(dz) * 100)}%)` : 'NEUTRAAL';
        outEl.style.color = dz > 0.15 ? '#00ff9f' : dz < -0.15 ? '#ff4f6d' : '#5c7488';
    }
}

function startNeoNet() {
    if (!_neonet.raf) _neonet.raf = requestAnimationFrame(_neoNetFrame);
}
window.startNeoNet = startNeoNet;

// ============================================================
// NEO BREIN — Trinity-stijl ultra-realistisch orgaan (30-07)
// ============================================================
// Overgenomen van het betere Trinity-brein en aangepast voor Neo: echte sulci
// (hersengroeven) met pulserend licht, gyri-schaduw via fold-waarde, gradient-
// synapsen, bouwgolf die de contouren tekent. Uitgebreid kleurenpalet (BR_PAL2):
// niet enkel rood/groen - de particles, synaps-accenten en sulci-pulsen putten uit
// cyaan/blauw/paars/amber/roze/groen. De handels-bias (CNN+momentum) kleurt alleen
// de "actieve" synapsen groen (bullish) / rood (bearish); de rest blijft kleurrijk.
const BR_PAL2 = ['#00d9ff', '#4fc3f7', '#81d4fa', '#c792ea', '#ffb627', '#ff6ec7', '#14f195'];
const _bA = 0.56, _bB = 0.50, _bC = 0.82, _FAMP = 0.085;
function _foldVal(y, phi) {
    const v = 0.55 * Math.sin(6.2 * phi + 5 * y) + 0.34 * Math.sin(9.3 * phi - 7 * y + 1.3)
            + 0.22 * Math.sin(13.1 * phi + 3 * y + 2.1) + 0.15 * Math.sin(4 * phi - 11 * y + 0.6);
    return Math.max(-1, Math.min(1, v / 1.26));
}
function _bSurf(y, phi) {
    const yn = y / _bB, t = Math.max(0, 1 - yn * yn), r = Math.pow(t, 0.62);
    let ax = _bA * r, az = _bC * r;
    const temporal = Math.exp(-Math.pow((y + 0.04) / 0.20, 2)); ax *= 1 + 0.16 * temporal;
    const f = _foldVal(y, phi), disp = 1 + _FAMP * f; ax *= disp; az *= disp;
    let x = ax * Math.sin(phi), z = az * Math.cos(phi); z *= z > 0 ? 1.07 : 0.90;
    const mid = Math.exp(-Math.pow(x / 0.09, 2)) * Math.max(0, (y + 0.05) / _bB); let yo = y + 0.08 * mid;
    const base = Math.max(0, (-y - 0.18) / 0.32); yo -= 0.05 * base * base;
    return { x, y: yo, z, fold: f };
}
let _brain2 = null;
function buildNeoBrain2() {
    const pts = [], rings = [], sulci = [];
    function addPt(x, y, z, glow, ring, fold, dim) {
        const a = Math.random() * 6.28, rad = 2.4 + Math.random() * 2.6, el = (Math.random() - 0.5) * Math.PI;
        pts.push({ tx: x, ty: y, tz: z, glow, ring, fold: fold || 0, dim: dim || 1,
            x: Math.cos(el) * Math.cos(a) * rad, y: Math.sin(el) * rad, z: Math.cos(el) * Math.sin(a) * rad,
            tw: Math.random() * 6.28, sp: 0.5 + Math.random() * 1.5, fl: 0 });
        return pts.length - 1;
    }
    const RINGS = 48;
    for (let ri = 0; ri < RINGS; ri++) {
        const y = _bB - (ri / (RINGS - 1)) * (2 * _bB), t = Math.max(0.001, 1 - (y / _bB) * (y / _bB)),
            n = Math.max(18, Math.round(60 * Math.pow(t, 0.6))), ring = [];
        for (let k = 0; k < n; k++) { const phi = -Math.PI + (k / n) * 6.283 + (Math.random() - 0.5) * 0.03, q = _bSurf(y, phi); ring.push(addPt(q.x, q.y, q.z, false, ri, q.fold)); }
        rings.push(ring);
    }
    // cerebellum
    for (let j = 0; j < 7; j++) { const y = -0.26 - j * 0.045, ring = [], n = 20, rr = 0.28 * (1 - j / 9);
        for (let k = 0; k < n; k++) { const phi = -Math.PI + (k / n) * 6.283; ring.push(addPt(rr * Math.sin(phi) * 0.95, y, -0.52 - 0.12 * Math.cos(phi) - rr * 0.25, false, RINGS + j, 0.5 * Math.sin(k * 1.7))); } rings.push(ring); }
    // hersenstam
    for (let j = 0; j < 7; j++) { const y = -0.40 - j * 0.05, ring = [], n = 12, rr = 0.115 - j * 0.008, pons = Math.exp(-Math.pow((j - 1) / 1.5, 2)) * 0.03;
        for (let k = 0; k < n; k++) { const phi = -Math.PI + (k / n) * 6.283; ring.push(addPt((rr + pons) * Math.sin(phi), y, -0.06 + (rr + pons) * Math.cos(phi), false, RINGS + 7 + j, 0, 0.6)); } rings.push(ring); }
    // sulci (hersengroeven)
    function sulcus(list, side) {
        const idx = list.map(([y, phi]) => { const q = _bSurf(y, phi); return addPt(q.x * 0.99, q.y, q.z * 0.99 + 0.012, true, Math.round((_bB - y) / (2 * _bB) * (RINGS - 1)), -0.8); });
        sulci.push({ idx, side, pulse: Math.random(), speed: 0.35 + Math.random() * 0.4, col: BR_PAL2[Math.random() * BR_PAL2.length | 0] });
    }
    const fis = []; for (let f = -1; f <= 1.001; f += 0.14) { const zc = f, y = Math.sqrt(Math.max(0, 1 - zc * zc)) * 0.30 + 0.14; fis.push([y, zc > 0 ? 0.001 : Math.PI]); } sulcus(fis, 'top');
    sulcus([[0.32, 0.85], [0.18, 1.02], [0.03, 1.14], [-0.12, 1.2], [-0.25, 1.12]], 'xpos');
    sulcus([[0.32, -0.85], [0.18, -1.02], [0.03, -1.14], [-0.12, -1.2], [-0.25, -1.12]], 'xneg');
    sulcus([[0.45, 0.55], [0.47, 0.28], [0.46, 0], [0.47, -0.28], [0.45, -0.55]], 'top');
    sulcus([[0.30, 0.45], [0.24, 0.62], [0.16, 0.76]], 'xpos');
    sulcus([[0.30, -0.45], [0.24, -0.62], [0.16, -0.76]], 'xneg');
    const links = []; let g = 0;
    while (links.length < 8 && g++ < 3000) { const a = Math.random() * pts.length | 0, b = Math.random() * pts.length | 0, d = Math.hypot(pts[a].tx - pts[b].tx, pts[a].ty - pts[b].ty, pts[a].tz - pts[b].tz); if (d > 0.04 && d < 0.12) links.push({ a, b }); }
    // GEEN losse synapsen meer (dat waren de zilverwitte flitslijnen). Alleen de
    // kleurige particle-streams met trail blijven over als "beweging" in het brein.
    const syn = [];
    const amb = []; for (let i = 0; i < 34; i++) amb.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.012, vy: (Math.random() - 0.5) * 0.01, r: 0.7 + Math.random() * 1.6, tw: Math.random() * 6.28, sp: 0.3 + Math.random(), c: BR_PAL2[Math.random() * BR_PAL2.length | 0] });
    // CREATIE-LIJNEN (30-07): net als bij het hoofd - deeltjes die vanaf randpunten
    // een curve naar de brein-puntjes trekken en zo de vorm "opbouwen".
    const streams = [];
    // De kleurige particle-streams die van buiten het brein in gaan - DEZE blijven
    // (de gebruiker wil ze houden). 8 bronnen, elk 10 deeltjes.
    const borigins = [[0.0, 0.30], [0.0, 0.55], [0.0, 0.80], [1.0, 0.20], [1.0, 0.50], [1.0, 0.78], [0.35, 0.0], [0.65, 1.0]];
    for (let s = 0; s < borigins.length; s++) {
        const deeltjes = [];
        for (let k = 0; k < 10; k++) deeltjes.push({ t: Math.random(), sp: 0.20 + Math.random() * 0.26, tgt: (Math.random() * pts.length) | 0, bow: (Math.random() - 0.5) * 0.5, px: 0, py: 0 });
        streams.push({ ox: borigins[s][0], oy: borigins[s][1], c: BR_PAL2[s % BR_PAL2.length], deeltjes });
    }
    _brain2 = { pts, rings, sulci, links, syn, amb, streams, rotY: 0.5, formStart: null, tSec: 0 };
}
const _bshade = f => 0.35 + 0.65 * (0.5 + 0.5 * f);
let _neobrain = { raf: null, last: 0 };
function _neoBrainFrame(now) {
    _neobrain.raf = requestAnimationFrame(_neoBrainFrame);
    if (now - _neobrain.last < 33) return;
    const dt = Math.min(0.06, (now - _neobrain.last) / 1000) || 0.033; _neobrain.last = now;
    const cv = document.getElementById('neo-brain-canvas'); if (!cv || !_brain2) return;
    const bs = _brain2;
    const r = cv.getBoundingClientRect(); if (r.width < 10) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (Math.abs(cv.width - r.width * dpr) > 2) { cv.width = Math.max(2, r.width * dpr); cv.height = Math.max(2, r.height * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height; ctx.clearRect(0, 0, w, h);
    if (bs.formStart == null) bs.formStart = now; bs.tSec = Math.max(0, (now - bs.formStart - 150) / 1000);
    // bias uit CNN + momentum
    let bias = 0; try { const inp = neoNetInputs(); bias = inp.cnn * 0.6 + inp.momentum * 0.4; } catch (e) {}
    const bull = Math.max(0, bias), bear = Math.max(0, -bias);
    bs.rotY += dt * 0.19;
    // update
    for (const a of bs.amb) { a.x = (a.x + a.vx * dt + 1) % 1; a.y = (a.y + a.vy * dt + 1) % 1; }
    for (const s of bs.sulci) { s.pulse += dt * s.speed; if (s.pulse > 1.25) s.pulse -= 1.5; }
    for (const sy of bs.syn) { sy.t += dt / sy.dur; if (sy.t > 1) { sy.t = 0; const nl = bs.links[Math.random() * bs.links.length | 0]; if (nl) { sy.a = nl.a; sy.b = nl.b; } } }
    // ambient particles (kleurrijk)
    for (const a of bs.amb) { const tw = 0.14 + 0.4 * (0.5 + 0.5 * Math.sin(now / 900 * a.sp + a.tw)); ctx.globalAlpha = tw; ctx.fillStyle = a.c; ctx.fillRect(a.x * w - a.r / 2, a.y * h - a.r / 2, a.r, a.r); } ctx.globalAlpha = 1;
    const cx = w / 2, cy = h * 0.5, scale = Math.min(w, h) * 0.42, cosr = Math.cos(bs.rotY), sinr = Math.sin(bs.rotY);
    const rings = bs.rings, totalR = rings.length, CYCLE = 16, BUILD = 9, PRE = 4, L = totalR + BUILD + PRE, wave = (bs.tSec / CYCLE) * L;
    const pts = bs.pts, proj = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) { const p = pts[i]; let e = 0;
        if (wave >= p.ring) { const db = (wave - p.ring) % L; if (db < BUILD) { const k = db / BUILD; e = 1 - Math.pow(1 - k, 3); } else if (db > L - PRE) { const k = (L - db) / PRE; e = k * k; } else e = 1; }
        const x3 = p.x + (p.tx - p.x) * e, y3 = p.y + (p.ty - p.y) * e, z3 = p.z + (p.tz - p.z) * e, rx = x3 * cosr + z3 * sinr, rz = -x3 * sinr + z3 * cosr, persp = 1 / (2.5 - rz * 0.6);
        proj[i] = { sx: cx + rx * scale * persp, sy: cy - y3 * scale * persp, persp, rz, e }; }
    // CREATIE-LIJNEN: deeltjes trekken vanaf randpunten naar de brein-puntjes en
    // laten een lijn achter die de vorm "opbouwt" (net als bij het hoofd).
    if (bs.streams) {
        for (const st of bs.streams) {
            const ox = st.ox * w, oy = st.oy * h;
            for (const d of st.deeltjes) {
                d.t += d.sp * dt;
                const tq = proj[d.tgt];
                if (d.t >= 1 || !tq) { d.t = 0; d.tgt = (Math.random() * pts.length) | 0; d.sp = 0.20 + Math.random() * 0.26; d.bow = (Math.random() - 0.5) * 0.5; d.trail = []; continue; }
                const t = d.t, mt = 1 - t;
                const mx = (ox + tq.sx) / 2 - (tq.sy - oy) * d.bow, my = (oy + tq.sy) / 2 + (tq.sx - ox) * d.bow;
                const x = mt * mt * ox + 2 * mt * t * mx + t * t * tq.sx, y = mt * mt * oy + 2 * mt * t * my + t * t * tq.sy;
                // lange, vervagende light-trail achter de gekleurde particle (blijft!)
                if (!d.trail) d.trail = [];
                d.trail.push([x, y]); if (d.trail.length > 16) d.trail.shift();
                ctx.strokeStyle = st.c; ctx.lineWidth = 1.1;
                for (let s = 1; s < d.trail.length; s++) {
                    ctx.globalAlpha = (s / d.trail.length) * 0.6 * t;
                    ctx.beginPath(); ctx.moveTo(d.trail[s - 1][0], d.trail[s - 1][1]); ctx.lineTo(d.trail[s][0], d.trail[s][1]); ctx.stroke();
                }
                ctx.globalAlpha = 0.6 + 0.4 * t; ctx.fillStyle = st.c; const sz = 1.6 + t * 1.6; ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
            }
        }
        ctx.globalAlpha = 1;
    }
    // (gyri-contourlijnen verwijderd 31-07: gebruiker wil geen teken-lijnen, alleen
    //  de puntenwolk van het brein + de gekleurde deeltjes-streams eromheen)
    // sulci-lijnen verwijderd; alleen het pulserende lichtpuntje langs de groef blijft
    // als subtiel levend accent (een punt, geen lijn).
    for (const s of bs.sulci) { const vis = s.side === 'top' ? 0.9 : s.side === 'xpos' ? Math.max(0, -sinr) : Math.max(0, sinr); if (vis < 0.06) continue; const e0 = proj[s.idx[0]].e; if (e0 < 0.5) continue; const pj = s.idx.map(i => proj[i]);
        const seg = pj.length - 1, fp = s.pulse * seg; if (fp >= 0 && fp < seg) { const i0 = Math.floor(fp), fr = fp - i0, qa = pj[i0], qb = pj[i0 + 1], px = qa.sx + (qb.sx - qa.sx) * fr, py = qa.sy + (qb.sy - qa.sy) * fr; ctx.save(); ctx.shadowColor = s.col; ctx.shadowBlur = 13; ctx.fillStyle = s.col; ctx.globalAlpha = 0.9 * vis * e0; ctx.beginPath(); ctx.arc(px, py, 2.3, 0, 6.28); ctx.fill(); ctx.restore(); ctx.globalAlpha = 1; } }
    // (synaps-lijnen volledig verwijderd 31-07: alleen deeltjes-streams + puntenwolk)

    // knopen — met SCAN-animatie (zoals het hoofd) en beter zichtbaar
    // scanY beweegt verticaal op en neer door het brein; punten dicht bij de scan-lijn
    // lichten fel op, zodat er een scan-golf over het brein trekt.
    const scanYb = ((now / 2600) % 1.3) * 2 * _bB - _bB * 1.15;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = proj[i]; if (q.e <= 0.02) continue;
        const tw = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(now / 700 * p.sp + p.tw)), sh = _bshade(p.fold), depth = 0.55 + 0.45 * q.rz;
        const scanGlow = Math.exp(-Math.pow((p.ty - scanYb) / 0.09, 2));
        // basis-zichtbaarheid flink omhoog + scan-flits
        const s = ((p.glow ? 1.6 : 1.15) + 1.1 * q.persp) * (0.6 + 0.4 * tw) * (0.6 + 0.6 * sh) + scanGlow * 1.4;
        ctx.globalAlpha = Math.min(1, q.e * (0.35 + tw * 0.65 * sh + scanGlow * 0.6) * depth) * p.dim;
        ctx.fillStyle = scanGlow > 0.5 ? '#ffffff' : (p.glow ? '#eaffff' : (p.fold > 0.3 ? '#d6f2ff' : '#9fd4f0'));
        ctx.fillRect(q.sx - s / 2, q.sy - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    // scan-lijn zelf (subtiele horizontale gloed-band die met scanYb meebeweegt)
    {
        const sy = cy - scanYb * scale;
        const grd = ctx.createLinearGradient(0, sy - 8, 0, sy + 8);
        grd.addColorStop(0, 'rgba(120,200,255,0)'); grd.addColorStop(0.5, 'rgba(120,210,255,0.10)'); grd.addColorStop(1, 'rgba(120,200,255,0)');
        ctx.fillStyle = grd; ctx.fillRect(cx - scale, sy - 8, scale * 2, 16);
    }
    // bias-label
    const el = document.getElementById('neo-brain-out');
    if (el) { el.textContent = bias > 0.12 ? 'BULLISH' : bias < -0.12 ? 'BEARISH' : 'neutraal'; el.style.color = bias > 0.12 ? '#14f195' : bias < -0.12 ? '#ff4f6d' : '#5c7488'; }
}
function startNeoBrain() { if (!_brain2) { try { buildNeoBrain2(); } catch (e) {} } if (!_neobrain.raf) _neobrain.raf = requestAnimationFrame(_neoBrainFrame); }
window.startNeoBrain = startNeoBrain;
function updateCortexActivation() {
    const cfg = (typeof currentConfigVersion === 'function') ? currentConfigVersion() : '';
    const schoon = (typeof learningLog !== 'undefined') ? learningLog.filter(l => !l.manual && l.configVersion === cfg && l.outcome).length : 0;
    // groei stuurt nu de synaps-activiteit (de anatomie is altijd volledig)
    _neo.actMul = 0.6 + 0.8 * Math.min(1, schoon / 300);
    const sEl = document.getElementById('neo-samples');
    if (sEl) sEl.textContent = _l2 && _l2.trainedOn ? _l2.trainedOn : 0;
    const pEl = document.getElementById('neo-prob');
    if (pEl && _l2 && _l2.lastActivation) pEl.textContent = `${Math.round(_l2.lastActivation.prob * 100)}%`;
}

function updateL2UI() {
    const st = document.getElementById('cortex-status');
    const leg = document.getElementById('cortex-legend');
    const tr = document.getElementById('cortex-trades');
    const pr = document.getElementById('cortex-progress');
    // Level 3 paneel ook bijwerken
    try { renderL3Panel(); } catch (e) {}
    if (!_l2) return;
    if (st) {
        let base = _l2.trained ? `getraind · ${_l2.trainedOn} samples` : 'nog niet getraind';
        if (_l2.trained && _l2.lastTrainMs) base += ` · bijgewerkt ${formatFullDateTime(_l2.lastTrainMs)}`;
        if (_l3 && _l3.trained) {
            const acc = _l3.valAcc != null ? (_l3.valAcc * 100).toFixed(0) + '%' : '—';
            const actief = (_l3.valAcc != null && _l3.valAcc > 0.52);
            base += ` · L3-net ${acc}${actief ? ' (actief)' : ' (inactief, <52%)'}`;
        }
        st.textContent = base;
    }
    if (tr) tr.textContent = _l2.trainedOn || 0;
    if (pr) {
        // voortgang: schone trades richting een stabiel model (ruwweg 300)
        const cfg = (typeof currentConfigVersion === 'function') ? currentConfigVersion() : '';
        const schoon = (typeof learningLog !== 'undefined') ? learningLog.filter(l => !l.manual && l.configVersion === cfg && l.outcome).length : 0;
        pr.style.width = Math.min(100, (schoon / 300) * 100).toFixed(0) + '%';
    }
    // Alleen de BTC-legend bijwerken als de BTC-tab actief is; anders zou de live-loop
    // de ETH/SOL-tekst overschrijven (tekst-overlap bij het switchen van tab).
    const _l2BtcActive = (typeof _activeL2Brain === 'undefined') || _activeL2Brain === 'BTC';
    if (leg && _l2BtcActive && _l2.trained && _l2.weights) {
        const labs = ['vfm', 'mom', 'er', 'fib', 'patroon', 'svp'];
        const top = _l2.weights.map((w, i) => ({ l: labs[i], w })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 3);
        leg.innerHTML = 'sterkste signalen: ' + top.map(t => `<span style="color:${t.w > 0 ? 'var(--teal)' : 'var(--red)'};">${t.l} ${t.w > 0 ? '+' : ''}${t.w.toFixed(2)}</span>`).join(' · ');
    }
    updateCortexActivation();
}

// ---- Level 2 & Level 3 per-brein weergave ----
let _activeL2Brain = 'BTC', _activeL3Brain = 'BTC';
// SCHONE WEG: toon voor ETH/SOL/Osiris de ECHTE per-markt DeepNet-leerdata in de
// Level 2/3-tabs i.p.v. de lege BTC-facade. Dit is waar die breinen daadwerkelijk leren.
function _deepNetBrainHtml(sym) {
    const dn = (typeof OsirisDeepNet !== 'undefined') ? OsirisDeepNet : null;
    const col = { ETH: '#627eea', SOL: '#14f195', OSIRIS: '#00d9ff' }[sym] || '#7fd8ff';
    const title = sym === 'OSIRIS' ? 'Osiris Mainbrain' : ('Neo ' + sym);
    if (!dn) return `<div style="color:${col}; font-weight:700;">${title}</div><div style="color:var(--text-dim); font-size:0.85em;">DeepNet niet beschikbaar.</div>`;
    const m = (sym !== 'OSIRIS' && dn.markets[sym]) ? dn.markets[sym] : null;
    const wf = m ? m.wf : null;
    const last = (sym !== 'OSIRIS') ? dn.last[sym] : null;
    let rel = null; try { rel = dn.calibrationCurve(sym); } catch (e) {}
    const insight = (typeof _calibInsight === 'function') ? _calibInsight(rel) : '';
    let html = `<div style="color:${col}; font-weight:700; margin-bottom:6px;">${title} &middot; DeepNet (per-markt leren)</div>`;
    if (wf) {
        const pc = wf.precision >= 0.58 ? '#14f195' : (wf.precision >= 0.52 ? '#ffb627' : '#ff6b6b');
        html += `<div style="font-size:0.9em; line-height:1.8;">`
            + `Walk-forward: <b style="color:${pc};">precisie ${(wf.precision * 100).toFixed(0)}%</b> &middot; accuraatheid ${(wf.acc * 100).toFixed(0)}% &middot; n=${wf.n}<br>`
            + (last ? `Live kans: <b>${(last.calProb * 100).toFixed(0)}% ${last.side}</b> &middot; meta-poort ${last.meta ? '<span style="color:#14f195;">open</span>' : '<span style="color:#ff6b6b;">dicht</span>'}<br>` : '')
            + `Kalibratie: <b>${insight}</b>${rel && rel.map ? ` &middot; ${rel.map.length} curve-punten` : ''}`
            + `</div>`;
    } else {
        html += `<div style="font-size:0.85em; color:var(--text-dim);">DeepNet traint nog voor ${sym}... (verschijnt zodra er genoeg candles zijn)</div>`;
    }
    html += `<div style="font-size:0.62em; color:var(--text-dimmer); margin-top:8px;">Dit is het per-markt-leren voor ${sym === 'OSIRIS' ? 'de mainbrain (alle markten samen)' : sym}: een forward-return-predictor met Platt-kalibratie en purged walk-forward. De klassieke L1/L2/L3 zijn BTC-specifiek.</div>`;
    return html;
}
window._deepNetBrainHtml = _deepNetBrainHtml;

function switchL2Brain(sym) {
    _activeL2Brain = sym;
    document.querySelectorAll('#l2-brain-tabs .learning-tab').forEach(b => b.classList.toggle('active', b.dataset.brain === sym));
    const leg = document.getElementById('cortex-legend');
    if (!leg) return;
    if (sym === 'BTC') { updateL2UI(); return; }
    leg.innerHTML = _deepNetBrainHtml(sym);   // SCHONE WEG: echte DeepNet-data voor ETH/SOL/Osiris
}
window.switchL2Brain = switchL2Brain;

function switchL3Brain(sym) {
    _activeL3Brain = sym;
    document.querySelectorAll('#l3-brain-tabs .learning-tab').forEach(b => b.classList.toggle('active', b.dataset.brain === sym));
    if (sym === 'BTC') { renderL3Panel(); return; }
    const body = document.getElementById('l3-body');   // SCHONE WEG: DeepNet-data voor ETH/SOL/Osiris
    if (body) body.innerHTML = _deepNetBrainHtml(sym);
    const stEl = document.getElementById('l3-status'); if (stEl) stEl.textContent = '';
}
window.switchL3Brain = switchL3Brain;

function renderL3Panel() {
    const body = document.getElementById('l3-body');
    const stEl = document.getElementById('l3-status');
    if (!body) return;
    const sym = _activeL3Brain || 'BTC';
    const brainCol = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' }[sym] || '#00d9ff';
    const brainName = sym === 'BTC' ? 'Neo BTC' : (neoMultiState.markets[sym] && neoMultiState.markets[sym].brain ? neoMultiState.markets[sym].brain.label : 'Neo ' + sym);
    // Level 3 is momenteel één getraind net op de BTC-hoofddata. Voor ETH/SOL tonen we
    // de status; hun eigen net traint zodra er genoeg munt-trades zijn.
    if (sym === 'BTC') {
        if (_l3 && _l3.trained) {
            const acc = _l3.valAcc != null ? (_l3.valAcc * 100).toFixed(0) + '%' : '—';
            const actief = (_l3.valAcc != null && _l3.valAcc > 0.52);
            const accColor = _l3.valAcc == null ? 'var(--text-dim)' : (_l3.valAcc > 0.58 ? 'var(--teal)' : (_l3.valAcc > 0.52 ? '#ffb627' : '#ff4f6d'));
            if (stEl) stEl.textContent = actief ? 'actief' : 'inactief';
            body.innerHTML = `<div style="color:${brainCol}; font-weight:700; margin-bottom:6px;">&#9673; ${brainName} — getraind net (2 lagen, ${_l3.H} verborgen neuronen)</div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px;">
                    <div><span style="color:var(--text-dim);">Validatie-accuraatheid</span><br><b style="color:${accColor}; font-size:1.1em;">${acc}</b></div>
                    <div><span style="color:var(--text-dim);">Getraind op</span><br><b>${_l3.trainedOn} samples</b></div>
                    <div><span style="color:var(--text-dim);">Laatst getraind</span><br><b>${_l3.lastTrainMs ? formatFullDateTime(_l3.lastTrainMs) : '—'}</b></div>
                    <div><span style="color:var(--text-dim);">Status</span><br><b style="color:${actief?'var(--teal)':'#ff4f6d'};">${actief ? `meebeslissend (${(Math.max(0,Math.min(1,(_l3.valAcc-0.52)/0.13))*l3WeightCap().cap*100).toFixed(0)}%)` : 'inactief (<52%)'}</b></div>
                </div>
                <div style="margin-top:8px; color:var(--text-dimmer); font-size:0.92em; line-height:1.5;">Dit net leert NIET-LINEAIRE combinaties van de signalen (bv. "hoge VFM alleen bij lage chaos"). Het weegt pas mee als de validatie-accuraatheid boven 52% ligt — een overfitting-rem. De accuraatheid is gemeten op data die het net tijdens de training NIET zag.</div>`;
        } else {
            if (stEl) stEl.textContent = 'niet getraind';
            body.innerHTML = `<div style="color:${brainCol}; font-weight:700; margin-bottom:6px;">&#9673; ${brainName}</div><span style="color:var(--text-dim);">Het getrainde net heeft minstens ~60 schone trades nodig. Traint automatisch mee met Level 2 zodra er genoeg data is.</span>`;
        }
    } else {
        const trades = (typeof botTradeLog !== 'undefined' ? botTradeLog : []).filter(t => t.action === 'EXIT' && t.market === sym).length;
        if (stEl) stEl.textContent = 'wacht op data';
        body.innerHTML = `<div style="color:${brainCol}; font-weight:700; margin-bottom:6px;">&#9673; ${brainName} — getraind net</div>
            <span style="color:var(--text-dim);">Het eigen net van ${brainName} traint zodra er genoeg ${sym}-trades zijn (nu ${trades}, doel ~60). Tot dan gebruikt ${sym} zijn sub-brein-score plus de gedeelde fundamentals.</span>`;
    }
}
window.renderL3Panel = renderL3Panel;

function toggleCortexPanel() {
    const body = document.getElementById('cortex-body');
    const chev = document.getElementById('cortex-chevron');
    if (!body) return;
    const dicht = body.style.display === 'none';
    body.style.display = dicht ? 'block' : 'none';
    if (chev) chev.innerHTML = dicht ? '&#9662;' : '&#9656;';
}
function toggleCortexHeadPanel() {
    const body = document.getElementById('cortexhead-body');
    const chev = document.getElementById('cortexhead-chevron');
    if (!body) return;
    const dicht = body.style.display === 'none';
    body.style.display = dicht ? 'block' : 'none';
    if (chev) chev.innerHTML = dicht ? '&#9662;' : '&#9656;';
}
window.toggleCortexHeadPanel = toggleCortexHeadPanel;

// alles opstarten zodra de DOM klaar is
(function bootLanding() {
    function go() {
        try { buildDecorEye('hero-eye', 150, false); } catch (e) {}
        try { buildDecorEye('engine-eye', 132, false); } catch (e) {}
        try {
            buildDecorEye('wallet-eye', 150, false); // geen statische 6/9-teller
            try { buildDecorEye('about-eye', 150, false); } catch (e) {} // ocular core in de intro/About-tab
            try { buildOsirisBrain(); } catch (e) {} // interactieve brain in de Overzicht-tab
            const wsvg = document.getElementById('wallet-eye');
            if (wsvg) {
                const NS = 'http://www.w3.org/2000/svg';
                // Ronddraaiende balken per markt (BTC/ETH/SOL) om het oog i.p.v. tekst.
                // Ná buildDecorEye toegevoegd zodat ze niet in de sentiment-herkleuring vallen.
                const bars = [['btc', 186, '#f7931a', '16s', 0], ['eth', 172, '#8aa0ff', '21s', 1], ['sol', 158, '#14f195', '27s', 0]];
                for (const [k, r, c, dur, rev] of bars) {
                    const circ = 2 * Math.PI * r;
                    const circle = document.createElementNS(NS, 'circle');
                    circle.setAttribute('cx', '500'); circle.setAttribute('cy', '190'); circle.setAttribute('r', String(r));
                    circle.setAttribute('fill', 'none'); circle.setAttribute('stroke', c);
                    circle.setAttribute('stroke-width', '6'); circle.setAttribute('stroke-linecap', 'round');
                    circle.setAttribute('stroke-dasharray', `${(circ * 0.10).toFixed(0)} ${(circ * 0.90).toFixed(0)}`);
                    circle.setAttribute('opacity', '0.35'); circle.setAttribute('id', 'we-bar-' + k);
                    circle.dataset.circ = circ.toFixed(1);
                    const anim = document.createElementNS(NS, 'animateTransform');
                    anim.setAttribute('attributeName', 'transform'); anim.setAttribute('type', 'rotate');
                    anim.setAttribute('from', `${rev ? 360 : 0} 500 190`); anim.setAttribute('to', `${rev ? 0 : 360} 500 190`);
                    anim.setAttribute('dur', dur); anim.setAttribute('repeatCount', 'indefinite');
                    circle.appendChild(anim);
                    wsvg.appendChild(circle);
                }
            }
        } catch (e) {}
        try { initStarmap(); } catch (e) {}
        // (v4 gebruikt waypoint-tekst i.p.v. SVG jump-rails)
        try { initScrollSpy(); } catch (e) {}
        try { initFlowHud(); } catch (e) {}
        try { startQuantumOrb(); startNeoNet(); startNeoBrain(); updateL2UI(); } catch (e) {}
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


// ============================================================
// SITE-PLEXUS — de vormings-strepen over de HELE website
// ============================================================
// Dezelfde beeldtaal als de strepen die NEO's kop vormen: driftende punten,
// dun verbindingsweefsel en heldere vormings-flitsen, als vaste laag achter
// de complete pagina zodat de hele site "leeft". Bewust subtiel en licht
// (~22fps, pauzeert op verborgen tab) zodat de bot-loop er niets van merkt.
(function initSitePlexus() {
    function boot() {
        const cv = document.getElementById('site-plexus');
        if (!cv) return;
        const ctx = cv.getContext('2d');
        let W = 0, H = 0, last = 0;
        const N = 64, pts = [];
        const PAL = ['#00d9ff', '#ff4fd8', '#ffb627', '#14f195', '#c792ea'];
        for (let i = 0; i < N; i++) {
            pts.push({ x: Math.random(), y: Math.random(),
                vx: (Math.random() - 0.5) * 0.010, vy: (Math.random() - 0.5) * 0.008,
                tw: Math.random() * Math.PI * 2, sp: 0.3 + Math.random(),
                c: Math.random() < 0.16 ? PAL[(Math.random() * PAL.length) | 0] : '#5fb8e8' });
        }
        const stripes = [];
        for (let i = 0; i < 7; i++) stripes.push({ a: (Math.random() * N) | 0, b: (Math.random() * N) | 0, t: Math.random() * 4, dur: 2.5 + Math.random() * 2 });
        function frame(now) {
            requestAnimationFrame(frame);
            if (document.hidden || now - last < 45) return;
            const dt = Math.min(0.1, (now - last) / 1000) || 0.045; last = now;
            if (cv.width !== window.innerWidth || cv.height !== window.innerHeight) { cv.width = W = window.innerWidth; cv.height = H = window.innerHeight; }
            ctx.clearRect(0, 0, W, H);
            for (const p of pts) { p.x = (p.x + p.vx * dt + 1) % 1; p.y = (p.y + p.vy * dt + 1) % 1; }
            ctx.lineWidth = 0.5;
            for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
                const a = pts[i], b = pts[j];
                const dx = (a.x - b.x) * W, dy = (a.y - b.y) * H;
                const d2 = dx * dx + dy * dy;
                if (d2 > 44100) continue;
                ctx.strokeStyle = `rgba(70,150,210,${(1 - Math.sqrt(d2) / 210) * 0.10})`;
                ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.stroke();
            }
            for (const p of pts) {
                const tw = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(now / 900 * p.sp + p.tw));
                ctx.globalAlpha = tw; ctx.fillStyle = p.c;
                ctx.fillRect(p.x * W - 1, p.y * H - 1, 2, 2);
            }
            ctx.globalAlpha = 1;
            for (const s of stripes) {
                s.t += dt;
                if (s.t > s.dur) { s.a = (Math.random() * N) | 0; s.b = (Math.random() * N) | 0; s.t = 0; continue; }
                const k = s.t / s.dur, glow = Math.sin(k * Math.PI);
                const a = pts[s.a], b = pts[s.b];
                ctx.strokeStyle = `rgba(180,230,255,${glow * 0.35})`;
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.stroke();
            }
        }
        requestAnimationFrame(frame);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();


// ============================================================
// OOG-PLEXUS — de vormings-strepen rond het Ocular Core
// ============================================================
// Zelfde beeldtaal als de site-plexus en de strepen die NEO's kop vormen,
// maar lokaal achter het oog: driftende punten, dun weefsel, en heldere
// vormings-flitsen waarvan de helft naar het oogcentrum schiet - alsof de
// strepen het oog continu vormen. Achter de SVG (z-index), raakt niets aan
// de bestaande oog-animaties. ~22fps, pauzeert op verborgen tab.
(function initEyePlexus() {
    function boot() {
        const cv = document.getElementById('eye-plexus');
        if (!cv) return;
        const ctx = cv.getContext('2d');
        let W = 0, H = 0, last = 0;
        const N = 42, pts = [];
        const PAL = ['#00d9ff', '#ff4fd8', '#ffb627', '#14f195', '#c792ea'];
        for (let i = 0; i < N; i++) {
            pts.push({ x: Math.random(), y: Math.random(),
                vx: (Math.random() - 0.5) * 0.012, vy: (Math.random() - 0.5) * 0.010,
                tw: Math.random() * Math.PI * 2, sp: 0.3 + Math.random(),
                c: Math.random() < 0.18 ? PAL[(Math.random() * PAL.length) | 0] : '#5fb8e8' });
        }
        // flitsen: helft punt-naar-punt, helft punt-naar-oogcentrum (vormend)
        const stripes = [];
        for (let i = 0; i < 8; i++) stripes.push({ a: (Math.random() * N) | 0, b: (Math.random() * N) | 0, naarOog: i % 2 === 0, t: Math.random() * 4, dur: 2.2 + Math.random() * 2 });
        function frame(now) {
            requestAnimationFrame(frame);
            if (document.hidden || now - last < 45) return;
            const dt = Math.min(0.1, (now - last) / 1000) || 0.045; last = now;
            const rect = cv.getBoundingClientRect();
            if (rect.width < 10) return;
            if (cv.width !== Math.round(rect.width)) { cv.width = W = Math.round(rect.width); cv.height = H = Math.round(rect.height); }
            ctx.clearRect(0, 0, W, H);
            const ecx = W * 0.5, ecy = H * 0.5;                 // oogcentrum (svg is gecentreerd)
            for (const p of pts) { p.x = (p.x + p.vx * dt + 1) % 1; p.y = (p.y + p.vy * dt + 1) % 1; }
            ctx.lineWidth = 0.5;
            for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
                const a = pts[i], b = pts[j];
                const dx = (a.x - b.x) * W, dy = (a.y - b.y) * H;
                const d2 = dx * dx + dy * dy;
                if (d2 > 32400) continue;                        // 180px
                ctx.strokeStyle = `rgba(70,150,210,${(1 - Math.sqrt(d2) / 180) * 0.10})`;
                ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.stroke();
            }
            for (const p of pts) {
                const tw = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(now / 900 * p.sp + p.tw));
                ctx.globalAlpha = tw; ctx.fillStyle = p.c;
                ctx.fillRect(p.x * W - 1, p.y * H - 1, 2, 2);
            }
            ctx.globalAlpha = 1;
            for (const s of stripes) {
                s.t += dt;
                if (s.t > s.dur) { s.a = (Math.random() * N) | 0; s.b = (Math.random() * N) | 0; s.t = 0; continue; }
                const k = s.t / s.dur, glow = Math.sin(k * Math.PI);
                const a = pts[s.a];
                const bx = s.naarOog ? ecx : pts[s.b].x * W, by = s.naarOog ? ecy : pts[s.b].y * H;
                ctx.strokeStyle = `rgba(180,230,255,${glow * 0.35})`;
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(bx, by); ctx.stroke();
                if (s.naarOog) { ctx.fillStyle = '#bfeeff'; ctx.globalAlpha = glow * 0.8; ctx.beginPath(); ctx.arc(bx, by, 1.8, 0, 6.283); ctx.fill(); ctx.globalAlpha = 1; }
            }
        }
        requestAnimationFrame(frame);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

// ============================================================
// OSIRIS DEEPNET (02-08) — voorspellende laag voor ALLE 3 de markten
// ============================================================
// Doel: echte predictieve kracht + precisie, per markt (BTC/ETH/SOL).
//
// KERN-IDEE (t.o.v. de bestaande L2/L3, die op ~50 trade-uitkomsten leren):
// dit traint op BAR-LEVEL forward-returns. Elke candle krijgt een label
// (steeg de prijs de volgende HORIZON candles boven de drempel?), dus dúizenden
// samples per markt i.p.v. tientallen trades. Hergebruikt l2ExtractFeatures /
// l2Label / sigmoid zodat het consistent is met de rest van de engine.
//
// PRECISIE: elke voorspelling wordt (1) Platt-gekalibreerd, (2) door een
// abstentie-band gefilterd (alleen traden bij genoeg gekalibreerde edge),
// (3) getoetst op ensemble-overeenstemming met het sub-brein, en (4) door een
// meta-gate (walk-forward-precisie moet op orde zijn). Cross-markt: BTC-return
// per bar (op openTime uitgelijnd) is een 7e feature voor ETH/SOL (BTC leidt).
//
// VEILIGHEID: dit draait SHADOW. OsirisDeepNet.LIVE = false betekent dat het
// alleen voorspelt, logt en visualiseert — het raakt geen enkele live entry of
// exit. Zet LIVE pas op true nadat je de walk-forward-cijfers (per markt) hebt
// gezien en vertrouwt. De dynamische time-stop zit óók achter deze vlag.
// LET OP: nog niet runtime-gevalideerd. De walk-forward is nu PURGED (embargo van de
// horizon rond elke split), dus de precisie is eerlijk gemeten - maar klein in aantal
// tot er genoeg samples zijn; behandel de eerste uren als opwarmen.
const OsirisDeepNet = {
    LIVE: true,                  // draait live (executionMode is TESTNET); zet uit voor puur advies
    GATE_ENTRIES: true,          // INGREEP 1: DeepNet-poort op ETH/SOL-entries (terugdraaibaar)
    HORIZON: 5,                  // forward-return over 5 candles (15m -> ~75 min)
    THR: 0.001,                  // labeldrempel (+0.1%)
    ABSTAIN_MARGIN: 0.56,        // soepeler: >= 0.56 (long) of <= 0.44 (short); Osiris tuned dit autonoom
    META_MIN_PRECISION: 0.50,    // ZACHTE basis-drempel; _metaThreshold verlaagt 'm nog als de markt zich bewijst
    _realizedWinrate: {},        // werkelijke winrate per markt (uit gesloten trades)
    _lastWrUpdate: 0,
    _updateRealizedWinrate() {
        try {
            const ex = (typeof botTradeLog !== 'undefined' ? botTradeLog : []).filter(t => t.action === 'EXIT');
            for (const key of ['BTC', 'ETH', 'SOL']) {
                const rows = ex.filter(t => (t.market || 'BTC') === key).slice(-40);
                if (rows.length >= 10) this._realizedWinrate[key] = rows.filter(t => (t.pnl || 0) > 0).length / rows.length;
            }
        } catch (e) {}
    },
    _metaThreshold(key) {
        let base = this.META_MIN_PRECISION;          // 0.50
        const wr = this._realizedWinrate[key];
        if (wr != null) {
            if (wr >= 0.60) base = Math.min(base, 0.44);
            else if (wr >= 0.55) base = Math.min(base, 0.47);
        }
        return base;
    },
    RETRAIN_MS: 30 * 60 * 1000,  // hertrain-cadans
    REFRESH_MS: 60 * 1000,       // hoe vaak de laatste candles verversen voor live-predict
    SYMBOLS: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' },
    markets: { BTC: {}, ETH: {}, SOL: {} },   // per markt: model, platt, wf, kl, btcRet, trainedMs
    last: { BTC: null, ETH: null, SOL: null }, // laatste voorspelling per markt (voor viz + EV)
    log: [],                     // log van voorspellingen
    reasoningLine: '',           // samenvatting voor de live reasoning-feed
    tsAB: { DYN: [], FIXED: [] },// A/B-metingen: dynamische vs vaste time-stop
    dynTimeStopDisabled: false,  // Osiris zet dit autonoom aan als dyn slechter blijkt
    _lastTick: 0, _lastTrainKick: 0, _serviceStarted: false,
    _trainingBusy: false,
    _lastRefresh: 0,
    // ---------- INVERSIE-AUTOPILOOT (22-08, voorstel 1) ----------
    // Osiris meet doorlopend de ECHTE out-of-sample richting-hitrate van het RAUWE model per markt
    // (schaduw-voorspellingen die na HORIZON-candles tegen de werkelijke prijs gescoord worden).
    // Is een markt structureel fout (hitRate laag bij n>=25) of toont de walk-forward-curve INVERSIE,
    // dan keert Osiris de richting van díe markt automatisch om i.p.v. 'm te negeren. Herstelt het
    // model, dan schakelt de inversie weer uit (hysterese). Een consistent-foute voorspeller is bruikbaar.
    _dirOpen: [], _dirRes: {}, _dirLastFire: {}, _invert: {},
    DIR_FIRE_MIN: 15,            // minuten tussen schaduw-metingen per markt (onafhankelijke samples)
    DIR_MIN_N: 25,               // minimaal aantal metingen voor een inversie-besluit
    _fireDir(key, rawSide, price, now) {
        try {
            if (price == null || !rawSide) return;
            if (this._dirLastFire[key] && (now - this._dirLastFire[key]) < this.DIR_FIRE_MIN * 60000) return;
            this._dirLastFire[key] = now;
            this._dirOpen.push({ key, side: rawSide, entry: price, deadline: now + this.HORIZON * 15 * 60000 });
            if (this._dirOpen.length > 400) this._dirOpen.shift();
        } catch (e) {}
    },
    _resolveDir(now) {
        try {
            const still = [];
            for (const o of this._dirOpen) {
                if (now < o.deadline) { still.push(o); continue; }
                const m = (typeof neoMultiState !== 'undefined') ? neoMultiState.markets[o.key] : null;
                const px = m ? m.lastPrice : null;
                if (px == null) { still.push(o); continue; }
                const up = px >= o.entry;
                const hit = ((o.side === 'LONG') === up) ? 1 : 0;
                const arr = this._dirRes[o.key] || []; arr.push(hit); if (arr.length > 60) arr.shift(); this._dirRes[o.key] = arr;
            }
            this._dirOpen = still;
        } catch (e) {}
    },
    _evalInvert(key) {
        try {
            const arr = this._dirRes[key] || []; const n = arr.length;
            if (n < this.DIR_MIN_N) return;
            const hr = arr.reduce((a, b) => a + b, 0) / n;
            let wfInv = false;
            try { const m = this.markets[key]; if (m && m.wf && m.wf.n >= this.DIR_MIN_N) wfInv = /^INVERSIE/.test(_calibInsight(this.calibrationCurve(key)) || ''); } catch (e) {}
            const doInvert = (hr <= 0.33) || (wfInv && hr <= 0.45);
            if (!this._invert[key] && doInvert) {
                this._invert[key] = true;
                try { logAdaptation(`DeepNet-inversie AAN (${key})`, `out-of-sample hitRate ${(hr * 100) | 0}% over ${n}${wfInv ? ' + wf-curve omgekeerd' : ''} — Osiris keert de richting van deze markt autonoom om`); } catch (e) {}
            } else if (this._invert[key] && hr >= 0.55) {
                this._invert[key] = false;
                try { logAdaptation(`DeepNet-inversie UIT (${key})`, `hitRate hersteld naar ${(hr * 100) | 0}% over ${n} — normale richting`); } catch (e) {}
            }
        } catch (e) {}
    },
    // een markt is "bewezen gekalibreerd" als de walk-forward genoeg samples + precisie heeft
    // én de kalibratie-curve als 'goed gekalibreerd' beoordeeld wordt. Zo'n DeepNet mag de core
    // overrulen bij directe tegenspraak (voorstel 2), ook bij lagere conviction.
    _provenCalibrated(key) {
        try {
            const m = this.markets[key];
            if (!m || !m.wf || m.wf.n < 40 || (m.wf.precision || 0) < 0.55) return false;
            if (this._invert[key]) return false;                         // omgekeerde markt telt niet als 'bewezen'
            const ins = _calibInsight(this.calibrationCurve(key)) || '';
            return /goed gekalibreerd/.test(ins);
        } catch (e) { return false; }
    },

    // ---------- helpers ----------
    async _fetchKl(sym, interval, limit) {
        const r = await bFetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
        if (!r.ok) throw new Error(`klines ${sym} ${r.status}`);
        return await r.json();
    },
    _btcRetMap(btcKl) {
        const m = new Map();
        for (const k of btcKl) { const o = +k[1], c = +k[4]; m.set(k[0], o ? (c - o) / o : 0); }
        return m;
    },
    _featAt(kl, i, btcRet) {
        const base = (typeof l2ExtractFeatures === 'function') ? l2ExtractFeatures(kl, i) : null;
        if (!base) return null;
        const br = btcRet ? (btcRet.get(kl[i][0]) || 0) : 0;
        return base.concat([Math.tanh(br * 40)]);   // 7e feature = cross-markt BTC-return
    },

    // ---------- kleine logistische trainer (los van _l2, muteert niks globaals) ----------
    _fit(samples, epochs = 240, lr = 0.12) {
        if (!samples || samples.length < 60) return null;
        const n = samples[0].x.length;
        const mean = new Array(n).fill(0), std = new Array(n).fill(0);
        for (const s of samples) for (let k = 0; k < n; k++) mean[k] += s.x[k];
        for (let k = 0; k < n; k++) mean[k] /= samples.length;
        for (const s of samples) for (let k = 0; k < n; k++) std[k] += (s.x[k] - mean[k]) ** 2;
        for (let k = 0; k < n; k++) std[k] = Math.sqrt(std[k] / samples.length) || 1;
        const norm = x => x.map((v, k) => (v - mean[k]) / std[k]);
        let w = new Array(n).fill(0), b = 0;
        for (let e = 0; e < epochs; e++) {
            const gw = new Array(n).fill(0); let gb = 0;
            for (const s of samples) {
                const xn = norm(s.x);
                const z = xn.reduce((a, v, k) => a + v * w[k], b);
                const p = sigmoid(z), err = p - s.y;
                for (let k = 0; k < n; k++) gw[k] += err * xn[k];
                gb += err;
            }
            for (let k = 0; k < n; k++) w[k] -= lr * gw[k] / samples.length;
            b -= lr * gb / samples.length;
        }
        return { w, b, mean, std };
    },
    _fwd(model, x) {
        const xn = x.map((v, k) => (v - model.mean[k]) / model.std[k]);
        const z = xn.reduce((a, v, k) => a + v * model.w[k], model.b);
        return sigmoid(z);
    },
    // Platt-kalibratie: fit sigmoid(a*logit(p_raw)+b) op een aparte validatieset
    _fitPlatt(model, cal, epochs = 300, lr = 0.15) {
        if (!cal || cal.length < 30) return { a: 1, b: 0 };
        const logit = p => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))));
        const pts = cal.map(s => ({ l: logit(this._fwd(model, s.x)), y: s.y }));
        let a = 1, b = 0;
        for (let e = 0; e < epochs; e++) {
            let ga = 0, gb = 0;
            for (const p of pts) { const q = sigmoid(a * p.l + b), err = q - p.y; ga += err * p.l; gb += err; }
            a -= lr * ga / pts.length; b -= lr * gb / pts.length;
        }
        return { a, b };
    },
    _applyPlatt(platt, raw) {
        if (!platt) return raw;
        const l = Math.log(Math.max(1e-6, Math.min(1 - 1e-6, raw)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, raw))));
        return sigmoid(platt.a * l + platt.b);
    },
    // walk-forward-evaluatie op de test-tail (ongezien tijdens train + kalibratie)
    _eval(model, platt, test) {
        if (!test || !test.length) return null;
        let correct = 0, traded = 0, tradedCorrect = 0;
        for (const s of test) {
            const cal = this._applyPlatt(platt, this._fwd(model, s.x));
            const predUp = cal >= 0.5;
            if (predUp === (s.y === 1)) correct++;
            if (cal >= this.ABSTAIN_MARGIN || cal <= 1 - this.ABSTAIN_MARGIN) {
                traded++;
                const tp = cal >= 0.5 ? 1 : 0;
                if (tp === s.y) tradedCorrect++;
            }
        }
        const rel = test.map(s => ({ p: this._applyPlatt(platt, this._fwd(model, s.x)), y: s.y }));
        return {
            n: test.length,
            acc: correct / test.length,
            precision: traded > 0 ? tradedCorrect / traded : 0,
            coverage: traded / test.length,
            rel
        };
    },

    // ---------- training ----------
    async trainMarket(key) {
        const sym = this.SYMBOLS[key];
        const kl = await this._fetchKl(sym, '15m', 1000);
        const btcKl = (key === 'BTC') ? kl : await this._fetchKl('BTCUSDT', '15m', 1000);
        const btcRet = this._btcRetMap(btcKl);
        const samples = [];
        for (let i = 21; i < kl.length - 1 - this.HORIZON; i++) {
            const x = this._featAt(kl, i, btcRet);
            const y = (typeof l2Label === 'function') ? l2Label(kl, i, this.HORIZON, this.THR) : null;
            if (x && y !== null) samples.push({ x, y, t: kl[i][0] });
        }
        if (samples.length < 120) return { key, ok: false, reason: 'te weinig data' };
        samples.sort((a, b) => a.t - b.t);
        const nTr = Math.floor(samples.length * 0.70), nCa = Math.floor(samples.length * 0.15);
        // PURGED walk-forward: de labels kijken HORIZON candles vooruit, dus samples vlak
        // voor een split lekken toekomst in het volgende blok. We schrappen daarom HORIZON
        // samples voor elke grens (purge) plus een kleine embargo erna, zodat de gemeten
        // precisie eerlijk is (het model zag de testdata ook niet indirect).
        const H = this.HORIZON, EMB = Math.ceil(this.HORIZON / 2);
        const train = samples.slice(0, Math.max(1, nTr - H));
        const cal = samples.slice(nTr + EMB, Math.max(nTr + EMB, nTr + nCa - H));
        const test = samples.slice(nTr + nCa + EMB);
        const model = this._fit(train);
        if (!model) return { key, ok: false, reason: 'fit faalde' };
        const platt = this._fitPlatt(model, cal);
        const wf = this._eval(model, platt, test);
        const m = this.markets[key];
        m.model = model; m.platt = platt; m.rel = (wf && wf.rel) ? wf.rel : []; m.wf = wf ? { n: wf.n, acc: wf.acc, precision: wf.precision, coverage: wf.coverage } : null; m.trainedMs = Date.now();
        m.kl = kl.slice(-120); m.btcRet = btcRet;   // vers genoeg voor live-predict tot de volgende refresh
        this._persist(key);
        return { key, ok: true, samples: samples.length, wf };
    },
    async trainAll() {
        if (this._trainingBusy) return;
        this._trainingBusy = true;
        const out = {};
        for (const key of ['BTC', 'ETH', 'SOL']) {
            try { out[key] = await this.trainMarket(key); }
            catch (e) { out[key] = { key, ok: false, reason: e.message }; }
        }
        this._trainingBusy = false;
        try { console.log('[DeepNet] getraind:', out); } catch (e) {}
        try { if (typeof updateDeepNetPanel === 'function') updateDeepNetPanel(); } catch (e) {}
        return out;
    },
    async _refreshLatest() {
        const now = Date.now();
        if (now - this._lastRefresh < this.REFRESH_MS) return;
        this._lastRefresh = now;
        try {
            const btcKl = await this._fetchKl('BTCUSDT', '15m', 80);
            const btcRet = this._btcRetMap(btcKl);
            for (const key of ['BTC', 'ETH', 'SOL']) {
                const m = this.markets[key]; if (!m.model) continue;
                const kl = (key === 'BTC') ? btcKl : await this._fetchKl(this.SYMBOLS[key], '15m', 80);
                m.kl = kl; m.btcRet = btcRet;
            }
        } catch (e) { /* netwerk-hik, niet kritiek */ }
    },

    // ---------- voorspelling + gates ----------
    predict(key) {
        const m = this.markets[key];
        if (!m || !m.model || !m.kl || m.kl.length < 25) return null;
        const i = m.kl.length - 1;   // laatste (net gesloten) candle
        const x = this._featAt(m.kl, i, m.btcRet);
        if (!x) return null;
        const raw = this._fwd(m.model, x);
        const calBase = this._applyPlatt(m.platt, raw);
        const rawSide = calBase >= 0.5 ? 'LONG' : 'SHORT';              // richting van het RAUWE model (voor scoring)
        // INVERSIE-AUTOPILOOT: is deze markt structureel fout, dan keert Osiris de kans/richting om.
        const inverted = !!this._invert[key];
        const cal = inverted ? (1 - calBase) : calBase;
        const side = cal >= 0.5 ? 'LONG' : 'SHORT';
        const conf = Math.abs(cal - 0.5) * 2;
        const trade = cal >= this.ABSTAIN_MARGIN || cal <= 1 - this.ABSTAIN_MARGIN;
        // ensemble-overeenstemming met het sub-brein van deze markt
        let agree = null;
        try {
            const mm = neoMultiState.markets[key];
            if (mm && mm.bestSide) agree = (mm.bestSide === side);
        } catch (e) {}
        // meta-gate: zelf-corrigerend. De drempel zakt als de markt zich in de PRAKTIJK
        // bewijst (hoge realized winrate) ondanks een lage walk-forward - zodat de poort
        // niet permanent dicht blijft. agree !== false blijft (geen tegenspraak sub-brein).
        if (Date.now() - (this._lastWrUpdate || 0) > 30000) { this._updateRealizedWinrate(); this._lastWrUpdate = Date.now(); }
        const wfOk = m.wf ? (m.wf.precision >= this._metaThreshold(key)) : false;
        // VOORSTEL 2: een bewezen-gekalibreerde DeepNet mag de core overrulen bij directe tegenspraak,
        // ook bij lagere conviction (de SOL-case: DeepNet LONG, core SHORT, conf 0.24 haalde de oude 0.34 niet).
        const proven = this._provenCalibrated(key);
        const overrideBar = proven ? 0.15 : 0.34;
        const meta = trade && wfOk && (agree !== false || conf >= overrideBar);   // sterke/bewezen DeepNet mag door ondanks core-onenigheid
        const out = { key, raw, calProb: cal, calBase: +calBase.toFixed(4), rawSide, inverted, proven, side, conf, trade, agree, meta, features: x, ts: Date.now() };
        this.last[key] = out;
        return out;
    },

    // ---------- EV-gestuurde dynamische time-stop ----------
    // Betrouwbaarheidscurve (reliability diagram) uit de walk-forward-testset:
    // voorspelde DeepNet-kans vs werkelijke uitkomst. 'OSIRIS' = alle markten samen.
    // Levert een ECHTE curve, want de DeepNet-kans spreidt breed (i.t.t. de Osiris-pick ~55%).
    calibrationCurve(key) {
        let rel = [];
        if (key === 'OSIRIS') { for (const k of ['BTC', 'ETH', 'SOL']) if (this.markets[k] && this.markets[k].rel) rel = rel.concat(this.markets[k].rel); }
        else if (this.markets[key] && this.markets[key].rel) rel = this.markets[key].rel;
        if (rel.length < 15) return { map: null, n: rel.length };
        // QUANTIEL-BINNING (22-08): verdeel de voorspellingen in gelijk-gevulde bins i.p.v.
        // vaste 10%-vakken. Zo krijg je veel meer punten die állemaal genoeg samples hebben,
        // en de curve loopt netjes over het werkelijke voorspel-bereik (niet 4 losse punten).
        const arr = rel.map(r => ({ p: r.p * 100, y: r.y })).sort((a, b) => a.p - b.p);
        const nBins = Math.max(3, Math.min(10, Math.floor(arr.length / 12)));
        const per = Math.floor(arr.length / nBins);
        const pts = [];
        for (let b = 0; b < nBins; b++) {
            const seg = arr.slice(b * per, b === nBins - 1 ? arr.length : (b + 1) * per);
            if (seg.length < 5) continue;
            const px = seg.reduce((a, x) => a + x.p, 0) / seg.length;
            const py = seg.filter(x => x.y === 1).length / seg.length * 100;
            pts.push([px, py]);
        }
        if (pts.length < 1) return { map: null, n: rel.length };
        return { map: pts, n: rel.length, unit: 'wf-samples' };
    },
    keyOf(pos) {
        if (!pos) return null;
        if (pos.market && this.markets[pos.market]) return pos.market;
        try {
            const k = Object.keys(this.SYMBOLS).find(k => this.SYMBOLS[k] === pos.symbol);
            if (k) return k;
        } catch (e) {}
        return 'BTC';
    },
    _magnitudes(key) {
        // gemiddelde win/verlies-grootte uit recente EXITs van deze markt
        try {
            const ex = (typeof botTradeLog !== 'undefined' ? botTradeLog : [])
                .filter(t => t.action === 'EXIT' && (t.market || 'BTC') === key).slice(-40);
            const w = ex.filter(t => t.pnl > 0).map(t => t.pnl);
            const l = ex.filter(t => t.pnl <= 0).map(t => Math.abs(t.pnl));
            const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
            return { tgt: avg(w) || 0.003, stp: avg(l) || 0.004 };
        } catch (e) { return { tgt: 0.003, stp: 0.004 }; }
    },
    evHold(pos) {
        const key = this.keyOf(pos); if (!key) return null;
        const pr = this.last[key] ? this.last[key].calProb : null;
        if (pr == null) return null;
        const pWin = pos.side === 'LONG' ? pr : (1 - pr);
        const { tgt, stp } = this._magnitudes(key);
        return pWin * tgt - (1 - pWin) * stp;   // verwachte waarde van vasthouden (fractie)
    },
    dynamicTimeStopMinutes(pos, base) {
        const b = base || 90;
        const ev = this.evHold(pos);
        if (ev == null) return b;
        // ev +0.2% -> +50% tijd; negatieve ev -> krimpt richting 0.4x
        const scale = Math.max(0.4, Math.min(2.0, 1 + (ev / 0.002) * 0.5));
        return b * scale;
    },

    // ---------- shadow-tick (draait mee in de heartbeat, raakt niks live) ----------
    tick() {
        const now = Date.now();
        if (now - (this._lastTick || 0) < 8000) return;   // dedup, ongeacht wie aanroept
        this._lastTick = now;
        // ZELF-HERSTEL: mist een markt een model (bv. internet viel weg bij het opstarten),
        // probeer stil opnieuw te trainen zodra we weer online zijn (max 1x per 2 min).
        if (!this._trainingBusy && ['BTC', 'ETH', 'SOL'].some(k => !this.markets[k].model) && now - (this._lastTrainKick || 0) > 120000) {
            this._lastTrainKick = now;
            this.trainAll();
        }
        this._refreshLatest();
        // INVERSIE-AUTOPILOOT: eerst gerijpte schaduw-metingen scoren, dan per markt evalueren
        this._resolveDir(now);
        const parts = [];
        for (const key of ['BTC', 'ETH', 'SOL']) {
            const p = this.predict(key);
            if (p) {
                // scoor het RAUWE model out-of-sample (onafhankelijk van of we nu omkeren)
                try { const mm = neoMultiState.markets[key]; this._fireDir(key, p.rawSide, mm ? mm.lastPrice : null, now); } catch (e) {}
                this._evalInvert(key);
                this.log.push({ key, calProb: +p.calProb.toFixed(3), side: p.side, trade: p.trade, meta: p.meta, agree: p.agree, inverted: p.inverted, ts: p.ts });
                parts.push(`${key} ${(p.calProb * 100).toFixed(0)}% ${p.meta ? p.side + '\u2713' : (p.trade ? p.side : 'abst')}${p.inverted ? '\u21c4' : ''}`);
            }
        }
        if (this.log.length > 3000) this.log = this.log.slice(-3000);
        try { localStorage.setItem('osirisDeepNetDir', JSON.stringify({ res: this._dirRes, inv: this._invert })); } catch (e) {}
        // samenvatting voor de live reasoning-feed (mainbrain-keuze)
        let choice = null, best = -1;
        for (const key of ['BTC', 'ETH', 'SOL']) { const p = this.last[key]; if (p && p.meta && p.conf > best) { best = p.conf; choice = p; } }
        this.reasoningLine = `DEEPNET \u00b7 ${parts.join(' \u00b7 ')}${choice ? ` \u2192 kiest ${choice.key} ${choice.side} (${(choice.calProb * 100).toFixed(0)}%)` : ' \u2192 geen setup boven de drempel'}${this.LIVE ? '' : ' [advies]'}${this.dynTimeStopDisabled ? ' \u00b7 dyn-stop autonoom uit (A/B)' : ''}`;
        try { if (typeof updateDeepNetPanel === 'function') updateDeepNetPanel(); } catch (e) {}
    },

    // ---------- persistentie (alleen het model, niet de candles) ----------
    _persist(key) {
        try {
            const m = this.markets[key];
            localStorage.setItem('osirisDeepNet_' + key, JSON.stringify({ model: m.model, platt: m.platt, wf: m.wf, trainedMs: m.trainedMs }));
        } catch (e) {}
    },
    _restore() {
        for (const key of ['BTC', 'ETH', 'SOL']) {
            try {
                const s = localStorage.getItem('osirisDeepNet_' + key);
                if (s) { const o = JSON.parse(s); Object.assign(this.markets[key], o); }
            } catch (e) {}
        }
        try { const lv = localStorage.getItem('osirisDeepNetLive'); if (lv != null) this.LIVE = (lv === 'true'); } catch (e) {}
        try { const ab = localStorage.getItem('osirisDeepNetTsAB'); if (ab) this.tsAB = JSON.parse(ab); } catch (e) {}
        try { this.dynTimeStopDisabled = localStorage.getItem('osirisDeepNetDynOff') === 'true'; } catch (e) {}
        try { const g = localStorage.getItem('osirisDeepNetGate'); if (g != null) this.GATE_ENTRIES = (g === 'true'); } catch (e) {}
        try { const d = localStorage.getItem('osirisDeepNetDir'); if (d) { const o = JSON.parse(d); if (o) { this._dirRes = o.res || {}; this._invert = o.inv || {}; } } } catch (e) {}
    },
    // ---------- A/B: dynamische vs vaste time-stop (Osiris leert wat beter werkt) ----------
    assignTsMode() {
        // verken-tempo: normaal 50/50; staat dyn autonoom uit, dan nog 15% dyn zodat
        // Osiris blijft meten en zo nodig kan herstellen (explore/exploit).
        const dynRate = this.dynTimeStopDisabled ? 0.15 : 0.5;
        return Math.random() < dynRate ? 'DYN' : 'FIXED';
    },
    recordTimeStop(mode, pnlPct) {
        const m = (mode === 'DYN') ? 'DYN' : 'FIXED';
        this.tsAB[m].push(pnlPct);
        if (this.tsAB[m].length > 200) this.tsAB[m] = this.tsAB[m].slice(-200);
        try { localStorage.setItem('osirisDeepNetTsAB', JSON.stringify(this.tsAB)); } catch (e) {}
        this.evaluateTimeStopAB();
    },
    evaluateTimeStopAB() {
        const A = this.tsAB.DYN, B = this.tsAB.FIXED, MIN = 12;
        if (A.length < MIN || B.length < MIN) return;
        const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
        const dynM = mean(A.slice(-40)), fixM = mean(B.slice(-40));
        const worse = dynM < fixM - 0.0003;   // 0.03% marge
        if (worse && !this.dynTimeStopDisabled) {
            this.dynTimeStopDisabled = true;
            try { localStorage.setItem('osirisDeepNetDynOff', 'true'); } catch (e) {}
            try { logAdaptation('Dynamische time-stop UITgezet', `A/B toont dyn (${(dynM * 100).toFixed(2)}%) onder vast (${(fixM * 100).toFixed(2)}%) over ${A.length}/${B.length} exits - Osiris valt autonoom terug op de vaste time-stop en blijft 15% verkennen`); } catch (e) {}
        } else if (!worse && this.dynTimeStopDisabled) {
            this.dynTimeStopDisabled = false;
            try { localStorage.setItem('osirisDeepNetDynOff', 'false'); } catch (e) {}
            try { logAdaptation('Dynamische time-stop weer AAN', `A/B toont dyn (${(dynM * 100).toFixed(2)}%) nu gelijk/beter dan vast (${(fixM * 100).toFixed(2)}%) - Osiris hervat de dynamische stop`); } catch (e) {}
        }
    },
    // ---------- achtergrond-service (draait altijd; niks aanzetten nodig) ----------
    startService() {
        if (this._serviceStarted) return;
        this._serviceStarted = true;
        try { this.trainAll(); } catch (e) {}
        try { startDeepNetViz(); } catch (e) {}
        if (this._svcTick) clearInterval(this._svcTick);
        this._svcTick = setInterval(() => { try { this.tick(); } catch (e) {} }, 10000);
        if (this._svcTrain) clearInterval(this._svcTrain);
        this._svcTrain = setInterval(() => { try { this.trainAll(); } catch (e) {} }, this.RETRAIN_MS);
    },
    setGate(on) {
        this.GATE_ENTRIES = !!on;
        try { localStorage.setItem('osirisDeepNetGate', on ? 'true' : 'false'); } catch (e) {}
        try { updateDeepNetPanel(); } catch (e) {}
    },
    setLive(on) {
        this.LIVE = !!on;
        try { localStorage.setItem('osirisDeepNetLive', on ? 'true' : 'false'); } catch (e) {}
        try { updateDeepNetPanel(); } catch (e) {}
    }
};
OsirisDeepNet._restore();
window.OsirisDeepNet = OsirisDeepNet;
window.deepNetToggle = (on) => OsirisDeepNet.setLive(on);
window.deepNetGate = (on) => OsirisDeepNet.setGate(on);

// ============================================================
// OSIRIS GUARD (INGREEP 2) - circuit breaker + champion-snapshot
// Pauzeert Osiris-entries autonoom als de rollende expectancy (gem. pnl% over de
// laatste N Osiris-trades) onder de vloer zakt, en hervat zodra hij herstelt.
// Champion: leg een goede config vast en zet 'm terug als het zelf-tunen wegdreef.
// ============================================================
const OsirisGuard = {
    ENABLED: true,
    WINDOW: 20,          // aantal recente trades per markt in het venster
    FLOOR: -0.0005,      // gem. pnl < -0.05% -> pauzeren
    RESUME: 0.0,         // gem. pnl >= break-even -> hervatten
    MIN_TRADES: 8,       // pas oordelen vanaf zoveel trades PER MARKT
    MARKETS: ['ETH', 'SOL'],
    pausedMarkets: {},   // (22-08) PER MARKT i.p.v. één globale pauze
    lastExp: {},
    _restore() {
        try { this.pausedMarkets = JSON.parse(localStorage.getItem('osirisGuardPausedMk') || '{}') || {}; } catch (e) { this.pausedMarkets = {}; }
        try { const e = localStorage.getItem('osirisGuardEnabled'); if (e != null) this.ENABLED = (e === 'true'); } catch (e) {}
        try { localStorage.removeItem('osirisGuardPaused'); } catch (e) {}   // oude globale vlag opruimen
    },
    _persist() { try { localStorage.setItem('osirisGuardPausedMk', JSON.stringify(this.pausedMarkets)); } catch (e) {} },
    // backward-compat: 'paused' = alle Osiris-markten gepauzeerd (voor oude checks)
    get paused() { return this.MARKETS.every(k => this.pausedMarkets[k]); },
    rollingExpectancy(sym) {
        const ex = (typeof botTradeLog !== 'undefined' ? botTradeLog : [])
            .filter(t => t.action === 'EXIT' && (t.isOsiris === true || (t.market && t.market !== 'BTC')) && (sym ? t.market === sym : true));
        const rec = ex.slice(-this.WINDOW);
        if (rec.length < this.MIN_TRADES) return { exp: null, n: rec.length };
        return { exp: rec.reduce((a, t) => a + (t.pnl || 0), 0) / rec.length, n: rec.length };
    },
    // OPPORTUNITY-OVERRIDE (22-08): een markt met een OPEN DeepNet-meta én een sterke
    // FSO-bliksemkans mag NIET gepauzeerd worden - dat is juist de kans die je wil pakken.
    // De breaker is bedoeld om te stoppen met matige verliesgevende setups, niet om de
    // béste setup over te slaan (dat gaf: ETH/SOL gepauzeerd terwijl SOL meta-open stond).
    _override(sym) {
        try {
            const dnp = (typeof OsirisDeepNet !== 'undefined' && OsirisDeepNet.last) ? OsirisDeepNet.last[sym] : null;
            const metaOpen = dnp && dnp.meta;
            const opp = (typeof osirisMarketOpportunity === 'function') ? osirisMarketOpportunity(sym) : 0;
            return !!metaOpen && opp > 0.5;
        } catch (e) { return false; }
    },
    isPaused(sym) { if (!this.ENABLED) return false; if (this._override(sym)) return false; return !!this.pausedMarkets[sym]; },
    evaluate() {
        if (!this.ENABLED) { if (Object.keys(this.pausedMarkets).length) { this.pausedMarkets = {}; this._persist(); } return; }
        for (const sym of this.MARKETS) {
            const { exp, n } = this.rollingExpectancy(sym); this.lastExp[sym] = exp;
            if (exp == null) {
                if (this.pausedMarkets[sym]) { this.pausedMarkets[sym] = false; this._persist(); try { logAdaptation(`Circuit breaker ${sym}: gereset`, 'te weinig recente trades om op te oordelen - hervat'); } catch (e) {} }
                continue;
            }
            if (!this.pausedMarkets[sym] && exp < this.FLOOR && !this._override(sym)) {
                this.pausedMarkets[sym] = true; this._persist();
                try { logAdaptation(`Circuit breaker ${sym}: GEPAUZEERD`, `expectancy ${(exp * 100).toFixed(3)}% over ${n} trades onder de vloer (geen open meta/opportunity)`); } catch (e) {}
            } else if (this.pausedMarkets[sym] && (exp >= this.RESUME || this._override(sym))) {
                this.pausedMarkets[sym] = false; this._persist();
                try { logAdaptation(`Circuit breaker ${sym}: HERVAT`, this._override(sym) ? 'open meta + FSO-bliksemkans - kans wordt niet overgeslagen' : `expectancy ${(exp * 100).toFixed(3)}% terug boven break-even`); } catch (e) {}
            }
        }
        try { updateDeepNetPanel(); } catch (e) {}
    },
    setEnabled(on) {
        this.ENABLED = !!on;
        try { localStorage.setItem('osirisGuardEnabled', on ? 'true' : 'false'); } catch (e) {}
        if (!on) { this.pausedMarkets = {}; this._persist(); }
        try { updateDeepNetPanel(); } catch (e) {}
    },
    snapshotChampion() {
        try { localStorage.setItem('osirisChampion', JSON.stringify({ ts: Date.now(), settings: (typeof botSettings !== 'undefined' ? botSettings : null) })); return true; } catch (e) { return false; }
    },
    restoreChampion() {
        try {
            const s = localStorage.getItem('osirisChampion'); if (!s) return false;
            const o = JSON.parse(s);
            if (o.settings && typeof botSettings !== 'undefined') {
                Object.assign(botSettings, o.settings);
                try { localStorage.setItem('osirisBotSettings', JSON.stringify(botSettings)); } catch (e) {}
                try { populateSettingsInputsFromState(); } catch (e) {}
                try { logAdaptation('Champion-config hersteld', `Instellingen teruggezet naar snapshot van ${new Date(o.ts).toLocaleString('nl-NL')}`); } catch (e) {}
                return true;
            }
        } catch (e) {}
        return false;
    }
};
OsirisGuard._restore();
window.OsirisGuard = OsirisGuard;
window.osirisGuardToggle = (on) => OsirisGuard.setEnabled(on);
window.osirisSnapshotChampion = () => { if (OsirisGuard.snapshotChampion()) alert('Champion-config vastgelegd.'); };
window.osirisRestoreChampion = () => { if (confirm('Instellingen terugzetten naar de champion-snapshot?')) OsirisGuard.restoreChampion(); };
window.deepNetRetrain = () => OsirisDeepNet.trainAll();

// ============================================================
// DEEPNET-VISUAL — echte weergave van hoe Osiris' deepnet beslist
// ============================================================
// Tekent: input-features -> 3 sub-breinen (BTC/ETH/SOL, elk met gekalibreerde
// kans) -> Osiris mainbrain (kiest de sterkste meta-goedgekeurde markt) -> output.
// Leest live uit OsirisDeepNet.last, dus dit IS wat het net op dit moment doet.
const _dnviz = { raf: null, pulse: 0, last: 0 };
const _DN_COL = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };

function _deepnetDraw(now) {
    _dnviz.raf = requestAnimationFrame(_deepnetDraw);
    if (now - _dnviz.last < 40) return;
    _dnviz.last = now;
    const cv = document.getElementById('deepnet-canvas');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    if (rect.width < 20) return;
    if (cv.width !== Math.round(rect.width * 2)) { cv.width = rect.width * 2; cv.height = rect.height * 2; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    _dnviz.pulse = (_dnviz.pulse + 0.012) % 1;

    const keys = ['BTC', 'ETH', 'SOL'];
    const inX = w * 0.10, subX = w * 0.42, mainX = w * 0.72, outX = w * 0.92;
    const rowY = k => h * 0.24 + h * 0.26 * k;

    // mainbrain-keuze: sterkste markt met open meta-poort (anders: abstineren)
    let choice = null, best = -1;
    for (const key of keys) {
        const p = OsirisDeepNet.last[key];
        if (p && p.meta && p.conf > best) { best = p.conf; choice = p; }
    }

    // input-hint (features van de gekozen/eerste markt)
    const anyP = choice || OsirisDeepNet.last.BTC || OsirisDeepNet.last.ETH || OsirisDeepNet.last.SOL;
    const feats = anyP ? anyP.features : new Array(7).fill(0);
    const fLabels = ['vfm', 'mom', 'er', 'fib', 'pat', 'svp', 'btc→'];
    for (let i = 0; i < 7; i++) {
        const y = h * 0.12 + (h * 0.76) * (i / 6);
        const a = Math.min(1, Math.abs(feats[i] || 0));
        ctx.beginPath(); ctx.arc(inX, y, 3, 0, 6.28);
        ctx.fillStyle = `rgba(127,216,255,${0.25 + 0.6 * a})`; ctx.fill();
        ctx.fillStyle = 'rgba(127,216,255,0.5)'; ctx.font = '7px JetBrains Mono';
        ctx.textAlign = 'right'; ctx.fillText(fLabels[i], inX - 6, y + 2.5);
    }

    // sub-breinen
    keys.forEach((key, k) => {
        const p = OsirisDeepNet.last[key];
        const y = rowY(k);
        const cal = p ? p.calProb : 0.5;
        const col = _DN_COL[key];
        // input -> sub verbindingen (pulserend)
        for (let i = 0; i < 7; i++) {
            const iy = h * 0.12 + (h * 0.76) * (i / 6);
            const ph = (_dnviz.pulse + i * 0.05) % 1;
            ctx.beginPath(); ctx.moveTo(inX, iy); ctx.lineTo(subX, y);
            ctx.strokeStyle = `rgba(120,160,190,${0.04 + 0.05 * (p ? p.conf : 0)})`; ctx.lineWidth = 0.6; ctx.stroke();
            if (p) {
                const px = inX + (subX - inX) * ph, py = iy + (y - iy) * ph;
                ctx.beginPath(); ctx.arc(px, py, 1.1, 0, 6.28); ctx.fillStyle = `${col}55`; ctx.fill();
            }
        }
        // sub-node
        const r = 10 + 10 * (p ? p.conf : 0);
        ctx.beginPath(); ctx.arc(subX, y, r, 0, 6.28);
        ctx.fillStyle = _hexToRgba ? _hexToRgba(col, p && p.trade ? 0.9 : 0.4) : col;
        ctx.fill();
        ctx.strokeStyle = p && p.meta ? '#eaffff' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = p && p.meta ? 1.6 : 0.8; ctx.stroke();
        ctx.fillStyle = '#04121c'; ctx.font = 'bold 8px JetBrains Mono'; ctx.textAlign = 'center';
        ctx.fillText(key, subX, y - 1);
        ctx.fillStyle = col; ctx.font = '7.5px JetBrains Mono';
        ctx.fillText(`${(cal * 100).toFixed(0)}% ${p ? p.side : ''}`, subX, y + r + 9);
        if (p && p.agree === false) { ctx.fillStyle = '#ff6b6b'; ctx.fillText('≠sub', subX + r + 12, y + 2); }
        // sub -> mainbrain
        const my = h * 0.5;
        ctx.beginPath(); ctx.moveTo(subX + r, y); ctx.lineTo(mainX, my);
        ctx.strokeStyle = (choice && choice.key === key) ? `${col}cc` : `${col}22`;
        ctx.lineWidth = (choice && choice.key === key) ? 2.2 : 0.7; ctx.stroke();
    });

    // Osiris mainbrain
    const my = h * 0.5;
    ctx.beginPath(); ctx.arc(mainX, my, 16, 0, 6.28);
    ctx.fillStyle = choice ? _hexToRgba(_DN_COL[choice.key], 0.85) : 'rgba(0,217,255,0.35)';
    ctx.fill(); ctx.strokeStyle = '#00d9ff'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = '#02131c'; ctx.font = 'bold 8px JetBrains Mono'; ctx.textAlign = 'center';
    ctx.fillText('OSIRIS', mainX, my + 2.5);

    // output
    ctx.beginPath(); ctx.moveTo(mainX + 16, my); ctx.lineTo(outX, my); ctx.strokeStyle = 'rgba(234,255,255,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#eaffff'; ctx.font = 'bold 9px JetBrains Mono'; ctx.textAlign = 'center';
    if (choice) ctx.fillText(`${choice.key} ${choice.side}`, outX, my - 6);
    else { ctx.fillStyle = '#7d99ac'; ctx.fillText('abstineert', outX, my - 6); }
    ctx.fillStyle = choice ? _DN_COL[choice.key] : '#7d99ac'; ctx.font = '8px JetBrains Mono';
    if (choice) ctx.fillText(`${(choice.calProb * 100).toFixed(0)}%`, outX, my + 8);
}

function startDeepNetViz() {
    if (!_dnviz.raf) _dnviz.raf = requestAnimationFrame(_deepnetDraw);
}
window.startDeepNetViz = startDeepNetViz;

// tekstueel statuspaneel (per-markt walk-forward + live-status)
function updateDeepNetPanel() {
    const el = document.getElementById('deepnet-status');
    if (!el) return;
    const dn = OsirisDeepNet, live = dn.LIVE;
    const badge = `<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-weight:700; font-size:0.92em; background:${live ? 'rgba(20,241,149,0.15)' : 'rgba(255,182,39,0.15)'}; color:${live ? '#14f195' : '#ffb627'}; border:1px solid ${live ? 'rgba(20,241,149,0.4)' : 'rgba(255,182,39,0.4)'};">${live ? 'LIVE' : 'ADVIES'}</span>`;
    let cards = '';
    for (const key of ['BTC', 'ETH', 'SOL']) {
        const m = dn.markets[key], p = dn.last[key], col = _DN_COL[key];
        const wf = m && m.wf, prec = wf ? wf.precision : 0;
        const precCol = prec >= 0.58 ? '#14f195' : (prec >= 0.52 ? '#ffb627' : '#ff6b6b');
        const cal = p ? p.calProb : null;
        const dirArr = dn._dirRes && dn._dirRes[key] ? dn._dirRes[key] : [];
        const dirHr = dirArr.length ? dirArr.reduce((a, b) => a + b, 0) / dirArr.length : null;
        let flags = '';
        if (p && p.inverted) flags += `<span title="Osiris keert deze markt autonoom om: out-of-sample hitRate ${dirHr != null ? (dirHr * 100 | 0) + '%' : '\u2014'} over ${dirArr.length}" style="color:#ffb627; font-size:0.72em; font-weight:700;">\u21c4 omgekeerd</span>`;
        if (p && p.proven) flags += `${flags ? ' \u00b7 ' : ''}<span title="Bewezen gekalibreerd: mag de core overrulen bij tegenspraak" style="color:#14f195; font-size:0.72em; font-weight:700;">\u2713 bewezen</span>`;
        cards += `<div style="flex:1; min-width:118px; background:rgba(255,255,255,0.02); border:1px solid ${col}44; border-radius:6px; padding:7px 9px;">
            <div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:${col}; font-weight:700; font-size:0.9em;">${key}</span>${p ? `<span style="color:${p.meta ? '#eaffff' : '#7d99ac'}; font-size:0.85em;">${(cal * 100).toFixed(0)}% ${p.meta ? p.side + '\u2713' : (p.trade ? p.side : '\u2014')}</span>` : '<span style="color:#5c7488;">\u2014</span>'}</div>
            ${flags ? `<div style="margin-top:3px;">${flags}</div>` : ''}
            <div style="margin-top:5px; font-size:0.8em; color:#7d99ac;">walk-forward precisie</div>
            <div style="height:5px; background:rgba(255,255,255,0.07); border-radius:3px; margin-top:2px; overflow:hidden;"><div style="height:100%; width:${(prec * 100).toFixed(0)}%; background:${precCol};"></div></div>
            <div style="font-size:0.75em; color:${precCol}; margin-top:2px;">${wf ? `${(prec * 100).toFixed(0)}% \u00b7 acc ${(wf.acc * 100).toFixed(0)}% \u00b7 n=${wf.n}` : 'nog niet getraind'}</div>
        </div>`;
    }
    const ab = dn.tsAB || { DYN: [], FIXED: [] };
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const dynM = mean(ab.DYN), fixM = mean(ab.FIXED);
    let abTxt;
    if (dynM != null && fixM != null) {
        const better = dynM >= fixM;
        abTxt = `<div style="margin-top:7px; font-size:0.8em; color:#9fb3c8;">Time-stop A/B: <span style="color:${better ? '#14f195' : '#ff6b6b'};">dyn ${(dynM * 100).toFixed(2)}%</span> vs vast ${(fixM * 100).toFixed(2)}% (n=${ab.DYN.length}/${ab.FIXED.length}) \u2014 ${dn.dynTimeStopDisabled ? '<span style="color:#ffb627;">dyn autonoom uit, 15% verkenning</span>' : '<span style="color:#14f195;">dyn actief</span>'}</div>`;
    } else {
        abTxt = `<div style="margin-top:7px; font-size:0.78em; color:#5c7488;">Time-stop A/B verzamelt data (${ab.DYN.length}/${ab.FIXED.length} exits)\u2026</div>`;
    }
    const cb = document.getElementById('deepnet-live-toggle');
    if (cb) cb.checked = live;
    const gb = document.getElementById('deepnet-gate-toggle');
    if (gb) gb.checked = !!dn.GATE_ENTRIES;
    // circuit breaker-status + champion-knoppen
    const g = (typeof OsirisGuard !== 'undefined') ? OsirisGuard : null;
    let guardTxt = '';
    if (g) {
        const btn = 'font-size:0.9em; padding:2px 7px; border-radius:4px; border:1px solid rgba(0,217,255,0.35); background:rgba(0,217,255,0.07); color:#cfe3f0; cursor:pointer;';
        guardTxt = `<div style="margin-top:7px; font-size:0.8em; color:#9fb3c8; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            Circuit breaker: <span style="color:${g.paused ? '#ff6b6b' : '#14f195'}; font-weight:700;">${!g.ENABLED ? 'uit' : (g.paused ? 'GEPAUZEERD' : 'actief')}</span>${g.lastExpectancy != null ? ` \u00b7 expectancy ${(g.lastExpectancy * 100).toFixed(3)}%` : ''}
            <button style="${btn}" onclick="osirisSnapshotChampion()">leg champion vast</button>
            <button style="${btn}" onclick="osirisRestoreChampion()">herstel champion</button>
        </div>`;
    }
    el.innerHTML = `<div style="margin-bottom:6px;">${badge} <span style="color:#7d99ac; font-size:0.85em;">${live ? 'stuurt de dynamische time-stop' : 'alleen advies, raakt geen trades'}</span></div><div style="display:flex; gap:6px; flex-wrap:wrap;">${cards}</div>${abTxt}${guardTxt}`;
}
function deepNetLearningHtml() {
    const dn = OsirisDeepNet;
    let inner = '';
    for (const key of ['BTC', 'ETH', 'SOL']) {
        const m = dn.markets[key], p = dn.last[key], wf = m && m.wf, col = _DN_COL[key];
        const prec = wf ? (wf.precision * 100).toFixed(0) + '%' : '\u2014';
        inner += `<span style="color:${col}; font-weight:700;">${key}</span> wf-prec ${prec}${p ? ` \u00b7 nu ${(p.calProb * 100).toFixed(0)}% ${p.meta ? p.side : '(abst)'}` : ''}&nbsp;&nbsp;`;
    }
    const ab = dn.tsAB || { DYN: [], FIXED: [] };
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const dynM = mean(ab.DYN), fixM = mean(ab.FIXED);
    const abLine = (dynM != null && fixM != null)
        ? `Time-stop A/B: dyn ${(dynM * 100).toFixed(2)}% vs vast ${(fixM * 100).toFixed(2)}% \u2192 ${dn.dynTimeStopDisabled ? 'dyn autonoom uitgezet' : 'dyn actief'}`
        : `Time-stop A/B verzamelt data (${ab.DYN.length}/${ab.FIXED.length})`;
    return `<div style="margin:2px 0 14px; padding:10px 12px; background:rgba(0,217,255,0.04); border:1px solid rgba(0,217,255,0.25); border-radius:6px;">
        <div style="font-size:0.72em; color:#00d9ff; font-weight:700; margin-bottom:5px;">\u25c9 OSIRIS DEEPNET \u2014 voorspellend leren (${dn.LIVE ? 'live' : 'advies'})</div>
        <div style="font-size:0.74em; color:#9fb3c8; line-height:1.7;">${inner}</div>
        <div style="font-size:0.7em; color:#7d99ac; margin-top:5px;">${abLine}</div>
        <div style="font-size:0.62em; color:#5c7488; margin-top:4px;">Bar-level forward-return per markt \u00b7 Platt-gekalibreerd \u00b7 abstentie \u2265${(dn.ABSTAIN_MARGIN * 100) | 0}% \u00b7 meta-gate wf-prec \u2265${(dn.META_MIN_PRECISION * 100) | 0}%. Osiris meet autonoom of de dynamische time-stop beter is dan de oude vaste, en zet 'm anders zelf terug.</div>
    </div>`;
}
window.deepNetLearningHtml = deepNetLearningHtml;
window.updateDeepNetPanel = updateDeepNetPanel;

// DEEPNET-band bovenop het bestaande grote MULTI-BREIN-canvas: toont per markt de
// gekalibreerde kans + meta-poort en zet de mainbrain-keuze in 'neo-net-out-big'.
// Tekent NIET het hele canvas leeg (overlay), zodat het bestaande net eronder blijft.
function _deepnetOverlayBig() {
    // Geen in-canvas band meer (design image 2): de per-markt gekalibreerde kansen
    // gaan naar het HTML-paneel 'DeepNet-band \u00b7 live', en de Osiris-keuze naar de
    // .net-out rechtsboven. Zo overlapt niets meer met de knopen/laag-labels.
    if (typeof OsirisDeepNet === 'undefined') return;
    const keys = ['BTC', 'ETH', 'SOL'];
    let choice = null, best = -1, lean = null, lb = -1;
    for (const key of keys) {
        const p = OsirisDeepNet.last[key];
        if (p && p.meta && p.conf > best) { best = p.conf; choice = p; }
        if (p && p.conf > lb) { lb = p.conf; lean = p; }
    }
    // (22-08) NIET meer de .net-out (OSIRIS DECISION) overschrijven met de losse DeepNet-pick:
    // dat gaf twee verschillende getallen onder dezelfde titel (wallet-tab toonde de ensemble-
    // beslissing SHORT 82%, neural-net-tab de DeepNet-pick 'wacht \u00b7 SOL LONG 66%'). Beide tabs
    // tonen nu dezelfde ensemble-beslissing (uit _neoNetDraw); de per-markt DeepNet-pick staat
    // in de 'DeepNet band \u00b7 live' hieronder, waar hij thuishoort.
    const band = document.getElementById('net-deepnet-band');
    if (band) {
        const col = (typeof _DN_COL !== 'undefined') ? _DN_COL : { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195' };
        band.innerHTML = keys.map(key => {
            const p = OsirisDeepNet.last[key], c = col[key] || '#7fd8ff';
            if (!p) return `<span style="color:${c}">${key}</span> <span class="muted">wacht\u2026</span>`;
            const cal = (p.calProb != null) ? (p.calProb * 100).toFixed(0) + '%' : '--';
            let meta, reden = '';
            if (p.meta) {
                meta = '<span style="color:var(--green)">open</span>';
            } else {
                meta = '<span style="color:var(--red)">dicht</span>';
                // waarom dicht? (leest de gate-velden uit predict())
                if (!p.trade) reden = ' <span class="muted">(uncertain \u00b7 gate needs \u226440% or \u226560%)</span>';
                else if (p.agree === false) reden = ' <span class="muted">(core points the other way)</span>';
                else reden = ' <span class="muted">(walk-forward precision below threshold)</span>';
            }
            const dir = p.trade ? (p.side || '') : 'NEUTRAL';
            return `<span style="color:${c}">${key} ${cal} ${dir}</span> &middot; meta ${meta}${reden}`;
        }).join('<br>');
    }
}
window._deepnetOverlayBig = _deepnetOverlayBig;

// Start de achtergrond-service NU pas - na de const _dnviz/_DN_COL en de viz-functies,
// zodat startDeepNetViz() niet in hun temporal-dead-zone valt (dat brak de canvas-render).
try { OsirisDeepNet.startService(); } catch (e) {}
