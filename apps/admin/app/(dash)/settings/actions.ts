'use server';

import { revalidatePath } from 'next/cache';
import { serverClient } from '@/lib/supabase';

async function adminClient() {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const { data } = await db.from('users').select('role').eq('id', user.id).single();
  if (data?.role !== 'admin') throw new Error('admin only');
  return { db, adminId: user.id };
}

/**
 * Write platform settings.
 *
 * Values are stored as JSONB, so a number must go in as a number and a boolean
 * as a boolean — `setting_numeric()` and `setting_bool()` cast on read and
 * would silently fall back to their defaults on a string.
 */
export async function updateSettings(values: Record<string, number | boolean | string[]>) {
  const { db, adminId } = await adminClient();

  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    value: value as unknown as object,
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db.from('platform_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    user_id: adminId,
    event_type: 'settings.updated',
    detail: `Updated ${Object.keys(values).join(', ')}`,
    metadata: values as Record<string, unknown>,
  });

  revalidatePath('/settings');
  revalidatePath('/');
}

/**
 * The two emergency controls.
 *
 * Neither closes an existing position. The kill switch stops the platform from
 * opening anything new; members' Kalshi accounts are their own and keep running
 * whatever is already on them.
 */
export async function setKillSwitch(on: boolean) {
  const { db, adminId } = await adminClient();

  const { error } = await db
    .from('platform_settings')
    .upsert(
      { key: 'kill_switch', value: on as unknown as object, updated_by: adminId, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    user_id: adminId,
    event_type: on ? 'platform.kill_switch_on' : 'platform.kill_switch_off',
    detail: on
      ? 'Global kill switch engaged — all platform trading halted'
      : 'Global kill switch released',
  });

  revalidatePath('/settings');
  revalidatePath('/');
}

export async function setTradingPaused(on: boolean) {
  const { db, adminId } = await adminClient();

  const { error } = await db
    .from('platform_settings')
    .upsert(
      { key: 'trading_paused', value: on as unknown as object, updated_by: adminId, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    user_id: adminId,
    event_type: on ? 'platform.paused' : 'platform.resumed',
    detail: on ? 'Live trading paused' : 'Live trading resumed',
  });

  revalidatePath('/settings');
  revalidatePath('/');
}
