// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten
let currentWs = null;        // Onthoudt actieve WebSocket-verbinding
let globalChartData = [];    // Buffer voor data
let countdownInterval = null; // Interval-id voor de live countdownklok

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
        mode: 0, // Start in Lineair mode voor intraday 15m
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
        if (currentWs) {
            currentWs.close();
            currentWs = null;
        }

        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        
        globalChartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000), 
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(globalChartData);
        
        // Update het Grid direct op basis van de interval
        refreshGrid();
        
        startLiveUpdates();
    } catch (error) {
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- REFRESH GRID ROUTER ---
function refreshGrid() {
    if (currentInterval === '1d') {
        applyMacroGrid(globalChartData);
    } else {
        applyIntradayGrid(globalChartData);
    }
}

// --- DYNAMISCH TIMEFRAME WISSELEN (Nu volledig gekoppeld en klikbaar) ---
window.changeTimeframe = function(interval) {
    currentInterval = interval;
    
    // Forceer reset van de markers
    candlestickSeries.setMarkers([]);
    
    if (interval === '1d') {
        chart.priceScale('right').applyOptions({ mode: 1 }); // Logarithmic voor Macro
    } else {
        chart.priceScale('right').applyOptions({ mode: 0 }); // Linear voor Intraday
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
};

// --- PURE MACRO BEREKENING (ALLEEN VOOR 1D) ---
function applyMacroGrid(chartData) {
    if (chartData.length === 0) return;
    
    const minTimeSec = chartData[0].time;
    const maxTimeSec = chartData[chartData.length - 1].time;
    const markers = [];
    
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const MACRO_STEP_MS = 56 * ONE_DAY_MS; 
    const anchorMidnightMs = new Date('2026-07-01T00:00:00Z').getTime();

    const startStep = Math.floor(((minTimeSec * 1000) - anchorMidnightMs) / MACRO_STEP_MS) - 5;
    const endStep = Math.ceil(((maxTimeSec * 1000) - anchorMidnightMs) / MACRO_STEP_MS) + 5;

    for (let s = startStep; s <= endStep; s++) {
        const macroTimeMs = anchorMidnightMs + (s * MACRO_STEP_MS);
        const targetDateStr = new Date(macroTimeMs).toISOString().split('T')[0];

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

    markers.sort((a, b) => a.time - b.time);
    candlestickSeries.setMarkers(markers);
}

// --- PURE INTRADAY BEREKENING (15m, 30m, 1h) ---
function applyIntradayGrid(chartData) {
    if (chartData.length === 0) return;
    
    const minTimeSec = chartData[0].time;
    const maxTimeSec = chartData[chartData.length - 1].time;
    const markers = [];
    
    const startSearchIndex = Math.floor(((minTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil(((maxTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) + 5;
    
    let candleSizeSec = 900;
    if (currentInterval === '30m') candleSizeSec = 1800;
    if (currentInterval === '1h') candleSizeSec = 3600;

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
    candlestickSeries.setMarkers(markers);
}

// --- LIVE INFO PANEL MET SECONDEN-COUNTDOWN ---
function startClockEngine() {
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        const now = Date.now();

        // 1. BEREKEN VOLGENDE CORE NODE (Factor 3)
        const currentCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
        const nextCoreTime = ANCHOR_TIME + (currentCoreIndex * T_PI_MS);
        
        // Countdown wiskunde voor Core Node
        const diffCore = nextCoreTime - now;
        const hoursCore = Math.floor(diffCore / (1000 * 60 * 60));
        const minutesCore = Math.floor((diffCore % (1000 * 60 * 60)) / (1000 * 60));
        const secondsCore = Math.floor((diffCore % (1000 * 60)) / 1000);
        
        const pad = (num) => String(num).padStart(2, '0');
        
        document.getElementById('next-core-node').innerHTML = 
            `${new Date(nextCoreTime).toLocaleTimeString('nl-NL')} (Node ${currentCoreIndex}) <br>` +
            `<span style="color: #00ffcc; font-weight: bold; font-family: monospace;">COUNTDOWN: ${pad(hoursCore)}:${pad(minutesCore)}:${pad(secondsCore)}</span>`;
        
        // 2. BEREKEN VOLGENDE EXPIRATIE NODE (Factor 8)
        const currentExpIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
        const nextExpTime = ANCHOR_TIME + (currentExpIndex * T_PI_MS);
        
        const diffExp = nextExpTime - now;
        const hoursExp = Math.floor(diffExp / (1000 * 60 * 60));
        const minutesExp = Math.floor((diffExp % (1000 * 60 * 60)) / (1000 * 60));
        const secondsExp = Math.floor((diffExp % (1000 * 60)) / 1000);

        document.getElementById('next-expiration').innerHTML = 
            `${new Date(nextExpTime).toLocaleString('nl-NL')} (Node ${currentExpIndex}) <br>` +
            `<span style="color: #ff3366; font-weight: bold; font-family: monospace;">COUNTDOWN: ${pad(hoursExp)}:${pad(minutesExp)}:${pad(secondsExp)}</span>`;

    }, 1000); // Knalt elke seconde live op je scherm
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
        const candleTimeSec = candle.t / 1000;
        
        const updatedCandle = {
            time: candleTimeSec,
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
        };
        
        candlestickSeries.update(updatedCandle);
        
        const existingIndex = globalChartData.findIndex(c => c.time === candleTimeSec);
        if (existingIndex !== -1) {
            globalChartData[existingIndex] = updatedCandle;
        } else {
            globalChartData.push(updatedCandle);
        }
        
        refreshGrid();
    };
    
    currentWs.onerror = (err) => console.error("UOTAM Stream Error:", err);
}

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

initDashboard();
startClockEngine();
