/**
 * Shared precision scan runner — injectable deps so main.js and scanner-server.js share one path.
 */
'use strict';

const scannerPrecision = require('./scanner-precision');

/**
 * @param {string} scanCoin
 * @param {object} deps — injected I/O (fetchers, AI, paper, settings)
 * @returns {Promise<'skipped'|'taken'|'blocked'|void>}
 */
async function runPrecisionScan(scanCoin, deps) {
  const {
    loadSettings, loadDailySignals, loadExpectancy, saveExpectancy,
    detectMarketRegime, getNewsSentiment, detectRSIDivergence, getTelegramGroupSentiment,
    getWhaleSignalForTrade, getCryptoPrice, getFundingRate, getFearGreed,
    getBTCDominanceTrend, getCryptoNews, getOpenInterest, getLongShortRatio,
    getLiquidationZones, getVolumeAnalysis, getTechnicalAnalysis, getOrderBook,
    getCorrelation, getTimeSignal, getAdvancedFlow, getBTCLeadSignal,
    getFundingRateExtreme, getMultiTimeframeSignal, getCandles, getSpreadPct,
    calculateSmartTrade, checkUserRules, getReentryPenalty,
    loadPaperTrades, closePaperTrade, openPaperTrade, runScalpScan,
    logShadowTrade, saveTradeReplay, sendIntelEvent, asukaReact,
    anthropic, CLAUDE_MODEL, onSignalOpened
  } = deps;

  const settings = loadSettings();

  const fgRaw = await getFearGreed().catch(() => '50');
  if (deps.setCachedFearGreed) deps.setCachedFearGreed(parseInt(String(fgRaw).match(/\d+/)?.[0] || 50));

  const dailySignals = loadDailySignals();
  const dailySignalForCoin = dailySignals?.signals?.[scanCoin];

  const [regime, newsSentiment, divergence, tgSentiment] = await Promise.all([
    detectMarketRegime().catch(() => null),
    getNewsSentiment(scanCoin).catch(() => null),
    detectRSIDivergence(scanCoin).catch(() => null),
    getTelegramGroupSentiment ? getTelegramGroupSentiment(scanCoin).catch(() => null) : Promise.resolve(null)
  ]);
  const whaleSignal = getWhaleSignalForTrade ? getWhaleSignalForTrade(scanCoin) : null;

  const [coinPrice, funding, fearGreed, dominance, news, openInterest, lsRatio, liquidations, volume, technicalAnalysis, orderBook, correlation, timeSignal, advancedFlow, btcLead, fundingExtreme] = await Promise.all([
    getCryptoPrice(scanCoin.toLowerCase ? scanCoin.toLowerCase() : scanCoin).catch(() => null),
    getFundingRate(scanCoin).catch(() => null),
    Promise.resolve(fgRaw),
    getBTCDominanceTrend ? getBTCDominanceTrend().catch(() => null) : Promise.resolve(null),
    getCryptoNews().catch(() => null),
    getOpenInterest(scanCoin).catch(() => null),
    getLongShortRatio(scanCoin).catch(() => null),
    getLiquidationZones(scanCoin).catch(() => null),
    getVolumeAnalysis(scanCoin).catch(() => null),
    getTechnicalAnalysis(scanCoin).catch(() => null),
    getOrderBook(scanCoin).catch(() => null),
    getCorrelation ? getCorrelation(scanCoin).catch(() => null) : Promise.resolve(null),
    Promise.resolve(typeof getTimeSignal === 'function' ? getTimeSignal() : null),
    getAdvancedFlow ? getAdvancedFlow(scanCoin).catch(() => null) : Promise.resolve(null),
    scanCoin !== 'BTC' && getBTCLeadSignal ? getBTCLeadSignal().catch(() => null) : Promise.resolve(null),
    getFundingRateExtreme(scanCoin).catch(() => null)
  ]);

  const entryPrice = parseFloat(String(coinPrice || '').match(/\$?([\d,]+\.?\d*)/)?.[1]?.replace(/,/g, '') || 0)
    || parseFloat(String(coinPrice || '').replace(/[^0-9.]/g, '')) || 0;

  if (!(entryPrice > 0)) {
    logShadowTrade(scanCoin, 'long', null, null, null, 'no entry price', 0, {
      blockedBy: 'price', allowNoEntry: true
    });
    return 'blocked';
  }

  const mtfProbe = await getMultiTimeframeSignal(scanCoin, null).catch(() => null);

  const confluence = scannerPrecision.computeConfluence({
    taText: technicalAnalysis,
    regime,
    dailyBias: dailySignalForCoin,
    mtf: mtfProbe,
    divergence,
    orderBook,
    liquidations,
    volume,
    timeSignal,
    funding,
    fundingExtreme,
    openInterest,
    lsRatio,
    whale: whaleSignal,
    advancedFlow,
    newsSentiment
  });

  console.log(`📐 Precision math: ${scanCoin} ${confluence.summary}`);

  if (sendIntelEvent) {
    sendIntelEvent({
      type: 'scan',
      source: 'Precision Scan',
      body: `${scanCoin}: ${String(coinPrice || '').match(/\$[\d,]+/)?.[0] || coinPrice || 'N/A'} | ${confluence.tier || 'NONE'} ${confluence.direction || '—'} ${confluence.score}`,
      note: confluence.summary,
      notify: false
    });
  }

  const metaCommon = {
    regime: regime?.regime || 'unknown',
    setupType: confluence.setupType,
    tier: confluence.tier,
    axes: confluence.axes,
    independentCount: confluence.independentCount,
    score: confluence.score,
    volumeQuality: confluence.volumeQuality
  };

  if (!confluence.direction || !confluence.tier) {
    logShadowTrade(scanCoin, confluence.direction || 'long', entryPrice || null, null, null,
      'no confluence', confluence.score, { ...metaCommon, blockedBy: 'confluence', allowNoEntry: !entryPrice });
    return 'blocked';
  }

  const mtf = await getMultiTimeframeSignal(scanCoin, confluence.direction).catch(() => mtfProbe);

  const gated = scannerPrecision.applyPrecisionGates({
    confluence, mtf, regime, btcLead, coin: scanCoin, settings,
    fundingExtreme, volumeQuality: confluence.volumeQuality, newsSentiment
  });

  console.log(`🚪 Gates: pass=${gated.pass} blocked=${gated.blockedBy || '—'} conf=${gated.confidence}%`);

  if (!gated.pass) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, null, null,
      `gate:${gated.blockedBy}`, gated.confidence, {
        ...metaCommon, blockedBy: gated.blockedBy, gates: gated.gates, ab: gated.ab
      });
    if (asukaReact) asukaReact('trade_skip');
    return 'blocked';
  }

  const expMult = scannerPrecision.expectancyMultiplier(loadExpectancy(), confluence.setupType, scanCoin);
  if (expMult.mult === 0) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, null, null,
      `expectancy dead: ${expMult.detail}`, gated.confidence, {
        ...metaCommon, blockedBy: 'expectancy', gates: gated.gates, ab: gated.ab
      });
    return 'blocked';
  }

  let confidence = Math.round(gated.confidence * (expMult.mult >= 1 ? 1 : 0.92));
  const smartParams = await calculateSmartTrade(
    scanCoin, confluence.direction, confidence, fearGreed, funding, entryPrice
  ).catch(() => null);

  const target = smartParams?.target || (confluence.direction === 'long' ? entryPrice * 1.025 : entryPrice * 0.975);
  const stopLoss = smartParams?.stopLoss || (confluence.direction === 'long' ? entryPrice * 0.988 : entryPrice * 1.012);

  try {
    const spike = await getCandles(scanCoin, '5m', 2);
    if (spike?.length === 2) {
      const spikePct = Math.abs(spike[1].close - spike[1].open) / spike[1].open * 100;
      if (spikePct > 3) {
        logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, 'news spike freeze', confidence, {
          ...metaCommon, blockedBy: 'spike', gates: gated.gates, ab: gated.ab
        });
        return 'blocked';
      }
    }
  } catch (e) {}

  if (getSpreadPct) {
    try {
      const spread = await getSpreadPct(scanCoin);
      if (spread !== null && spread > 0.15) {
        logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, 'spread too wide', confidence, {
          ...metaCommon, blockedBy: 'spread', gates: gated.gates, ab: gated.ab
        });
        return 'blocked';
      }
    } catch (e) {}
  }

  if (checkUserRules) {
    const ruleCheck = await checkUserRules(scanCoin, confluence.direction, confluence.summary).catch(() => ({ violated: false }));
    if (ruleCheck.violated) {
      logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, `Blocked by rule: ${ruleCheck.rule}`, confidence, {
        ...metaCommon, blockedBy: 'user_rule', gates: gated.gates, ab: gated.ab
      });
      return 'blocked';
    }
  }

  let aiVeto = false;
  let aiReason = 'math confirmed';
  if (anthropic && CLAUDE_MODEL) {
    try {
      const prompt = scannerPrecision.buildAiValidationPrompt({
        coin: scanCoin,
        direction: confluence.direction,
        entry: entryPrice,
        target,
        stopLoss,
        confluence,
        gates: gated.gates,
        news: newsSentiment || news,
        regime,
        funding,
        reasonBits: [whaleSignal, divergence?.signal, tgSentiment?.signal, dominance].filter(Boolean).join(' | ')
      });
      const aiPromise = anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }]
      });
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('AI validator timeout')), 25000));
      const res = await Promise.race([aiPromise, timeoutPromise]);
      const text = res.content[0].text.trim().replace(/```json|```/g, '').trim();
      const verdict = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      aiVeto = !!verdict.veto;
      aiReason = verdict.reason || aiReason;
      if (typeof verdict.confidenceAdjust === 'number') {
        confidence = Math.max(0, Math.min(95, confidence + Math.max(-10, Math.min(10, verdict.confidenceAdjust))));
      }
      console.log(`🧠 AI validator: ${aiVeto ? 'VETO' : 'CONFIRM'} — ${aiReason}`);
    } catch (e) {
      console.log(`⚠️ AI validator error (${e.message?.slice(0, 60)}) — proceeding on math alone`);
    }
  }

  if (aiVeto) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, `AI veto: ${aiReason}`, confidence, {
      ...metaCommon, blockedBy: 'ai_veto', gates: gated.gates, ab: gated.ab
    });
    if (asukaReact) asukaReact('trade_skip');
    return 'blocked';
  }

  if (settings.mirofishMode === 'veto' && anthropic) {
    try {
      const roles = ['risk manager', 'news trader', 'contrarian trader'];
      let disagree = 0;
      for (const role of roles) {
        const r = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 80,
          messages: [{ role: 'user', content: `You are a crypto ${role}. Math says ${confluence.direction} ${scanCoin} (${confluence.tier}, ${confidence}%). News: ${String(news || '').slice(0, 120)}. Veto only if clear risk. JSON: {"veto":true/false,"reason":"8 words"}` }]
        });
        const j = JSON.parse((r.content[0].text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
        if (j.veto) disagree++;
      }
      if (disagree >= 2) {
        logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, `mirofish veto ${disagree}/3`, confidence, {
          ...metaCommon, blockedBy: 'mirofish_veto', gates: gated.gates, ab: gated.ab
        });
        return 'blocked';
      }
    } catch (e) {}
  }

  const threshold = settings.autoThreshold ? 50 : (settings.paperTradeThreshold || 20);
  const reentryPenalty = (getReentryPenalty && getReentryPenalty(scanCoin)) || 0;
  if (confidence < threshold + reentryPenalty) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss,
      `below threshold ${threshold}+${reentryPenalty}`, confidence, {
        ...metaCommon, blockedBy: 'threshold', gates: gated.gates, ab: gated.ab
      });
    return 'blocked';
  }

  const tierMult = confluence.tier === 'ULTRA' ? 1.0 : confluence.tier === 'STRONG' ? 0.75 : 0.4;
  const sizeMultiplier = Math.round(tierMult * expMult.mult * 100) / 100;
  if (sizeMultiplier < 0.25) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, 'size too small', confidence, {
      ...metaCommon, blockedBy: 'size', gates: gated.gates, ab: gated.ab
    });
    return 'blocked';
  }

  const pd = loadPaperTrades();
  // Main path: only block/replace non-scalp opens for this coin
  const existingTrade = (pd.trades || []).find(t => t.status === 'open' && t.coin === scanCoin && !t.isScalp);
  if (existingTrade) {
    if (confidence > (existingTrade.confidence || 0) + 15 && closePaperTrade) {
      await closePaperTrade(existingTrade.id, entryPrice, 'replaced by higher confidence precision signal');
    } else {
      console.log(`⏭️ Already have ${scanCoin} — skipping`);
      return 'skipped';
    }
  }

  const signal = {
    coin: scanCoin,
    direction: confluence.direction,
    entry: entryPrice,
    target,
    stopLoss,
    confidence,
    caller: 'Asuka (Precision)',
    groupName: `Math→Gates→AI | ${confluence.tier} | ${confluence.setupType}`,
    messageId: `prec_${Date.now()}`,
    timestamp: Date.now(),
    tradeMode: smartParams?.mode || 'normal',
    trailingLevels: smartParams?.trailingLevels,
    partialTp: smartParams?.partialTp,
    qualityGrade: confluence.tier === 'ULTRA' ? 'A' : confluence.tier === 'STRONG' ? 'B' : 'C',
    sizeMultiplier,
    setupType: confluence.setupType,
    confluenceTier: confluence.tier,
    confluenceScore: confluence.score,
    independentAxes: confluence.agreeing,
    precisionMeta: { gates: gated.gates, mtf: mtf?.summary, aiReason, expMult }
  };

  if (saveTradeReplay) {
    saveTradeReplay({
      coin: scanCoin, direction: confluence.direction,
      entry: entryPrice, target, stopLoss, confidence, timestamp: signal.timestamp,
      claudeReason: aiReason,
      marketBias: regime?.bias,
      finalReason: confluence.summary,
      qualityGrade: signal.qualityGrade,
      mode: signal.tradeMode,
      setupType: confluence.setupType,
      tier: confluence.tier,
      axes: confluence.agreeing,
      outcome: null
    });
  }

  const opened = await openPaperTrade(signal);
  if (!opened) {
    logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, 'open blocked downstream', confidence, {
      ...metaCommon, blockedBy: 'open_blocked', gates: gated.gates, ab: gated.ab
    });
    if (asukaReact) asukaReact('trade_skip');
    return 'blocked';
  }

  logShadowTrade(scanCoin, confluence.direction, entryPrice, target, stopLoss, 'TAKEN precision', confidence, {
    ...metaCommon, taken: true, gates: gated.gates, ab: gated.ab, blockedBy: null
  });

  if (asukaReact) asukaReact('trade_open', { detail: `${confluence.direction?.toUpperCase()} ${scanCoin}` });

  if (settings.scalpTrading && runScalpScan) {
    setTimeout(() => runScalpScan(signal), 2000);
  }

  if (onSignalOpened) onSignalOpened(signal, { aiReason, confluence });

  if (sendIntelEvent) {
    sendIntelEvent({
      type: 'signal',
      source: 'Precision Scanner',
      body: `${confluence.tier} ${confluence.direction?.toUpperCase()} ${scanCoin} @ ${confidence}%`,
      note: confluence.summary,
      notify: true
    });
  }

  return 'taken';
}

