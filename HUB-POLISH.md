# Hub Polish Backlog

Finishing work to make the Hub a **production-quality, polished, enjoyable** operating
system — coherent, low-friction, something to rely on daily. This is *completing the
product*, distinct from feature creep (new foundational capabilities) and from
`OPERATIONS-EVIDENCE.md` (friction from operating a business on top of it).

Bar for this list: does it materially affect the day-to-day experience of using the Hub?
Nice-to-haves that don't are parked, not logged.

## Classes
- **Coherence** — two things that should feel like one; inconsistent models/vocab/layout
- **Friction** — more steps / thinking / risk than the task warrants
- **First-run** — the new-workspace / empty-state / "where do I start?" experience
- **Affordance** — a thing you'd expect to be able to do but can't (edit, filter, sort, link)
- **Copy** — labels/microcopy that mislead, over-explain, or read as unfinished
- **Polish** — visual/interaction rough edges (spacing, states, feedback)

## Entry format
```
### HP-### — <one-line>
- Class: Coherence | Friction | First-run | Affordance | Copy | Polish
- Where: <route / component>
- Observed: <what a real user hits>
- Options: <possible directions — decide together before building>
- Status: proposed | agreed | done | parked
```

## Backlog (first-pass observations — to discuss, not yet agreed)

### HP-001 — "Owner" can only be an AI employee, never the human operator
- Class: Coherence
- Where: ownership across all objects (org.ts `setOwner`, OwnerPicker, Work items)
- Observed: The owner picker lists employees (AI agents). But the operator thinks "I own this" (e.g. "the pilot task owner is me"). A human running the business can't own anything as themselves — they'd have to create a "Founder" employee to represent themselves. For an OS a person relies on daily, "who owns this?" excluding the actual person is an incoherence.
- Options: (a) allow owning to a workspace *member* (human) as well as an employee; (b) treat the signed-in humans as first-class "people" alongside employees; (c) accept employees-only and document the "create a Founder employee" convention. Decide before touching.
- Status: proposed

### HP-002 — "Tasks" vs "Work" — two places for work, unclear which is which
- Class: Coherence
- Where: nav (`New task`, `Work`), tasks vs work_items
- Observed: We now have AI Tasks (write-once, auto-run, cost) and Work Items (human, editable, staged). Both are "work." A new user won't know which to use for what, and the nav shows "New task" and "Work" as unrelated peers. The distinction is real and good — but it isn't *communicated*.
- Options: group them under one "Work" area with two clearly-labeled kinds; and/or one line of copy on each that says when to use it.
- Status: proposed

### HP-003 — Navigation is 14 top-level items with no grouping
- Class: Coherence / First-run
- Where: `layout.tsx` nav
- Observed: Dashboard, Objectives, Work, Knowledge, Decisions, Documents, New task, Approvals, Artifacts, Employees, Providers, Usage, Audit, Settings — a flat wall of 14 links. Hard to form a mental model of the product; everything looks equally important.
- Options: group into a few sections (e.g. Operate / Memory / People / System) or a primary+overflow split. IA decision, discuss.
- Status: proposed

### HP-004 — Creating a task immediately spends money (auto-run, no preview)
- Class: Friction
- Where: `tasks/actions.ts` → redirect `?autorun=1`
- Observed: Submitting the new-task form picks an AI vendor and *immediately* fires a paid run. There's no "save as draft" / review-before-run / cost preview. Easy to spend by accident or before you're ready; nowhere to stage a task you intend to run later.
- Options: offer "Create" vs "Create & run"; or a confirm step showing the vendor/est. cost. Discuss.
- Status: proposed

### HP-005 — First-run experience is undefined
- Class: First-run
- Where: new workspace → dashboard + every list page
- Observed: A brand-new workspace almost certainly lands on a dashboard of empty sections with no "start here." Empty states likely say "No X yet" without telling you what to do first. This is the moment that decides whether the product feels finished.
- Options: a short guided first-run (create your first employee → objective → task), or richer empty states with a single clear next action each. Needs a walkthrough with real eyes to scope.
- Status: proposed
