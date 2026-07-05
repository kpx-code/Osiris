// --- UOTAM CONFIGURATIE EN PARAMETERS --
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten
let currentWs = null;        // Onthoudt actieve WebSocket-verbinding

// - INITIALISEER HET TRADINGVIEW CHART INTERFACE -
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
        // 1. Zorg voor een schone lei: Wis markers direct bij start
        LightweightCharts.createSeriesMarkers(candlestickSeries, []);
        
        // 2. Fetch de data
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        // 3. Update de serie
        candlestickSeries.setData(chartData);
        
        // 4. Teken het grid
        applyUOTAMGrid(chartData);
        
        // 5. Herstart de live stream
        startLiveUpdates();
        
    } catch (error) {
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- LIVE KLOK BEREKENING (Zorg dat deze BOVEN de aanroep staat) ---
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
    
    LightweightCharts.createSeriesMarkers(candlestickSeries, []); 
    
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
        
        // Universeel label voor elke node
        const d = new Date(nodeTimeMs);
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
        const timeLabel = `${dateStr} ${timeStr}`;
        
        const normalizedNodeTime = Math.floor(nodeTimeSec / candleSizeSec) * candleSizeSec;
        const closestCandle = chartData.find(c => c.time === normalizedNodeTime);
        
        if (closestCandle) {
            // 1. RESET / VORTEX 9
            if (relativeIndex === 0) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffffff',
                    shape: 'circle',
                    text: `RESET [Vortex 9] Node ${i} | ${timeLabel}`,
                });
            }
            // 2. VOLA TRIGGER
            else if (relativeIndex === 1) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffff00',
                    shape: 'circle',
                    text: `VOLA Node ${i} | ${timeLabel}`,
                });
            }
            // 3. CORE NODES (Vortex 3 en 6)
            else if (relativeIndex === 3 || relativeIndex === 6) {
                let vortexValue = (relativeIndex === 3) ? "3" : "6";
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `CORE [Vortex ${vortexValue}] Node ${i} | ${timeLabel}`,
                });
            }
            // 4. OVERIGE NODES (Oscillatoren)
            else {
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
    
    LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
    if (typeof updateInfoPanel === 'function') updateInfoPanel();
}
// --- CRYPTO DATASTREAM VIA BINANCE WEBSOCKET ---
// --- 1. Historie lijst updaten ---
function updateHistoryList(rawData) {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    
    // Pak de laatste 10 candles (omgekeerd van de API-data)
    const recent = rawData.slice(-10).reverse();
    
    listEl.innerHTML = recent.map(d => `
        <li style="margin-bottom: 5px; border-bottom: 1px solid #333;">
            ${new Date(d[0]).toLocaleTimeString()} | 
            <span style="color: #00ffcc;">$${parseFloat(d[4]).toFixed(2)}</span> | 
            Vol: ${parseFloat(d[5]).toFixed(2)}
        </li>
    `).join('');
}

// --- 2. WebSocket aanpassen voor Live Volume ---
function startLiveUpdates() {
    if (currentWs) {
        currentWs.close();
    }

    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    
    currentWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const candle = message.k;
        
        // Update Chart
        candlestickSeries.update({
            time: candle.t / 1000,
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
        });

        // Update Live Volume in je nieuwe kaart
        const volEl = document.getElementById('live-volume');
        if (volEl) {
            volEl.innerText = parseFloat(candle.v).toFixed(4);
        }
    };
}

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

initDashboard();
setInterval(updateInfoPanel, 1000);
