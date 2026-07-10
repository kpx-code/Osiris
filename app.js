// - UOTAM CONFIGURATIE EN PARAMETERS --
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten

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
    minLossForEarlyExit: 0.003,  // ondergrens (0.3%) verlies voordat de bot vroegtijdig mag sluiten op bevestigde tegentrend, vóór de volle stop-loss
    maxOpenPositions: 3,         // totaal aantal posities dat tegelijk open mag staan (over beide kanten samen), hard begrensd op 4
    minHedgeReservePct: 0.15,    // gereserveerde allocatie voor een eventuele hedge op de andere kant, ALLEEN als die kant nog geen positie heeft
    pendingOrderTtlMinutes: 30,  // hoe lang een pending order geldig blijft als hij niet eerder triggert of wordt herbeoordeeld (zie revalidatePendingOrders)
    isRunning: false
};

// --- WALLET (persistente staat, los van botSettings.startingCapital-invoer) ---
let walletState = {
    startingCapital: 1000,
    realizedPnL: 0,   // cumulatieve gerealiseerde winst/verlies in EUR
    wins: 0,
    losses: 0
};

// Meerdere posities tegelijk = hedging (LONG + SHORT naast elkaar toegestaan)
let openPositions = [];   // { id, side, entryPrice, amount, notional, sizePct, targetPrice, openTime, peakPnlPct, trailingStopPct }
let pendingOrders = [];   // { id, side, triggerPrice, direction, targetPrice, projectedProfitPct, probabilityPct, createdAt, expiresAt }

// Cache van de laatste (elke 10s) Osiris-berekening, gebruikt door de per-seconde
// hold/close-beslissing zodat we niet elke seconde alles hoeven te herberekenen.
let lastOsirisDecision = null;
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
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
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

function formatChartPrice(usdPrice) {
    return `${currencySymbol()}${convertToDisplayCurrency(usdPrice).toFixed(0)}`;
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
        const cappedLog = botTradeLog.length > 500 ? botTradeLog.slice(-500) : botTradeLog;
        localStorage.setItem('osirisTradeLog', JSON.stringify(cappedLog));
    } catch (e) { console.warn("Kon wallet/positie-status niet opslaan:", e); }
}

function loadPersistentState() {
    try {
        const w = localStorage.getItem('osirisWalletState');
        const p = localStorage.getItem('osirisOpenPositions');
        const q = localStorage.getItem('osirisPendingOrders');
        const t = localStorage.getItem('osirisTradeLog');
        if (w) walletState = JSON.parse(w);
        if (p) openPositions = JSON.parse(p);
        if (q) pendingOrders = JSON.parse(q);
        if (t) botTradeLog = JSON.parse(t);
    } catch (e) { console.warn("Kon wallet/positie-status niet laden:", e); }
}

loadPersistentState();

