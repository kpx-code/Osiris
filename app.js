// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; 
let currentWs = null;        

// --- INITIALISEER HET TRADINGVIEW CHART INTERFACE ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1f2233' }, horzLines: { color: '#1f2233' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});

// --- HOOFDFUNCTIE: INITIALISATIE ---
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
    } catch (error) { console.error("Fout bij laden:", error); }
}

// --- DYNAMISCH TIMEFRAME WISSELEN ---
function changeTimeframe(interval) {
    currentInterval = interval;
    const intervals = ['15m', '30m', '1h']; // 1d verwijderd
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
    let candleSizeSec = (currentInterval === '30m') ? 1800 : (currentInterval === '1h') ? 3600 : 900;

    const startSearchIndex = Math.floor(((chartData[0].time * 1000) - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil(((chartData[chartData.length-1].time * 1000) - ANCHOR_TIME) / T_PI_MS) + 5;

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        const nodeTimeSec = Math.floor((ANCHOR_TIME + (i * T_PI_MS)) / 1000);
        const normalizedNodeTime = Math.floor(nodeTimeSec / candleSizeSec) * candleSizeSec;
        const closestCandle = chartData.find(c => c.time === normalizedNodeTime);
        
        if (closestCandle) {
            const dateStr = new Date(closestCandle.time * 1000).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
            
            if (i % 3 === 0) {
                let v = ((i/3)%3 === 0) ? "3" : ((i/3)%3 === 1) ? "6" : "9";
                markers.push({ 
                    time: closestCandle.time, position: 'aboveBar', color: '#00ffcc', shape: 'arrowDown', 
                    text: `Node ${i} [V${v}] | ${dateStr}` 
                });
            }
            if (i % 8 === 0) {
                markers.push({ 
                    time: closestCandle.time, position: 'belowBar', color: '#ff3366', shape: 'verticalLine', 
                    text: `EXPIRATIE ${i} | ${dateStr}` 
                });
            }
        }
    }
    candlestickSeries.setMarkers(markers);
    updateInfoPanel();
}

// --- LIVE KLOK & COUNTDOWN ---
function updateInfoPanel() {
    const now = Date.now();
    const pad = (n) => String(n).padStart(2, '0');
    
    // Core Node Countdown
    const nextCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const diff = (ANCHOR_TIME + (nextCoreIndex * T_PI_MS)) - now;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    const el = document.getElementById('next-core-node');
    if (el) el.innerText = `Node ${nextCoreIndex} in: ${h}:${pad(m)}:${pad(s)}`;
    
    // Expiratie
    const expIdx = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const expEl = document.getElementById('next-expiration');
    if (expEl) expEl.innerText = `Exp: ${new Date(ANCHOR_TIME + (expIdx * T_PI_MS)).toLocaleString('nl-NL')} (Node ${expIdx})`;
}

// --- WEBSOCKET ---
function startLiveUpdates() {
    if (currentWs) currentWs.close();
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    currentWs.onmessage = (event) => {
        const m = JSON.parse(event.data).k;
        candlestickSeries.update({ time: m.t / 1000, open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c) });
    };
}

// Start het systeem op
initDashboard();
setInterval(updateInfoPanel, 1000);
window.addEventListener('resize', () => chart.resize(chartContainer.clientWidth, 600));

