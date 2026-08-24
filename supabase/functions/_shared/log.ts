/**
 * Activity log and notification writes.
 *
 * Both are best-effort: a failure to record an event must never roll back the
 * thing that happened. A trade that filled but whose log row failed is still a
 * filled trade, and throwing here would turn a cosmetic problem into a
 * financial one.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export async function logActivity(
  db: SupabaseClient,
  event: {
    userId?: string | null;
    type: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from('activity_log').insert({
    user_id: event.userId ?? null,
    event_type: event.type,
    detail: event.detail ?? null,
    metadata: event.metadata ?? {},
  });
  if (error) console.error('activity_log write failed:', error.message);
}

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

/**
 * Queue an in-app notification. `sent_at` stays null until send-notifications
 * pushes it, which is what makes the drain job idempotent.
 */
export async function notify(
  db: SupabaseClient,
  n: NotificationInput,
): Promise<void> {
  const { error } = await db.from('notifications').insert({
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    payload: n.payload ?? {},
  });
  if (error) console.error('notification write failed:', error.message);
}

export async function notifyMany(
  db: SupabaseClient,
  rows: NotificationInput[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from('notifications').insert(
    rows.map((n) => ({
      user_id: n.userId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      payload: n.payload ?? {},
    })),
  );
  if (error) console.error('notification batch write failed:', error.message);
}

/** Notify every admin — used for signal disables, payment and execution failures. */
export async function notifyAdmins(
  db: SupabaseClient,
  n: Omit<NotificationInput, 'userId'>,
): Promise<void> {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('role', 'admin')
    .neq('account_status', 'removed');

  if (error) {
    console.error('admin lookup failed:', error.message);
    return;
  }
  await notifyMany(db, (data ?? []).map((u) => ({ ...n, userId: u.id })));
}
