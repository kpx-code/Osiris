// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m';
let currentWs = null;

// --- INITIALISEER HET CHART ---
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
    } catch (error) { console.error("Data laadfout:", error); }
}

// --- MATRIX REKENKERN ---
function applyUOTAMGrid(chartData) {
    const markers = [];
    const candleSizeSec = currentInterval === '1m' ? 60 : currentInterval === '30m' ? 1800 : currentInterval === '1h' ? 3600 : 900;

    chartData.forEach(c => {
        const i = Math.round(((c.time * 1000) - ANCHOR_TIME) / T_PI_MS);
        
        if (i % 3 === 0) {
            const flowIndex = (i / 3) % 3;
            let vortex = (flowIndex === 0) ? "3" : (flowIndex === 1 || flowIndex === -2) ? "6" : "9";
            markers.push({
                time: c.time, position: 'aboveBar', color: '#00ffcc', shape: 'arrowDown',
                text: `Node ${i} [Vortex ${vortex}]`
            });
        }
        if (i % 8 === 0) {
            markers.push({
                time: c.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine',
                text: `EXPIRATIE (Node ${i})`
            });
        }
    });

    candlestickSeries.setMarkers(markers);
    updateInfoPanel();
}

// --- TIMEFRAME & UI ---
window.changeTimeframe = function(interval) {
    currentInterval = interval;
    // UI update alleen als knoppen bestaan
    ['1m', '15m', '30m', '1h'].forEach(int => {
        const btn = document.getElementById(`btn-${int}`);
        if (btn) {
            btn.style.background = (int === interval) ? '#00ffcc' : '#1f2233';
            btn.style.color = (int === interval) ? '#131722' : '#fff';
        }
    });
    initDashboard();
};

// --- REALTIME & INFOPANEEL ---
function startLiveUpdates() {
    if (currentWs) currentWs.close();
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    currentWs.onmessage = (e) => {
        const m = JSON.parse(e.data).k;
        candlestickSeries.update({
            time: m.t / 1000, open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c)
        });
    };
}

function updateInfoPanel() {
    const now = Date.now();
    const getCD = (mult) => {
        const idx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * mult)) * mult;
        return new Date(ANCHOR_TIME + (idx * T_PI_MS)).toLocaleString('nl-NL');
    };
    if(document.getElementById('next-core-node')) document.getElementById('next-core-node').innerText = getCD(3);
    if(document.getElementById('next-expiration')) document.getElementById('next-expiration').innerText = getCD(8);
}

initDashboard();
setInterval(updateInfoPanel, 60000);
