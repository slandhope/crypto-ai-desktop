/**
 * Scanner Precision Layer
 * Math generates the signal; AI only validates/vetoes.
 * Independent confluence types (not stacked oscillators).
 * Scoreboard + per-setup expectancy + feature A/B snapshots.
 */

'use strict';

const TIERS = ['WATCH', 'STRONG', 'ULTRA'];
const TIER_MIN_SCORE = { WATCH: 45, STRONG: 65, ULTRA: 80 };

// Independent signal axes — different information, not redundant RSI clones
const AXES = ['trend', 'momentum', 'structure', 'volume', 'positioning', 'flow'];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseNum(s, re) {
  if (s == null) return null;
  const m = String(s).match(re);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function dirFromBias(bias) {
  if (bias > 0.15) return 'long';
  if (bias < -0.15) return 'short';
  return null;
}

/** Score one axis: -1..+1 (negative = bearish / short) */
function scoreTrend({ taText, regime, dailyBias, mtf }) {
  let s = 0;
  const t = String(taText || '');
  if (/TA BULLISH/i.test(t)) s += 0.55;
  else if (/TA BEARISH/i.test(t)) s -= 0.55;
  if (/Golden Cross/i.test(t)) s += 0.25;
  if (/Death Cross/i.test(t)) s -= 0.25;
  if (/Above 200MA/i.test(t)) s += 0.15;
  if (/Below 200MA/i.test(t)) s -= 0.15;
  if (/above Cloud|Ichimoku.*bull/i.test(t)) s += 0.2;
  if (/below Cloud|Ichimoku.*bear/i.test(t)) s -= 0.2;

  const r = (regime?.regime || '').toLowerCase();
  if (r === 'bull') s += 0.2;
  else if (r === 'bear') s -= 0.2;

  if (dailyBias?.direction === 'long') s += 0.15;
  else if (dailyBias?.direction === 'short') s -= 0.15;

  if (mtf?.alignmentPct != null) {
    // mtf alignment vs a provisional direction is applied later; here use HTF trend hint
    if (mtf.htfTrend === 'long') s += 0.25;
    else if (mtf.htfTrend === 'short') s -= 0.25;
  }
  return clamp(s, -1, 1);
}

function scoreMomentum({ taText, divergence }) {
  let s = 0;
  const t = String(taText || '');
  const rsi = parseNum(t, /RSI(?:\(\d+\))?\s*1h:\s*([\d.]+)/i);
  if (rsi != null) {
    if (rsi < 30) s += 0.55;
    else if (rsi < 40) s += 0.25;
    else if (rsi > 70) s -= 0.55;
    else if (rsi > 60) s -= 0.25;
  }
  if (/MACD:.*Bullish/i.test(t)) s += 0.2;
  if (/MACD:.*Bearish/i.test(t)) s -= 0.2;
  if (/Stoch|stoch/i.test(t) && /oversold|K\s*<\s*20/i.test(t)) s += 0.15;
  if (/Stoch|stoch/i.test(t) && /overbought|K\s*>\s*80/i.test(t)) s -= 0.15;

  const d = String(divergence?.signal || divergence || '');
  if (/bullish divergence/i.test(d)) s += 0.35;
  if (/bearish divergence/i.test(d)) s -= 0.35;
  return clamp(s, -1, 1);
}

function scoreStructure({ orderBook, liquidations, taText, pivotsNear }) {
  let s = 0;
  const ob = String(orderBook || '');
  const ratio = parseNum(ob, /Bid\/Ask ratio\s*([\d.]+)/i);
  if (ratio != null) {
    if (ratio > 1.5) s += 0.45;
    else if (ratio > 1.2) s += 0.2;
    else if (ratio < 0.7) s -= 0.45;
    else if (ratio < 0.85) s -= 0.2;
  }
  if (/Strong buy pressure/i.test(ob)) s += 0.2;
  if (/Strong sell pressure/i.test(ob)) s -= 0.2;

  const t = String(taText || '');
  if (/at SUPPORT/i.test(t)) s += 0.3;
  if (/at RESISTANCE/i.test(t)) s -= 0.3;
  if (/LOWER band/i.test(t)) s += 0.2;
  if (/UPPER band/i.test(t)) s -= 0.2;

  const liq = String(liquidations || '');
  // Recent long liquidations often precede bounce; short liqs → dump risk
  if (/Long liq zone/i.test(liq) && /Short liq zone/i.test(liq)) {
    /* magnet zones — mild mean-revert bias only if price near them handled elsewhere */
  }
  if (pivotsNear === 'support') s += 0.2;
  if (pivotsNear === 'resistance') s -= 0.2;
  return clamp(s, -1, 1);
}

function scoreVolume({ volume, timeSignal }) {
  let s = 0; // magnitude / quality, signed lightly with confirmation later
  const v = String(volume || '');
  let quality = 0; // 0..1 confirmation strength
  if (/SPIKE|spike/i.test(v)) quality = 0.8;
  else if (/High volume|above average/i.test(v)) quality = 0.5;
  else if (/Low volume|thin/i.test(v)) quality = 0.15;
  else quality = 0.35;

  const ts = String(timeSignal || '');
  let session = 0.5;
  if (/NY session/i.test(ts)) session = 1;
  else if (/London session/i.test(ts)) session = 0.85;
  else if (/Weekend/i.test(ts)) session = 0.25;
  else if (/low volume hours|Asia/i.test(ts)) session = 0.4;

  // Volume axis is "confirm" strength folded into signed bias by trend later;
  // here return a neutral-ish signed score from volume direction keywords
  if (/buying|bid|up volume|green/i.test(v)) s += 0.3;
  if (/selling|ask|down volume|red/i.test(v)) s -= 0.3;
  return { score: clamp(s, -1, 1), quality: quality * session, session };
}

function scorePositioning({ funding, fundingExtreme, openInterest, lsRatio }) {
  let s = 0;
  const fr = fundingExtreme || {};
  const rate = fr.rate != null ? fr.rate : parseNum(funding, /([-\d.]+)%/);
  if (rate != null) {
    // Extreme positive funding → crowded long → short bias
    if (rate > 0.1) s -= 0.55;
    else if (rate > 0.05) s -= 0.3;
    else if (rate < -0.1) s += 0.55;
    else if (rate < -0.05) s += 0.3;
  }
  if (fr.extreme) {
    if (rate > 0) s -= 0.15;
    else s += 0.15;
  }

  const oi = String(openInterest || '');
  const ls = String(lsRatio || '');
  if (/TOO MANY LONGS/i.test(ls)) s -= 0.4;
  if (/TOO MANY SHORTS/i.test(ls)) s += 0.4;

  // Rising OI reinforces trend (applied in regime layer); here mild mean-revert on extreme
  if (/RISING/i.test(oi) && rate != null && Math.abs(rate) > 0.05) {
    // crowded + rising OI = fuel for squeeze against crowd
    if (rate > 0) s -= 0.15;
    else s += 0.15;
  }
  return clamp(s, -1, 1);
}

function scoreFlow({ whale, advancedFlow, newsSentiment }) {
  let s = 0;
  const w = String(whale || '');
  if (/OFF exchange|accumulation/i.test(w)) s += 0.45;
  if (/TO exchange|distribution/i.test(w)) s -= 0.45;

  const f = String(advancedFlow || '');
  if (/bullish|bid sweep|accumulation|longs/i.test(f) && !/bearish/i.test(f)) s += 0.25;
  if (/bearish|ask sweep|distribution|shorts/i.test(f) && !/bullish/i.test(f)) s -= 0.25;

  const ns = newsSentiment;
  if (ns?.score != null) s += clamp(ns.score / 10, -0.35, 0.35);
  return clamp(s, -1, 1);
}

/**
 * Regime-appropriate weights: momentum in trends, mean-reversion in ranges.
 */
function axisWeights(regimeName) {
  const r = (regimeName || '').toLowerCase();
  if (r === 'bull' || r === 'bear') {
    return { trend: 1.35, momentum: 1.15, structure: 0.9, volume: 1.0, positioning: 1.0, flow: 0.95 };
  }
  // sideways / unknown → mean-reversion / structure / positioning heavier
  return { trend: 0.7, momentum: 1.2, structure: 1.25, volume: 0.9, positioning: 1.3, flow: 1.0 };
}

function tierFromScore(score) {
  if (score >= TIER_MIN_SCORE.ULTRA) return 'ULTRA';
  if (score >= TIER_MIN_SCORE.STRONG) return 'STRONG';
  if (score >= TIER_MIN_SCORE.WATCH) return 'WATCH';
  return null;
}

/**
 * Build independent confluence + provisional direction from market bundle.
 */
function computeConfluence(ctx) {
  const vol = scoreVolume(ctx);
  const axes = {
    trend: scoreTrend(ctx),
    momentum: scoreMomentum(ctx),
    structure: scoreStructure(ctx),
    volume: vol.score,
    positioning: scorePositioning(ctx),
    flow: scoreFlow(ctx)
  };

  const weights = axisWeights(ctx.regime?.regime);
  let longScore = 0;
  let shortScore = 0;
  let weightSum = 0;
  const agreeing = { long: [], short: [] };

  for (const axis of AXES) {
    const w = weights[axis] || 1;
    weightSum += w;
    const v = axes[axis];
    if (v > 0.12) {
      longScore += v * w;
      agreeing.long.push(axis);
    } else if (v < -0.12) {
      shortScore += Math.abs(v) * w;
      agreeing.short.push(axis);
    }
  }

  // Volume quality boosts whichever side is leading
  const lead = longScore >= shortScore ? 'long' : 'short';
  const leadRaw = lead === 'long' ? longScore : shortScore;
  const otherRaw = lead === 'long' ? shortScore : longScore;
  const net = leadRaw - otherRaw * 0.5;
  const maxPossible = weightSum;
  let score = clamp(Math.round((net / Math.max(maxPossible * 0.55, 0.01)) * 100 * (0.7 + 0.3 * vol.quality)), 0, 100);

  let direction = leadRaw > 0.15 && leadRaw > otherRaw ? lead : null;
  // Require at least 2 independent axes agreeing
  const agreeList = direction === 'long' ? agreeing.long : agreeing.short;
  if (!direction || agreeList.length < 2) {
    direction = null;
    score = Math.min(score, 40);
  }

  const setupType = classifySetup({ direction, axes, regime: ctx.regime?.regime, agreeing: agreeList });
  const tier = direction ? tierFromScore(score) : null;

  return {
    direction,
    score,
    tier,
    axes,
    agreeing: agreeList,
    independentCount: agreeList.length,
    setupType,
    volumeQuality: vol.quality,
    session: vol.session,
    weights,
    summary: direction
      ? `${tier || 'WEAK'} ${direction.toUpperCase()} score=${score} axes=[${agreeList.join(',')}] setup=${setupType}`
      : `NO SIGNAL score=${score} (need ≥2 independent axes)`
  };
}

function classifySetup({ direction, axes, regime, agreeing }) {
  if (!direction) return 'none';
  const r = (regime || 'unknown').toLowerCase();
  const meanRevert = agreeing.includes('momentum') && agreeing.includes('positioning') && !agreeing.includes('trend');
  const momentumTrend = agreeing.includes('trend') && agreeing.includes('momentum');
  const flowDriven = agreeing.includes('flow') || agreeing.includes('structure');
  let kind = 'mixed';
  if (meanRevert) kind = 'mean_reversion';
  else if (momentumTrend) kind = 'momentum';
  else if (flowDriven) kind = 'flow_structure';
  return `${kind}_${direction}_${r}`;
}

/**
 * Improved MTF: HTF trend via SMA20 slope/price, entry TF RSI — not RSI-only on all TFs.
 * Higher TF should be 4–6× entry; here entry≈1h → confirm 4h + 1d.
 */
function analyzeMultiTimeframe(candles1h, candles4h, candles1d, direction) {
  const sma = (candles, n) => {
    if (!candles || candles.length < n) return null;
    const slice = candles.slice(-n);
    return slice.reduce((a, c) => a + c.close, 0) / n;
  };
  const trendOf = (candles) => {
    if (!candles || candles.length < 25) return null;
    const close = candles[candles.length - 1].close;
    const s20 = sma(candles, 20);
    const s50 = candles.length >= 50 ? sma(candles, 50) : s20;
    if (s20 == null) return null;
    if (close > s20 && s20 >= (s50 || s20) * 0.998) return 'long';
    if (close < s20 && s20 <= (s50 || s20) * 1.002) return 'short';
    return 'neutral';
  };

  const t1h = trendOf(candles1h);
  const t4h = trendOf(candles4h);
  const t1d = trendOf(candles1d);
  const htfTrend = t4h === t1d && t4h !== 'neutral' ? t4h
    : (t4h && t4h !== 'neutral' ? t4h : (t1d && t1d !== 'neutral' ? t1d : 'neutral'));

  let aligned = 0;
  let total = 0;
  const check = (t) => {
    if (!t || t === 'neutral' || !direction) return;
    total++;
    if (t === direction) aligned++;
  };
  check(t1h);
  check(t4h);
  check(t1d);

  const alignmentPct = total > 0 ? Math.round((aligned / total) * 100) : 0;
  // Hard align: HTF (4h or daily) must match direction when it has a lean.
  // All-neutral / no directional TFs: treat as soft-ok (not a hard fail on 0%).
  const htfAligned = !direction || htfTrend === 'neutral' || htfTrend === direction;
  const isAligned = total === 0
    ? htfAligned
    : (htfAligned && alignmentPct >= 67);

  return {
    t1h, t4h, t1d, htfTrend,
    aligned, total, alignmentPct, isAligned, htfAligned,
    summary: `MTF: 1h=${t1h} 4h=${t4h} 1d=${t1d} HTF=${htfTrend} align=${aligned}/${total} (${alignmentPct}%) ${isAligned ? '✅' : '⚠️'}`
  };
}

/**
 * Apply hard/soft gates. Returns { pass, confidence, blockedBy, gates, ab }
 * `ab` records would-pass with/without each feature for scoreboard A/B.
 */
function applyPrecisionGates({ confluence, mtf, regime, btcLead, coin, settings, fundingExtreme, volumeQuality, newsSentiment }) {
  const gates = {};
  const ab = {};
  let confidence = confluence.score;
  let blockedBy = null;
  const direction = confluence.direction;
  const mtfMode = (settings.mtfMode || 'hard').toLowerCase();
  let minTier = (settings.confluenceMinTier || 'STRONG').toUpperCase();
  if (TIERS.indexOf(minTier) < 0) minTier = 'STRONG';
  const minScore = TIER_MIN_SCORE[minTier] || TIER_MIN_SCORE.STRONG;

  // Confluence threshold
  const tierOk = confluence.tier && TIERS.indexOf(confluence.tier) >= TIERS.indexOf(minTier);
  gates.confluence = {
    pass: !!(direction && tierOk && confluence.score >= minScore),
    detail: confluence.summary
  };
  ab.withoutConfluenceGate = { wouldPass: !!direction, score: confluence.score };

  if (!gates.confluence.pass && !blockedBy) blockedBy = 'confluence';

  // MTF gate — missing MTF in hard mode fails (don't silently disable)
  if (mtfMode !== 'off') {
    if (!mtf) {
      ab.withoutMtf = { wouldPass: true };
      ab.withMtf = { wouldPass: false };
      if (mtfMode === 'hard') {
        gates.mtf = { pass: false, detail: 'MTF unavailable' };
        if (!blockedBy) blockedBy = 'mtf';
      } else {
        confidence = Math.max(0, confidence - 12);
        gates.mtf = { pass: true, softPenalty: 12, detail: 'MTF unavailable (soft)' };
      }
    } else {
      const hardFail = !mtf.htfAligned || !mtf.isAligned;
      ab.withoutMtf = { wouldPass: true };
      ab.withMtf = { wouldPass: !hardFail };
      if (hardFail) {
        if (mtfMode === 'hard') {
          gates.mtf = { pass: false, detail: mtf.summary };
          if (!blockedBy) blockedBy = 'mtf';
        } else {
          confidence = Math.max(0, confidence - 12);
          gates.mtf = { pass: true, softPenalty: 12, detail: mtf.summary };
        }
      } else {
        gates.mtf = { pass: true, detail: mtf.summary };
        confidence = Math.min(95, confidence + 5);
      }
    }
  } else {
    gates.mtf = { pass: true, detail: 'off' };
  }

  // Regime: never strong counter-trend on HTF in hard mode
  const r = (regime?.regime || '').toLowerCase();
  const counter = (r === 'bear' && direction === 'long') || (r === 'bull' && direction === 'short');
  const alignedReg = (r === 'bull' && direction === 'long') || (r === 'bear' && direction === 'short');
  ab.withoutRegime = { wouldPass: true };
  if (counter) {
    if ((settings.regimeMode || 'hard') === 'hard' && confluence.tier !== 'ULTRA') {
      gates.regime = { pass: false, detail: `counter-regime ${r}` };
      ab.withRegime = { wouldPass: false };
      if (!blockedBy) blockedBy = 'regime';
    } else {
      confidence = Math.max(0, confidence - 15);
      gates.regime = { pass: true, softPenalty: 15, detail: `counter-regime soft ${r}` };
      ab.withRegime = { wouldPass: true };
    }
  } else {
    if (alignedReg) confidence = Math.min(95, confidence + 5);
    gates.regime = { pass: true, detail: r || 'unknown' };
    ab.withRegime = { wouldPass: true };
  }

  // BTC lead
  if (btcLead?.block && coin !== 'BTC' && direction === btcLead.block) {
    gates.btcLead = { pass: false, detail: btcLead.summary };
    ab.withBtcLead = { wouldPass: false };
    if (!blockedBy) blockedBy = 'btcLead';
  } else {
    gates.btcLead = { pass: true, detail: btcLead?.summary || 'ok' };
    ab.withBtcLead = { wouldPass: true };
  }
  ab.withoutBtcLead = { wouldPass: true };

  // Funding extreme: block SAME-direction crowd chase
  const rate = fundingExtreme?.rate;
  if (rate != null && Math.abs(rate) > 0.08) {
    const chasingCrowd = (rate > 0.08 && direction === 'long') || (rate < -0.08 && direction === 'short');
    ab.withoutFunding = { wouldPass: true };
    ab.withFunding = { wouldPass: !chasingCrowd };
    if (chasingCrowd) {
      gates.funding = { pass: false, detail: `funding chase ${rate}` };
      if (!blockedBy) blockedBy = 'funding';
    } else {
      gates.funding = { pass: true, detail: `fade funding ${rate}` };
      confidence = Math.min(95, confidence + 4);
    }
  } else {
    gates.funding = { pass: true, detail: 'normal' };
    ab.withFunding = { wouldPass: true };
    ab.withoutFunding = { wouldPass: true };
  }

  // Volume/session soft gate
  if (volumeQuality != null && volumeQuality < 0.2) {
    confidence = Math.max(0, confidence - 8);
    gates.volume = { pass: true, softPenalty: 8, detail: 'thin volume/session' };
  } else {
    gates.volume = { pass: true, detail: `volQ=${volumeQuality?.toFixed?.(2) ?? volumeQuality}` };
  }

  // News extreme veto hint (AI still confirms)
  if (newsSentiment?.score != null && Math.abs(newsSentiment.score) >= 8) {
    const newsDir = newsSentiment.score > 0 ? 'long' : 'short';
    if (newsDir !== direction) {
      confidence = Math.max(0, confidence - 10);
      gates.newsConflict = { pass: true, softPenalty: 10, detail: newsSentiment.key_event || 'news conflict' };
    }
  }

  const allPass = Object.values(gates).every(g => g.pass !== false);
  return {
    pass: allPass && !blockedBy,
    blockedBy: allPass ? null : blockedBy,
    confidence: Math.round(confidence),
    gates,
    ab,
    direction,
    tier: confluence.tier,
    setupType: confluence.setupType
  };
}

/** Map expectancy record → size/confidence multiplier */
function expectancyMultiplier(expectancyStore, setupType, coin) {
  const key = `${coin}|${setupType}`;
  const row = expectancyStore?.[key] || expectancyStore?.[setupType];
  if (!row || row.n < 8) return { mult: 1, detail: 'insufficient samples' };
  // Half-Kelly-ish from win rate & avg R
  const wr = row.wins / row.n;
  const avgWin = row.sumWinR / Math.max(row.wins, 1);
  const avgLoss = Math.abs(row.sumLossR) / Math.max(row.losses, 1);
  const exp = wr * avgWin - (1 - wr) * avgLoss;
  if (exp <= 0 || wr < 0.42) return { mult: 0, detail: `dead setup exp=${exp.toFixed(2)} wr=${Math.round(wr * 100)}%`, expectancy: exp, wr };
  if (exp > 0.35 && wr >= 0.58) return { mult: 1.15, detail: `hot setup exp=${exp.toFixed(2)}`, expectancy: exp, wr };
  if (exp > 0.15) return { mult: 1.0, detail: `ok setup exp=${exp.toFixed(2)}`, expectancy: exp, wr };
  return { mult: 0.6, detail: `weak setup exp=${exp.toFixed(2)}`, expectancy: exp, wr };
}

function updateExpectancy(store, { coin, setupType, won, rMultiple }) {
  const next = { ...(store || {}) };
  const keys = [`${coin}|${setupType}`, setupType];
  for (const key of keys) {
    if (!next[key]) next[key] = { n: 0, wins: 0, losses: 0, sumWinR: 0, sumLossR: 0, lastUpdated: 0 };
    const row = next[key];
    row.n++;
    if (won) {
      row.wins++;
      row.sumWinR += Math.abs(rMultiple || 1);
    } else {
      row.losses++;
      row.sumLossR += Math.abs(rMultiple || 1);
    }
    row.lastUpdated = Date.now();
    const wr = row.wins / row.n;
    const avgWin = row.sumWinR / Math.max(row.wins, 1);
    const avgLoss = Math.abs(row.sumLossR) / Math.max(row.losses, 1);
    row.expectancy = parseFloat((wr * avgWin - (1 - wr) * avgLoss).toFixed(4));
    row.winRate = Math.round(wr * 100);
  }
  return next;
}

/**
 * Build scoreboard from structured shadows + paper meta + expectancy store.
 */
function buildScoreboard({ shadows, paperTrades, expectancy, holdoutPct = 0.25 }) {
  const list = (shadows || []).filter(s => s.meta || s.setupType || s.gates);
  const resolved = list.filter(s => s.resolved && (s.outcome === 'would_win' || s.outcome === 'would_lose'));

  // Time holdout: last holdoutPct of resolved by timestamp = out-of-sample
  const sorted = [...resolved].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const split = Math.floor(sorted.length * (1 - holdoutPct));
  const inSample = sorted.slice(0, split);
  const holdout = sorted.slice(split);

  const bucket = (arr, keyFn) => {
    const m = {};
    for (const s of arr) {
      const k = keyFn(s);
      if (!m[k]) m[k] = { n: 0, wins: 0, losses: 0 };
      m[k].n++;
      if (s.outcome === 'would_win') m[k].wins++;
      else m[k].losses++;
    }
    return Object.entries(m).map(([k, v]) => ({
      key: k,
      n: v.n,
      winRate: v.n ? Math.round((v.wins / v.n) * 100) : null,
      wins: v.wins,
      losses: v.losses
    })).sort((a, b) => b.n - a.n);
  };

  // Feature A/B: for each gate, compare outcomes where withX.wouldPass vs without
  const featureAB = {};
  for (const feat of ['mtf', 'funding', 'regime', 'btcLead', 'confluence']) {
    const withKey = feat === 'confluence' ? 'withoutConfluenceGate' : `with${feat[0].toUpperCase()}${feat.slice(1)}`;
    // Normalize ab keys from applyPrecisionGates
    const map = {
      mtf: ['withMtf', 'withoutMtf'],
      funding: ['withFunding', 'withoutFunding'],
      regime: ['withRegime', 'withoutRegime'],
      btcLead: ['withBtcLead', 'withoutBtcLead'],
      confluence: ['withoutConfluenceGate', null]
    };
    const [withK, withoutK] = map[feat];
    const sample = resolved.filter(s => s.ab && (s.ab[withK] || s.ab[withoutK]));
    if (sample.length < 5) {
      featureAB[feat] = { n: sample.length, status: 'need_more_data' };
      continue;
    }
    // Proxy: blocked by this gate → outcome was would_lose = good block
    const blocked = resolved.filter(s => s.blockedBy === feat || s.reason?.includes?.(feat));
    const goodBlocks = blocked.filter(s => s.outcome === 'would_lose').length;
    const badBlocks = blocked.filter(s => s.outcome === 'would_win').length;
    featureAB[feat] = {
      n: blocked.length,
      goodBlocks,
      badBlocks,
      precision: blocked.length ? Math.round((goodBlocks / blocked.length) * 100) : null,
      status: blocked.length >= 10 ? (goodBlocks >= badBlocks ? 'keep' : 'review') : 'collecting'
    };
  }

  const paper = (paperTrades || []).filter(t => t.setupType && t.status !== 'open');
  const paperBySetup = {};
  for (const t of paper) {
    const k = t.setupType;
    if (!paperBySetup[k]) paperBySetup[k] = { n: 0, wins: 0, pnl: 0 };
    paperBySetup[k].n++;
    if ((t.pnl || 0) > 0) paperBySetup[k].wins++;
    paperBySetup[k].pnl += t.pnl || 0;
  }

  const expectancyRows = Object.entries(expectancy || {})
    .map(([k, v]) => ({ key: k, ...v }))
    .filter(r => r.n >= 3)
    .sort((a, b) => (b.expectancy || 0) - (a.expectancy || 0));

  return {
    totals: {
      structuredShadows: list.length,
      resolved: resolved.length,
      inSample: inSample.length,
      holdout: holdout.length,
      holdoutWinRate: holdout.length
        ? Math.round((holdout.filter(s => s.outcome === 'would_win').length / holdout.length) * 100)
        : null,
      inSampleWinRate: inSample.length
        ? Math.round((inSample.filter(s => s.outcome === 'would_win').length / inSample.length) * 100)
        : null
    },
    bySetup: bucket(resolved, s => s.setupType || s.meta?.setupType || 'unknown'),
    byTier: bucket(resolved, s => s.tier || s.meta?.tier || 'unknown'),
    byRegime: bucket(resolved, s => s.regime || s.meta?.regime || 'unknown'),
    byBlockedBy: bucket(resolved.filter(s => s.blockedBy), s => s.blockedBy),
    featureAB,
    paperBySetup: Object.entries(paperBySetup).map(([k, v]) => ({
      key: k, n: v.n, winRate: Math.round((v.wins / v.n) * 100), pnl: Math.round(v.pnl * 100) / 100
    })).sort((a, b) => b.n - a.n),
    expectancy: expectancyRows.slice(0, 30),
    recent: list.slice(-15).reverse()
  };
}

function buildAiValidationPrompt({ coin, direction, entry, target, stopLoss, confluence, gates, news, regime, funding, reasonBits }) {
  return `You are a TRADE VALIDATOR, not a signal generator.
A math-based scanner already decided: ${direction?.toUpperCase()} ${coin}.
Your ONLY job: CONFIRM or VETO. Do not invent a new direction.

MATH SIGNAL:
- Tier: ${confluence.tier} | Score: ${confluence.score}
- Setup: ${confluence.setupType}
- Independent axes agreeing: ${(confluence.agreeing || []).join(', ')}
- Gates: ${JSON.stringify(gates, null, 0).slice(0, 500)}
- Regime: ${regime?.summary || '?'}
- Funding: ${funding || '?'}
- News/context: ${typeof news === 'string' ? news.slice(0, 280) : JSON.stringify(news || {}).slice(0, 280)}
- Notes: ${reasonBits || ''}

Proposed: entry ${entry}, target ${target}, stop ${stopLoss}

Veto if: major news/event risk in next few hours, math clearly broken vs data, or liquidity event.
Confirm if: math is coherent and no critical context risk.

JSON only:
{"veto":true/false,"confidenceAdjust":-10..10,"reason":"under 20 words"}`;
}

module.exports = {
  TIERS,
  TIER_MIN_SCORE,
  AXES,
  computeConfluence,
  analyzeMultiTimeframe,
  applyPrecisionGates,
  expectancyMultiplier,
  updateExpectancy,
  buildScoreboard,
  buildAiValidationPrompt,
  classifySetup
};
