# Lifecycle Audit — can every object be owned, not just created?

> Commissioned by the owner, 2026-07-24, after O-12 (workspaces could be
> created but never changed). The question asked of every object in the
> product: **can it be created, edited, archived, and managed over time — or
> only made?**
>
> Method: every user-creatable object traced through the domain layer
> (`src/domain/**`) and the UI (`src/app/**`) for create / read / update /
> archive paths. A capability counts only if it is reachable *in the product* —
> a domain function with no UI is not ownership, it is potential.
>
> Related: [OBSERVATIONS.md](OBSERVATIONS.md) O-10, O-11, O-12 ·
> [DECISIONS.md](DECISIONS.md) · [ROADMAP.md](ROADMAP.md)

## Summary

| Object | Create | Edit | Archive / end | Verdict |
|---|---|---|---|---|
| **Knowledge item** | ✅ | ✅ versioned revise | ✅ archive | **Complete** |
| **Provider secret** | ✅ | ✅ replace | ✅ delete | **Complete** |
| **Approval** | (system) | ✅ decide | ✅ expires | **Complete by design** |
| **Workspace** | ✅ | ✅ *(built today)* | ✅ *(built today)* | **Complete** |
| **Success criterion** | ✅ at creation only | ⚠️ status only | ❌ | **Critical gap** |
| **Objective** | ✅ | ⚠️ status only | ✅ cancel | Gap |
| **Task** | ✅ | ❌ | ❌ no cancel in UI | Gap |
| **Standing work** | ✅ | ⚠️ pause/resume only | ⚠️ pause only | Gap |
| **Milestone** | ✅ | ⚠️ status only | ⚠️ cancel status | Gap |
| **Employee** | ❌ provisioning only | ✅ | ⚠️ disable | Gap |
| **Artifact** | (system) | ❌ | ❌ | Minor gap |
| **Department** | ❌ seeded only | ❌ | ❌ | Gap |

Four of twelve objects support their full lifecycle. The rest can be brought
into existence and then only partially steered.

## The finding that has a live consequence

**Success criteria cannot be edited after an objective is created.** Only
their *status* can change (met / waived / unmet). The label, target, and unit
are frozen at creation, no criterion can be added or removed, and objectives
cannot be deleted.

This is not hypothetical. The owner's real objective — *"connect all ai to
this hub"* in `king-ai-ops-hub` — holds four criteria, three of which have a
target of 0 because of the defect fixed in O-11. **There is currently no way
to fix them.** The available moves are:

- activate the objective and immediately *waive* the three broken criteria
  (recorded in the audit log as waivers, which misrepresents what happened —
  they were never goals, they were bugs), or
- leave the objective in draft permanently, or
- start again with a new objective and abandon this one, uncancellable.

None of those is ownership. This is the sharpest possible illustration of the
executive's point: the platform can create a definition of success but cannot
correct one, so a bug in generation becomes permanent in the record.

**Recommendation: fix this next, before any other gap.** It is the only entry
in this audit currently blocking real work.

## Gap detail

### Critical

**Success criteria — no editing after creation.** As above. Needs: edit
label/target/unit, add a criterion, remove a criterion. All post-activation
changes must be audited (goalposts move only in daylight, per D-017's
reasoning) — but *editing* is not the same as *moving goalposts*, and
conflating them is what produced this gap.

### High

**Objective — title and description are immutable.** A typo in an objective
title is permanent. Status transitions and criteria statuses work; the object's
own content does not.

**Task — cannot be cancelled or edited.** `setTaskStatus` exists in the domain
layer with no UI. A task created by mistake stays `pending` forever; a task
whose brief has a typo must be recreated, leaving the flawed one in history
and in the harvest's "created but never run" count.

**Standing work — cannot be edited.** Pause and resume are the only controls.
Changing a cadence from daily to weekly, or fixing the brief, means creating a
second schedule and pausing the first — which is exactly the accumulation of
half-dead objects that makes a system feel unmanaged. Also: no delete, so a
paused mistake is permanent.

### Medium

**Employee — cannot be added.** Employees arrive only through workspace
provisioning (`DEFAULT_STAFF`). Existing ones can be edited and disabled, but
a workspace that needs a Marketing employee cannot get one. Note this
interacts with the workforce framing (D-015): "hire someone" is a natural
thing to want from a product that presents itself as a company.

**Milestone — no rename, reorder, or removal.** Status only.

**Department — entirely immutable.** Eight are seeded per organization; none
can be added, renamed, or retired. D-015 chose a table over an enum
specifically so departments could grow, and then nothing was built to grow
them.

### Low

**Artifact — no delete or archive.** System-created, so less pressing, but
storage grows unboundedly and a mistakenly-produced artifact is permanent.

## The pattern

Three findings in two days (O-10, O-11, O-12) plus this audit point at one
habit: **features have been scoped to their happy path and declared complete
when creation worked.** Tests reinforced it — every test creates an object and
asserts it exists; almost none change one afterwards and assert it still
behaves.

Two things follow, and they are worth more than the individual fixes:

1. **A definition-of-done change.** A feature that creates an object is not
   complete until that object can be corrected and ended. This belongs in the
   quality gate as a checklist item, not as a hope.
2. **A test-shape change.** Integration tests should exercise
   create → edit → archive, not create → assert. The workspace settings suite
   written today is the first in the codebase to do this; it caught nothing,
   because the feature was built with the audit in view — which is the point.

## Recommended sequence

Not a sprint plan — the owner decides scope. In value order:

1. **Success criteria editing** (critical, blocking real work now)
2. **Task cancel + objective title/description edit** (high, cheap, same shape)
3. **Standing work editing** (high; grows in importance as standing work is
   actually adopted, currently zero)
4. **Add an employee** (medium; the workforce metaphor promises it)
5. **Departments management, milestone editing, artifact deletion** (medium/low)

Items 1–3 are roughly one working session together and share a pattern —
edit-with-audit on an existing owned object — so batching them costs less than
their sum.
