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
let osirisSystemLog = [];

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

// --- FIBONACCI MARKERS FUNCTIE ---

// --- MOUSE HOVER (OHLC DATA) SUBSCRIBER ---
chart.subscribeCrosshairMove(param => {
    const ohlcOpen = document.getElementById('ohlc-open');
    const ohlcHigh = document.getElementById('ohlc-high');
    const ohlcLow = document.getElementById('ohlc-low');
    const ohlcClose = document.getElementById('ohlc-close');

    if (param.time && param.seriesData.has(candlestickSeries)) {
        const data = param.seriesData.get(candlestickSeries);
        ohlcOpen.innerText = data.open.toFixed(2);
        ohlcHigh.innerText = data.high.toFixed(2);
        ohlcLow.innerText = data.low.toFixed(2);
        ohlcClose.innerText = data.close.toFixed(2);
        
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

function logSystemState(metrics, targets, currentPrice, chaos, db, isBullish) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        price: currentPrice,
        // Kern-indicatoren
        vfm: metrics.vfm || 0,
        er: metrics.er || 0,
        db: db || 0,
        chaos: chaos || 0,
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
        isBullish: isBullish
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

let botSettings = {
    capital: 0,
    riskPerTrade: 0.01, // 1% risico
    isRunning: false
};


let botState = {
    active: false,
    entryPrice: 0,
    side: null
};

let botTradeLog = []; // Voor je trades (Entry/Exit/PnL)
let osirisSystemLog = []; // Voor je 1-minuut marktdata

function startAutonomousBot() {
    botSettings.capital = parseFloat(document.getElementById('start-capital').value);
    botSettings.riskPerTrade = parseFloat(document.getElementById('risk-per-trade').value) / 100;
    botSettings.isRunning = true;
    
    document.getElementById('btn-start-bot').style.display = 'none';
    document.getElementById('btn-stop-bot').style.display = 'inline-block';
    
    console.log("Bot gestart met kapitaal:", botSettings.capital);
}

function stopAutonomousBot() {
    botSettings.isRunning = false;
    document.getElementById('btn-start-bot').style.display = 'inline-block';
    document.getElementById('btn-stop-bot').style.display = 'none';
}

// De kern: De "Heartbeat" van de bot
setInterval(() => {
    if (!botSettings.isRunning) return;
    
    // Check of we in een positie zitten of nieuwe signalen zoeken
    const metrics = calculateVolumeMetrics(liveVol, isBullish);
    const decision = getOrisisDecisionData(metrics, livePrice, vfm, er, db, chaos, isBullish);
    
    if (botState.active) {
        checkExits(decision, livePrice);
    } else {
        checkEntries(decision, livePrice);
    }
}, 5000); // Bot checkt elke 5 seconden voor maximale responsiviteit

function checkEntries(decision, price) {
    if (decision.confluence >= 4) {
        // Bereken positiegrootte obv risico
        const amountToRisk = botSettings.capital * botSettings.riskPerTrade;
        const positionSize = amountToRisk / 0.01; // Bij 1% SL afstand

        // Logic voor entry
        botState = { 
            active: true, 
            entryPrice: price, 
            side: decision.decision.includes("BULLISH") ? "LONG" : "SHORT",
            size: positionSize 
        };
    }
}

function checkExits(decision, price) {
    const pnl = botState.side === 'LONG' ? ((price - botState.entryPrice) / botState.entryPrice) : ((botState.entryPrice - price) / botState.entryPrice);

    // Harde Stoploss op -1%
    if (pnl <= -0.01) executeExit("STOP_LOSS", pnl);
    
    // Dynamische Exit: sluit bij meso target
    else if (pnl > 0 && isTargetReached(decision.targets.meso, botState.side, price)) {
        executeExit("MESO_TARGET_REACHED", pnl);
    }
}

let botTradeLog = []; // Specifiek voor entries/exits/PnL

function logBotAction(action, price, side, pnl = 0) {
    const entry = {
        timestamp: new Date().toISOString(),
        action: action, // "ENTRY" of "EXIT"
        price: price,
        side: side,
        pnl: pnl,
        capital: botSettings.capital // Om P/L in euro's te zien
    };
    botTradeLog.push(entry);
    
    // Update de UI
    if (action === "EXIT") {
        document.getElementById('bot-status').innerText = `Status: Standby (Laatste PnL: ${(pnl*100).toFixed(2)}%)`;
    }
}

function openPosition(side, price) {
    botState = { active: true, entryPrice: price, side: side };
    logBotAction("ENTRY", price, side); // <--- HIER LOGGEN
}

function executeExit(reason, pnl) {
    logBotAction("EXIT", livePrice, botState.side, pnl); // <--- HIER LOGGEN
    botState = { active: false, ... };
}
function updateBotUI() {
    const posEl = document.getElementById('bot-position');
    const pnlEl = document.getElementById('bot-pnl');
    
    if (botState.active) {
        posEl.innerText = `Positie: ${botState.side} @ ${botState.entryPrice}`;
        // Bereken live P/L
        const livePnl = botState.side === 'LONG' ? ((livePrice - botState.entryPrice)/botState.entryPrice) : ((botState.entryPrice - livePrice)/botState.entryPrice);
        pnlEl.innerText = `Live P/L: ${(livePnl * 100).toFixed(2)}%`;
    } else {
        posEl.innerText = "Geen actieve positie";
    }
}

function startAutonomousBot() {
    const capInput = document.getElementById('start-capital');
    botSettings.capital = parseFloat(capInput.value) || 1000;
    botSettings.isRunning = true;
    
    console.log("🚀 Osiris Bot operationeel.");
    document.getElementById('bot-status').innerText = "Status: Actief";
}

function stopAutonomousBot() {
    botSettings.isRunning = false;
    console.log("🛑 Osiris Bot gestopt.");
    document.getElementById('bot-status').innerText = "Status: Gestopt";
}

// De Heartbeat (elke 10 seconden voor hoge precisie)
setInterval(() => {
    if (!botSettings.isRunning) return;

    // 1. Data verzamelen voor kalibratie
    const metrics = calculateVolumeMetrics(liveVol, isBullish);
    const decision = getOrisisDecisionData(metrics, livePrice, vfm, er, db, chaos, isBullish);
    
    // 2. Altijd loggen voor je kalibratie (elke 10 sec)
    logSystemState(metrics, decision.targets, livePrice, liveVol, chaos, db, isBullish);
    
    // 3. Bot actie
    if (botState.active) {
        checkExits(decision, livePrice);
    } else {
        checkEntries(decision, livePrice);
    }
}, 10000);

function exportBotTradeLog() {
    if (botTradeLog.length === 0) {
        alert("Geen trade data beschikbaar om te exporteren.");
        return;
    }

    // Headers voor je CSV
    const headers = ["Timestamp", "Action", "Price", "Side", "PnL_Percent", "Capital"];
    
    // Rijen formatteren
    const rows = botTradeLog.map(t => [
        t.timestamp,
        t.action,
        t.price,
        t.side,
        (t.pnl * 100).toFixed(2), // PnL als percentage voor leesbaarheid in Excel
        t.capital
    ].join(","));

    // Samenvoegen tot CSV
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
    
    // Download trigger
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "osiris_bot_trade_log.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function logBotAction(action, price, side, pnl = 0) {
    const entry = {
        timestamp: new Date().toISOString(),
        action: action, 
        price: price,
        side: side,
        pnl: pnl,
        capital: botSettings.capital
    };
    botTradeLog.push(entry);
    
    // Update UI
    document.getElementById('bot-last-action').innerText = `${action} @ ${price}`;
    if (action === "EXIT") {
        document.getElementById('bot-status').innerText = `Status: Standby (Laatste PnL: ${(pnl*100).toFixed(2)}%)`;
    }
}

function isTargetReached(targetMatrix, side, price) {
    if (side === 'LONG') {
        // Sluit als de prijs de mesoBull target raakt of overschrijdt
        return price >= targetMatrix.mesoBull;
    } else if (side === 'SHORT') {
        // Sluit als de prijs de mesoBear target raakt of onderschrijdt
        return price <= targetMatrix.mesoBear;
    }
    return false;
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
    LightweightCharts.createSeriesMarkers(candlestickSeries, []);
    
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
        LightweightCharts.createSeriesMarkers(candlestickSeries, []);
        
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

            // 3. Tekst markers voor de grafiek
            if (relativeIndex === 0) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffffff',
                    shape: 'circle',
                    text: `RESET [Vortex 9] Node ${i} | ${timeLabel}`,
                });
            } else if (relativeIndex === 1) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffff00',
                    shape: 'circle',
                    text: `VOLA Node ${i} | ${timeLabel}`,
                });
            } else if (relativeIndex === 3 || relativeIndex === 6) {
                let vortexValue = (relativeIndex === 3) ? "3" : "6";
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `CORE [Vortex ${vortexValue}] Node ${i} | ${timeLabel}`,
                });
            } else {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#888888',
                    shape: 'square',
                    text: `Node ${i} | ${timeLabel}`,
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
            });
        }
    }
    
    // Sla de tekst-markers op
    gridMarkers = markers; 
    
    // Update de grafiek markers
    LightweightCharts.createSeriesMarkers(candlestickSeries, gridMarkers);
    
    // Update de Fib-lijnen
   // HIER PAS JE HET AAN:
    // Je voegt 'chartData' toe als het tweede argument.
    // De functie gebruikt nu allNodes voor de timing en chartData voor de prijs-range.
    updateActiveNodeFibLines(allNodes, chartData);

    if (typeof updateInfoPanel === 'function') updateInfoPanel();
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

            const livePrice = parseFloat(candle.c);
            const liveVol = parseFloat(candle.v);
            const high = parseFloat(candle.h);
            const low = parseFloat(candle.l);
            const openPrice = parseFloat(candle.o);
            const isBullish = livePrice >= openPrice;

            // 1. Volume Rate Berekening
            const volMetrics = calculateVolumeMetrics(liveVol, isBullish);
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
                const er = liveVol / sma20Volume;
                const db = (high - low !== 0) ? (2 * livePrice - (high + low)) / (high - low) : 0;
                const vfm = er * db;
                const price3DaysAgo = parseFloat(rawData[rawData.length - 288][4]);
                const chaos = Math.abs((livePrice - price3DaysAgo) / price3DaysAgo) * 100;
            
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
                        document.getElementById('mic-bull').innerText = decisionResult.targets.micro.bullish;
                        document.getElementById('mic-bear').innerText = decisionResult.targets.micro.bearish;
                        document.getElementById('mes-bull').innerText = decisionResult.targets.meso.bullish;
                        document.getElementById('mes-bear').innerText = decisionResult.targets.meso.bearish;
                        document.getElementById('mac-bull').innerText = decisionResult.targets.macro.bullish;
                        document.getElementById('mac-bear').innerText = decisionResult.targets.macro.bearish;
                    }

                    // Confidence Score
                    const confEl = document.getElementById('probability-score');
                    if (confEl) {
                        confEl.innerText = `Confidence: ${decisionResult.probability}`;
                        confEl.style.color = (decisionResult.probability.includes('High')) ? '#00ffcc' : '#aaa';
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

function toggleFibScale(scaleId) {
    // 1. Wissel de status
    activeFibScales[scaleId] = !activeFibScales[scaleId];
    
    // 2. Visuele feedback
    const btn = document.getElementById(`btn-toggle-${scaleId}`);
    if (btn) {
        btn.style.opacity = activeFibScales[scaleId] ? '1' : '0.5';
        btn.style.border = activeFibScales[scaleId] ? '2px solid #00ffcc' : '1px solid #555';
    }
    
    // 3. Herbereken en teken de chart
    // VOEG TOE: Check of de chart-serie überhaupt al bestaat
    if (typeof candlestickSeries !== 'undefined' && typeof allNodes !== 'undefined' && typeof rawData !== 'undefined') {
        updateActiveNodeFibLines(allNodes, rawData);
        console.log(`Schaal ${scaleId} is nu: ${activeFibScales[scaleId] ? 'AAN' : 'UIT'}`);
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

    let decision = "WAIT";
    let probability = "Low";

    if (confluence >= 4) {
        decision = isBullish ? "🚀 BULLISH BREAKOUT" : "📉 BEARISH CRASH";
        probability = "High (80%+)";
    } else if (confluence >= 2) {
        decision = "⚖️ TREND-FOLLOW";
        probability = "Medium (60%)";
    }

    return { decision, probability, targets, confluence };
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

initDashboard();
setInterval(updateInfoPanel, 1000);
