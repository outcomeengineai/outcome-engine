'use server';

import { revalidatePath } from 'next/cache';
import { serverClient } from '@/lib/supabase';

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
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/run-backtest`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(params),
    },
  );

  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'backtest failed');

  revalidatePath('/simulate');
  return body;
}
