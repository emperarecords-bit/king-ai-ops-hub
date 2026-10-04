# App Security Audit Runbook (+ AccurateBids review 2026-09-20)

A reusable, do-this-every-time procedure for auditing a Supabase/Postgres + React app for "are we hacked / can we be hacked." Written from the AccurateBids review on 2026-09-20. Apply the STEPS to any product; the FINDINGS/SOLUTIONS section is the worked AccurateBids example. Pairs with the pinned "CREDENTIAL LAW" (never enter/handle owner secrets — recommend, don't execute credential actions).

## STEPS — the repeatable audit (run in this order)

1. Run the platform's own linter first. Supabase: security advisor (`get_advisors type=security`). Triage every WARN. Known-benign classes: `rls_enabled_no_policy` (RLS on + no policy = deny-all = safe/locked), `extension_in_public` (pg_net) = minor.

2. Auth & MFA posture. Query `auth.users`: `last_sign_in_at`, provider, `banned_until`, and verified MFA factors per user. FLAG any privileged/owner account with zero verified factors — password-only is the #1 real takeover path.
   `select u.email,u.last_sign_in_at,(select count(*) from auth.mfa_factors f where f.user_id=u.id and f.status='verified') mfa from auth.users u order by u.last_sign_in_at desc nulls last;`

3. SECURITY DEFINER function exposure. Definer functions bypass RLS, so who can EXECUTE them matters. List every definer function callable by `anon`/`authenticated` and confirm each is intentional:
   `select p.proname, array_agg(r.rolname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace, lateral (select rolname from pg_roles where has_function_privilege(rolname,p.oid,'EXECUTE') and rolname in ('anon','authenticated','service_role')) r where n.nspname='public' and p.prosecdef group by p.proname;`
   - Anon-callable is ONLY acceptable when the function is token-gated (takes a share token and returns exactly one record). A definer function that returns rows across all tenants must NOT be callable by anon/authenticated → `revoke execute ... from anon, authenticated, public;` (keep `service_role`; a definer chain owned by postgres still calls it internally).
   - Every definer function must `set search_path` to a fixed schema.

4. Privilege / billing tampering. Look for self-granted power or comped plans:
   - Rogue elevated members: `select role, count(*) from team_members group by role;` (or the app's membership table) — investigate any unexpected owner/admin.
   - Free paid access: subscriptions with `status='active'` but no `stripe_subscription_id` — confirm each is a legitimate internal/comped account, not a stranger.
   - New signups in the last 14 days that look like abuse.

5. Login / audit-log review. Check `auth.audit_log_entries` for recovery, email-change, factor-unenroll, or logins from unexpected actors. If it is empty/short-retention, fall back to `auth.users.last_sign_in_at` and confirm every recent sign-in is a known account.

6. Secret scan — working tree AND full git history (a secret committed once and later removed still leaks):
   - Committed sensitive files: `git ls-files | grep -iE '\.env|secret|credential|\.pem|\.key|serviceaccount'` (only `.env.example` template is OK).
   - `.gitignore` must exclude `.env` / `.env.*` (allow `!.env.example`).
   - Content, HEAD: `git grep -nEI '(sk_live_|sk_test_|whsec_|-----BEGIN [A-Z ]*PRIVATE KEY[-]{5}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'` — the `KEY[-]{5}` matches the same `KEY-----` header at runtime; it is written this way so this doc does not itself carry the verbatim marker that the repo-hygiene scan forbids.
   - Content, all history: `git log --all --oneline -G'<same patterns>'` and `... -- '*.env' '*.env.*'` diff-filter=A. A Supabase service_role key is a long `eyJ…` JWT — never in client source. The anon key is public and fine in the client.
   - If a real secret is found: rotate it immediately (it is compromised the moment it was pushed), then purge history.

7. Control-plane 2FA (the part outside the app). The most likely founder-takeover isn't the app login — it's the accounts that own everything: the Supabase org, GitHub org, Vercel/host, and the founder's email/Google account. Confirm 2FA on ALL of them. Recommend to the owner; never perform credential actions yourself (see CREDENTIAL LAW).

8. Optional Supabase Auth hardening (dashboard toggles, not settable via MCP): leaked-password protection (HaveIBeenPwned) + a minimum password strength.

## FINDINGS — AccurateBids, 2026-09-20 (verdict: NO evidence of compromise)
- No rogue owner/admin (both team_members are role 'manager'); no stranger comped a plan (only comped accounts are the owner's own orville@accuratebids.com + emperamechanical@gmail.com, both Pro no-stripe); no banned users; no unfamiliar admin logins; 0 broken public quotes.
- TOP GAP: no MFA on ANY account, including both founder logins. Password-only.
- LEAK (fixed): `broken_public_quotes()` returned customer_name/job_name/totals across ALL tenants and was anon-callable via /rest/v1/rpc — cross-tenant PII exposure on the next broken quote.
- Secret scan: CLEAN across all 440 commits — no keys/JWTs/tokens/.env; .gitignore correct; only .env.example (placeholders) tracked.

## SUGGESTIONS
- Turn on 2FA for the app owner logins AND for Supabase/GitHub/Vercel/Google.
- Keep definer functions either token-gated-anon or authenticated/service_role only — never anon-callable cross-tenant.
- Enable Supabase leaked-password protection + min password strength.

## SOLUTIONS (what was shipped)
- Locked the leak: revoked EXECUTE on `broken_public_quotes()` from anon+authenticated (service_role only) and `owner_dashboard()` from anon — accuratebids PR #158, applied to prod via MCP.
- Built opt-in TOTP MFA: Settings enroll/verify/disable + a full-screen aal1→aal2 login gate wired into App's session choke point (fails open, sign-out escape). accuratebids PR #159. Opt-in only, no AAL2 RLS enforcement (avoids locking out non-technical contractor users; enforcement can be layered later). Owner must still enroll + test after deploy.
- Secret scan: clean, nothing to remediate.

## REUSABLE CHECKLIST (copy per audit)
- [ ] advisor security lint triaged
- [ ] MFA on every privileged account
- [ ] no anon cross-tenant definer fn
- [ ] all definer fns have fixed search_path
- [ ] no rogue elevated member / comped sub
- [ ] recent logins all known
- [ ] secret scan HEAD + full history clean
- [ ] .gitignore excludes .env
- [ ] control-plane 2FA (Supabase/GitHub/host/email)
- [ ] leaked-password protection on
