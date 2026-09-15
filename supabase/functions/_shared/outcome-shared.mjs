/// <reference types="./outcome-shared.d.mts" /> // GENERATED from packages/shared/src — do not edit. Rebuild: npm run bundle:shared

// src/types.ts
var SIGNAL_LABELS = {
  micro: "Market activity",
  news: "News",
  base: "Track record"
};
var SIGNAL_KEYS = ["micro", "news", "base"];

// src/money.ts
var PAYOUT_PER_CONTRACT_CENTS = 100;
var DEFAULT_FEE_RATE = 0.2;
function roundCents(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
function stakeCents(priceCents, contracts) {
  return roundCents(priceCents * contracts);
}
function sidePriceCents(yesPriceCents, side) {
  return side === "YES" ? yesPriceCents : PAYOUT_PER_CONTRACT_CENTS - yesPriceCents;
}
function payoutCents(contracts) {
  return contracts * PAYOUT_PER_CONTRACT_CENTS;
}
function profitIfWinCents(priceCents, contracts) {
  return payoutCents(contracts) - stakeCents(priceCents, contracts);
}
function realizedPnlCents(priceCents, contracts, won) {
  const stake = stakeCents(priceCents, contracts);
  return won ? payoutCents(contracts) - stake : -stake;
}
function unrealizedPnlCents(entryPriceCents, currentSidePriceCents, contracts) {
  return roundCents((currentSidePriceCents - entryPriceCents) * contracts);
}
function feeOnNetPnlCents(netPnlCents, feeRate) {
  if (!(feeRate >= 0)) throw new Error(`invalid feeRate: ${feeRate}`);
  return roundCents(Math.max(0, netPnlCents) * feeRate);
}
function periodTotals(pnls, feeRate) {
  let grossWins = 0;
  let grossLosses = 0;
  for (const pnl of pnls) {
    if (pnl >= 0) grossWins += pnl;
    else grossLosses += -pnl;
  }
  const netPnl = grossWins - grossLosses;
  return {
    grossWins,
    grossLosses,
    netPnl,
    feeOwed: feeOnNetPnlCents(netPnl, feeRate)
  };
}
function allocateSettlementCents(totalCents, contractsPerTrade) {
  if (contractsPerTrade.length === 0) return [];
  const totalContracts = contractsPerTrade.reduce((sum, c) => sum + c, 0);
  if (totalContracts <= 0) {
    throw new Error("cannot allocate a settlement across zero contracts");
  }
  const out = [];
  let allocated = 0;
  for (let i = 0; i < contractsPerTrade.length; i++) {
    if (i === contractsPerTrade.length - 1) {
      out.push(totalCents - allocated);
      break;
    }
    const share = roundCents(totalCents * contractsPerTrade[i] / totalContracts);
    allocated += share;
    out.push(share);
  }
  return out;
}
function quoteStake(params) {
  const { priceCents, contracts, mode, feeRate } = params;
  const stake = stakeCents(priceCents, contracts);
  const payout = payoutCents(contracts);
  const profitIfWin = payout - stake;
  const estimatedFee = mode === "live" ? feeOnNetPnlCents(profitIfWin, feeRate) : 0;
  return {
    mode,
    priceCents,
    contracts,
    stake,
    payout,
    profitIfWin,
    estimatedFee,
    youdKeep: profitIfWin - estimatedFee
  };
}
function formatUsd(cents, opts = {}) {
  const decimals = opts.decimals ?? 2;
  const negative = cents < 0;
  const abs = Math.abs(cents) / 100;
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const sign = negative ? "-" : opts.signed ? "+" : "";
  return `${sign}$${body}`;
}
function formatPriceCents(cents) {
  return `${Math.round(cents)}\xA2`;
}
var KALSHI_FEE_RATE = 0.07;
function kalshiFeeCents(priceCents, contracts = 1) {
  const p = priceCents / 100;
  return Math.ceil(KALSHI_FEE_RATE * contracts * p * (1 - p) * 100);
}
function netIfHitCents(priceCents) {
  return PAYOUT_PER_CONTRACT_CENTS - priceCents - kalshiFeeCents(priceCents);
}
function netIfMissCents(priceCents) {
  return -priceCents - kalshiFeeCents(priceCents);
}
function breakevenHitRate(priceCents) {
  return (priceCents + kalshiFeeCents(priceCents)) / PAYOUT_PER_CONTRACT_CENTS;
}
function expectedNetCents(priceCents, hitRate) {
  return hitRate * netIfHitCents(priceCents) + (1 - hitRate) * netIfMissCents(priceCents);
}

// src/score.ts
var SCORE_MIN = 1;
var SCORE_MAX = 10;
function scoreBand(score) {
  if (score >= 7) return "strong";
  if (score >= 4.5) return "moderate";
  return "weak";
}
function formatScore(score) {
  return score.toFixed(1);
}
function roundScore(score) {
  return Math.round(score * 10) / 10;
}
function clampScore(score) {
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
}
function weightsForCategory(config, category) {
  if (category && config.overrides && config.overrides[category]) {
    return config.overrides[category];
  }
  return config.default;
}
function hasOverride(config, category) {
  return Boolean(config.overrides && config.overrides[category]);
}
function activeWeights(weights, disabled) {
  const live = SIGNAL_KEYS.filter((k) => !disabled.includes(k));
  if (live.length === 0) return null;
  const originalTotal = SIGNAL_KEYS.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
  const liveTotal = live.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
  if (liveTotal <= 0) return null;
  const scale = originalTotal / liveTotal;
  const out = { micro: 0, news: 0, base: 0 };
  for (const k of live) out[k] = (weights[k] ?? 0) * scale;
  return out;
}
function combineSignals(subScores, weights) {
  const total = SIGNAL_KEYS.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
  if (total <= 0) {
    return { score: SCORE_MIN, breakdown: { micro: 0, news: 0, base: 0 } };
  }
  const breakdown = { micro: 0, news: 0, base: 0 };
  let raw = 0;
  for (const k of SIGNAL_KEYS) {
    const contribution = (weights[k] ?? 0) / total * (subScores[k] ?? 0);
    breakdown[k] = roundScore(contribution);
    raw += contribution;
  }
  return { score: roundScore(clampScore(raw)), breakdown };
}
function pickSide(yesScore, noScore) {
  return noScore > yesScore ? "NO" : "YES";
}
function surfaces(score, surfaceThreshold) {
  return score >= surfaceThreshold;
}
function isStrongPick(score, strongThreshold) {
  return score >= strongThreshold;
}
var MATERIAL_SCORE_DELTA = 0.5;
function scoreChangedMaterially(before, after) {
  return Math.abs(after - before) >= MATERIAL_SCORE_DELTA;
}
function retuneRecommendation(newScore, strongThreshold) {
  if (newScore >= strongThreshold) return "hold";
  if (newScore >= 4.5) return "review";
  return "consider_exit";
}

// src/theme.ts
var COLORS = {
  bg: "#F1F3F5",
  surface: "#FFFFFF",
  surfaceMuted: "#F7F8FA",
  border: "#E3E6EA",
  text: "#161B22",
  muted: "#69707C",
  faint: "#9AA1AC",
  green: "#1FBE87",
  greenDark: "#149A6D",
  blue: "#3E7BFA",
  red: "#E2544F",
  gold: "#DE9F35",
  purple: "#8B6FD8"
};
var GRADIENT_STOPS = [COLORS.blue, COLORS.green];
var GRADIENT_CSS = `linear-gradient(100deg, ${COLORS.blue} 0%, ${COLORS.green} 100%)`;
var SIGNAL_COLORS = {
  micro: COLORS.green,
  news: COLORS.blue,
  base: COLORS.purple
};
var BAND_COLORS = {
  strong: COLORS.green,
  moderate: COLORS.gold,
  weak: COLORS.red
};
var SEVERITY_COLORS = {
  info: COLORS.blue,
  caution: COLORS.gold
};
var FONTS = {
  sans: "Inter",
  mono: "JetBrains Mono"
};

// src/fit.ts
var FEATURE_NAMES = ["bias", "micro", "news", "base", "price"];
function features(c) {
  return [1, c.subs.micro / 10, c.subs.news / 10, c.subs.base / 10, (c.price - 50) / 50];
}
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}
function fitLogistic(X, y, opts = {}) {
  const l2 = opts.l2 ?? 0.01;
  const iterations = opts.iterations ?? 800;
  const lr = opts.learningRate ?? 0.3;
  const n = X.length;
  if (n === 0) return [];
  const d = X[0].length;
  const w = new Array(d).fill(0);
  for (let it = 0; it < iterations; it++) {
    const grad = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * xi[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) grad[j] += err * xi[j];
    }
    for (let j = 0; j < d; j++) {
      const reg = j === 0 ? 0 : l2 * w[j];
      w[j] = w[j] - lr * (grad[j] / n + reg);
    }
  }
  return w;
}
function predictProb(w, x) {
  let z = 0;
  for (let j = 0; j < w.length; j++) z += w[j] * x[j];
  return sigmoid(z);
}
function evaluatePolicy(rows, take) {
  let taken = 0, hits = 0, total = 0;
  rows.forEach((c, i) => {
    if (!take(c, i)) return;
    taken++;
    if (c.hit) {
      hits++;
      total += netIfHitCents(c.price);
    } else {
      total += netIfMissCents(c.price);
    }
  });
  return { taken, hits, netPerContractCents: taken ? total / taken : 0, totalNetCents: total };
}
function walkForward(calls, opts) {
  const folds = Math.max(2, opts.folds ?? 5);
  const margin = opts.margin ?? 0.02;
  const sorted = [...calls].sort((a, b) => a.at.localeCompare(b.at));
  const n = sorted.length;
  const size = Math.floor(n / folds);
  const oosRows = [];
  const oosProb = [];
  const oosBase = [];
  let lastW = [];
  for (let k = 1; k < folds; k++) {
    const train = sorted.slice(0, k * size);
    const test = k === folds - 1 ? sorted.slice(k * size) : sorted.slice(k * size, (k + 1) * size);
    if (train.length === 0 || test.length === 0) continue;
    const w = fitLogistic(train.map(features), train.map((c) => c.hit ? 1 : 0), opts);
    lastW = w;
    const base = train.filter((c) => c.hit).length / train.length;
    for (const c of test) {
      oosRows.push(c);
      oosProb.push(predictProb(w, features(c)));
      oosBase.push(base);
    }
  }
  const brier = (p) => oosRows.length ? p.reduce((s, pi, i) => s + (pi - (oosRows[i].hit ? 1 : 0)) ** 2, 0) / oosRows.length : NaN;
  const coefficients = Object.fromEntries(
    FEATURE_NAMES.map((name, j) => [name, Number((lastW[j] ?? 0).toFixed(4))])
  );
  return {
    rows: n,
    folds,
    holdout: oosRows.length,
    fittedBrier: Number(brier(oosProb).toFixed(4)),
    baseRateBrier: Number(brier(oosBase).toFixed(4)),
    coefficients,
    fittedPolicy: evaluatePolicy(oosRows, (c, i) => oosProb[i] >= breakevenHitRate(c.price) + margin),
    livePolicy: evaluatePolicy(oosRows, (c) => c.score >= opts.liveSurface),
    takeAll: evaluatePolicy(oosRows, () => true)
  };
}
function impliedBlendWeights(coefficients) {
  const raw = {
    micro: Math.max(0, coefficients.micro),
    news: Math.max(0, coefficients.news),
    base: Math.max(0, coefficients.base)
  };
  const total = raw.micro + raw.news + raw.base;
  if (total <= 0) return null;
  return {
    micro: Number((raw.micro / total).toFixed(3)),
    news: Number((raw.news / total).toFixed(3)),
    base: Number((raw.base / total).toFixed(3))
  };
}
export {
  BAND_COLORS,
  COLORS,
  DEFAULT_FEE_RATE,
  FEATURE_NAMES,
  FONTS,
  GRADIENT_CSS,
  GRADIENT_STOPS,
  KALSHI_FEE_RATE,
  MATERIAL_SCORE_DELTA,
  PAYOUT_PER_CONTRACT_CENTS,
  SCORE_MAX,
  SCORE_MIN,
  SEVERITY_COLORS,
  SIGNAL_COLORS,
  SIGNAL_KEYS,
  SIGNAL_LABELS,
  activeWeights,
  allocateSettlementCents,
  breakevenHitRate,
  clampScore,
  combineSignals,
  expectedNetCents,
  features,
  feeOnNetPnlCents,
  fitLogistic,
  formatPriceCents,
  formatScore,
  formatUsd,
  hasOverride,
  impliedBlendWeights,
  isStrongPick,
  kalshiFeeCents,
  netIfHitCents,
  netIfMissCents,
  payoutCents,
  periodTotals,
  pickSide,
  predictProb,
  profitIfWinCents,
  quoteStake,
  realizedPnlCents,
  retuneRecommendation,
  roundCents,
  roundScore,
  scoreBand,
  scoreChangedMaterially,
  sidePriceCents,
  stakeCents,
  surfaces,
  unrealizedPnlCents,
  walkForward,
  weightsForCategory
};
