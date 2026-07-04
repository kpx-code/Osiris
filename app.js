// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten
let currentWs = null;        // Onthoudt actieve WebSocket-verbinding

// --- INITIALISEER HET TRADINGVIEW CHART INTERFACE ---
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
    rightPriceScale: {
        mode: 1, // Start in Logarithmic mode
        autoScale: true,
        borderVisible: false,
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

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        
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
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- DYNAMISCH TIMEFRAME WISSELEN ---
function changeTimeframe(interval) {
    currentInterval = interval;
    
    // Veeg de oude markers direct rigoureus leeg bij een wissel
    LightweightCharts.createSeriesMarkers(candlestickSeries, []);
    
    // Dynamische Schaal-wissel
    if (interval === '1d') {
        chart.priceScale('right').applyOptions({ mode: 1 }); // Logarithmic
    } else {
        chart.priceScale('right').applyOptions({ mode: 0 }); // Linear
    }
    
    const intervals = ['15m', '30m', '1h', '1d'];
    intervals.forEach(int => {
        const btn = document.getElementById(`btn-${int}`);
        if (btn) {
            if (int === interval) {
                btn.style.background = '#00ffcc';
                btn.style.color = '#131722';
                btn.style.border = '1px solid #00ffcc';
                btn.style.fontWeight = 'bold';
            } else {
                btn.style.background = '#1f2233';
                btn.style.color = '#fff';
                btn.style.border = '1px solid #333';
                btn.style.fontWeight = 'normal';
            }
        }
    });

    initDashboard();
}

// --- MATRIX REKENKERN ---
function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    
    const minTimeSec = chartData[0].time;
    const maxTimeSec = chartData[chartData.length - 1].time;
    const markers = [];
    
    // 1. HARD CORRIGEERBARE MACRO LOGICA (1 DAG)
    if (currentInterval === '1d') {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const MACRO_STEP_MS = 56 * ONE_DAY_MS; 

        // Harde ankerdatumafspraak gecorrigeerd op UTC middernacht
        const anchorMidnightMs = new Date('2026-07-01T00:00:00Z').getTime();

        const startStep = Math.floor(((minTimeSec * 1000) - anchorMidnightMs) / MACRO_STEP_MS) - 5;
        const endStep = Math.ceil(((maxTimeSec * 1000) - anchorMidnightMs) / MACRO_STEP_MS) + 5;

        for (let s = startStep; s <= endStep; s++) {
            const macroTimeMs = anchorMidnightMs + (s * MACRO_STEP_MS);
            const targetDateStr = new Date(macroTimeMs).toISOString().split('T')[0];

            // Zoek de dagkaars op basis van de datumstring
            const closestCandle = chartData.find(c => {
                const candleDateStr = new Date(c.time * 1000).toISOString().split('T')[0];
                return candleDateStr === targetDateStr;
            });

            if (closestCandle) {
                let labelText = `MACRO NODE (${s * 56}d)`;
                if (s === 0) labelText = "UOTAM ANKER (1 JULI 2026)";

                markers.push({
                    time: closestCandle.time,
                    position: 'belowBar',
                    color: '#ff3366',
                    shape: 'verticalLine',
                    text: labelText,
                });
            }
        }

        // STRIKTE ISOLATIE: Sorteer, teken de macro-markers en STOP direct! Ga niet door naar intraday.
        markers.sort((a, b) => a.time - b.time);
        LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
        updateInfoPanel();
        return; 
    } 
    
    // 2. INTRADAY SCALP LOGICA (15m, 30m, 1h) - Wordt NOOIT bereikt als interval '1d' is
    const startSearchIndex = Math.floor(((minTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil(((maxTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) + 5;
    const candleSizeSec = currentInterval === '30m' ? 1800 : (currentInterval === '1h' ? 3600 : 900);

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        const normalizedNodeTime = Math.floor(nodeTimeSec / candleSizeSec) * candleSizeSec;
        const closestCandle = chartData.find(c => c.time === normalizedNodeTime);
        
        if (closestCandle) {
            const hasCoreNode = markers.some(m => m.time === closestCandle.time && m.position === 'aboveBar');
            const hasExpiration = markers.some(m => m.time === closestCandle.time && m.position === 'belowBar');
            
            if (i % 3 === 0 && !hasCoreNode) {
                let vortexValue = "";
                const flowIndex = (i / 3) % 3; 
                if (flowIndex === 0) vortexValue = "3 (Start)";
                else if (flowIndex === 1 || flowIndex === -2) vortexValue = "6 (Inversie)";
                else if (flowIndex === 2 || flowIndex === -1) vortexValue = "9 (Absorptie)";

                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `Node ${i} [Vortex ${vortexValue.charAt(0)}]`,
                });
            }
            
            if (i % 8 === 0 && !hasExpiration) {
                markers.push({
                    time: closestCandle.time,
                    position: 'belowBar',
                    color: '#ff3366',
                    shape: 'verticalLine',
                    text: `EXPIRATIE (Node ${i})`,
                });
            }
        }
    }
    
    markers.sort((a, b) => a.time - b.time);
    LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
    updateInfoPanel();
}

// --- LIVE KLOK BEREKENING ---
function updateInfoPanel() {
    const now = Date.now();
    const currentCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const nextCoreTime = ANCHOR_TIME + (currentCoreIndex * T_PI_MS);
    document.getElementById('next-core-node').innerText = `${new Date(nextCoreTime).toLocaleTimeString('nl-NL')} (Node ${currentCoreIndex})`;
    
    const currentExpIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const nextExpTime = ANCHOR_TIME + (currentExpIndex * T_PI_MS);
    document.getElementById('next-expiration').innerText = `${new Date(nextExpTime).toLocaleString('nl-NL')} (Node ${currentExpIndex})`;
}

// --- CRYPTO DATASTREAM VIA BINANCE WEBSOCKET ---
function startLiveUpdates() {
    if (currentWs) {
        currentWs.close();
    }

    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    
    currentWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const candle = message.k;
        
        candlestickSeries.update({
            time: candle.t / 1000,
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
        });
        
        // Zorg ervoor dat live updates de grid-markers op 1D niet breken met intraday data
        if (candle.x && currentInterval === '1d') {
            initDashboard();
        }
    };
    
    currentWs.onerror = (err) => console.error("UOTAM Stream Error:", err);
}

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

initDashboard();
setInterval(updateInfoPanel, 60000);
