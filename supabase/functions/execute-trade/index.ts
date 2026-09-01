/**
 * Trade execution — invoked from the member app.
 *
 * This is the only path that creates a `trades` row; there is no member-facing
 * INSERT policy on that table, so every trade necessarily passes the checks
 * below. Ordering matters: the cheap global gates come first, then per-user
 * state, then the Kalshi round trip, so a paused platform never spends an API
 * call and a member never gets a filled order they were not allowed to place.
 *
 * Failure is explicit. A live order that does not confirm leaves the trade in
 * 'pending' or 'failed' with a reason attached, and the caller is told. A
 * trade must never be silently swallowed — the member's money is at stake and
 * a missing position is worse than an error message.
 */

import {
  badRequest,
  forbidden,
  handler,
  HttpError,
  json,
  readJson,
  requireUser,
  serviceClient,
} from '../_shared/http.ts';
import { createOrder, getBalance, getOrder, KalshiError } from '../_shared/kalshi.ts';
import { loadKalshiCredentials } from '../_shared/vault.ts';
import { logActivity, logPlatformFlow, notify, notifyAdmins } from '../_shared/log.ts';
import { sidePriceCents, stakeCents } from '../_shared/outcome-shared.mjs';
import type { RiskLimits, Side, TradeMode } from '../_shared/outcome-shared.mjs';

interface TradeRequest {
  marketId: string;
  mode: TradeMode;
  contracts: number;
  /**
   * The side price in cents the member was quoted. Acts as a limit: if the
   * market has moved beyond `maxSlippageCents`, the trade is refused rather
   * than filled at a price the stake card never showed them.
   */
  quotedPriceCents: number;
  maxSlippageCents?: number;
}

