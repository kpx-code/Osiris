// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

// --- INITIALISEER HET CHART ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1f2233' }, horzLines: { color: '#1f2233' } },
});

// CORRECTIE: Gebruik addSeries (v5 standaard)
const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
});

// --- HOOFDFUNCTIE ---
async function initDashboard() {
    try {
        const response = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000');
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
    chartData.forEach(c => {
        const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        
        // Filter 1: Core Micro Nodes
        if (i % 3 === 0) {
            const flowIndex = (i / 3) % 3;
            let vortex = (flowIndex === 0) ? "3" : (flowIndex === 1 || flowIndex === -2) ? "6" : "9";
            markers.push({
                time: c.time, position: 'aboveBar', color: '#00ffcc', shape: 'arrowDown',
                text: `Node ${i} [Vortex ${vortex}]`
            });
        }
        // Filter 2: Expiratie
        if (i % 8 === 0) {
            markers.push({
                time: c.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine',
                text: `EXPIRATIE (${i})`
            });
        }
    });
    // CORRECTIE: setMarkers op de serie-instantie
    candlestickSeries.setMarkers(markers);
}

// --- REALTIME UPDATES ---
function startLiveUpdates() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_15m');
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data).k;
        candlestickSeries.update({
            time: m.t / 1000, open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c)
        });
    };
}

initDashboard();
