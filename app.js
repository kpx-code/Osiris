// - UOTAM CONFIGURATIE EN PARAMETERS -
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten

let currentWs = null; // Dit is cruciaal: Onthoudt actieve WebSocket-verbinding
let rawData = [];
// Houd een lijst bij van alle nodes waarvoor we puntjes willen tonen
let activeNodes = [];
let allNodes = []; // Hierin slaan we de gedetecteerde nodes op
let gridMarkers = []; // Zorg dat deze hier staat


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

    let candleSizeSec = 900; 

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        let relativeIndex = i % 8;
        if (relativeIndex < 0) relativeIndex += 8;

        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        const d = new Date(nodeTimeMs);
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
        const timeLabel = `${dateStr} ${timeStr}`;
        
        const normalizedNodeTime = Math.floor(nodeTimeSec / candleSizeSec) * candleSizeSec;
        const closestCandle = chartData.find(c => c.time === normalizedNodeTime);
        
        if (closestCandle) {
            // 1. Bepaal het nodeType voor de PriceLines
            let nodeType = 'osc';
            if (relativeIndex === 0) nodeType = 'reset';
            else if (relativeIndex === 1) nodeType = 'vola';
            else if (relativeIndex === 3) nodeType = 'vortex3';
            else if (relativeIndex === 6) nodeType = 'vortex6';

            // 2. Push naar allNodes inclusief het nieuwe 'type' veld
            allNodes.push({
                id: i,
                type: nodeType,
                time: closestCandle.time,
                high: closestCandle.high,
                low: closestCandle.low,
                isBullish: closestCandle.close >= closestCandle.open
            });

            // 3. Tekst markers voor de grafiek (blijven bestaan voor visuele referentie)
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
    }
    
// Sla de tekst-markers op
    gridMarkers = markers; 
    
    // HOUD DEZE AANROEP ZOALS HIJ WAS, MAAR ZORG DAT HIJ ALLEEN JE TEXT-MARKERS BEVAT
    LightweightCharts.createSeriesMarkers(candlestickSeries, gridMarkers);
    
    // VOEG DAARONDER DE FIB-LIJNEN TOE
    updateActiveNodeFibLines(allNodes);

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
    // 1. Sluit actieve verbinding indien aanwezig
    if (currentWs) {
        currentWs.close();
        currentWs = null;
    }

    const baseUrl = "wss://fstream.binance.com/market"; 
    currentWs = new WebSocket(`${baseUrl}/ws/btcusdt@kline_15m`);
    
    currentWs.onopen = () => console.log("UOTAM Engine verbonden met Binance.");

    currentWs.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            const candle = message.k;
            if (!candle) return;

            const livePrice = parseFloat(candle.c);
            const liveVol = parseFloat(candle.v);
            const high = parseFloat(candle.h);
            const low = parseFloat(candle.l);

            // 1. Update de grafiek
            candlestickSeries.update({
                time: candle.t / 1000,
                open: parseFloat(candle.o),
                high: high,
                low: low,
                close: livePrice,
            });

            // 2. UOTAM Engine Berekeningen
            if (rawData && rawData.length >= 20) {
                const sma20Volume = rawData.slice(-20).reduce((a, b) => a + parseFloat(b[5]), 0) / 20;
                const er = liveVol / sma20Volume;
                const db = (2 * livePrice - (high + low)) / (high - low);
                const vfm = er * db;
                
                let chaos = 0;
                if (rawData.length >= 288) {
                    const price3DaysAgo = parseFloat(rawData[rawData.length - 288][4]);
                    chaos = Math.abs((livePrice - price3DaysAgo) / price3DaysAgo) * 100;
                }

                // 3. UI Updates
                const updateDisplay = (id, val, format, status) => {
                    const pEl = document.getElementById(`${id}-display`);
                    const sEl = document.getElementById(`${id}-status`);
                    if (pEl) pEl.innerText = format(val);
                    if (sEl) {
                        sEl.innerText = status;
                        sEl.style.color = (val > 0) ? "#00ffcc" : "#ef5350";
                    }
                };

                updateDisplay('vfm', vfm, (v) => v.toFixed(3), Math.abs(vfm) > 1.5 ? "EXTREME" : "SIGNIFICANT");
                updateDisplay('er', er, (v) => v.toFixed(2), er > 1.2 ? "HIGH ENERGY" : "LOW ENERGY");
                updateDisplay('db', db, (v) => v.toFixed(2), db > 0 ? "BULLISH" : "BEARISH");
                updateDisplay('chaos', chaos, (v) => v.toFixed(1) + '%', chaos > 15 ? "EXTREME" : "STABIEL");
                
                const volEl = document.getElementById('live-volume');
                if (volEl) volEl.innerText = liveVol.toFixed(4);

                // 4. Sentiment Bar (Market Pressure)
                const bar = document.getElementById('sentiment-bar');
                if (bar) {
                    const buyPercent = ((db + 1) / 2) * 100;
                    bar.style.background = `linear-gradient(to right, #7FFFD4 ${buyPercent}%, #ef5350 ${buyPercent}%)`;
                }
            }

            // --- FIBONACCI NODE STRUCTUUR (LIVE) ---
            allNodes.forEach(node => {
                const nodeTimeSnapped = Math.floor(node.time / 900) * 900;
                const currentCandleTime = Math.floor(candle.t / 1000 / 900) * 900;

                if (nodeTimeSnapped === currentCandleTime) {
                    node.high = Math.max(parseFloat(candle.o), livePrice);
                    node.low = Math.min(parseFloat(candle.o), livePrice);
                    node.isBullish = livePrice > parseFloat(candle.o);
                    
                    if (!activeNodes.find(n => n.id === node.id)) {
                        activeNodes.push(node);
                    }
                }
            });
            
            // Teken alles opnieuw als de huidige candle een node raakt
            updateActiveNodeFibLines(); 
            
        } catch (err) {
            console.error("UOTAM Engine Fout:", err);
        }
    };
}

