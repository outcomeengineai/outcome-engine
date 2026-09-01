/**
 * Push notification drain — scheduled, every 2 minutes.
 *
 * Notification rows are written by whichever function caused the event; this
 * job only delivers them. The split matters: a failure in Expo's push service
 * must never roll back a trade resolution or a billing charge, and a row that
 * fails to push stays in the notification centre either way.
 *
 * `sent_at` is the idempotency marker — it is stamped only after Expo accepts
 * the batch, so a crash mid-drain resends rather than silently dropping.
 */

import { handler, json, requireCronOrAdmin, serviceClient } from '../_shared/http.ts';
import { optional } from '../_shared/env.ts';
import { forEachBatch } from '../_shared/batch.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo accepts at most 100 messages per request. */
const BATCH = 100;

interface Row {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  await requireCronOrAdmin(req, db);

  const { data: pending, error } = await db
    .from('notifications')
    .select('id, user_id, type, title, body, payload')
    .is('sent_at', null)
    // Anything older than a day is stale; the member will see it in-app.
    .gte('created_at', new Date(Date.now() - 86400_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) throw new Error(`notification load failed: ${error.message}`);
  const rows = (pending ?? []) as Row[];
  if (rows.length === 0) return json({ ok: true, sent: 0, pending: 0 });

  // ---- push targets ------------------------------------------------------
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: devices } = await db
    .from('devices')
    .select('user_id, expo_push_token')
    .in('user_id', userIds);

  const tokensByUser = new Map<string, string[]>();
  for (const d of (devices ?? []) as Array<{ user_id: string; expo_push_token: string }>) {
    tokensByUser.set(d.user_id, [...(tokensByUser.get(d.user_id) ?? []), d.expo_push_token]);
  }

  const messages: Array<Record<string, unknown> & { __rowId: string; __token: string }> = [];
  const noDevice: string[] = [];

  for (const row of rows) {
    const tokens = tokensByUser.get(row.user_id) ?? [];
    if (tokens.length === 0) {
      // Nothing to push to. Mark it sent so it stops being retried — it is
      // still in the notification centre, which is where they will see it.
      noDevice.push(row.id);
      continue;
    }
    for (const token of tokens) {
      messages.push({
        __rowId: row.id,
        __token: token,
        to: token,
        title: row.title,
        body: row.body ?? '',
        sound: 'default',
        data: { notificationId: row.id, type: row.type, ...row.payload },
      });
    }
  }

  await forEachBatch(noDevice, (batch) =>
    db.from('notifications').update({ sent_at: new Date().toISOString() }).in('id', batch));

  // ---- send ---------------------------------------------------------------
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const accessToken = optional('EXPO_ACCESS_TOKEN');
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const deliveredRows = new Set<string>();
  const deadTokens = new Set<string>();
  let errors = 0;

  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH);
    const payload = chunk.map(({ __rowId: _r, __token: _t, ...m }) => m);

    let tickets: ExpoTicket[] = [];
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error(`expo push ${res.status}: ${(await res.text()).slice(0, 300)}`);
        errors += chunk.length;
        continue; // leave sent_at null so the next tick retries
      }
      const parsed = await res.json() as { data?: ExpoTicket[] };
      tickets = parsed.data ?? [];
    } catch (err) {
      console.error('expo push failed:', err instanceof Error ? err.message : err);
      errors += chunk.length;
      continue;
    }

    tickets.forEach((ticket, idx) => {
      const msg = chunk[idx];
      if (!msg) return;
      if (ticket.status === 'ok') {
        deliveredRows.add(msg.__rowId);
        return;
      }
      errors++;
      // A token belonging to an uninstalled app is permanently dead. Prune it
      // rather than failing this notification every two minutes forever.
      if (ticket.details?.error === 'DeviceNotRegistered') deadTokens.add(msg.__token);
      console.warn(`push rejected for row ${msg.__rowId}: ${ticket.message ?? ticket.details?.error}`);
    });
  }

  if (deadTokens.size) {
    await db.from('devices').delete().in('expo_push_token', [...deadTokens]);
  }

  await forEachBatch([...deliveredRows], (batch) =>
    db.from('notifications').update({ sent_at: new Date().toISOString() }).in('id', batch));

  return json({
    ok: true,
    queued: rows.length,
    pushed: deliveredRows.size,
    noDevice: noDevice.length,
    prunedTokens: deadTokens.size,
    errors,
  });
}));
