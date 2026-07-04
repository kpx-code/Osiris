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

// --- GRID ROUTER (Schoont oude PriceLines op) ---
function refreshGrid() {
    // Verwijder alle oude lijnen
    const lines = candlestickSeries.priceLines();
    lines.forEach(line => candlestickSeries.removePriceLine(line));

    if (currentInterval === '1d') {
        applyMacroGrid(globalChartData);
    } else {
        applyIntradayGrid(globalChartData);
    }
}

// --- LOGICA MET PRICELINES (v5.x COMPATIBEL) ---
function applyMacroGrid(chartData) {
    const ONE_DAY_MS = 86400000;
    const MACRO_STEP_MS = 56 * ONE_DAY_MS;
    const anchor = new Date('2026-07-01T00:00:00Z').getTime();

    chartData.forEach(c => {
        const diff = Math.round(((c.time * 1000) - anchor) / MACRO_STEP_MS);
        if (Math.abs((c.time * 1000) - (anchor + diff * MACRO_STEP_MS)) < ONE_DAY_MS / 2) {
            candlestickSeries.createPriceLine({
                price: c.close,
                color: '#ff3366',
                lineWidth: 1,
                lineStyle: 2, // Dashed
                axisLabelVisible: true,
                title: `Node ${diff * 56}d`,
            });
        }
    });
}

function applyIntradayGrid(chartData) {
    chartData.forEach(c => {
        const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        if (i % 3 === 0) {
            candlestickSeries.createPriceLine({
                price: c.close,
                color: '#00ffcc',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: `Node ${i}`,
            });
        }
    });
}

window.changeTimeframe = function(interval) {
    currentInterval = interval;
    initDashboard();
};

// --- CLOCK & LIVE UPDATES (Geen wijzigingen nodig) ---
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
        const c = { time: Math.floor(m.t/1000), open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c) };
        candlestickSeries.update(c);
        refreshGrid();
    };
}

initDashboard();
startClockEngine();
