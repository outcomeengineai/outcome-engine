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

export async function deleteTag(id: string) {
  const { db } = await adminClient();
  const { error } = await db.from('tags').delete().eq('id', id);
  if (error) throw new Error(error.message);
  revalidatePath('/tags');
}

export async function updateTag(id: string, patch: { text?: string; severity?: 'info' | 'caution' }) {
  const { db, adminId } = await adminClient();

  // Editing an auto tag converts it to manual, so the next scoring pass does
  // not overwrite the admin's correction with the rule's original wording.
  const { error } = await db
    .from('tags')
    .update({ ...patch, source: 'manual', created_by: adminId })
    .eq('id', id);
  if (error) throw new Error(error.message);

  revalidatePath('/tags');
}

export async function addTag(params: {
  marketId?: string;
  tradeId?: string;
  tagType: string;
  severity: 'info' | 'caution';
  text: string;
}) {
  const { db, adminId } = await adminClient();

  const { error } = await db.from('tags').insert({
    market_id: params.marketId ?? null,
    trade_id: params.tradeId ?? null,
    tag_type: params.tagType,
    severity: params.severity,
    text: params.text,
    source: 'manual',
    created_by: adminId,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/tags');
}
