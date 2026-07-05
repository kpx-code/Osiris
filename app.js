// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); 
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

let currentInterval = '15m'; // Standaard interval bij opstarten
let currentWs = null;        // Onthoudt actieve WebSocket-verbinding

// --- INITIALISEER HET TRADINGVIEW CHART INTERFACE ---
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: 600,
    layout: {
        background: { color: '#131722' },
        textColor: '#d1d4dc',
    },
    grid: {
        vertLines: { color: '#1f2233' },
        horzLines: { color: '#1f2233' },
    },
    crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
    },
    timeScale: {
        timeVisible: true,
        secondsVisible: false,
    },
});

const candlestickSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
});

// --- MOUSE HOVER (OHLC DATA) SUBSCRIBER ---
chart.subscribeCrosshairMove(param => {
    const ohlcOpen = document.getElementById('ohlc-open');
    const ohlcHigh = document.getElementById('ohlc-high');
    const ohlcLow = document.getElementById('ohlc-low');
    const ohlcClose = document.getElementById('ohlc-close');

    if (param.time && param.seriesData.has(candlestickSeries)) {
        const data = param.seriesData.get(candlestickSeries);
        ohlcOpen.innerText = data.open.toFixed(2);
        ohlcHigh.innerText = data.high.toFixed(2);
        ohlcLow.innerText = data.low.toFixed(2);
        ohlcClose.innerText = data.close.toFixed(2);
        
        const color = data.close >= data.open ? '#26a69a' : '#ef5350';
        ohlcClose.style.color = color;
    } else {
        ohlcOpen.innerText = '-';
        ohlcHigh.innerText = '-';
        ohlcLow.innerText = '-';
        ohlcClose.innerText = '-';
        ohlcClose.style.color = '#d1d4dc';
    }
});

// --- DYNAMISCH TIMEFRAME WISSELEN ---
function changeTimeframe(interval) {
    currentInterval = interval;
    
    // Wis de markers
    LightweightCharts.createSeriesMarkers(candlestickSeries, []);
    
    // Update alleen de 15m knop (of verwijder de loop als je geen actieve status nodig hebt)
    const btn = document.getElementById('btn-15m');
    if (btn) {
        btn.style.background = '#00ffcc';
        btn.style.color = '#131722';
        btn.style.fontWeight = 'bold';
    }

    // Herlaad de data
    initDashboard();
}

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        // 1. Zorg voor een schone lei: Wis markers direct bij start
        LightweightCharts.createSeriesMarkers(candlestickSeries, []);
        
        // 2. Fetch de data
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000),
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        // 3. Update de serie
        candlestickSeries.setData(chartData);
        
        // 4. Teken het grid
        applyUOTAMGrid(chartData);
        
        // 5. Herstart de live stream
        startLiveUpdates();
        
    } catch (error) {
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- LIVE KLOK BEREKENING (Zorg dat deze BOVEN de aanroep staat) ---
// --- LIVE KLOK BEREKENING ---
function updateInfoPanel() {
    const now = Date.now();
    
    // Hulpfunctie voor datum en tijd
    const formatDateTime = (ms) => {
        const d = new Date(ms);
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
        return `${dateStr} ${timeStr}`;
    };

    // Hulpfunctie voor countdown
    const formatCountdown = (ms) => {
        const diff = ms - now;
        if (diff <= 0) return "NU";
        const minutes = Math.floor((diff / 1000 / 60) % 60);
        const seconds = Math.floor((diff / 1000) % 60);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    // Berekeningen
    const currentCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const nextCoreTime = ANCHOR_TIME + (currentCoreIndex * T_PI_MS);
    
    const currentExpIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const nextExpTime = ANCHOR_TIME + (currentExpIndex * T_PI_MS);

    // Update HTML
    const coreEl = document.getElementById('next-core-node');
    if (coreEl) {
        coreEl.innerText = `${formatDateTime(nextCoreTime)} | Node ${currentCoreIndex} | ${formatCountdown(nextCoreTime)}`;
    }
    
    const expEl = document.getElementById('next-expiration');
    if (expEl) {
        expEl.innerText = `${formatDateTime(nextExpTime)} | Node ${currentExpIndex} | ${formatCountdown(nextExpTime)}`;
    }
}

// --- MATRIX REKENKERN (VERVANG JE HUIDIGE FUNCTIE HIERDOOR) ---
// --- MATRIX REKENKERN ---
function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    
    LightweightCharts.createSeriesMarkers(candlestickSeries, []); 
    
    const markers = []; // Deze variabele hoort hier thuis
    const minTimeSec = chartData[0].time;
    const maxTimeSec = chartData[chartData.length - 1].time;
    
    const startSearchIndex = Math.floor(((minTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil(((maxTimeSec * 1000) - ANCHOR_TIME) / T_PI_MS) + 5;

    let candleSizeSec = 900; 

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        const d = new Date(nodeTimeMs);
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
        
        const normalizedNodeTime = Math.floor(nodeTimeSec / candleSizeSec) * candleSizeSec;
        const closestCandle = chartData.find(c => c.time === normalizedNodeTime);
        
        if (closestCandle) {
            // Logica voor CORE nodes
            if (i % 3 === 0) {
                let vortexValue = ((i / 3) % 3 === 0) ? "3" : (((i / 3) % 3 === 1) ? "6" : "9");
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `CORE Node ${i} [Vortex ${vortexValue}] | ${dateStr}`,
                });
            } 
            // Logica voor Volatiliteits-trigger
            else if (i === 1) {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#ffff00',
                    shape: 'circle',
                    text: `VOLA TRIGGER (Node ${i}) | ${dateStr}`,
                });
            }
            // Logica voor Oscillators
            else {
                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#888888',
                    shape: 'square',
                    text: `π-Oscillator (Node ${i}) | ${dateStr}`,
                });
            }

            // Expiratie toevoegen aan de set
            if (i % 8 === 0 && i !== 0) {
                markers.push({
                    time: closestCandle.time,
                    position: 'belowBar',
                    color: '#ff3366',
                    shape: 'verticalLine',
                    text: `EXPIRATIE (Node ${i}) | ${dateStr}`,
                });
            }
        }
    }
    
    // Nu zijn we nog steeds BINNEN de functie, dus 'markers' is hier bekend:
    LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
    
    if (typeof updateInfoPanel === 'function') {
        updateInfoPanel();
    }
} // <--- DEZE SLUITENDE ACCOLADE IS CRUCIAAL

// --- CRYPTO DATASTREAM VIA BINANCE WEBSOCKET ---
function startLiveUpdates() {
    // 1. Zorg voor een volledige afsluiting van de vorige instantie
    if (currentWs) {
        currentWs.onmessage = null; // ESSENTIEEL: verwijder de handler
        currentWs.onerror = null;   // Verwijder ook de error handler
        currentWs.close();          // Sluit de verbinding
        currentWs = null;           // Maak de referentie leeg
    }

    // 2. Start de nieuwe verbinding
    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    
    currentWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const candle = message.k;
        
        // Update de candlestick-serie
        candlestickSeries.update({
            time: candle.t / 1000,
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
        });
    };
    
    currentWs.onerror = (err) => console.error("UOTAM Stream Error:", err);
}

window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

initDashboard();
setInterval(updateInfoPanel, 1000);
