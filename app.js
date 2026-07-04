// --- CONFIGURATIE ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m';
let currentWs = null;
let globalChartData = [];
let countdownInterval = null;

// --- INITIALISATIE ---
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

// --- MOUSE HOVER (OHLC) ---
chart.subscribeCrosshairMove(param => {
    if (param.time && param.seriesData.has(candlestickSeries)) {
        const d = param.seriesData.get(candlestickSeries);
        document.getElementById('ohlc-open').innerText = d.open.toFixed(2);
        document.getElementById('ohlc-high').innerText = d.high.toFixed(2);
        document.getElementById('ohlc-low').innerText = d.low.toFixed(2);
        document.getElementById('ohlc-close').innerText = d.close.toFixed(2);
    }
});

// --- HOOFDFUNCTIE ---
async function initDashboard() {
    if (currentWs) { currentWs.close(); currentWs = null; }
    try {
        const resp = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const data = await resp.json();
        globalChartData = data.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        candlestickSeries.setData(globalChartData);
        refreshGrid();
        startLiveUpdates();
    } catch (e) { console.error("Init fout:", e); }
}

// --- GRID LOGICA (PriceLine is 100% v5 compatibel) ---
function refreshGrid() {
    // Verwijder oude lijnen
    candlestickSeries.priceLines().forEach(line => candlestickSeries.removePriceLine(line));

    globalChartData.forEach(c => {
        const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        // Teken verticale "node" lijnen
        if (i % 3 === 0) {
            candlestickSeries.createPriceLine({
                price: c.close,
                color: '#00ffcc',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: false,
                title: `Node ${i}`
            });
        }
    });
}

// --- CLOCK ENGINE ---
function startClockEngine() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        const cN = document.getElementById('next-core-node');
        const eN = document.getElementById('next-expiration');
        if (!cN || !eN) return;
        const now = Date.now();
        const getCD = (f) => {
            const idx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * f)) * f;
            const diff = (ANCHOR_TIME + (idx * T_PI_MS)) - now;
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(Math.floor(diff/3600000))}:${pad(Math.floor((diff%3600000)/60000))}:${pad(Math.floor((diff%60000)/1000))}`;
        };
        cN.innerHTML = `Core Node CD: ${getCD(3)}`;
        eN.innerHTML = `Expiratie CD: ${getCD(8)}`;
    }, 1000);
}

// --- LIVE DATA ---
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
