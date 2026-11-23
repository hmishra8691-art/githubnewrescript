-- 0117 — NETWORK SIGNALS, THE FREE LAYER (Level 5 roadmap F2, 2026-11-23). Needs 0084.
--
--   ip_range_sources   one row per published list (AWS, Google Cloud, Oracle, DigitalOcean, Linode, Cloudflare, the
--                      Tor exit list, or a licensed / operator feed): when it was last refreshed, how many ranges,
--                      the last error. Written by the Studio's ip-ranges job.
--   ip_ranges          the ranges themselves, one row per CIDR block and source, kind datacenter / tor / vpn / proxy.
--                      GiST-indexed for `cidr >>= inet`.
--
--   rescript_ip_ranges_replace(source, kind, provider, cidrs)   swaps one source's ranges in one transaction
--   rescript_ip_signals(ip)                                     what the ranges say about one address
--
-- The runtime's gateway asks rescript_ip_signals at admission with the arriving address; the address itself is not
-- stored (network_reputation keeps only its hash, as before). Shared, platform-wide data (the lists are public):
-- no customer column. Row-level security on, no policy (service role only).
--
-- Additive. Rollback:
--   drop function if exists public.rescript_ip_signals(inet);
--   drop function if exists public.rescript_ip_ranges_replace(text, text, text, text[]);
--   drop table if exists public.ip_ranges; drop table if exists public.ip_range_sources;

create table if not exists public.ip_range_sources (
  source        text primary key check (source ~ '^[a-z0-9_-]{2,40}$'),
  kind          text not null check (kind in ('datacenter', 'tor', 'vpn', 'proxy')),
  provider      text not null check (char_length(provider) <= 120),
  ranges        integer not null default 0,
  refreshed_at  timestamptz,
  last_error    text check (last_error is null or char_length(last_error) <= 500),
  checked_at    timestamptz not null default now()
);
alter table public.ip_range_sources enable row level security;

create table if not exists public.ip_ranges (
  source  text not null references public.ip_range_sources(source) on delete cascade,
  kind    text not null check (kind in ('datacenter', 'tor', 'vpn', 'proxy')),
  cidr    cidr not null,
  primary key (source, cidr)
);
create index if not exists ip_ranges_cidr_gist on public.ip_ranges using gist (cidr inet_ops);
alter table public.ip_ranges enable row level security;

create or replace function public.rescript_ip_ranges_replace(p_source text, p_kind text, p_provider text, p_cidrs text[])
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if coalesce(array_length(p_cidrs, 1), 0) = 0 then raise exception 'IP_RANGES_EMPTY %', p_source; end if;
  insert into public.ip_range_sources (source, kind, provider) values (p_source, p_kind, p_provider)
  on conflict (source) do update set kind = excluded.kind, provider = excluded.provider;
  delete from public.ip_ranges where source = p_source;
  insert into public.ip_ranges (source, kind, cidr)
    -- network(): a block written with host bits set (192.0.2.1/24) is stored as its network (192.0.2.0/24)
    select distinct p_source, p_kind, network(c::inet) from unnest(p_cidrs) c
  on conflict do nothing;
  get diagnostics n = row_count;
  update public.ip_range_sources set ranges = n, refreshed_at = now(), last_error = null, checked_at = now() where source = p_source;
  return n;
end $$;

create or replace function public.rescript_ip_signals(p_ip inet)
returns table (datacenter boolean, tor boolean, vpn boolean, proxy boolean, providers text[])
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(r.kind = 'datacenter'), false),
         coalesce(bool_or(r.kind = 'tor'), false),
         coalesce(bool_or(r.kind = 'vpn'), false),
         coalesce(bool_or(r.kind = 'proxy'), false),
         coalesce(array_agg(distinct s.provider) filter (where s.provider is not null), '{}')
    from public.ip_ranges r join public.ip_range_sources s on s.source = r.source
   where r.cidr >>= p_ip;
$$;

revoke all on function public.rescript_ip_ranges_replace(text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.rescript_ip_signals(inet) from public, anon, authenticated;

insert into public.schema_marks (migration, note) values ('0117', 'ip_ranges / ip_range_sources: published datacenter and Tor ranges for admission (F2 free layer)')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
