/**
 * Invite validation and redemption.
 *
 * There is no public signup. Two operations:
 *   POST { code }            -> validate before the auth step, unauthenticated
 *   POST { code, redeem:1 }  -> claim it, authenticated, after the account exists
 *
 * Validation is deliberately unauthenticated: the app has to be able to tell
 * someone their code is wrong before asking them to create an account. It
 * returns only whether the code is usable, never who it belongs to.
 */

import { badRequest, handler, json, readJson, requireUser, serviceClient } from '../_shared/http.ts';
import { logActivity } from '../_shared/log.ts';

interface Body {
  code: string;
  redeem?: boolean;
  displayName?: string;
  /** send mode: create the account for this email and email the sign-in link. */
  send?: boolean;
  email?: string;
  /** The app's own deep link. Validated against an allowlist of schemes. */
  redirectTo?: string;
}

/** Only the member app's own schemes. Anything else is an open redirect. */
const APP_REDIRECT = /^(outcomeengine:\/\/|exp:\/\/|exps:\/\/)/;

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') badRequest('POST only');

  const db = serviceClient();
  const body = await readJson<Body>(req);

  const code = (body.code ?? '').trim().toUpperCase();
  if (!code) badRequest('code is required');

  const { data: invite, error } = await db
    .from('invites')
    .select('code, email, redeemed_by, expires_at')
    .eq('code', code)
    .maybeSingle();

  if (error) throw new Error(`invite lookup failed: ${error.message}`);

  // One message for every failure mode, so the endpoint cannot be used to
  // enumerate which codes exist.
  const invalid = () => badRequest('That invite code is not valid.', 'invalid_invite');

  if (!invite) invalid();
  if (invite!.redeemed_by) invalid();
  if (invite!.expires_at && new Date(invite!.expires_at) < new Date()) invalid();

  // ---- send: the account is created HERE, by the platform, from a valid
  // invite -- not by the app calling signInWithOtp with the public anon key,
  // which anyone can do. Public signups are off; inviteUserByEmail is the
  // only way an account comes to exist. The code rides in the user's
  // metadata and the auth trigger claims the invite in the same transaction
  // the account is born in.
  if (body.send) {
    const email = (body.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) badRequest('email is required');
    if (invite!.email && invite!.email.toLowerCase() !== email) {
      badRequest('That invite code was issued to a different email address.', 'wrong_email');
    }
    const redirectTo = (body.redirectTo ?? '').trim();
    if (!APP_REDIRECT.test(redirectTo)) badRequest('redirectTo must be the app deep link');

    // Already a member: no account to create. The app signs them in instead.
    const { data: existing } = await db.from('users').select('id').ilike('email', email).maybeSingle();
    if (existing) return json({ ok: true, existing: true });

    const { error: invErr } = await db.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        invite_code: code,
        ...(body.displayName?.trim() ? { display_name: body.displayName.trim() } : {}),
      },
    });
    if (invErr) throw new Error(`invite email failed: ${invErr.message}`);

    await logActivity(db, {
      type: 'account.invite_sent',
      detail: `Invite ${code} sent to ${email}`,
      metadata: { code },
    });
    return json({ ok: true, sent: true });
  }

  if (!body.redeem) {
    return json({ ok: true, valid: true, email: invite!.email ?? null });
  }

  // ---- redemption --------------------------------------------------------
  const user = await requireUser(req, db);

  // A code addressed to a specific person may only be claimed by that person.
  if (invite!.email && invite!.email.toLowerCase() !== user.email.toLowerCase()) {
    badRequest('That invite code was issued to a different email address.', 'wrong_email');
  }

  // Conditional update: `is('redeemed_by', null)` makes the claim atomic, so
  // two devices racing the same code cannot both succeed.
  const { data: claimed, error: rErr } = await db
    .from('invites')
    .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
    .eq('code', code)
    .is('redeemed_by', null)
    .select()
    .maybeSingle();

  if (rErr) throw new Error(`invite redemption failed: ${rErr.message}`);
  if (!claimed) invalid();

  if (body.displayName?.trim()) {
    await db.from('users').update({ display_name: body.displayName.trim() }).eq('id', user.id);
  }

  await logActivity(db, {
    userId: user.id,
    type: 'account.invite_redeemed',
    detail: `Redeemed invite ${code}`,
    metadata: { code },
  });

  return json({ ok: true, redeemed: true });
}));
