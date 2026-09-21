-- ---------------------------------------------------------------------------
-- Row-Level Security, append-only triggers, and the runtime roles.
--
-- Applied by scripts/migrate.ts AFTER the Drizzle-generated DDL. Idempotent:
-- safe to re-run on every migrate.
--
-- Role model (O-22, SECURITY.md T1/T5):
--   * MIGRATION role (king / your managed-PG owner): DDL, policies, table
--     ownership. Runs migrations. NEVER used by the web or worker process.
--   * app_server: the runtime role. NOSUPERUSER, NOBYPASSRLS, owns nothing.
--     The web process, the worker, and every background job connect as this.
--   * app_system: NOLOGIN, BYPASSRLS. Owns only the SECURITY DEFINER queue-
--     dispatch functions below. It cannot log in; app_server reaches its
--     narrow, audited elevation solely by EXECUTE on those functions. This is
--     how a worker claims a job across workspaces without app_server itself
--     holding BYPASSRLS.
--
-- Tenant contract:
--   * withTenant() stamps app.user_id / app.org_id / app.project_id as
--     transaction-local GUCs (SET LOCAL semantics via set_config(...,true)),
--     so nothing leaks across pooled connections. Policies read them via the
--     app.current_*() helpers, which return NULL when unset → fail closed.
--   * Tenant tables: single-table predicate on (org_id, project_id).
--   * Navigation tables (organizations, memberships, projects, project_members)
--     key off membership so the pre-tenant bootstrap works with only
--     app.user_id set (withUser). They never expose a tenant the user is not a
--     member of.
--   * messages + audit_logs: UPDATE/DELETE raise, always, for every role.
-- ---------------------------------------------------------------------------

-- Helper functions -----------------------------------------------------------

create schema if not exists app;

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app.current_project_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.project_id', true), '')::uuid
$$;

-- Membership predicates used INSIDE the navigation-table policies. They must be
-- SECURITY DEFINER (owned by the BYPASSRLS app_system, set below) so their
-- internal reads of memberships/project_members do NOT re-enter those tables'
-- own RLS policies — otherwise a policy that queries its own table recurses
-- infinitely. This latent trap only surfaces once the app connects as a
-- non-superuser (O-22); under the dev superuser RLS was never evaluated.
create or replace function app.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from memberships
    where org_id = p_org and user_id = app.current_user_id()
  )
$$;

create or replace function app.is_project_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from project_members
    where project_id = p_project and user_id = app.current_user_id()
  )
$$;

-- Runtime roles --------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server login password 'app_server_dev_only' nosuperuser nobypassrls;
  end if;
  -- Defensive: a role someone created by hand must not carry bypass/superuser.
  alter role app_server nosuperuser nobypassrls nocreatedb nocreaterole;

  if not exists (select 1 from pg_roles where rolname = 'app_system') then
    create role app_system nologin nosuperuser bypassrls;
  end if;
  alter role app_system nologin nosuperuser bypassrls;
end
$$;

grant usage on schema public to app_server;
grant usage on schema app to app_server;

-- Table privileges: deliberately NOT "grant all".
grant select, insert, update on
  organizations, memberships, projects, project_members,
  agents, departments, project_context_items, integration_secrets,
  tasks, runs, run_steps, artifacts, approvals,
  objectives, milestones, knowledge_items, task_schedules,
  documents, document_versions, document_chunks, document_version_tombstones, object_cleanup_operations, document_purge_operations, run_document_versions, task_dependencies, decisions, decision_injections, knowledge_injections, knowledge_sources, knowledge_verification_events, knowledge_disclosure_grants, document_disclosure_grants, knowledge_proposals, ai_operations, run_jobs, document_jobs,
  work_items,
  instruments, watchlists, watchlist_items, market_quotes, research_notes, trade_theses, paper_portfolios, paper_positions, paper_orders, paper_fills, risk_limits, restricted_symbols, risk_checks, kill_switches,
  usage_events, spend_limits, rate_limit_buckets, profiles
to app_server;

-- Re-index replaces a document's chunks wholesale, so chunks and documents
-- both need DELETE. The `search` tsvector is generated, never written directly.
-- app_server deliberately has NO delete on document_versions or
-- document_disclosure_grants: immutable version rows (and their disclosure grants)
-- may be removed ONLY through the admin-authorized document PURGE, which runs as a
-- dedicated least-privilege `purge_agent` role on a separate connection (below).
grant delete on
  rate_limit_buckets, integration_secrets, project_context_items,
  documents, document_chunks, task_dependencies, run_jobs, document_jobs,
  -- Trading: only the mutable curation lists are deletable; orders/fills/positions/risk_checks are never hard-deleted.
  watchlists, watchlist_items, restricted_symbols
to app_server;
-- Belt: revoke any previously-granted delete on immutable version rows from app_server. Purge is the ONLY
-- deletion path for these, and it runs as purge_agent (below) — app_server must never delete them directly.
revoke delete on document_versions, document_disclosure_grants from app_server;

-- Append-only tables: INSERT and SELECT only. No UPDATE grant at all.
grant select, insert on messages, audit_logs to app_server;

grant usage on all sequences in schema public to app_server;

-- purge_agent (O-23 document purge) -----------------------------------------
-- A dedicated least-privilege role for the DATABASE-authoritative document purge
-- ONLY. It is NOSUPERUSER + NOBYPASSRLS (every statement is still tenant-scoped by
-- the same RLS policies), has NO schema/role/DDL rights, and — critically — is
-- NOT granted to app_server, so ordinary application code (which connects as
-- app_server) can never assume it. The purge execution path uses a SEPARATE
-- connection as this role; app_server has no delete on immutable version rows, so
-- a version can only be deleted through the admin-authorized, quarantined,
-- retention-elapsed, exact-state-verified purge lifecycle that runs here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'purge_agent') then
    create role purge_agent login password 'purge_agent_dev_only' nosuperuser nobypassrls;
  end if;
  alter role purge_agent nosuperuser nobypassrls nocreatedb nocreaterole;
end
$$;

grant usage on schema public to purge_agent;
grant usage on schema app to purge_agent;
grant execute on function app.current_user_id(), app.current_org_id(), app.current_project_id() to purge_agent;
-- Reads for the final reference-closure + exact-state re-checks inside the purge txn.
grant select on
  documents, document_versions, document_chunks, document_disclosure_grants, document_jobs,
  document_version_tombstones, document_purge_operations, knowledge_sources, run_document_versions, runs, object_cleanup_operations
