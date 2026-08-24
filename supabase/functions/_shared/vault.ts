/**
 * Supabase Vault access for Kalshi private keys.
 *
 * RULES, enforced by keeping every Vault touch inside this file:
 *   - A key is written once, at connect time, and read only by server code
 *     that is about to sign a Kalshi request for that same user.
 *   - A key is NEVER returned to a client, NEVER logged, and NEVER stored in
 *     a plain column. `kalshi_connections.vault_secret_ref` holds only the
 *     vault.secrets id, which is inert without service-role access.
 *   - Each user has their own key. There is no master key and no fallback to
 *     one — Kalshi's developer agreement forbids sublicensing, so routing
 *     several members through one credential is not an option.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/** Create a Vault secret and return its id. */
export async function storeSecret(
  db: SupabaseClient,
  name: string,
  secret: string,
  description = '',
): Promise<string> {
  const { data, error } = await db.rpc('vault_create_secret', {
    p_secret: secret,
    p_name: name,
    p_description: description,
  });
  if (error) throw new Error(`vault store failed: ${error.message}`);
  return data as string;
}

/** Read a Vault secret by id. Callers must not log or return the result. */
export async function readSecret(db: SupabaseClient, ref: string): Promise<string> {
  const { data, error } = await db.rpc('vault_read_secret', { p_id: ref });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error('vault secret not found');
  return data as string;
}

export async function deleteSecret(db: SupabaseClient, ref: string): Promise<void> {
  const { error } = await db.rpc('vault_delete_secret', { p_id: ref });
  if (error) throw new Error(`vault delete failed: ${error.message}`);
}

/**
 * Load a user's Kalshi credentials for a signing operation.
 * Returns null when the user has no usable connection, so callers can produce
 * a clear "connect your Kalshi account" error instead of a crash.
 */
export async function loadKalshiCredentials(
  db: SupabaseClient,
  userId: string,
): Promise<{ keyId: string; privateKeyPem: string } | null> {
  const { data, error } = await db
    .from('kalshi_connections')
    .select('vault_secret_ref, kalshi_key_id, status')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`connection lookup failed: ${error.message}`);
  if (!data || data.status !== 'connected') return null;

  const privateKeyPem = await readSecret(db, data.vault_secret_ref);
  return { keyId: data.kalshi_key_id, privateKeyPem };
}
