// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m';
let currentWs = null;

// --- INITIALISEER CHART ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth, height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1f2233' }, horzLines: { color: '#1f2233' } },
    timeScale: { timeVisible: true, secondsVisible: false },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});

// --- OHLC MOUSE HOVER ---
chart.subscribeCrosshairMove(param => {
    const ohlc = { o: document.getElementById('ohlc-open'), h: document.getElementById('ohlc-high'), l: document.getElementById('ohlc-low'), c: document.getElementById('ohlc-close') };
    if (param.time && param.seriesData.has(candlestickSeries)) {
        const data = param.seriesData.get(candlestickSeries);
        ohlc.o.innerText = data.open.toFixed(2); ohlc.h.innerText = data.high.toFixed(2);
        ohlc.l.innerText = data.low.toFixed(2); ohlc.c.innerText = data.close.toFixed(2);
        ohlc.c.style.color = data.close >= data.open ? '#26a69a' : '#ef5350';
    } else {
        Object.values(ohlc).forEach(el => el.innerText = '-');
        ohlc.c.style.color = '#d1d4dc';
    }
});

// --- HOOFDFUNCTIE ---
async function initDashboard() {
    try {
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        candlestickSeries.setData(chartData);
        applyUOTAMGrid(chartData);
        startLiveUpdates();
    } catch (error) { console.error("Fout:", error); }
}

// --- TIMEFRAME WISSELEN (1d verwijderd) ---
function changeTimeframe(interval) {
    currentInterval = interval;
    const intervals = ['15m', '30m', '1h'];
    intervals.forEach(int => {
        const btn = document.getElementById(`btn-${int}`);
        if (btn) {
            btn.style.background = (int === interval) ? '#00ffcc' : '#1f2233';
            btn.style.color = (int === interval) ? '#131722' : '#fff';
            btn.style.border = (int === interval) ? '1px solid #00ffcc' : '1px solid #333';
        }
    });
    initDashboard();
}

// --- MATRIX REKENKERN ---
function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    const markers = [];
    const candleSizeSec = (currentInterval === '30m') ? 1800 : (currentInterval === '1h') ? 3600 : (currentInterval === '1d') ? 86400 : 900;

    chartData.forEach(c => {
        const i = Math.round(((c.time * 1000) - ANCHOR_TIME) / T_PI_MS);
        const dateStr = new Date(c.time * 1000).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

        // LOGICA: 1d = 56-dagen node, overig = 3 & 8 cyclus
        const isTargetNode = (currentInterval === '1d') ? (i % 56 === 0) : (i % 3 === 0);
        const isExpiration = (currentInterval !== '1d') && (i % 8 === 0);

        if (isTargetNode) {
            let vortex = (i % 9 === 0) ? "9" : (i % 6 === 0) ? "6" : "3";
            markers.push({
                time: c.time, position: 'aboveBar', color: '#00ffcc', shape: 'arrowDown',
                text: `Node ${i} [Vortex ${vortex}] | ${dateStr}`
            });
        }
        if (isExpiration) {
            markers.push({
                time: c.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine',
                text: `EXPIRATIE Node ${i} | ${dateStr}`
            });
        }
    });

    // Unieke markers filteren op tijd + positie
    const uniqueMarkers = markers.filter((v, i, a) => a.findIndex(t => (t.time === v.time && t.position === v.position)) === i);
    candlestickSeries.setMarkers(uniqueMarkers);
}

// --- LIVE INFO & COUNTDOWN ---
function updateInfoPanel() {
    const now = Date.now();
    const pad = (n) => String(n).padStart(2, '0');
    
    // Core Node Countdown
    const nextCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const diff = (ANCHOR_TIME + (nextCoreIndex * T_PI_MS)) - now;
    const el = document.getElementById('next-core-node');
    if (el) el.innerText = `Node ${nextCoreIndex} in: ${Math.floor(diff/3600000)}u ${pad(Math.floor((diff%3600000)/60000))}m ${pad(Math.floor((diff%60000)/1000))}s`;
    
    // Expiratie
    const expIdx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const expEl = document.getElementById('next-expiration');
    if (expEl) expEl.innerText = `Exp Node ${expIdx}: ${new Date(ANCHOR_TIME + (expIdx * T_PI_MS)).toLocaleTimeString('nl-NL')}`;
}

// --- WEBSOCKET ---
function startLiveUpdates() {
    if (currentWs) currentWs.close();
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    currentWs.onmessage = (e) => {
        const m = JSON.parse(e.data).k;
        candlestickSeries.update({ time: m.t / 1000, open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c) });
    };
}

window.addEventListener('resize', () => chart.resize(chartContainer.clientWidth, 600));
initDashboard();
setInterval(updateInfoPanel, 1000);
