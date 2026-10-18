create table if not exists public.wine_purchase_requests (
  request_id uuid not null,
  user_id uuid not null default auth.uid(),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

alter table public.wine_purchase_requests enable row level security;
drop policy if exists wine_purchase_requests_authenticated on public.wine_purchase_requests;
create policy wine_purchase_requests_authenticated on public.wine_purchase_requests
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert on public.wine_purchase_requests to authenticated;
grant all on public.wine_purchase_requests to service_role;

create or replace function public.add_wine_purchase(
  p_request_id uuid,
  p_wine_id text,
  p_name text,
  p_producer text,
  p_vintage integer,
  p_category text,
  p_quantity integer,
  p_unit_price numeric,
  p_acquisition_type text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_wine_id public.wines.id%type;
  v_candidate_id public.wines.id%type;
  v_quantity integer;
  v_matches integer;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_request_id is null or nullif(btrim(p_name), '') is null or p_quantity < 1 then
    raise exception 'Invalid purchase request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    lower(btrim(p_name)) || chr(31) || lower(btrim(coalesce(p_producer, ''))) || chr(31) || coalesce(p_vintage::text, 'S.A.'), 0
  ));

  select r.result into v_result
  from public.wine_purchase_requests r
  where r.request_id = p_request_id and r.user_id = auth.uid();
  if found then
    return v_result;
  end if;

  if p_wine_id is null then
    select count(*), (array_agg(w.id))[1]
      into v_matches, v_candidate_id
    from public.wines w
    where lower(btrim(w.name)) = lower(btrim(p_name))
      and lower(btrim(coalesce(w.producer, ''))) = lower(btrim(coalesce(p_producer, '')))
      and w.vintage is not distinct from p_vintage;

    if v_matches > 1 then
      return jsonb_build_object('requires_selection', true);
    elsif v_matches = 1 then
      return jsonb_build_object(
        'requires_confirmation', true,
        'wine_id', v_candidate_id::text,
        'quantity', (select w.quantity from public.wines w where w.id = v_candidate_id)
      );
    end if;

    insert into public.wines (name, producer, vintage, category, quantity, acquisition_type, purchase_price, priority, status)
    values (btrim(p_name), nullif(btrim(p_producer), ''), p_vintage, p_category, p_quantity, p_acquisition_type, p_unit_price, 'orange', 'Da valutare')
    returning id, quantity into v_wine_id, v_quantity;
  else
    select w.id, w.quantity into v_wine_id, v_quantity
    from public.wines w
    where w.id::text = p_wine_id
      and lower(btrim(w.name)) = lower(btrim(p_name))
      and lower(btrim(coalesce(w.producer, ''))) = lower(btrim(coalesce(p_producer, '')))
      and w.vintage is not distinct from p_vintage
    for update;
    if not found then
      raise exception 'Selected wine no longer matches the purchase' using errcode = '22023';
    end if;
    update public.wines
      set quantity = coalesce(quantity, 0) + p_quantity
      where id = v_wine_id
      returning quantity into v_quantity;
  end if;

  insert into public.purchase_lots (wine_id, quantity, unit_price, acquisition_type)
  values (v_wine_id, p_quantity, p_unit_price, p_acquisition_type);

  insert into public.cellar_events (wine_id, wine_name, vintage, event_type, quantity_delta)
  values (v_wine_id, btrim(p_name), p_vintage, 'added', p_quantity);

  v_result := jsonb_build_object('wine_id', v_wine_id::text, 'quantity', v_quantity, 'created', p_wine_id is null);
  insert into public.wine_purchase_requests (request_id, user_id, result) values (p_request_id, auth.uid(), v_result);
  return v_result;
end;
$$;

revoke all on function public.add_wine_purchase(uuid, text, text, text, integer, text, integer, numeric, text) from public, anon;
grant execute on function public.add_wine_purchase(uuid, text, text, text, integer, text, integer, numeric, text) to authenticated;

create table if not exists public.market_refresh_runs (
  run_id uuid primary key,
  trigger text not null check (trigger in ('manual', 'weekly')),
  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  progress jsonb not null default '{"next_index":0}'::jsonb,
  summary jsonb not null default '{"updated":0,"unchanged":0,"unverifiable":0,"errors":0}'::jsonb
);
create index if not exists market_refresh_runs_trigger_status_started_idx
  on public.market_refresh_runs (trigger, status, started_at desc);

