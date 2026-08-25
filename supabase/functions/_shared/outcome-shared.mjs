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
export {
  BAND_COLORS,
  COLORS,
  DEFAULT_FEE_RATE,
  FONTS,
  GRADIENT_CSS,
  GRADIENT_STOPS,
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
  clampScore,
  combineSignals,
  feeOnNetPnlCents,
  formatPriceCents,
  formatScore,
  formatUsd,
  hasOverride,
  isStrongPick,
  payoutCents,
  periodTotals,
  pickSide,
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
  weightsForCategory
};
