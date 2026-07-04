// --- CONFIGURATIE ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MS = 188.6634 * 60 * 1000;

let currentInterval = '15m';
let globalChartData = [];
let countdownInterval = null;

// --- INITIALISATIE ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries);

// --- HOOFDFUNCTIE ---
async function initDashboard() {
    try {
        const resp = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const data = await resp.json();
        globalChartData = data.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(globalChartData);
        
        // Wacht kort om te zorgen dat de chart 'ready' is voor markers
        setTimeout(refreshMarkers, 500); 
    } catch (e) { console.error("Init fout:", e); }
}

// --- MARKER LOGICA (Tekst opmaak zoals in afbeeldingen) ---
function refreshMarkers() {
    const markers = [];
    
    globalChartData.forEach(c => {
        const nodeIdx = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        
        // Logica voor Vortex weergave
        if (nodeIdx % 3 === 0) {
            let vortex = (nodeIdx % 9 === 0) ? 9 : (nodeIdx % 6 === 0) ? 6 : 3;
            markers.push({
                time: c.time,
                position: 'aboveBar',
                color: '#00ffcc',
                shape: 'arrowDown',
                text: `Node ${nodeIdx} [Vortex ${vortex}]`
            });
        }
    });

    // Failsafe voor v5.2.0 build beperkingen
    if (typeof candlestickSeries.setMarkers === 'function') {
        candlestickSeries.setMarkers(markers);
    } else {
        console.error("Fout: Jouw versie van Lightweight Charts ondersteunt geen setMarkers.");
    }
}

// --- CLOCK & LIVE UPDATES ---
function startClockEngine() {
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

window.changeTimeframe = (int) => { currentInterval = int; initDashboard(); };
initDashboard();
startClockEngine();
