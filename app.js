// --- CONFIGURATIE ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime();
const T_PI_MS = 188.6634 * 60 * 1000;

let currentInterval = '15m';
let globalChartData = [];

// --- INITIALISATIE ---
const chart = LightweightCharts.createChart(document.getElementById('chart-container'), {
    width: document.getElementById('chart-container').clientWidth,
    height: 600,
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1f2233' }, horzLines: { color: '#1f2233' } },
});

const series = chart.addSeries(LightweightCharts.CandlestickSeries);

// --- DATA LADEN ---
async function initDashboard() {
    try {
        const resp = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const data = await resp.json();
        globalChartData = data.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4])
        }));
        series.setData(globalChartData);
        drawNodes();
    } catch (e) { console.error("Init fout:", e); }
}

// --- NODES TEKENEN (Gebruikt PriceLine ipv Markers) ---
function drawNodes() {
    // Verwijder oude lijnen
    series.priceLines().forEach(line => series.removePriceLine(line));

    globalChartData.forEach(c => {
        const i = Math.round((c.time * 1000 - ANCHOR_TIME) / T_PI_MS);
        if (i % 3 === 0) {
            let vortex = (i % 9 === 0) ? 9 : (i % 6 === 0) ? 6 : 3;
            // We gebruiken PriceLine omdat dit in elke build van Lightweight Charts zit
            series.createPriceLine({
                price: c.close,
                color: '#00ffcc',
                lineWidth: 1,
                lineStyle: 1,
                axisLabelVisible: true,
                title: `Node ${i} [Vortex ${vortex}]`
            });
        }
    });
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
