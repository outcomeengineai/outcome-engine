-- The first live anchor run reported one unknown station. Kalshi's San
-- Francisco temperature markets resolve at CLISFO.
insert into public.anchor_stations (code, name, lat, lon) values
  ('CLISFO', 'San Francisco (SFO)', 37.6213, -122.3790)
on conflict (code) do nothing;
