alter table public.wines
  add column if not exists market_value_median numeric,
  add column if not exists market_sources jsonb not null default '[]'::jsonb,
  add column if not exists market_source_count integer not null default 0,
  add column if not exists market_confidence text;

alter table public.wines
  drop constraint if exists wines_market_source_count_nonnegative,
  add constraint wines_market_source_count_nonnegative check (market_source_count >= 0),
  drop constraint if exists wines_market_confidence_check,
  add constraint wines_market_confidence_check check (market_confidence is null or market_confidence in ('low', 'medium', 'high'));

create table if not exists public.market_refresh_source_requests (
  host text primary key,
  last_reserved_at timestamptz not null
);

alter table public.market_refresh_source_requests enable row level security;
revoke all on public.market_refresh_source_requests from public, anon, authenticated;
grant all on public.market_refresh_source_requests to service_role;

create or replace function public.market_refresh_reserve_source_request(
  p_host text,
  p_interval_seconds integer,
  p_backoff_seconds integer default 0
) returns double precision
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wait_seconds double precision;
begin
  if p_host is distinct from 'www.vinatis.it'
    or p_interval_seconds is null or p_interval_seconds not between 1 and 60
    or p_backoff_seconds is null or p_backoff_seconds not between 0 and 604800 then
    raise exception 'Invalid market source request reservation' using errcode = '22023';
  end if;

  insert into public.market_refresh_source_requests as current_request (host, last_reserved_at)
  values (p_host, now())
  on conflict (host) do update
    set last_reserved_at = greatest(
      current_request.last_reserved_at + pg_catalog.make_interval(secs => p_interval_seconds),
      now()
    ) + pg_catalog.make_interval(secs => p_backoff_seconds)
  returning greatest(0, extract(epoch from (last_reserved_at - now())))
    into v_wait_seconds;

  return v_wait_seconds;
end;
$$;

revoke all on function public.market_refresh_reserve_source_request(text, integer, integer) from public, anon, authenticated;
grant execute on function public.market_refresh_reserve_source_request(text, integer, integer) to service_role;

do $$
begin
  update public.market_refresh_runs
  set status = 'failed',
      finished_at = now()
  where trigger = 'weekly' and status = 'in_progress';

  update public.market_refresh_locks
  set lease_until = null,
      run_id = null,
      expires_at = null
  where singleton and run_id in (
    select run_id
    from public.market_refresh_runs
    where trigger = 'weekly' and status = 'failed'
  );

  if pg_catalog.to_regclass('cron.job') is not null then
    execute $query$
      select cron.unschedule(jobid)
      from cron.job
      where jobname in ('weekly-market-refresh', 'weekly-market-refresh-continue')
    $query$;
  end if;
end;
$$;

drop function if exists public.configure_weekly_market_refresh();
