import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { ScoreBreakdown, Side, TradeMode } from '@outcome/shared';

/**
 * Data hooks.
 *
 * Every query here is scoped by RLS rather than by a `.eq('user_id', me)`
 * filter, so a mistake in a hook cannot leak another member's rows — the worst
 * case is an empty list. The user id is still passed where it makes the query
 * cheaper, not where it is the security boundary.
 */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

function useLoadable<T>(fn: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setData(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload]);

  return { data, loading, error, reload };
}

// --------------------------------------------------------------------------

export interface DeskMarket {
  market_id: string;
  question: string;
  category: string;
  side: Side;
  score: number;
  breakdown: ScoreBreakdown;
  side_price: number | null;
  yes_price: number | null;
  close_time: string | null;
  scored_at: string;
  tags: Array<{ text: string; severity: 'info' | 'caution' }>;
}

/**
 * The Decision Desk feed, scored by the member's EFFECTIVE model version —
 * which during a transition window may be the previous stable one they pinned.
 */
export function useDesk(userId: string | undefined) {
  return useLoadable<{ markets: DeskMarket[]; strongThreshold: number; versionLabel: string }>(
    async () => {
      if (!userId) return { markets: [], strongThreshold: 7, versionLabel: '—' };

      const { data: versionId } = await supabase.rpc('effective_version_for', { p_user: userId });
      if (!versionId) return { markets: [], strongThreshold: 7, versionLabel: '—' };

      const [{ data: rows, error }, { data: version }, { data: tags }] = await Promise.all([
        supabase
          .from('decision_desk')
          .select('*')
          .eq('model_version_id', versionId)
          .order('score', { ascending: false })
          .limit(50),
        supabase.from('model_versions').select('version_label, thresholds').eq('id', versionId).maybeSingle(),
        supabase.from('tags').select('market_id, text, severity').not('market_id', 'is', null).limit(300),
      ]);

      if (error) throw error;

      const tagsByMarket = new Map<string, Array<{ text: string; severity: 'info' | 'caution' }>>();
      for (const t of (tags ?? []) as Array<{ market_id: string; text: string; severity: 'info' | 'caution' }>) {
        tagsByMarket.set(t.market_id, [...(tagsByMarket.get(t.market_id) ?? []), t]);
      }

      return {
        markets: ((rows ?? []) as Array<Record<string, any>>).map((r) => ({
          market_id: r.market_id,
          question: r.question,
          category: r.category,
          side: r.side,
          score: Number(r.score),
          breakdown: r.breakdown,
          side_price: r.side_price === null ? null : Number(r.side_price),
          yes_price: r.yes_price === null ? null : Number(r.yes_price),
          close_time: r.close_time,
          scored_at: r.scored_at,
          tags: tagsByMarket.get(r.market_id) ?? [],
        })),
        strongThreshold: Number(version?.thresholds?.strongPick ?? 7),
        versionLabel: version?.version_label ?? '—',
      };
    },
    [userId],
  );
}

export function useMarket(marketId: string | undefined, userId: string | undefined) {
  return useLoadable<DeskMarket | null>(
    async () => {
      if (!marketId || !userId) return null;

      const { data: versionId } = await supabase.rpc('effective_version_for', { p_user: userId });

      const [{ data: row }, { data: tags }] = await Promise.all([
        supabase
          .from('decision_desk')
          .select('*')
          .eq('market_id', marketId)
          .eq('model_version_id', versionId)
          .maybeSingle(),
        supabase.from('tags').select('text, severity').eq('market_id', marketId),
      ]);

      if (!row) return null;

      return {
        market_id: row.market_id,
        question: row.question,
        category: row.category,
        side: row.side,
        score: Number(row.score),
        breakdown: row.breakdown,
        side_price: row.side_price === null ? null : Number(row.side_price),
        yes_price: row.yes_price === null ? null : Number(row.yes_price),
        close_time: row.close_time,
        scored_at: row.scored_at,
        tags: (tags ?? []) as Array<{ text: string; severity: 'info' | 'caution' }>,
      };
    },
    [marketId, userId],
  );
}

// --------------------------------------------------------------------------

export interface OpenPosition {
  trade_id: string;
  market_id: string;
  question: string;
  category: string;
  mode: TradeMode;
  side: Side;
  entry_price: number;
  current_price: number | null;
  contracts: number;
  stake_cents: number;
  entry_score: number;
  entry_model_label: string;
  unrealized_pnl: number;
  opened_at: string;
}

export interface ResolvedPosition {
  trade_id: string;
  question: string;
  category: string;
  mode: TradeMode;
  side: Side;
  outcome: 'win' | 'loss';
  pnl: number;
  entry_price: number;
  contracts: number;
  entry_model_label: string;
  opened_at: string;
  resolved_at: string;
  hold_seconds: number;
}

export function usePositions() {
  return useLoadable<{ open: OpenPosition[]; resolved: ResolvedPosition[] }>(
    async () => {
      const [{ data: open, error: e1 }, { data: resolved, error: e2 }] = await Promise.all([
        supabase.from('open_positions').select('*').order('opened_at', { ascending: false }),
        supabase.from('resolved_positions').select('*').order('resolved_at', { ascending: false }).limit(100),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;

      return {
        open: ((open ?? []) as Array<Record<string, any>>).map((p) => ({
          ...p,
          entry_price: Number(p.entry_price),
          current_price: p.current_price === null ? null : Number(p.current_price),
          stake_cents: Number(p.stake_cents),
          entry_score: Number(p.entry_score),
          unrealized_pnl: Number(p.unrealized_pnl ?? 0),
        })) as unknown as OpenPosition[],
        resolved: ((resolved ?? []) as Array<Record<string, any>>).map((r) => ({
          ...r,
          pnl: Number(r.pnl),
          entry_price: Number(r.entry_price),
          entry_score: Number(r.entry_score),
          hold_seconds: Number(r.hold_seconds ?? 0),
        })) as unknown as ResolvedPosition[],
      };
    },
    [],
  );
}

// --------------------------------------------------------------------------

/**
 * The open billing period. `fee_owed` here is a running estimate that the
 * resolution job recomputes as trades settle — it is not a charge until the
 * period closes.
 */
export function useCurrentPeriod(userId: string | undefined) {
  return useLoadable<Record<string, any> | null>(
    async () => {
      if (!userId) return null;
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);

      const { data } = await supabase
        .from('billing_periods')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', start.toISOString())
        .maybeSingle();

      return data ?? null;
    },
    [userId],
  );
}

export function useKalshiConnection(userId: string | undefined) {
  return useLoadable<{ status: string | null }>(
    async () => {
      if (!userId) return { status: null };
      const { data } = await supabase
        .from('kalshi_connections')
        .select('status')
        .eq('user_id', userId)
        .maybeSingle();
      return { status: data?.status ?? null };
    },
    [userId],
  );
}

export function useNotifications() {
  return useLoadable<Array<Record<string, any>>>(
    async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}

export function useActivity() {
  return useLoadable<Array<Record<string, any>>>(
    async () => {
      const { data, error } = await supabase
        .from('activity_log')
        .select('*')
        .order('ts', { ascending: false })
        .limit(150);
      if (error) throw error;
      return data ?? [];
    },
    [],
  );
}