function _rsi14(candles) {
  if (!candles || candles.length < 16) return null;
  let g = 0, l = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) g += d; else l -= d;
  }
  const rs = l === 0 ? 100 : g / l;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function _scalpTaText(candles15) {
  if (!candles15 || candles15.length < 21) return '';
  const rsi = _rsi14(candles15);
  const last = candles15[candles15.length - 1].close;
  const slice = candles15.slice(-20);
  const sma = slice.reduce((a, c) => a + c.close, 0) / 20;
  const std = Math.sqrt(slice.reduce((s, c) => s + (c.close - sma) ** 2, 0) / 20) || 0;
  const upper = sma + 2 * std, lower = sma - 2 * std;
  const parts = [];
  if (rsi != null) {
    let sig = 'Neutral zone';
    if (rsi < 30) sig = '📈 Oversold — long bias';
    else if (rsi > 70) sig = '📉 Overbought — short bias';
    parts.push(`RSI(14) 1h: ${rsi} ${sig}`);
  }
  if (last <= lower * 1.002) parts.push('BB: Price at LOWER band — oversold bounce likely');
  else if (last >= upper * 0.998) parts.push('BB: Price at UPPER band — overbought pullback likely');
  const lows = candles15.slice(-30).map(c => c.low);
  const highs = candles15.slice(-30).map(c => c.high);
  const sup = Math.min(...lows), res = Math.max(...highs);
  const distS = ((last - sup) / last) * 100, distR = ((res - last) / last) * 100;
  if (distS < 0.4) parts.push('S/R: Price at SUPPORT — good long entry');
  else if (distR < 0.4) parts.push('S/R: Price at RESISTANCE — good short entry');
  const bull = (rsi != null && rsi < 40 ? 1 : 0) + (last <= lower ? 1 : 0) + (last > sma ? 1 : 0);
  const bear = (rsi != null && rsi > 60 ? 1 : 0) + (last >= upper ? 1 : 0) + (last < sma ? 1 : 0);
  if (bull > bear + 1) parts.push('Overall: ✅ TA BULLISH (scalp 15m)');
  else if (bear > bull + 1) parts.push('Overall: ❌ TA BEARISH (scalp 15m)');
  else parts.push('Overall: ⚖️ TA MIXED — no clear direction');
  return parts.join('\n');
}

