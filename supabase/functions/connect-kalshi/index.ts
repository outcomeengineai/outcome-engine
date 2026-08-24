/**
 * Kalshi connect flow — invoked once from onboarding.
 *
 * This is the only moment a Kalshi private key crosses the network to us. It
 * is verified against Kalshi, written straight to Vault, and the plaintext is
 * never persisted, logged, echoed back, or held in a variable longer than the
 * verification call needs it.
 *
 * The member keeps their own key on their own Kalshi account. We never hold a
 * master key and never route one member's order through another's credential —
 * Kalshi's developer agreement prohibits sublicensing, and the RLS model
 * assumes one key per member throughout.
 */

import {
  badRequest,
  handler,
  json,
  readJson,
  requireUser,
  serviceClient,
} from '../_shared/http.ts';
import { verifyCredentials } from '../_shared/kalshi.ts';
import { deleteSecret, storeSecret } from '../_shared/vault.ts';
import { logActivity } from '../_shared/log.ts';

interface Body {
  keyId: string;
  /** PKCS#8 PEM. Discarded from memory after verification and Vault write. */
  privateKey: string;
  kalshiUsername?: string;
}

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') badRequest('POST only');

  const db = serviceClient();
  const user = await requireUser(req, db);
  const body = await readJson<Body>(req);

  if (!body.keyId?.trim()) badRequest('keyId is required');
  if (!body.privateKey?.trim()) badRequest('privateKey is required');

  const keyId = body.keyId.trim();
  const privateKeyPem = body.privateKey.trim();

  if (!/-----BEGIN PRIVATE KEY-----/.test(privateKeyPem)) {
    badRequest(
      'That does not look like a PKCS#8 private key. Paste the whole file, ' +
        'including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.',
      'bad_key_format',
    );
  }

  // Verify BEFORE storing. A key that cannot authenticate is not a connection,
  // and storing it would leave the member looking connected until their first
  // trade failed.
  const check = await verifyCredentials({ keyId, privateKeyPem });
  if (!check.ok) {
    await logActivity(db, {
      userId: user.id,
      type: 'kalshi.connect_failed',
      detail: check.reason,
    });
    badRequest(check.reason, 'verification_failed');
  }

  // Replace any prior connection, and delete its secret rather than orphaning
  // it in Vault.
  const { data: existing } = await db
    .from('kalshi_connections')
    .select('vault_secret_ref')
    .eq('user_id', user.id)
    .maybeSingle();

  const secretRef = await storeSecret(
    db,
    `kalshi_key_${user.id}_${Date.now()}`,
    privateKeyPem,
    `Kalshi private key for ${user.email}`,
  );

  const { error } = await db.from('kalshi_connections').upsert(
    {
      user_id: user.id,
      vault_secret_ref: secretRef,
      kalshi_key_id: keyId,
      kalshi_username: body.kalshiUsername ?? null,
      permission_scope: ['trade'], // minimum scope; never request withdrawals
      status: 'connected',
      last_error: null,
      last_verified_at: new Date().toISOString(),
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    await deleteSecret(db, secretRef); // do not leave a secret with no owner
    throw new Error(`could not save connection: ${error.message}`);
  }

  if (existing?.vault_secret_ref && existing.vault_secret_ref !== secretRef) {
    await deleteSecret(db, existing.vault_secret_ref);
  }

  await logActivity(db, {
    userId: user.id,
    type: 'kalshi.connected',
    detail: `Connected Kalshi account (key ${keyId.slice(0, 8)}…)`,
    metadata: { key_id_prefix: keyId.slice(0, 8) },
  });

  // The balance goes back so onboarding can show it immediately. The key does
  // not, and there is no endpoint anywhere that returns it.
  return json({
    ok: true,
    connected: true,
    balanceCents: check.balanceCents,
  });
}));
