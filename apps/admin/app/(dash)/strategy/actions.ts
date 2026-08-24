'use server';

import { revalidatePath } from 'next/cache';
import { serverClient } from '@/lib/supabase';
import type { RiskLimits, Thresholds, WeightConfig } from '@outcome/shared';

async function adminClient() {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const { data } = await db.from('users').select('role').eq('id', user.id).single();
  if (data?.role !== 'admin') throw new Error('admin only');
  return { db, adminId: user.id };
}

/** Next label in the vN sequence, based on the highest number already used. */
async function nextVersionLabel(db: Awaited<ReturnType<typeof serverClient>>): Promise<string> {
  const { data } = await db.from('model_versions').select('version_label');
  const highest = (data ?? []).reduce((max: number, r: { version_label: string }) => {
    const n = Number(/^v(\d+)$/.exec(r.version_label)?.[1] ?? 0);
    return Math.max(max, n);
  }, 0);
  return `v${highest + 1}`;
}

/**
 * Save a draft version. Drafts are cheap and never affect scoring — the
 * scoring engine only ever reads the current STABLE version — so the configure
 * flow can save freely and publishing stays a separate, deliberate step.
 */
export async function saveDraft(config: {
  weights: WeightConfig;
  thresholds: Thresholds;
  riskLimits: RiskLimits;
  notes?: string;
  draftId?: string;
}) {
  const { db, adminId } = await adminClient();

  if (config.draftId) {
    const { data, error } = await db
      .from('model_versions')
      .update({
        weights: config.weights,
        thresholds: config.thresholds,
        risk_limits: config.riskLimits,
        notes: config.notes ?? null,
      })
      .eq('id', config.draftId)
      .eq('status', 'draft') // never edit a published version in place
      .select()
      .single();
    if (error) throw new Error(error.message);
    revalidatePath('/strategy');
    return data;
  }

  const label = await nextVersionLabel(db);
  const { data, error } = await db
    .from('model_versions')
    .insert({
      version_label: label,
      status: 'draft',
      weights: config.weights,
      thresholds: config.thresholds,
      risk_limits: config.riskLimits,
      notes: config.notes ?? null,
      created_by: adminId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  revalidatePath('/strategy');
  return data;
}

/**
 * Publish a draft.
 *
 * Goes through the publish-model Edge Function rather than the SQL RPC
 * directly, because publishing also re-scores open markets and notifies
 * members whose open trades moved — work that does not belong in a request
 * handler here.
 */
export async function publishVersion(modelVersionId: string) {
  const db = await serverClient();
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('not signed in');

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/publish-model`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ modelVersionId }),
    },
  );

  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'publish failed');

  revalidatePath('/strategy');
  revalidatePath('/');
  return body;
}

export async function deleteDraft(id: string) {
  const { db } = await adminClient();
  const { error } = await db.from('model_versions').delete().eq('id', id).eq('status', 'draft');
  if (error) throw new Error(error.message);
  revalidatePath('/strategy');
}

/** Auto-disable rule configuration for the signal monitor. */
export async function updateSignalRules(values: Record<string, number>) {
  const { db, adminId } = await adminClient();

  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    value: value as unknown as object,
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db.from('platform_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(error.message);

  revalidatePath('/strategy');
}

/** Manual override — bring a cooling-off signal back early, or force one off. */
export async function setSignalStatus(signal: string, status: 'healthy' | 'disabled') {
  const { db, adminId } = await adminClient();

  const { data: cooldownRow } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'signal_cooldown_hours')
    .maybeSingle();

  const hours = Number(cooldownRow?.value ?? 24);

  const { error } = await db
    .from('signal_health')
    .update({
      status,
      disabled_until:
        status === 'disabled' ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
      disabled_reason: status === 'disabled' ? 'Disabled manually by admin' : null,
      computed_at: new Date().toISOString(),
    })
    .eq('signal', signal);
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    user_id: adminId,
    event_type: status === 'disabled' ? 'signal.disabled' : 'signal.reenabled',
    detail: `${signal} ${status === 'disabled' ? 'disabled' : 're-enabled'} manually`,
    metadata: { signal },
  });

  revalidatePath('/strategy');
}