/**
 * Math-first scalp for one coin. Entry TF ≈ 15m, confirm 1h + 4h.
 */
async function runPrecisionScalpForCoin(coin, deps, opts = {}) {
  const {
    loadSettings, loadPaperTrades, getCryptoPrice, getCandles, getOrderBook,
    getVolumeAnalysis, getFundingRate, getFundingRateExtreme, getLongShortRatio,
    getLiquidationZones, getTimeSignal, detectMarketRegime, getBTCLeadSignal,
    openPaperTrade, logShadowTrade, sendIntelEvent, anthropic, CLAUDE_MODEL
  } = deps;

  const settings = loadSettings();
  const pd = loadPaperTrades();
  const maxScalps = settings.maxScalpTrades || 3;
  const openScalps = (pd.trades || []).filter(t => t.status === 'open' && t.isScalp).length;
  if (openScalps >= maxScalps) return 'skipped';
  if ((pd.trades || []).find(t => t.status === 'open' && t.coin === coin && t.isScalp)) return 'skipped';

  const priceStr = await getCryptoPrice(coin.toLowerCase ? coin.toLowerCase() : coin).catch(() => null);
  const entryPrice = parseFloat(String(priceStr || '').match(/\$?([\d,]+\.?\d*)/)?.[1]?.replace(/,/g, '') || 0);
  if (!entryPrice) return 'skipped';

  const [c15, c1h, c4h, orderBook, volume, funding, fundingExtreme, lsRatio, liquidations, regime, btcLead] = await Promise.all([
    getCandles(coin, '15m', 60).catch(() => null),
    getCandles(coin, '1h', 60).catch(() => null),
    getCandles(coin, '4h', 60).catch(() => null),
    getOrderBook ? getOrderBook(coin).catch(() => null) : Promise.resolve(null),
    getVolumeAnalysis ? getVolumeAnalysis(coin).catch(() => null) : Promise.resolve(null),
    getFundingRate ? getFundingRate(coin).catch(() => null) : Promise.resolve(null),
    getFundingRateExtreme ? getFundingRateExtreme(coin).catch(() => null) : Promise.resolve(null),
    getLongShortRatio ? getLongShortRatio(coin).catch(() => null) : Promise.resolve(null),
    getLiquidationZones ? getLiquidationZones(coin).catch(() => null) : Promise.resolve(null),
    detectMarketRegime ? detectMarketRegime().catch(() => null) : Promise.resolve(null),
    coin !== 'BTC' && getBTCLeadSignal ? getBTCLeadSignal().catch(() => null) : Promise.resolve(null)
  ]);

  const taText = _scalpTaText(c15);
  const mtfProbe = scannerPrecision.analyzeMultiTimeframe(c15, c1h, c4h, null);
  const timeSignal = typeof getTimeSignal === 'function' ? getTimeSignal() : null;
  const confluence = scannerPrecision.computeConfluence({
    taText, regime, mtf: mtfProbe, orderBook, liquidations, volume, timeSignal,
    funding, fundingExtreme, lsRatio
  });

  const mainDir = opts.mainTrade?.direction;
  if (mainDir && confluence.direction && confluence.direction !== mainDir && confluence.tier !== 'ULTRA') {
    logShadowTrade(coin, confluence.direction, entryPrice, null, null, 'scalp vs main direction', confluence.score, {
      setupType: confluence.setupType, tier: confluence.tier, blockedBy: 'main_align', allowNoEntry: false
    });
    return 'blocked';
  }

  if (!confluence.direction || !confluence.tier) {
    logShadowTrade(coin, 'long', entryPrice, null, null, 'scalp no confluence', confluence.score, {
      setupType: confluence.setupType, blockedBy: 'confluence'
    });
    return 'blocked';
  }

  const mtf = scannerPrecision.analyzeMultiTimeframe(c15, c1h, c4h, confluence.direction);
  const scalpSettings = {
    ...settings,
    confluenceMinTier: settings.scalpConfluenceMinTier || 'WATCH',
    mtfMode: settings.mtfMode || 'hard',
    regimeMode: settings.regimeMode || 'soft' // scalps can fade a bit; still penalized
  };
  const gated = scannerPrecision.applyPrecisionGates({
    confluence, mtf, regime, btcLead, coin, settings: scalpSettings,
    fundingExtreme, volumeQuality: confluence.volumeQuality, newsSentiment: null
  });
  if (!gated.pass) {
    logShadowTrade(coin, confluence.direction, entryPrice, null, null, `scalp gate:${gated.blockedBy}`, gated.confidence, {
      setupType: confluence.setupType, tier: confluence.tier, blockedBy: gated.blockedBy, gates: gated.gates, ab: gated.ab
    });
    return 'blocked';
  }

  const tpPct = 0.007, slPct = 0.004;
  const target = confluence.direction === 'long' ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);
  const stopLoss = confluence.direction === 'long' ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);

  let confidence = gated.confidence;
  let aiVeto = false, aiReason = 'scalp math confirmed';
  if (anthropic && CLAUDE_MODEL) {
    try {
      const prompt = scannerPrecision.buildAiValidationPrompt({
        coin, direction: confluence.direction, entry: entryPrice, target, stopLoss,
        confluence, gates: gated.gates, news: 'scalp — skip unless breaking news',
        regime, funding, reasonBits: `15m scalp | main=${mainDir || 'none'}`
      });
      const res = await Promise.race([
        anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('scalp AI timeout')), 20000))
      ]);
      const verdict = JSON.parse((res.content[0].text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      aiVeto = !!verdict.veto;
      aiReason = verdict.reason || aiReason;
      if (typeof verdict.confidenceAdjust === 'number') {
        confidence = Math.max(0, Math.min(95, confidence + Math.max(-10, Math.min(10, verdict.confidenceAdjust))));
      }
    } catch (e) {
      console.log(`⚠️ Scalp AI validator: ${e.message?.slice(0, 50)} — math only`);
    }
  }
  if (aiVeto) {
    logShadowTrade(coin, confluence.direction, entryPrice, target, stopLoss, `scalp AI veto: ${aiReason}`, confidence, {
      setupType: confluence.setupType, blockedBy: 'ai_veto'
    });
    return 'blocked';
  }

  const threshold = settings.scalpThreshold || 45;
  if (confidence < threshold) {
    logShadowTrade(coin, confluence.direction, entryPrice, target, stopLoss, `scalp below threshold ${threshold}`, confidence, {
      setupType: confluence.setupType, blockedBy: 'threshold'
    });
    return 'blocked';
  }

  const scalpDuration = settings.scalpDuration || 30;
  const scalpLeverage = settings.scalpLeverage || 10;
  const scalpSize = settings.scalpSize || 50;
  const isLowVol = String(volume || timeSignal || '').match(/Low volume|Weekend/i);
  const size = Math.max(10, Math.round(scalpSize * (confluence.tier === 'ULTRA' ? 1 : confluence.tier === 'STRONG' ? 0.75 : 0.5) * (isLowVol ? 0.4 : 1)));

  const opened = await openPaperTrade({
    coin, direction: confluence.direction, entry: entryPrice, target, stopLoss,
    confidence, leverage: scalpLeverage, size,
    caller: 'Asuka (Precision Scalp)',
    groupName: `Scalp math→gates→AI | ${confluence.tier} | ${confluence.setupType}`,
    messageId: `pscalp_${Date.now()}`,
    timestamp: Date.now(),
    isScalp: true,
    tradeMode: 'scalp',
    scalpExpiry: Date.now() + scalpDuration * 60 * 1000,
    setupType: confluence.setupType,
    confluenceTier: confluence.tier,
    confluenceScore: confluence.score,
    independentAxes: confluence.agreeing,
    qualityGrade: confluence.tier === 'ULTRA' ? 'A' : confluence.tier === 'STRONG' ? 'B' : 'C',
    sizeMultiplier: 1 // size already tier-scaled above — do not double-apply
  });
  if (!opened) {
    logShadowTrade(coin, confluence.direction, entryPrice, target, stopLoss, 'scalp open blocked downstream', confidence, {
      setupType: confluence.setupType, blockedBy: 'open_blocked'
    });
    return 'blocked';
  }

  if (sendIntelEvent) {
    sendIntelEvent({
      type: 'signal', source: 'Precision Scalp',
      body: `${confluence.tier} ${confluence.direction?.toUpperCase()} ${coin} scalp @ ${confidence}%`,
      note: `${confluence.summary} | ${aiReason}`,
      notify: true
    });
  }
  console.log(`⚡ Precision scalp: ${confluence.direction?.toUpperCase()} ${coin} ${confluence.tier} ${confidence}%`);
  return 'taken';
}

async function runPrecisionIndependentScalp(deps) {
  const settings = deps.loadSettings();
  const coins = settings.scalpCoins || settings.tradingCoins || ['BTC', 'ETH', 'SOL'];
  console.log('⚡ Precision scalp scan (math → gates → AI veto)...');
  for (const coin of coins) {
    try { await runPrecisionScalpForCoin(coin, deps); }
    catch (e) { console.error(`⚡ Precision scalp ${coin}:`, e.message?.slice(0, 80)); }
  }
}

module.exports = {
  runPrecisionScan,
  runPrecisionScalpForCoin,
  runPrecisionIndependentScalp,
  scannerPrecision
};
