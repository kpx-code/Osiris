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
    isRunning: false
};

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
    if (!rawData || rawData.length < Math.max(maFastPeriod, maSlowPeriod)) return;

    const closes = rawData.map(d => parseFloat(d[4]));
    const times = rawData.map(d => Math.floor(d[0] / 1000));

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
    CONSERVATIVE: {
        'max-allocation-pct': 40, 'stop-loss-pct': 1.5, 'min-probability-pct': 80,
        'hold-continuation-probability-pct': 90, 'min-projected-profit-pct': 1.5,
        'max-open-positions': 2, 'hedge-reserve-pct': 25, 'pending-order-ttl': 20,
        'min-loss-early-exit': 0.2, 'continuation-confirmation-sec': 30,
        'range-scalp-target-pct': 0.2, 'range-scalp-stop-pct': 0.3, 'range-scalp-alloc-pct': 5,
        'chase-probability-pct': 95, 'chase-after-minutes': 15,
        'ma-fast-period': 20, 'ma-slow-period': 50,
        'rsi-period': 14, 'rsi-overbought': 75, 'rsi-oversold': 25
    },
    BALANCED: {
        'max-allocation-pct': 70, 'stop-loss-pct': 2, 'min-probability-pct': 70,
        'hold-continuation-probability-pct': 85, 'min-projected-profit-pct': 1,
        'max-open-positions': 3, 'hedge-reserve-pct': 15, 'pending-order-ttl': 30,
        'min-loss-early-exit': 0.3, 'continuation-confirmation-sec': 20,
        'range-scalp-target-pct': 0.3, 'range-scalp-stop-pct': 0.5, 'range-scalp-alloc-pct': 10,
        'chase-probability-pct': 90, 'chase-after-minutes': 10,
        'ma-fast-period': 9, 'ma-slow-period': 21,
        'rsi-period': 14, 'rsi-overbought': 70, 'rsi-oversold': 30
    },
    AGGRESSIVE: {
        'max-allocation-pct': 70, 'stop-loss-pct': 2.5, 'min-probability-pct': 60,
        'hold-continuation-probability-pct': 80, 'min-projected-profit-pct': 0.5,
        'max-open-positions': 4, 'hedge-reserve-pct': 10, 'pending-order-ttl': 45,
        'min-loss-early-exit': 0.5, 'continuation-confirmation-sec': 10,
        'range-scalp-target-pct': 0.5, 'range-scalp-stop-pct': 0.8, 'range-scalp-alloc-pct': 15,
        'chase-probability-pct': 82, 'chase-after-minutes': 5,
        'ma-fast-period': 5, 'ma-slow-period': 13,
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
    if (!rawData || rawData.length < rsiPeriod + 1) return;

    const closes = rawData.map(d => parseFloat(d[4]));
    const times = rawData.map(d => Math.floor(d[0] / 1000));
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

    const bullish = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluenceLong, fibConfluenceInfluence, 'LONG', isBullish);
    const bearish = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluenceShort, fibConfluenceInfluence, 'SHORT', isBullish);

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
function formatMoney(amount, decimals = 2) {
    const sym = walletState.currency === 'USD' ? '$' : '€';
    return `${sym}${amount.toFixed(decimals)}`;
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
        if (w) walletState = JSON.parse(w);
        if (p) openPositions = JSON.parse(p);
        if (q) pendingOrders = JSON.parse(q);
        if (t) botTradeLog = JSON.parse(t);
        if (bs) {
            const restored = JSON.parse(bs);
            restored.isRunning = false; // altijd vers starten - startAutonomousBot(true) zet dit zelf weer terug op true indien nodig
            botSettings = restored;
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
    setVal('continuation-confirmation-sec', s.continuationConfirmationSeconds);
    setVal('range-scalp-target-pct', s.rangeScalpProfitTargetPct);
    setVal('range-scalp-stop-pct', s.rangeScalpStopLossPct);
    setVal('range-scalp-alloc-pct', (s.rangeScalpAllocationPct * 100).toFixed(0));
    setVal('chase-probability-pct', s.chaseProbabilityThreshold);
    setVal('chase-after-minutes', s.chaseAfterMinutes);
    setVal('reallocation-enabled', s.reallocationEnabled ? 'true' : 'false');
    setVal('reallocation-margin-pct', s.reallocationMarginPct);

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
}

// ============================================================
// SESSIE-LOG: houdt bij WANNEER welke instellingen actief werden - zowel bij
// Start als bij een live update terwijl de bot draait. Dit maakt de trade log
// achteraf te segmenteren per configuratie, ook als je nooit expliciet Reset
// Wallet gebruikt tussen twee verschillende instellingen-sets in.
// ============================================================
let sessionLog = [];

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
        walletState.currency = (currencyInput && currencyInput.value === 'USD') ? 'USD' : 'EUR';
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
        ['Bevestigingstijd exit', `${s.continuationConfirmationSeconds}s`],
        ['Range-scalp doel / stop / alloc', `${s.rangeScalpProfitTargetPct}% / ${s.rangeScalpStopLossPct}% / ${(s.rangeScalpAllocationPct * 100).toFixed(0)}%`],
        ['Chase (aan >kans / na min)', `${s.chaseEnabled ? 'aan' : 'uit'} / ${s.chaseProbabilityThreshold}% / ${s.chaseAfterMinutes}min`],
        ['Reallocatie (aan / marge)', `${s.reallocationEnabled ? 'aan' : 'uit'} / ${s.reallocationMarginPct}%`],
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
    const currencyInput = document.getElementById('wallet-currency-select');
    const newCurrency = (currencyInput && currencyInput.value === 'USD') ? 'USD' : 'EUR';

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
    console.log(`Wallet gereset naar ${walletState.currency === 'USD' ? '$' : '€'}${walletState.startingCapital}`);
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
        chanceTxt = ` | winkans nu ${formatConfidencePct(liveCheck.probabilityPct)} (bij entry ${formatConfidencePct(pos.probabilityPct)}) / verlieskans nu ${formatConfidencePct(100 - liveCheck.probabilityPct)}`;
    }

    return `[${pos.isScalp ? 'SCALP' : 'TREND'}] ${pos.side} @ ${formatChartPrice(pos.entryPrice)} | P/L ${(pnlPct * 100).toFixed(2)}% | ${zone}${detail ? ': ' + detail : ''}${confirmTxt}${chanceTxt}`;
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
        `${Math.abs(vfm) > 1.2 ? '\u2713' : '\u2717'} |VFM|>1.2 (+2)`,
        `${Math.abs(db) > 0.3 ? '\u2713' : '\u2717'} |DB|>0.3 (+1)`,
        `${chaos < 10 ? '\u2713' : '\u2717'} Chaos<10 (+1)`,
        `${er > 1.2 ? '\u2713' : '\u2717'} ER>1.2 (+1)`
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

    const maVals = getCurrentMAValues();
    const rsiVal = getCurrentRSIValue();
    let indicatorTxt = 'INDICATOREN · ';
    indicatorTxt += maVals.fast !== null ? `MA${maFastPeriod} ${maVals.fast.toFixed(0)} / MA${maSlowPeriod} ${maVals.slow.toFixed(0)} (${maVals.fast > maVals.slow ? 'bullish' : 'bearish'} stand)` : 'MA nog niet beschikbaar';
    indicatorTxt += rsiVal !== null ? ` \u00b7 RSI${rsiPeriod} ${rsiVal.toFixed(0)}` : '';
    lines.push(indicatorTxt);

    const confDirs = getDirectionalConfidences();
    lines.push(`EINDSCORE \u00b7 LONG ${formatConfidencePct(confDirs.bullish)} vs. drempel ${botSettings.minProbabilityPct}% (${confDirs.bullish >= botSettings.minProbabilityPct ? 'gehaald' : 'niet gehaald'}) \u00b7 SHORT ${formatConfidencePct(confDirs.bearish)} vs. drempel ${botSettings.minProbabilityPct}% (${confDirs.bearish >= botSettings.minProbabilityPct ? 'gehaald' : 'niet gehaald'})`);

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
    setText('wallet-realized-pnl', formatMoney(walletState.realizedPnL));
    const realizedEl = document.getElementById('wallet-realized-pnl');
    if (realizedEl) realizedEl.style.color = walletState.realizedPnL >= 0 ? '#00ffcc' : '#ef5350';

    setText('wallet-unrealized-pnl', formatMoney(unrealized));
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
            posBody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#888; padding:8px;">Geen open posities</td></tr>`;
            setText('bot-position', 'Geen');
        } else {
            posBody.innerHTML = openPositions.map(p => {
                const pnlPct = livePrice ? (p.side === 'LONG'
                    ? (livePrice - p.entryPrice) / p.entryPrice
                    : (p.entryPrice - livePrice) / p.entryPrice) : 0;
                const color = pnlPct >= 0 ? '#00ffcc' : '#ef5350';
                const entryTijd = p.openTime ? formatFullDateTime(p.openTime) : '-';
                const typeLabel = p.isScalp ? 'SCALP' : 'TREND';
                const typeColor = p.isScalp ? '#c678dd' : '#4287f5';
                return `<tr>
                    <td style="padding:4px; color:${typeColor}; font-weight:bold; font-size:0.8em;">${typeLabel}</td>
                    <td style="color:${p.side === 'LONG' ? '#26a69a' : '#ef5350'}; font-weight:bold;">${p.side}</td>
                    <td>${formatChartPrice(p.entryPrice)}</td>
                    <td style="font-size:0.9em; color:#aaa;">${entryTijd}</td>
                    <td>${p.amount}</td>
                    <td>${formatMoney(p.notional)}</td>
                    <td>${(p.sizePct * 100).toFixed(1)}%</td>
                    <td style="color:${color};">${(pnlPct * 100).toFixed(2)}%</td>
                    <td style="color:${color};">${formatMoney(p.notional * pnlPct)}</td>
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
    const walletNotionalFallback = walletState.currency === 'USD'
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
    if (pct >= 100) return '\u2265 99%';
    if (pct <= 0) return '\u2264 1%';
    return `~${pct.toFixed(0)}%`;
}

function calculateProbabilityScore(confluence, chaosVal, erVal, nodeInfluence = 0, momentumInfluence = 0, fibConfluenceInfluence = 0, side = null, isBullishNow = null) {
    let confluenceContribution = confluence * 9; // default (oud gedrag) als side/isBullishNow niet zijn meegegeven
    if (side !== null && isBullishNow !== null) {
        const directionAligned = (side === 'LONG' && isBullishNow) || (side === 'SHORT' && !isBullishNow);
        confluenceContribution = directionAligned ? confluence * 9 : -(confluence * 5);
    }

    let score = 50 + confluenceContribution; // confluence 0-9 -> tot 50-131 (aligned) of omlaag (tegengesteld), geclamped naar [0,100]
    if (chaosVal > 15) score -= 15;    // extreme volatiliteit = onbetrouwbaarder
    else if (chaosVal < 5) score += 5; // rustige markt = betrouwbaarder
    if (erVal > 1.5) score += 5;       // sterke volume-deelname = betrouwbaarder
    score += nodeInfluence;            // node-timing: VOLA/CORE verhogen, RESET verlaagt (zie calculateNodeInfluence)
    score += momentumInfluence;        // "geheugen": trend uit metricsHistory bevestigt of ontkracht het signaal
    score += fibConfluenceInfluence;   // MES/MAC fib-niveaus (dezelfde lijnen als op de chart) die de MIC-trigger bevestigen
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
    const probabilityPct = calculateProbabilityScore(decision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, side, isBullish);

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
    const fibConfluenceInfluence = calculateFibConfluenceInfluence(livePrice);
    const probabilityPct = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, side, isBullish);

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
    const probabilityPct = calculateProbabilityScore(lastOsirisDecision.confluence, chaos, er, nodeInfluence, momentumInfluence, fibConfluenceInfluence, order.side, isBullish);

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

    const candidates = openPositions.filter(pos => {
        const pnlPct = pos.side === 'LONG'
            ? (livePrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - livePrice) / pos.entryPrice;
        return pnlPct < botSettings.profitHoldTriggerPct;
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
    const notionalUSD = walletState.currency === 'USD' ? notional : (eurUsdtRate ? notional * eurUsdtRate : notional);
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

    openPositions.push(position);
    logBotAction("ENTRY", price, side, 0, amount, `RANGE-SCALP alloc ${(finalSizePct * 100).toFixed(1)}%`, 0, notional, true);
    savePersistentState();
    updateWalletUI();
    updatePositionLines();
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
    if (walletState.currency === 'USD') {
        notionalUSD = notional;
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
        trailingStopPct: null
    };

    openPositions.push(position);
    const tagTxt = entryTag ? `${entryTag} | ` : '';
    logBotAction("ENTRY", price, order.side, 0, amount, `${tagTxt}alloc ${(finalSizePct * 100).toFixed(1)}% | node-inv ${(order.nodeInfluence || 0).toFixed(1)}`, 0, notional);
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

    logBotAction("EXIT", livePrice, pos.side, pnlPct, pos.amount, reason, pnlAmount, pos.notional, pos.isScalp || false);
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

        // 1. Harde stop-loss: -2% (of, voor een range-scalp, de eigen krappere
        // stop) - niet onderhandelbaar.
        const activeStopLossPct = pos.customStopLossPct ?? botSettings.stopLossPct;
        if (pnlPct <= -activeStopLossPct) {
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
        renderMovingAverage();
        renderRSI();
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
        const midDate = new Date(midTimeMs);
        const midDateStr = `${String(midDate.getUTCDate()).padStart(2, '0')}-${String(midDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const midTimeStr = `${String(midDate.getUTCHours()).padStart(2, '0')}:${String(midDate.getUTCMinutes()).padStart(2, '0')} UTC`;
        const midTimeLabel = `${midDateStr} ${midTimeStr}`;

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
                text: `MID PULSE Node ${i} | ${midTimeLabel}`,
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
    if (Math.abs(vfm) > 1.2) confluence += 2;
    if (Math.abs(db) > 0.3) confluence += 1;
    if (chaos < 10) confluence += 1;
    if (er > 1.2) confluence += 1;
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