// FIX: na het laden de "Laatste 10 Posities" tabel opnieuw opbouwen uit de
// hersteldeel trade log, zodat gesloten posities niet meer "verdwijnen" bij
// een refresh - ze staan nu gewoon weer in de tabel, precies zoals vóór het
// herladen.
function rebuildHistoryUIFromLog() {
    const body = document.getElementById('history-body');
    if (!body) return;
    body.innerHTML = '';
    const exits = botTradeLog.filter(e => e.action === 'EXIT').slice(-10);
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
    updateWalletUI();
    updatePendingOrdersUI();
    rebuildHistoryUIFromLog();
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



function startAutonomousBot(isAutoRestart = false) {
    isBotRunning = true;
    localStorage.setItem('botIsRunning', 'true');

    // FIX: dit was nooit true gezet, waardoor botHeartbeat() de trading
    // engine altijd oversloeg (bot deed nooit iets, ook al stond hij "ACTIEF").
    botSettings.isRunning = true;

    // Lees de door de gebruiker ingevulde waarden uit de UI.
    // Start Kapitaal wordt alleen toegepast als de wallet nog nooit gebruikt is
    // (anders zou elke herstart de opgebouwde equity overschrijven).
    const capitalInput = document.getElementById('start-capital');
    const allocInput = document.getElementById('max-allocation-pct');
    const stopLossInput = document.getElementById('stop-loss-pct');
    const minProbInput = document.getElementById('min-probability-pct');
    const holdProbInput = document.getElementById('hold-continuation-probability-pct');
    const minProfitInput = document.getElementById('min-projected-profit-pct');
    const maxPositionsInput = document.getElementById('max-open-positions');
    const hedgeReserveInput = document.getElementById('hedge-reserve-pct');
    const pendingTtlInput = document.getElementById('pending-order-ttl');
    const minLossEarlyExitInput = document.getElementById('min-loss-early-exit');

    if (!isAutoRestart && walletState.realizedPnL === 0 && openPositions.length === 0) {
        if (capitalInput && !isNaN(parseFloat(capitalInput.value)) && parseFloat(capitalInput.value) > 0) {
            walletState.startingCapital = parseFloat(capitalInput.value);
        }
    }
    if (allocInput && !isNaN(parseFloat(allocInput.value))) {
        botSettings.maxAllocationPct = Math.min(Math.max(parseFloat(allocInput.value) / 100, 0), 1);
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
        // Harde bovengrens van 4, ongeacht wat er wordt ingevuld
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

    savePersistentState();
    updateWalletUI();
}

function stopAutonomousBot() {
    // 1. Stop de bot-logica
    botSettings.isRunning = false;
    
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
    return openPositions.reduce((sum, p) => {
        const pnlPct = p.side === 'LONG'
            ? (livePrice - p.entryPrice) / p.entryPrice
            : (p.entryPrice - livePrice) / p.entryPrice;
        return sum + (p.notional * pnlPct);
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

    walletState = {
        startingCapital: (!isNaN(newCapital) && newCapital > 0) ? newCapital : 1000,
        realizedPnL: 0,
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
    console.log("Wallet gereset naar €" + walletState.startingCapital);
}

// ============================================================
// UI UPDATES
// ============================================================
function updateWalletUI() {
    const equity = getEquity();
    const balance = getBalance();
    const unrealized = getUnrealizedPnL();
    const allocatedPct = getAllocatedPct() * 100;
    const totalTrades = walletState.wins + walletState.losses;
    const winRate = totalTrades > 0 ? ((walletState.wins / totalTrades) * 100).toFixed(1) : null;

    setText('wallet-equity', `€${equity.toFixed(2)}`);
    setText('wallet-balance', `€${balance.toFixed(2)}`);
    setText('wallet-realized-pnl', `€${walletState.realizedPnL.toFixed(2)}`);
    const realizedEl = document.getElementById('wallet-realized-pnl');
    if (realizedEl) realizedEl.style.color = walletState.realizedPnL >= 0 ? '#00ffcc' : '#ef5350';

    setText('wallet-unrealized-pnl', `€${unrealized.toFixed(2)}`);
    const unrealizedEl = document.getElementById('wallet-unrealized-pnl');
    if (unrealizedEl) unrealizedEl.style.color = unrealized >= 0 ? '#00ffcc' : '#ef5350';

    setText('wallet-allocated-pct', `${allocatedPct.toFixed(1)}%`);
    setText('wallet-open-count', `${openPositions.length}`);
    setText('wallet-winrate', winRate !== null ? `${winRate}% (${walletState.wins}W / ${walletState.losses}L)` : '--');

    // Backwards-compatible aggregate P/L veld (bovenin de bot-monitor tegel) - nu met €-bedrag erbij
    const aggPct = equity !== 0 ? (unrealized / equity) * 100 : 0;
    setText('bot-pnl', `${aggPct >= 0 ? '+' : ''}${aggPct.toFixed(2)}% (${unrealized >= 0 ? '+' : ''}€${unrealized.toFixed(2)})`);
    const pnlEl = document.getElementById('bot-pnl');
    if (pnlEl) pnlEl.style.color = unrealized >= 0 ? '#00ffcc' : '#ef5350';

    // Open-posities tabel
    const posBody = document.getElementById('open-positions-body');
    if (posBody) {
        if (openPositions.length === 0) {
            posBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#888; padding:8px;">Geen open posities</td></tr>`;
            setText('bot-position', 'Geen');
        } else {
            posBody.innerHTML = openPositions.map(p => {
                const pnlPct = livePrice ? (p.side === 'LONG'
                    ? (livePrice - p.entryPrice) / p.entryPrice
                    : (p.entryPrice - livePrice) / p.entryPrice) : 0;
                const color = pnlPct >= 0 ? '#00ffcc' : '#ef5350';
                const entryTijd = p.openTime ? formatFullDateTime(p.openTime) : '-';
                return `<tr>
                    <td style="padding:4px; color:${p.side === 'LONG' ? '#26a69a' : '#ef5350'}; font-weight:bold;">${p.side}</td>
                    <td>${p.entryPrice.toFixed(2)}</td>
                    <td style="font-size:0.9em; color:#aaa;">${entryTijd}</td>
                    <td>${p.amount}</td>
                    <td>€${p.notional.toFixed(2)}</td>
                    <td>${(p.sizePct * 100).toFixed(1)}%</td>
                    <td style="color:${color};">${(pnlPct * 100).toFixed(2)}%</td>
                    <td style="color:${color};">€${(p.notional * pnlPct).toFixed(2)}</td>
                </tr>`;
            }).join('');
            setText('bot-position', openPositions.map(p => p.side).join(' + '));
        }
    }

    updatePositionLines();
}

function updatePendingOrdersUI() {
    const el = document.getElementById('pending-orders-list');
    if (!el) return;
    if (pendingOrders.length === 0) {
        el.innerHTML = `<span style="color:#888;">Geen pending orders</span>`;
        return;
    }
    el.innerHTML = pendingOrders.map(o =>
        `<div>${o.side === 'LONG' ? '🟢' : '🔴'} ${o.side} wacht op €${o.triggerPrice.toFixed(2)} (kans ${o.probabilityPct.toFixed(0)}%, verwacht +${o.projectedProfitPct.toFixed(2)}%)</div>`
    ).join('');
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
    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid #222';
    row.innerHTML = `
        <td style="padding:5px; color:#888;">${entry.timestamp}</td>
        <td style="color:${entry.side === 'LONG' ? '#26a69a' : '#ef5350'};">${entry.side || '-'}</td>
        <td>${typeof entry.price === 'number' ? entry.price.toFixed(2) : entry.price}</td>
        <td>${entry.amount}</td>
        <td>€${(entry.notionalEUR || 0).toFixed(2)}</td>
        <td style="color:${pnlColor}; font-weight:bold;">${(entry.pnl * 100).toFixed(2)}% (€${(entry.pnlAmount || 0).toFixed(2)})</td>
    `;
    body.insertBefore(row, body.firstChild);

    // Houd de tabel beperkt tot de laatste 10 rijen
    while (body.children.length > 10) {
        body.removeChild(body.lastChild);
    }
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

function logBotAction(action, price, side, pnl = 0, amount = 0, reason = '', pnlAmount = 0, notionalEUR = 0) {
    const timestamp = formatFullDateTime();
    const priceNum = typeof price === 'number' ? price : parseFloat(price);
    const notional = notionalEUR || (amount && priceNum ? amount * priceNum : 0);

    const entry = {
        timestamp,
        action,
        price,
        side,
        pnl,
        pnlAmount,
        amount,
        notionalEUR: notional,
        reason,
        equity: getEquity()
    };
    botTradeLog.push(entry);

    const actionEl = document.getElementById('bot-last-action');
    if (actionEl) {
        const priceTxt = typeof price === 'number' ? price.toFixed(2) : price;
        const sizeTxt = amount ? `(${amount} BTC \u2248 \u20ac${notional.toFixed(2)})` : '';
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
function calculateProbabilityScore(confluence, chaosVal, erVal, nodeInfluence = 0, momentumInfluence = 0) {
    let score = 50 + (confluence * 9); // confluence 0-5 -> 50-95
    if (chaosVal > 15) score -= 15;    // extreme volatiliteit = onbetrouwbaarder
    else if (chaosVal < 5) score += 5; // rustige markt = betrouwbaarder
    if (erVal > 1.5) score += 5;       // sterke volume-deelname = betrouwbaarder
    score += nodeInfluence;            // node-timing: VOLA/CORE verhogen, RESET verlaagt (zie calculateNodeInfluence)
    score += momentumInfluence;        // "geheugen": trend uit metricsHistory bevestigt of ontkracht het signaal
    return Math.max(0, Math.min(100, score));
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
function calculateEntryTrigger(side, currentPrice) {
    if (!rawData || rawData.length < 9) return currentPrice;

    const recent = rawData.slice(-9);
    const rangeHigh = Math.max(...recent.map(d => parseFloat(d[2])));
    const rangeLow = Math.min(...recent.map(d => parseFloat(d[3])));
    if (!isFinite(rangeHigh) || !isFinite(rangeLow) || rangeHigh === rangeLow) return currentPrice;

    const levels = calculateFibLevels(rangeHigh, rangeLow);

    // LONG: wacht op een pullback naar de 0.618-retracement ("koop de dip")
    // SHORT: wacht op een opleving naar de 0.382-retracement ("verkoop de rally")
    const level = side === 'LONG' ? levels['0.618'] : levels['0.382'];

    // Als dat niveau te ver van de huidige prijs afligt (>1.5%) is wachten
    // niet realistisch binnen een redelijke tijd -> gebruik de live prijs.
    const distancePct = Math.abs(currentPrice - level) / currentPrice;
    if (!isFinite(level) || distancePct > 0.015) return currentPrice;

    return level;
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
    const probabilityPct = calculateProbabilityScore(decision.confluence, chaos, er, nodeInfluence, momentumInfluence);

    const targetPrice = side === 'LONG'
        ? parseFloat(decision.targets.meso.bullish)
        : parseFloat(decision.targets.meso.bearish);

    const projectedProfitPct = side === 'LONG'
        ? ((targetPrice - triggerPrice) / triggerPrice) * 100
        : ((triggerPrice - targetPrice) / triggerPrice) * 100;

    const eligible = probabilityPct >= botSettings.minProbabilityPct &&
                      projectedProfitPct > botSettings.minProjectedProfitPct;

    return { eligible, triggerPrice, targetPrice, projectedProfitPct, probabilityPct, nodeContext, nodeInfluence, momentumContext, momentumInfluence };
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
    const probabilityPct = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluence);

    return {
        eligible: probabilityPct >= threshold,
        probabilityPct, nodeContext, nodeInfluence, momentumContext, momentumInfluence
    };
}

// Elke 10 seconden: scan of er een nieuwe kans is voor LONG en/of SHORT.
// Hedging is toegestaan (beide kanten tegelijk), maar niet dubbel op dezelfde kant.
// Herbeoordeelt bestaande pending orders elke 10s (dynamische geldigheid i.p.v.
// alleen een harde TTL) - als het signaal intussen is weggevallen, wordt de
// order meteen geannuleerd i.p.v. te blijven wachten tot de vervaltijd. Loopt
// op dezelfde 10s-cadans als de rest van de Osiris-scan, dus zonder extra load.
function revalidatePendingOrders(decision, metrics) {
    let changed = false;
    pendingOrders = pendingOrders.filter(order => {
        const evalResult = evaluateEntryOpportunity(order.side, decision, metrics, livePrice);
        if (!evalResult.eligible) {
            logBotAction("CANCELLED", order.triggerPrice, order.side, 0, 0, "niet langer geldig (herbeoordeeld)");
            changed = true;
            return false;
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
function scanForOpportunities(decision, metrics) {
    revalidatePendingOrders(decision, metrics);

    ['LONG', 'SHORT'].forEach(side => {
        if (openPositions.length >= botSettings.maxOpenPositions) return;

        const hasPending = pendingOrders.some(p => p.side === side);
        if (hasPending) return;

        const evalResult = evaluateEntryOpportunity(side, decision, metrics, livePrice);
        if (!evalResult.eligible) return;

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
// ENTRY / EXIT UITVOERING
// ============================================================
function openPositionFromOrder(order) {
    const price = livePrice;
    const confluence = lastOsirisDecision ? lastOsirisDecision.confluence : 0;
    const maxConfluence = 5; // zie getOrisisDecisionData: vfm(2)+db(1)+chaos(1)+er(1)

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
    const notional = balance * finalSizePct; // dit is het bedrag in EUR (de wallet-valuta)

    // FIX: `price` (livePrice) komt van BTCUSDT en is dus een USD-bedrag, terwijl
    // `notional` in EUR is - notional direct door price delen behandelde 1 EUR
    // stilzwijgend als 1 USD (~8-17% fout, afhankelijk van de actuele koers).
    // Reken notional eerst correct om naar USD via de live EUR/USDT-koers voor
    // een kloppende BTC-hoeveelheid. Zonder koers (nog niet opgehaald) valt dit
    // terug op de oude aanname als noodgreep, met een duidelijke log-vermelding.
    const notionalUSD = eurUsdtRate ? (notional * eurUsdtRate) : notional;
    const amount = parseFloat((notionalUSD / price).toFixed(6));
    if (!eurUsdtRate) {
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
        trailingStopPct: null
    };

    openPositions.push(position);
    logBotAction("ENTRY", price, order.side, 0, amount, `alloc ${(finalSizePct * 100).toFixed(1)}% | node-inv ${(order.nodeInfluence || 0).toFixed(1)}`, 0, notional);
    savePersistentState();
    updateWalletUI();
    updatePositionLines();
}

function closePosition(pos, pnlPct, reason) {
    const pnlAmount = pos.notional * pnlPct;
    walletState.realizedPnL += pnlAmount;
    if (pnlPct >= 0) walletState.wins++; else walletState.losses++;
    pos.closeTime = Date.now();

    openPositions = openPositions.filter(p => p.id !== pos.id);

    logBotAction("EXIT", livePrice, pos.side, pnlPct, pos.amount, reason, pnlAmount, pos.notional);
    savePersistentState();
    updateWalletUI();
    updatePositionLines();
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

        // 1. Harde stop-loss: -2%, niet onderhandelbaar
        if (pnlPct <= -botSettings.stopLossPct) {
            closePosition(pos, pnlPct, "STOP_LOSS");
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

            const continuation = evaluateContinuation(pos.side, botSettings.holdContinuationMinProbabilityPct);
            if (!continuation.eligible) {
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
            const continuation = evaluateContinuation(pos.side);
            if (!continuation.eligible) {
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
            const continuation = evaluateContinuation(pos.side);
            if (!continuation.eligible) {
                closePosition(pos, pnlPct, "EARLY_STOP_TREND");
                return;
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
function downloadAllData() {
    const nodeCtx = getNodeContext();
    const payload = {
        exportedAt: new Date().toISOString(),
        meta: {
            symbol: 'BTCUSDT',
            interval: currentInterval,
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
            volumeShiftPct: calculateVolumeShift(6)
        },
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
        if (runtimeEl) runtimeEl.innerText = `Runtime: ${h}:${m}:${s}`;
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

// --- DYNAMISCH TIMEFRAME WISSELEN ---
function changeTimeframe(interval) {
    currentInterval = interval;
    
    // Wis de markers
    setChartMarkers([]);
    
    // Update alleen de 15m knop (of verwijder de loop als je geen actieve status nodig hebt)
    const btn = document.getElementById('btn-15m');
    if (btn) {
        btn.style.background = '#00ffcc';
        btn.style.color = '#131722';
        btn.style.fontWeight = 'bold';
    }

    // Herlaad de data
    initDashboard();
}

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        setChartMarkers([]);
        
        // 2. Fetch 672 candles (exact 7 dagen bij 15m interval)
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=672`);
        rawData = await response.json(); // Data opslaan in de globale variabele
        
        // 3. Update de historie lijst
        updateHistoryList(rawData);
        
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(chartData);
        applyUOTAMGrid(chartData);
        startLiveUpdates();
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
        midPulseEl.innerText = formatCountdown(nextMidTime);
    }

    // Next Node: De absolute eerstvolgende node (Reset/Vola/Vortex/etc)
    const nextNodeEl = document.getElementById('next-node-display');
    if (nextNodeEl) {
        const nextIdx = currentAbsoluteNode + 1;
        const nextTime = ANCHOR_TIME + (nextIdx * T_PI_MS);
        
        let relIdx = ((nextIdx % 8) + 8) % 8;
        let type = ['RESET', 'VOLA', 'OSC', 'VORTEX 3', 'OSC', 'OSC', 'VORTEX 6', 'OSC'][relIdx];
        
        nextNodeEl.innerText = `${formatCountdown(nextTime)} | ${type}`;
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
}

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

function recordMetricsSnapshot() {
    metricsHistory.push({
        timestamp: Date.now(),
        price: livePrice,
        vfm, er, db, chaos,
        liveVol,
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
    const avgRecent = recent.reduce((a, m) => a + m.liveVol, 0) / recent.length;
    const avgPrior = prior.reduce((a, m) => a + m.liveVol, 0) / prior.length;
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

function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    
    // 1. Wis oude data
    allNodes = [];
    
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
        
        // Zoek de candle die het dichtst bij de berekende node tijd ligt (binnen een marge van 15 minuten)
        const marge = 15 * 60; // 15 minuten in seconden
        const closestCandle = chartData.find(c => Math.abs(c.time - nodeTimeSec) <= marge);
        
        if (closestCandle) {
            // 1. Bepaal het nodeType voor de PriceLines
            let nodeType = 'osc';
            if (relativeIndex === 0) nodeType = 'reset';
            else if (relativeIndex === 1) nodeType = 'vola';
            else if (relativeIndex === 3) nodeType = 'vortex3';
            else if (relativeIndex === 6) nodeType = 'vortex6';

            // 2. Push naar allNodes inclusief het type veld
            allNodes.push({
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

        if (midCandle) {
            allNodes.push({
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
                text: `MID PULSE Node ${i}`,
                nodeTypeKey: 'MIDPULSE',
            });
        }
    }
    
    // Sla de tekst-markers op
    gridMarkers = markers; 
    
    // Update de grafiek markers (gefilterd op welke node-types actief zijn getoggeld)
    renderNodeMarkers();
    
    // Update de Fib-lijnen
   // HIER PAS JE HET AAN:
    // Je voegt 'chartData' toe als het tweede argument.
    // De functie gebruikt nu allNodes voor de timing en chartData voor de prijs-range.
    updateActiveNodeFibLines(allNodes, chartData);

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
    const visibleMarkers = gridMarkers.filter(m => activeNodeTypes[m.nodeTypeKey] !== false);
    setChartMarkers(visibleMarkers);
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

    const baseUrl = "wss://fstream.binance.com/market"; 
    currentWs = new WebSocket(`${baseUrl}/ws/btcusdt@kline_15m`);
    
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

            // 2. Chart Update
            candlestickSeries.update({
                time: candle.t / 1000,
                open: openPrice,
                high: high,
                low: low,
                close: livePrice,
            });

            // 3. Live Volume UI
            const volEl = document.getElementById('live-volume');
            if (volEl) volEl.innerText = liveVol ? liveVol.toFixed(4) : "Wachten...";

            // 4. Data-afhankelijke berekeningen (VFM, ER, DB, Chaos)
            if (rawData && rawData.length >= 288) {
                const sma20Volume = rawData.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
                er = liveVol / sma20Volume;
                db = (high - low !== 0) ? (2 * livePrice - (high + low)) / (high - low) : 0;
                vfm = er * db;
                const price3DaysAgo = parseFloat(rawData[rawData.length - 288][4]);
                chaos = Math.abs((livePrice - price3DaysAgo) / price3DaysAgo) * 100;
            
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
                if (chaosEl) chaosEl.innerText = chaos.toFixed(1) + '%';
                if (chaosStatusEl) { chaosStatusEl.innerText = chaos > 15 ? "EXTREME" : "STABIEL"; chaosStatusEl.style.color = chaos > 15 ? "#ef5350" : "#00ffcc"; }
            
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

function updateActiveNodeFibLines(targetNodes, chartData = null) {
    // 1. Data voorbereiding
    let processedData = (chartData && Array.isArray(chartData)) ? chartData : rawData.map(d => ({
        time: Math.floor(d[0] / 1000), 
        high: parseFloat(d[2]), 
        low: parseFloat(d[3])
    }));

    if (!Array.isArray(processedData) || processedData.length === 0) return;

    // 2. Wis oude lijnen
    activeFibLines.forEach(line => candlestickSeries.removePriceLine(line));
    activeFibLines = [];

    // 3. Definieer de schaal-configuratie (stijlen gescheiden van kleuren)
    const fibPalettes = {
        MIC: { width: 1, style: LightweightCharts.LineStyle.Dotted },
        MES: { width: 2, style: LightweightCharts.LineStyle.Dashed },
        MAC: { width: 3, style: LightweightCharts.LineStyle.Solid }
    };

    const allScales = [
    // Micro: 9-candle cyclus. 
    // We filteren niet op type, maar we kijken naar de laatste 9.
    { id: 'MIC', harmonic: 9, width: 1 }, 
    
    // Meso: 12.25-dag cyclus. 
    // Hier kijken we naar 12 nodes terug voor de swing-structuur.
    { id: 'MES', harmonic: 12, width: 1 }, 
    
    // Macro: 49-dag cyclus (Quarterly Scaffolding).
    // Hier kijken we naar 49 nodes terug voor de structurele marktlaag.
    { id: 'MAC', harmonic: 49, width: 1 }
];
   // const allScales = [
   //     { id: 'MIC', harmonic: 9 },  // 9-candle Micro
   //     { id: 'MES', harmonic: 12 }, // 12.25-dag Meso
   //     { id: 'MAC', harmonic: 49 }  // 49-dag Macro
   // ];

    // 4. Teken alleen wat actief is (Fractaal TAM model)
    allScales.forEach(scale => {
        // Check of de gebruiker deze schaal aan heeft staan via de UI
        if (!activeFibScales[scale.id]) return;

        // GEEN harde filter op 'type' meer: 
        // We gebruiken ALLE beschikbare nodes als ankerpunten.
        // Dit respecteert de fractale natuur van het TAM-model.
        const relevantNodes = targetNodes; 
        
        if (relevantNodes.length < 2) return;

        // Pak de laatste X nodes op basis van de harmonische waarde (9, 12, of 49)
        const nodesInRange = relevantNodes.slice(-scale.harmonic);
        
        // Bepaal het tijdsbereik op basis van deze nodes
        const startTime = nodesInRange[0].time;
        const endTime = nodesInRange[nodesInRange.length - 1].time;
        
        const candlesInPeriod = processedData.filter(c => c.time >= startTime && c.time <= endTime);
        if (candlesInPeriod.length === 0) return;

        const rangeHigh = Math.max(...candlesInPeriod.map(c => c.high));
        const rangeLow = Math.min(...candlesInPeriod.map(c => c.low));
        
        // Bereken Fibonacci niveaus (isBullish gebaseerd op de laatste node in de reeks)
        const levels = calculateFibLevels(rangeHigh, rangeLow, nodesInRange[nodesInRange.length - 1].isBullish);
        
        const palette = fibPalettes[scale.id];

        Object.entries(levels).forEach(([ratio, price]) => {
            const levelStyle = fibStyles[ratio] || { color: '#cccccc', label: ratio };
            
            if (!isNaN(price)) {
                const line = candlestickSeries.createPriceLine({
                    price: price,
                    color: levelStyle.color, // Kleur per Fib-niveau
                    lineWidth: palette.width, // Dikte per schaal
                    lineStyle: palette.style, // Stijl (dotted/dashed/solid) per schaal
                    axisLabelVisible: true,
                    title: `${scale.id} ${levelStyle.label}` 
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
    if (Math.abs(vfm) > 1.2) confluence += 2;
    if (Math.abs(db) > 0.3) confluence += 1;
    if (chaos < 10) confluence += 1;
    if (er > 1.2) confluence += 1;

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
    chart.resize(chartContainer.clientWidth, 600);
});

applyChartPriceFormat();
fetchEurUsdtRate();
setInterval(fetchEurUsdtRate, 5 * 60 * 1000); // elke 5 minuten verversen

initDashboard();
setInterval(updateInfoPanel, 1000);
