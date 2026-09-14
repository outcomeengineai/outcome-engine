import { serverClient } from '@/lib/supabase';
import { SimulateWorkspace } from './client';

export const dynamic = 'force-dynamic';
// Server actions on this route call Edge Functions that can run for tens of
// seconds; the default action budget is shorter than that.
export const maxDuration = 60;

export default async function SimulatePage() {
  const db = await serverClient();

  const [{ data: versions }, { data: runs }] = await Promise.all([
    db.from('model_versions').select('id, version_label, status').order('created_at', { ascending: false }),
    db.from('backtest_runs').select('*').order('created_at', { ascending: false }).limit(10),
  ]);

  return <SimulateWorkspace versions={versions ?? []} runs={runs ?? []} />;
}
