create table if not exists public.market_pricing_pilot_diagnostics (
  run_id uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  requested integer not null check (requested >= 0),
  tested integer not null check (tested >= 0),
  priced integer not null check (priced >= 0),
  unverifiable integer not null check (unverifiable >= 0),
  errors integer not null check (errors >= 0),
  diagnostics jsonb not null check (jsonb_typeof(diagnostics) = 'array')
);

create index if not exists market_pricing_pilot_diagnostics_checked_at_idx
  on public.market_pricing_pilot_diagnostics (checked_at desc);

alter table public.market_pricing_pilot_diagnostics enable row level security;
alter table public.market_pricing_pilot_diagnostics force row level security;
revoke all on public.market_pricing_pilot_diagnostics from public, anon, authenticated;
grant select, insert on public.market_pricing_pilot_diagnostics to service_role;
