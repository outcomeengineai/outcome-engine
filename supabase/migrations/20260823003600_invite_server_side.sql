-- ===========================================================================
-- Invite-only, enforced by the server.
--
-- WHY. "No public signup" was enforced by the member app's UI: the invite
-- code was checked client-side, then signInWithOtp created an account for
-- whatever email was submitted. Anyone holding the public anon key -- it
-- ships in the app bundle by design -- could call that endpoint directly
-- and mint an account with no invite. The code was also redeemed by the
-- app after the magic link landed, from a screen that the router had
-- already navigated away from, so it is doubtful the redemption ever ran.
--
-- Now: redeem-invite (service role) validates the code and creates the
-- account itself via auth.admin.inviteUserByEmail, carrying the code in
-- the user's metadata. This trigger -- which already creates the profile
-- when an auth user appears -- reads that code and claims the invite
-- atomically in the same transaction the account is born in. No client
-- step, no window. Public signups get switched off in the dashboard, so
-- the only way an account comes to exist is through an invite.
-- ===========================================================================
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  is_first boolean;
  v_code   text := upper(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
  v_name   text := nullif(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), '');
  v_claimed public.invites%rowtype;
begin
  select count(*) = 0 into is_first from public.users;

  insert into public.users (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(v_name, split_part(new.email, '@', 1)),
    case when is_first then 'admin'::public.user_role else 'member'::public.user_role end
  )
  on conflict (id) do nothing;

  -- Claim the invite this account was created from. Conditional on the
  -- code being unclaimed and, if addressed, addressed to this email, so a
  -- code cannot be reused and a code sent to one person cannot be consumed
  -- by another. If the claim fails the account still exists (it was created
  -- by an admin action), but it is logged loudly.
  if v_code <> '' then
    update public.invites
       set redeemed_by = new.id,
           redeemed_at = now()
     where code = v_code
       and redeemed_by is null
       and (expires_at is null or expires_at > now())
       and (email is null or lower(email) = lower(new.email))
     returning * into v_claimed;

    if v_claimed.code is not null then
      insert into public.activity_log (user_id, event_type, detail, metadata)
      values (new.id, 'account.invite_redeemed', 'Redeemed invite ' || v_code || ' at account creation',
              jsonb_build_object('code', v_code));
    else
      insert into public.activity_log (user_id, event_type, detail, metadata)
      values (new.id, 'account.invite_unclaimed',
              'Account created with invite ' || v_code || ' but the code could not be claimed (used, expired, or addressed elsewhere)',
              jsonb_build_object('code', v_code));
    end if;
  end if;

  return new;
end;
$fn$;
