/**
 * The caller's own Kalshi balance.
 *
 * Exists so the stake card can warn BEFORE a member commits to a size they
 * cannot afford. It is a courtesy check, not the authoritative one —
 * execute-trade re-reads the balance immediately before placing an order,
 * because this number can be seconds stale and a stale balance must never be
 * what lets an order through.
 *
 * Signed with the CALLING USER's own key. There is no way to ask for anyone
 * else's balance: the credentials are looked up from the session, never from
 * a parameter.
 */

import { handler, json, requireUser, serviceClient } from '../_shared/http.ts';
import { getBalance, KalshiError } from '../_shared/kalshi.ts';
import { loadKalshiCredentials } from '../_shared/vault.ts';

Deno.serve(handler(async (req) => {
  const db = serviceClient();
  const user = await requireUser(req, db);

  const creds = await loadKalshiCredentials(db, user.id);
  if (!creds) {
    return json({ ok: true, connected: false, balanceCents: null });
  }

  try {
    const { balance } = await getBalance(creds);
    await db
      .from('kalshi_connections')
      .update({ last_verified_at: new Date().toISOString(), status: 'connected', last_error: null })
      .eq('user_id', user.id);

    return json({ ok: true, connected: true, balanceCents: balance });
  } catch (err) {
    // A rejected key is worth recording — the member should be told to
    // reconnect rather than discovering it when an order fails.
    if (err instanceof KalshiError && err.status === 401) {
      await db
        .from('kalshi_connections')
        .update({ status: 'error', last_error: 'authentication rejected' })
        .eq('user_id', user.id);

      return json(
        { ok: false, connected: false, balanceCents: null, error: 'Kalshi rejected your API key.' },
        200, // not an app error — the client shows a reconnect prompt
      );
    }

    return json({ ok: false, connected: true, balanceCents: null, error: 'Could not reach Kalshi.' }, 200);
  }
}));