to purge_agent;
-- The exact writes the purge lifecycle performs — and nothing else.
grant insert on document_version_tombstones to purge_agent;
grant select, insert on audit_logs to purge_agent; -- append-only (trigger forbids update/delete for every role); SELECT for the hash-chain head
grant update on document_purge_operations, document_version_tombstones to purge_agent;
grant delete on
  document_chunks, document_jobs, document_disclosure_grants, document_versions, documents
to purge_agent;
grant usage on all sequences in schema public to purge_agent;

-- app_system owns the dispatch functions and touches only the queue + the
-- identity columns those functions read. It has BYPASSRLS, so it still needs
-- explicit table privileges (bypass affects row filtering, not GRANTs).
grant usage on schema public to app_system;
grant usage on schema app to app_system;  -- the definer fns call app.current_*()
grant select, update on run_jobs, document_jobs to app_system;
grant select on task_schedules to app_system;  -- the standing-tick dispatcher
-- Profile adoption (app.adopt_placeholder_profile) reassigns a seed
-- placeholder's rows to the real auth user — a cross-identity provisioning step
-- confined to that one fixed function body.
grant select, insert, update, delete on profiles to app_system;
grant select, update on tasks, project_members, memberships, project_context_items, approvals to app_system;

-- Append-only enforcement ----------------------------------------------------
-- Belt (no UPDATE grant) and braces (trigger), because a future GRANT ALL
-- should not silently make history mutable.

create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % blocked (row id %)',
    tg_table_name, tg_op, coalesce(old.id::text, '?')
    using errcode = 'raise_exception';
end
$$;

-- HUB-006 correction 1: a redacted, searchable representation of an audit detail payload. Free-text audit
-- search matches over THIS, never the raw detail, so a stored secret VALUE can never influence a match,
-- a count, or the empty-result signal. Secret-bearing KEYS (case-insensitive, at any nesting depth) have
-- their values replaced with '[redacted]' before matching; key NAMES and non-sensitive values remain
-- searchable. The deny-list mirrors the app-layer redactAuditDetail() so display and search agree.
create or replace function app.redact_audit_detail(v jsonb) returns jsonb
language plpgsql immutable parallel safe as $$
declare
  result jsonb;
  k text;
  val jsonb;
begin
  if v is null then return v; end if;
  if jsonb_typeof(v) = 'object' then
    result := '{}'::jsonb;
    for k, val in select * from jsonb_each(v) loop
      if k ~* '(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret|bearer)' then
        result := result || jsonb_build_object(k, '[redacted]');
      else
        result := result || jsonb_build_object(k, app.redact_audit_detail(val));
      end if;
    end loop;
    return result;
  elsif jsonb_typeof(v) = 'array' then
    select coalesce(jsonb_agg(app.redact_audit_detail(e)), '[]'::jsonb) into result from jsonb_array_elements(v) e;
    return result;
  else
    return v;
  end if;
end
$$;
grant execute on function app.redact_audit_detail(jsonb) to app_server, purge_agent;

drop trigger if exists messages_append_only on messages;
create trigger messages_append_only
  before update or delete on messages
  for each row execute function app.forbid_mutation();

drop trigger if exists audit_logs_append_only on audit_logs;
create trigger audit_logs_append_only
  before update or delete on audit_logs
  for each row execute function app.forbid_mutation();

-- Knowledge support-judgment events are append-only: a later resolution failure must never rewrite a
-- historical judgment.
drop trigger if exists knowledge_verification_events_append_only on knowledge_verification_events;
create trigger knowledge_verification_events_append_only
  before update or delete on knowledge_verification_events
  for each row execute function app.forbid_mutation();

-- Hub P1d run execution checkpoints — tenant RLS (org_id, project_id) + append-only, applied in ONE guarded
-- block so rls.sql stays resilient when it is run against a database that has not yet applied migration 0056
-- (the incremental-bootstrap path applies the CURRENT rls.sql against the penultimate schema). On a real,
-- fully-migrated database the table always exists, so every statement below runs. Posture matches messages:
-- INSERT/SELECT only (no UPDATE grant) + a trigger that blocks UPDATE/DELETE for every role — a checkpoint
-- records what a run's step produced and must never be rewritten or deleted (a re-attempt appends under a new
-- execution_attempt_id). Does not weaken any existing policy; it only adds this table's.
do $$
begin
  if to_regclass('public.run_execution_checkpoints') is not null then
    grant select, insert on run_execution_checkpoints to app_server;
    alter table run_execution_checkpoints enable row level security;
    alter table run_execution_checkpoints force row level security;
    drop policy if exists run_execution_checkpoints_tenant on run_execution_checkpoints;
    create policy run_execution_checkpoints_tenant on run_execution_checkpoints
      using (org_id = app.current_org_id() and project_id = app.current_project_id())
      with check (org_id = app.current_org_id() and project_id = app.current_project_id());
    drop trigger if exists run_execution_checkpoints_append_only on run_execution_checkpoints;
    create trigger run_execution_checkpoints_append_only
      before update or delete on run_execution_checkpoints
      for each row execute function app.forbid_mutation();
  end if;
end
$$;

-- Document VERSIONS are immutable evidence (Documents increment 1). The content-identity facts can
-- NEVER change after insert; the only permitted mutation is the one-way index transition pending →
-- indexed | failed (setting indexed_at / error_message). This is the hard backstop under the narrow
-- version service — ordinary code cannot rewrite an established version, nor return it to pending.
create or replace function app.document_version_guard()
returns trigger as $$
begin
  if NEW.sha256 is distinct from OLD.sha256
     or NEW.size_bytes is distinct from OLD.size_bytes
     or NEW.document_id is distinct from OLD.document_id
     or NEW.org_id is distinct from OLD.org_id
     or NEW.project_id is distinct from OLD.project_id
     or NEW.object_key is distinct from OLD.object_key
     or NEW.mime_type is distinct from OLD.mime_type
     or NEW.content_fidelity is distinct from OLD.content_fidelity
     or NEW.disclosure_snapshot is distinct from OLD.disclosure_snapshot
     or NEW.source_revision_id is distinct from OLD.source_revision_id
     or NEW.source_modified_at is distinct from OLD.source_modified_at
     or NEW.parser_version is distinct from OLD.parser_version
     or NEW.ingestion_operation_id is distinct from OLD.ingestion_operation_id
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'document_versions: immutable version facts cannot be changed (id=%)', OLD.id;
  end if;
  if OLD.index_status <> 'pending' and NEW.index_status is distinct from OLD.index_status then
    raise exception 'document_versions: index status is terminal once set (id=%)', OLD.id;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists document_versions_immutable on document_versions;
