import { serverClient } from '@/lib/supabase';
import { ActivityLog } from './client';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const db = await serverClient();

  const [{ data: events }, { data: users }] = await Promise.all([
    db.from('activity_log').select('*').order('ts', { ascending: false }).limit(500),
    db.from('users').select('id, email, display_name'),
  ]);

  const nameById = new Map(
    (users ?? []).map((u: { id: string; email: string; display_name: string | null }) => [
      u.id,
      u.display_name ?? u.email,
    ]),
  );

  return (
    <ActivityLog
      events={(events ?? []).map((e: Record<string, any>) => ({
        id: e.id,
        event_type: e.event_type,
        detail: e.detail,
        ts: e.ts,
        who: e.user_id ? nameById.get(e.user_id) ?? 'unknown' : 'system',
      }))}
    />
  );
}