const DEFAULT_MAX_SLIPPAGE = 3;

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') badRequest('POST only');

  const db = serviceClient();
  const user = await requireUser(req, db);
  const body = await readJson<TradeRequest>(req);

  // ---- shape -------------------------------------------------------------
  if (!body.marketId) badRequest('marketId is required');
  if (body.mode !== 'paper' && body.mode !== 'live') badRequest('mode must be paper or live');
  if (!Number.isInteger(body.contracts) || body.contracts <= 0) {
    badRequest('contracts must be a positive integer');
  }
  if (!Number.isFinite(body.quotedPriceCents)) badRequest('quotedPriceCents is required');

  const mode: TradeMode = body.mode;
  const slippage = body.maxSlippageCents ?? DEFAULT_MAX_SLIPPAGE;

  // ---- global gates ------------------------------------------------------
  const { data: settingsRows } = await db
    .from('platform_settings')
    .select('key, value')
    .in('key', ['kill_switch', 'trading_paused', 'max_exposure_per_market_cents', 'locked_categories']);

  const settings = new Map(
    (settingsRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]),
  );

  // The kill switch stops ALL platform trading, paper included: if the model
  // or the data feed is compromised, practice trades on bad scores are still
  // teaching members the wrong thing.
  if (settings.get('kill_switch') === true) {
    forbidden('Trading is halted platform-wide.', 'kill_switch');
  }
  if (mode === 'live' && settings.get('trading_paused') === true) {
    forbidden('Live trading is paused. Paper mode is still available.', 'trading_paused');
  }

  // ---- account state -----------------------------------------------------
  if (!['active', 'inactive'].includes(user.account_status)) {
    forbidden(
      user.account_status === 'grace'
        ? 'Your last payment failed. Update your card to resume trading.'
        : 'Your account is paused.',
      user.account_status,
    );
  }

  // A live trade creates a billable obligation, so a card has to be on file
  // BEFORE it is opened. The member app blocks this too, but client-side
  // enforcement of a money rule is not enforcement: without this check,
  // anyone calling the endpoint directly could trade live all month and leave
  // nothing to charge when the period closes.
  if (mode === 'live') {
    const { data: card, error: pmErr } = await db
      .from('payment_methods')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (pmErr) throw new Error(`payment method lookup failed: ${pmErr.message}`);
    if (!card) {
      forbidden('Add a payment method to trade live.', 'no_payment_method');
    }
  }

  // ---- market + current score -------------------------------------------
  const { data: market, error: mErr } = await db
    .from('markets')
    .select('id, question, category, resolved_at, close_time')
    .eq('id', body.marketId)
    .maybeSingle();

  if (mErr) throw new Error(`market lookup failed: ${mErr.message}`);
  if (!market) badRequest('unknown market');
  if (market.resolved_at) badRequest('market has already resolved');
  if (market.close_time && new Date(market.close_time) <= new Date()) {
    badRequest('market has closed');
  }

  const locked = (settings.get('locked_categories') ?? []) as string[];
  if (Array.isArray(locked) && locked.includes(market.category)) {
    forbidden(`${market.category} markets are locked by the admin.`, 'category_locked');
  }

  // The score the member acts on is the one from THEIR effective model
  // version, which during a transition window may not be the newest stable.
  const { data: effectiveVersion, error: evErr } = await db.rpc('effective_version_for', {
    p_user: user.id,
  });
  if (evErr || !effectiveVersion) throw new Error('could not resolve a model version');

  const { data: score, error: sErr } = await db
    .from('latest_scores')
    .select('side, score, model_version_id')
    .eq('market_id', market.id)
    .eq('model_version_id', effectiveVersion)
    .maybeSingle();

  if (sErr) throw new Error(`score lookup failed: ${sErr.message}`);
  if (!score) badRequest('this market is not currently scored', 'no_score');

  const side = score.side as Side;

  // ---- price check -------------------------------------------------------
  const { data: snap } = await db
    .from('latest_snapshots')
    .select('price, ts')
    .eq('market_id', market.id)
    .maybeSingle();

  if (!snap) badRequest('no current price for this market', 'no_price');

  const currentPrice = sidePriceCents(snap.price, side);
  if (currentPrice < 1 || currentPrice > 99) {
    badRequest('market is not tradeable at the current price', 'untradeable');
  }

  const drift = Math.abs(currentPrice - body.quotedPriceCents);
  if (drift > slippage) {
    badRequest(
      `Price moved from ${body.quotedPriceCents}¢ to ${currentPrice}¢. Review and try again.`,
      'price_moved',
    );
  }

  const stake = stakeCents(currentPrice, body.contracts);

  // ---- risk limits -------------------------------------------------------
  const { data: mv } = await db
    .from('model_versions')
    .select('risk_limits')
    .eq('id', effectiveVersion)
    .single();

  const limits = (mv?.risk_limits ?? {}) as Partial<RiskLimits>;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const { data: todaysTrades } = await db
    .from('trades')
    .select('id, market_id, stake_cents, opened_at')
    .eq('user_id', user.id)
    .eq('mode', mode)
    .gte('opened_at', dayStart.toISOString())
    .neq('status', 'failed');

  const today = todaysTrades ?? [];

  if (limits.maxTradesPerDay && today.length >= limits.maxTradesPerDay) {
    forbidden(
      `Daily limit reached (${limits.maxTradesPerDay} trades).`,
      'max_trades_per_day',
    );
  }

  const perMarketCap = Number(
    limits.maxExposurePerMarketCents ?? settings.get('max_exposure_per_market_cents') ?? 0,
  );
  if (perMarketCap > 0) {
    const existing = today
      .filter((t: { market_id: string }) => t.market_id === market.id)
      .reduce((sum: number, t: { stake_cents: number }) => sum + t.stake_cents, 0);
    if (existing + stake > perMarketCap) {
      forbidden(
        `This would exceed the per-market cap of $${(perMarketCap / 100).toFixed(2)}.`,
        'market_exposure',
      );
    }
  }

  // Realised losses today, and the cooldown after the most recent one. Both
  // read resolutions rather than open positions: an unrealised drawdown is not
  // a loss yet, and treating it as one would lock members out on noise.
  const { data: todaysResolutions } = await db
    .from('resolved_positions')
    .select('pnl, resolved_at')
    .eq('user_id', user.id)
    .eq('mode', mode)
    .gte('resolved_at', dayStart.toISOString());

  const losses = (todaysResolutions ?? []).filter((r: { pnl: number }) => r.pnl < 0);
  const lossTotal = losses.reduce((s: number, r: { pnl: number }) => s + -r.pnl, 0);

  if (limits.dailyLossLimitCents && lossTotal >= limits.dailyLossLimitCents) {
    forbidden(
      `Daily loss limit of $${(limits.dailyLossLimitCents / 100).toFixed(2)} reached.`,
      'daily_loss_limit',
    );
  }

  if (limits.cooldownAfterLossMinutes && losses.length > 0) {
    const lastLoss = losses
      .map((r: { resolved_at: string }) => new Date(r.resolved_at).getTime())
      .sort((a: number, b: number) => b - a)[0]!;
    const readyAt = lastLoss + limits.cooldownAfterLossMinutes * 60_000;
    if (Date.now() < readyAt) {
      const mins = Math.ceil((readyAt - Date.now()) / 60_000);
      forbidden(`Cooling off after a loss — ${mins} min remaining.`, 'cooldown');
    }
  }

  // ---- the trade row -----------------------------------------------------
  // Written BEFORE any Kalshi call so a fill can never exist without a record
  // of it. Status starts 'pending' and only becomes 'open' on confirmation.
  const { data: trade, error: tErr } = await db
    .from('trades')
    .insert({
      user_id: user.id,
      market_id: market.id,
      model_version_id: effectiveVersion,
      mode,
      side,
      entry_price: currentPrice,
      contracts: body.contracts,
      entry_score: score.score,
      stake_cents: stake,
      status: mode === 'paper' ? 'open' : 'pending',
      confirmed_at: mode === 'paper' ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (tErr || !trade) throw new Error(`could not record trade: ${tErr?.message}`);

  await db.rpc('ensure_open_billing_period', { p_user: user.id });

  // ---- paper stops here --------------------------------------------------
  if (mode === 'paper') {
    await logPlatformFlow(db, {
      marketId: market.id,
      tradeId: trade.id,
      userId: user.id,
      side,
      contracts: body.contracts,
      price: currentPrice,
      mode: 'paper',
    });

    await logActivity(db, {
      userId: user.id,
      type: 'trade.opened',
      detail: `Paper: ${side} ${body.contracts} @ ${currentPrice}¢ — ${market.question}`,
      metadata: { trade_id: trade.id, mode, market_id: market.id },
    });
    return json({ ok: true, trade, mode: 'paper' });
  }

  // ---- live: credentials, balance, order ---------------------------------
  const fail = async (reason: string, code: string, status = 400): Promise<never> => {
    await db
      .from('trades')
      .update({ status: 'failed', failure_reason: reason })
      .eq('id', trade.id);
    await logActivity(db, {
      userId: user.id,
      type: 'trade.failed',
      detail: reason,
      metadata: { trade_id: trade.id, code, market_id: market.id },
    });
    throw new HttpError(status, reason, code);
  };

  const creds = await loadKalshiCredentials(db, user.id);
  if (!creds) await fail('Connect your Kalshi account before trading live.', 'no_connection', 403);

  let balanceCents: number;
  try {
    balanceCents = (await getBalance(creds!)).balance;
  } catch (err) {
    if (err instanceof KalshiError && err.status === 401) {
      await db
        .from('kalshi_connections')
        .update({ status: 'error', last_error: 'authentication rejected' })
        .eq('user_id', user.id);
      await fail('Kalshi rejected your API key. Reconnect your account.', 'auth_failed', 403);
    }
    await fail(
      `Could not reach Kalshi: ${err instanceof Error ? err.message : 'unknown error'}`,
      'kalshi_unreachable',
      502,
    );
    throw err; // unreachable; satisfies the type checker
  }

  if (stake > balanceCents) {
    await fail(
      `Not enough in your Kalshi account. This costs $${(stake / 100).toFixed(2)}, you have $${(balanceCents / 100).toFixed(2)}.`,
      'insufficient_balance',
    );
  }

  // The trade id doubles as the Kalshi client_order_id, which makes the order
  // idempotent on Kalshi's side: a retried request cannot double-fill.
  let order;
  try {
    const res = await createOrder(creds!, {
      ticker: market.id,
      side: side === 'YES' ? 'yes' : 'no',
      count: body.contracts,
      priceCents: currentPrice,
      clientOrderId: trade.id,
    });
    order = res.order;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await notifyAdmins(db, {
      type: 'execution.failed',
      title: 'Order rejected by Kalshi',
      body: `${user.email}: ${message}`,
      payload: { trade_id: trade.id, market_id: market.id },
    });
    await fail(`Kalshi rejected the order: ${message}`, 'order_rejected', 502);
    throw err;
  }

  // ---- confirm the fill ---------------------------------------------------
  let filled = order.taker_fill_count ?? 0;
  let orderStatus = order.status;

  // A resting limit order is not a position yet. Give it a moment to cross,
  // then take whatever it actually filled.
  if (filled === 0 && orderStatus !== 'canceled') {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const check = await getOrder(creds!, order.order_id);
      filled = check.order.taker_fill_count ?? 0;
      orderStatus = check.order.status;
    } catch (err) {
      console.warn('order re-check failed:', err instanceof Error ? err.message : err);
    }
  }

  if (filled === 0) {
    await db
      .from('trades')
      .update({
        status: 'failed',
        kalshi_order_id: order.order_id,
        failure_reason: `Order did not fill (status: ${orderStatus}).`,
      })
      .eq('id', trade.id);

    await logActivity(db, {
      userId: user.id,
      type: 'trade.failed',
      detail: `Order ${order.order_id} did not fill`,
      metadata: { trade_id: trade.id, kalshi_order_id: order.order_id, status: orderStatus },
    });

    throw new HttpError(
      409,
      'Your order did not fill at that price and has been cancelled. Nothing was charged.',
      'no_fill',
    );
  }

  // A partial fill is a real position for the quantity that FILLED, not the
  // quantity requested. This update is the last moment the fill details can be
  // written — the database freezes them as the trade leaves 'pending' — so the
  // numbers recorded here are the ones the member is held to forever.
  const partial = filled < body.contracts;
  const actualStake = order.taker_fill_cost ?? stakeCents(currentPrice, filled);

  const { data: confirmed, error: cErr } = await db
    .from('trades')
    .update({
      status: 'open',
      contracts: filled,
      stake_cents: actualStake,
      kalshi_order_id: order.order_id,
      confirmed_at: new Date().toISOString(),
      failure_reason: partial
        ? `Partially filled: ${filled} of ${body.contracts} contracts.`
        : null,
    })
    .eq('id', trade.id)
    .select()
    .single();

  if (cErr) {
    // The order filled but the record did not update — the one case that must
    // never pass quietly, because Kalshi and the platform now disagree.
    await notifyAdmins(db, {
      type: 'execution.desync',
      title: 'Filled order failed to record',
      body: `Trade ${trade.id} / Kalshi order ${order.order_id} for ${user.email}.`,
      payload: { trade_id: trade.id, kalshi_order_id: order.order_id },
    });
    throw new Error(`order filled but trade update failed: ${cErr.message}`);
  }

  if (partial) {
    await notify(db, {
      userId: user.id,
      type: 'trade.partial_fill',
      title: 'Partial fill',
      body: `${filled} of ${body.contracts} contracts filled on ${market.question}.`,
      payload: { trade_id: trade.id, filled, requested: body.contracts },
    });
  }

  // Log the FILLED quantity. Own-flow exclusion subtracts volume that
  // actually reached the book, and a partial fill only put `filled` there.
  await logPlatformFlow(db, {
    marketId: market.id,
    tradeId: trade.id,
    userId: user.id,
    side,
    contracts: filled,
    price: currentPrice,
    mode: 'live',
  });

  await logActivity(db, {
    userId: user.id,
    type: 'trade.opened',
    detail: `Live: ${side} ${filled} @ ${currentPrice}¢ — ${market.question}`,
    metadata: {
      trade_id: trade.id,
      mode: 'live',
      market_id: market.id,
      kalshi_order_id: order.order_id,
      filled,
      requested: body.contracts,
      stake_cents: actualStake,
    },
  });

  return json({
    ok: true,
    trade: confirmed,
    mode: 'live',
    filled,
    requested: body.contracts,
    partial,
    kalshiOrderId: order.order_id,
  });
}));
