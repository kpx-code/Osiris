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
                    const nextNode = allNodes.length > 1 ? allNodes[allNodes.length - 2] : activeNode;
                    const chartData = rawData.map(d => ({ time: Math.floor(d[0] / 1000), high: parseFloat(d[2]), low: parseFloat(d[3]) }));
            
                    if (activeNode.id !== lastProcessedNodeId) {
                        applyUOTAMGrid(chartData); 
                        lastProcessedNodeId = activeNode.id; 
                    }
                    updateActiveNodeFibLines(allNodes, chartData);
            
                    const activePrice = (activeNode.high + activeNode.low) / 2;
                    const nextPrice = (nextNode.high + nextNode.low) / 2;
            
                    if (!isNaN(activePrice) && !isNaN(nextPrice)) {
                        const decisionResult = getOrisisDecisionData(
                            volMetrics, livePrice, activePrice, nextPrice, vfm, er, db, chaos, isBullish
                        );
                        const statusDisplay = document.getElementById('market-status-main');
                        const targetDisplay = document.getElementById('target-range-main');
                        if (statusDisplay) statusDisplay.innerText = `${decisionResult.decision}`;
                        if (targetDisplay) targetDisplay.innerText = `Target: ${decisionResult.targetRange}`;
                        // 3. Update de Confidence Score (DEZE MISTE NOG!)
                        const confEl = document.getElementById('probability-score');
                        if (confEl) {
                            confEl.innerText = `Confidence: ${decisionResult.probability}`; // of wat je in je resultaat hebt
                            confEl.style.color = (decisionResult.probability === 'High') ? '#00ffcc' : '#aaa';
                        }
                    } else {
                        console.warn("Orisis blokkeert update: activePrice of nextPrice is NaN");
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
        { id: 'MIC', harmonic: 3, type: 'vortex3' },
        { id: 'MES', harmonic: 9, type: 'reset' },
        { id: 'MAC', harmonic: 24, type: 'reset' }
    ];

    // 4. Teken alleen wat actief is
    allScales.forEach(scale => {
        if (!activeFibScales[scale.id]) return; 

        const relevantNodes = targetNodes.filter(n => n.type && n.type.toLowerCase().includes(scale.type));
        if (relevantNodes.length < 2) return;

        const nodesInRange = relevantNodes.slice(-scale.harmonic);
        const startTime = nodesInRange[0].time;
        const endTime = nodesInRange[nodesInRange.length - 1].time;
        
        const candlesInPeriod = processedData.filter(c => c.time >= startTime && c.time <= endTime);
        if (candlesInPeriod.length === 0) return;

        const rangeHigh = Math.max(...candlesInPeriod.map(c => c.high));
        const rangeLow = Math.min(...candlesInPeriod.map(c => c.low));
        
        // Bereken levels
        const levels = calculateFibLevels(rangeHigh, rangeLow);
        const palette = fibPalettes[scale.id];

        Object.entries(levels).forEach(([ratio, price]) => {
            // Gebruik kleur van fibStyles, maar stijl/dikte van palette
            const levelStyle = fibStyles[ratio] || { color: '#cccccc', label: ratio };
            
            if (!isNaN(price)) {
                const line = candlestickSeries.createPriceLine({
                    price: price,
                    color: levelStyle.color, // Jouw kleuren (0.618 blijft groen, etc.)
                    lineWidth: palette.width,
                    lineStyle: palette.style, // Stijl per schaal (Dotted/Dashed/Solid)
                    axisLabelVisible: true,
                    title: `${scale.id} ${levelStyle.label}` 
                });
                activeFibLines.push(line);
            }
        });
    });
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

// Pas deze eerste regel van je functie aan:
function getOrisisDecisionData(metrics, currentPrice, activePrice, nextPrice, vfm, er, db, chaos, isBullish) {
    // 1. Confluence: Orisis' "Brain"
    let confluence = 0;
    if (metrics.regime === "BULLISH_EXPANSION" || metrics.regime === "BEARISH_CRASH") confluence += 2;
    if (Math.abs(db) > 0.4) confluence += 1; // Delta Balance
    if (vfm > 0) confluence += 2;           // VFM moet positief zijn
    if (chaos < 12) confluence += 1;        // Stabiliteit

    // 2. Dynamische Price Targets (GEBRUIK NU DE GETALLEN)
    const rangeLow = Math.min(activePrice, nextPrice);
    const rangeHigh = Math.max(activePrice, nextPrice);
    
    // 3. Besluitvorming
    let decision = "WAIT";
    let probability = "Low";
    
    // Optioneel: voeg hier je Critical Zone check toe
    const distanceToNode = Math.abs(currentPrice - activePrice);
    const isAtCriticalZone = distanceToNode < (currentPrice * 0.002);

    if (isAtCriticalZone && confluence >= 4) {
        decision = isBullish ? "🚀 BULLISH BREAKOUT" : "📉 BEARISH CRASH";
        probability = "High (80%+)";
    } else if (confluence >= 2) {
        decision = "⚖️ TREND-FOLLOW";
        probability = "Medium (60%)";
    }

    return { 
        decision, 
        probability, 
        targetRange: `${rangeLow.toFixed(0)} - ${rangeHigh.toFixed(0)}`,
        confluence 
    };
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
