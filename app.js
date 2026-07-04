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

// --- NIEUW: MOUSE HOVER (OHLC DATA) SUBSCRIBER ---
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
        
        // Kleur aanpassen op basis van bullish/bearish candle
        const color = data.close >= data.open ? '#26a69a' : '#ef5350';
        ohlcClose.style.color = color;
    } else {
        // Reset waarden als muis buiten de grafiek staat
        ohlcOpen.innerText = '-';
        ohlcHigh.innerText = '-';
        ohlcLow.innerText = '-';
        ohlcClose.innerText = '-';
        ohlcClose.style.color = '#d1d4dc';
    }
});

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        // 1. Haal historische data op op basis van het gekozen interval
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${currentInterval}&limit=1000`);
        const rawData = await response.json();
        
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000), // Dit is pure UTC van Binance, de browser vertaalt dit naar CET op de tijdas
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(chartData);

        // 2. Bereken en plot de UOTAM Matrix Nodes
        applyUOTAMGrid(chartData);
        
        // 3. Start de Live WebSocket verbinding
        startLiveUpdates();
    } catch (error) {
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- DYNAMISCH TIMEFRAME WISSELEN ---
function changeTimeframe(interval) {
    currentInterval = interval;
    
    // Update knoppen styling
    const intervals = ['1m', '15m', '30m', '1h'];
    intervals.forEach(int => {
        const btn = document.getElementById(`btn-${int}`);
        if (int === interval) {
            btn.style.background = '#00ffcc';
            btn.style.color = '#131722';
            btn.style.border = '1px solid #00ffcc';
            btn.style.fontWeight = 'bold';
        } else {
            btn.style.background = '#1f2233';
            btn.style.color = '#fff';
            btn.style.border = '1px solid #333';
            btn.style.fontWeight = 'normal';
        }
    });

    // Herstart het dashboard met het nieuwe interval
    initDashboard();
}

// --- MATRIX REKENKERN ---
function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    
    const minTimeMs = chartData[0].time * 1000;
    const maxTimeMs = chartData[chartData.length - 1].time * 1000;
    const markers = [];
    
    const startSearchIndex = Math.floor((minTimeMs - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil((maxTimeMs - ANCHOR_TIME) / T_PI_MS) + 32;

    // Bepaal de tolerantie (marge) op basis van het gekozen interval (in seconden)
    let toleranceSec = 450; // Standaard voor 15m (7.5 min)
    if (currentInterval === '1m') toleranceSec = 30;
    if (currentInterval === '30m') toleranceSec = 900;
    if (currentInterval === '1h') toleranceSec = 1800;

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        const closestCandle = chartData.find(c => Math.abs(c.time - nodeTimeSec) <= toleranceSec);
        
        if (closestCandle) {
            if (i % 3 === 0) {
                let vortexValue = "";
                const flowIndex = (i / 3) % 3; 
                if (flowIndex === 0) vortexValue = "3 (Start)";
                else if (flowIndex === 1 || flowIndex === -2) vortexValue = "6 (Inversie)";
                else if (flowIndex === 2 || flowIndex === -1) vortexValue = "9 (Absorptie)";

                markers.push({
                    time: closestCandle.time,
                    position: 'aboveBar',
                    color: '#00ffcc',
                    shape: 'arrowDown',
                    text: `Node ${i} [Vortex ${vortexValue.charAt(0)}]`,
                });
            }
            
            if (i % 8 === 0) {
                markers.push({
                    time: closestCandle.time,
                    position: 'belowBar',
                    color: '#ff3366',
                    shape: 'verticalLine',
                    text: `EXPIRATIE (Node ${i})`,
                });
            }
        }
    }
    
    markers.sort((a, b) => a.time - b.time);
    LightweightCharts.createSeriesMarkers(candlestickSeries, markers);
    updateInfoPanel();
}

// --- LIVE KLOK BEREKENING ---
function updateInfoPanel() {
    const now = Date.now();
    const currentCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const nextCoreTime = ANCHOR_TIME + (currentCoreIndex * T_PI_MS);
    document.getElementById('next-core-node').innerText = `${new Date(nextCoreTime).toLocaleTimeString('nl-NL')} (Node ${currentCoreIndex})`;
    
    const currentExpIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const nextExpTime = ANCHOR_TIME + (currentExpIndex * T_PI_MS);
    document.getElementById('next-expiration').innerText = `${new Date(nextExpTime).toLocaleString('nl-NL')} (Node ${currentExpIndex})`;
}

// --- CRYPTO DATASTREAM VIA BINANCE WEBSOCKET ---
function startLiveUpdates() {
    // Sluit de oude WebSocket als die nog open staat (cruciaal bij schakelen!)
    if (currentWs) {
        currentWs.close();
    }

    currentWs = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${currentInterval}`);
    
    currentWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const candle = message.k;
        
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
setInterval(updateInfoPanel, 60000);