create table if not exists public.market_refresh_items (
  run_id uuid not null references public.market_refresh_runs(run_id) on delete cascade,
  wine_id text not null,
  status text not null check (status in ('updated', 'unchanged', 'unverifiable', 'error')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, wine_id)
);

create table if not exists public.market_refresh_locks (
  singleton boolean primary key default true check (singleton),
  run_id uuid,
  lease_until timestamptz,
  expires_at timestamptz
);
insert into public.market_refresh_locks (singleton) values (true) on conflict (singleton) do nothing;

alter table public.market_refresh_runs enable row level security;
alter table public.market_refresh_items enable row level security;
alter table public.market_refresh_locks enable row level security;
grant all on public.market_refresh_runs, public.market_refresh_items, public.market_refresh_locks to service_role;

create or replace function public.market_refresh_try_lock(p_run_id uuid, p_trigger text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquired boolean;
begin
  if p_trigger not in ('manual', 'weekly') then
    raise exception 'Invalid refresh trigger' using errcode = '22023';
  end if;
  update public.market_refresh_locks
    set run_id = p_run_id,
        lease_until = now() + interval '15 minutes',
        expires_at = case when run_id = p_run_id and expires_at > now() then expires_at else now() + interval '8 days' end
    where singleton
      and (lease_until is null or lease_until <= now())
      and (run_id is null or run_id = p_run_id or expires_at <= now());
  v_acquired := found;
  if v_acquired then
    insert into public.market_refresh_runs (run_id, trigger)
    values (p_run_id, p_trigger)
    on conflict (run_id) do nothing;
  end if;
  return v_acquired;
end;
$$;

create or replace function public.market_refresh_release_lock(p_run_id uuid, p_status text, p_progress jsonb, p_summary jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('in_progress', 'completed', 'failed') then
    raise exception 'Invalid refresh status' using errcode = '22023';
  end if;
  update public.market_refresh_runs
    set status = p_status,
        progress = coalesce(p_progress, progress),
        summary = coalesce(p_summary, summary),
        finished_at = case when p_status in ('completed', 'failed') then now() else null end
    where run_id = p_run_id;
  update public.market_refresh_locks
    set lease_until = null,
        run_id = case when p_status = 'in_progress' then run_id else null end,
        expires_at = case when p_status = 'in_progress' then expires_at else null end
    where singleton and run_id = p_run_id;
end;
$$;

revoke all on function public.market_refresh_try_lock(uuid, text) from public, anon, authenticated;
revoke all on function public.market_refresh_release_lock(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.market_refresh_try_lock(uuid, text) to service_role;
grant execute on function public.market_refresh_release_lock(uuid, text, jsonb, jsonb) to service_role;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.configure_weekly_market_refresh()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url_configured boolean := false;
  v_token_configured boolean := false;
begin
  if pg_catalog.to_regclass('vault.decrypted_secrets') is not null then
    execute $query$
            select exists(select 1 from vault.decrypted_secrets where name = 'project_url' and decrypted_secret like 'https://%'),
              exists(select 1 from vault.decrypted_secrets where name = 'market_refresh_cron_token' and length(decrypted_secret) >= 32)
    $query$ into v_url_configured, v_token_configured;
  end if;
  if not coalesce(v_url_configured, false) or not coalesce(v_token_configured, false) then
    raise notice 'Weekly market refresh not scheduled: configure project_url and market_refresh_cron_token in Supabase Vault, then run configure_weekly_market_refresh().';
    return false;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname in ('weekly-market-refresh', 'weekly-market-refresh-continue');
  perform cron.schedule(
    'weekly-market-refresh',
    '0 6 * * 1',
    $job$
      select net.http_post(
        url := pg_catalog.rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/market-refresh-weekly',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_refresh_cron_token')
        ),
        body := '{"action":"start"}'::jsonb
      );
    $job$
  );
  perform cron.schedule(
    'weekly-market-refresh-continue',
    '*/10 * * * *',
    $job$
      select net.http_post(
        url := pg_catalog.rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'project_url'), '/') || '/functions/v1/market-refresh-weekly',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'market_refresh_cron_token')
        ),
        body := '{"action":"continue"}'::jsonb
      );
    $job$
  );
  return true;
end;
$$;
revoke all on function public.configure_weekly_market_refresh() from public, anon, authenticated;

DO $$
begin
  perform public.configure_weekly_market_refresh();
end;
$$;
