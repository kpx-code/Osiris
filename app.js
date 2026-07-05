// --- UOTAM CONFIGURATIE EN PARAMETERS ---
const ANCHOR_TIME = new Date('2026-07-01T12:00:00Z').getTime(); // Unix ms (UTC Ankerpunt)
const T_PI_MINUTES = 188.6634;
const T_PI_MS = T_PI_MINUTES * 60 * 1000;

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

// Gecorrigeerde Versie 5 syntax: we gebruiken 'createCandlestickSeries' i.p.v 'addCandlestickSeries'
const candlestickSeries = chart.createCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
});

// --- HOOFDFUNCTIE: INITIALISATIE ---
async function initDashboard() {
    try {
        // 1. Haal historische BTC kaarsen op van de gratis openbare Binance API (15m interval)
        const response = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000');
        const rawData = await response.json();
        
        const chartData = rawData.map(d => ({
            time: Math.floor(d[0] / 1000), // Omzetten van Unix ms naar Unix seconden voor de chart
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4])
        }));
        
        candlestickSeries.setData(chartData);

        // 2. Bereken en plot de UOTAM Matrix Nodes over de geladen kaarsen heen
        applyUOTAMGrid(chartData);
        
        // 3. Start de Live WebSocket verbinding voor realtime updates
        startLiveUpdates();
    } catch (error) {
        console.error("Fout bij het laden van de UOTAM Engine data:", error);
    }
}

// --- MATRIX REKENKERN: NODES BEREKENEN EN PROJECTEREN ---
function applyUOTAMGrid(chartData) {
    if (chartData.length === 0) return;
    
    const minTimeMs = chartData[0].time * 1000;
    const maxTimeMs = chartData[chartData.length - 1].time * 1000;
    
    const markers = [];
    
    // Bereken welke wiskundige nodes binnen het tijdvenster van de geladen grafiek vallen
    const startSearchIndex = Math.floor((minTimeMs - ANCHOR_TIME) / T_PI_MS) - 5;
    const endSearchIndex = Math.ceil((maxTimeMs - ANCHOR_TIME) / T_PI_MS) + 32;

    for (let i = startSearchIndex; i <= endSearchIndex; i++) {
        const nodeTimeMs = ANCHOR_TIME + (i * T_PI_MS);
        const nodeTimeSec = Math.floor(nodeTimeMs / 1000);
        
        // Koppel het wiskundige tijdstip aan de dichtstbijzijnde 15-minuten candle (marge van 7.5 min)
        const closestCandle = chartData.find(c => Math.abs(c.time - nodeTimeSec) <= 450);
        
        if (closestCandle) {
            // --- FILTER 1: CORE MICRO NODES (3-6-9 Cadans) ---
            if (i % 3 === 0) {
                let vortexValue = "";
                const flowIndex = (i / 3) % 3; 
                
                // Chronologische golf-stroom herleiden
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
            
            // --- FILTER 2: MACRO CYCLUS EXPIRATIE (Elke 8e Node) ---
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
    
    // Sorteer alle signalen chronologisch en activeer ze op het scherm
    markers.sort((a, b) => a.time - b.time);
    candlestickSeries.setMarkers(markers);
    
    // Update de realtime klokken in het dashboard
    updateInfoPanel();
}

// --- LIVE KLOK BEREKENING (INFOPANEEL) ---
function updateInfoPanel() {
    const now = Date.now();
    
    // Volgende Core Node berekenen
    const currentCoreIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 3)) * 3;
    const nextCoreTime = ANCHOR_TIME + (currentCoreIndex * T_PI_MS);
    document.getElementById('next-core-node').innerText = `${new Date(nextCoreTime).toLocaleTimeString('nl-NL')} (Node ${currentCoreIndex})`;
    
    // Volgende Macro Expiratie (8-Polair) berekenen
    const currentExpIndex = Math.ceil((now - ANCHOR_TIME) / (T_PI_MS * 8)) * 8;
    const nextExpTime = ANCHOR_TIME + (currentExpIndex * T_PI_MS);
    document.getElementById('next-expiration').innerText = `${new Date(nextExpTime).toLocaleString('nl-NL')} (Node ${currentExpIndex})`;
}

// --- REALTIME CRYPTO DATASTREAM VIA BINANCE WEBSOCKET ---
function startLiveUpdates() {
    // Gebruik WSS (Secure WebSocket) - verplicht voor GitHub Pages
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_15m');
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const candle = message.k;
        
        // Update de actuele kaars live op de openstaande TradingView chart
        candlestickSeries.update({
            time: candle.t / 1000,
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
        });
    };
    
    ws.onerror = (err) => console.error("UOTAM Stream Error:", err);
}

// Responsive design: schaal grafiek mee als het browservenster verandert
window.addEventListener('resize', () => {
    chart.resize(chartContainer.clientWidth, 600);
});

// Start de applicatie bij het laden van de pagina
initDashboard();
setInterval(updateInfoPanel, 60000); // Herbereken countdown data elke 60 seconden
