-- ===========================================================================
-- Manual signal holds, and the news signal put on one.
--
-- WHY. signal_health knows two ways for a signal to be off: a performance
-- break (auto-disabled on hit rate) and a cooldown (disabled_until). A signal
-- that is UNAVAILABLE is neither. A disabled row with no disabled_until reads
-- as an expired cooldown and is flipped back to healthy within the hour.
--
-- News is unavailable. Measured directly against GDELT:
--
--   * one request permitted every five seconds (HTTP 429 otherwise)
--   * ~12 seconds per response when permitted
--
-- The scorer fired 60 concurrent requests with a 2.5s timeout, failing on both
-- counts every pass -- and kept doing so every five minutes, collecting 429s
-- from a free public service for nothing. Done politely it is still hopeless:
-- 800 fast-tier markets at one request per five seconds is 67 minutes per
-- pass against a 5-minute cadence. The per-market article search that the
-- signal was designed around cannot run on this source at all.
--
-- A hold is set by a person, states why, and is lifted by a person. The
-- health job leaves held signals alone; the scorer treats them as disabled
-- and does not fetch.
-- ===========================================================================
alter table public.signal_health
  add column hold_reason text;

comment on column public.signal_health.hold_reason is
  'Non-null puts the signal on a manual hold: treated as disabled by the '
  'scorer, never auto-re-enabled by signal-health. For unavailability, not '
  'performance -- performance is what the automatic breaker is for.';

update public.signal_health
   set status          = 'disabled',
       disabled_until  = null,
       disabled_reason = 'Held: source unavailable (see hold_reason).',
       hold_reason     =
         'GDELT permits one request per five seconds and answers in ~12s; '
         'per-market article search cannot run at 800 markets per 5-minute '
         'pass. Held until a viable news source exists. Set by migration '
         '20260823002000 on 2026-09-11.',
       computed_at     = now()
 where signal = 'news';

insert into public.activity_log (event_type, detail, metadata)
values (
  'signal.held',
  'news held: GDELT rate-limited to 1 req/5s with ~12s latency; unusable at platform scale',
  jsonb_build_object('signal', 'news', 'source', 'GDELT', 'rate_limit', '1/5s', 'latency_s', 12)
);
