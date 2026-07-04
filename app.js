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
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { autoScale: true, borderVisible: false },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
});

// --- OHLC MOUSE HOVER ---
chart.subscribeCrosshairMove(param => {
    const ohlc = { o: '-', h: '-', l: '-', c: '-' };
    if (param.time && param.seriesData.has(candlestickSeries)) {
        const d = param.seriesData.get(candlestickSeries);
        ohlc.o = d.open.toFixed(2); ohlc.h = d.high.toFixed(2); ohlc.l = d.low.toFixed(2); ohlc.c = d.close.toFixed(2);
    }
    const el = (id) => document.getElementById(id);
    if(el('ohlc-open')) {
        el('ohlc-open').innerText = ohlc.o;
        el('ohlc-high').innerText = ohlc.h;
        el('ohlc-low').innerText = ohlc.l;
        el('ohlc-close').innerText = ohlc.c;
    }
});

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    if (currentWs) {
        currentWs.onmessage = null;
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

// --- GRID ROUTER (Met foutafhandeling voor markers) ---
function refreshGrid() {
    try {
        if (typeof candlestickSeries.setMarkers === 'function') {
            candlestickSeries.setMarkers([]);
        }
    } catch(e) { console.warn("Markers wissen mislukt, negeren."); }

    if (currentInterval === '1d') {
        applyMacroGrid(globalChartData);
    } else {
        applyIntradayGrid(globalChartData);
    }
}

// --- TIMEFRAME SWITCH ---
window.changeTimeframe = function(interval) {
    currentInterval = interval;
    document.querySelectorAll('.timeframe-selector button').forEach(btn => {
        const isActive = btn.id === `btn-${interval}`;
        btn.style.background = isActive ? '#00ffcc' : '#1f2233';
        btn.style.color = isActive ? '#131722' : '#fff';
        btn.style.fontWeight = isActive ? 'bold' : 'normal';
    });
    initDashboard();
};

// --- LOGICA ---
function applyMacroGrid(chartData) {
    const markers = [];
    const ONE_DAY_MS = 86400000;
    const MACRO_STEP_MS = 56 * ONE_DAY_MS;
    const anchor = new Date('2026-07-01T00:00:00Z').getTime();

    chartData.forEach(c => {
        const diff = Math.round(((c.time * 1000) - anchor) / MACRO_STEP_MS);
        if (Math.abs((c.time * 1000) - (anchor + diff * MACRO_STEP_MS)) < ONE_DAY_MS / 2) {
            markers.push({ time: c.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine', text: `NODE ${diff * 56}d` });
        }
    });
    if (typeof candlestickSeries.setMarkers === 'function') candlestickSeries.setMarkers(markers);
}

function applyIntradayGrid(chartData) {
    const markers = [];
    chartData.forEach(c => {
        const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        if (i % 3 === 0) markers.push({ time: c.time, position: 'aboveBar', color: '#00ffcc', shape: 'arrowDown', text: `Node ${i}` });
        if (i % 8 === 0) markers.push({ time: c.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine', text: `EXP` });
    });
    if (typeof candlestickSeries.setMarkers === 'function') candlestickSeries.setMarkers(markers);
}

// --- CLOCK ENGINE ---
function startClockEngine() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        const cN = document.getElementById('next-core-node');
        const eN = document.getElementById('next-expiration');
        if (!cN || !eN) return;

        const now = Date.now();
        const pad = (n) => String(n).padStart(2, '0');
        const getCountdown = (factor) => {
            const idx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * factor)) * factor;
            const target = ANCHOR_TIME + (idx * T_PI_MS);
            const diff = target - now;
            return {
                text: `${new Date(target).toLocaleTimeString('nl-NL')} (Node ${idx})`,
                cd: `${pad(Math.floor(diff/3600000))}:${pad(Math.floor((diff%3600000)/60000))}:${pad(Math.floor((diff%60000)/1000))}`
            };
        };
        const core = getCountdown(3);
        const exp = getCountdown(8);
        cN.innerHTML = `${core.text}<br><span style="color:#00ffcc; font-family:monospace;">CD: ${core.cd}</span>`;
        eN.innerHTML = `${exp.text}<br><span style="color:#ff3366; font-family:monospace;">CD: ${exp.cd}</span>`;
    }, 1000);
}

// --- LIVE UPDATES ---
function startLiveUpdates() {
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    currentWs.onmessage = (e) => {
        const m = JSON.parse(e.data).k;
        const c = { time: Math.floor(m.t/1000), open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c) };
        candlestickSeries.update(c);
        const idx = globalChartData.findIndex(x => x.time === c.time);
        if (idx !== -1) globalChartData[idx] = c; else globalChartData.push(c);
        refreshGrid();
    };
}

initDashboard();
startClockEngine();
