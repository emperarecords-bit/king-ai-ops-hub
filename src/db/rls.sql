-- ---------------------------------------------------------------------------
-- Row-Level Security, append-only triggers, and the runtime role.
--
-- Applied by scripts/migrate.ts AFTER the Drizzle-generated DDL. Idempotent:
-- safe to re-run on every migrate.
--
-- Model (SECURITY.md T1, T5):
--   * The app connects as `app_server`, NOBYPASSRLS.
--   * withTenant() stamps app.user_id / app.org_id / app.project_id as
--     transaction-local GUCs; policies read them via helper functions.
--   * Tenant tables: single-table predicate on (org_id, project_id).
--   * Org-scoped tables: predicate on org_id via membership.
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

-- Runtime role ---------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server login password 'app_server_dev_only' nobypassrls;
  end if;
end
$$;

grant usage on schema public to app_server;
grant usage on schema app to app_server;

-- Table privileges: deliberately NOT "grant all".
grant select, insert, update on
  organizations, memberships, projects, project_members,
  agents, departments, project_context_items, integration_secrets,
  tasks, runs, run_steps, artifacts, approvals,
  objectives, milestones, knowledge_items,
  usage_events, spend_limits, rate_limit_buckets, profiles
to app_server;

grant delete on rate_limit_buckets, integration_secrets, project_context_items to app_server;

-- Append-only tables: INSERT and SELECT only. No UPDATE grant at all.
grant select, insert on messages, audit_logs to app_server;

grant usage on all sequences in schema public to app_server;

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

drop trigger if exists messages_append_only on messages;
create trigger messages_append_only
  before update or delete on messages
  for each row execute function app.forbid_mutation();

drop trigger if exists audit_logs_append_only on audit_logs;
create trigger audit_logs_append_only
  before update or delete on audit_logs
  for each row execute function app.forbid_mutation();

-- Row-Level Security ---------------------------------------------------------

-- Profiles: a user sees exactly themself.
alter table profiles enable row level security;
alter table profiles force row level security;
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- Organizations: visible when the current user has a membership row.
alter table organizations enable row level security;
alter table organizations force row level security;
drop policy if exists organizations_member on organizations;
create policy organizations_member on organizations
  using (
    id = app.current_org_id()
    and exists (
      select 1 from memberships m
      where m.org_id = organizations.id
        and m.user_id = app.current_user_id()
    )
  );

-- Memberships: rows for the current org, if you belong to it.
alter table memberships enable row level security;
alter table memberships force row level security;
drop policy if exists memberships_scope on memberships;
create policy memberships_scope on memberships
  using (
    org_id = app.current_org_id()
    and exists (
      select 1 from memberships m2
      where m2.org_id = memberships.org_id
        and m2.user_id = app.current_user_id()
    )
  );

-- Projects: org-scoped read (project pickers need sibling projects the user
-- belongs to; system.ts filters by explicit membership on top of this).
alter table projects enable row level security;
alter table projects force row level security;
drop policy if exists projects_scope on projects;
create policy projects_scope on projects
  using (
    org_id = app.current_org_id()
    and exists (
      select 1 from project_members pm
      where pm.project_id = projects.id
        and pm.user_id = app.current_user_id()
    )
  );

alter table project_members enable row level security;
alter table project_members force row level security;
drop policy if exists project_members_scope on project_members;
create policy project_members_scope on project_members
  using (
    org_id = app.current_org_id()
    and (
      user_id = app.current_user_id()
      or project_id = app.current_project_id()
    )
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
    'objectives', 'milestones', 'knowledge_items'
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
