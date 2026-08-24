'use server';

import { revalidatePath } from 'next/cache';
import { serverClient } from '@/lib/supabase';

/**
 * Account and billing actions.
 *
 * Every one of these runs through the caller's own session, so RLS and the
 * `is_admin()` checks inside the SQL functions are the real authorisation —
 * a member who somehow reached this code would simply get a policy error.
 */

async function requireAdminClient() {
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');

  const { data: profile } = await db.from('users').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') throw new Error('admin only');

  return { db, adminId: user.id };
}

export async function createInvite(formData: FormData) {
  const { db, adminId } = await requireAdminClient();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  // Ambiguous characters removed: these get read aloud and retyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');

  const { error } = await db.from('invites').insert({
    code,
    email: email || null,
    created_by: adminId,
    expires_at: new Date(Date.now() + 14 * 86400_000).toISOString(),
  });
  if (error) throw new Error(error.message);

  revalidatePath('/accounts');
  return code;
}

export async function setAccountStatus(userId: string, status: string) {
  const { db } = await requireAdminClient();

  const { error } = await db.from('users').update({ account_status: status }).eq('id', userId);
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    user_id: userId,
    event_type: 'account.status_changed',
    detail: `Status set to ${status} by admin`,
    metadata: { status },
  });

  revalidatePath('/accounts');
}

export async function setRole(userId: string, role: 'admin' | 'member') {
  const { db } = await requireAdminClient();
  const { error } = await db.from('users').update({ role }).eq('id', userId);
  if (error) throw new Error(error.message);
  revalidatePath('/accounts');
}

/** Manual payment override, for the rare P2P-balance case. */
export async function markPeriodPaid(periodId: string, note?: string) {
  const { db } = await requireAdminClient();
  const { error } = await db.rpc('mark_period_paid', { p_period: periodId, p_note: note ?? null });
  if (error) throw new Error(error.message);
  revalidatePath('/accounts');
}

export async function waivePeriod(periodId: string, note?: string) {
  const { db } = await requireAdminClient();
  const { error } = await db.rpc('waive_period', { p_period: periodId, p_note: note ?? null });
  if (error) throw new Error(error.message);
  revalidatePath('/accounts');
}

/** Recompute a period's totals from its resolved live trades. */
export async function recomputePeriod(periodId: string) {
  const { db } = await requireAdminClient();
  const { error } = await db.rpc('recompute_billing_period', { p_period: periodId });
  if (error) throw new Error(error.message);
  revalidatePath('/accounts');
}
