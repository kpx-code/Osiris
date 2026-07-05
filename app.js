// --- CONFIGURATIE ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MS = 188.6634 * 60 * 1000;

let currentInterval = '15m';
let globalChartData = [];

// --- INITIALISATIE ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
});

const series = chart.addSeries(LightweightCharts.CandlestickSeries);

// We maken een transparante 'AreaSeries' om de verticale lijnen te simuleren
const lineLayer = chart.addSeries(LightweightCharts.AreaSeries, {
    topColor: 'rgba(0, 255, 204, 0.5)',
    bottomColor: 'rgba(0, 255, 204, 0.0)',
    lineColor: 'rgba(0, 255, 204, 0.5)',
    lineWidth: 2,
    priceLineVisible: false
});

async function initDashboard() {
    try {
        const resp = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const data = await resp.json();
        globalChartData = data.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        
        series.setData(globalChartData);
        
        // Verticale lijnen logica:
        const lineData = globalChartData.map(c => {
            const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
            // Alleen waarde geven als het een node is, anders null (geen lijn)
            return (i % 3 === 0) ? { time: c.time, value: c.high * 1.05 } : { time: c.time, value: null };
        });
        lineLayer.setData(lineData);
        
    } catch (e) { console.error("Init fout:", e); }
}

// --- CLOCK ENGINE ---
setInterval(() => {
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

window.changeTimeframe = (int) => { currentInterval = int; initDashboard(); };
initDashboard();
