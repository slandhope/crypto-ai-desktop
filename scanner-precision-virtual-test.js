/**
 * Virtual scanner test — no live orders, no Claude calls.
 * Synthetic BTC/ETH/SOL books + candles exercise math, gates, main, and scalp.
 */
'use strict';

const {
  computeConfluence,
  analyzeMultiTimeframe,
  applyPrecisionGates
} = require('./scanner-precision');
const { runPrecisionScan, runPrecisionScalpForCoin } = require('./scanner-precision-run');

function candles(start, n, drift, noise = 0.002) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const d = drift + (i % 7 === 0 ? -noise * 0.4 : noise * ((i % 3) - 1) * 0.15);
    const open = p;
    p = p * (1 + d);
    const high = Math.max(open, p) * 1.001;
    const low = Math.min(open, p) * 0.999;
    out.push({ open, high, low, close: p, volume: 1000 + i * 10 });
  }
  return out;
}

/** HTF still up, last 14 bars dip so RSI < 40 while close stays above SMA20 (scalp TA BULLISH). */
function scalpPullbackCandles(start, n = 60) {
  const out = candles(start, n - 14, 0.006, 0.0005);
  let p = out[out.length - 1].close;
  for (let i = 0; i < 14; i++) {
    const open = p;
    p = p * (i % 4 === 0 ? 1.0002 : 0.9994);
    out.push({
      open,
      high: Math.max(open, p) * 1.0004,
      low: Math.min(open, p) * 0.9996,
      close: p,
      volume: 2000
    });
  }
  return out;
}

function taBull(rsi = 28) {
  return [
    `RSI(14) 1h: ${rsi} 📈 Oversold — long bias`,
    'MACD: Bullish crossover',
    'BB: Price at LOWER band — oversold bounce likely',
    'S/R: Price at SUPPORT — good long entry',
    'Golden Cross — Above 200MA',
    'Overall: ✅ TA BULLISH (1h)'
  ].join('\n');
}

