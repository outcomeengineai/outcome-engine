/**
 * Resolution sync — scheduled, hourly.
 *
 * Two halves, and the difference between them is the whole point:
 *
 *   PAPER trades resolve against the market's published outcome, because no
 *   money moved and the outcome is all there is to know.
 *
 *   LIVE trades resolve against the member's own Kalshi settlement record,
 *   because what they actually received is the only number that may be billed.
 *   Deriving live PnL from the market outcome would be a guess, and a guess
 *   that becomes an invoice is not acceptable.
 *
 * Each live user is queried with their own key, one user at a time.
 */

import { handler, json, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { getMarketsByTickers, getSettlements, KalshiError, type KalshiMarket, type KalshiSettlement } from '../_shared/kalshi.ts';
import { loadKalshiCredentials } from '../_shared/vault.ts';
import { logActivity, notify, notifyAdmins } from '../_shared/log.ts';
import { forEachBatch, selectInBatches, selectPaged } from '../_shared/batch.ts';
import { stampFinalThesis } from '../_shared/thesis.ts';
import { allocateSettlementCents, formatUsd, realizedPnlCents } from '../_shared/outcome-shared.mjs';

/**
 * Markets checked for settlement per pass, on top of any that are held.
 *
 * Two populations. Markets past their close, oldest first. And markets that
 * have LEFT the open discovery feed while still unresolved here: a market
 * disappears from the feed when Kalshi finalizes it, and its stored dates
 * can sit days or years in the future -- Kalshi does not update
 * expected_expiration_time on an early finalization. 126,000 of those had
 * accumulated. Fetched as an exact set, 3,000 is ~20 requests; the backlog
 * clears in a couple of days and the steady state is a few hundred an hour.
 */
const MARKET_BATCH = 3000;

/** Not seen by discovery for this long means not in the open feed. */
const STALE_HOURS = 2;

interface OpenTrade {
  id: string;
  user_id: string;
  market_id: string;
  mode: 'paper' | 'live';
  side: 'YES' | 'NO';
  entry_price: number;
  contracts: number;
  stake_cents: number;
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);
  const started = Date.now();

  // ---- 1. find markets that have settled ---------------------------------
  // Two populations, and the second is the one that matters for learning.
  //
  // Markets someone HOLDS a position in must resolve so trades can settle.
  // But the learning loop runs on MARKET volume, not trade volume: every
  // scored market carries a thesis, and that thesis only becomes a labelled
  // example when the market's outcome is recorded. The first version checked
  // held markets only -- with no trades, nothing ever resolved, and no thesis
  // ever received its label. The loop was wired and the clock never ticked.
  //
  // So: held markets, plus every market the platform has ever priced whose
  // close has passed, oldest close first, capped per pass. Fetched as an
  // exact set in a handful of requests rather than one call per market.
  const heldRows = await selectPaged<{ market_id: string }>(
    (from, to) =>
      db.from('trades').select('market_id').in('status', ['open', 'pending']).order('id').range(from, to),
    { label: 'held markets' },
  );
  const held = [...new Set(heldRows.map((r) => r.market_id))];

  const heldOpen = await selectInBatches<{ id: string }>(
    held,
    (batch) => db.from('markets').select('id').is('resolved_at', null).in('id', batch),
    { label: 'held candidates' },
  );

  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();

  // Flagged by ingestion or discovery as finalized/settled but not yet
  // resolved here. These are the priced universe's own outcomes -- the
  // learning loop's labels -- so they go first, ahead of the stale backlog.
  const flagged = await selectPaged<{ id: string }>(
    (from, to) =>
      db
        .from('markets')
        .select('id')
        .is('resolved_at', null)
        .in('status', ['finalized', 'settled'])
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to),
    { max: MARKET_BATCH, label: 'flagged candidates' },
  );

  const pastClose = await selectPaged<{ id: string }>(
    (from, to) =>
      db
        .from('markets')
        .select('id')
        .is('resolved_at', null)
        .lt('close_time', nowIso)
        .order('close_time', { ascending: true })
        .order('id')
        .range(from, to),
    { max: MARKET_BATCH, label: 'past-close candidates' },
  );

  // Left the open feed but not yet resolved here: check them regardless of
  // what their stored dates claim. Oldest sighting first.
  const remaining = Math.max(0, MARKET_BATCH - flagged.length - pastClose.length);
  const unseen = remaining === 0 ? [] : await selectPaged<{ id: string }>(
    (from, to) =>
      db
        .from('markets')
        .select('id')
        .is('resolved_at', null)
        .lt('disc_seen_at', staleBefore)
        .order('disc_seen_at', { ascending: true })
        .order('id')
        .range(from, to),
    { max: remaining, label: 'unseen candidates' },
  );

  const candidateIds = [...new Set([
    ...heldOpen.map((m) => m.id),
    ...flagged.map((m) => m.id),
    ...pastClose.map((m) => m.id),
    ...unseen.map((m) => m.id),
  ])];

  let marketsResolved = 0;
  let stillOpen = 0;
  const newlyResolved: Array<{ id: string; outcome: 'YES' | 'NO' }> = [];

  let fetched: KalshiMarket[] = [];
  try {
    fetched = await getMarketsByTickers(candidateIds);
  } catch (err) {
    if (err instanceof KalshiError && err.status === 429) {
      await logActivity(db, {
        type: 'resolution.rate_limited',
        detail: 'Kalshi 429 on settlement check; retry next hour',
      });
    } else {
      console.warn('settlement fetch failed:', err instanceof Error ? err.message : err);
    }
  }

  const { data: stableVersion } = await db.rpc('current_stable_version');
  const resolvedAt = new Date().toISOString();

  for (const market of fetched) {
    if (!market.ticker) continue;
    const settled = market.status === 'settled' || market.status === 'finalized';
    if (!settled || !market.result) { stillOpen++; continue; }

    const result = market.result.toLowerCase();
    // Kalshi reports 'yes' | 'no' | 'void'. A voided market has no winning
    // side; positions are refunded, so it is not a win or a loss.
    if (result !== 'yes' && result !== 'no') {
      await db.from('markets')
        .update({ resolved_at: resolvedAt, status: market.status, cadence_tier: 'excluded', tier_reason: 'voided' })
        .eq('id', market.ticker);
      await logActivity(db, {
        type: 'market.voided',
        detail: market.ticker + ' settled as "' + market.result + '"',
        metadata: { market_id: market.ticker, result: market.result },
      });
      continue;
    }

    const outcome = result === 'yes' ? 'YES' : 'NO';
    await db
      .from('markets')
      .update({
        resolved_at: resolvedAt,
        outcome,
        status: market.status,
        cadence_tier: 'excluded',
        tier_reason: 'resolved',
      })
      .eq('id', market.ticker);

    newlyResolved.push({ id: market.ticker, outcome });
    marketsResolved++;

    // Unconditional final-state thesis. The last transition may have been
    // days ago, which leaves the training label ambiguous about what the
    // platform believed at the end. This row states it explicitly and
    // carries whether the thesis pointed the way the market actually went.
    if (stableVersion) await stampFinalThesis(db, stableVersion, market.ticker, outcome);
  }

  // Close membership for anything that just left the universe.
  if (newlyResolved.length) {
    await forEachBatch(newlyResolved.map((m) => m.id), (batch) =>
      db.from('universe_membership').update({ left_at: resolvedAt }).is('left_at', null).in('market_id', batch));
  }

  // ---- 2. resolve PAPER trades against the market outcome ----------------
  let paperResolved = 0;

  if (newlyResolved.length) {
    const paperTrades = await selectInBatches<OpenTrade>(
      newlyResolved.map((m) => m.id),
      (batch) =>
        db
          .from('trades')
          .select('id, user_id, market_id, mode, side, entry_price, contracts, stake_cents')
          .eq('mode', 'paper')
          .eq('status', 'open')
          .in('market_id', batch),
      { label: 'paper trades' },
    );

    for (const t of paperTrades) {
      const market = newlyResolved.find((m) => m.id === t.market_id)!;
      const won = t.side === market.outcome;
      const pnl = realizedPnlCents(t.entry_price, t.contracts, won);

      const { error } = await db.from('trade_resolutions').insert({
        trade_id: t.id,
        outcome: won ? 'win' : 'loss',
        pnl,
        settled_via: 'market_outcome',
      });
      if (error) {
        console.warn(`paper resolution insert failed for ${t.id}:`, error.message);
        continue;
      }

      await db.from('trades').update({ status: 'resolved' }).eq('id', t.id);
      await notifyResolution(db, t, won, pnl);
      paperResolved++;
    }
  }

  // ---- 3. resolve LIVE trades from each member's own settlements ---------
  const liveTrades = await selectPaged<OpenTrade>(
    (from, to) =>
      db
        .from('trades')
        .select('id, user_id, market_id, mode, side, entry_price, contracts, stake_cents')
        .eq('mode', 'live')
        .eq('status', 'open')
        .order('id')
        .range(from, to),
    { label: 'live trades' },
  );

  const byUser = new Map<string, OpenTrade[]>();
  for (const t of liveTrades) {
    byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t]);
  }

  let liveResolved = 0;
  const usersTouched = new Set<string>();

  for (const [userId, trades] of byUser) {
    const creds = await loadKalshiCredentials(db, userId);
    if (!creds) {
      // Positions exist but the key is gone. Do not guess the PnL — flag it.
      await notifyAdmins(db, {
        type: 'resolution.no_connection',
        title: 'Open live positions with no Kalshi connection',
        body: `${trades.length} position(s) cannot be settled for user ${userId}.`,
        payload: { user_id: userId, trade_ids: trades.map((t) => t.id) },
      });
      continue;
    }

    let settlements: KalshiSettlement[] = [];
    try {
      const res = await getSettlements(creds, { limit: 200 });
      settlements = res.settlements ?? [];
    } catch (err) {
      console.warn(`settlement fetch failed for ${userId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    const byTicker = new Map<string, KalshiSettlement>();
    for (const s of settlements) byTicker.set(s.ticker, s);

    // A Kalshi settlement is per MARKET and aggregates the member's entire
    // position in it. Our trades are finer-grained: a member can hold two
    // separate trades on one ticker. Attributing the full settlement to each
    // would double-count the revenue, inflating their PnL and therefore the
    // fee we bill them.
    //
    // So group our trades by ticker first and split the settlement across
    // them, proportional to contracts. With a single trade on a market — the
    // common case — the split is exact and this is a no-op.
    const tradesByTicker = new Map<string, OpenTrade[]>();
    for (const t of trades) {
      tradesByTicker.set(t.market_id, [...(tradesByTicker.get(t.market_id) ?? []), t]);
    }

    for (const [ticker, group] of tradesByTicker) {
      const s = byTicker.get(ticker);
      if (!s) continue; // not settled on Kalshi's books yet

      const totalContracts = group.reduce((sum, t) => sum + t.contracts, 0);
      if (totalContracts <= 0) continue;

      // The settlement is authoritative about the OUTCOME. Deriving it from
      // the sign of PnL instead would misclassify a winning trade entered at
      // a price so high it barely profited.
      const result = (s.market_result ?? '').toLowerCase();
      const winningSide = result === 'yes' ? 'YES' : result === 'no' ? 'NO' : null;
      if (!winningSide) {
        // Void or unrecognised: refunded, so neither a win nor a loss. Leave
        // the trades open rather than inventing a result for them.
        await logActivity(db, {
          userId,
          type: 'resolution.skipped',
          detail: `${ticker} settled as "${s.market_result}" — not a win or a loss`,
          metadata: { market_id: ticker, result: s.market_result },
        });
        continue;
      }

      // Allocate revenue by share of contracts. The helper lives in the shared
      // package so this arithmetic is unit-tested rather than trusted — the
      // parts are guaranteed to sum to exactly what Kalshi paid.
      const shares = allocateSettlementCents(s.revenue, group.map((t) => t.contracts));

      // Cost stays per-trade: stake_cents is the real fill cost recorded at
      // execution, which is more accurate than splitting an aggregate. If
      // Kalshi's total disagrees, that is a reconciliation signal worth
      // surfacing rather than quietly absorbing.
      const ourCost = group.reduce((sum, t) => sum + t.stake_cents, 0);
      if (s.cost !== undefined && Math.abs(s.cost - ourCost) > 1) {
        await logActivity(db, {
          userId,
          type: 'resolution.cost_mismatch',
          detail: `${ticker}: Kalshi cost ${s.cost}c vs recorded ${ourCost}c across ${group.length} trade(s)`,
          metadata: { market_id: ticker, kalshi_cost: s.cost, recorded_cost: ourCost },
        });
      }

      for (const [i, t] of group.entries()) {
        const pnl = Math.round((shares[i] ?? 0) - t.stake_cents);
        const won = t.side === winningSide;

        const { error } = await db.from('trade_resolutions').insert({
          trade_id: t.id,
          outcome: won ? 'win' : 'loss',
          pnl,
          settled_via: 'kalshi',
        });
        if (error) {
          console.warn(`live resolution insert failed for ${t.id}:`, error.message);
          continue;
        }

        await db.from('trades').update({ status: 'resolved' }).eq('id', t.id);
        await notifyResolution(db, t, won, pnl);
        usersTouched.add(userId);
        liveResolved++;
      }
    }
  }

  // ---- 4. keep the open billing period's running totals honest ------------
  // The member's Billing screen shows "fee accruing" against this number, so
  // it has to move the moment a live trade settles rather than at month end.
  for (const userId of usersTouched) {
    const { data: period } = await db.rpc('ensure_open_billing_period', { p_user: userId });
    if (period?.id) await db.rpc('recompute_billing_period', { p_period: period.id });
  }

  const result = {
    ok: true,
    marketsChecked: candidateIds.length,
    marketsResolved,
    stillOpen,
    paperResolved,
    liveResolved,
    ms: Date.now() - started,
  };

  await logActivity(db, {
    type: 'resolution.completed',
    detail: `${marketsResolved} markets, ${paperResolved} paper + ${liveResolved} live trades resolved`,
    metadata: result,
  });

  return json(result);
}));

async function notifyResolution(
  db: ReturnType<typeof serviceClient>,
  trade: OpenTrade,
  won: boolean,
  pnl: number,
) {
  const { data: market } = await db
    .from('markets')
    .select('question')
    .eq('id', trade.market_id)
    .maybeSingle();

  const modeLabel = trade.mode === 'paper' ? ' (paper)' : '';

  await notify(db, {
    userId: trade.user_id,
    type: 'trade.resolved',
    title: won ? `Win${modeLabel}` : `Loss${modeLabel}`,
    body: `${formatUsd(pnl, { signed: true })} — ${market?.question ?? trade.market_id}`,
    payload: { trade_id: trade.id, outcome: won ? 'win' : 'loss', pnl, mode: trade.mode },
  });

  await logActivity(db, {
    userId: trade.user_id,
    type: 'trade.resolved',
    detail: `${won ? 'Win' : 'Loss'}${modeLabel} ${formatUsd(pnl, { signed: true })} — ${market?.question ?? trade.market_id}`,
    metadata: { trade_id: trade.id, pnl, mode: trade.mode },
  });
}
