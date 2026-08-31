-- ===========================================================================
-- Close an ordering gap in the anon revoke.
--
-- 20260823000200_rls.sql ends with:
--
--   revoke all on all tables in schema public from anon;
--
-- That statement applies to tables existing AT THAT MOMENT. news_cache is
-- created two migrations later, so it never lost its anon grant — confirmed
-- against the live database, where every other table returns 42501 to an
-- anonymous caller and news_cache returned 200 with an empty array.
--
-- No data was exposed: RLS is enabled on news_cache and its only policy grants
-- to `authenticated`, so anonymous reads were already filtered to nothing. But
-- the revoke is the second layer precisely so a policy mistake is not the only
-- thing standing between anon and the data, and news_cache was missing it.
-- ===========================================================================

revoke all on public.news_cache from anon;

-- Same for anything added later: revoking by default means a new table has to
-- be granted access deliberately rather than inheriting it.
alter default privileges in schema public revoke all on tables from anon;
