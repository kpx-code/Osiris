// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; 
let currentWs = null;        
let globalChartData = [];    
let countdownInterval = null; 

// --- INITIALISEER CHART ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1f2233' }, horzLines: { color: '#1f2233' } },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
});

// Verticale lijn laag (Histogram methode voor v5.x)
const nodeSeries = chart.addHistogramSeries({
    color: 'rgba(0, 255, 204, 0.3)',
    priceFormat: { type: 'volume' },
    priceScaleId: '', 
});

// --- MOUSE HOVER (OHLC DATA) ---
chart.subscribeCrosshairMove(param => {
    const ohlc = { o: '-', h: '-', l: '-', c: '-' };
    if (param.time && param.seriesData.has(candlestickSeries)) {
        const data = param.seriesData.get(candlestickSeries);
        ohlc.o = data.open.toFixed(2);
        ohlc.h = data.high.toFixed(2);
        ohlc.l = data.low.toFixed(2);
        ohlc.c = data.close.toFixed(2);
    }
    document.getElementById('ohlc-open').innerText = ohlc.o;
    document.getElementById('ohlc-high').innerText = ohlc.h;
    document.getElementById('ohlc-low').innerText = ohlc.l;
    document.getElementById('ohlc-close').innerText = ohlc.c;
});

// --- HOOFDFUNCTIE ---
async function initDashboard() {
    if (currentWs) {
        currentWs.close();
        currentWs = null;
    }

    try {
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        globalChartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000), 
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(globalChartData);
        refreshGrid();
        startLiveUpdates();
    } catch (e) { console.error("Init fout:", e); }
}

// --- GRID ROUTER ---
function refreshGrid() {
    const verticalNodes = [];
    
    if (currentInterval === '1d') {
        const ONE_DAY_MS = 86400000;
        const MACRO_STEP_MS = 56 * ONE_DAY_MS;
        const anchor = new Date('2026-07-01T00:00:00Z').getTime();
        globalChartData.forEach(c => {
            const diff = Math.round(((c.time * 1000) - anchor) / MACRO_STEP_MS);
            if (Math.abs((c.time * 1000) - (anchor + diff * MACRO_STEP_MS)) < ONE_DAY_MS / 2) {
                verticalNodes.push({ time: c.time, value: 1000000, color: '#ff3366' });
            }
        });
    } else {
        globalChartData.forEach(c => {
            const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
            if (i % 3 === 0) verticalNodes.push({ time: c.time, value: 1000000, color: '#00ffcc' });
            if (i % 8 === 0) verticalNodes.push({ time: c.time, value: 1000000, color: '#ff3366' });
        });
    }
    nodeSeries.setData(verticalNodes);
}

// --- CLOCK & LIVE ---
function startClockEngine() {
    countdownInterval = setInterval(() => {
        const cN = document.getElementById('next-core-node');
        const eN = document.getElementById('next-expiration');
        if (!cN || !eN) return;
        const now = Date.now();
        const pad = (n) => String(n).padStart(2, '0');
        const getCD = (f) => {
            const idx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * f)) * f;
            const target = ANCHOR_TIME + (idx * T_PI_MS);
            const diff = target - now;
            return { cd: `${pad(Math.floor(diff/3600000))}:${pad(Math.floor((diff%3600000)/60000))}:${pad(Math.floor((diff%60000)/1000))}` };
        };
        cN.innerHTML = `Core Node CD: ${getCD(3).cd}`;
        eN.innerHTML = `Expiratie CD: ${getCD(8).cd}`;
    }, 1000);
}

function startLiveUpdates() {
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    currentWs.onmessage = (e) => {
        const m = JSON.parse(e.data).k;
        candlestickSeries.update({ 
            time: Math.floor(m.t/1000), open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c) 
        });
    };
}

window.changeTimeframe = (int) => { currentInterval = int; initDashboard(); };

initDashboard();
startClockEngine();
