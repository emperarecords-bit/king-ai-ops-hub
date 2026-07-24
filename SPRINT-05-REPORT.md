# Sprint 5 Report — "The Front Door"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 5.
> Authorization: Executive Response to Sprint 4 (2026-07-24), including the
> daily-operation question answered in §8. Prior reports: SPRINT-01 … 04.

---

## 1. Executive Summary

**What was accomplished.** The platform is now self-serve from zero. A brand-
new account can sign up, click "+ New workspace", and land in a working
company — staffed with a business-named AI team (Lead Engineer, Senior
Engineer, Review Engineer, Principal Reviewer), organized into the eight
standard departments, protected by a budget with a hard stop, and carrying an
approved charter — without any engineer running a script. The task form's
visible question is now **"Who should perform this work?"** — an employee
picker; vendors and models are fully derived and no longer appear anywhere in
the primary flow. A getting-started checklist walks fresh workspaces through
meet-the-team → first objective → first work. The completion gate now has a
browser-level E2E proof, and provisioning is covered for all three paths
(existing org, key collision, brand-new-user org bootstrap).

**Clarity over capability**, as directed: this sprint *removed* visible
controls (the vendor radio is gone entirely) and added exactly one — the
question a manager would actually ask.

**Internal consistency.** ONBOARDING.md's journey is now implemented through
stage 5 (account → workspace → team → objective → assignment); stages 6–8
(watch, review, approve) already existed from Sprints 3–4. The seed and the
provisioning service share one staffing roster, so scripted and self-serve
workspaces can never drift apart.

## 2. Work Delivered

| Item | Detail | Commit |
|---|---|---|
| Workspace provisioning service | Two-phase (org-level rows, then tenant-path staffing); brand-new users get an org of their own as owner; slug keys with collision suffixes; audited `workspace.created` | `b979b06` |
| RLS provisioning policies | Three new INSERT policies: organizations (any authed user), memberships (self only — adding others stays a future flow), projects (org owner/admin). No read widened | `b979b06` |
| Front-door UI | `/projects/new` + "+ New workspace" on the selector; empty state rewritten for newcomers; "Setting up your team…" pending state | `b979b06` |
| Business-named staff | Shared roster module; seed renames legacy vendor-named agents in place (history preserved); sandbox duplicates reconciled | `b979b06` |
| Assignee-first task form | Employee picker (name + department) replaces all vendor controls; leading vendor derived from the pick, cross-check partner via D-005; server-side validation of the assignee | `b979b06` |
| Getting-started checklist | Data-driven (checks real objectives/tasks), shown only while incomplete, with the trust line: "Your team proposes; you approve" | `b979b06` |
| Objectives E2E | The completion gate proven in a hydrated browser: create → activate → refusal visible → mark met → complete → controls gone | `b979b06` |
| Provisioning tests | 3 integration tests incl. org bootstrap (8 departments, owner membership) | `b979b06` |

**Evidence:** 113 unit/integration tests + 3 E2E, all green; typecheck + lint
clean; provisioning verified against the real database including the
brand-new-user path.

## 3. Deviations and judgment calls

1. **Org-member (non-admin) users who create a workspace get a new org of
   their own** rather than a workspace in the org they belong to. Correct for
   the front door (anyone can start their own company); revisit when real
   multi-user arrives.
2. **Task assignee is not yet a stored column** — the pick resolves to the
   leading vendor and the run records the executing agents. Exact today
   (one primary per vendor per workspace), but a `tasks.assignee_agent_id`
   column should land before multiple employees share a vendor. Queued as
   debt, Low.
3. **Onboarding stage instrumentation** shipped partially: workspace creation
   and every subsequent step are audited as domain events, but the dedicated
   `onboarding.stage_reached` funnel events from ONBOARDING.md are not yet
   emitted. Fold into the next UX sprint.

## 4. Outstanding Questions (owner)