function taChop() {
  return [
    'RSI(14) 1h: 51 Neutral zone',
    'MACD: Flat',
    'Overall: ⚖️ TA MIXED — no clear direction'
  ].join('\n');
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

function mockDeps({ coin, price, scenario, opened, shadows }) {
  const bull = scenario === 'bull';
  const c1h = candles(price, 60, bull ? 0.004 : 0.0001);
  const c4h = candles(price * 0.92, 60, bull ? 0.006 : 0.0001);
  const c1d = candles(price * 0.8, 60, bull ? 0.008 : 0.00005);
  const c15 = bull ? scalpPullbackCandles(price, 60) : candles(price, 60, 0.0002);
  const last = c1h[c1h.length - 1].close;

  const settings = {
    precisionScanner: true,
    independentScanner: true,
    autoPaperTrade: true,
    scalpTrading: true,
    mtfMode: 'hard',
    regimeMode: 'hard',
    confluenceMinTier: 'STRONG',
    scalpConfluenceMinTier: 'WATCH',
    paperTradeThreshold: 20,
    autoThreshold: false,
    mirofishMode: 'off',
    scalpThreshold: 45,
    maxScalpTrades: 3,
    scalpDuration: 30,
    scalpLeverage: 10,
    scalpSize: 50
  };

  return {
    loadSettings: () => settings,
    loadDailySignals: () => ({ signals: { [coin]: { tier: 'Buy', rsi: 32, direction: 'long' } } }),
    loadExpectancy: () => ({}),
    saveExpectancy: () => {},
    detectMarketRegime: async () => ({
      regime: bull ? 'bull' : 'chop',
      bias: bull ? 'long' : 'neutral',
      summary: bull ? 'Bull regime' : 'Chop'
    }),
    getNewsSentiment: async () => ({ label: 'Neutral', score: 5, key_event: 'none' }),
    detectRSIDivergence: async () => ({ signal: bull ? 'bullish divergence on 1h' : '' }),
    getTelegramGroupSentiment: async () => null,
    getWhaleSignalForTrade: () => null,
    getCryptoPrice: async () => `$${last.toFixed(2)}`,
    getFundingRate: async () => 'Funding: 0.005% (neutral)',
    getFearGreed: async () => 'Fear & Greed: 48',
    getBTCDominanceTrend: async () => 'BTC.D stable',
    getCryptoNews: async () => 'No breaking news',
    getOpenInterest: async () => 'OI stable',
    getLongShortRatio: async () => 'L/S 1.1',
    getLiquidationZones: async () => 'Long liq zone below; Short liq zone above',
    getVolumeAnalysis: async () => bull ? 'High volume — above average' : 'Low volume thin tape',
    getTechnicalAnalysis: async () => bull ? taBull() : taChop(),
    getOrderBook: async () => bull ? 'Bid/Ask ratio 1.65 — Strong buy pressure' : 'Bid/Ask ratio 1.02',
    getCorrelation: async () => null,
    getTimeSignal: () => 'London/NY overlap — good liquidity',
    getAdvancedFlow: async () => bull ? 'Spot bid, CVD rising' : 'Mixed flow',
    getBTCLeadSignal: async () => ({ block: false, summary: 'BTC not blocking' }),
    getFundingRateExtreme: async () => ({ extreme: false, rate: 0.00005 }),
    getMultiTimeframeSignal: async (_c, dir) => analyzeMultiTimeframe(c1h, c4h, c1d, dir),
    getCandles: async (_c, tf) => {
      if (tf === '15m') return c15;
      if (tf === '4h') return c4h;
      if (tf === '1d') return c1d;
      if (tf === '5m') return [{ open: last, close: last * 1.001 }, { open: last, close: last * 1.002 }];
      return c1h;
    },
    getSpreadPct: async () => 0.02,
    calculateSmartTrade: async () => ({
      target: last * 1.025,
      stopLoss: last * 0.988
    }),
    checkUserRules: async () => ({ violated: false }),
    getReentryPenalty: () => 0,
    loadPaperTrades: () => ({ trades: [], balance: 100000, stats: { wins: 0, losses: 0 } }),
    closePaperTrade: async () => {},
    openPaperTrade: async (sig) => { opened.push(sig); return sig; },
    runScalpScan: async () => {},
    logShadowTrade: (...args) => { shadows.push({ coin: args[0], reason: args[5], meta: args[7] }); },
    saveTradeReplay: () => {},
    sendIntelEvent: () => {},
    asukaReact: () => {},
    anthropic: null,
    CLAUDE_MODEL: null
  };
}

async function main() {
  let failed = 0;
  const prices = { BTC: 64000, ETH: 3200, SOL: 145 };

  console.log('\n=== 1) Math layer: MTF + confluence + gates ===\n');
  try {
    const btcUp = candles(64000, 60, 0.005);
    const mtf = analyzeMultiTimeframe(btcUp, btcUp, btcUp, 'long');
    assert(mtf.htfTrend === 'long', `BTC synthetic uptrend HTF=${mtf.htfTrend}`);
    assert(mtf.isAligned, `long aligned ${mtf.alignmentPct}%`);

    const chop = candles(64000, 60, 0);
    const mtfChop = analyzeMultiTimeframe(chop, chop, chop, 'long');
    assert(!mtfChop.isAligned || mtfChop.htfTrend === 'neutral', `flat series not a hard long (${mtfChop.summary})`);

    const conf = computeConfluence({
      taText: taBull(),
      regime: { regime: 'bull', bias: 'long' },
      dailyBias: { direction: 'long' },
      mtf,
      divergence: { signal: 'bullish divergence' },
      orderBook: 'Bid/Ask ratio 1.7 — Strong buy pressure',
      liquidations: '',
      volume: 'High volume — above average',
      timeSignal: 'NY session',
      funding: '0.01%',
      fundingExtreme: { extreme: false },
      lsRatio: '1.2',
      advancedFlow: 'CVD rising'
    });
    assert(conf.direction === 'long', `confluence direction=${conf.direction} score=${conf.score} ${conf.tier}`);
    assert(['STRONG', 'ULTRA'].includes(conf.tier), `tier ${conf.tier} is STRONG+`);

    const gated = applyPrecisionGates({
      confluence: conf,
      mtf,
      regime: { regime: 'bull' },
      btcLead: { block: false },
      coin: 'BTC',
      settings: { mtfMode: 'hard', regimeMode: 'hard', confluenceMinTier: 'STRONG' },
      fundingExtreme: { extreme: false },
      volumeQuality: conf.volumeQuality,
      newsSentiment: { score: 5 }
    });
    assert(gated.pass, `gates pass conf=${gated.confidence} blocked=${gated.blockedBy}`);

    const chopConf = computeConfluence({
      taText: taChop(),
      regime: { regime: 'chop' },
      mtf: mtfChop,
      volume: 'Low volume thin',
      timeSignal: 'Weekend',
      orderBook: 'Bid/Ask ratio 1.01'
    });
    assert(!chopConf.direction || !chopConf.tier || chopConf.score < 65, `chop not STRONG (${chopConf.summary})`);
  } catch (e) {
    failed++;
    console.error(e.message);
  }

  console.log('\n=== 2) Virtual MAIN scan (paper, no AI) ===\n');
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    try {
      const opened = [];
      const shadows = [];
      const result = await runPrecisionScan(coin, mockDeps({ coin, price: prices[coin], scenario: 'bull', opened, shadows }));
      assert(result === 'taken', `${coin} main result=${result} opened=${opened.length}`);
      assert(opened[0].coin === coin && opened[0].direction === 'long', `${coin} paper ${opened[0].direction} @ ${opened[0].entry}`);
      assert(!opened[0].isScalp, `${coin} main is not a scalp`);
    } catch (e) {
      failed++;
      console.error(e.message);
    }
  }

  console.log('\n=== 3) Virtual MAIN chop should BLOCK ===\n');
  try {
    const opened = [];
    const shadows = [];
    const result = await runPrecisionScan('BTC', mockDeps({ coin: 'BTC', price: 64000, scenario: 'chop', opened, shadows }));
    assert(result === 'blocked', `chop main blocked (got ${result})`);
    assert(opened.length === 0, 'chop did not open paper');
    assert(shadows.length >= 1, `shadow logged: ${shadows[0]?.reason}`);
  } catch (e) {
    failed++;
    console.error(e.message);
  }

  console.log('\n=== 4) Virtual SCALP scan (paper, no AI) ===\n');
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    try {
      const opened = [];
      const shadows = [];
      const result = await runPrecisionScalpForCoin(
        coin,
        mockDeps({ coin, price: prices[coin], scenario: 'bull', opened, shadows }),
        { mainTrade: { coin, direction: 'long' } }
      );
      assert(result === 'taken', `${coin} scalp result=${result} opened=${opened.length} shadows=${shadows.map(s => s.reason).join(',')}`);
      assert(opened[0].isScalp === true, `${coin} flagged isScalp`);
      assert(opened[0].scalpExpiry > Date.now(), `${coin} has scalpExpiry`);
    } catch (e) {
      failed++;
      console.error(e.message);
    }
  }

  console.log('\n=== 5) Scalp vs main direction BLOCK ===\n');
  try {
    const opened = [];
    const shadows = [];
    const result = await runPrecisionScalpForCoin(
      'SOL',
      mockDeps({ coin: 'SOL', price: 145, scenario: 'bull', opened, shadows }),
      { mainTrade: { coin: 'SOL', direction: 'short' } }
    );
    assert(result === 'blocked', `counter-scalp blocked (got ${result})`);
    assert(opened.length === 0, 'no counter-scalp paper');
  } catch (e) {
    failed++;
    console.error(e.message);
  }

  console.log('\n' + (failed ? `RESULT: ${failed} failed` : 'RESULT: all virtual scanner tests passed'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