function calculateFibLevels(high, low, isBullish) {
    const range = high - low;
    
    // We berekenen zowel de positieve retracements als de negatieve extensies
    return {
        // Standaard levels (0 tot 1)
        '0.786': isBullish ? low + (range * 0.786) : high - (range * 0.786),
        '0.618': isBullish ? low + (range * 0.618) : high - (range * 0.618),
        '0.500': isBullish ? low + (range * 0.500) : high - (range * 0.500),
        '0.382': isBullish ? low + (range * 0.382) : high - (range * 0.382),
        '0.236': isBullish ? low + (range * 0.236) : high - (range * 0.236),
        
        // Negatieve levels (Extensies voor als de trend verder doorzet)
        '-0.236': isBullish ? low - (range * 0.236) : high + (range * 0.236),
        '-0.382': isBullish ? low - (range * 0.382) : high + (range * 0.382),
        '-0.500': isBullish ? low - (range * 0.500) : high + (range * 0.500),
        '-0.618': isBullish ? low - (range * 0.618) : high + (range * 0.618),
        '-0.786': isBullish ? low - (range * 0.786) : high + (range * 0.786)
    };
}

// Houd een referentie bij van de actieve lijnen zodat we ze kunnen verwijderen
let activeFibLines = [];

function updateActiveNodeFibLines(targetNodes) {
    // 1. Veiligheidscheck: bestaat de data wel?
    if (!targetNodes || !Array.isArray(targetNodes)) {
        console.warn("updateActiveNodeFibLines: targetNodes is leeg of geen array");
        return;
    }

    // 2. Verwijder eerst alle oude lijnen
    activeFibLines.forEach(line => candlestickSeries.removePriceLine(line));
    activeFibLines = [];

    const nodeConfigs = {
        'reset': '#ffffff',
        'vola': '#ffeb3b',
        'vortex3': '#ff4081',
        'vortex6': '#00ffcc'
    };

    Object.keys(nodeConfigs).forEach(type => {
        // Gebruik een veilige manier om de laatste node te vinden (zonder findLast)
        const lastNode = [...targetNodes].reverse().find(n => n.type === type);
        
        if (lastNode) {
            const levels = calculateFibLevels(lastNode.high, lastNode.low, lastNode.isBullish);
            
            Object.values(levels).forEach(price => {
                const line = candlestickSeries.createPriceLine({
                    price: price,
                    color: nodeConfigs[type],
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    axisLabelVisible: true,
                    title: type.toUpperCase()
                });
                activeFibLines.push(line);
            });
        }
    });
}
function getLastActiveNode() {
    if (typeof allNodes !== 'undefined' && allNodes.length > 0) {
        return allNodes[allNodes.length - 1];
    }
    return null; 
}

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

initDashboard();
setInterval(updateInfoPanel, 1000);
