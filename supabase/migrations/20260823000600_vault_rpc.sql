-- ===========================================================================
-- Vault wrappers.
--
-- PostgREST cannot reach the `vault` schema directly, so the Edge Functions
-- go through these three SECURITY DEFINER wrappers instead. Execute is granted
-- to service_role ONLY — never to authenticated — so a member's JWT cannot
-- reach a Kalshi key even with a valid secret id in hand.
-- ===========================================================================

create or replace function public.vault_create_secret(
  p_secret      text,
  p_name        text,
  p_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  select vault.create_secret(p_secret, p_name, p_description) into v_id;
  return v_id;
end;
$$;

create or replace function public.vault_read_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where id = p_id;
  return v_secret;
end;
$$;

create or replace function public.vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = p_id;
end;
$$;

-- Lock these down hard. The default grant to PUBLIC on a new function is
-- exactly the mistake that would make the whole Vault design decorative.
revoke all on function public.vault_create_secret(text, text, text) from public, anon, authenticated;
revoke all on function public.vault_read_secret(uuid)              from public, anon, authenticated;
revoke all on function public.vault_delete_secret(uuid)            from public, anon, authenticated;

grant execute on function public.vault_create_secret(text, text, text) to service_role;
grant execute on function public.vault_read_secret(uuid)               to service_role;
grant execute on function public.vault_delete_secret(uuid)             to service_role;

-- Deleting a connection row should not orphan its secret in Vault.
create or replace function public.cleanup_kalshi_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = old.vault_secret_ref;
  return old;
end;
$$;

create trigger kalshi_connections_cleanup_secret
  after delete on public.kalshi_connections
  for each row execute function public.cleanup_kalshi_secret();
