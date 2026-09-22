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

// src/news-rss.ts
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#34": '"',
  "#8217": "\u2019",
  "#8216": "\u2018",
  "#8220": "\u201C",
  "#8221": "\u201D"
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith("#")) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}
function cleanText(raw) {
  if (!raw) return "";
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/<[^>]+>/g, " ");
  return s.replace(/\s+/g, " ").trim();
}
function tagContent(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  return m ? m[1] : void 0;
}
function atomLink(block) {
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback;
  for (const l of links) {
    const href = /href\s*=\s*"([^"]+)"/i.exec(l)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*"([^"]+)"/i.exec(l)?.[1]?.toLowerCase();
    if (!rel || rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}
function parseDate(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  if (t < Date.UTC(2e3, 0, 1) || t > Date.now() + 2 * 864e5) return null;
  return new Date(t).toISOString();
}
function parseFeed(xml) {
  if (!xml || typeof xml !== "string") return [];
  const isAtom = /<feed\b[^>]*xmlns\s*=\s*"http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml) || !/<item\b/i.test(xml) && /<entry\b/i.test(xml);
  const blockRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const out = [];
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const title = cleanText(tagContent(block, "title"));
    if (!title) continue;
    let url;
    if (isAtom) {
      url = atomLink(block);
    } else {
      url = cleanText(tagContent(block, "link")) || void 0;
      if (!url) {
        const guid = tagContent(block, "guid");
        const permalink = /isPermaLink\s*=\s*"false"/i.test(/<guid[^>]*>/i.exec(block)?.[0] ?? "");
        const g = cleanText(guid);
        if (g && !permalink && /^https?:\/\//i.test(g)) url = g;
      }
    }
    if (url && !/^https?:\/\//i.test(url)) url = void 0;
    const summary = cleanText(
      tagContent(block, "description") ?? tagContent(block, "summary") ?? tagContent(block, "content:encoded") ?? tagContent(block, "content")
    ).slice(0, 400);
    const publishedAt = parseDate(
      tagContent(block, "pubDate") ?? tagContent(block, "published") ?? tagContent(block, "updated") ?? tagContent(block, "dc:date")
    );
    out.push({ title: title.slice(0, 300), url: url ?? null, summary, publishedAt });
  }
  return out;
}
var STOP = /* @__PURE__ */ new Set([
  "will",
  "the",
  "a",
  "an",
  "be",
  "is",
  "are",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "and",
  "or",
  "above",
  "below",
  "before",
  "after",
  "than",
  "this",
  "that",
  "it",
  "its",
  "come",
  "more",
  "less",
  "least",
  "most",
  "any",
  "have",
  "has",
  "do",
  "does",
  "if",
  "when",
  "what",
  "which",
  "who",
  "yes",
  "no",
  "with",
  "from",
  "over",
  "under",
  "between",
  "into",
  "out",
  "up",
  "down",
  "win",
  "wins",
  "reach",
  "hit",
  "end",
  "close",
  "open",
  "high",
  "low",
  "temperature",
  "temp",
  "game",
  "match",
  "season",
  "week",
  "day",
  "today",
  "tomorrow",
  "price",
  "closing",
  "ends",
  "total",
  "points",
  "point",
  "against",
  "vs",
  "first",
  "last",
  "new",
  "next",
  "get",
  "go",
  "make",
  "made",
  "per",
  "via",
  "about",
  "his",
  "her",
  "their"
]);
var CALENDAR = /* @__PURE__ */ new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "am",
  "pm",
  "et",
  "est",
  "edt",
  "pt",
  "pst",
  "pdt",
  "ct",
  "cst",
  "cdt",
  "utc"
]);
function tokenize(text) {
  return text.replace(/[‘’']/g, "").split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
}
function tokenSet(text) {
  return new Set(tokenize(text).map((w) => w.toLowerCase()));
}
function marketTerms(id, question, category) {
  const raw = question.replace(/[‘’']/g, "").split(/[^A-Za-z0-9$%.,-]+/).filter(Boolean);
  const subject = [];
  const other = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i].replace(/^[$.,-]+|[.,-]+$/g, "");
    if (!word || /\d/.test(word)) continue;
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOP.has(lower) || CALENDAR.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    const capitalised = /^[A-Z]/.test(word) && i > 0;
    if (capitalised) subject.push(lower);
    else if (lower.length >= 4) other.push(lower);
  }
  const subj = subject.slice(0, 3);
  const all = [...subj, ...other].slice(0, 8);
  return { id, subject: subj, all: all.length ? all : tokenize(category).map((w) => w.toLowerCase()) };
}
function matchesTerms(tokens, t) {
  if (t.subject.length > 0) {
    for (const s of t.subject) if (!tokens.has(s)) return false;
    return true;
  }
  let hits = 0;
  for (const w of t.all) if (tokens.has(w)) hits++;
  return hits >= 2;
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
  cleanText,
  combineSignals,
  decodeEntities,
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
  marketTerms,
  matchesTerms,
  netIfHitCents,
  netIfMissCents,
  parseFeed,
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
  tokenSet,
  tokenize,
  unrealizedPnlCents,
  walkForward,
  weightsForCategory
};