create trigger document_versions_immutable
  before update on document_versions
  for each row execute function app.document_version_guard();

-- Content-fidelity consistency: byte_exact must have a retained object key. (Hash verification is a
-- service-level check on the bytes; this guards the simple nullability relationship at the DB.)
alter table document_versions drop constraint if exists document_versions_byte_exact_has_object;
alter table document_versions
  add constraint document_versions_byte_exact_has_object
  check (content_fidelity <> 'byte_exact' or object_key is not null);

-- Queue-dispatch functions (O-22) --------------------------------------------
-- The worker must claim/scan run_jobs ACROSS workspaces (it does not yet know
-- whose job is next). That single cross-tenant step is the only thing that
-- cannot run under a per-tenant GUC, so it is confined to these SECURITY
-- DEFINER functions owned by app_system (BYPASSRLS). Everything the worker
-- does AFTER a claim — executing the run, writing runs/steps/audit — happens
-- under withTenant() with RLS fully enforced. app_server can ONLY do what
-- these functions expose; it never gains general cross-tenant read.
--
-- `set search_path` is pinned so a malicious search_path cannot redirect the
-- table references inside a definer function.

create or replace function app.claim_next_run_job(p_lease_ms bigint)
returns table (
  job_id uuid, task_id uuid, org_id uuid, project_id uuid,
  created_by uuid, project_role text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v run_jobs;
begin
  update run_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         leased_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         -- Hub P1d: stamp a liveness beat at claim. Stage 2 renews it during the run.
         heartbeat_at = now(),
         updated_at = now()
   where j.id = (
     select rj.id from run_jobs rj
      where rj.status = 'queued'
         or (rj.status = 'running' and rj.leased_until < now())
      order by rj.created_at
      for update skip locked
      limit 1
   )
  returning j.* into v;

  if not found then
    return;
  end if;

  job_id := v.id;
  task_id := v.task_id;
  org_id := v.org_id;
  project_id := v.project_id;
  select t.created_by into created_by from tasks t where t.id = v.task_id;
  select pm.role into project_role
    from project_members pm
   where pm.project_id = v.project_id and pm.user_id = created_by
   limit 1;
  return next;
end
$$;

create or replace function app.claim_run_job_for_task(
  p_task uuid, p_org uuid, p_project uuid, p_lease_ms bigint
)
returns table (
  job_id uuid, task_id uuid, org_id uuid, project_id uuid,
  created_by uuid, project_role text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v run_jobs;
begin
  update run_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         leased_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         -- Hub P1d: stamp a liveness beat at claim. Stage 2 renews it during the run.
         heartbeat_at = now(),
         updated_at = now()
   where j.id = (
     select rj.id from run_jobs rj
      where rj.task_id = p_task and rj.org_id = p_org and rj.project_id = p_project
        and (rj.status = 'queued' or (rj.status = 'running' and rj.leased_until < now()))
      for update skip locked
      limit 1
   )
  returning j.* into v;

  if not found then
    return;
  end if;

  job_id := v.id;
  task_id := v.task_id;
  org_id := v.org_id;
  project_id := v.project_id;
  select t.created_by into created_by from tasks t where t.id = v.task_id;
  select pm.role into project_role
    from project_members pm
   where pm.project_id = v.project_id and pm.user_id = created_by
   limit 1;
  return next;
end
$$;

create or replace function app.list_stale_run_jobs()
returns table (
  job_id uuid, task_id uuid, org_id uuid, project_id uuid,
  task_status text, created_by uuid, project_role text
)
language sql security definer set search_path = public, pg_temp as $$
  select j.id, j.task_id, j.org_id, j.project_id,
         t.status, t.created_by,
         (select pm.role from project_members pm
           where pm.project_id = j.project_id and pm.user_id = t.created_by limit 1)
  from run_jobs j
  left join tasks t on t.id = j.task_id
  where j.status = 'running'
    and (j.leased_until < now() or j.leased_until is null)
$$;

create or replace function app.finish_run_job(p_id uuid, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update run_jobs
     set status = p_status::run_job_status,
         last_error = left(p_error, 500),
         updated_at = now()
   where id = p_id;
end
$$;

create or replace function app.requeue_run_job(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update run_jobs
     set status = 'queued', leased_until = null, updated_at = now()
   where id = p_id;
end
$$;

-- Hub P1d — the lease OWNERSHIP token is the job's `attempts` counter (exact integer, no timestamp-precision
-- pitfalls). A claim/reclaim increments it, so a superseded worker's token no longer matches. app_server has
-- no direct cross-tenant read of run_jobs, so the worker reads its token through this definer right after a
-- claim.
create or replace function app.run_job_attempt(p_id uuid)
returns int language sql security definer set search_path = public, pg_temp as $$
  select attempts from run_jobs where id = p_id;
$$;

-- Hub P1d — renew the lease + liveness heartbeat IFF this worker still owns the job: it is still `running`
-- AND its `attempts` token is unchanged (not reclaimed). Returns true when ownership held (lease extended),
-- false once another worker reclaimed it. Used by the runner to re-confirm ownership before every provider
-- dispatch and before the terminal finalize commit, so a stale worker can never overwrite the winner.
create or replace function app.renew_run_job_lease(p_id uuid, p_attempt int, p_lease_ms bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update run_jobs
     set leased_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_id and status = 'running' and attempts = p_attempt;
  return found;
end
$$;

-- Document-indexing dispatch (O-23): the worker claims document_jobs across
-- workspaces exactly like run_jobs. Same SECURITY DEFINER pattern; indexing then
-- runs under withTenant() with the job's persisted (org, project).
create or replace function app.claim_next_document_job(p_lease_ms bigint)
returns table (
  job_id uuid, document_id uuid, org_id uuid, project_id uuid,
  created_by uuid, project_role text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v document_jobs;
begin
  update document_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         leased_until = now() + make_interval(secs => p_lease_ms / 1000.0),
         updated_at = now()
   where j.id = (
     select dj.id from document_jobs dj
      where dj.status = 'queued'
         or (dj.status = 'running' and dj.leased_until < now())
      order by dj.created_at
      for update skip locked
      limit 1
   )
  returning j.* into v;
  if not found then return; end if;
  job_id := v.id; document_id := v.document_id;
  org_id := v.org_id; project_id := v.project_id;
  -- No per-user identity: indexing is a system operation scoped by (org,project);
  -- created_by/project_role are returned null and the worker uses a system ctx.
  created_by := null; project_role := null;
  return next;
end
$$;

create or replace function app.finish_document_job(p_id uuid, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update document_jobs
     set status = p_status::document_job_status,
         last_error = left(p_error, 500),
         updated_at = now()
   where id = p_id;
end
$$;

create or replace function app.requeue_document_job(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update document_jobs
     set status = 'queued', leased_until = null, updated_at = now()
   where id = p_id;
end
$$;

create or replace function app.list_stale_document_jobs()
returns table (job_id uuid, document_id uuid, org_id uuid, project_id uuid)
language sql security definer set search_path = public, pg_temp as $$
  select j.id, j.document_id, j.org_id, j.project_id
  from document_jobs j
  where j.status = 'running' and (j.leased_until < now() or j.leased_until is null)
$$;

-- Standing-work dispatch (O-22): the hourly tick scans task_schedules ACROSS
-- workspaces to find due ones — the same cross-tenant step as the run worker.
-- Returns only the identity tuple + author role; the tick then reads each full
-- schedule row and does all writes UNDER withTenant(), RLS enforced.
create or replace function app.list_due_schedules(p_now timestamptz)
returns table (
  schedule_id uuid, org_id uuid, project_id uuid, created_by uuid, project_role text
)
language sql security definer set search_path = public, pg_temp as $$
  select s.id, s.org_id, s.project_id, s.created_by,
         (select pm.role from project_members pm
           where pm.project_id = s.project_id and pm.user_id = s.created_by limit 1)
  from task_schedules s
  where s.enabled = true and s.next_run_at <= p_now
$$;

-- Worker/queue health (O-22): the /api/health worker-liveness signal counts
-- run_jobs across tenants. app_server has no cross-tenant read, so this fixed
-- aggregate (no row data) is exposed as a definer function instead.
create or replace function app.run_jobs_health()
returns table (queued bigint, recent bigint)
language sql security definer set search_path = public, pg_temp as $$
  select
    count(*) filter (where status = 'queued'),
    count(*) filter (where updated_at > now() - interval '5 minutes')
  from run_jobs
$$;

-- Profile adoption (Sprint 1 issue #2, now app_server-safe). The seed may hold a
-- placeholder profile (random id) carrying the owner's memberships so their
-- workspaces exist before first sign-up. First real sign-in arrives with the
-- SAME email under the auth id; we must move the placeholder's references to
-- the auth id and drop it. This is a cross-identity write — impossible under a
-- per-user RLS context — so it lives in one fixed SECURITY DEFINER body.
-- Returns: 'relinked' | 'conflict' | 'upserted' (the caller logs).
create or replace function app.adopt_placeholder_profile(
  p_auth_id uuid, p_email text, p_display text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_placeholder uuid;
  v_self_exists boolean;
begin
  select id into v_placeholder from profiles where email = p_email limit 1;
  select exists (select 1 from profiles where id = p_auth_id) into v_self_exists;

  if v_placeholder is not null and v_placeholder <> p_auth_id then
    if v_self_exists then
      -- Two REAL histories (auth profile under an old email + another profile
      -- holding this email). Merging implicitly is unsafe — surface it.
      return 'conflict';
    end if;
    -- Temporary unique email so the real one can move over afterwards.
    insert into profiles (id, email, display_name)
      values (p_auth_id, 'relinking-' || p_auth_id::text || '@invalid.local', p_display);
    update memberships          set user_id    = p_auth_id where user_id    = v_placeholder;
    update project_members      set user_id    = p_auth_id where user_id    = v_placeholder;
    update project_context_items set created_by = p_auth_id where created_by = v_placeholder;
    update tasks                set created_by  = p_auth_id where created_by  = v_placeholder;
    update approvals            set decided_by  = p_auth_id where decided_by  = v_placeholder;
    delete from profiles where id = v_placeholder;
    update profiles set email = p_email, updated_at = now() where id = p_auth_id;
    return 'relinked';
  end if;

  insert into profiles (id, email, display_name) values (p_auth_id, p_email, p_display)
    on conflict (id) do update set email = excluded.email, updated_at = now();
  return 'upserted';
end
$$;

-- Own the dispatch functions with app_system (BYPASSRLS) and expose them to the
-- runtime role by EXECUTE only. create-or-replace preserves an existing owner,
-- but reassert every run so a first-time create is corrected too.
do $$
declare fn text;
begin
  foreach fn in array array[
    'app.claim_next_run_job(bigint)',
    'app.claim_run_job_for_task(uuid, uuid, uuid, bigint)',
    'app.list_stale_run_jobs()',
    'app.finish_run_job(uuid, text, text)',
    'app.requeue_run_job(uuid)',
    'app.run_job_attempt(uuid)',
    'app.renew_run_job_lease(uuid, int, bigint)',
    'app.claim_next_document_job(bigint)',
    'app.finish_document_job(uuid, text, text)',
    'app.requeue_document_job(uuid)',
    'app.list_stale_document_jobs()',
    'app.list_due_schedules(timestamptz)',
    'app.run_jobs_health()',
    'app.adopt_placeholder_profile(uuid, text, text)',
    'app.is_org_member(uuid)',
    'app.is_project_member(uuid)'
  ]
  loop
    execute format('alter function %s owner to app_system', fn);
    -- Do not let the world execute an RLS-bypassing function.
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to app_server', fn);
  end loop;
end
$$;

-- Row-Level Security ---------------------------------------------------------

-- Profiles: a user sees exactly themself.
alter table profiles enable row level security;
alter table profiles force row level security;
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- Organizations: visible when the current user is a member. Keyed off
-- membership (not app.org_id) so the pre-tenant bootstrap — "which orgs am I
-- in?" — works with only app.user_id set. Still never exposes a non-member org.
alter table organizations enable row level security;
alter table organizations force row level security;
drop policy if exists organizations_member on organizations;
create policy organizations_member on organizations
  using (app.is_org_member(id));

-- Memberships: your own rows always (bootstrap), plus co-members of any org you
-- belong to. Does not require app.org_id, so "resolve my memberships" works
-- before a workspace is chosen.
alter table memberships enable row level security;
alter table memberships force row level security;
drop policy if exists memberships_scope on memberships;
create policy memberships_scope on memberships
  using (
    user_id = app.current_user_id()
    or app.is_org_member(org_id)
  );

-- Projects: visible when the current user is a member of the project. Keyed off
-- project_members (not app.org_id) so "which workspaces am I in?" resolves at
-- bootstrap. Tenant tables still enforce the strict (org, project) GUC match;
-- this navigation read only ever surfaces the user's own workspaces.
alter table projects enable row level security;
alter table projects force row level security;
drop policy if exists projects_scope on projects;
create policy projects_scope on projects
  using (app.is_project_member(id));

alter table project_members enable row level security;
alter table project_members force row level security;
drop policy if exists project_members_scope on project_members;
create policy project_members_scope on project_members
  using (
    user_id = app.current_user_id()
    or project_id = app.current_project_id()
  );

-- Tenant tables: the strict single-table predicate. -------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'agents', 'project_context_items', 'integration_secrets',
    'tasks', 'runs', 'run_steps', 'messages',
    'artifacts', 'approvals', 'usage_events', 'spend_limits',
    'objectives', 'milestones', 'knowledge_items', 'task_schedules',
    'documents', 'document_versions', 'document_chunks', 'document_version_tombstones', 'object_cleanup_operations', 'document_purge_operations', 'run_document_versions', 'task_dependencies', 'decisions', 'decision_injections', 'knowledge_injections', 'knowledge_sources', 'knowledge_verification_events', 'knowledge_disclosure_grants', 'document_disclosure_grants', 'knowledge_proposals', 'ai_operations', 'run_jobs',
    'document_jobs', 'work_items',
    -- Stock Trading (P1): every trading table is strictly (org, project) tenant-scoped.
    'instruments', 'watchlists', 'watchlist_items', 'market_quotes', 'research_notes', 'trade_theses',
    'paper_portfolios', 'paper_positions', 'paper_orders', 'paper_fills', 'risk_limits', 'restricted_symbols',
    'risk_checks', 'kill_switches'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant', t);
    execute format(
      'create policy %I on %I
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())',
      t || '_tenant', t
    );
  end loop;
end
$$;

-- Phase 3 executor lifecycle storage is introduced by migration 0058. The incremental-bootstrap
-- test deliberately applies the CURRENT rls.sql to the penultimate schema before migrating 0058,
-- so absence at that exact point is expected. Once either table exists, every grant and tenant
-- policy statement remains mandatory and any SQL failure propagates (fail closed).
do $$
declare
  t text;
begin
  foreach t in array array['executor_executions', 'executor_execution_attempts']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select, insert, update on %I to app_server', t);
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force row level security', t);
      execute format('drop policy if exists %I on %I', t || '_tenant', t);
      execute format(
        'create policy %I on %I
           using (org_id = app.current_org_id() and project_id = app.current_project_id())
           with check (org_id = app.current_org_id() and project_id = app.current_project_id())',
        t || '_tenant', t
      );
    end if;
  end loop;
end
$$;

-- Phase 5 MCP API tokens are introduced by migration 0059. Like the executor tables above, this block is
-- to_regclass-guarded so the incremental-bootstrap test (which applies the CURRENT rls.sql to the PENULTIMATE
-- schema, before 0059) tolerates the table's absence at that exact point. Once it exists, every grant and the
-- tenant policy remain mandatory and any SQL failure propagates (fail closed).
do $$
begin
  if to_regclass('public.api_tokens') is not null then
    -- Runtime role: read/create/soft-revoke tokens within its own tenant. NO delete — revocation is a soft
    -- update (revoked_at), so a token's audit trail is never destroyed.
    grant select, insert, update on api_tokens to app_server;
    -- The definer owner (app_system) needs table access to resolve a presented token before a tenant exists.
    grant select, update on api_tokens to app_system;
    alter table api_tokens enable row level security;
    alter table api_tokens force row level security;
    drop policy if exists api_tokens_tenant on api_tokens;
    execute
      'create policy api_tokens_tenant on api_tokens
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- The ONLY sanctioned read of api_tokens outside tenant scope: resolve a presented token HASH to the bound
-- (org, project, user) so a TenantContext can be built BEFORE one exists — mirrors app.adopt_placeholder_profile.
-- It also stamps last_used_at so an idle/leaked token is observable. plpgsql is late-binding, so this create is
-- tolerated even in the penultimate-schema bootstrap where api_tokens does not yet exist (it is simply never
-- called there). Ownership by app_system (BYPASSRLS) + EXECUTE-only exposure is asserted below.
create or replace function app.resolve_api_token(p_token_hash text)
returns table (token_id uuid, org_id uuid, project_id uuid, created_by uuid, scopes jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    update api_tokens t
       set last_used_at = now()
     where t.token_hash = p_token_hash
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())
    returning t.id, t.org_id, t.project_id, t.created_by, t.scopes;
end
$$;

-- Own the resolver with app_system (BYPASSRLS) so it sees the row under FORCE RLS without org/project GUCs, and
-- expose it to the runtime role by EXECUTE only. Guarded because the grant/owner target a function whose body
-- depends on api_tokens; only assert once the table (and thus the meaningful function) exists.
do $$
begin
  if to_regclass('public.api_tokens') is not null then
    alter function app.resolve_api_token(text) owner to app_system;
    revoke all on function app.resolve_api_token(text) from public;
    grant execute on function app.resolve_api_token(text) to app_server;
  end if;
end
$$;

-- Phase 6 GitHub repo links are introduced by migration 0060. to_regclass-guarded like the executor/api_tokens
-- blocks above so the incremental-bootstrap test (which applies the CURRENT rls.sql to the PENULTIMATE schema)
-- tolerates the newest table's absence. The row is ordinary tenant-scoped configuration — no secret, no definer
-- function; unlink is a hard delete of the config row (the audit trail lives in audit_logs, not here).
do $$
begin
  if to_regclass('public.github_repo_links') is not null then
    grant select, insert, update, delete on github_repo_links to app_server;
    alter table github_repo_links enable row level security;
    alter table github_repo_links force row level security;
    drop policy if exists github_repo_links_tenant on github_repo_links;
    execute
      'create policy github_repo_links_tenant on github_repo_links
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- Employee Chat conversations (EV-004; migration 0064). to_regclass-guarded like api_tokens/github_repo_links
-- so the penultimate-schema incremental bootstrap tolerates absence. Thread identities only — every exchange
-- is still an ordinary task/run, so no delete grant: a conversation, once begun, is history.
do $$
begin
  if to_regclass('public.conversations') is not null then
    grant select, insert, update on conversations to app_server;
    alter table conversations enable row level security;
    alter table conversations force row level security;
    drop policy if exists conversations_tenant on conversations;
    execute
      'create policy conversations_tenant on conversations
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- Ask-the-owner questions (migration 0066). to_regclass-guarded like conversations so the
-- penultimate-schema incremental bootstrap tolerates absence. Questions are answered or
-- dismissed, never deleted — no delete grant.
do $$
begin
  if to_regclass('public.owner_questions') is not null then
    grant select, insert, update on owner_questions to app_server;
    alter table owner_questions enable row level security;
    alter table owner_questions force row level security;
    drop policy if exists owner_questions_tenant on owner_questions;
    execute
      'create policy owner_questions_tenant on owner_questions
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- Portfolio ledger (migration 0067). to_regclass-guarded like owner_questions so the
-- penultimate-schema incremental bootstrap tolerates absence. Trades may be deleted
-- (typo correction by the owner); accounts and quotes are never deleted by the app.
do $$
begin
  if to_regclass('public.brokerage_accounts') is not null then
    grant select, insert, update on brokerage_accounts to app_server;
    alter table brokerage_accounts enable row level security;
    alter table brokerage_accounts force row level security;
    drop policy if exists brokerage_accounts_tenant on brokerage_accounts;
    execute
      'create policy brokerage_accounts_tenant on brokerage_accounts
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
  if to_regclass('public.portfolio_trades') is not null then
    grant select, insert, update, delete on portfolio_trades to app_server;
    alter table portfolio_trades enable row level security;
    alter table portfolio_trades force row level security;
    drop policy if exists portfolio_trades_tenant on portfolio_trades;
    execute
      'create policy portfolio_trades_tenant on portfolio_trades
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
  if to_regclass('public.symbol_quotes') is not null then
    grant select, insert, update on symbol_quotes to app_server;
    alter table symbol_quotes enable row level security;
    alter table symbol_quotes force row level security;
    drop policy if exists symbol_quotes_tenant on symbol_quotes;
    execute
      'create policy symbol_quotes_tenant on symbol_quotes
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- Provisioning INSERT policies (Sprint 5, "The Front Door") -------------------
-- Workspace/org creation happens BEFORE the row being created has members, so
-- the membership-based USING predicates above can never admit these inserts.
-- Permissive policies OR together per command: these add the create paths
-- without widening any read.

-- Any authenticated user may create an organization (they immediately insert
-- their own owner membership in the same transaction).
drop policy if exists organizations_insert on organizations;
create policy organizations_insert on organizations
  for insert with check (app.current_user_id() is not null);

-- You may only ever INSERT a membership row for YOURSELF (org bootstrap).
-- Adding others is a future multi-user flow with its own policy.
drop policy if exists memberships_self_insert on memberships;
create policy memberships_self_insert on memberships
  for insert with check (user_id = app.current_user_id());

-- Org owners/admins may create projects in their org.
drop policy if exists projects_insert on projects;
create policy projects_insert on projects
  for insert with check (
    org_id = app.current_org_id()
    and exists (
      select 1 from memberships m
      where m.org_id = projects.org_id
        and m.user_id = app.current_user_id()
        and m.role in ('owner', 'admin')
    )
  );

-- departments: org-scoped, like organizations — an employee's department is
-- the same in every workspace, so the predicate is org membership, not project.
alter table departments enable row level security;
alter table departments force row level security;
drop policy if exists departments_org on departments;
create policy departments_org on departments
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

-- audit_logs: org-scoped (org-level events have null project_id). Insert must
-- still match the current org.
alter table audit_logs enable row level security;
alter table audit_logs force row level security;
drop policy if exists audit_logs_org on audit_logs;
create policy audit_logs_org on audit_logs
  using (org_id = app.current_org_id())
  with check (org_id = app.current_org_id());

-- rate_limit_buckets carries no tenant column (scope is inside scope_key);
-- app_server may use it freely but it holds no tenant data.
alter table rate_limit_buckets enable row level security;
alter table rate_limit_buckets force row level security;
drop policy if exists rate_limit_open on rate_limit_buckets;
create policy rate_limit_open on rate_limit_buckets using (true) with check (true);

-- ---------------------------------------------------------------------------
-- P1a — platform pricing (GLOBAL, not tenant-scoped). Migration-seeded and
-- IMMUTABLE: app_server may READ only; UPDATE/DELETE are blocked for every role
-- by app.forbid_mutation (superusers bypass RLS but NOT triggers). There is no
-- INSERT grant/policy for app_server, so runtime code cannot create pricing;
-- only the migration/platform (superuser) role seeds these rows.
-- ---------------------------------------------------------------------------
grant select on pricing_schedules, pricing_schedule_entries, platform_pricing_state to app_server;

alter table pricing_schedules enable row level security;
alter table pricing_schedules force row level security;
drop policy if exists pricing_schedules_read on pricing_schedules;
create policy pricing_schedules_read on pricing_schedules for select using (true);

alter table pricing_schedule_entries enable row level security;
alter table pricing_schedule_entries force row level security;
drop policy if exists pricing_schedule_entries_read on pricing_schedule_entries;
create policy pricing_schedule_entries_read on pricing_schedule_entries for select using (true);

alter table platform_pricing_state enable row level security;
alter table platform_pricing_state force row level security;
drop policy if exists platform_pricing_state_read on platform_pricing_state;
create policy platform_pricing_state_read on platform_pricing_state for select using (true);

drop trigger if exists pricing_schedules_immutable on pricing_schedules;
create trigger pricing_schedules_immutable
  before update or delete on pricing_schedules
  for each row execute function app.forbid_mutation();

drop trigger if exists pricing_schedule_entries_immutable on pricing_schedule_entries;
create trigger pricing_schedule_entries_immutable
  before update or delete on pricing_schedule_entries
  for each row execute function app.forbid_mutation();

drop trigger if exists platform_pricing_state_immutable on platform_pricing_state;
create trigger platform_pricing_state_immutable
  before update or delete on platform_pricing_state
  for each row execute function app.forbid_mutation();

-- Stock Trading (P1): tenant-bind references that cannot be plain composite FKs -----------------------------------
-- Trading→trading references use composite FKs (org_id, project_id, parent_id) in the schema. The remaining
-- tenant-bound references — to Hub tables (approvals, agents) and the circular order↔risk_check pair — are enforced
-- here with narrow constraint triggers. The existence check filters on (id, org_id, project_id), so a cross-workspace
-- reference (or one hidden by RLS) fails closed. No SECURITY DEFINER: the explicit org/project filter is authoritative.

create or replace function app.trading_ref_same_tenant(p_relname text, p_id uuid, p_org uuid, p_project uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if p_id is null then return; end if;
  execute format('select exists(select 1 from %I where id = $1 and org_id = $2 and project_id = $3)', p_relname)
    into ok using p_id, p_org, p_project;
  if not ok then
    raise exception 'trading tenant violation: %.% is not in org % project %', p_relname, p_id, p_org, p_project
      using errcode = '23514';
  end if;
end $$;
grant execute on function app.trading_ref_same_tenant(text, uuid, uuid, uuid) to app_server;

create or replace function app.trg_paper_orders_tenant() returns trigger
language plpgsql as $$
begin
  perform app.trading_ref_same_tenant('approvals', new.approval_id, new.org_id, new.project_id);
  perform app.trading_ref_same_tenant('risk_checks', new.risk_check_id, new.org_id, new.project_id);
  perform app.trading_ref_same_tenant('agents', new.proposed_by_agent_id, new.org_id, new.project_id);
  return new;
end $$;
drop trigger if exists trading_paper_orders_tenant_trg on paper_orders;
create constraint trigger trading_paper_orders_tenant_trg after insert or update on paper_orders
  deferrable initially immediate for each row execute function app.trg_paper_orders_tenant();

create or replace function app.trg_research_notes_tenant() returns trigger
language plpgsql as $$
begin
  perform app.trading_ref_same_tenant('agents', new.author_agent_id, new.org_id, new.project_id);
  return new;
end $$;
drop trigger if exists trading_research_notes_tenant_trg on research_notes;
create constraint trigger trading_research_notes_tenant_trg after insert or update on research_notes
  deferrable initially immediate for each row execute function app.trg_research_notes_tenant();

create or replace function app.trg_trade_theses_tenant() returns trigger
language plpgsql as $$
begin
  perform app.trading_ref_same_tenant('agents', new.author_agent_id, new.org_id, new.project_id);
  return new;
end $$;
drop trigger if exists trading_trade_theses_tenant_trg on trade_theses;
create constraint trigger trading_trade_theses_tenant_trg after insert or update on trade_theses
  deferrable initially immediate for each row execute function app.trg_trade_theses_tenant();

create or replace function app.trg_risk_checks_tenant() returns trigger
language plpgsql as $$
begin
  perform app.trading_ref_same_tenant('agents', new.evaluated_by_agent_id, new.org_id, new.project_id);
  return new;
end $$;
drop trigger if exists trading_risk_checks_tenant_trg on risk_checks;
create constraint trigger trading_risk_checks_tenant_trg after insert or update on risk_checks
  deferrable initially immediate for each row execute function app.trg_risk_checks_tenant();

-- VER-002 — external-runner evidence ingestion (migration 0069). to_regclass-guarded
-- like github_repo_links so an incremental bootstrap tolerates absence until the
-- tables are applied. Same strict tenant predicate (org_id + project_id GUCs).
do $$
begin
  if to_regclass('public.verification_requests') is not null then
    -- The verification CONTRACT is immutable: the app role may INSERT (create) and SELECT (read) only.
    -- Revoking UPDATE/DELETE prevents silent alteration of an existing contract at the grant layer
    -- (there is also no update code path). Idempotent-or-conflict on create is enforced in the app +
    -- a unique (org, project, task_id, expected_commit_sha) constraint.
    grant select, insert on verification_requests to app_server;
    revoke update, delete on verification_requests from app_server;
    alter table verification_requests enable row level security;
    alter table verification_requests force row level security;
    drop policy if exists verification_requests_tenant on verification_requests;
    execute
      'create policy verification_requests_tenant on verification_requests
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
  if to_regclass('public.verification_evidence') is not null then
    -- Adjudicated evidence is APPEND-ONLY. The app role may INSERT (record a submission's decision)
    -- and SELECT (read) only; UPDATE/DELETE are revoked at the grant layer, and the trigger below is
    -- the defense-in-depth that rejects a mutation even from a role that still holds the grant. There
    -- is intentionally NO delete path until the governed retention feature exists.
    grant select, insert on verification_evidence to app_server;
    revoke update, delete on verification_evidence from app_server;
    alter table verification_evidence enable row level security;
    alter table verification_evidence force row level security;
    drop policy if exists verification_evidence_tenant on verification_evidence;
    execute
      'create policy verification_evidence_tenant on verification_evidence
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
    -- Append-only enforcement (fires on UPDATE/DELETE for EVERY role, incl. table owner/superuser —
    -- triggers are not bypassed by RLS/superuser). Mirrors messages/audit_logs above.
    execute 'drop trigger if exists verification_evidence_append_only on verification_evidence';
    execute
      'create trigger verification_evidence_append_only
         before update or delete on verification_evidence
         for each row execute function app.forbid_mutation()';
  end if;
end
$$;

-- ─────────────────────── VER-002 PR-2: runner (machine) credentials ───────────────────────
-- A narrowly-privileged, LOGIN-LESS role that owns the pre-tenant lookup function below. It is not a
-- superuser; it can read only verification_runner_keys and bypasses RLS solely so the SECURITY
-- DEFINER lookup can resolve a bearer credential BEFORE any tenant context (GUCs) exists.
do $$
begin
  if not exists (select from pg_roles where rolname = 'verification_key_reader') then
    create role verification_key_reader nologin nosuperuser bypassrls;
  end if;
  alter role verification_key_reader nologin nosuperuser bypassrls nocreatedb nocreaterole;
end
$$;
-- Ownership of a function in schema `app` requires CREATE there; scope the reader to exactly that.
grant usage, create on schema app to verification_key_reader;

do $$
begin
  if to_regclass('public.verification_runner_keys') is not null then
    -- NO-DIRECT-ACCESS design: app_server never reads or mutates verification_runner_keys directly —
    -- secret material must not be broadly SELECTable, and credential fields must not be generally
    -- mutable. Every operation (lookup, issue, revoke, touch) goes through a narrowly-scoped SECURITY
    -- DEFINER function below. Revoke any prior grants so re-running rls.sql converges to no access.
    revoke all on verification_runner_keys from app_server;
    -- The narrow reader OWNS the definer functions and is the only role that touches the table; it
    -- needs exactly select/insert/update (no delete — credentials are revoked, never hard-deleted).
    grant select, insert, update on verification_runner_keys to verification_key_reader;
    -- RLS stays enabled + FORCEd as defense-in-depth even though only a BYPASSRLS owner reaches the
    -- table; the definer functions enforce tenant scope explicitly via the org/project GUCs.
    alter table verification_runner_keys enable row level security;
    alter table verification_runner_keys force row level security;
    drop policy if exists verification_runner_keys_tenant on verification_runner_keys;
    execute
      'create policy verification_runner_keys_tenant on verification_runner_keys
         using (org_id = app.current_org_id() and project_id = app.current_project_id())
         with check (org_id = app.current_org_id() and project_id = app.current_project_id())';
  end if;
end
$$;

-- Hardened pre-tenant lookup. SECURITY DEFINER so it resolves a bearer before tenant GUCs exist, but
-- owned by the narrow verification_key_reader (NOT a superuser); fixed safe search_path; fully
-- qualified table reference; NO execute for PUBLIC. It returns ONLY the columns authentication needs.
-- plpgsql (not sql) so the body is late-bound: rls.sql also runs at intermediate migration points
-- (e.g. an incremental upgrade paused at the penultimate migration) where verification_runner_keys
-- does not exist yet. A SQL function validates its table refs at CREATE and would fail there; plpgsql
-- resolves them at first call, by which time the table exists.
create or replace function app.lookup_verification_runner_key(p_key_id uuid)
returns table (org_id uuid, project_id uuid, secret_hash text, secret_salt text, revoked_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog as $fn$
begin
  return query
    select k.org_id, k.project_id, k.secret_hash, k.secret_salt, k.revoked_at, k.expires_at
    from public.verification_runner_keys k
    where k.id = p_key_id;
end
$fn$;
alter function app.lookup_verification_runner_key(uuid) owner to verification_key_reader;
revoke all on function app.lookup_verification_runner_key(uuid) from public;
grant execute on function app.lookup_verification_runner_key(uuid) to app_server;

-- Resolve a project KEY to its (org, project) ids before any tenant context exists, so the guard can
-- confirm a runner credential's project matches the URL's project key (a key for project A must not
-- act on project B). Same hardening: narrow owner, fixed search_path, qualified ref, no PUBLIC exec.
grant select on projects to verification_key_reader;
create or replace function app.resolve_project_by_key(p_key text)
returns table (org_id uuid, project_id uuid)
language sql stable security definer set search_path = pg_catalog as $fn$
  select p.org_id, p.id from public.projects p where p.key = p_key and p.archived = false
$fn$;
alter function app.resolve_project_by_key(text) owner to verification_key_reader;
revoke all on function app.resolve_project_by_key(text) from public;
grant execute on function app.resolve_project_by_key(text) to app_server;

-- Narrowly-scoped credential OPERATIONS (the only write paths app_server has). Each is SECURITY
-- DEFINER, owned by verification_key_reader, and derives the tenant from the transaction GUCs
-- (app.current_*(), set by withTenant/withRunner) — NOT from parameters — so a caller can only ever
-- act within its own project. This is what enforces cross-project isolation, and what prevents general
-- credential-field mutation: issuance sets the tenant/creator itself, revocation touches only
-- revoked_at/revoked_by, and touch updates only last_used_at. plpgsql for late binding (see above).

-- ISSUE: insert a credential into the CALLER's tenant (org/project/creator from GUCs, never params).
create or replace function app.issue_verification_runner_key(
  p_key_id uuid, p_secret_hash text, p_secret_salt text, p_label text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = pg_catalog as $fn$
begin
  insert into public.verification_runner_keys
    (id, org_id, project_id, secret_hash, secret_salt, label, created_by, expires_at)
  values
    (p_key_id, app.current_org_id(), app.current_project_id(), p_secret_hash, p_secret_salt,
     coalesce(p_label, ''), app.current_user_id(), p_expires_at);
end
$fn$;
alter function app.issue_verification_runner_key(uuid, text, text, text, timestamptz) owner to verification_key_reader;
revoke all on function app.issue_verification_runner_key(uuid, text, text, text, timestamptz) from public;
grant execute on function app.issue_verification_runner_key(uuid, text, text, text, timestamptz) to app_server;

-- REVOKE: mark a credential revoked, scoped to the caller's tenant. Returns true iff a not-yet-revoked
-- row in THIS project was revoked (a key in another project never matches → cross-project isolation).
create or replace function app.revoke_verification_runner_key(p_key_id uuid)
returns boolean
language plpgsql security definer set search_path = pg_catalog as $fn$
declare v_count int;
begin
  update public.verification_runner_keys
     set revoked_at = now(), revoked_by = app.current_user_id()
   where id = p_key_id
     and org_id = app.current_org_id()
     and project_id = app.current_project_id()
     and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end
$fn$;
alter function app.revoke_verification_runner_key(uuid) owner to verification_key_reader;
revoke all on function app.revoke_verification_runner_key(uuid) from public;
grant execute on function app.revoke_verification_runner_key(uuid) to app_server;

-- TOUCH: best-effort last-used stamp, scoped to the caller's tenant. Updates ONLY last_used_at.
create or replace function app.touch_verification_runner_key(p_key_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog as $fn$
begin
  update public.verification_runner_keys
     set last_used_at = now()
   where id = p_key_id
     and org_id = app.current_org_id()
     and project_id = app.current_project_id();
end
$fn$;
alter function app.touch_verification_runner_key(uuid) owner to verification_key_reader;
revoke all on function app.touch_verification_runner_key(uuid) from public;
grant execute on function app.touch_verification_runner_key(uuid) to app_server;