1. PartsHunt Pro: still zero live runs (carried third sprint running — say
   the word and I'll stop tracking it).
2. Carried, defaults safe: approval expiry · single-owner · local-only ·
   mini-model price verification.

## 5. Technical Debt

| Rank | Item | Type |
|---|---|---|
| **Medium** | Nonce-based production CSP (deployment blocker, unchanged) | Technical |
| **Medium** | A5 approval-expiry sweep; A7 bucket pruning — now three sprints deferred; schedule or de-scope next sprint | Technical |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product |
| **Low** | `tasks.assignee_agent_id` column (§3.2) | Technical |
| **Low** | `onboarding.stage_reached` funnel events (§3.3) | Product |
| **Low** | E2E workspace-creation flow untested in browser (would spawn an org per run; needs a cleanup strategy first) | Process |
| **Low** | USER_JOURNEY.md deprecation pointer (third carry — will just do it next doc touch) | Documentation |

## 6. Risks

**Product** — *Empty-company syndrome*: a new user's workspace is staffed but
its employees have no history, so Employees/Dashboard read as zeros. The
getting-started card mitigates; the §8 morning-briefing direction is the real
fix. *Org sprawl* (§3.1): future users experimenting could mint orgs freely;
fine single-owner, needs quotas before public exposure.

**Security** — The new INSERT policies were reviewed against probing:
organizations insert requires an authenticated GUC; memberships insert is
self-only (privilege escalation into others' orgs is not representable);
projects insert requires existing owner/admin membership. The dynamic
every-table RLS test still passes. No engine, provider, or approval-path
changes.

**Technical** — Provisioning is two transactions (org rows, then staffing); a
crash between them leaves a staffless workspace. Recovery is benign (the UI
shows an unstaffed team; re-provisioning is idempotent-ish) but a cleanup
sweep is queued with A5/A7.

## 7. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 9/10 | All four sprint objectives; funnel instrumentation partial (§3.3) |
| Quality | 9/10 | Three test layers on the new surface; −1: no browser E2E for provisioning itself (§5) |
| Completeness | 9/10 | The fifteen-minute journey is now implementable end to end by a stranger; unmeasured until instrumentation lands |
| Maintainability | 10/10 | One shared staffing roster; provisioning reuses the tenant path; presentation stayed presentation |
| Future scalability | 9/10 | Org bootstrap opens multi-tenant SaaS structurally; quotas/billing deliberately absent |

**Overall: 9/10.** The platform's biggest structural gap — seed-only
workspaces — is closed with the same discipline as everything else: RLS-
backed, audited, tested at three layers, and simpler-looking than what it
replaced.

## 8. The Daily-Operation Question (requested analysis — no code shipped)

> "What makes someone want to open the Hub every morning instead of opening
> ChatGPT or Claude directly?"

**Observation of the existing workflow.** Chat tools win the *first minute*
of any task — zero friction, blank page, instant reply. The Hub wins
everything that surrounds the task: it already knows the workspace (approved
context loaded into every prompt), it cross-checks answers with a rival
vendor, it remembers everything immutably, it meters cost, and it queues
consequential actions for a decision. Today, however, all of that value is
*reactive* — the Hub only does something when you bring it a task, which
means the morning habit currently belongs to the blank chat box.

**Where the Hub is already unique** (observed, not aspirational): (1) work
that survives the session — objectives and their progress exist tomorrow;
(2) answers with a second signature — the review-value metric shows when the
cross-check catches things; (3) an inbox of *decisions*, not messages — the
approval queue; (4) attribution — who did what, at what cost, toward which
goal.

**The gap that decides the habit:** the Hub must open with *answers*, not a
prompt box. Three recommendations, in priority order:

1. **The Morning Briefing (highest value, lowest cost).** The dashboard's
   first render each day becomes a since-you-were-away digest: runs finished
   overnight, review interventions worth reading, approvals waiting, budget
   burn, objectives that moved or stalled. All of it is already in the
   database — this is a read-model and a layout, not new machinery. The
   habit-forming property is that opening the Hub *pays* before you type
   anything. (Natural Sprint 6 core.)
2. **Standing work.** A manager's mornings are driven by recurring
   commitments. Let an objective carry scheduled tasks ("every Monday:
   competitive summary") executed through the existing engine with the
   existing approval gate. This turns the Hub from a place you bring work
   into a place work is already happening — the single strongest daily-return
   mechanic. Bounded autonomy note: schedules are human-defined, runs stay
   gated; this does NOT breach the no-autonomous-consequences exclusion.
3. **Knowledge compounding.** Every session in ChatGPT starts from zero;
   every Hub run should start smarter than the last. Implement the
   KNOWLEDGE.md promotion loop (artifact → human approves → knowledge) so
   using the Hub visibly *accumulates* an asset a chat tab can never have.
   Longer-horizon (Phase 4.5), but it is the moat once habits form.

**Recommended Sprint 6:** "Every Morning" — the Morning Briefing plus
standing work (recurring tasks on objectives), with the deferred A5/A7
hygiene folded in. That sprint makes the Hub the place where work *continued
while you slept* — which is the one thing no chat window offers.

## 9. CEO Briefing (one page)

**1. Where are we now?** A stranger with an email address can now walk in the
front door: sign up, create a workspace, meet a business-named AI team,
define an objective with real success criteria, assign work to an employee —
never seeing a model name — and approve the result. Underneath, the same
audited, isolated, budget-capped machine as always; 113 tests and 3 browser
scenarios green.

**2. Biggest remaining challenge?** The daily-return habit (§8). Onboarding
gets someone in the door once; the Morning Briefing and standing work are
what bring them back at 8am. That, plus the long-standing Phase 3 executors
when we're ready to give the platform hands.

**3. What should I personally focus on?** Two things: (a) try the front door
yourself — create a fresh workspace from the UI and run its getting-started
checklist; (b) read §8 and tell me whether "Every Morning" is the right
Sprint 6 — it's a product bet, and it's yours to place.

**4. Ready to continue?** Yes. No new debt above Medium; the deferred
hygiene items (A5/A7) are pre-slotted into Sprint 6.

**5. Decisions needed?** Only Sprint 6 direction (§8 recommendation vs.
alternatives). Everything else holds its default.

---

*Requesting: approval of this report and a direction decision on Sprint 6 —
recommended: "Every Morning" (Morning Briefing + standing work + deferred
hygiene).*
