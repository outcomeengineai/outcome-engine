'use server';

import { revalidatePath } from 'next/cache';
import { serverClient } from '@/lib/supabase';
import { supabaseUrl } from '@/lib/supabase-env';

/**
 * Kick off a backtest.
 *
 * Runs in the Edge Function rather than here because it replays thousands of
 * snapshot rows — work that would tie up a Next.js request handler and, on
 * Vercel, hit the function timeout on a wide date range.
 */
export async function runBacktest(params: {
  modelVersionId: string;
  rangeStart: string;
  rangeEnd: string;
  compareVersionId?: string;
}) {
  const db = await serverClient();
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error('not signed in');

  const res = await fetch(
    `${supabaseUrl()}/functions/v1/run-backtest`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(params),
    },
  );

  const text = await res.text();
  let body: { error?: string } & Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
  // Returned, not thrown: a thrown error's message is stripped in production.
  if (!res.ok) return { ok: false as const, error: body.error ?? `backtest failed (HTTP ${res.status})` };

  revalidatePath('/simulate');
  return body;
}
