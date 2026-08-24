import { serverClient } from '@/lib/supabase';
import { StrategyWorkspace } from './client';

export const dynamic = 'force-dynamic';

export default async function StrategyPage() {
  const db = await serverClient();

  const [{ data: versions }, { data: signals }, { data: settings }, { data: categories }, { data: history }] =
    await Promise.all([
      db.from('model_versions').select('*').order('created_at', { ascending: false }),
      db.from('signal_health').select('*'),
      db.from('platform_settings').select('key, value').like('key', 'signal_%'),
      db.from('markets').select('category').limit(2000),
      db.from('signal_health_history')
        .select('signal, win_rate, computed_at')
        .order('computed_at', { ascending: true })
        .limit(400),
    ]);

  const stable = (versions ?? []).find((v: { status: string }) => v.status === 'stable') ?? null;
  const drafts = (versions ?? []).filter((v: { status: string }) => v.status === 'draft');

  // Offer overrides for categories that actually exist in the data. An override
  // keyed to a category no market carries would silently never apply.
  const seen = new Set<string>();
  for (const c of (categories ?? []) as Array<{ category: string }>) seen.add(c.category);

  const rules = Object.fromEntries(
    (settings ?? []).map((s: { key: string; value: unknown }) => [s.key, Number(s.value)]),
  ) as Record<string, number>;

  return (
    <StrategyWorkspace
      stable={stable}
      drafts={drafts}
      allVersions={versions ?? []}
      signals={signals ?? []}
      signalHistory={history ?? []}
      rules={rules}
      categories={[...seen].sort()}
    />
  );
}
